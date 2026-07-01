const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const db = require('../db');
const { sendStagePush } = require('../push');
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

// Parse a "9:30 AM" style label to minutes since midnight; -1 if unparsable.
function slotMins(t) {
  var m = /(\d+):(\d+)\s*(AM|PM)/i.exec(t || '');
  if (!m) return -1;
  var h = (+m[1] % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
  return h * 60 + (+m[2]);
}
function slotLabel(mins) {
  var h24 = Math.floor(mins / 60), m = mins % 60;
  var ampm = h24 < 12 ? 'AM' : 'PM';
  var h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

// Customer-picker availability: which slots are already taken on a date.
// Each booked job occupies its start through its service duration plus a
// 1-hour bumper; the requesting customer's own duration (plus bumper) must
// also fit before the next booked job. These are scheduling defaults only —
// the owner has full control at approval time and owner forms are unrestricted.
// Owner personal time blocks are intentionally NOT included (visual only).
function blockedSlotsForDate(dateIso, ownService, excludeLeadId) {
  var jobs = db.prepare(
    "SELECT q.pref_time, q.service FROM quotes q JOIN leads l ON l.id = q.lead_id "
    + "WHERE l.status = 'booked' AND l.archived = 0 AND q.status = 'approved' "
    + "AND q.pref_date = ? AND q.lead_id != ?"
  ).all(dateIso, excludeLeadId || 0);
  var BUFFER = 60;
  var windows = [];
  jobs.forEach(function(j) {
    var start = slotMins(j.pref_time);
    if (start < 0) return; // "Anytime" or unparsable — no fixed window to block
    windows.push([start, start + (totalMinutes(j.service) || 60) + BUFFER]);
  });
  var ownDur = (totalMinutes(ownService) || 60) + BUFFER;
  var blocked = [];
  for (var mins = 9 * 60; mins <= 18 * 60; mins += 30) {
    var slotEnd = mins + ownDur;
    var conflict = windows.some(function(w) { return mins < w[1] && w[0] < slotEnd; });
    if (conflict) blocked.push(slotLabel(mins));
  }
  return blocked;
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
    + '.bk-date-val{font-size:0.92rem;font-weight:600;color:#0a1f3d;background:#f0f4f8;border-radius:8px;padding:10px 14px;margin-bottom:10px;min-height:42px;display:flex;align-items:center}'
    + '.bk-date-val.placeholder{color:#aab;font-weight:400}'
    + '.bk-cal-wrap{border:1.5px solid #dde3ea;border-radius:12px;overflow:hidden;background:#fff;user-select:none}'
    + '.bk-cal-hdr{display:flex;align-items:center;justify-content:space-between;background:#0a1f3d;padding:12px 16px}'
    + '.bk-cal-hdr span{color:#fff;font-weight:700;font-size:0.95rem}'
    + '.bk-cal-nav{background:rgba(255,255,255,.15);border:none;color:#fff;font-size:1rem;width:32px;height:32px;border-radius:6px;cursor:pointer;line-height:1}'
    + '.bk-cal-nav:hover{background:rgba(255,255,255,.28)}'
    + '.bk-cal-nav:disabled{opacity:.25;cursor:default}'
    + '.bk-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;padding:10px 8px 12px}'
    + '.bk-dh{text-align:center;font-size:0.7rem;font-weight:700;color:#aaa;padding:0 0 6px;letter-spacing:.04em}'
    + '.bk-dh.sun{color:#e0c0c0}'
    + '.bk-day{text-align:center;font-size:0.88rem;padding:8px 2px;border-radius:8px;cursor:default;color:#ddd;line-height:1}'
    + '.bk-day.avail{cursor:pointer;color:#1a2a3a}'
    + '.bk-day.avail:hover{background:#deeeff;color:#0a1f3d}'
    + '.bk-day.today{font-weight:700;box-shadow:inset 0 0 0 1.5px #4169e1}'
    + '.bk-day.sel{background:#0a1f3d!important;color:#fff!important;font-weight:700}'
    + '.bk-time-grid{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}'
    + '.bk-tb{padding:9px 14px;border:1.5px solid #dde3ea;border-radius:20px;background:#fff;color:#1a2a3a;font-size:0.88rem;cursor:pointer;font-weight:500;transition:background .12s,color .12s,border-color .12s}'
    + '.bk-tb:hover{background:#e3f0ff;border-color:#b9d4f5}'
    + '.bk-tb.sel{background:#0a1f3d!important;color:#fff!important;border-color:#0a1f3d!important;font-weight:700}'
    + '.bk-tb.off{color:#ccc;cursor:default;pointer-events:none}'
    + '.bk-pick-err{color:#c0392b;font-size:0.84rem;margin-top:5px;display:none}'
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
    + ((q.discount || 0) > 0 ? '<div class="qline"><span style="color:#1a7a3a;">Discount' + (q.discount_label ? ' (' + esc(q.discount_label) + ')' : '') + '</span><span style="color:#1a7a3a;">-$' + money(q.discount) + '</span></div>' : '')
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

// ─── Alternative time selection (customer taps a link from the scheduling email) ─
// Route must appear BEFORE /:id/:token to prevent Express matching "alt" as :id.
router.get('/alt/:quoteId/:token', async function(req, res) {
  var quote = db.prepare(
    'SELECT q.*, l.id AS lead_id, l.first_name, l.last_name, l.email AS lead_email '
    + 'FROM quotes q JOIN leads l ON l.id = q.lead_id WHERE q.id = ?'
  ).get(req.params.quoteId);

  // Find which alt slot this token matches.
  var slot = null;
  if (quote && quote.alt_token1 && quote.alt_token1 === req.params.token) slot = 1;
  else if (quote && quote.alt_token2 && quote.alt_token2 === req.params.token) slot = 2;
  else if (quote && quote.alt_token3 && quote.alt_token3 === req.params.token) slot = 3;

  if (!slot) {
    return res.status(404).send(shell('Link Not Found',
      '<div class="card" style="text-align:center;">'
      + '<h1>Link not found</h1>'
      + '<p>This link may have already been used or is no longer valid.</p>'
      + '<p class="muted">Call or text us at <a href="tel:+17039774475" style="color:#0a1f3d;font-weight:700;">703-977-4475</a> and we\'ll sort it out.</p>'
      + '</div>'));
  }

  var altDate = quote['alt_date' + slot];
  var altTime = quote['alt_time' + slot];
  var when = (altDate ? formatPrefDate(altDate) : '') + (altTime ? ' at ' + altTime : '');

  // Update quote: store chosen time, clear alt tokens, reset alt_times_sent.
  db.prepare(
    'UPDATE quotes SET pref_date=?, pref_time=?, alt_times_sent=0,'
    + 'alt_token1=NULL, alt_date1=NULL, alt_time1=NULL,'
    + 'alt_token2=NULL, alt_date2=NULL, alt_time2=NULL,'
    + 'alt_token3=NULL, alt_date3=NULL, alt_time3=NULL WHERE id=?'
  ).run(altDate, altTime, quote.id);

  db.prepare("UPDATE leads SET status='quote_accepted', status_updated_at=datetime('now') WHERE id=?").run(quote.lead_id);
  db.prepare("INSERT INTO lead_history (lead_id, event, detail) VALUES (?, ?, ?)").run(quote.lead_id, 'Customer selected alternative time', when);
  sendStagePush({ id: quote.lead_id, first_name: quote.first_name, last_name: quote.last_name, service: quote.service }, 'quote_accepted');

  // Notify admin.
  if (process.env.SMTP_PASS) {
    try {
      var name = quote.first_name + ' ' + quote.last_name;
      var adminUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host') + '/admin/quote/' + quote.lead_id;
      var adminHtml = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">'
        + '<div style="background:#0a1f3d;padding:14px 20px;"><h2 style="color:#6b8ff5;margin:0;font-size:1.1rem;">Customer Selected a Time</h2></div>'
        + '<div style="padding:20px;">'
        + '<p style="margin:0 0 14px;color:#444;">' + esc(name) + ' tapped an alternative time from your scheduling email.</p>'
        + '<p style="font-weight:700;font-size:1.05rem;color:#0a1f3d;margin:0 0 18px;">' + esc(when) + '</p>'
        + '<div style="text-align:center;">'
        + '<a href="' + adminUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:12px 28px;border-radius:8px;">Review in Admin</a>'
        + '</div></div></div>';
      await transporter().sendMail({
        from:    '"BK Admin" <greetings@brakeknights.com>',
        to:      'greetings@brakeknights.com',
        subject: name + ' selected a time: ' + when,
        html:    adminHtml
      });
    } catch (_) {}
  }

  return res.send(shell('Time Confirmed',
    '<div class="card" style="text-align:center;">'
    + '<div class="check">&#10003;</div>'
    + '<h1>Got it, ' + esc(quote.first_name) + '!</h1>'
    + '<p style="margin-bottom:6px;">You selected: <strong>' + esc(when) + '</strong></p>'
    + '<p>We\'ll review and send a confirmation once the appointment is locked in. You\'ll hear from us shortly.</p>'
    + '<p class="muted" style="margin-top:16px;">Questions? Call or text <a href="tel:+17039774475" style="color:#0a1f3d;font-weight:700;">703-977-4475</a>.</p>'
    + '</div>'));
});

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

// Availability for the customer time picker. Token-protected; returns only
// blocked time labels for the requested date, never any booking details.
router.get('/:id/:token/availability', function(req, res) {
  var q = loadQuote(req.params.id, req.params.token);
  if (!q) return res.status(404).json({ blocked: [] });
  var date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.json({ blocked: [] });
  res.json({ blocked: blockedSlotsForDate(date, q.service, q.lead_id) });
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

  // Customer cancelled their appointment via the self-service button.
  if (q.status === 'cancelled') {
    return res.send(shell('Appointment Cancelled', cancelledConfirmation(q)));
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
    + '<form method="POST" action="/quote/' + q.id + '/' + q.accept_token + '/accept" id="bkAcceptForm" novalidate>'
    + '<input type="hidden" name="prefDate" id="bkPrefDate">'
    + '<input type="hidden" name="prefTime" id="bkPrefTime">'

    // Date picker
    + '<div class="form-group">'
    + '<label>Preferred date</label>'
    + '<div id="bkDateVal" class="bk-date-val placeholder">Select a date below</div>'
    + '<div class="bk-cal-wrap"><div id="bkCalBox"></div></div>'
    + '<div id="bkDateErr" class="bk-pick-err">Please select a date.</div>'
    + '</div>'

    // Time picker
    + '<div class="form-group" style="margin-top:18px;">'
    + '<label>Preferred time</label>'
    + '<div id="bkTimeVal" class="bk-date-val placeholder">Select a time</div>'
    + '<div class="bk-time-grid" id="bkTimeGrid"></div>'
    + '<div id="bkTimeErr" class="bk-pick-err">Please select a time.</div>'
    + '</div>'

    + '<div class="form-group" style="margin-top:18px;"><label>Service address</label>'
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
    +   'var MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];'
    +   'var WDAYS=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];'
    +   'var TIMES=["Anytime","9:00 AM","9:30 AM","10:00 AM","10:30 AM","11:00 AM","11:30 AM","12:00 PM","12:30 PM","1:00 PM","1:30 PM","2:00 PM","2:30 PM","3:00 PM","3:30 PM","4:00 PM","4:30 PM","5:00 PM","5:30 PM","6:00 PM"];'
    +   'var SAT_CUTOFF_MINS=15*60;'
    +   'var BLOCKED=[];'
    +   'var AVAIL_URL="/quote/' + q.id + '/' + q.accept_token + '/availability";'

    +   'var today=new Date();today.setHours(0,0,0,0);'
    +   'var calY=today.getFullYear(),calM=today.getMonth();'
    +   'var selDate="",selTime="";'

    +   'function isoToDate(iso){var p=iso.split("-");return new Date(+p[0],+p[1]-1,+p[2]);}'
    +   'function timeMins(t){var m=t.match(/(\\d+):(\\d+)\\s*(AM|PM)/i);if(!m)return -1;'
    +     'var h=+m[1],mn=+m[2],ap=m[3].toUpperCase();'
    +     'var h24=(ap==="PM"&&h!==12)?h+12:(ap==="AM"&&h===12)?0:h;return h24*60+mn;}'

    +   'function renderCal(){'
    +     'var firstDay=new Date(calY,calM,1);'
    +     'var lastDay=new Date(calY,calM+1,0);'
    +     'var prevY=calM===0?calY-1:calY,prevM=calM===0?11:calM-1;'
    +     'var nextY=calM===11?calY+1:calY,nextM=calM===11?0:calM+1;'
    +     'var prevDisabled=(prevY<today.getFullYear()||(prevY===today.getFullYear()&&prevM<today.getMonth()));'
    +     'var html=\'<div class="bk-cal-hdr">\''
    +       '+\'<button type="button" class="bk-cal-nav" onclick="bkPrevM()"\'+( prevDisabled?\' disabled\':\'\')+ \'>&#8592;</button>\''
    +       '+\'<span>\'+MONTHS[calM]+\' \'+calY+\'</span>\''
    +       '+\'<button type="button" class="bk-cal-nav" onclick="bkNextM()">&#8594;</button>\''
    +       '+\'</div><div class="bk-cal-grid">\';'
    +     '["Su","Mo","Tu","We","Th","Fr","Sa"].forEach(function(d,i){'
    +       'html+=\'<div class="bk-dh\'+(i===0?\' sun\':\'\')+\'">\'+ d +\'</div>\';'
    +     '});'
    +     'for(var pad=0;pad<firstDay.getDay();pad++)html+=\'<div></div>\';'
    +     'for(var d=1;d<=lastDay.getDate();d++){'
    +       'var dt=new Date(calY,calM,d);'
    +       'var iso=calY+"-"+String(calM+1).padStart(2,"0")+"-"+String(d).padStart(2,"0");'
    +       'var isSun=dt.getDay()===0,isPast=dt<today,isSel=iso===selDate,isToday=dt.getTime()===today.getTime();'
    +       'var cls="bk-day";'
    +       'if(!isSun&&!isPast)cls+=" avail";'
    +       'if(isSel)cls+=" sel";'
    +       'if(isToday&&!isPast)cls+=" today";'
    +       'var click=(!isSun&&!isPast)?" onclick=\\"bkPickDate(\'"+iso+"\')\\"":"";'
    +       'html+=\'<div class="\'+cls+\'"\'+click+\'>\'+d+\'</div>\';'
    +     '}'
    +     'html+=\'</div>\';'
    +     'document.getElementById("bkCalBox").innerHTML=html;'
    +   '}'

    +   'function renderTimes(){'
    +     'var isSat=selDate&&isoToDate(selDate).getDay()===6;'
    +     'var html=TIMES.map(function(t){'
    +       'var isOff=(isSat&&t!=="Anytime"&&timeMins(t)>SAT_CUTOFF_MINS)||(t!=="Anytime"&&BLOCKED.indexOf(t)>=0);'
    +       'var isSel=t===selTime;'
    +       'var cls="bk-tb"+(isSel?" sel":"")+(isOff?" off":"");'
    +       'var click=isOff?"":" onclick=\\"bkPickTime(\'"+t+"\')\\"";'
    +       'return \'<button type="button" class="\'+cls+\'"\'+click+\'>\'+t+\'</button>\';'
    +     '}).join("");'
    +     'document.getElementById("bkTimeGrid").innerHTML=html;'
    +   '}'

    +   'function bkPickDate(iso){'
    +     'selDate=iso;'
    +     'document.getElementById("bkPrefDate").value=iso;'
    +     'var dt=isoToDate(iso);'
    +     'document.getElementById("bkDateVal").textContent=WDAYS[dt.getDay()]+", "+MONTHS[dt.getMonth()]+" "+dt.getDate()+", "+dt.getFullYear();'
    +     'document.getElementById("bkDateVal").classList.remove("placeholder");'
    +     'document.getElementById("bkDateErr").style.display="none";'
    +     'if(selTime&&dt.getDay()===6&&timeMins(selTime)>SAT_CUTOFF_MINS){'
    +       'selTime="";document.getElementById("bkPrefTime").value="";'
    +       'document.getElementById("bkTimeVal").textContent="Select a time";'
    +       'document.getElementById("bkTimeVal").classList.add("placeholder");'
    +     '}'
    +     'BLOCKED=[];'
    +     'renderCal();renderTimes();'
    // Pull real availability for the picked day and grey out taken slots.
    +     'fetch(AVAIL_URL+"?date="+iso).then(function(r){return r.json();}).then(function(d){'
    +       'if(selDate!==iso)return;'
    +       'BLOCKED=d.blocked||[];'
    +       'if(selTime&&BLOCKED.indexOf(selTime)>=0){'
    +         'selTime="";document.getElementById("bkPrefTime").value="";'
    +         'document.getElementById("bkTimeVal").textContent="Select a time";'
    +         'document.getElementById("bkTimeVal").classList.add("placeholder");'
    +       '}'
    +       'renderTimes();'
    +     '}).catch(function(){});'
    +   '}'

    +   'function bkPickTime(t){'
    +     'selTime=t;'
    +     'document.getElementById("bkPrefTime").value=t;'
    +     'document.getElementById("bkTimeVal").textContent=t;'
    +     'document.getElementById("bkTimeVal").classList.remove("placeholder");'
    +     'document.getElementById("bkTimeErr").style.display="none";'
    +     'renderTimes();'
    +   '}'

    +   'window.bkPickDate=bkPickDate;window.bkPickTime=bkPickTime;'
    +   'window.bkPrevM=function(){calM--;if(calM<0){calM=11;calY--;}renderCal();};'
    +   'window.bkNextM=function(){calM++;if(calM>11){calM=0;calY++;}renderCal();};'

    +   'document.getElementById("bkAcceptForm").addEventListener("submit",function(e){'
    +     'var ok=true;'
    +     'if(!selDate){document.getElementById("bkDateErr").style.display="block";ok=false;}'
    +     'if(!selTime){document.getElementById("bkTimeErr").style.display="block";ok=false;}'
    +     'if(!ok)e.preventDefault();'
    +   '});'

    +   'renderCal();renderTimes();'
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
  sendStagePush({ id: q.lead_id, first_name: q.first_name, last_name: q.last_name, service: q.service }, 'quote_accepted');

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

// ─── Customer self-service: reschedule ────────────────────────────────────────
router.post('/:id/:token/reschedule', express.urlencoded({ extended: false }), async function(req, res) {
  var q = loadQuote(req.params.id, req.params.token);
  if (!q) return res.status(404).send(shell('Quote Not Found', '<div class="card"><h1>Quote not found</h1></div>'));

  var prefDate = (req.body.prefDate || '').trim();
  var prefTime = (req.body.prefTime || '').trim();
  var note     = (req.body.rescheduleNote || '').trim();
  if (!prefDate || !prefTime) {
    return res.send(shell('Quote Accepted', acceptedConfirmation(q)));
  }

  // Update the requested time and send it back to the owner's review queue.
  var schedNote = note ? ('Reschedule request: ' + note) : 'Customer requested a new time';
  db.prepare(
    "UPDATE quotes SET pref_date=?, pref_time=?, scheduling_notes=?, status='accepted' WHERE id=?"
  ).run(prefDate, prefTime, schedNote, q.id);
  db.prepare("UPDATE leads SET status='quote_accepted', status_updated_at=datetime('now') WHERE id=?").run(q.lead_id);
  db.prepare("INSERT INTO lead_history (lead_id, event, detail) VALUES (?, ?, ?)").run(
    q.lead_id, 'Customer requested reschedule', formatPrefDate(prefDate) + (prefTime ? ' at ' + prefTime : '') + (note ? ' — ' + note : '')
  );
  sendStagePush({ id: q.lead_id, first_name: q.first_name, last_name: q.last_name, service: q.service }, 'quote_accepted');

  if (process.env.SMTP_PASS) {
    try {
      var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
      var fresh = loadQuote(req.params.id, req.params.token);
      await transporter().sendMail({
        from:    '"Brake Knights" <greetings@brakeknights.com>',
        to:      'greetings@brakeknights.com',
        replyTo: q.lead_email || 'greetings@brakeknights.com',
        subject: 'Reschedule request: ' + q.first_name + ' ' + q.last_name,
        html:    ownerAcceptedEmail(fresh, baseUrl)
      });
    } catch (err) { console.error('Reschedule email error:', err.message); }
  }

  res.send(shell('New Time Requested',
    '<div class="card" style="text-align:center;">'
    + '<div class="check">&#10003;</div>'
    + '<h1>New time requested</h1>'
    + '<p>Thanks, ' + esc(q.first_name) + '. We&rsquo;ve received your new preferred time: <strong>' + esc(formatPrefDate(prefDate)) + (prefTime ? ' at ' + esc(prefTime) : '') + '</strong>. We&rsquo;ll review it and confirm shortly.</p>'
    + '<p class="muted" style="margin-top:14px;">Questions? Call or text <a href="tel:+17039774475" style="color:#0a1f3d;font-weight:700;">703-977-4475</a>.</p>'
    + '</div>'));
});

// ─── Customer self-service: cancel ────────────────────────────────────────────
router.post('/:id/:token/cancel', express.urlencoded({ extended: false }), async function(req, res) {
  var q = loadQuote(req.params.id, req.params.token);
  if (!q) return res.status(404).send(shell('Quote Not Found', '<div class="card"><h1>Quote not found</h1></div>'));

  var reason = (req.body.cancelReason || '').trim();
  // Mark the quote cancelled and move the lead to Follow Up so the owner sees it
  // needs attention/rescheduling (same stage an owner-side cancellation lands in).
  db.prepare("UPDATE quotes SET status='cancelled' WHERE id=?").run(q.id);
  db.prepare("UPDATE leads SET status='follow_up', status_updated_at=datetime('now') WHERE id=?").run(q.lead_id);
  db.prepare("INSERT INTO lead_history (lead_id, event, detail) VALUES (?, ?, ?)").run(
    q.lead_id, 'Customer cancelled appointment', reason || null
  );
  sendStagePush({ id: q.lead_id, first_name: q.first_name, last_name: q.last_name, service: q.service }, 'follow_up');

  if (process.env.SMTP_PASS) {
    try {
      var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
      var adminUrl = baseUrl + '/admin/quote/' + q.lead_id;
      var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">'
        + '<div style="background:#c0392b;padding:16px 20px;"><h2 style="color:#fff;margin:0;font-size:1.15rem;">Appointment Cancelled by Customer</h2></div>'
        + '<div style="padding:20px;">'
        + '<p style="margin:0 0 12px;color:#444;"><strong>' + esc(q.first_name + ' ' + q.last_name) + '</strong> cancelled their appointment.</p>'
        + '<table style="width:100%;border-collapse:collapse;font-size:0.92rem;color:#444;">'
        + '<tr><td style="padding:4px 0;color:#888;width:110px;">Service</td><td style="padding:4px 0;">' + esc(q.service || '—') + '</td></tr>'
        + '<tr><td style="padding:4px 0;color:#888;">Was set for</td><td style="padding:4px 0;">' + esc(formatPrefDate(q.pref_date)) + (q.pref_time ? ' at ' + esc(q.pref_time) : '') + '</td></tr>'
        + (reason ? '<tr><td style="padding:4px 0;color:#888;vertical-align:top;">Reason</td><td style="padding:4px 0;">' + esc(reason) + '</td></tr>' : '')
        + '</table>'
        + '<p style="margin:14px 0 0;color:#666;font-size:0.9rem;">The lead is back in your pipeline as an open quote.</p>'
        + '<div style="margin-top:16px;text-align:center;"><a href="' + adminUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.92rem;text-decoration:none;padding:11px 26px;border-radius:8px;">Open in Admin &rarr;</a></div>'
        + '</div></div>';
      await transporter().sendMail({
        from:    '"Brake Knights" <greetings@brakeknights.com>',
        to:      'greetings@brakeknights.com',
        replyTo: q.lead_email || 'greetings@brakeknights.com',
        subject: 'Appointment CANCELLED: ' + q.first_name + ' ' + q.last_name,
        html:    html
      });
    } catch (err) { console.error('Cancel email error:', err.message); }
  }

  res.send(shell('Appointment Cancelled', cancelledConfirmation(q)));
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
    + manageAppointmentCard(q)
    + '<div class="callbar"><span class="muted">Prefer to talk? Call or text </span><a href="tel:+17039774475">703-977-4475</a></div>';
}

// Self-service reschedule / cancel controls shown on the accepted-quote page.
// Token-protected (the customer already holds the accept token), no login needed.
function manageAppointmentCard(q) {
  var base = '/quote/' + q.id + '/' + q.accept_token;
  return '<div class="card">'
    + '<h2>Need to change your appointment?</h2>'
    + '<p class="muted" style="margin:-4px 0 14px;">Request a different time or cancel, no call needed. We&rsquo;ll get your update right away.</p>'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap;">'
    + '<button type="button" class="btn btn-blue" style="flex:1;min-width:150px;" onclick="bkShowResched()">Request a New Time</button>'
    + '<button type="button" class="btn" style="flex:1;min-width:150px;background:#fff;border:1.5px solid #e0c0c0;color:#c0392b;" onclick="bkShowCancel()">Cancel Appointment</button>'
    + '</div>'

    // Reschedule form (hidden until requested)
    + '<form method="POST" action="' + base + '/reschedule" id="bkReschedForm" style="display:none;margin-top:18px;border-top:1px solid #eef0f4;padding-top:16px;">'
    + '<div class="form-group"><label>New preferred date</label>'
    + '<input type="date" name="prefDate" id="bkReschedDate" required></div>'
    + '<div class="form-group"><label>New preferred time</label>'
    + '<select name="prefTime" id="bkReschedTime" required>' + buildTimeOptions() + '</select></div>'
    + '<div class="form-group"><label>Anything we should know? <span style="color:#aab;font-weight:400;">(optional)</span></label>'
    + '<textarea name="rescheduleNote" placeholder="Reason for the change, second-choice time, etc."></textarea></div>'
    + '<button type="submit" class="btn btn-blue">Send New Time Request</button>'
    + '</form>'

    // Cancel confirmation (hidden until requested)
    + '<form method="POST" action="' + base + '/cancel" id="bkCancelForm" style="display:none;margin-top:18px;border-top:1px solid #eef0f4;padding-top:16px;">'
    + '<p style="color:#0a1f3d;font-weight:600;margin-bottom:8px;">Cancel this appointment?</p>'
    + '<p class="muted" style="margin-bottom:12px;">Your quoted price stays valid. You can rebook any time by replying to us or calling.</p>'
    + '<div class="form-group"><label>Reason <span style="color:#aab;font-weight:400;">(optional)</span></label>'
    + '<textarea name="cancelReason" placeholder="Let us know why, if you like."></textarea></div>'
    + '<button type="submit" class="btn" style="background:#c0392b;color:#fff;">Yes, Cancel My Appointment</button>'
    + '</form>'

    + '<script>'
    + 'function bkShowResched(){var f=document.getElementById("bkReschedForm");var c=document.getElementById("bkCancelForm");c.style.display="none";f.style.display=f.style.display==="none"?"block":"none";var d=document.getElementById("bkReschedDate");if(d){var t=new Date();t.setDate(t.getDate()+1);d.min=t.toISOString().slice(0,10);}}'
    + 'function bkShowCancel(){var f=document.getElementById("bkReschedForm");var c=document.getElementById("bkCancelForm");f.style.display="none";c.style.display=c.style.display==="none"?"block":"none";}'
    // Grey out taken slots when a reschedule date is picked (same availability
    // rules as the accept page).
    + '(function(){var d=document.getElementById("bkReschedDate"),s=document.getElementById("bkReschedTime");if(!d||!s)return;'
    + 'd.addEventListener("change",function(){var iso=d.value;if(!iso)return;'
    + 'fetch("' + base + '/availability?date="+iso).then(function(r){return r.json();}).then(function(j){'
    + 'var bl=j.blocked||[];'
    + 'for(var i=0;i<s.options.length;i++){var o=s.options[i];o.disabled=o.value!==""&&o.value!=="Anytime"&&bl.indexOf(o.value)>=0;}'
    + 'if(s.value&&s.value!=="Anytime"&&bl.indexOf(s.value)>=0)s.value="";'
    + '}).catch(function(){});});})();'
    // Email Reschedule/Cancel buttons land here with ?action= to auto-open the form.
    + '(function(){var a=new URLSearchParams(location.search).get("action");'
    + 'if(a==="reschedule")bkShowResched();else if(a==="cancel")bkShowCancel();'
    + 'if(a){var el=document.getElementById(a==="cancel"?"bkCancelForm":"bkReschedForm");if(el)el.scrollIntoView({behavior:"smooth",block:"center"});}})();'
    + '</script>'
    + '</div>';
}

function cancelledConfirmation(q) {
  return '<div class="card" style="text-align:center;">'
    + '<div class="check" style="background:#fdecea;color:#c0392b;">&#10005;</div>'
    + '<h1>Appointment cancelled</h1>'
    + '<p>Your appointment has been cancelled, ' + esc(q.first_name) + '. Your quoted price stays valid, so you can rebook any time.</p>'
    + '<p class="muted" style="margin-top:14px;">Want to rebook or have questions? Call or text <a href="tel:+17039774475" style="color:#0a1f3d;font-weight:700;">703-977-4475</a>.</p>'
    + '</div>';
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
