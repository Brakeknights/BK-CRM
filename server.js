const express = require('express');
const path = require('path');
const session = require('express-session');
const nodemailer = require('nodemailer');
const webpush = require('web-push');
const { verifyConnection, createOrFindSquareCustomer } = require('./square');
const { toEasternRfc3339 } = require('./datetime');
const db = require('./db');
const customers = require('./customers');
const SqliteStore = require('./sqlite-session-store');
const adminRouter = require('./routes/admin');
const quoteRouter = require('./routes/quote');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:greetings@brakeknights.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

function sendNewLeadPush(lead) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  var subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) return;
  var name = lead.first_name + ' ' + lead.last_name;
  var body = [lead.service, lead.vehicle].filter(Boolean).join(' — ') || lead.phone;
  var payload = JSON.stringify({
    title: 'New Lead: ' + name,
    body: body,
    url: '/admin?status=new'
  });
  subs.forEach(function(row) {
    var sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    webpush.sendNotification(sub, payload).catch(function(err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      } else {
        console.error('Push send error:', err.message);
      }
    });
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours
const IS_PROD = process.env.NODE_ENV === 'production';

// Customer-data guard: in production, refuse to start if the admin password or
// session secret is missing/left at the public default. Serving the CRM behind a
// known default password would expose every customer record, so a hard stop is
// safer than running insecure. Crashing here surfaces the misconfiguration on the
// dev deploy before it can reach the live site.
if (IS_PROD) {
  const insecure = [];
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'bk-dev-secret-change-in-prod') insecure.push('SESSION_SECRET');
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'brakeknights') insecure.push('ADMIN_PASSWORD');
  if (insecure.length) {
    console.error('FATAL: refusing to start in production. Set a strong value for: ' + insecure.join(', ') + ' in the hosting environment.');
    process.exit(1);
  }
}

// Behind Hostinger's HTTPS proxy. Required so secure cookies are sent and req.ip
// reflects the real client address (used by login rate limiting).
app.set('trust proxy', 1);

// Baseline security headers on every response.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  name: 'bk.sid',
  secret: process.env.SESSION_SECRET || 'bk-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  store: new SqliteStore(db, SESSION_TTL),
  cookie: {
    maxAge: SESSION_TTL,
    httpOnly: true,           // not readable by JavaScript — blocks XSS cookie theft
    sameSite: 'lax',          // blocks cross-site POSTs from carrying the session — CSRF guard
    secure: IS_PROD           // HTTPS-only in production; off locally so http://localhost works
  }
}));

// 301 redirects for old blog posts and old-format location URLs from previous site
const OLD_REDIRECTS = {
  '/benefits-and-drawbacks-of-mobile-mechanics':                                        '/blog',
  '/havent-changed-your-brake-fluid-in-years-what-is-happening-to-your-brakes':        '/blog',
  '/diy-brake-pad-replacement-when-to-roll-up-your-sleeves-and-when-to-call-the-pros': '/blog',
  '/getting-back-on-the-road-how-long-will-it-take':                                   '/blog',
  '/can-i-drive-with-80-worn-brake-pads':                                              '/blog',
  '/7-common-diy-brake-repair-mistakes-avoid-these-by-hiring-a-pro':                   '/blog',
  '/machining-rotors-when-to-replace-your-brakes-or-not':                              '/blog',
  '/winter-brake-maintenance-protecting-your-cars-brakes-from-corrosion':              '/blog',
  '/abs-explained-for-drivers-how-to-brake-without-skids':                             '/blog',
  '/is-your-handbrake-light-on-even-when-released-heres-why':                         '/blog',
  '/brake-pad-slapping-what-it-is-and-why-we-dont-do-it':                             '/blog',
  '/what-is-the-30-30-30-rule-for-brakes':                                             '/blog',
  '/what-is-the-30-60-90-rule-for-car-maintenance':                                    '/blog',
  '/is-it-safe-to-repair-brakes-on-an-icy-or-frozen-driveway-winter-brake-repair-explained': '/blog',
  '/car-brakes-squeal-when-its-cold-what-it-really-means-and-whats-causing-it':        '/blog',
  '/how-long-should-normal-brake-pads-last':                                           '/blog',
  '/mobile-brake-repair-springfield-va':  '/brake-repair-springfield',
  '/mobile-brake-repair-annandale':       '/brake-repair-annandale',
  '/mobile-brake-repair-aldie-va':        '/brake-repair-aldie',
};

