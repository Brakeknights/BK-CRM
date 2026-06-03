const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const db = require('../db');
const { toEasternRfc3339 } = require('../datetime');
const pricing = require('../pricing');

// On-site duration (minutes) for a service, falling back to the default.
function serviceMinutes(service) {
  var svc = pricing.services[service];
  return (svc && svc.minutes) || pricing.defaultMinutes || 60;
}

// Formats a JS Date as an ICS UTC timestamp, e.g. 20260608T160000Z.
function icsUtc(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// Escapes text for an ICS field (commas, semicolons, backslashes, newlines).
function icsEscape(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

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

// Display money with thousands separators, e.g. 1039.5 -> "1,039.50".
function money(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Natural list join, e.g. "A, B, and C" (or "A, and B").
function joinServices(s) {
  var a = String(s || '').split(', ').map(function(x) { return x.trim(); }).filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
}

// Total on-site minutes across all selected services.
function totalMinutes(s) {
  return String(s || '').split(', ').reduce(function(sum, name) {
    var sv = pricing.services[name.trim()];
    return sum + ((sv && sv.minutes) || 0);
  }, 0);
}

// Friendly duration, e.g. 90 -> "1 hr 30 min".
function formatDuration(mins) {
  if (!mins) return '';
  var h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return h + ' hr ' + m + ' min';
  if (h) return h + ' hr';
  return m + ' min';
}

var WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Upcoming bookable days as <option>s. Value is ISO (YYYY-MM-DD), label shows
// weekday + date. Sundays are skipped (closed). Covers the next ~6 weeks.
function buildDateOptions() {
  var opts = '<option value="" disabled selected>Select a day…</option>';
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  for (var added = 0, days = 0; added < 35 && days < 60; days++) {
    var day = new Date(d.getTime() + days * 86400000);
    if (day.getDay() === 0) continue; // closed Sundays
    var iso = day.getFullYear() + '-'
      + String(day.getMonth() + 1).padStart(2, '0') + '-'
      + String(day.getDate()).padStart(2, '0');
    var label = WEEKDAYS[day.getDay()] + ', ' + MONTHS[day.getMonth()] + ' ' + day.getDate();
    opts += '<option value="' + iso + '" data-wday="' + day.getDay() + '">' + label + '</option>';
    added++;
  }
  return opts;
}

// Time slots in 30-minute increments, 9:00 AM through 6:00 PM inclusive.
function buildTimeOptions() {
  var opts = '<option value="" disabled selected>Select a time…</option>'
    + '<option value="Anytime">Anytime</option>';
  for (var mins = 9 * 60; mins <= 18 * 60; mins += 30) {
    var h24 = Math.floor(mins / 60);
    var m = mins % 60;
    var ampm = h24 < 12 ? 'AM' : 'PM';
    var h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    var label = h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
    opts += '<option value="' + label + '">' + label + '</option>';
  }
  return opts;
}

// Format a stored ISO date (YYYY-MM-DD) as "Friday, June 5, 2026".
// Falls back to the raw value if it isn't an ISO date.
function formatPrefDate(val) {
  if (!val) return '—';
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
  if (!m) return val;
  var dt = new Date(+m[1], +m[2] - 1, +m[3]);
  return WEEKDAYS[dt.getDay()] + ', ' + MONTHS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
}

function transporter() {
  return nodemailer.createTransport({
    host: 'smtp.hostinger.com',
    port: 465,
    secure: true,
    auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS }
  });
}

// Branded full-page shell matching the public site (navy/blue).
function shell(title, inner) {
  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>' + esc(title) + ' — Brake Knights</title>'
    + '<link rel="icon" href="/images/favicon.png">'
    + '<style>'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;background:#eef2f7;color:#1a2a3a;line-height:1.6;padding:0 0 48px}'
    + '.topbar{background:#0a1f3d;padding:18px 16px;text-align:center}'
    + '.topbar a{color:#6b8ff5;font-weight:700;font-size:1.05rem;letter-spacing:.5px;text-decoration:none;display:inline-flex;align-items:center;gap:9px}'
    + '.topbar img{width:26px;height:26px;border-radius:6px}'
    + '.topbar .tag{display:block;color:#8aadcf;font-size:0.78rem;font-weight:400;letter-spacing:0;margin-top:3px}'
    + '.wrap{max-width:560px;margin:0 auto;padding:18px 16px}'
    + '.card{background:#fff;border-radius:14px;padding:24px;margin-bottom:16px;box-shadow:0 2px 10px rgba(10,31,61,.07)}'
    + 'h1{font-size:1.35rem;color:#0a1f3d;margin-bottom:6px}'
    + 'h2{font-size:1.05rem;color:#0a1f3d;margin-bottom:12px}'
    + 'p{color:#445;margin-bottom:12px}'
    + '.muted{color:#8a98a8;font-size:0.88rem}'
    + '.qline{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f0f0;font-size:0.95rem}'
    + '.qline:last-child{border-bottom:none}'
    + '.qtotal{font-weight:700;font-size:1.2rem;color:#0a1f3d;border-top:2px solid #dde3ea;margin-top:4px;padding-top:12px}'
    + '.svc{font-size:1.1rem;font-weight:700;color:#0a1f3d;margin-bottom:2px}'
    + '.badge{display:inline-block;background:#e3f0ff;color:#1a6fc4;font-size:0.75rem;font-weight:700;padding:3px 11px;border-radius:20px;letter-spacing:.3px;margin-bottom:14px}'
    + '.form-group{margin-bottom:16px}'
    + '.form-group label{display:block;font-size:0.86rem;font-weight:600;color:#445;margin-bottom:6px}'
    + '.form-group input,.form-group select,.form-group textarea{width:100%;padding:12px 13px;border:1.5px solid #dde3ea;border-radius:9px;font-size:1rem;color:#1a2a3a;background:#fff;font-family:inherit}'
    + '.form-group input:focus,.form-group select:focus,.form-group textarea:focus{outline:none;border-color:#0a1f3d}'
    + '.form-group textarea{resize:vertical;min-height:72px}'
    + '.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}'
    + '.btn{display:block;width:100%;padding:15px;border:none;border-radius:9px;font-size:1.02rem;font-weight:700;cursor:pointer;text-align:center;text-decoration:none}'
    + '.btn-blue{background:#4169e1;color:#fff}'
    + '.btn-blue:hover{opacity:.9}'
    + '.note{background:#f4f7fb;border-left:4px solid #4169e1;border-radius:6px;padding:12px 14px;font-size:0.88rem;color:#556;margin-top:16px}'
    + '.check{width:58px;height:58px;border-radius:50%;background:#e6f9ee;color:#1a7a3a;font-size:1.9rem;line-height:58px;text-align:center;margin:0 auto 16px}'
    + '.footer{text-align:center;color:#9aa7b4;font-size:0.78rem;margin-top:8px}'
    + '.footer a{color:#7a8794;text-decoration:none}'
    + '.callbar{text-align:center;margin-top:18px}'
    + '.callbar a{color:#0a1f3d;font-weight:700;text-decoration:none}'
    + '</style></head><body>'
    + '<div class="topbar"><a href="https://brakeknights.com"><img src="/images/favicon.png" alt=""> Brake Knights'
    + '<span class="tag">Mobile Brake Service — Northern Virginia</span></a></div>'
    + '<div class="wrap">' + inner + '</div>'
    + '<div class="footer">Brake Knights &middot; Sterling, VA &middot; <a href="https://brakeknights.com">brakeknights.com</a></div>'
    + '</body></html>';
}

function quoteSummaryCard(q) {
  var partsLabor = (q.price_parts || 0) + (q.price_labor || 0);
  return '<div class="card">'
    + '<span class="badge">Your Quote</span>'
    + '<div class="svc">' + esc(joinServices(q.service) || 'Brake Service') + '</div>'
    + (q.vehicle ? '<p class="muted" style="margin-bottom:14px;">' + esc(q.vehicle) + '</p>' : '<div style="height:6px"></div>')
    + '<div class="qline"><span>Parts &amp; Labor</span><span>$' + money(partsLabor) + '</span></div>'
    + '<div class="qline"><span>Shop Supplies</span><span>$' + money(q.shop_supplies) + '</span></div>'
    + '<div class="qline"><span style="color:#889;">Tax</span><span style="color:#889;">$' + money(q.tax) + '</span></div>'
    + '<div class="qline qtotal"><span>Total</span><span>$' + money(q.total) + '</span></div>'
    + '</div>';
}

// Load a quote joined with its lead, validating the accept token.
function loadQuote(id, token) {
  var q = db.prepare(
    'SELECT q.*, l.first_name, l.last_name, l.vehicle, l.email AS lead_email, l.phone AS lead_phone '
    + 'FROM quotes q JOIN leads l ON l.id = q.lead_id WHERE q.id = ?'
  ).get(id);
  if (!q || !q.accept_token || q.accept_token !== token) return null;
  return q;
}

// ─── Calendar file (.ics) ─────────────────────────────────────────────────────
// Token-protected so it works straight from the confirmation email. Universal:
// adds the appointment on Apple Calendar, Google Calendar, and Outlook.
router.get('/:id/:token/calendar.ics', function(req, res) {
  var q = loadQuote(req.params.id, req.params.token);
  if (!q || !q.pref_date) return res.status(404).send('Appointment not found.');

  var startRfc = toEasternRfc3339(q.pref_date, q.pref_time);
  if (!startRfc) return res.status(404).send('Appointment time unavailable.');
  var start = new Date(startRfc);
  var end = new Date(start.getTime() + serviceMinutes(q.service) * 60 * 1000); // per-service block

  var summary = 'Brake Knights — ' + (q.service || 'Brake Service');
  var desc = 'Mobile brake service' + (q.service ? ' (' + q.service + ')' : '')
    + '. Total: $' + money(q.total) + '. Questions? Call or text 703-977-4475.';

  var ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Brake Knights//Appointments//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:bk-quote-' + q.id + '@brakeknights.com',
    'DTSTAMP:' + icsUtc(new Date()),
    'DTSTART:' + icsUtc(start),
    'DTEND:' + icsUtc(end),
    'SUMMARY:' + icsEscape(summary),
    'LOCATION:' + icsEscape(q.pref_location || ''),
    'DESCRIPTION:' + icsEscape(desc),
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  res.set('Content-Type', 'text/calendar; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="brakeknights-appointment.ics"');
  res.send(ics);
});

// ─── Accept page (GET) ────────────────────────────────────────────────────────

router.get('/:id/:token', function(req, res) {
  var q = loadQuote(req.params.id, req.params.token);
  if (!q) {
    return res.status(404).send(shell('Quote Not Found',
      '<div class="card" style="text-align:center;">'
      + '<h1>Quote not found</h1>'
      + '<p>This link may have expired or is no longer valid.</p>'
      + '<p class="muted">Call or text us at <a href="tel:+17039774475" style="color:#0a1f3d;font-weight:700;">703-977-4475</a> and we&rsquo;ll sort it out.</p>'
      + '</div>'));
  }

  // Already accepted — show the confirmation state instead of the form.
  if (q.accepted_at) {
    return res.send(shell('Quote Accepted', acceptedConfirmation(q)));
  }

  // Google Places address autocomplete is enabled only when an API key is set.
  // Until then the address field is a plain text input.
  var mapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
  var addressAutocomplete = mapsKey
    ? '<script>function initBkAddr(){var input=document.getElementById("prefLocation");if(!input||!window.google||!google.maps||!google.maps.places)return;'
      + 'var ac=new google.maps.places.Autocomplete(input,{fields:["formatted_address"],componentRestrictions:{country:"us"},types:["address"]});'
      + 'ac.addListener("place_changed",function(){var p=ac.getPlace();if(p&&p.formatted_address){input.value=p.formatted_address;}});'
      + 'input.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();}});}</script>'
      + '<script src="https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(mapsKey) + '&libraries=places&loading=async&callback=initBkAddr" async></script>'
    : '';

  var body = '<div class="card">'
    + '<h1>Greetings ' + esc(q.first_name) + ',</h1>'
    + '<p>Your quote is ready. Review the details below, choose a preferred day and time, and accept. We&rsquo;ll confirm your appointment or reach out about other openings.</p>'
    + '</div>'
    + quoteSummaryCard(q)
    + '<div class="card">'
    + '<h2>Choose Your Preferred Time</h2>'
    + (totalMinutes(q.service) ? '<p class="muted" style="margin:-6px 0 14px;">This service takes about <strong style="color:#0a1f3d;">' + formatDuration(totalMinutes(q.service)) + '</strong> on site. Please pick a time that allows for it.</p>' : '')
    + '<form method="POST" action="/quote/' + q.id + '/' + q.accept_token + '/accept">'
    + '<div class="row2">'
    + '<div class="form-group"><label>Preferred date</label>'
    + '<select name="prefDate" required>' + buildDateOptions() + '</select></div>'
    + '<div class="form-group"><label>Preferred time</label>'
    + '<select name="prefTime" required>' + buildTimeOptions() + '</select></div>'
    + '</div>'
    + '<div class="form-group"><label>Service address</label>'
    + '<input type="text" id="prefLocation" name="prefLocation" placeholder="Where should we meet you? Home or work address" autocomplete="off" required></div>'
    + '<div class="form-group"><label>Anything else? <span style="color:#aab;font-weight:400;">(optional)</span></label>'
    + '<textarea name="schedulingNotes" placeholder="Gate codes, second choice of time, parking notes…"></textarea></div>'
    + '<button type="submit" class="btn btn-blue">Accept Quote &amp; Request This Time</button>'
    + '<div class="note">Accepting confirms the quoted price. Your time is a request: we&rsquo;ll review it and confirm, or contact you about other availability.</div>'
    + '</form>'
    + '</div>'
    + '<div class="callbar"><span class="muted">Questions first? Call or text </span><a href="tel:+17039774475">703-977-4475</a></div>'
    + '<script>'
    + '(function(){'
    +   'var dateEl=document.querySelector(\'select[name="prefDate"]\');'
    +   'var timeEl=document.querySelector(\'select[name="prefTime"]\');'
    +   'if(!dateEl||!timeEl)return;'
    +   'function capTimes(){'
    +     'var sel=dateEl.options[dateEl.selectedIndex];'
    +     'var isSat=sel&&sel.getAttribute("data-wday")==="6";'
    +     'Array.from(timeEl.options).forEach(function(o){'
    +       'if(!o.value)return;'
    +       'var parts=o.value.match(/(\\d+):(\\d+) (AM|PM)/);'
    +       'if(!parts)return;'
    +       'var h=parseInt(parts[1]);var m=parseInt(parts[2]);var ap=parts[3];'
    +       'var h24=(ap==="PM"&&h!==12)?h+12:(ap==="AM"&&h===12)?0:h;'
    +       'var mins=h24*60+m;'
    +       'o.disabled=isSat&&mins>15*60;'
    +       'if(o.disabled&&o.selected){o.selected=false;timeEl.value=""}'
    +     '});'
    +   '}'
    +   'dateEl.addEventListener("change",capTimes);'
    +   'capTimes();'
    + '})();'
    + '</script>'
    + addressAutocomplete;

  res.send(shell('Your Quote', body));
});

// ─── Accept submission (POST) ──────────────────────────────────────────────────

router.post('/:id/:token/accept', express.urlencoded({ extended: false }), async function(req, res) {
  var q = loadQuote(req.params.id, req.params.token);
  if (!q) return res.status(404).send(shell('Quote Not Found', '<div class="card"><h1>Quote not found</h1></div>'));

  // Idempotent — if they double-submit, just show the confirmation.
  if (q.accepted_at) return res.send(shell('Quote Accepted', acceptedConfirmation(q)));

  var prefDate        = (req.body.prefDate        || '').trim();
  var prefTime        = (req.body.prefTime        || '').trim();
  var prefLocation    = (req.body.prefLocation    || '').trim();
  var schedulingNotes = (req.body.schedulingNotes || '').trim() || null;

  db.prepare(
    'UPDATE quotes SET accepted_at = datetime(\'now\'), pref_date = ?, pref_time = ?, pref_location = ?, scheduling_notes = ? WHERE id = ?'
  ).run(prefDate, prefTime, prefLocation, schedulingNotes, q.id);

  // Move the lead to Quote Accepted so the owner reviews the scheduling request.
  db.prepare("UPDATE leads SET status = ?, status_updated_at = datetime('now') WHERE id = ?").run('quote_accepted', q.lead_id);

  // Reload so the confirmation reflects the saved values.
  var fresh = loadQuote(req.params.id, req.params.token);

  var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');

  // Log to lead history
  db.prepare("INSERT INTO lead_history (lead_id, event, detail) VALUES (?, ?, ?)").run(
    q.lead_id,
    'Quote accepted by customer',
    (prefDate || '') + (prefTime ? ' at ' + prefTime : '') + (prefLocation ? ' — ' + prefLocation : '')
  );

  // Fire emails after we have a valid record. Never let email failure break the page.
  if (process.env.SMTP_PASS) {
    try {
      var tx = transporter();
      // Owner notification — owner reviews and approves the requested time.
      await tx.sendMail({
        from:    '"Brake Knights" <greetings@brakeknights.com>',
        to:      'greetings@brakeknights.com',
        replyTo: q.lead_email || 'greetings@brakeknights.com',
        subject: 'Quote ACCEPTED: ' + q.first_name + ' ' + q.last_name + ' — needs scheduling',
        html:    ownerAcceptedEmail(fresh, baseUrl)
      });
      // No customer auto-reply here: the on-screen confirmation already covers it,
      // and the branded appointment-confirmed email is sent once the owner approves.
    } catch (err) {
      console.error('Acceptance email error:', err.message);
    }
  } else {
    console.error('SMTP_PASS not set — acceptance recorded but no emails sent');
  }

  res.send(shell('Quote Accepted', acceptedConfirmation(fresh)));
});

// ─── Confirmation views / emails ──────────────────────────────────────────────

function acceptedConfirmation(q) {
  return '<div class="card" style="text-align:center;">'
    + '<div class="check">&#10003;</div>'
    + '<h1>Quote accepted, ' + esc(q.first_name) + '</h1>'
    + '<p><strong>Your appointment isn&rsquo;t booked yet.</strong> We&rsquo;ve received your accepted quote and your preferred time below. We&rsquo;ll review it and email you a confirmation once your appointment is locked in, or reach out if we need to find another time.</p>'
    + '</div>'
    + '<div class="card">'
    + '<h2>Your Requested Time</h2>'
    + '<div class="qline"><span>Service</span><span style="text-align:right;max-width:60%;">' + esc(joinServices(q.service) || 'Brake Service') + '</span></div>'
    + '<div class="qline"><span>Total</span><span>$' + money(q.total) + '</span></div>'
    + (totalMinutes(q.service) ? '<div class="qline"><span>Estimated time</span><span>about ' + esc(formatDuration(totalMinutes(q.service))) + '</span></div>' : '')
    + '<div class="qline"><span>Preferred date</span><span>' + esc(formatPrefDate(q.pref_date)) + '</span></div>'
    + '<div class="qline"><span>Preferred time</span><span>' + esc(q.pref_time || '—') + '</span></div>'
    + '<div class="qline"><span>Location</span><span style="text-align:right;max-width:60%;">' + esc(q.pref_location || '—') + '</span></div>'
    + '</div>'
    + '<div class="callbar"><span class="muted">Need to change something? Call or text </span><a href="tel:+17039774475">703-977-4475</a></div>';
}

function ownerAcceptedEmail(q, baseUrl) {
  var adminUrl   = (baseUrl || 'https://brakeknights.com') + '/admin/quote/' + q.lead_id;
  var approveUrl = (baseUrl || 'https://brakeknights.com') + '/admin/quote/' + q.lead_id + '/approve-schedule';
  var denyUrl    = (baseUrl || 'https://brakeknights.com') + '/admin/quote/' + q.lead_id + '/deny-schedule';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">'
    + '<div style="background:#1a7a3a;padding:16px 20px;"><h2 style="color:#fff;margin:0;font-size:1.2rem;">&#10003; Quote Accepted — Review Scheduling Request</h2></div>'
    + '<div style="padding:20px;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.95rem;">'
    + '<tr><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;width:140px;">Customer</td><td style="padding:7px 10px;">' + esc(q.first_name) + ' ' + esc(q.last_name) + '</td></tr>'
    + '<tr style="background:#f9f9f9;"><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Phone</td><td style="padding:7px 10px;"><a href="tel:' + esc(q.lead_phone) + '">' + esc(q.lead_phone) + '</a></td></tr>'
    + '<tr><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Email</td><td style="padding:7px 10px;">' + esc(q.lead_email || '—') + '</td></tr>'
    + (q.vehicle ? '<tr style="background:#f9f9f9;"><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Vehicle</td><td style="padding:7px 10px;">' + esc(q.vehicle) + '</td></tr>' : '')
    + '<tr><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Service</td><td style="padding:7px 10px;">' + esc(q.service) + '</td></tr>'
    + '<tr style="background:#f9f9f9;"><td style="padding:7px 10px;font-weight:bold;color:#0a1f3d;">Total</td><td style="padding:7px 10px;">$' + money(q.total) + '</td></tr>'
    + '</table>'
    + '<div style="background:#e3f0ff;border-left:4px solid #4169e1;border-radius:4px;padding:14px;margin-top:16px;">'
    + '<p style="margin:0 0 8px;font-weight:bold;color:#0a1f3d;">Requested Scheduling</p>'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.92rem;color:#444;">'
    + '<tr><td style="padding:4px 0;color:#888;width:120px;">Date</td><td style="padding:4px 0;">' + esc(formatPrefDate(q.pref_date)) + '</td></tr>'
    + '<tr><td style="padding:4px 0;color:#888;">Time</td><td style="padding:4px 0;">' + esc(q.pref_time || '—') + '</td></tr>'
    + '<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Location</td><td style="padding:4px 0;">' + esc(q.pref_location || '—') + '</td></tr>'
    + (q.scheduling_notes ? '<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Notes</td><td style="padding:4px 0;">' + esc(q.scheduling_notes) + '</td></tr>' : '')
    + '</table></div>'
    + '<div style="margin-top:18px;display:flex;gap:10px;">'
    + '<a href="' + approveUrl + '" style="flex:1;display:block;background:#1a7a3a;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 10px;border-radius:8px;text-align:center;">&#10003; Approve This Time</a>'
    + '<a href="' + denyUrl + '" style="flex:1;display:block;background:#c0392b;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 10px;border-radius:8px;text-align:center;">&#10005; Time Not Available</a>'
    + '</div>'
    + '<div style="margin-top:10px;text-align:center;">'
    + '<a href="' + adminUrl + '" style="color:#4169e1;font-size:0.88rem;text-decoration:none;font-weight:600;">Open in Admin &rarr;</a>'
    + '</div>'
    + '</div></div>';
}

module.exports = router;
