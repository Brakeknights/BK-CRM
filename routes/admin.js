const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const db = require('../db');
const PRICING = require('../pricing');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'brakeknights';

// ─── Helpers ────────────────────────────────────────────────────────────────

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(n) {
  return Number(n || 0).toFixed(2);
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(dateStr + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function statusBadge(status) {
  const styles = {
    new:            'background:#e3f0ff;color:#1a6fc4;',
    quoted:         'background:#dde7fb;color:#3a4fb8;',
    follow_up:      'background:#fce8ff;color:#8b2fc9;',
    quote_accepted: 'background:#e0f4f8;color:#0e7490;',
    booked:         'background:#e6f9ee;color:#1a7a3a;',
    completed:      'background:#f0f0f0;color:#555;',
  };
  const labels = { new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', quote_accepted: 'Quote Accepted', booked: 'Booked', completed: 'Completed' };
  const style = styles[status] || styles.new;
  const label = labels[status] || status;
  return '<span style="' + style + 'padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;letter-spacing:0.3px;white-space:nowrap;">' + label + '</span>';
}

function requireAuth(req, res, next) {
  if (req.session && req.session.adminAuthed) return next();
  res.redirect('/admin/login');
}

function logHistory(leadId, event, detail) {
  db.prepare("INSERT INTO lead_history (lead_id, event, detail) VALUES (?, ?, ?)").run(leadId, event, detail || null);
}

function fmtHistoryTime(dateStr) {
  var d = new Date(dateStr + 'Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

async function notifyStageChange(req, lead, newStatus) {
  if (!process.env.SMTP_PASS) return;
  var statusLabels = { new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', quote_accepted: 'Quote Accepted', booked: 'Booked', completed: 'Completed' };
  var newLabel = statusLabels[newStatus] || newStatus;
  var oldLabel = statusLabels[lead.status] || lead.status;
  var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
  var adminUrl = baseUrl + '/admin/quote/' + lead.id;
  var name = lead.first_name + ' ' + lead.last_name;
  var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">'
    + '<div style="background:#0a1f3d;padding:14px 20px;"><h2 style="color:#6b8ff5;margin:0;font-size:1.1rem;">Lead Status Updated</h2></div>'
    + '<div style="padding:20px;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.95rem;">'
    + '<tr><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;width:120px;">Lead</td><td style="padding:7px 10px;">' + esc(name) + '</td></tr>'
    + '<tr style="background:#f9f9f9;"><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Phone</td><td style="padding:7px 10px;"><a href="tel:' + esc(lead.phone) + '">' + esc(lead.phone) + '</a></td></tr>'
    + (lead.service ? '<tr><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Service</td><td style="padding:7px 10px;">' + esc(lead.service) + '</td></tr>' : '')
    + '<tr style="background:#f9f9f9;"><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Stage: Before</td><td style="padding:7px 10px;color:#888;">' + esc(oldLabel) + '</td></tr>'
    + '<tr><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Stage: Now</td><td style="padding:7px 10px;font-weight:700;color:#0e7490;">' + esc(newLabel) + '</td></tr>'
    + '</table>'
    + '<div style="margin-top:16px;text-align:center;">'
    + '<a href="' + adminUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:12px 28px;border-radius:8px;">Open in Admin</a>'
    + '</div>'
    + '</div></div>';
  var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
  await tx.sendMail({
    from:    '"BK Admin" <greetings@brakeknights.com>',
    to:      'greetings@brakeknights.com',
    subject: 'Lead Update: ' + name + ' → ' + newLabel,
    html
  });
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;min-height:100vh;color:#1a2a3a}
.topbar{background:#0a1f3d;padding:13px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.topbar-brand{color:#6b8ff5;font-weight:700;font-size:0.95rem;letter-spacing:.5px;display:flex;align-items:center;gap:8px;text-decoration:none}
.topbar-brand img{width:22px;height:22px;border-radius:4px}
.topbar-logout{color:#8aadcf;font-size:0.82rem;text-decoration:none}
.topbar-logout:hover{color:#fff}
.wrap{max-width:600px;margin:0 auto;padding:16px}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.section-title{font-size:0.95rem;font-weight:700;color:#0a1f3d;margin-bottom:14px}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:0.95rem;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;transition:opacity .15s}
.btn:hover{opacity:.88}
.btn-navy{background:#0a1f3d;color:#fff}
.btn-blue{background:#4169e1;color:#fff}
.btn-outline{background:transparent;border:2px solid #0a1f3d;color:#0a1f3d}
.btn-sm{padding:9px 14px;font-size:0.85rem;width:auto;display:inline-block}
.filter-tabs{display:flex;gap:8px;margin-bottom:14px;overflow-x:auto;padding-bottom:2px}
.filter-tab{padding:6px 13px;border-radius:20px;font-size:0.82rem;font-weight:600;text-decoration:none;background:#fff;color:#666;border:1px solid #dde3ea;white-space:nowrap;flex-shrink:0}
.filter-tab.active{background:#0a1f3d;color:#fff;border-color:#0a1f3d}
.form-group{margin-bottom:14px}
.form-group label{display:block;font-size:0.83rem;font-weight:600;color:#555;margin-bottom:5px}
.form-group input,.form-group select,.form-group textarea{width:100%;padding:10px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.95rem;color:#1a2a3a;background:#fff;-webkit-appearance:none;appearance:none}
.form-group input:focus,.form-group select:focus,.form-group textarea:focus{outline:none;border-color:#0a1f3d}
.form-group textarea{resize:vertical;min-height:80px;line-height:1.5}
.tier-toggle{display:flex;border:2px solid #0a1f3d;border-radius:8px;overflow:hidden}
.tier-btn{flex:1;padding:10px;border:none;background:#fff;color:#0a1f3d;font-size:0.9rem;font-weight:600;cursor:pointer;transition:background .15s,color .15s}
.tier-btn.active{background:#0a1f3d;color:#fff}
.price-section{border:1.5px solid #dde3ea;border-radius:10px;overflow:hidden;margin-bottom:14px}
.price-section-header{background:#f4f7fb;padding:8px 14px;font-size:0.78rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;border-bottom:1.5px solid #dde3ea}
.price-row{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #f0f0f0;font-size:0.9rem;gap:12px}
.price-row:last-child{border-bottom:none}
.price-row.total-row{font-weight:700;font-size:1.05rem;color:#0a1f3d;background:#f9fbfd}
.price-row.tax-row{color:#666;font-size:0.88rem}
.price-row.divider-row{border-top:2px solid #dde3ea}
.price-label{flex:1}
.price-note{font-size:0.75rem;color:#aaa;font-weight:400}
.price-input{width:96px;padding:7px 8px;border:1.5px solid #dde3ea;border-radius:6px;font-size:0.9rem;text-align:right;flex-shrink:0}
.price-input:focus{outline:none;border-color:#0a1f3d}
.tax-rate-input{width:44px;padding:3px 5px;border:1.5px solid #dde3ea;border-radius:5px;font-size:0.85rem;text-align:center}
.tax-rate-input:focus{outline:none;border-color:#0a1f3d}
.info-grid{display:grid;grid-template-columns:100px 1fr;gap:7px 12px;font-size:0.88rem}
.info-key{color:#888}
.info-val{color:#1a2a3a;font-weight:500;word-break:break-word}
.back-link{display:inline-flex;align-items:center;gap:6px;color:#0a1f3d;text-decoration:none;font-weight:600;font-size:0.88rem;margin-bottom:14px}
.alert{padding:11px 14px;border-radius:8px;margin-bottom:14px;font-size:0.88rem;font-weight:500}
.alert-success{background:#e6f9ee;color:#1a7a3a;border:1px solid #b2dfcb}
.alert-error{background:#fff0f0;color:#c0392b;border:1px solid #f5c6c6}
.empty{text-align:center;padding:48px 16px;color:#aaa}
.lead-name{font-weight:700;font-size:1rem;color:#0a1f3d}
.lead-service{color:#1a6fc4;font-size:0.88rem;font-weight:600;margin:3px 0}
.lead-vehicle{color:#555;font-size:0.85rem}
.lead-meta{color:#aaa;font-size:0.8rem;margin-top:2px}
.lead-note{color:#666;font-size:0.83rem;margin-top:6px;font-style:italic}
.row-sb{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px}
.preview-box{background:#f4f7fb;border:1px solid #dde3ea;border-radius:8px;padding:16px;margin-top:14px;font-size:0.87rem;line-height:1.6;color:#444}
.preview-box h4{color:#0a1f3d;margin-bottom:8px;font-size:0.92rem}
.preview-divider{border:none;border-top:1px solid #dde3ea;margin:10px 0}
.svc-check-list{border:1.5px solid #dde3ea;border-radius:8px;overflow-y:auto;max-height:180px;padding:4px 0;}
.svc-check-item{display:flex;align-items:center;gap:10px;padding:10px 12px;font-size:0.9rem;cursor:pointer;border-bottom:1px solid #f4f4f4;color:#1a2a3a;user-select:none;}
.svc-check-item:last-child{border-bottom:none;}
.svc-check-item:hover{background:#f0f5ff;}
.svc-check-item input[type=checkbox]{display:none;}
.svc-check-item .svc-box{width:20px;height:20px;border:2px solid #c8d0db;border-radius:5px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#fff;transition:background .12s,border-color .12s;}
.svc-check-item:has(input:checked){background:#e8f0fe;color:#1a4fc4;font-weight:600;border-bottom-color:#d4e2fb;}
.svc-check-item:has(input:checked) .svc-box{background:#4169e1;border-color:#4169e1;}
.svc-check-item:has(input:checked) .svc-box::after{content:'✓';color:#fff;font-size:0.82rem;font-weight:800;line-height:1;}
.svc-clear-btn{margin-top:7px;padding:6px 12px;border:1.5px solid #dde3ea;border-radius:6px;background:#fff;color:#888;font-size:0.8rem;font-weight:600;cursor:pointer;}
.svc-clear-btn:hover{border-color:#c0c8d8;color:#555;}
.svc-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;min-height:0;}
.svc-tag{display:inline-flex;align-items:center;gap:5px;background:#4169e1;color:#fff;border-radius:20px;padding:4px 12px 4px 10px;font-size:0.78rem;font-weight:600;}
.svc-tag-x{cursor:pointer;font-size:0.9rem;line-height:1;opacity:.8;border:none;background:none;color:#fff;padding:0;}
`;

function page(title, body, req) {
  var logoutLink = (req.session && req.session.adminAuthed)
    ? '<a href="/admin/logout" class="topbar-logout">Log out</a>'
    : '';
  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>BK Admin' + (title && title !== 'Leads' ? ' — ' + esc(title) : '') + '</title>'
    + '<style>' + CSS + '</style>'
    + '</head><body>'
    + '<div class="topbar">'
    + '<a href="/admin" class="topbar-brand"><img src="/images/favicon.png" alt=""> BK Admin</a>'
    + logoutLink
    + '</div>'
    + '<div class="wrap">' + body + '</div>'
    + '</body></html>';
}

// ─── Auth routes ─────────────────────────────────────────────────────────────

router.get('/login', function(req, res) {
  if (req.session && req.session.adminAuthed) return res.redirect('/admin');
  var errorHtml = req.query.error
    ? '<div class="alert alert-error">Incorrect password. Try again.</div>'
    : '';
  res.send(page('Login',
    '<div style="max-width:360px;margin:56px auto 0;">'
    + '<div class="card" style="padding:28px;">'
    + '<div style="text-align:center;margin-bottom:24px;">'
    + '<img src="/images/favicon.png" style="width:44px;height:44px;border-radius:10px;margin-bottom:10px;">'
    + '<div style="font-weight:700;font-size:1.15rem;color:#0a1f3d;">Brake Knights Admin</div>'
    + '<div style="color:#aaa;font-size:0.83rem;margin-top:4px;">Enter your password to continue</div>'
    + '</div>'
    + errorHtml
    + '<form method="POST" action="/admin/login">'
    + '<div class="form-group"><label>Password</label>'
    + '<input type="password" name="password" autofocus autocomplete="current-password" required></div>'
    + '<button type="submit" class="btn btn-navy" style="margin-top:4px;">Sign In</button>'
    + '</form>'
    + '</div></div>',
    req
  ));
});

router.post('/login', express.urlencoded({ extended: false }), function(req, res) {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.adminAuthed = true;
    res.redirect('/admin');
  } else {
    res.redirect('/admin/login?error=1');
  }
});

router.get('/logout', function(req, res) {
  req.session.destroy();
  res.redirect('/admin/login');
});

// ─── Status update ────────────────────────────────────────────────────────────

router.post('/lead/:id/status', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var validStatuses = ['new', 'quoted', 'follow_up', 'quote_accepted', 'booked', 'completed'];
  var status = req.body.status;
  if (!validStatuses.includes(status)) return res.status(400).send('Invalid status');
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  if (lead.status !== status) {
    var statusLabels = { new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', quote_accepted: 'Quote Accepted', booked: 'Booked', completed: 'Completed' };
    db.prepare("UPDATE leads SET status = ?, status_updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
    logHistory(lead.id, 'Status changed to ' + (statusLabels[status] || status));
    notifyStageChange(req, lead, status).catch(function(err) { console.error('Stage notification error:', err.message); });
  }
  var back = req.body.back || '/admin';
  res.redirect(back);
});

// ─── Square setup diagnostics (temporary) ────────────────────────────────────
router.get('/square-info', requireAuth, async function(req, res) {
  const { client } = require('../square');
  const out = {};
  try {
    const r = await client.locations.list();
    out.locations = (r.locations || []).map(l => ({ id: l.id, name: l.name, status: l.status }));
  } catch (e) { out.locations = 'ERR: ' + e.message; }
  try {
    const r = await client.teamMembers.search({ query: { filter: { statuses: ['ACTIVE'] } } });
    out.teamMembers = (r.teamMembers || []).map(m => ({ id: m.id, name: (m.displayName || ((m.givenName || '') + ' ' + (m.familyName || '')).trim()) }));
  } catch (e) { out.teamMembers = 'ERR: ' + e.message; }
  try {
    const r = await client.catalog.list({ types: 'ITEM' });
    out.allCatalogItems = (r.objects || []).map(o => ({
      id: o.id, type: o.type, productType: o.itemData?.productType, name: o.itemData?.name,
      variations: (o.itemData?.variations || []).map(v => ({ id: v.id, name: v.itemVariationData?.name, duration: v.itemVariationData?.serviceDuration }))
    }));
  } catch (e) { out.allCatalogItems = 'ERR: ' + e.message; }
  res.type('json').send(JSON.stringify(out, null, 2));
});

// ─── Approve / deny scheduling ────────────────────────────────────────────────

router.get('/quote/:id/approve-schedule', requireAuth, async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id);
  if (!quote) return res.redirect('/admin/quote/' + lead.id + '?msg=no_accepted_quote');

  db.prepare("UPDATE leads SET status = 'booked', status_updated_at = datetime('now') WHERE id = ?").run(lead.id);
  logHistory(lead.id, 'Time approved', (quote.pref_date || '') + (quote.pref_time ? ' at ' + quote.pref_time : '') + (quote.pref_location ? ' — ' + quote.pref_location : ''));

  if (process.env.SMTP_PASS && lead.email) {
    try {
      var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      var WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
      var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      function fmtDate(val) {
        if (!val) return '—';
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
        if (!m) return val;
        var dt = new Date(+m[1], +m[2]-1, +m[3]);
        return WEEKDAYS[dt.getDay()] + ', ' + MONTHS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
      }
      var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">'
        + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
        + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;"> Brake Knights</h1>'
        + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service — Northern Virginia</p></div>'
        + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
        + '<h2 style="color:#1a7a3a;margin:0 0 16px;">Your appointment is confirmed!</h2>'
        + '<p style="color:#444;line-height:1.6;margin:0 0 20px;">Greetings ' + esc(lead.first_name) + ', your service appointment has been confirmed. See you then!</p>'
        + '<div style="background:#f4f7fb;border-radius:8px;padding:20px;margin-bottom:24px;">'
        + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
        + '<tr><td style="padding:5px 0;color:#888;width:100px;">Service</td><td style="padding:5px 0;font-weight:600;">' + esc(quote.service) + '</td></tr>'
        + '<tr><td style="padding:5px 0;color:#888;">Total</td><td style="padding:5px 0;font-weight:700;">$' + fmt(quote.total) + '</td></tr>'
        + '<tr><td style="padding:5px 0;color:#888;">Date</td><td style="padding:5px 0;">' + esc(fmtDate(quote.pref_date)) + '</td></tr>'
        + '<tr><td style="padding:5px 0;color:#888;">Time</td><td style="padding:5px 0;">' + esc(quote.pref_time || '—') + '</td></tr>'
        + '<tr><td style="padding:5px 0;color:#888;vertical-align:top;">Location</td><td style="padding:5px 0;">' + esc(quote.pref_location || '—') + '</td></tr>'
        + '</table></div>'
        + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
        + '<p style="color:#fff;font-weight:700;margin:0 0 8px;">Questions? Call or text:</p>'
        + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
        + '</div></div>'
        + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div></div>';
      await tx.sendMail({ from: '"Brake Knights" <greetings@brakeknights.com>', to: lead.email, subject: 'Your appointment is confirmed — Brake Knights', html });
    } catch (err) { console.error('Approve schedule email error:', err.message); }
  }
  res.redirect('/admin/quote/' + lead.id + '?msg=approved');
});

router.get('/quote/:id/deny-schedule', requireAuth, async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id);

  logHistory(lead.id, 'Time denied', quote ? ((quote.pref_date || '') + (quote.pref_time ? ' at ' + quote.pref_time : '')) : null);

  if (process.env.SMTP_PASS && lead.email) {
    try {
      var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">'
        + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
        + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;"> Brake Knights</h1>'
        + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service — Northern Virginia</p></div>'
        + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
        + '<h2 style="color:#0a1f3d;margin:0 0 16px;">Greetings ' + esc(lead.first_name) + ',</h2>'
        + '<p style="color:#444;line-height:1.6;margin:0 0 16px;">Unfortunately that date and time is not available. We will reach out to you shortly to discuss available times and confirm your booking.</p>'
        + '<p style="color:#444;line-height:1.6;margin:0 0 24px;">We apologize for the inconvenience and look forward to getting you scheduled soon.</p>'
        + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
        + '<p style="color:#fff;font-weight:700;margin:0 0 8px;">Feel free to call or text us directly:</p>'
        + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
        + '</div></div>'
        + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div></div>';
      await tx.sendMail({ from: '"Brake Knights" <greetings@brakeknights.com>', to: lead.email, subject: 'Scheduling update — Brake Knights', html });
    } catch (err) { console.error('Deny schedule email error:', err.message); }
  }
  res.redirect('/admin/quote/' + lead.id + '?msg=denied');
});

// ─── Lead list ───────────────────────────────────────────────────────────────

router.get('/', requireAuth, function(req, res) {
  var status = req.query.status || 'all';
  var search = (req.query.q || '').trim();
  var sp = '%' + search + '%';

  var leads;
  if (search) {
    leads = db.prepare(
      'SELECT * FROM leads WHERE (first_name || " " || last_name LIKE ? OR phone LIKE ? OR email LIKE ? OR vehicle LIKE ? OR service LIKE ?) ORDER BY id DESC'
    ).all(sp, sp, sp, sp, sp);
  } else if (status === 'all') {
    leads = db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
  } else {
    leads = db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY id DESC').all(status);
  }

  var counts = db.prepare('SELECT status, COUNT(*) as n FROM leads GROUP BY status').all()
    .reduce(function(acc, r) { acc[r.status] = r.n; return acc; }, {});
  var total = db.prepare('SELECT COUNT(*) as n FROM leads').get().n;

  var tabs = [
    ['all',            'All',            total],
    ['new',            'New',            counts.new            || 0],
    ['quoted',         'Quoted',         counts.quoted         || 0],
    ['follow_up',      'Follow Up',      counts.follow_up      || 0],
    ['quote_accepted', 'Quote Accepted', counts.quote_accepted || 0],
    ['booked',         'Booked',         counts.booked         || 0],
    ['completed',      'Completed',      counts.completed      || 0],
  ];

  var tabsHtml = tabs.map(function(t) {
    var countBit = t[2] > 0 ? ' <span style="opacity:.65">(' + t[2] + ')</span>' : '';
    return '<a href="/admin?status=' + t[0] + '" class="filter-tab' + (!search && status === t[0] ? ' active' : '') + '">'
      + t[1] + countBit + '</a>';
  }).join('');

  var alert = '';
  if (req.query.msg === 'sent')  alert = '<div class="alert alert-success">Quote sent successfully.</div>';
  if (req.query.msg === 'saved') alert = '<div class="alert alert-success">Quote saved. No email on file for this lead.</div>';
  if (req.query.msg === 'err')   alert = '<div class="alert alert-error">Failed to send quote email. Please try again.</div>';

  var emptyMsg = search
    ? 'No leads match &ldquo;' + esc(search) + '&rdquo;.'
    : 'No leads' + (status !== 'all' ? ' in this category' : ' yet') + '.';

  var cardsHtml = leads.length === 0
    ? '<div class="empty"><div style="font-size:2rem;margin-bottom:10px;">&#128203;</div>' + emptyMsg + '</div>'
    : leads.map(function(l) {
        return '<div class="card">'
          + '<div class="row-sb">'
          + '<div class="lead-name">' + esc(l.first_name) + ' ' + esc(l.last_name) + '</div>'
          + statusBadge(l.status)
          + '</div>'
          + '<div class="lead-service">' + esc(l.service || 'Service not specified') + '</div>'
          + (l.vehicle ? '<div class="lead-vehicle">' + esc(l.vehicle) + '</div>' : '')
          + '<div class="lead-meta">' + timeAgo(l.created_at) + (l.preferred_contact ? ' &middot; Prefers ' + esc(l.preferred_contact) : '') + '</div>'
          + (l.message ? '<div class="lead-note">&ldquo;' + esc(l.message) + '&rdquo;</div>' : '')
          + '<div style="display:flex;gap:8px;margin-top:12px;align-items:center;">'
          + '<a href="tel:' + esc(l.phone) + '" class="btn btn-outline btn-sm" style="width:auto;flex-shrink:0;">&#128222; Call</a>'
          + '<a href="/admin/quote/' + l.id + '" class="btn btn-navy btn-sm" style="flex:1;text-align:center;">Open Quote</a>'
          + '</div>'
          + '<form method="POST" action="/admin/lead/' + l.id + '/status" style="margin-top:10px;display:flex;align-items:center;gap:8px;">'
          + '<input type="hidden" name="back" value="/admin?status=' + status + (search ? '&q=' + encodeURIComponent(search) : '') + '">'
          + '<label style="font-size:0.78rem;color:#aaa;font-weight:600;white-space:nowrap;">Status:</label>'
          + '<select name="status" onchange="this.form.submit()" style="flex:1;padding:6px 8px;border:1.5px solid #dde3ea;border-radius:6px;font-size:0.82rem;color:#1a2a3a;background:#fff;">'
          + ['new','quoted','follow_up','quote_accepted','booked','completed'].map(function(s) {
              var label = { new:'New', quoted:'Quoted', follow_up:'Follow Up', quote_accepted:'Quote Accepted', booked:'Booked', completed:'Completed' }[s];
              return '<option value="' + s + '"' + (l.status === s ? ' selected' : '') + '>' + label + '</option>';
            }).join('')
          + '</select>'
          + '</form>'
          + '</div>';
      }).join('');

  var searchBar = '<form method="GET" action="/admin" style="margin-bottom:12px;display:flex;gap:8px;">'
    + '<input type="hidden" name="status" value="' + esc(status) + '">'
    + '<input type="text" name="q" value="' + esc(search) + '" placeholder="Search by name, phone, vehicle, service..." '
    + 'style="flex:1;padding:9px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.9rem;background:#fff;">'
    + (search ? '<a href="/admin?status=' + esc(status) + '" style="padding:9px 12px;border:1.5px solid #dde3ea;border-radius:8px;background:#fff;color:#666;text-decoration:none;font-size:0.9rem;white-space:nowrap;">&#10005; Clear</a>' : '')
    + '</form>';

  res.send(page('Leads',
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">'
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;">Leads</h1>'
    + '<span style="color:#aaa;font-size:0.83rem;">' + total + ' total</span>'
    + '</div>'
    + alert
    + searchBar
    + '<div class="filter-tabs">' + tabsHtml + '</div>'
    + cardsHtml,
    req
  ));
});

// ─── Quote tool ───────────────────────────────────────────────────────────────

router.get('/quote/:id', requireAuth, function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');

  var allQuotes = db.prepare('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC').all(lead.id);
  var existing = allQuotes[0] || {};
  var q = existing;
  var currentService = q.service || lead.service || '';
  var currentTier    = q.tier || 'standard';
  var currentTaxRate = q.tax_rate != null ? +(q.tax_rate * 100).toFixed(2) : +(PRICING.taxRate * 100).toFixed(2);

  var serviceNames = Object.keys(PRICING.services);
  var currentServices = currentService ? currentService.split(', ').map(function(s) { return s.trim(); }) : [];
  var serviceCheckboxes = '<div class="svc-check-list">'
    + serviceNames.map(function(s) {
        var checked = currentServices.indexOf(s) !== -1 ? ' checked' : '';
        return '<label class="svc-check-item"><input type="checkbox" class="svc-cb" value="' + esc(s) + '"' + checked + ' onchange="updatePrices()"><span class="svc-box"></span>' + esc(s) + '</label>';
      }).join('')
    + '</div>'
    + '<input type="hidden" name="service" id="svcHidden" value="' + esc(currentService) + '">';

  var pricingJson = JSON.stringify(PRICING.services);
  var noEmail = !lead.email;

  var quoteAlert = '';
  if (req.query.msg === 'approved') quoteAlert = '<div class="alert alert-success">Time confirmed. Customer notified.</div>';
  if (req.query.msg === 'denied')   quoteAlert = '<div class="alert alert-error" style="background:#fff8e1;color:#7a5a00;border-color:#f0d080;">Time denied. Customer notified — we\'ll reach out to reschedule.</div>';

  var body = '<a href="/admin" class="back-link">&#8592; All Leads</a>'
    + quoteAlert

    // Customer info card
    + '<div class="card">'
    + '<div class="row-sb" style="margin-bottom:10px;">'
    + '<div><div class="lead-name">' + esc(lead.first_name) + ' ' + esc(lead.last_name) + '</div>'
    + '<div style="color:#aaa;font-size:0.8rem;">' + timeAgo(lead.created_at) + '</div></div>'
    + statusBadge(lead.status)
    + '</div>'
    + '<div class="info-grid">'
    + '<span class="info-key">Phone</span><span class="info-val"><a href="tel:' + esc(lead.phone) + '" style="color:#1a6fc4;">' + esc(lead.phone) + '</a></span>'
    + (lead.email   ? '<span class="info-key">Email</span><span class="info-val">' + esc(lead.email) + '</span>'
                    : '<span class="info-key">Email</span><span class="info-val" style="color:#e07000;font-style:italic;">No email on file</span>')
    + (lead.vehicle ? '<span class="info-key">Vehicle</span><span class="info-val">' + esc(lead.vehicle) + '</span>' : '')
    + '<span class="info-key">Service</span><span class="info-val">' + esc(lead.service || 'Not specified') + '</span>'
    + (lead.preferred_contact ? '<span class="info-key">Contact via</span><span class="info-val">' + esc(lead.preferred_contact) + '</span>' : '')
    + (lead.message ? '<span class="info-key">Notes</span><span class="info-val" style="font-style:italic;">' + esc(lead.message) + '</span>' : '')
    + '</div>'
    + '<form method="POST" action="/admin/lead/' + lead.id + '/status" style="margin-top:12px;display:flex;align-items:center;gap:8px;">'
    + '<input type="hidden" name="back" value="/admin/quote/' + lead.id + '">'
    + '<label style="font-size:0.78rem;color:#aaa;font-weight:600;white-space:nowrap;">Status:</label>'
    + '<select name="status" onchange="this.form.submit()" style="flex:1;padding:7px 10px;border:1.5px solid #dde3ea;border-radius:6px;font-size:0.88rem;color:#1a2a3a;background:#fff;">'
    + ['new','quoted','follow_up','quote_accepted','booked','completed'].map(function(s) {
        var label = { new:'New', quoted:'Quoted', follow_up:'Follow Up', quote_accepted:'Quote Accepted', booked:'Booked', completed:'Completed' }[s];
        return '<option value="' + s + '"' + (lead.status === s ? ' selected' : '') + '>' + label + '</option>';
      }).join('')
    + '</select>'
    + '</form>'
    + '</div>'

    // Quote history
    + (allQuotes.length > 0
        ? '<div class="card">'
          + '<div class="section-title" style="margin-bottom:10px;">Quote History <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(' + allQuotes.length + ')</span></div>'
          + '<div style="overflow-x:auto;">'
          + '<table style="width:100%;border-collapse:collapse;font-size:0.83rem;">'
          + '<thead><tr style="border-bottom:2px solid #f0f0f0;">'
          + '<th style="text-align:left;padding:4px 8px 8px 0;color:#888;font-weight:600;">Date</th>'
          + '<th style="text-align:left;padding:4px 8px 8px;color:#888;font-weight:600;">Service</th>'
          + '<th style="text-align:left;padding:4px 8px 8px;color:#888;font-weight:600;">Tier</th>'
          + '<th style="text-align:right;padding:4px 0 8px 8px;color:#888;font-weight:600;">Total</th>'
          + '</tr></thead><tbody>'
          + allQuotes.map(function(pq, i) {
              var isLatest = i === 0;
              var sentDate = pq.sent_at ? new Date(pq.sent_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—';
              var tierLabel = pq.tier === 'premium' ? 'Premium' : 'Standard';
              return '<tr style="border-bottom:1px solid #f0f0f0;' + (isLatest ? 'font-weight:600;' : 'color:#666;') + '">'
                + '<td style="padding:7px 8px 7px 0;white-space:nowrap;">' + sentDate + (isLatest ? ' <span style="font-size:0.72rem;background:#e3f0ff;color:#1a6fc4;padding:1px 6px;border-radius:10px;font-weight:700;">Latest</span>' : '') + '</td>'
                + '<td style="padding:7px 8px;">' + esc(pq.service || '—') + '</td>'
                + '<td style="padding:7px 8px;">' + tierLabel + '</td>'
                + '<td style="padding:7px 0 7px 8px;text-align:right;">$' + fmt(pq.total) + '</td>'
                + '</tr>';
            }).join('')
          + '</tbody></table></div></div>'
        : '')

    // Lead history timeline
    + (function() {
        var history = db.prepare('SELECT * FROM lead_history WHERE lead_id = ? ORDER BY id ASC').all(lead.id);
        if (history.length === 0) return '';
        var rows = history.map(function(h) {
          return '<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f4f4f4;">'
            + '<div style="width:10px;height:10px;border-radius:50%;background:#4169e1;flex-shrink:0;margin-top:5px;"></div>'
            + '<div><div style="font-size:0.88rem;color:#1a2a3a;font-weight:600;">' + esc(h.event) + '</div>'
            + (h.detail ? '<div style="font-size:0.82rem;color:#888;margin-top:2px;">' + esc(h.detail) + '</div>' : '')
            + '<div style="font-size:0.78rem;color:#bbb;margin-top:2px;">' + fmtHistoryTime(h.created_at) + '</div>'
            + '</div></div>';
        }).join('');
        return '<div class="card">'
          + '<div class="section-title" style="margin-bottom:10px;">Lead History</div>'
          + '<div style="padding-left:4px;">' + rows + '</div>'
          + '</div>';
      })()

    // Quote form
    + '<form method="POST" action="/admin/quote/' + lead.id + '/send" id="qf">'
    + '<div class="card">'
    + '<div class="section-title">Build Quote</div>'

    + '<div class="form-group"><label>Service <span style="color:#bbb;font-weight:400;">(select all that apply)</span></label>'
    + serviceCheckboxes
    + '<button type="button" class="svc-clear-btn" onclick="clearServices()">&#10005; Clear selection</button>'
    + '<div class="svc-tags" id="svcTags"></div>'
    + '</div>'

    + '<div class="form-group"><label>Tier</label>'
    + '<div class="tier-toggle">'
    + '<button type="button" class="tier-btn' + (currentTier === 'standard' ? ' active' : '') + '" id="btnStd" onclick="setTier(\'standard\')">Standard</button>'
    + '<button type="button" class="tier-btn' + (currentTier === 'premium'  ? ' active' : '') + '" id="btnPrem" onclick="setTier(\'premium\')">Premium</button>'
    + '</div>'
    + '<input type="hidden" name="tier" id="tierVal" value="' + esc(currentTier) + '"></div>'

    // Price breakdown — internal section (parts + labor visible to admin only)
    + '<div class="price-section">'
    + '<div class="price-section-header">Internal Breakdown <span style="font-weight:400;text-transform:none;letter-spacing:0;">(not sent to customer)</span></div>'
    + '<div class="price-row">'
    + '<span class="price-label">Parts</span>'
    + '<input class="price-input" type="number" name="parts" id="parts" min="0" step="0.01" value="' + fmt(q.price_parts) + '" oninput="calc()"></div>'
    + '<div class="price-row">'
    + '<span class="price-label">Labor <span class="price-note">(not taxed)</span></span>'
    + '<input class="price-input" type="number" name="labor" id="labor" min="0" step="0.01" value="' + fmt(q.price_labor) + '" oninput="calc()"></div>'
    + '<div class="price-row">'
    + '<span class="price-label">Shop Supplies</span>'
    + '<input class="price-input" type="number" name="shopSupplies" id="ss" min="0" step="0.01" value="' + fmt(q.shop_supplies) + '" oninput="calc()"></div>'
    + '<div class="price-row tax-row">'
    + '<span class="price-label" style="display:flex;align-items:center;gap:5px;">VA Tax (<input class="tax-rate-input" type="number" name="taxRate" id="tr" min="0" max="20" step="0.1" value="' + fmt(currentTaxRate) + '" oninput="calc()">%) on Parts + Supplies</span>'
    + '<span id="taxAmt">$' + fmt(q.tax) + '</span></div>'
    + '</div>'

    // Customer-facing totals
    + '<div class="price-section" style="margin-bottom:0;">'
    + '<div class="price-section-header">Customer Quote</div>'
    + '<div class="price-row"><span class="price-label">Parts &amp; Labor</span><span id="partsLaborDisplay">$' + fmt((q.price_parts || 0) + (q.price_labor || 0)) + '</span></div>'
    + '<div class="price-row"><span class="price-label">Shop Supplies</span><span id="ssDisplay">$' + fmt(q.shop_supplies) + '</span></div>'
    + '<div class="price-row tax-row"><span class="price-label">Tax</span><span id="taxDisplay">$' + fmt(q.tax) + '</span></div>'
    + '<div class="price-row total-row divider-row"><span>Total</span><span id="totalAmt" style="font-size:1.15rem;">$' + fmt(q.total) + '</span></div>'
    + '</div>'

    + '<input type="hidden" name="taxAmt"   id="taxH"   value="' + fmt(q.tax)   + '">'
    + '<input type="hidden" name="totalAmt" id="totalH" value="' + fmt(q.total) + '">'
    + '</div>'

    // VIN and notes
    + '<div class="card">'
    + '<div class="form-group"><label>VIN <span style="color:#bbb;font-weight:400;">(optional)</span></label>'
    + '<input type="text" name="vin" placeholder="17-character VIN" value="' + esc(q.vin || '') + '" maxlength="17"></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Internal Notes <span style="color:#bbb;font-weight:400;">(not sent to customer)</span></label>'
    + '<textarea name="internalNotes" placeholder="Parts ordered, scheduling notes, vehicle details...">' + esc(q.internal_notes || '') + '</textarea></div>'
    + '</div>'

    + (noEmail ? '<div class="alert alert-error" style="margin-bottom:8px;">No email on file. Quote will be saved but not emailed.</div>' : '')
    + '<button type="button" class="btn btn-outline" onclick="togglePreview()" id="prevBtn">Preview Email</button>'
    + '<div id="previewBox" style="display:none;"></div>'
    + '<button type="submit" class="btn btn-blue" style="margin-top:10px;">Send Quote</button>'
    + '</form>'

    + '<script>'
    + 'var PRICING=' + pricingJson + ';'
    + 'var tier="' + esc(currentTier) + '";'
    + 'var firstName="' + esc(lead.first_name) + '";'
    + 'var vehicle="' + esc(lead.vehicle || '') + '";'
    + 'var leadEmail="' + esc(lead.email || '') + '";'

    + 'function setTier(t){'
    +   'tier=t;'
    +   'document.getElementById("tierVal").value=t;'
    +   'document.getElementById("btnStd").classList.toggle("active",t==="standard");'
    +   'document.getElementById("btnPrem").classList.toggle("active",t==="premium");'
    +   'updatePrices();'
    + '}'

    + 'function renderTags(){'
    +   'var names=Array.from(document.querySelectorAll(".svc-cb:checked")).map(function(c){return c.value;});'
    +   'var box=document.getElementById("svcTags");'
    +   'box.innerHTML=names.map(function(n){'
    +     'var title=n.replace(/\\b\\w/g,function(c){return c.toUpperCase();});'
    +     'return "<span class=\'svc-tag\'><button type=\'button\' class=\'svc-tag-x\' onclick=\'removeTag(this)\' data-val=\'"+n+"\'>&#10005;</button>"+title+"</span>";'
    +   '}).join("");'
    + '}'

    + 'function removeTag(btn){'
    +   'var val=btn.getAttribute("data-val");'
    +   'var cb=Array.from(document.querySelectorAll(".svc-cb")).find(function(c){return c.value===val;});'
    +   'if(cb){cb.checked=false;}'
    +   'updatePrices();'
    + '}'

    + 'function clearServices(){'
    +   'document.querySelectorAll(".svc-cb").forEach(function(cb){cb.checked=false;});'
    +   'document.getElementById("svcHidden").value="";'
    +   'document.getElementById("parts").value="0.00";'
    +   'document.getElementById("labor").value="0.00";'
    +   'document.getElementById("ss").value="0.00";'
    +   'renderTags();'
    +   'calc();'
    + '}'

    + 'function updatePrices(){'
    +   'var cbs=document.querySelectorAll(".svc-cb:checked");'
    +   'var names=Array.from(cbs).map(function(c){return c.value;});'
    +   'document.getElementById("svcHidden").value=names.join(", ");'
    +   'var totParts=0,totLabor=0,totSS=0;'
    +   'names.forEach(function(svc){'
    +     'if(!PRICING[svc])return;'
    +     'var p=PRICING[svc][tier];'
    +     'if(!p)return;'
    +     'totParts+=p.parts;totLabor+=p.labor;totSS+=p.shopSupplies;'
    +   '});'
    +   'renderTags();'
    +   'if(names.length===0)return;'
    +   'document.getElementById("parts").value=totParts.toFixed(2);'
    +   'document.getElementById("labor").value=totLabor.toFixed(2);'
    +   'document.getElementById("ss").value=totSS.toFixed(2);'
    +   'calc();'
    + '}'

    // Tax is on parts + shop supplies only (not labor — Virginia law)
    + 'function calc(){'
    +   'var parts=parseFloat(document.getElementById("parts").value)||0;'
    +   'var labor=parseFloat(document.getElementById("labor").value)||0;'
    +   'var ss=parseFloat(document.getElementById("ss").value)||0;'
    +   'var tr=parseFloat(document.getElementById("tr").value)||0;'
    +   'var tax=(parts+ss)*tr/100;'
    +   'var total=parts+labor+ss+tax;'
    +   'document.getElementById("taxAmt").textContent="$"+tax.toFixed(2);'
    +   'document.getElementById("partsLaborDisplay").textContent="$"+(parts+labor).toFixed(2);'
    +   'document.getElementById("ssDisplay").textContent="$"+ss.toFixed(2);'
    +   'document.getElementById("taxDisplay").textContent="$"+tax.toFixed(2);'
    +   'document.getElementById("totalAmt").textContent="$"+total.toFixed(2);'
    +   'document.getElementById("taxH").value=tax.toFixed(2);'
    +   'document.getElementById("totalH").value=total.toFixed(2);'
    + '}'

    + 'function togglePreview(){'
    +   'var box=document.getElementById("previewBox");'
    +   'if(box.style.display!=="none"){box.style.display="none";document.getElementById("prevBtn").textContent="Preview Email";return;}'
    +   'var svcNames=Array.from(document.querySelectorAll(".svc-cb:checked")).map(function(c){return c.value;});'
    +   'var svc=svcNames.length?svcNames.join(", "):"(no service selected)";'
    +   'var parts=parseFloat(document.getElementById("parts").value)||0;'
    +   'var labor=parseFloat(document.getElementById("labor").value)||0;'
    +   'var ss=parseFloat(document.getElementById("ss").value)||0;'
    +   'var tax=parseFloat(document.getElementById("taxH").value)||0;'
    +   'var tot=parseFloat(document.getElementById("totalH").value)||0;'
    +   'var tierLabel=tier.charAt(0).toUpperCase()+tier.slice(1);'
    +   'var veh=vehicle?" for your <strong>"+vehicle+"</strong>":"";'
    +   'var toLine=leadEmail||"<em style=\'color:#e07000\'>(no email on file)</em>";'
    +   'var svcListHtml=svcNames.map(function(s){return "<li style=\'padding:3px 0;\'>"+s+"</li>";}).join("");'
    +   'box.innerHTML='
    +     '"<div class=\'preview-box\'>"'
    +     '+"<h4>Email Preview</h4>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:4px;\'>To: "+toLine+"</div>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:8px;\'>Subject: Your Brake Service Quote — Brake Knights</div>"'
    +     '+"<hr class=\'preview-divider\'>"'
    +     '+"<p>Greetings "+firstName+",</p>"'
    +     '+"<p style=\'margin-top:8px;\'>Here is your <strong>"+tierLabel+"</strong> quote"+veh+":</p>"'
    +     '+"<div style=\'margin:10px 0 4px;font-size:0.8rem;font-weight:700;color:#0a1f3d;text-transform:uppercase;letter-spacing:.4px;\'>Services Included</div>"'
    +     '+"<ul style=\'margin:0 0 12px;padding-left:18px;font-size:0.9rem;color:#1a2a3a;\'>"+svcListHtml+"</ul>"'
    +     '+"<table style=\'width:100%;margin:12px 0;font-size:0.88rem;border-collapse:collapse;\'>"'
    +     '+"<tr><td>Parts &amp; Labor</td><td style=\'text-align:right;\'>$"+(parts+labor).toFixed(2)+"</td></tr>"'
    +     '+"<tr><td>Shop Supplies</td><td style=\'text-align:right;\'>$"+ss.toFixed(2)+"</td></tr>"'
    +     '+"<tr><td>Tax</td><td style=\'text-align:right;\'>$"+tax.toFixed(2)+"</td></tr>"'
    +     '+"<tr style=\'font-weight:700;font-size:1rem;border-top:2px solid #dde3ea;\'><td style=\'padding-top:8px;\'>Total</td><td style=\'text-align:right;padding-top:8px;\'>$"+tot.toFixed(2)+"</td></tr>"'
    +     '+"</table>"'
    +     '+"<p>Includes all parts and labor. Qualifying pad and rotor replacements carry a <strong>12-month / 12,000-mile warranty</strong>.</p>"'
    +     '+"<p style=\'margin-top:8px;\'>We come to your home or office. No shop visit needed.</p>"'
    +     '+"<p style=\'margin-top:8px;\'>Reply to this email or call/text <strong>703-977-4475</strong> to confirm.</p>"'
    +     '+"</div>";'
    +   'box.style.display="block";'
    +   'document.getElementById("prevBtn").textContent="Hide Preview";'
    + '}'

    + 'calc();'
    + 'renderTags();'
    + '</script>';

  res.send(page('Quote — ' + lead.first_name + ' ' + lead.last_name, body, req));
});

// ─── Send quote ───────────────────────────────────────────────────────────────

router.post('/quote/:id/send', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');

  var service       = req.body.service       || '';
  var tier          = req.body.tier          || 'standard';
  var parts         = parseFloat(req.body.parts)         || 0;
  var labor         = parseFloat(req.body.labor)         || 0;
  var shopSupplies  = parseFloat(req.body.shopSupplies)  || 0;
  var taxRate       = parseFloat(req.body.taxRate)       || 0;
  var taxAmt        = parseFloat(req.body.taxAmt)        || 0;
  var totalAmt      = parseFloat(req.body.totalAmt)      || 0;
  var vin           = req.body.vin            || null;
  var internalNotes = req.body.internalNotes  || null;

  var acceptToken = crypto.randomBytes(24).toString('hex');

  var info = db.prepare(
    'INSERT INTO quotes (lead_id, service, tier, price_parts, price_labor, shop_supplies, tax_rate, tax, total, vin, internal_notes, accept_token, sent_at, status) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\'),?)'
  ).run(lead.id, service, tier, parts, labor, shopSupplies, taxRate / 100, taxAmt, totalAmt, vin, internalNotes, acceptToken, lead.email ? 'sent' : 'saved');

  db.prepare("UPDATE leads SET status = 'quoted', status_updated_at = datetime('now') WHERE id = ?").run(lead.id);
  logHistory(lead.id, 'Quote sent', service + (tier ? ' (' + tier + ')' : '') + ' — $' + totalAmt.toFixed(2));

  if (!lead.email) return res.redirect('/admin?msg=saved');

  // Absolute base URL so the accept link points back to the same site that sent it
  // (dev.brakeknights.com on dev, brakeknights.com on prod) without an env var.
  var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
  var acceptUrl = baseUrl + '/quote/' + info.lastInsertRowid + '/' + acceptToken;

  if (!process.env.SMTP_PASS) {
    console.error('SMTP_PASS not set — quote saved but not emailed');
    return res.redirect('/admin?msg=err');
  }

  try {
    var transporter = nodemailer.createTransport({
      host: 'smtp.hostinger.com',
      port: 465,
      secure: true,
      auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS }
    });

    await transporter.sendMail({
      from:    '"Brake Knights" <greetings@brakeknights.com>',
      to:      lead.email,
      replyTo: 'greetings@brakeknights.com',
      subject: 'Your Brake Service Quote — Brake Knights',
      html:    buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, taxAmt, totalAmt, acceptUrl)
    });

    res.redirect('/admin?msg=sent');
  } catch (err) {
    console.error('Quote email error:', err.message);
    res.redirect('/admin?msg=err');
  }
});

// ─── Quote email (Phase 3C upgrades this to fully branded template) ───────────

function buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, tax, total, acceptUrl) {
  var tierLabel   = tier === 'premium' ? 'Premium' : 'Standard';
  var partsLabor  = parts + labor;
  var vehicleBit  = lead.vehicle ? ' for your <strong>' + esc(lead.vehicle) + '</strong>' : '';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">'
    + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
    + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;">'
    + '<img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;">'
    + 'Brake Knights</h1>'
    + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service — Northern Virginia</p>'
    + '</div>'
    + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
    + '<h2 style="color:#0a1f3d;margin:0 0 16px;font-size:1.15rem;">Greetings ' + esc(lead.first_name) + ',</h2>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 20px;">Here is your <strong>' + tierLabel + '</strong> quote' + vehicleBit + ':</p>'
    + '<div style="background:#f4f7fb;border-radius:8px;padding:20px;margin-bottom:24px;">'
    + '<p style="font-weight:700;color:#0a1f3d;margin:0 0 8px;font-size:0.82rem;text-transform:uppercase;letter-spacing:.5px;">Services Included</p>'
    + '<ul style="margin:0 0 16px;padding-left:18px;font-size:0.95rem;color:#1a2a3a;font-weight:600;">'
    + service.split(', ').map(function(s) { return '<li style="padding:3px 0;">' + esc(s.trim()) + '</li>'; }).join('')
    + '</ul>'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
    + '<tr><td style="padding:6px 0;">Parts &amp; Labor</td><td style="text-align:right;">$' + partsLabor.toFixed(2) + '</td></tr>'
    + '<tr><td style="padding:6px 0;">Shop Supplies</td><td style="text-align:right;">$' + shopSupplies.toFixed(2) + '</td></tr>'
    + '<tr><td style="padding:6px 0;color:#888;">Tax</td><td style="text-align:right;color:#888;">$' + tax.toFixed(2) + '</td></tr>'
    + '<tr style="border-top:2px solid #dde3ea;"><td style="padding:10px 0 0;font-weight:700;font-size:1rem;color:#0a1f3d;">Total</td>'
    + '<td style="text-align:right;padding:10px 0 0;font-weight:700;font-size:1.1rem;color:#0a1f3d;">$' + total.toFixed(2) + '</td></tr>'
    + '</table></div>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 12px;font-size:0.9rem;">This quote includes all parts and labor. All qualifying pad and rotor replacements come with a <strong>12-month / 12,000-mile warranty</strong> on parts and labor.</p>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 24px;font-size:0.9rem;">Our service is fully mobile. We come directly to your home or office. No shop visit needed.</p>'
    // Primary CTA — accept the quote and pick a preferred time in one step
    + (acceptUrl
        ? '<div style="text-align:center;margin:0 0 24px;">'
          + '<a href="' + acceptUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:1rem;text-decoration:none;padding:15px 34px;border-radius:8px;">Accept Quote &amp; Choose Your Time &rarr;</a>'
          + '<p style="color:#888;font-size:0.82rem;margin:12px 0 0;">You&rsquo;ll pick a preferred day and time. We&rsquo;ll confirm it or reach out about other openings.</p>'
          + '</div>'
        : '')
    + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
    + '<p style="color:#fff;font-weight:700;margin:0 0 8px;font-size:0.95rem;">Prefer to talk it through? Reply to this email or call/text:</p>'
    + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
    + '</div></div>'
    + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div>'
    + '</div>';
}

module.exports = router;