// Strip trailing slashes and /feed suffixes, apply old-URL redirects — all as 301
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  let p = req.path;
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);
  if (p.endsWith('/feed')) p = p.replace(/\/feed$/, '');
  const dest = OLD_REDIRECTS[p];
  if (p !== req.path || dest) return res.redirect(301, dest || p);
  next();
});

app.use('/admin', adminRouter);
app.use('/quote', quoteRouter);
app.use('/images', express.static(path.join(__dirname, 'public/images'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
app.use('/css', express.static(path.join(__dirname, 'public/css'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// The trailing-slash stripper causes a redirect loop for directory index files
// (express.static redirects /blog → /blog/, stripper strips it back → loop).
// Explicit routes for directories with index files avoid this.
app.get('/blog', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'blog', 'index.html'));
});

app.get('/api/square/verify', async (req, res) => {
  const result = await verifyConnection();
  const ok = result.customers === 'ok' && result.bookings === 'ok';
  res.status(ok ? 200 : 502).json(result);
});


app.post('/api/contact', async (req, res) => {
  const { firstName, lastName, phone, email, vehicle, service, preferredContact, message, source } = req.body;

  if (!firstName || !lastName || !phone) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }

  // Guard against accidental double-posts: if the same person (name + phone) just
  // submitted within the last 2 minutes, treat it as a resubmit. Reuse that lead
  // and skip re-sending emails. Legitimate repeat requests later still create a
  // new lead.
  const recentDupe = db.prepare(
    "SELECT id FROM leads WHERE first_name = ? AND last_name = ? AND phone = ? "
    + "AND created_at >= datetime('now', '-2 minutes') ORDER BY id DESC LIMIT 1"
  ).get(firstName, lastName, phone);
  if (recentDupe) {
    console.log('Duplicate contact submission ignored for lead', recentDupe.id);
    return res.json({ success: true, duplicate: true });
  }

  // Save lead to database
  const lead = db.prepare(
    'INSERT INTO leads (first_name, last_name, phone, email, vehicle, service, message, preferred_contact, source) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(firstName, lastName, phone, email || null, vehicle || null, service || null, message || null, preferredContact || null, source || null);
  db.prepare("INSERT INTO lead_history (lead_id, event, detail) VALUES (?, 'Lead created', ?)").run(
    lead.lastInsertRowid, [service, vehicle, source].filter(Boolean).join(' — ') || null
  );

  // Phase 7B: attach this lead to an existing customer (matched by email then
  // phone) or create a new customer record. Never blocks the form response.
  let customerId = null;
  try { customerId = customers.linkLead(lead.lastInsertRowid); }
  catch (err) { console.error('Customer auto-link error:', err.message); }

  if (!process.env.SMTP_PASS) {
    console.error('SMTP_PASS environment variable is not set');
    return res.status(500).json({ success: false, error: 'Email not configured' });
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: {
      user: 'greetings@brakeknights.com',
      pass: process.env.SMTP_PASS
    }
  });

  const baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
  const adminUrl = baseUrl + '/admin/quote/' + lead.lastInsertRowid;

  // Internal notification email to Brake Knights
  const internalHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #ddd;border-radius:8px;">
      <div style="background:#0a1f3d;padding:16px 20px;border-radius:6px 6px 0 0;margin:-20px -20px 20px;">
        <h2 style="color:#6b8ff5;margin:0;font-size:1.3rem;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:24px;height:24px;vertical-align:middle;margin-right:8px;border-radius:4px;"> New Service Request — Brake Knights</h2>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.95rem;">
        <tr><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;width:130px;">Name</td><td style="padding:8px 12px;">${firstName} ${lastName}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Phone</td><td style="padding:8px 12px;"><a href="tel:${phone}">${phone}</a></td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Email</td><td style="padding:8px 12px;"><a href="mailto:${email}">${email || 'Not provided'}</a></td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Vehicle</td><td style="padding:8px 12px;">${vehicle || 'Not provided'}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Service</td><td style="padding:8px 12px;">${service || 'Not specified'}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Preferred Contact</td><td style="padding:8px 12px;">${preferredContact || 'Not specified'}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Message</td><td style="padding:8px 12px;">${message || 'None'}</td></tr>
        <tr style="background:#f9f9f9;"><td style="padding:8px 12px;font-weight:bold;color:#0a1f3d;">Source</td><td style="padding:8px 12px;">${source || 'Website'}</td></tr>
      </table>
      <div style="margin-top:20px;padding:12px;background:#e3f0ff;border-left:4px solid #4169e1;border-radius:4px;font-size:0.85rem;color:#555;">
        Reply directly to this email to respond to the customer.
      </div>
      <div style="margin-top:14px;text-align:center;">
        <a href="${adminUrl}" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.9rem;text-decoration:none;padding:11px 26px;border-radius:8px;">Open in Admin &rarr;</a>
      </div>
    </div>
  `;

  // Customer confirmation email
  const confirmationHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">
      <!-- Header -->
      <div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">
        <h1 style="color:#ffffff;margin:0 0 4px;font-size:1.5rem;letter-spacing:-0.5px;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:32px;height:32px;vertical-align:middle;margin-right:10px;border-radius:6px;"> Brake Knights</h1>
        <p style="color:#8aadcf;margin:0;font-size:0.9rem;">Mobile Brake Service — Northern Virginia</p>
      </div>

      <!-- Body -->
      <div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">
        <h2 style="color:#0a1f3d;margin:0 0 12px;font-size:1.2rem;">Greetings ${firstName},</h2>
        <p style="color:#444;line-height:1.6;margin:0 0 12px;">
          Thanks for reaching out to Brake Knights. A knight is already reviewing your request.
        </p>
        <p style="color:#444;line-height:1.6;margin:0 0 24px;">
          You'll receive a personalized quote specific to your vehicle and the service you need — typically within a few hours. Every quote is reviewed and sent by us directly, not generated automatically.
        </p>

        <!-- Request summary -->
        <div style="background:#f4f7fb;border-radius:6px;padding:20px;margin-bottom:24px;">
          <p style="margin:0 0 12px;font-weight:bold;color:#0a1f3d;font-size:0.95rem;">What You Sent Us</p>
          <table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">
            <tr><td style="padding:5px 0;color:#888;width:90px;">Name</td><td style="padding:5px 0;">${firstName} ${lastName}</td></tr>
            <tr><td style="padding:5px 0;color:#888;">Phone</td><td style="padding:5px 0;">${phone}</td></tr>
            ${vehicle ? `<tr><td style="padding:5px 0;color:#888;">Vehicle</td><td style="padding:5px 0;">${vehicle}</td></tr>` : ''}
            ${service ? `<tr><td style="padding:5px 0;color:#888;">Service</td><td style="padding:5px 0;">${service}</td></tr>` : ''}
            ${preferredContact ? `<tr><td style="padding:5px 0;color:#888;">Preferred Contact</td><td style="padding:5px 0;">${preferredContact}</td></tr>` : ''}
            ${message ? `<tr><td style="padding:5px 0;color:#888;vertical-align:top;">Notes</td><td style="padding:5px 0;">${message}</td></tr>` : ''}
          </table>
        </div>

        <!-- What to expect -->
        <p style="color:#0a1f3d;font-weight:bold;margin:0 0 10px;font-size:0.95rem;">What happens next?</p>
        <ol style="color:#444;line-height:1.8;margin:0 0 24px;padding-left:20px;font-size:0.9rem;">
          <li>We review your request and send you a personalized quote by phone, text, or email.</li>
          <li>Once you approve the quote, we schedule a time and location that works for you.</li>
          <li>Our knight comes to you — fully equipped, no shop visit needed.</li>
        </ol>

        <!-- Contact -->
        <div style="border-top:1px solid #e0e7ef;padding-top:20px;text-align:center;">
          <p style="color:#888;font-size:0.85rem;margin:0 0 8px;">Questions? Reach us directly:</p>
          <a href="tel:7039774475" style="color:#0a1f3d;font-weight:bold;font-size:1rem;text-decoration:none;">📞 703-977-4475</a>
          <span style="color:#ccc;margin:0 10px;">|</span>
          <a href="mailto:greetings@brakeknights.com" style="color:#0a1f3d;font-size:0.9rem;text-decoration:none;">greetings@brakeknights.com</a>
        </div>
      </div>

      <!-- Footer -->
      <div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">
        Brake Knights · Sterling, VA · brakeknights.com
      </div>
    </div>
  `;

  try {
    // Send internal notification
    await transporter.sendMail({
      from: '"Brake Knights Website" <greetings@brakeknights.com>',
      to: 'greetings@brakeknights.com',
      replyTo: email || 'greetings@brakeknights.com',
      subject: `New Service Request: ${firstName} ${lastName}`,
      html: internalHtml
    });

    // Send customer confirmation if they provided an email
    if (email) {
      await transporter.sendMail({
        from: '"Brake Knights" <greetings@brakeknights.com>',
        to: email,
        subject: `We received your request, ${firstName}! — Brake Knights`,
        html: confirmationHtml
      });
    }

    res.json({ success: true });

    // Fire push notification to all registered browsers
    sendNewLeadPush({ first_name: firstName, last_name: lastName, service, vehicle, phone });

    // Create or find Square customer — runs after response so it never blocks the form
    const squareNote = [service && `Service: ${service}`, vehicle && `Vehicle: ${vehicle}`, message].filter(Boolean).join(' | ');
    createOrFindSquareCustomer({ firstName, lastName, phone, email, vehicle, note: squareNote })
      .then(r => {
        console.log(`Square customer ${r.action}: ${r.customerId}`);
        db.prepare('UPDATE leads SET square_customer_id = ? WHERE id = ?').run(r.customerId, lead.lastInsertRowid);
        try { customers.attachSquareId(customerId, r.customerId); } catch (_) {}
      })
      .catch(err => console.error('Square customer sync error:', err.message));
  } catch (err) {
    console.error('Email send error:', err.code, err.message);
    res.status(500).json({ success: false, error: 'Failed to send email' });
  }
});

function gracefulShutdown() {
  try { db.close(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

app.listen(PORT, () => {
  console.log(`Brakeknights server running on port ${PORT}`);
});

// Returns the current hour (0-23) in Eastern Time, accounting for DST automatically.
function easternHour() {
  return parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(new Date()), 10);
}

// Unaccepted quote reminder: if a sent quote has not been accepted after 4 hours,
// send a reminder to the owner. Suppressed overnight — only fires 9 AM to 9 PM ET.
setInterval(function() {
  if (!process.env.SMTP_PASS) return;
  var h = easternHour();
  if (h < 9 || h >= 21) return; // outside business hours — check again next hour

  var pending = db.prepare(
    "SELECT q.*, l.first_name, l.last_name, l.phone, l.email, l.service AS lead_service "
    + "FROM quotes q JOIN leads l ON l.id = q.lead_id "
    + "WHERE q.accepted_at IS NULL AND q.sent_at IS NOT NULL AND q.quote_followup_sent = 0 "
    + "AND (julianday('now') - julianday(q.sent_at)) * 24 >= 4"
  ).all();
  if (pending.length === 0) return;

  var transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS }
  });

  pending.forEach(function(q) {
    var name = q.first_name + ' ' + q.last_name;
    var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">'
      + '<div style="background:#0a1f3d;padding:14px 20px;"><h2 style="color:#6b8ff5;margin:0;font-size:1.1rem;">Reminder: Quote Not Yet Accepted</h2></div>'
      + '<div style="padding:20px;">'
      + '<p style="margin:0 0 14px;color:#444;font-size:0.95rem;"><strong>' + name + '</strong> was sent a quote over 4 hours ago and hasn\'t accepted yet.</p>'
      + '<table style="width:100%;border-collapse:collapse;font-size:0.92rem;">'
      + '<tr><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;width:120px;">Phone</td><td style="padding:6px 10px;"><a href="tel:' + q.phone + '">' + q.phone + '</a></td></tr>'
      + (q.email ? '<tr style="background:#f9f9f9;"><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;">Email</td><td style="padding:6px 10px;">' + q.email + '</td></tr>' : '')
      + (q.service ? '<tr><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;">Service</td><td style="padding:6px 10px;">' + q.service + '</td></tr>' : '')
      + '<tr style="background:#f9f9f9;"><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;">Total</td><td style="padding:6px 10px;">$' + Number(q.total || 0).toFixed(2) + '</td></tr>'
      + '</table>'
      + '<div style="margin-top:16px;text-align:center;">'
      + '<a href="https://brakeknights.com/admin/quote/' + q.lead_id + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:12px 28px;border-radius:8px;">Open in Admin</a>'
      + '</div>'
      + '<p style="margin:14px 0 0;font-size:0.83rem;color:#aaa;text-align:center;">This reminder fires once per quote. Follow up manually if needed.</p>'
      + '</div></div>';

    db.prepare('UPDATE quotes SET quote_followup_sent = 1 WHERE id = ?').run(q.id);

    transporter.sendMail({
      from:    '"BK Admin" <greetings@brakeknights.com>',
      to:      'greetings@brakeknights.com',
      subject: 'Follow up: ' + name + ' hasn\'t accepted their quote yet',
      html
    }).catch(function(err) { console.error('Quote follow-up reminder error:', err.message); });
  });
}, 60 * 60 * 1000); // check every hour

// Auto follow-up: if a lead has been in quote_accepted for 48h with no further action,
// send a reminder email to the owner and mark followup_sent so it only fires once.
setInterval(function() {
  if (!process.env.SMTP_PASS) return;
  var stale = db.prepare(
    "SELECT * FROM leads WHERE status = 'quote_accepted' AND followup_sent = 0 "
    + "AND status_updated_at IS NOT NULL "
    + "AND (julianday('now') - julianday(status_updated_at)) * 24 >= 48"
  ).all();
  if (stale.length === 0) return;

  var transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS }
  });

  stale.forEach(function(lead) {
    var name = lead.first_name + ' ' + lead.last_name;
    var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">'
      + '<div style="background:#e07000;padding:14px 20px;"><h2 style="color:#fff;margin:0;font-size:1.1rem;">Reminder: Pending Accepted Quote</h2></div>'
      + '<div style="padding:20px;">'
      + '<p style="margin:0 0 14px;color:#444;font-size:0.95rem;"><strong>' + lead.first_name + ' ' + lead.last_name + '</strong> accepted their quote 48 hours ago and is still waiting to be scheduled.</p>'
      + '<table style="width:100%;border-collapse:collapse;font-size:0.92rem;">'
      + '<tr><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;width:120px;">Phone</td><td style="padding:6px 10px;"><a href="tel:' + lead.phone + '">' + lead.phone + '</a></td></tr>'
      + (lead.email ? '<tr style="background:#f9f9f9;"><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;">Email</td><td style="padding:6px 10px;">' + lead.email + '</td></tr>' : '')
      + (lead.service ? '<tr><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;">Service</td><td style="padding:6px 10px;">' + lead.service + '</td></tr>' : '')
      + '</table>'
      + '<div style="margin-top:16px;text-align:center;">'
      + '<a href="https://brakeknights.com/admin/quote/' + lead.id + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:12px 28px;border-radius:8px;">Open in Admin</a>'
      + '</div>'
      + '</div></div>';

    db.prepare('UPDATE leads SET followup_sent = 1 WHERE id = ?').run(lead.id);

    transporter.sendMail({
      from:    '"BK Admin" <greetings@brakeknights.com>',
      to:      'greetings@brakeknights.com',
      subject: 'Reminder: ' + name + ' — accepted quote not yet scheduled',
      html
    }).catch(function(err) { console.error('Follow-up reminder error:', err.message); });
  });
}, 60 * 60 * 1000); // check every hour

// ─── Appointment reminders (customer) ────────────────────────────────────────
// Branded email reminders for confirmed (booked) appointments, each sent once:
//   • ~24 hours before the appointment time
//   • ~2 hours before the appointment time
// Uses our own emails — disable Square Appointments' automatic reminders to
// avoid customers getting duplicates. Checks every 15 minutes.
function buildReminderEmail(q, soonText) {
  function e(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtDate(val) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val || '');
    if (!m) return val || '—';
    var WD = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var MO = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var dt = new Date(+m[1], +m[2] - 1, +m[3]);
    return WD[dt.getDay()] + ', ' + MO[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
  }
  var calendarUrl = 'https://brakeknights.com/quote/' + q.id + '/' + q.accept_token + '/calendar.ics';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">'
    + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
    + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;"> Brake Knights</h1>'
    + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service — Northern Virginia</p></div>'
    + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
    + '<h2 style="color:#0a1f3d;margin:0 0 16px;">Appointment reminder</h2>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 20px;">Greetings ' + e(q.first_name) + ', this is a friendly reminder that your brake service appointment is coming up ' + soonText + '.</p>'
    + '<div style="background:#f4f7fb;border-radius:8px;padding:20px;margin-bottom:24px;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
    + '<tr><td style="padding:5px 0;color:#888;width:100px;">Service</td><td style="padding:5px 0;font-weight:600;">' + e(q.service) + '</td></tr>'
    + '<tr><td style="padding:5px 0;color:#888;">Date</td><td style="padding:5px 0;">' + e(fmtDate(q.pref_date)) + '</td></tr>'
    + '<tr><td style="padding:5px 0;color:#888;">Time</td><td style="padding:5px 0;">' + e(q.pref_time || '—') + '</td></tr>'
    + '<tr><td style="padding:5px 0;color:#888;vertical-align:top;">Location</td><td style="padding:5px 0;">' + e(q.pref_location || '—') + '</td></tr>'
    + '</table></div>'
    + '<div style="text-align:center;margin:0 0 24px;">'
    + '<a href="' + calendarUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 30px;border-radius:8px;">&#128197; Add to Calendar</a>'
    + '</div>'
    + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
    + '<p style="color:#fff;font-weight:700;margin:0 0 8px;">Need to reschedule? Call or text:</p>'
    + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
    + '</div></div>'
    + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div></div>';
}

setInterval(function() {
  if (!process.env.SMTP_PASS) return;

  var rows = db.prepare(
    "SELECT q.*, l.first_name, l.email AS lead_email "
    + "FROM quotes q JOIN leads l ON l.id = q.lead_id "
    + "WHERE l.status = 'booked' AND q.accepted_at IS NOT NULL AND q.pref_date IS NOT NULL "
    + "AND l.email IS NOT NULL AND (q.reminder_24h_sent = 0 OR q.reminder_2h_sent = 0)"
  ).all();
  if (rows.length === 0) return;

  var now = Date.now();
  var transporter = null;
  function tx() {
    if (!transporter) transporter = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
    return transporter;
  }

  rows.forEach(function(q) {
    var startRfc = toEasternRfc3339(q.pref_date, q.pref_time);
    if (!startRfc) return;
    var start = new Date(startRfc).getTime();
    if (now >= start) return; // appointment already passed

    // 24h reminder fires in the [start-24h, start-2h) window; 2h reminder from
    // start-2h onward. They're mutually exclusive per run, so at most one sends.
    var send24 = !q.reminder_24h_sent && now >= start - 24 * 3600 * 1000 && now < start - 2 * 3600 * 1000;
    var send2  = !q.reminder_2h_sent  && now >= start - 2 * 3600 * 1000;
    if (!send24 && !send2) return;

    var col = send2 ? 'reminder_2h_sent' : 'reminder_24h_sent';
    var soonText = send2 ? 'shortly' : 'soon';
    db.prepare('UPDATE quotes SET ' + col + ' = 1 WHERE id = ?').run(q.id);

    tx().sendMail({
      from:    '"Brake Knights" <greetings@brakeknights.com>',
      to:      q.lead_email,
      subject: 'Reminder: Your Brake Knights appointment',
      html:    buildReminderEmail(q, soonText)
    }).catch(function(err) { console.error('Appointment reminder error:', err.message); });
  });
}, 15 * 60 * 1000); // check every 15 minutes

// ─── Follow-up reminders (Phase 6 foundation) ─────────────────────────────────
// Receipt advisories can carry a timed reminder. On/after the due date, each
// fires once to the owner, the customer, or both, then is marked sent.
function followupOwnerEmail(f) {
  function e(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  var name = f.first_name + ' ' + f.last_name;
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">'
    + '<div style="background:#e07000;padding:14px 20px;"><h2 style="color:#fff;margin:0;font-size:1.1rem;">Follow-Up Due</h2></div>'
    + '<div style="padding:20px;">'
    + '<p style="margin:0 0 14px;color:#444;font-size:0.95rem;">A follow-up you scheduled for <strong>' + e(name) + '</strong>' + (f.vehicle ? ' (' + e(f.vehicle) + ')' : '') + ' is due.</p>'
    + '<div style="background:#fff8e1;border:1px solid #f0d080;border-radius:6px;padding:14px;margin-bottom:16px;color:#7a5a00;font-size:0.95rem;">' + e(f.description) + '</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.92rem;">'
    + '<tr><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;width:120px;">Phone</td><td style="padding:6px 10px;"><a href="tel:' + e(f.phone) + '">' + e(f.phone) + '</a></td></tr>'
    + (f.lead_email ? '<tr style="background:#f9f9f9;"><td style="padding:6px 10px;font-weight:bold;color:#0a1f3d;">Email</td><td style="padding:6px 10px;">' + e(f.lead_email) + '</td></tr>' : '')
    + '</table>'
    + '<div style="margin-top:16px;text-align:center;">'
    + '<a href="https://brakeknights.com/admin/quote/' + f.lead_id + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:12px 28px;border-radius:8px;">Open in Admin</a>'
    + '</div></div></div>';
}

function followupCustomerEmail(f) {
  function e(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">'
    + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
    + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;"> Brake Knights</h1>'
    + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service — Northern Virginia</p></div>'
    + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
    + '<h2 style="color:#0a1f3d;margin:0 0 16px;">Greetings ' + e(f.first_name) + ',</h2>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 16px;">A quick reminder from Brake Knights' + (f.vehicle ? ' about your <strong>' + e(f.vehicle) + '</strong>' : '') + ':</p>'
    + '<div style="background:#f4f7fb;border-left:4px solid #4169e1;border-radius:6px;padding:16px 18px;margin-bottom:24px;color:#1a2a3a;font-size:0.95rem;line-height:1.6;">' + e(f.description) + '</div>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 24px;font-size:0.9rem;">When you&rsquo;re ready, we&rsquo;ll come to your home or office. No shop visit needed.</p>'
    + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
    + '<p style="color:#fff;font-weight:700;margin:0 0 8px;">Schedule your service. Call or text:</p>'
    + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
    + '</div></div>'
    + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Call/Text 703-977-4475 &middot; brakeknights.com</div></div>';
}

setInterval(function() {
  if (!process.env.SMTP_PASS) return;

  var due = db.prepare(
    "SELECT f.*, l.first_name, l.last_name, l.phone, l.email AS lead_email, l.vehicle "
    + "FROM followups f JOIN leads l ON l.id = f.lead_id "
    + "WHERE f.sent = 0 AND date(f.due_date) <= date('now')"
  ).all();
  if (due.length === 0) return;

  var transporter = nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS }
  });

  due.forEach(function(f) {
    // Mark sent first so a send error never causes a duplicate on the next tick.
    db.prepare("UPDATE followups SET sent = 1, sent_at = datetime('now') WHERE id = ?").run(f.id);

    var toOwner    = f.recipient === 'owner' || f.recipient === 'both';
    var toCustomer = (f.recipient === 'customer' || f.recipient === 'both') && f.lead_email;

    if (toOwner) {
      transporter.sendMail({
        from:    '"BK Admin" <greetings@brakeknights.com>',
        to:      'greetings@brakeknights.com',
        subject: 'Follow-up due: ' + f.first_name + ' ' + f.last_name,
        html:    followupOwnerEmail(f)
      }).catch(function(err) { console.error('Follow-up owner email error:', err.message); });
    }
    if (toCustomer) {
      transporter.sendMail({
        from:    '"Brake Knights" <greetings@brakeknights.com>',
        to:      f.lead_email,
        replyTo: 'greetings@brakeknights.com',
        subject: 'A reminder from Brake Knights',
        html:    followupCustomerEmail(f)
      }).catch(function(err) { console.error('Follow-up customer email error:', err.message); });
    }
  });
}, 6 * 60 * 60 * 1000); // check every 6 hours
