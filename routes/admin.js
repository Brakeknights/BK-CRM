const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const db = require('../db');
const PRICING = require('../pricing');
const { client: squareClient } = require('../square');
const { toEasternRfc3339 } = require('../datetime');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'brakeknights';

// Location + team member are auto-discovered from whichever Square environment the
// token points at (sandbox now, production after upgrade), so no code change is needed
// to switch. Optional env overrides win; the known production IDs are the last-resort
// fallback if discovery returns nothing.
const FALLBACK_LOCATION_ID = 'LDDQ81CM33HJH';
const FALLBACK_TEAM_MEMBER = 'TM2pRrtr9Kh27HGq';
var _squareLocationId = null;
var _squareTeamMemberId = null;

async function getSquareLocationId() {
  if (_squareLocationId) return _squareLocationId;
  if (process.env.SQUARE_LOCATION_ID) { _squareLocationId = process.env.SQUARE_LOCATION_ID; return _squareLocationId; }
  try {
    var r = await squareClient.locations.list();
    var locs = r.locations || [];
    var pick = locs.find(function(l) { return l.status === 'ACTIVE'; }) || locs[0];
    if (pick && pick.id) { _squareLocationId = pick.id; return _squareLocationId; }
  } catch (_) {}
  _squareLocationId = FALLBACK_LOCATION_ID;
  return _squareLocationId;
}

async function getSquareTeamMemberId() {
  if (_squareTeamMemberId) return _squareTeamMemberId;
  if (process.env.SQUARE_TEAM_MEMBER) { _squareTeamMemberId = process.env.SQUARE_TEAM_MEMBER; return _squareTeamMemberId; }
  try {
    var r = await squareClient.teamMembers.search({ query: { filter: { statuses: ['ACTIVE'] } } });
    var members = r.teamMembers || [];
    if (members.length && members[0].id) { _squareTeamMemberId = members[0].id; return _squareTeamMemberId; }
  } catch (_) {}
  _squareTeamMemberId = FALLBACK_TEAM_MEMBER;
  return _squareTeamMemberId;
}

// Cache for the Square catalog service variation (created on first Approve)
var _squareSvcVar = null;

async function getSquareSvcVar() {
  if (_squareSvcVar) return _squareSvcVar;
  try {
    var r = await squareClient.catalog.list({ types: 'ITEM' });
    var existing = (r.objects || []).find(function(o) {
      return o.itemData && o.itemData.name === 'Mobile Brake Service' &&
             o.itemData.productType === 'APPOINTMENTS_SERVICE';
    });
    if (existing && existing.itemData.variations && existing.itemData.variations.length > 0) {
      var v = existing.itemData.variations[0];
      _squareSvcVar = { id: v.id, version: v.version };
      return _squareSvcVar;
    }
  } catch (_) {}
  var result = await squareClient.catalog.object.upsert({
    idempotencyKey: 'bk-mobile-brake-service-v1',
    object: {
      type: 'ITEM',
      id: '#MobileBrakeService',
      itemData: {
        name: 'Mobile Brake Service',
        productType: 'APPOINTMENTS_SERVICE',
        variations: [{
          type: 'ITEM_VARIATION',
          id: '#MobileBrakeServiceVar',
          itemVariationData: {
            name: 'Standard',
            pricingType: 'VARIABLE_PRICING',
            serviceDuration: BigInt(5400000)
          }
        }]
      }
    }
  });
  var vr = result.catalogObject && result.catalogObject.itemData &&
           result.catalogObject.itemData.variations &&
           result.catalogObject.itemData.variations[0];
  _squareSvcVar = { id: vr ? vr.id : null, version: vr ? vr.version : null };
  return _squareSvcVar;
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
// Use for on-screen/email display only — never for input or hidden field values
// (those must stay comma-free so parseFloat works).
function money(n) {
  return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Natural list join for the service line, e.g. "A, B, and C" (or "A, and B").
function joinServices(s) {
  var a = String(s || '').split(', ').map(function(x) { return x.trim(); }).filter(Boolean);
  if (a.length <= 1) return a[0] || '';
  return a.slice(0, -1).join(', ') + ', and ' + a[a.length - 1];
}

// Total on-site minutes across all selected services.
function totalServiceMinutes(s) {
  return String(s || '').split(', ').reduce(function(sum, name) {
    var sv = PRICING.services[name.trim()];
    return sum + ((sv && sv.minutes) || 0);
  }, 0);
}

// Friendly duration, e.g. 90 -> "1 hr 30 min", 60 -> "1 hr", 45 -> "45 min".
function formatDuration(mins) {
  if (!mins) return '';
  var h = Math.floor(mins / 60), m = mins % 60;
  if (h && m) return h + ' hr ' + m + ' min';
  if (h) return h + ' hr';
  return m + ' min';
}

// JS UTC stamp for calendar links, e.g. 20260608T160000Z.
function icsUtcStamp(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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
    completed:      'background:#fff1de;color:#a85b00;',
    receipt:        'background:#e6f9ee;color:#0a6b2e;',
  };
  const labels = { new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', quote_accepted: 'Quote Accepted', booked: 'Booked', completed: 'Completed', receipt: 'Receipt Sent' };
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

// Today's date in Eastern Time as YYYY-MM-DD (en-CA yields ISO order).
function easternToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Computes a follow-up due date (YYYY-MM-DD) from a base date and a timeframe key.
// '1m'/'3m'/'6m'/'1y' add calendar months; 'custom' returns the provided date.
function followupDueDate(baseDate, timeframe, customDate) {
  if (timeframe === 'custom') return (customDate || '').trim() || null;
  var months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12 }[timeframe];
  if (!months) return null;
  var p = String(baseDate || easternToday()).split('-').map(Number);
  if (p.length !== 3) return null;
  var d = new Date(p[0], p[1] - 1, p[2]);
  d.setMonth(d.getMonth() + months);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Formats a stored ISO date (YYYY-MM-DD) as "Friday, June 5, 2026".
function fmtPrefDate(val) {
  if (!val) return '—';
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
  if (!m) return val;
  var WD = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var MO = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var dt = new Date(+m[1], +m[2] - 1, +m[3]);
  return WD[dt.getDay()] + ', ' + MO[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
}

// Renders the scheduling panel for a lead with an accepted quote: a confirmed
// banner once booked, or the requested time + Approve/Deny actions while pending.
// Approve/Deny hit the same /approve-schedule and /deny-schedule routes the email
// buttons use. `compact` trims padding for the leads-list cards. Returns '' when
// there's nothing to show.
function schedulingPanel(lead, quote, compact) {
  if (!quote || !quote.accepted_at || !quote.pref_date) return '';
  var pad = compact ? '12px' : '16px';
  if (lead.status === 'booked') {
    return '<div style="background:#eaf6ee;border:1px solid #bfe3cb;border-radius:8px;padding:' + pad + ';margin-bottom:12px;">'
      + '<div style="font-weight:700;color:#1a7a3a;font-size:0.9rem;">&#10003; Appointment confirmed</div>'
      + '<div style="color:#444;font-size:0.85rem;margin-top:3px;">' + esc(fmtPrefDate(quote.pref_date)) + ' at ' + esc(quote.pref_time || '—') + '</div>'
      + '</div>';
  }
  if (lead.status !== 'quote_accepted') return '';
  // Alternatives were sent and the customer hasn't responded yet: show waiting state.
  if (quote.alt_times_sent) {
    return '<div style="background:#fff8e1;border:1px solid #f0d080;border-left:4px solid #e07000;border-radius:8px;padding:' + pad + ';margin-bottom:12px;">'
      + '<div style="font-weight:700;color:#7a5a00;font-size:0.9rem;margin-bottom:4px;">Alternative Times Sent</div>'
      + '<div style="font-size:0.85rem;color:#7a5a00;line-height:1.5;">Waiting for the customer to select a time from the options you sent. The Approve button will reappear once they choose.</div>'
      + '</div>';
  }
  return '<div style="background:#e3f0ff;border:1px solid #b9d4f5;border-left:4px solid #4169e1;border-radius:8px;padding:' + pad + ';margin-bottom:12px;">'
    + '<div style="font-weight:700;color:#0a1f3d;font-size:0.9rem;margin-bottom:8px;">Requested Appointment</div>'
    + '<div style="font-size:0.88rem;color:#1a2a3a;">' + esc(fmtPrefDate(quote.pref_date)) + ' at <strong>' + esc(quote.pref_time || 'time TBD') + '</strong></div>'
    + (quote.pref_location ? '<div style="font-size:0.83rem;color:#666;margin-top:2px;">' + esc(quote.pref_location) + '</div>' : '')
    + (quote.scheduling_notes ? '<div style="font-size:0.82rem;color:#666;font-style:italic;margin-top:4px;">' + esc(quote.scheduling_notes) + '</div>' : '')
    + '<div style="display:flex;gap:8px;margin-top:12px;">'
    + '<a href="/admin/quote/' + lead.id + '/approve-schedule" class="btn btn-sm" style="flex:1;text-align:center;background:#1a7a3a;color:#fff;border:none;">&#10003; Approve Time</a>'
    + '<a href="/admin/quote/' + lead.id + '/deny-schedule" class="btn btn-sm" style="flex:1;text-align:center;background:#c0392b;color:#fff;border:none;">&#10005; Not Available</a>'
    + '</div></div>';
}

function stageTracker(status) {
  var STAGES = [
    { key: 'new',            label: 'New' },
    { key: 'quoted',         label: 'Quoted' },
    { key: 'quote_accepted', label: 'Accepted' },
    { key: 'booked',         label: 'Booked' },
    { key: 'completed',      label: 'Complete' },
    { key: 'receipt',        label: 'Receipt' }
  ];
  var IDX = { new: 0, quoted: 1, follow_up: 1, quote_accepted: 2, booked: 3, completed: 4, receipt: 5 };
  var cur = IDX[status] != null ? IDX[status] : 0;
  var parts = [];
  STAGES.forEach(function(s, i) {
    var past = i < cur, active = i === cur;
    var pill;
    if (past) {
      pill = '<span style="display:inline-flex;align-items:center;padding:4px 11px;border-radius:20px;font-size:0.75rem;font-weight:600;background:#1a7a3a;color:#fff;white-space:nowrap;">&#10003; ' + s.label + '</span>';
    } else if (active) {
      pill = '<span style="display:inline-flex;align-items:center;padding:4px 11px;border-radius:20px;font-size:0.75rem;font-weight:700;background:#4169e1;color:#fff;white-space:nowrap;">' + s.label + '</span>';
    } else {
      pill = '<span style="display:inline-flex;align-items:center;padding:4px 11px;border-radius:20px;font-size:0.75rem;font-weight:600;background:#f0f4f8;color:#aaa;border:1.5px solid #dde3ea;white-space:nowrap;">' + s.label + '</span>';
    }
    parts.push(pill);
    if (i < STAGES.length - 1) parts.push('<span style="color:#ccc;font-size:0.9rem;flex-shrink:0;">›</span>');
  });
  return '<div style="display:flex;align-items:center;gap:3px;overflow-x:auto;padding-bottom:12px;margin-bottom:4px;-webkit-overflow-scrolling:touch;scrollbar-width:none;">' + parts.join('') + '</div>';
}

function nextStageHint(lead) {
  var hints = {
    new:            { text: 'Next: build and send a quote using the form on this page.', bg: '#e3f0ff', border: '#b9d4f5', color: '#1a2a3a' },
    quoted:         { text: 'Waiting for the customer to accept the quote.', bg: '#dde7fb', border: '#b9c9f5', color: '#3a4fb8' },
    quote_accepted: { text: 'Review the appointment request above and Approve or Deny.', bg: '#e0f4f8', border: '#b9dde8', color: '#0e7490' },
    booked:         { text: 'Job is booked. After the service, click Complete Job &amp; Send Receipt.', bg: '#e6f9ee', border: '#bfe3cb', color: '#1a7a3a' },
    completed:      { text: 'Job done. Send the customer a receipt to wrap up.', bg: '#fff1de', border: '#f5d9b0', color: '#7a4a00' },
    receipt:        { text: 'Receipt sent. Follow-ups are scheduled if applicable.', bg: '#e6f9ee', border: '#bfe3cb', color: '#0a6b2e' }
  };
  var h = hints[lead.status];
  if (!h) return '';
  return '<div style="font-size:0.82rem;color:' + h.color + ';background:' + h.bg + ';border:1px solid ' + h.border + ';border-radius:8px;padding:8px 12px;margin-bottom:12px;line-height:1.5;">' + h.text + '</div>';
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
.topbar-nav{display:flex;align-items:center;gap:4px}
.topbar-link{color:#8aadcf;font-size:0.84rem;font-weight:500;text-decoration:none;display:inline-flex;align-items:center;padding:5px 10px;border-radius:6px;transition:background .12s,color .12s}
.topbar-link:hover{color:#fff;background:rgba(255,255,255,.08)}
.topbar-link.active{color:#fff;background:rgba(107,143,245,.18);font-weight:700}
.topbar-logout{color:#8aadcf;font-size:0.82rem;text-decoration:none;padding:5px 10px;border-radius:6px;transition:color .12s}
.topbar-logout:hover{color:#fff}
.nav-badge{background:#e07000;color:#fff;font-size:0.7rem;font-weight:700;padding:1px 7px;border-radius:10px;margin-left:5px;line-height:1.5}
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
  var authed = req.session && req.session.adminAuthed;
  var nav = '';
  if (authed) {
    // Count of follow-ups that are due now (overdue or due today) so the owner sees
    // at a glance when something needs attention.
    var dueCount = 0;
    try {
      dueCount = db.prepare("SELECT COUNT(*) AS n FROM followups WHERE sent = 0 AND date(due_date) <= date('now')").get().n;
    } catch (_) {}
    var badge = dueCount > 0
      ? ' <span class="nav-badge">' + dueCount + '</span>'
      : '';
    var p = req.path || '/';
    var activeSection = p === '/quick' ? 'quick' : p.startsWith('/followups') ? 'followups' : 'leads';
    nav = '<div class="topbar-nav">'
      + '<a href="/admin" class="topbar-link' + (activeSection === 'leads'     ? ' active' : '') + '">Leads</a>'
      + '<a href="/admin/quick" class="topbar-link' + (activeSection === 'quick'     ? ' active' : '') + '">Quick Quote</a>'
      + '<a href="/admin/followups" class="topbar-link' + (activeSection === 'followups' ? ' active' : '') + '">Follow-ups' + badge + '</a>'
      + '<a href="/admin/logout" class="topbar-logout">Log out</a>'
      + '</div>';
  }
  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<link rel="icon" type="image/png" href="/images/favicon.png">'
    + '<title>BK Admin' + (title && title !== 'Leads' ? ' — ' + esc(title) : '') + '</title>'
    + '<style>' + CSS + '</style>'
    + '</head><body>'
    + '<div class="topbar">'
    + '<a href="/admin" class="topbar-brand"><img src="/images/favicon.png" alt=""> BK Admin</a>'
    + nav
    + '</div>'
    + '<div class="wrap">' + body + '</div>'
    + '<script>function copyEmail(btn,addr){var orig=btn.innerHTML;navigator.clipboard.writeText(addr).then(function(){btn.innerHTML="&#10003; Copied!";btn.style.color="#1a7a3a";setTimeout(function(){btn.innerHTML=orig;btn.style.color="";},1600);}).catch(function(){window.location.href="mailto:"+addr;});}</script>'
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
  var validStatuses = ['new', 'quoted', 'follow_up', 'quote_accepted', 'booked', 'completed', 'receipt'];
  var status = req.body.status;
  if (!validStatuses.includes(status)) return res.status(400).send('Invalid status');
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  if (lead.status !== status) {
    var statusLabels = { new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', quote_accepted: 'Quote Accepted', booked: 'Booked', completed: 'Completed', receipt: 'Receipt Sent' };
    db.prepare("UPDATE leads SET status = ?, status_updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
    logHistory(lead.id, 'Status changed to ' + (statusLabels[status] || status));
    notifyStageChange(req, lead, status).catch(function(err) { console.error('Stage notification error:', err.message); });
  }
  var back = req.body.back || '/admin';
  res.redirect(back);
});

// ─── Archive / restore (soft delete) ──────────────────────────────────────────
// Soft archive keeps the lead, its quotes, and history for CRM lookups; archived
// leads are just hidden from the working lists.
router.post('/lead/:id/archive', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  db.prepare("UPDATE leads SET archived = 1, archived_at = datetime('now') WHERE id = ?").run(lead.id);
  logHistory(lead.id, 'Lead archived');
  res.redirect(req.body.back || '/admin');
});

router.post('/lead/:id/restore', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  db.prepare("UPDATE leads SET archived = 0, archived_at = NULL WHERE id = ?").run(lead.id);
  logHistory(lead.id, 'Lead restored from archive');
  res.redirect(req.body.back || '/admin?status=archived');
});

router.post('/lead/:id/delete', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  db.prepare('DELETE FROM followups WHERE lead_id = ?').run(lead.id);
  db.prepare('DELETE FROM receipts WHERE lead_id = ?').run(lead.id);
  db.prepare('DELETE FROM quotes WHERE lead_id = ?').run(lead.id);
  db.prepare('DELETE FROM lead_history WHERE lead_id = ?').run(lead.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(lead.id);
  res.redirect(req.body.back || '/admin');
});

// Lead-level VIN + internal notes (item 5). Saved independently of any quote.
router.post('/lead/:id/notes', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  var vin = (req.body.vin || '').trim() || null;
  var notes = (req.body.internalNotes || '').trim() || null;
  db.prepare('UPDATE leads SET vin = ?, internal_notes = ? WHERE id = ?').run(vin, notes, lead.id);
  if ((lead.vin || '') !== (vin || '') || (lead.internal_notes || '') !== (notes || '')) {
    logHistory(lead.id, 'VIN / internal notes updated');
  }
  res.redirect('/admin/quote/' + lead.id + '?msg=notes_saved');
});
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
    await client.bookings.getBusinessProfile();
    out.bookingsOnboarded = 'ok';
  } catch (e) { out.bookingsOnboarded = 'ERR: ' + e.message; }
  try {
    const r = await client.catalog.list({ types: 'ITEM' });
    out.allCatalogItems = (r.objects || []).map(o => ({
      id: o.id, type: o.type, productType: o.itemData?.productType, name: o.itemData?.name,
      variations: (o.itemData?.variations || []).map(v => ({ id: v.id, name: v.itemVariationData?.name, duration: v.itemVariationData?.serviceDuration }))
    }));
  } catch (e) { out.allCatalogItems = 'ERR: ' + e.message; }
  res.type('json').send(JSON.stringify(out, null, 2));
});

// ─── Alt-time date/time option builders (for deny-schedule form) ─────────────

var ALT_WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
var ALT_MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function buildAltDateOptions() {
  var opts = '<option value="" disabled selected>Select a day...</option>';
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  for (var added = 0, days = 0; added < 35 && days < 60; days++) {
    var day = new Date(d.getTime() + days * 86400000);
    if (day.getDay() === 0) continue;
    var iso = day.getFullYear() + '-'
      + String(day.getMonth() + 1).padStart(2, '0') + '-'
      + String(day.getDate()).padStart(2, '0');
    opts += '<option value="' + iso + '">' + ALT_WEEKDAYS[day.getDay()] + ', ' + ALT_MONTHS[day.getMonth()] + ' ' + day.getDate() + '</option>';
    added++;
  }
  return opts;
}

function buildAltTimeOptions() {
  var opts = '<option value="" disabled selected>Select a time...</option>';
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

// ─── Approve / deny scheduling ────────────────────────────────────────────────

router.get('/quote/:id/approve-schedule', requireAuth, async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id);
  if (!quote) return res.redirect('/admin/quote/' + lead.id + '?msg=no_accepted_quote');

  db.prepare("UPDATE leads SET status = 'booked', status_updated_at = datetime('now') WHERE id = ?").run(lead.id);
  logHistory(lead.id, 'Time approved', (quote.pref_date || '') + (quote.pref_time ? ' at ' + quote.pref_time : '') + (quote.pref_location ? ', ' + quote.pref_location : ''));

  // Square calendar booking
  try {
    var startAt = toEasternRfc3339(quote.pref_date, quote.pref_time);
    if (startAt) {
      var svcVar = await getSquareSvcVar();
      if (svcVar && svcVar.id) {
        var teamMemberId = await getSquareTeamMemberId();
        var locationId = await getSquareLocationId();
        var seg = { serviceVariationId: svcVar.id, teamMemberId: teamMemberId, durationMinutes: 90 };
        if (svcVar.version) seg.serviceVariationVersion = svcVar.version;
        var bkBody = {
          locationId: locationId,
          startAt: startAt,
          appointmentSegments: [seg],
          customerNote: [lead.first_name + ' ' + lead.last_name, quote.service, quote.pref_location].filter(Boolean).join(' — ')
        };
        if (lead.square_customer_id) bkBody.customerId = lead.square_customer_id;
        var bkResult = await squareClient.bookings.create({
          idempotencyKey: 'bk-approve-quote-' + quote.id,
          booking: bkBody
        });
        var bkId = bkResult.booking && bkResult.booking.id;
        logHistory(lead.id, 'Square appointment created', bkId || '');
      }
    }
  } catch (sqErr) {
    console.error('Square booking error:', sqErr.message);
    logHistory(lead.id, 'Square booking failed', sqErr.message);
  }

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
      var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
      var calendarUrl = baseUrl + '/quote/' + quote.id + '/' + quote.accept_token + '/calendar.ics';
      // Direct "Add to Google Calendar" link (opens in the browser — better than the
      // .ics download on desktop, which hands off to whatever app is the OS default).
      var gcalUrl = '';
      var apptStartRfc = toEasternRfc3339(quote.pref_date, quote.pref_time);
      if (apptStartRfc) {
        var apptMins = totalServiceMinutes(quote.service) || 60;
        var gStart = new Date(apptStartRfc);
        var gEnd = new Date(gStart.getTime() + apptMins * 60000);
        gcalUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
          + '&text=' + encodeURIComponent('Brake Knights — ' + (quote.service || 'Brake Service'))
          + '&dates=' + icsUtcStamp(gStart) + '/' + icsUtcStamp(gEnd)
          + '&details=' + encodeURIComponent('Mobile brake service. Total: $' + money(quote.total) + '. Questions? Call or text 703-977-4475.')
          + '&location=' + encodeURIComponent(quote.pref_location || '');
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
        + '<tr><td style="padding:5px 0;color:#888;">Total</td><td style="padding:5px 0;font-weight:700;">$' + money(quote.total) + '</td></tr>'
        + '<tr><td style="padding:5px 0;color:#888;">Date</td><td style="padding:5px 0;">' + esc(fmtDate(quote.pref_date)) + '</td></tr>'
        + '<tr><td style="padding:5px 0;color:#888;">Time</td><td style="padding:5px 0;">' + esc(quote.pref_time || '—') + '</td></tr>'
        + '<tr><td style="padding:5px 0;color:#888;vertical-align:top;">Location</td><td style="padding:5px 0;">' + esc(quote.pref_location || '—') + '</td></tr>'
        + '</table></div>'
        + '<div style="text-align:center;margin:0 0 24px;">'
        + (gcalUrl ? '<a href="' + gcalUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 28px;border-radius:8px;margin:0 4px 8px;">&#128197; Add to Google Calendar</a>' : '')
        + '<a href="' + calendarUrl + '" style="display:inline-block;background:#0a1f3d;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 28px;border-radius:8px;margin:0 4px 8px;">&#127822; Apple / Outlook (.ics)</a>'
        + '<p style="color:#888;font-size:0.8rem;margin:6px 0 0;">Google Calendar opens in your browser. The .ics works with Apple Calendar and Outlook.</p>'
        + '</div>'
        + '<p style="color:#6b5900;background:#fffbea;border:1px solid #e8d87a;border-radius:6px;padding:10px 14px;line-height:1.55;margin:0 0 24px;font-size:0.84rem;"><strong>Inspection note:</strong> If we arrive and determine no brake service is needed, a $60 inspection fee applies. If repairs are needed, the inspection fee is applied toward the cost of the repair — no extra charge.</p>'
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

router.get('/quote/:id/deny-schedule', requireAuth, function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id);
  var reqTime = quote ? fmtPrefDate(quote.pref_date) + (quote.pref_time ? ' at ' + quote.pref_time : '') : 'the requested time';

  var body = '<a href="/admin/quote/' + lead.id + '" class="back-link">&#8592; Back</a>'
    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:4px;">Suggest Alternative Times</div>'
    + '<div style="font-size:0.85rem;color:#888;margin-bottom:14px;">Customer requested: <strong>' + esc(reqTime) + '</strong></div>'
    + '<p style="font-size:0.87rem;color:#555;line-height:1.55;margin-bottom:16px;">Enter up to 3 alternatives below. The customer will be asked to choose whichever works best, or reply if none do.</p>'
    + '<form method="POST" action="/admin/quote/' + lead.id + '/deny-schedule">'
    + [1,2,3].map(function(n) {
        var dateOpts = buildAltDateOptions();
        var timeOpts = buildAltTimeOptions();
        return '<div style="margin-bottom:12px;">'
          + '<div style="font-size:0.8rem;color:#888;font-weight:600;margin-bottom:5px;">Option ' + n + '</div>'
          + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
          + '<select name="altDate' + n + '" style="flex:1;min-width:160px;padding:8px 10px;border:1.5px solid #dde3ea;border-radius:7px;font-size:0.85rem;background:#fff;color:#1a2a3a;">' + dateOpts + '</select>'
          + '<select name="altTime' + n + '" style="flex:1;min-width:130px;padding:8px 10px;border:1.5px solid #dde3ea;border-radius:7px;font-size:0.85rem;background:#fff;color:#1a2a3a;">' + timeOpts + '</select>'
          + '</div></div>';
      }).join('')
    + '<div style="margin-top:16px;display:flex;gap:8px;">'
    + '<button type="submit" class="btn btn-blue" style="flex:1;">Send to Customer</button>'
    + '<a href="/admin/quote/' + lead.id + '" class="btn btn-outline" style="flex:1;text-align:center;">Cancel</a>'
    + '</div></form></div>';

  res.send(page('Suggest Alternatives', body, req));
});

router.post('/quote/:id/deny-schedule', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id);

  logHistory(lead.id, 'Time denied', quote ? ((quote.pref_date || '') + (quote.pref_time ? ' at ' + quote.pref_time : '')) : null);

  var alts = [];
  for (var i = 1; i <= 3; i++) {
    var d = (req.body['altDate' + i] || '').trim();
    var t = (req.body['altTime' + i] || '').trim();
    if (d || t) alts.push({ date: d, time: t, token: crypto.randomBytes(20).toString('hex') });
  }

  // Store alt tokens + dates + times on the quote so the customer's tap can be validated.
  if (quote) {
    var upd = db.prepare(
      'UPDATE quotes SET alt_times_sent=1,'
      + 'alt_token1=?,alt_date1=?,alt_time1=?,'
      + 'alt_token2=?,alt_date2=?,alt_time2=?,'
      + 'alt_token3=?,alt_date3=?,alt_time3=? WHERE id=?'
    );
    upd.run(
      alts[0] ? alts[0].token : null, alts[0] ? alts[0].date : null, alts[0] ? alts[0].time : null,
      alts[1] ? alts[1].token : null, alts[1] ? alts[1].date : null, alts[1] ? alts[1].time : null,
      alts[2] ? alts[2].token : null, alts[2] ? alts[2].date : null, alts[2] ? alts[2].time : null,
      quote.id
    );
  }

  if (process.env.SMTP_PASS && lead.email) {
    try {
      var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
      var altHtml = '';
      if (alts.length) {
        altHtml = '<div style="margin:20px 0;">'
          + '<p style="font-size:0.85rem;color:#888;margin:0 0 10px;">Tap the time that works best for you:</p>'
          + alts.map(function(a, idx) {
              var when = (a.date ? fmtPrefDate(a.date) : '') + (a.time ? ' at ' + a.time : '');
              var link = quote ? (baseUrl + '/quote/alt/' + quote.id + '/' + a.token) : '';
              return '<a href="' + esc(link) + '" style="display:block;padding:14px 18px;background:#4169e1;color:#fff;border-radius:9px;margin-bottom:10px;font-size:0.95rem;font-weight:700;text-align:center;text-decoration:none;">'
                + (idx + 1) + '. ' + esc(when) + '</a>';
            }).join('')
          + '<p style="font-size:0.82rem;color:#888;margin:10px 0 0;">If none of these times work, just reply to this email and we\'ll find one that does.</p>'
          + '</div>';
      }
      var bodyText = alts.length
        ? 'We\'re sorry, the time you requested isn\'t available. Here are a few options that work on our end. Tap the one that works for you and we\'ll lock it in.'
        : 'We\'re sorry, the time you requested isn\'t available. Please reply with your availability and we\'ll work with you to find a time that fits your schedule.';
      var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">'
        + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
        + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;"> Brake Knights</h1>'
        + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service, Northern Virginia</p></div>'
        + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
        + '<h2 style="color:#0a1f3d;margin:0 0 16px;">Greetings ' + esc(lead.first_name) + ',</h2>'
        + '<p style="color:#444;line-height:1.6;margin:0 0 4px;">' + bodyText + '</p>'
        + altHtml
        + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;margin-top:20px;">'
        + '<p style="color:#fff;font-weight:700;margin:0 0 8px;">You can also reach us directly:</p>'
        + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
        + '</div></div>'
        + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div></div>';
      await tx.sendMail({ from: '"Brake Knights" <greetings@brakeknights.com>', to: lead.email, replyTo: 'greetings@brakeknights.com', subject: 'Scheduling update from Brake Knights', html });
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
    // Search spans everything (including archived) so old customers stay findable.
    leads = db.prepare(
      'SELECT * FROM leads WHERE (first_name || " " || last_name LIKE ? OR phone LIKE ? OR email LIKE ? OR vehicle LIKE ? OR service LIKE ?) ORDER BY id DESC'
    ).all(sp, sp, sp, sp, sp);
  } else if (status === 'archived') {
    leads = db.prepare('SELECT * FROM leads WHERE archived = 1 ORDER BY archived_at DESC, id DESC').all();
  } else if (status === 'all') {
    leads = db.prepare('SELECT * FROM leads WHERE archived = 0 ORDER BY id DESC').all();
  } else {
    leads = db.prepare('SELECT * FROM leads WHERE status = ? AND archived = 0 ORDER BY id DESC').all(status);
  }

  var counts = db.prepare('SELECT status, COUNT(*) as n FROM leads WHERE archived = 0 GROUP BY status').all()
    .reduce(function(acc, r) { acc[r.status] = r.n; return acc; }, {});
  var total = db.prepare('SELECT COUNT(*) as n FROM leads WHERE archived = 0').get().n;
  var archivedCount = db.prepare('SELECT COUNT(*) as n FROM leads WHERE archived = 1').get().n;

  var tabs = [
    ['all',            'All',            total],
    ['new',            'New',            counts.new            || 0],
    ['quoted',         'Quoted',         counts.quoted         || 0],
    ['follow_up',      'Follow Up',      counts.follow_up      || 0],
    ['quote_accepted', 'Quote Accepted', counts.quote_accepted || 0],
    ['booked',         'Booked',         counts.booked         || 0],
    ['completed',      'Completed',      counts.completed      || 0],
    ['receipt',        'Receipt Sent',        counts.receipt        || 0],
    ['archived',       'Archived',       archivedCount         || 0],
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
        var sched = (l.status === 'quote_accepted' || l.status === 'booked')
          ? db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(l.id)
          : null;
        var backVal = '/admin?status=' + status + (search ? '&q=' + encodeURIComponent(search) : '');
        return '<div class="card"' + (l.archived ? ' style="opacity:.72;"' : '') + '>'
          + '<div class="row-sb">'
          + '<div class="lead-name">' + esc(l.first_name) + ' ' + esc(l.last_name) + '</div>'
          + statusBadge(l.status)
          + '</div>'
          + '<div class="lead-service">' + esc(l.service || 'Service not specified') + '</div>'
          + (l.vehicle ? '<div class="lead-vehicle">' + esc(l.vehicle) + '</div>' : '')
          + '<div class="lead-meta">' + timeAgo(l.created_at) + (l.preferred_contact ? ' &middot; Prefers ' + esc(l.preferred_contact) : '') + '</div>'
          + (l.message ? '<div class="lead-note">&ldquo;' + esc(l.message) + '&rdquo;</div>' : '')
          + '<div style="margin-top:12px;">' + schedulingPanel(l, sched, true) + '</div>'
          + '<div style="display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap;">'
          + '<a href="tel:' + esc(l.phone) + '" class="btn btn-outline btn-sm" style="width:auto;flex-shrink:0;">&#128222; Call</a>'
          + '<a href="sms:' + esc(l.phone) + '" class="btn btn-outline btn-sm" style="width:auto;flex-shrink:0;">&#128172; Text</a>'
          + (l.email ? '<button type="button" onclick="copyEmail(this,\'' + esc(l.email) + '\')" class="btn btn-outline btn-sm" style="width:auto;flex-shrink:0;">&#9993; Email</button>' : '')
          + '<a href="/admin/quote/' + l.id + '" class="btn btn-navy btn-sm" style="flex:1;text-align:center;min-width:120px;">Open Quote</a>'
          + '</div>'
          + (l.archived ? '' : '<a href="/admin/receipt/' + l.id + '" class="btn btn-blue btn-sm" style="width:100%;margin-top:8px;text-align:center;">&#10003; Complete Job &amp; Send Receipt</a>')
          + (l.archived
              ? '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;justify-content:space-between;">'
                + '<span style="font-size:0.78rem;color:#aaa;">Archived' + (l.archived_at ? ' ' + timeAgo(l.archived_at) : '') + '</span>'
                + '<form method="POST" action="/admin/lead/' + l.id + '/restore" style="margin:0;">'
                + '<input type="hidden" name="back" value="' + backVal + '">'
                + '<button type="submit" class="btn btn-outline btn-sm" style="width:auto;">&#8634; Restore</button>'
                + '</form></div>'
              : '<form method="POST" action="/admin/lead/' + l.id + '/status" style="margin-top:10px;display:flex;align-items:center;gap:8px;">'
                + '<input type="hidden" name="back" value="' + backVal + '">'
                + '<label style="font-size:0.78rem;color:#aaa;font-weight:600;white-space:nowrap;">Status:</label>'
                + '<select name="status" onchange="this.form.submit()" style="flex:1;padding:6px 8px;border:1.5px solid #dde3ea;border-radius:6px;font-size:0.82rem;color:#1a2a3a;background:#fff;">'
                + ['new','quoted','follow_up','quote_accepted','booked','completed','receipt'].map(function(s) {
                    var label = { new:'New', quoted:'Quoted', follow_up:'Follow Up', quote_accepted:'Quote Accepted', booked:'Booked', completed:'Completed', receipt:'Receipt Sent' }[s];
                    return '<option value="' + s + '"' + (l.status === s ? ' selected' : '') + '>' + label + '</option>';
                  }).join('')
                + '</select></form>'
                + '<div style="display:flex;gap:0;margin-top:8px;">'
                + '<form method="POST" action="/admin/lead/' + l.id + '/archive" style="flex:1;" onsubmit="return confirm(\'Archive this lead? It stays saved and can be restored from the Archived tab.\');">'
                + '<input type="hidden" name="back" value="' + backVal + '">'
                + '<button type="submit" style="width:100%;background:none;border:none;color:#888;font-size:0.8rem;font-weight:600;cursor:pointer;padding:4px;">&#128451; Archive</button>'
                + '</form>'
                + '<form method="POST" action="/admin/lead/' + l.id + '/delete" style="flex:1;" onsubmit="return confirm(\'Permanently delete ' + esc(l.first_name) + ' ' + esc(l.last_name) + '? All quotes, receipts, and follow-ups will be erased. This cannot be undone.\');">'
                + '<input type="hidden" name="back" value="' + backVal + '">'
                + '<button type="submit" style="width:100%;background:none;border:none;color:#c0392b;font-size:0.8rem;font-weight:600;cursor:pointer;padding:4px;">&#128465; Delete</button>'
                + '</form></div>')
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
  if (req.query.msg === 'receipt_sent')  quoteAlert = '<div class="alert alert-success">Receipt sent to the customer. Lead moved to Receipt.</div>';
  if (req.query.msg === 'receipt_saved') quoteAlert = '<div class="alert alert-success">Receipt saved. No email on file for this lead.</div>';
  if (req.query.msg === 'receipt_err')   quoteAlert = '<div class="alert alert-error">Receipt saved, but the email failed to send. Try again.</div>';
  if (req.query.msg === 'quick_sent')    quoteAlert = '<div class="alert alert-success">Quick Quote sent to the customer. Lead created in the Quoted stage.</div>';
  if (req.query.msg === 'quick_saved')   quoteAlert = '<div class="alert alert-success">Lead created from Quick Quote and the quote was saved (not emailed).</div>';
  if (req.query.msg === 'quick_err')     quoteAlert = '<div class="alert alert-error">Lead and quote saved, but the email failed to send. Try resending from this page.</div>';

  var body = '<a href="/admin" class="back-link">&#8592; All Leads</a>'
    + quoteAlert
    + stageTracker(lead.status)
    + nextStageHint(lead)

    // Scheduling request / Approve-Deny (pending) or confirmed banner
    + schedulingPanel(lead, q, false)

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
    + '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">'
    + '<a href="tel:' + esc(lead.phone) + '" class="btn btn-outline btn-sm" style="width:auto;">&#128222; Call</a>'
    + '<a href="sms:' + esc(lead.phone) + '" class="btn btn-outline btn-sm" style="width:auto;">&#128172; Text</a>'
    + (lead.email ? '<button type="button" onclick="copyEmail(this,\'' + esc(lead.email) + '\')" class="btn btn-outline btn-sm" style="width:auto;">&#9993; Email</button>' : '')
    + '</div>'
    + '<form method="POST" action="/admin/lead/' + lead.id + '/status" style="margin-top:12px;display:flex;align-items:center;gap:8px;">'
    + '<input type="hidden" name="back" value="/admin/quote/' + lead.id + '">'
    + '<label style="font-size:0.78rem;color:#aaa;font-weight:600;white-space:nowrap;">Status:</label>'
    + '<select name="status" onchange="this.form.submit()" style="flex:1;padding:7px 10px;border:1.5px solid #dde3ea;border-radius:6px;font-size:0.88rem;color:#1a2a3a;background:#fff;">'
    + ['new','quoted','follow_up','quote_accepted','booked','completed','receipt'].map(function(s) {
        var label = { new:'New', quoted:'Quoted', follow_up:'Follow Up', quote_accepted:'Quote Accepted', booked:'Booked', completed:'Completed', receipt:'Receipt Sent' }[s];
        return '<option value="' + s + '"' + (lead.status === s ? ' selected' : '') + '>' + label + '</option>';
      }).join('')
    + '</select>'
    + '</form>'
    + '<div style="display:flex;gap:0;margin-top:6px;">'
    + '<form method="POST" action="/admin/lead/' + lead.id + '/archive" style="flex:1;" onsubmit="return confirm(\'Archive this lead? It stays saved and can be restored from the Archived tab.\');">'
    + '<input type="hidden" name="back" value="/admin">'
    + '<button type="submit" style="width:100%;background:none;border:none;color:#888;font-size:0.8rem;font-weight:600;cursor:pointer;padding:4px;">&#128451; Archive lead</button>'
    + '</form>'
    + '<form method="POST" action="/admin/lead/' + lead.id + '/delete" style="flex:1;" onsubmit="return confirm(\'Permanently delete ' + esc(lead.first_name) + ' ' + esc(lead.last_name) + '? All quotes, receipts, and follow-ups will be erased. This cannot be undone.\');">'
    + '<input type="hidden" name="back" value="/admin">'
    + '<button type="submit" style="width:100%;background:none;border:none;color:#c0392b;font-size:0.8rem;font-weight:600;cursor:pointer;padding:4px;">&#128465; Delete lead permanently</button>'
    + '</form>'
    + '</div>'
    + '</div>'

    // Lead-level VIN + Internal Notes — the running record for this customer,
    // saved on its own and shown right under the profile (item 5).
    + '<div class="card">'
    + (req.query.msg === 'notes_saved' ? '<div class="alert alert-success" style="margin-bottom:10px;">Saved.</div>' : '')
    + '<div class="section-title" style="margin-bottom:10px;">VIN &amp; Internal Notes <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(internal only, never sent)</span></div>'
    + '<form method="POST" action="/admin/lead/' + lead.id + '/notes">'
    + '<div class="form-group"><label>VIN</label>'
    + '<input type="text" name="vin" placeholder="17-character VIN" value="' + esc(lead.vin || '') + '" maxlength="17"></div>'
    + '<div class="form-group" style="margin-bottom:10px;"><label>Internal Notes</label>'
    + '<textarea name="internalNotes" placeholder="Running notes about this customer or vehicle...">' + esc(lead.internal_notes || '') + '</textarea></div>'
    + '<button type="submit" class="btn btn-outline" style="width:auto;">Save</button>'
    + '</form></div>'

    // Sections below are reordered client-side based on the pipeline stage
    + '<div id="sects">'

    + '<div data-section="complete-job">'
    + (!lead.archived ? '<a href="/admin/receipt/' + lead.id + '" class="btn btn-blue" style="margin-bottom:12px;">&#10003; Complete Job &amp; Send Receipt</a>' : '')
    + '</div>'

    // Receipt history
    + '<div data-section="receipts">'
    + (function() {
        var receipts = db.prepare('SELECT * FROM receipts WHERE lead_id = ? ORDER BY id DESC').all(lead.id);
        if (receipts.length === 0) return '';
        var cards = receipts.map(function(rc) {
          var when = rc.sent_at
            ? 'Sent ' + new Date(rc.sent_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : 'Saved (not emailed)';
          var advisories = [];
          try { advisories = JSON.parse(rc.customer_notes || '[]'); } catch (_) {}
          var advHtml = advisories.length
            ? '<div style="margin-top:10px;"><div style="font-size:0.74rem;font-weight:700;color:#1a6fc4;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;">Advisories to customer</div>'
              + '<ul style="margin:0;padding-left:18px;color:#1a2a3a;font-size:0.85rem;line-height:1.5;">'
              + advisories.map(function(a) { return '<li>' + esc(a) + '</li>'; }).join('')
              + '</ul></div>'
            : '';
          var officeHtml = rc.office_notes
            ? '<div style="margin-top:10px;background:#fff8e1;border:1px solid #f0d080;border-radius:7px;padding:10px 12px;">'
              + '<div style="font-size:0.74rem;font-weight:700;color:#7a5a00;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">Office notes (internal)</div>'
              + '<div style="color:#5a4400;font-size:0.85rem;line-height:1.5;white-space:pre-wrap;">' + esc(rc.office_notes) + '</div></div>'
            : '';
          return '<div style="border:1px solid #eef1f5;border-radius:9px;padding:13px;margin-bottom:10px;">'
            + '<div class="row-sb" style="align-items:flex-start;">'
            + '<div><div style="font-weight:700;color:#0a1f3d;font-size:0.9rem;">' + esc(rc.service || 'Service') + '</div>'
            + '<div style="color:#999;font-size:0.78rem;margin-top:2px;">' + esc(when) + (rc.payment_method ? ' &middot; ' + esc(rc.payment_method) : '') + '</div></div>'
            + '<div style="font-weight:700;color:#0a1f3d;white-space:nowrap;">$' + money(rc.total) + '</div>'
            + '</div>'
            + advHtml
            + officeHtml
            + '<div style="margin-top:11px;"><a href="/admin/receipt/view/' + rc.id + '" class="btn btn-outline btn-sm" style="width:auto;">View customer copy &rarr;</a></div>'
            + '</div>';
        }).join('');
        return '<div class="card">'
          + '<div class="section-title" style="margin-bottom:10px;">Receipts <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(' + receipts.length + ')</span></div>'
          + cards + '</div>';
      })()
    + '</div>'

    // Follow-ups
    + '<div data-section="followups">'
    + (function() {
        var fus = db.prepare(
          'SELECT f.*, ? AS first_name, ? AS last_name, ? AS vehicle FROM followups f WHERE f.lead_id = ? ORDER BY f.sent ASC, f.due_date ASC, f.id ASC'
        ).all(lead.first_name, lead.last_name, lead.vehicle, lead.id);
        var back = '/admin/quote/' + lead.id;
        var todayIso = easternToday();
        var cards = fus.map(function(f) { return followupCard(f, back); }).join('');
        var addForm = '<form method="POST" action="/admin/followup/new" style="margin:0;">'
          + '<input type="hidden" name="lead_id" value="' + lead.id + '">'
          + '<input type="hidden" name="back" value="' + back + '">'
          + '<div style="font-size:0.8rem;color:#888;font-weight:600;margin-bottom:7px;">Add a reminder</div>'
          + '<input type="text" name="description" placeholder="What to follow up on (e.g. recommend rear pads soon)" required style="width:100%;padding:8px 10px;border:1.5px solid #dde3ea;border-radius:7px;font-size:0.86rem;margin-bottom:8px;">'
          + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">'
          + '<input type="date" name="due_date" required min="' + todayIso + '" style="padding:7px 9px;border:1.5px solid #dde3ea;border-radius:7px;font-size:0.84rem;color:#1a2a3a;">'
          + '<select name="recipient" style="padding:7px 9px;border:1.5px solid #dde3ea;border-radius:7px;font-size:0.84rem;background:#fff;">'
          + '<option value="owner">Owner only</option>'
          + '<option value="customer">Customer only</option>'
          + '<option value="both">Owner + Customer</option>'
          + '</select>'
          + '<button type="submit" class="btn btn-navy btn-sm" style="width:auto;">+ Add</button>'
          + '</div></form>';
        return '<div class="section-title" style="margin:18px 0 10px;">Follow-ups'
          + (fus.length ? ' <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(' + fus.length + ')</span>' : '') + '</div>'
          + cards
          + '<div class="card">' + addForm + '</div>';
      })()
    + '</div>'

    // Quote history
    + '<div data-section="quote-history">'
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
                + '<td style="padding:7px 0 7px 8px;text-align:right;">$' + money(pq.total) + '</td>'
                + '</tr>';
            }).join('')
          + '</tbody></table></div></div>'
        : '')
    + '</div>'

    // Lead history
    + '<div data-section="lead-history">'
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
    + '</div>'

    // Build Quote form
    + '<div data-section="build-quote">'
    + '<form method="POST" action="/admin/quote/' + lead.id + '/send" id="qf">'
    + '<div class="card">'
    + '<div class="section-title">Build Quote</div>'

    + '<div class="form-group"><label>Service <span style="color:#bbb;font-weight:400;">(select all that apply)</span></label>'
    + serviceCheckboxes
    + '<button type="button" class="svc-clear-btn" onclick="clearServices()">&#10005; Clear selection</button>'
    + '<div class="svc-tags" id="svcTags"></div>'
    + '<div id="customQuoteHint" style="display:none;background:#fff8e1;border:1px solid #f0d080;border-radius:8px;padding:10px 12px;margin-top:10px;font-size:0.83rem;color:#7a5a00;"></div>'
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
    + '<span id="taxAmt">$' + money(q.tax) + '</span></div>'
    + '</div>'

    // Customer-facing totals
    + '<div class="price-section" style="margin-bottom:0;">'
    + '<div class="price-section-header">Customer Quote</div>'
    + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">'
    + '<span style="font-size:0.77rem;color:#888;font-weight:600;">Show pricing as:</span>'
    + '<div class="tier-toggle" style="margin:0;">'
    + '<button type="button" class="tier-btn active" id="btnCombined" onclick="setLineItems(\'combined\')">Combined</button>'
    + '<button type="button" class="tier-btn" id="btnSeparate" onclick="setLineItems(\'separate\')">Separate</button>'
    + '</div></div>'
    + '<input type="hidden" name="lineItems" id="lineItemsVal" value="combined">'
    + '<div class="price-row" id="liCombinedRow"><span class="price-label">Parts &amp; Labor</span><span id="partsLaborDisplay">$' + money((q.price_parts || 0) + (q.price_labor || 0)) + '</span></div>'
    + '<div class="price-row" id="liPartsRow" style="display:none;"><span class="price-label">Parts</span><span id="partsOnlyDisplay">$' + money(q.price_parts || 0) + '</span></div>'
    + '<div class="price-row" id="liLaborRow" style="display:none;"><span class="price-label">Labor</span><span id="laborOnlyDisplay">$' + money(q.price_labor || 0) + '</span></div>'
    + '<div class="price-row"><span class="price-label">Shop Supplies</span><span id="ssDisplay">$' + money(q.shop_supplies) + '</span></div>'
    + '<div class="price-row tax-row"><span class="price-label">Tax</span><span id="taxDisplay">$' + money(q.tax) + '</span></div>'
    + '<div class="price-row total-row divider-row"><span>Total</span><span id="totalAmt" style="font-size:1.15rem;">$' + money(q.total) + '</span></div>'
    + '</div>'

    + '<input type="hidden" name="taxAmt"   id="taxH"   value="' + fmt(q.tax)   + '">'
    + '<input type="hidden" name="totalAmt" id="totalH" value="' + fmt(q.total) + '">'
    + '</div>'

    + (noEmail ? '<div class="alert alert-error" style="margin-bottom:8px;">No email on file. Quote will be saved but not emailed.</div>' : '')
    + '<button type="button" class="btn btn-outline" onclick="togglePreview()" id="prevBtn">Preview Email</button>'
    + '<div id="previewBox" style="display:none;"></div>'
    + '<button type="submit" class="btn btn-blue" style="margin-top:10px;">Send Quote</button>'
    + '</form>'
    + '</div>'
    + '</div>'

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

    + 'var lineItems="combined";'
    + 'function setLineItems(v){'
    +   'lineItems=v;document.getElementById("lineItemsVal").value=v;'
    +   'document.getElementById("btnCombined").classList.toggle("active",v==="combined");'
    +   'document.getElementById("btnSeparate").classList.toggle("active",v==="separate");'
    +   'document.getElementById("liCombinedRow").style.display=v==="combined"?"":"none";'
    +   'document.getElementById("liPartsRow").style.display=v==="separate"?"":"none";'
    +   'document.getElementById("liLaborRow").style.display=v==="separate"?"":"none";'
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
    +   'updateServiceHints([]);'
    +   'calc();'
    + '}'

    + 'function updatePrices(){'
    +   'var cbs=document.querySelectorAll(".svc-cb:checked");'
    +   'var names=Array.from(cbs).map(function(c){return c.value;});'
    +   'document.getElementById("svcHidden").value=names.join(", ");'
    +   'var totParts=0,totLabor=0,totSS=0;'
    +   'names.forEach(function(svc){'
    +     'if(!PRICING[svc])return;'
    +     'var p=PRICING[svc][tier]||PRICING[svc].standard;' // fall back to standard when tier missing
    +     'if(!p)return;'
    +     'totParts+=p.parts;totLabor+=p.labor;totSS+=p.shopSupplies;'
    +   '});'
    +   'renderTags();'
    +   'updateServiceHints(names);'
    +   'if(names.length===0)return;'
    +   'document.getElementById("parts").value=totParts.toFixed(2);'
    +   'document.getElementById("labor").value=totLabor.toFixed(2);'
    +   'document.getElementById("ss").value=totSS.toFixed(2);'
    +   'calc();'
    + '}'

    // Shows custom-quote reminders and any service-specific notes (e.g. inspection fee policy)
    + 'function updateServiceHints(names){'
    +   'var msgs=[];'
    +   'var custom=names.filter(function(n){return PRICING[n]&&PRICING[n].customQuote;});'
    +   'if(custom.length){msgs.push("<strong>Custom quote:</strong> "+custom.join(", ")+" "+(custom.length>1?"have":"has")+" no preset price. Look up the exact part(s) and enter Parts and Labor manually.");}'
    +   'names.forEach(function(n){if(PRICING[n]&&PRICING[n].note){msgs.push(PRICING[n].note);}});'
    +   'var box=document.getElementById("customQuoteHint");'
    +   'if(msgs.length){box.innerHTML=msgs.join("<br><br>");box.style.display="block";}else{box.style.display="none";}'
    + '}'

    + 'function money(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'

    // Tax is on parts + shop supplies only (not labor — Virginia law)
    + 'function calc(){'
    +   'var parts=parseFloat(document.getElementById("parts").value)||0;'
    +   'var labor=parseFloat(document.getElementById("labor").value)||0;'
    +   'var ss=parseFloat(document.getElementById("ss").value)||0;'
    +   'var tr=parseFloat(document.getElementById("tr").value)||0;'
    +   'var tax=(parts+ss)*tr/100;'
    +   'var total=parts+labor+ss+tax;'
    +   'document.getElementById("taxAmt").textContent="$"+money(tax);'
    +   'document.getElementById("partsLaborDisplay").textContent="$"+money(parts+labor);'
    +   'document.getElementById("partsOnlyDisplay").textContent="$"+money(parts);'
    +   'document.getElementById("laborOnlyDisplay").textContent="$"+money(labor);'
    +   'document.getElementById("ssDisplay").textContent="$"+money(ss);'
    +   'document.getElementById("taxDisplay").textContent="$"+money(tax);'
    +   'document.getElementById("totalAmt").textContent="$"+money(total);'
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
    +   'var veh=vehicle?" for your <strong>"+vehicle+"</strong>":"";'
    +   'var toLine=leadEmail||"<em style=\'color:#e07000\'>(no email on file)</em>";'
    +   'var svcLine=svcNames.length<=1?(svcNames[0]||"(no service selected)"):svcNames.slice(0,-1).join(", ")+", and "+svcNames[svcNames.length-1];'
    +   'var totMins=svcNames.reduce(function(a,n){return a+((PRICING[n]&&PRICING[n].minutes)||0);},0);'
    +   'var durTxt=totMins?(Math.floor(totMins/60)?(Math.floor(totMins/60)+" hr"+(totMins%60?" "+(totMins%60)+" min":"")):(totMins+" min")):"";'
    +   'box.innerHTML='
    +     '"<div class=\'preview-box\'>"'
    +     '+"<h4>Email Preview</h4>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:4px;\'>To: "+toLine+"</div>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:8px;\'>Subject: Your Brake Service Quote — Brake Knights</div>"'
    +     '+"<hr class=\'preview-divider\'>"'
    +     '+"<p>Greetings "+firstName+",</p>"'
    +     '+"<p style=\'margin-top:8px;\'>Here is your quote"+veh+":</p>"'
    +     '+"<div style=\'margin:10px 0 4px;font-size:0.8rem;font-weight:700;color:#0a1f3d;text-transform:uppercase;letter-spacing:.4px;\'>Service Requested</div>"'
    +     '+"<p style=\'margin:0 0 6px;font-size:0.92rem;font-weight:600;color:#1a2a3a;\'>"+svcLine+"</p>"'
    +     '+(durTxt?"<p style=\'margin:0 0 12px;font-size:0.85rem;color:#555;\'>Estimated time on site: about "+durTxt+"</p>":"")'
    +     '+"<table style=\'width:100%;margin:12px 0;font-size:0.88rem;border-collapse:collapse;\'>"'
    +     '+(lineItems==="separate"?"<tr><td>Parts</td><td style=\'text-align:right;\'>$"+money(parts)+"</td></tr><tr><td>Labor</td><td style=\'text-align:right;\'>$"+money(labor)+"</td></tr>":"<tr><td>Parts &amp; Labor</td><td style=\'text-align:right;\'>$"+money(parts+labor)+"</td></tr>")'
    +     '+"<tr><td>Shop Supplies</td><td style=\'text-align:right;\'>$"+money(ss)+"</td></tr>"'
    +     '+"<tr><td>Tax</td><td style=\'text-align:right;\'>$"+money(tax)+"</td></tr>"'
    +     '+"<tr style=\'font-weight:700;font-size:1rem;border-top:2px solid #dde3ea;\'><td style=\'padding-top:8px;\'>Total</td><td style=\'text-align:right;padding-top:8px;\'>$"+money(tot)+"</td></tr>"'
    +     '+"</table>"'
    +     '+svcNames.map(function(s){return PRICING[s]&&PRICING[s].note;}).filter(Boolean).map(function(n){return "<p style=\'color:#7a5a00;background:#fff8e1;border:1px solid #f0d080;border-radius:6px;padding:8px 10px;font-size:0.85rem;\'>"+n+"</p>";}).join("")'
    +     '+"<p>Includes all parts and labor. Qualifying pad and rotor replacements carry a <strong>12-month / 12,000-mile warranty</strong>.</p>"'
    +     '+"<p style=\'margin-top:8px;\'>We come to your home or office. No shop visit needed.</p>"'
    +     '+"<p style=\'margin-top:8px;\'>Reply to this email or call/text <strong>703-977-4475</strong> to confirm.</p>"'
    +     '+"</div>";'
    +   'box.style.display="block";'
    +   'document.getElementById("prevBtn").textContent="Hide Preview";'
    + '}'

    // On load: if this is a brand-new quote (no saved quote yet) with a service
    // already auto-filled from the lead, populate prices from the pricing table.
    // Otherwise just total up the saved/edited values without overwriting them.
    + (allQuotes.length === 0 && currentServices.length > 0 ? 'updatePrices();' : 'calc();')
    + 'updateServiceHints(Array.from(document.querySelectorAll(".svc-cb:checked")).map(function(c){return c.value;}));'
    + 'renderTags();'
    + '(function(){'
    +   'var STATUS="' + esc(lead.status) + '";'
    +   'var ORDER={'
    +     'new:["build-quote","followups","complete-job","receipts","quote-history","lead-history"],'
    +     'quoted:["followups","build-quote","complete-job","receipts","quote-history","lead-history"],'
    +     'follow_up:["followups","build-quote","complete-job","receipts","quote-history","lead-history"],'
    +     'quote_accepted:["complete-job","followups","build-quote","receipts","quote-history","lead-history"],'
    +     'booked:["complete-job","followups","build-quote","receipts","quote-history","lead-history"],'
    +     'completed:["receipts","complete-job","followups","build-quote","quote-history","lead-history"],'
    +     'receipt:["receipts","complete-job","followups","build-quote","quote-history","lead-history"]'
    +   '};'
    +   'var order=ORDER[STATUS]||ORDER.new;'
    +   'var c=document.getElementById("sects");'
    +   'if(!c)return;'
    +   'order.forEach(function(n){var el=c.querySelector("[data-section=\'"+n+"\']");if(el)c.appendChild(el);});'
    + '})();'
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
      html:    buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, taxAmt, totalAmt, acceptUrl, req.body.lineItems || 'combined')
    });

    res.redirect('/admin?msg=sent');
  } catch (err) {
    console.error('Quote email error:', err.message);
    res.redirect('/admin?msg=err');
  }
});

// ─── Quote email (Phase 3C upgrades this to fully branded template) ───────────

// Returns the warranty paragraph for a given service string (comma-separated names).
// Rotors/drums: full parts + labor warranty.
// Pads/shoes only: labor warranty (pads wear; no parts warranty).
// Inspection or fluid flush only: no warranty clause.
function buildWarrantyClause(service) {
  var svcs = String(service || '').split(',').map(function(s) { return s.trim().toLowerCase(); });
  if (!svcs.length) return '';
  var allNoWarranty = svcs.every(function(s) { return /inspection|fluid/i.test(s); });
  if (allNoWarranty) return '';
  var partsQuality = 'All parts are <strong>premium quality, meeting or exceeding OEM manufacturer specifications</strong>.';
  var hasRotorsOrDrums = svcs.some(function(s) { return /rotor|drum/i.test(s); });
  if (hasRotorsOrDrums) {
    return '<p style="color:#444;line-height:1.6;margin:0 0 12px;font-size:0.9rem;">' + partsQuality + ' This job carries a <strong>12-month / 12,000-mile warranty</strong> on parts and labor.</p>';
  }
  return '<p style="color:#444;line-height:1.6;margin:0 0 12px;font-size:0.9rem;">' + partsQuality + ' This job carries a <strong>12-month / 12,000-mile warranty on labor</strong>.</p>';
}

function buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, tax, total, acceptUrl, lineItems) {
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
    + '<p style="color:#444;line-height:1.6;margin:0 0 20px;">Here is your quote' + vehicleBit + ':</p>'
    + '<div style="background:#f4f7fb;border-radius:8px;padding:20px;margin-bottom:24px;">'
    + '<p style="font-weight:700;color:#0a1f3d;margin:0 0 8px;font-size:0.82rem;text-transform:uppercase;letter-spacing:.5px;">Service Requested</p>'
    + '<p style="margin:0 0 6px;font-size:0.95rem;color:#1a2a3a;font-weight:600;">' + esc(joinServices(service)) + '</p>'
    + (totalServiceMinutes(service) ? '<p style="margin:0 0 16px;font-size:0.86rem;color:#555;">Estimated time on site: about <strong>' + formatDuration(totalServiceMinutes(service)) + '</strong>. Please pick a time that allows for it.</p>' : '')
    + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
    + (lineItems === 'separate'
        ? '<tr><td style="padding:6px 0;">Parts</td><td style="text-align:right;">$' + money(parts) + '</td></tr>'
          + '<tr><td style="padding:6px 0;">Labor</td><td style="text-align:right;">$' + money(labor) + '</td></tr>'
        : '<tr><td style="padding:6px 0;">Parts &amp; Labor</td><td style="text-align:right;">$' + money(partsLabor) + '</td></tr>')
    + '<tr><td style="padding:6px 0;">Shop Supplies</td><td style="text-align:right;">$' + money(shopSupplies) + '</td></tr>'
    + '<tr><td style="padding:6px 0;color:#888;">Tax</td><td style="text-align:right;color:#888;">$' + money(tax) + '</td></tr>'
    + '<tr style="border-top:2px solid #dde3ea;"><td style="padding:10px 0 0;font-weight:700;font-size:1rem;color:#0a1f3d;">Total</td>'
    + '<td style="text-align:right;padding:10px 0 0;font-weight:700;font-size:1.1rem;color:#0a1f3d;">$' + money(total) + '</td></tr>'
    + '</table></div>'
    + service.split(', ').map(function(s) { var sv = PRICING.services[s.trim()]; return (sv && sv.note) ? sv.note : null; }).filter(Boolean).map(function(n) {
        return '<p style="color:#7a5a00;background:#fff8e1;border:1px solid #f0d080;border-radius:8px;padding:12px 14px;line-height:1.55;margin:0 0 20px;font-size:0.86rem;">' + esc(n) + '</p>';
      }).join('')
    // Primary CTA — placed directly under the total (the unique part of the email)
    // so Gmail never hides it below "show trimmed content".
    + (acceptUrl
        ? '<div style="text-align:center;margin:4px 0 24px;">'
          + '<a href="' + acceptUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:1rem;text-decoration:none;padding:15px 34px;border-radius:8px;">Accept Quote &amp; Choose Your Time &rarr;</a>'
          + '<p style="color:#888;font-size:0.82rem;margin:12px 0 0;">You&rsquo;ll pick a preferred day and time. We&rsquo;ll confirm it or reach out about other openings.</p>'
          + '</div>'
        : '')
    + buildWarrantyClause(service)
    + '<p style="color:#444;line-height:1.6;margin:0 0 12px;font-size:0.9rem;">Our service is fully mobile. We come directly to your home or office. No shop visit needed.</p>'
    + '<p style="color:#6b5900;background:#fffbea;border:1px solid #e8d87a;border-radius:6px;padding:10px 14px;line-height:1.55;margin:0 0 24px;font-size:0.84rem;"><strong>Inspection note:</strong> If we arrive and determine no brake service is needed, a $60 inspection fee applies. If repairs are needed, the inspection fee is applied toward the cost of the repair — no extra charge.</p>'
    + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
    + '<p style="color:#fff;font-weight:700;margin:0 0 8px;font-size:0.95rem;">Prefer to talk it through? Reply to this email or call/text:</p>'
    + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
    + '</div></div>'
    + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div>'
    + '</div>';
}

// ─── Phase 5: Job summary + custom receipt ────────────────────────────────────

var PAYMENT_METHODS = ['Credit/Debit Card', 'Cash', 'Other'];

// Renders one advisory row: a customer-facing note plus an optional date-picker
// follow-up reminder. Pass hidden=true for rows 2-4 (shown via "+ Add Advisory").
function advisoryRow(i, hidden) {
  var today = easternToday();
  return '<div id="advRow' + i + '" style="border:1.5px solid #eef1f5;border-radius:10px;padding:13px;margin-bottom:10px;background:#fbfcfe;' + (hidden ? 'display:none;' : '') + '">'
    + '<div class="form-group" style="margin-bottom:9px;"><label>Advisory ' + i + ' <span style="color:#bbb;font-weight:400;">(shown on receipt)</span></label>'
    + '<input type="text" name="custNote' + i + '" placeholder="e.g. Rear pads ~30%, plan replacement in about 6 months"></div>'
    + '<div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;">'
    + '<div class="form-group" style="margin-bottom:0;flex:1;min-width:140px;"><label>Follow-up date <span style="color:#bbb;font-weight:400;">(optional — leave blank for no reminder)</span></label>'
    + '<input type="date" name="fuCustom' + i + '" min="' + today + '" style="width:100%;padding:9px 10px;border:1.5px solid #dde3ea;border-radius:7px;font-size:0.9rem;color:#1a2a3a;"></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Remind</label>'
    + '<select name="fuRecipient' + i + '" style="padding:10px;border:1.5px solid #dde3ea;border-radius:7px;font-size:0.88rem;background:#fff;">'
    + '<option value="owner" selected>Owner only</option>'
    + '<option value="customer">Customer only</option>'
    + '<option value="both">Both</option>'
    + '</select></div>'
    + '</div>'
    + '</div>';
}

router.get('/receipt/:id', requireAuth, function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');

  // Prefill from the accepted quote if there is one, otherwise the most recent quote.
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id)
    || db.prepare('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id)
    || {};

  var service   = quote.service || lead.service || '';
  var vehicle   = lead.vehicle || '';
  // Prefer the chosen quote's location; otherwise pull the most recent service
  // address from any of this lead's quotes (phone-booked jobs may have it on a
  // different quote than the one we prefilled from).
  var address   = quote.pref_location
    || (db.prepare("SELECT pref_location FROM quotes WHERE lead_id = ? AND pref_location IS NOT NULL AND TRIM(pref_location) != '' ORDER BY id DESC LIMIT 1").get(lead.id) || {}).pref_location
    || '';
  var partsLabor = (quote.price_parts || 0) + (quote.price_labor || 0);
  var shopSupplies = quote.shop_supplies || 0;
  var tax       = quote.tax || 0;
  var total     = partsLabor + shopSupplies + tax;
  var receiptTier = quote.tier === 'premium' ? 'premium' : 'standard';

  // Service picker mirrors the quote tool: a multi-select of every service so the
  // owner can change/add what was actually done if the job grew on arrival.
  var selectedServices = service ? service.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
  var rServiceCheckboxes = '<div class="svc-check-list">'
    + Object.keys(PRICING.services).map(function(s) {
        var checked = selectedServices.indexOf(s) >= 0 ? ' checked' : '';
        return '<label class="svc-check-item"><input type="checkbox" class="rsvc-cb" value="' + esc(s) + '"' + checked + ' onchange="rUpdateServices()"><span class="svc-box"></span>' + esc(s) + '</label>';
      }).join('')
    + '</div>'
    + '<input type="hidden" name="service" id="rsvcHidden" value="' + esc(service) + '">';
  var rPricingJson = JSON.stringify(PRICING.services);

  var paymentOpts = PAYMENT_METHODS.map(function(p) {
    return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
  }).join('');

  var advisoryRows = advisoryRow(1, false);
  for (var i = 2; i <= 4; i++) advisoryRows += advisoryRow(i, true);
  advisoryRows += '<button type="button" id="rAddAdvBtn" class="svc-clear-btn" style="margin-top:6px;" onclick="bkAddAdvisory(\'r\')">+ Add Advisory</button>';

  // Past receipts for this lead (lightweight history)
  var pastReceipts = db.prepare('SELECT * FROM receipts WHERE lead_id = ? ORDER BY id DESC').all(lead.id);

  var body = '<a href="/admin/quote/' + lead.id + '" class="back-link">&#8592; Back to Lead</a>'
    + '<div class="card">'
    + '<div class="row-sb" style="margin-bottom:6px;">'
    + '<div class="lead-name">' + esc(lead.first_name) + ' ' + esc(lead.last_name) + '</div>'
    + statusBadge(lead.status)
    + '</div>'
    + '<div style="color:#888;font-size:0.85rem;">Complete the job and send a branded receipt. This marks the lead Completed.</div>'
    + (pastReceipts.length
        ? '<div style="margin-top:10px;font-size:0.82rem;color:#1a7a3a;">&#10003; ' + pastReceipts.length + ' receipt' + (pastReceipts.length > 1 ? 's' : '') + ' already sent for this lead. Sending another creates a new one.</div>'
        : '')
    + '</div>'

    + '<form method="POST" action="/admin/receipt/' + lead.id + '/send" id="rf">'

    + '<div class="card">'
    + '<div class="section-title">Service &amp; Vehicle</div>'
    + '<div class="form-group"><label>Service performed <span style="color:#bbb;font-weight:400;">(select all that apply, change if the job grew on arrival)</span></label>'
    + rServiceCheckboxes
    + '<button type="button" class="svc-clear-btn" onclick="rClearServices()">&#10005; Clear selection</button>'
    + '<div class="svc-tags" id="rsvcTags"></div>'
    + '</div>'
    + '<div class="form-group"><label>Tier <span style="color:#bbb;font-weight:400;">(sets auto-filled pricing)</span></label>'
    + '<div class="tier-toggle">'
    + '<button type="button" class="tier-btn' + (receiptTier === 'standard' ? ' active' : '') + '" id="rBtnStd" onclick="rSetTier(\'standard\')">Standard</button>'
    + '<button type="button" class="tier-btn' + (receiptTier === 'premium'  ? ' active' : '') + '" id="rBtnPrem" onclick="rSetTier(\'premium\')">Premium</button>'
    + '</div></div>'
    + '<div class="form-group"><label>Vehicle <span style="color:#bbb;font-weight:400;">(year make model)</span></label>'
    + '<input type="text" name="vehicle" value="' + esc(vehicle) + '" placeholder="e.g. 2018 Honda Accord"></div>'
    + '<div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Date of service</label>'
    + '<input type="date" name="serviceDate" value="' + esc(easternToday()) + '"></div>'
    + '<div class="form-group"><label>Payment method</label>'
    + '<select name="paymentMethod" id="rpm" onchange="rPayToggle()">' + paymentOpts + '</select></div>'
    + '</div>'
    + '<div class="form-group" id="rpmOtherWrap" style="display:none;"><label>Specify payment method</label>'
    + '<input type="text" name="paymentOther" id="rpmOther" placeholder="e.g. Zelle, Venmo, Check"></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Service address</label>'
    + '<input type="text" id="receiptAddr" name="serviceAddress" autocomplete="off" value="' + esc(address) + '" placeholder="Where the work was performed"></div>'
    + '</div>'

    + '<div class="card">'
    + '<div class="section-title">Amount Paid</div>'
    + '<div class="price-section" style="margin-bottom:0;">'
    + '<div class="price-row"><span class="price-label">Parts &amp; Labor</span>'
    + '<input class="price-input" type="number" name="partsLabor" id="rpl" min="0" step="0.01" value="' + fmt(partsLabor) + '" oninput="rcalc()"></div>'
    + '<div class="price-row"><span class="price-label">Shop Supplies</span>'
    + '<input class="price-input" type="number" name="shopSupplies" id="rss" min="0" step="0.01" value="' + fmt(shopSupplies) + '" oninput="rcalc()"></div>'
    + '<div class="price-row"><span class="price-label">Tax</span>'
    + '<input class="price-input" type="number" name="tax" id="rtax" min="0" step="0.01" value="' + fmt(tax) + '" oninput="rcalc()"></div>'
    + '<div class="price-row total-row divider-row"><span>Total Paid</span><span id="rtotal" style="font-size:1.15rem;">$' + money(total) + '</span></div>'
    + '</div>'
    + '<input type="hidden" name="total" id="rtotalH" value="' + fmt(total) + '">'
    + '</div>'

    + '<div class="card">'
    + '<div class="section-title">Notes to Customer <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(each appears on the receipt)</span></div>'
    + advisoryRows
    + '</div>'

    + '<div class="card">'
    + '<div class="form-group" style="margin-bottom:0;"><label>Notes to Office <span style="color:#bbb;font-weight:400;">(internal only, never sent)</span></label>'
    + '<textarea name="officeNotes" placeholder="Torque specs, parts used, condition observations, anything for the record…"></textarea></div>'
    + '</div>'

    + (lead.email ? '' : '<div class="alert alert-error" style="margin-bottom:8px;">No email on file. The receipt will be saved but not emailed.</div>')
    + '<button type="button" class="btn btn-outline" onclick="toggleReceiptPreview()" id="rPrevBtn" style="margin-bottom:10px;">Preview Receipt Email</button>'
    + '<div id="rPreviewBox" style="display:none;margin-bottom:10px;"></div>'
    + '<button type="submit" class="btn btn-blue">&#10003; Complete Job &amp; Send Receipt</button>'
    + '</form>'

    + '<script>'
    + 'var RPRICING=' + rPricingJson + ';'
    + 'var RTAXRATE=' + PRICING.taxRate + ';'
    + 'var rtier="' + esc(receiptTier) + '";'
    + 'function rcalc(){'
    +   'var pl=parseFloat(document.getElementById("rpl").value)||0;'
    +   'var ss=parseFloat(document.getElementById("rss").value)||0;'
    +   'var tax=parseFloat(document.getElementById("rtax").value)||0;'
    +   'var t=pl+ss+tax;'
    +   'document.getElementById("rtotal").textContent="$"+t.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});'
    +   'document.getElementById("rtotalH").value=t.toFixed(2);'
    + '}'
    + 'function rCheckedServices(){'
    +   'return Array.from(document.querySelectorAll(".rsvc-cb:checked")).map(function(c){return c.value;});'
    + '}'
    + 'function rRenderTags(){'
    +   'var names=rCheckedServices();'
    +   'document.getElementById("rsvcTags").innerHTML=names.map(function(n){'
    +     'return "<span class=\'svc-tag\'><button type=\'button\' class=\'svc-tag-x\' onclick=\'rRemoveTag(this)\' data-val=\'"+n+"\'>&#10005;</button>"+n+"</span>";'
    +   '}).join("");'
    + '}'
    + 'function rRemoveTag(btn){'
    +   'var val=btn.getAttribute("data-val");'
    +   'var cb=Array.from(document.querySelectorAll(".rsvc-cb")).find(function(c){return c.value===val;});'
    +   'if(cb)cb.checked=false;'
    +   'rUpdateServices();'
    + '}'
    + 'function rClearServices(){'
    +   'document.querySelectorAll(".rsvc-cb").forEach(function(cb){cb.checked=false;});'
    +   'rUpdateServices();'
    + '}'
    + 'function rSetTier(t){'
    +   'rtier=t;'
    +   'document.getElementById("rBtnStd").classList.toggle("active",t==="standard");'
    +   'document.getElementById("rBtnPrem").classList.toggle("active",t==="premium");'
    +   'rAutofill();'
    + '}'
    // Auto-fill the Amount Paid fields from the pricing table for the selected
    // services + tier. The owner can still type over any field afterward.
    + 'function rAutofill(){'
    +   'var names=rCheckedServices();'
    +   'if(names.length===0){'
    +     'document.getElementById("rpl").value="0.00";'
    +     'document.getElementById("rss").value="0.00";'
    +     'document.getElementById("rtax").value="0.00";'
    +     'rcalc();return;'
    +   '}'
    +   'var parts=0,labor=0,ss=0;'
    +   'names.forEach(function(s){'
    +     'var sv=RPRICING[s];if(!sv)return;'
    +     'var p=sv[rtier]||sv.standard;if(!p)return;'
    +     'parts+=p.parts;labor+=p.labor;ss+=p.shopSupplies;'
    +   '});'
    +   'var tax=(parts+ss)*RTAXRATE;'
    +   'document.getElementById("rpl").value=(parts+labor).toFixed(2);'
    +   'document.getElementById("rss").value=ss.toFixed(2);'
    +   'document.getElementById("rtax").value=tax.toFixed(2);'
    +   'rcalc();'
    + '}'
    + 'function rUpdateServices(){'
    +   'document.getElementById("rsvcHidden").value=rCheckedServices().join(", ");'
    +   'rRenderTags();'
    +   'rAutofill();'
    + '}'
    + 'function rPayToggle(){'
    +   'var v=document.getElementById("rpm").value;'
    +   'var wrap=document.getElementById("rpmOtherWrap");'
    +   'var show=(v==="Other");'
    +   'wrap.style.display=show?"block":"none";'
    +   'document.getElementById("rpmOther").required=show;'
    + '}'
    + 'function toggleCustom(i){'
    +   'var v=document.querySelector("[name=fuTime"+i+"]").value;'
    +   'document.getElementById("customWrap"+i).style.display=(v==="custom")?"block":"none";'
    + '}'
    + 'rRenderTags();rPayToggle();'
    // Auto-fill prices from pricing table on page load if all price fields are 0
    + 'if(!(parseFloat(document.getElementById("rpl").value)||parseFloat(document.getElementById("rss").value)))rUpdateServices();'
    + 'function bkAddAdvisory(pfx){'
    +   'for(var i=2;i<=4;i++){'
    +     'var r=document.getElementById((pfx||"")+"advRow"+i)||document.getElementById("advRow"+i);'
    +     'if(r&&r.style.display==="none"){r.style.display="block";'
    +       'if(i===4){var btn=document.getElementById((pfx||"r")+"AddAdvBtn");if(btn)btn.style.display="none";}'
    +       'return;}'
    +   '}'
    + '}'
    + 'function toggleReceiptPreview(){'
    +   'var box=document.getElementById("rPreviewBox");'
    +   'if(box.style.display!=="none"){box.style.display="none";document.getElementById("rPrevBtn").textContent="Preview Receipt Email";return;}'
    +   'var svcs=Array.from(document.querySelectorAll(".rsvc-cb:checked")).map(function(c){return c.value;});'
    +   'var veh=(document.querySelector("[name=vehicle]")||{}).value||"";'
    +   'var svcDate=(document.querySelector("[name=serviceDate]")||{}).value||"";'
    +   'var pm=(document.getElementById("rpm")||{}).value||"";'
    +   'var tot=document.getElementById("rtotal").textContent||"$0.00";'
    +   'var advNotes=[];for(var i=1;i<=4;i++){var n=(document.querySelector("[name=custNote"+i+"]")||{}).value||"";if(n)advNotes.push(n);}'
    +   'var toLine="' + esc(lead.email || '') + '"||"<em style=\'color:#e07000\'>(no email on file)</em>";'
    +   'box.innerHTML="<div class=\'preview-box\'>"'
    +     '+"<h4>Receipt Email Preview</h4>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:4px;\'>To: "+toLine+"</div>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:8px;\'>Subject: Your Brake Knights Service Receipt</div>"'
    +     '+"<hr class=\'preview-divider\'>"'
    +     '+"<p>Greetings ' + esc(lead.first_name) + ',</p>"'
    +     '+"<div style=\'margin:10px 0;background:#f4f7fb;border-radius:8px;padding:14px;font-size:0.88rem;\'>"'
    +     '+(svcs.length?"<div><strong>Service:</strong> "+svcs.join(", ")+"</div>":"")'
    +     '+(veh?"<div style=\'margin-top:4px;\'><strong>Vehicle:</strong> "+veh+"</div>":"")'
    +     '+(svcDate?"<div style=\'margin-top:4px;\'><strong>Date:</strong> "+svcDate+"</div>":"")'
    +     '+"<div style=\'margin-top:4px;\'><strong>Total:</strong> "+tot+"</div>"'
    +     '+(pm?"<div style=\'margin-top:4px;\'><strong>Payment:</strong> "+pm+"</div>":"")'
    +     '+"</div>"'
    +     '+(advNotes.length?"<div style=\'margin-top:10px;\'><strong>Notes to customer:</strong><ul style=\'margin:6px 0 0 18px;padding:0;font-size:0.86rem;\'>"+advNotes.map(function(n){return"<li>"+n+"</li>";}).join("")+"</ul></div>":"")'
    +     '+"<p style=\'margin-top:10px;\'>All qualifying pad and rotor replacements come with a <strong>12-month / 12,000-mile warranty</strong>.</p>"'
    +     '+"</div>";'
    +   'box.style.display="block";document.getElementById("rPrevBtn").textContent="Hide Preview";'
    + '}'
    + '</script>'
    + (process.env.GOOGLE_MAPS_API_KEY
        ? '<script>function initBkRecAddr(){var el=document.getElementById("receiptAddr");if(!el||!window.google||!google.maps||!google.maps.places)return;var ac=new google.maps.places.Autocomplete(el,{fields:["formatted_address"],componentRestrictions:{country:"us"},types:["address"]});ac.addListener("place_changed",function(){if(ac.getPlace())el.value=ac.getPlace().formatted_address||el.value;});}<\/script>'
          + '<script src="https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(process.env.GOOGLE_MAPS_API_KEY) + '&libraries=places&loading=async&callback=initBkRecAddr" async><\/script>'
        : '');

  res.send(page('Receipt — ' + lead.first_name + ' ' + lead.last_name, body, req));
});

router.post('/receipt/:id/send', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');

  var service      = (req.body.service || '').trim();
  var vehicle      = (req.body.vehicle || '').trim();
  var serviceDate  = (req.body.serviceDate || '').trim() || easternToday();
  var address      = (req.body.serviceAddress || '').trim();
  var partsLabor   = parseFloat(req.body.partsLabor)   || 0;
  var shopSupplies = parseFloat(req.body.shopSupplies) || 0;
  var tax          = parseFloat(req.body.tax)          || 0;
  var total        = partsLabor + shopSupplies + tax;
  var payment      = (req.body.paymentMethod || '').trim();
  if (payment === 'Other') payment = (req.body.paymentOther || '').trim() || 'Other';
  var officeNotes  = (req.body.officeNotes || '').trim() || null;

  // Collect customer advisories and any reminders attached to them.
  var notes = [];
  var followups = [];
  for (var i = 1; i <= 4; i++) {
    var txt = (req.body['custNote' + i] || '').trim();
    if (txt) notes.push(txt);
    var due = (req.body['fuCustom' + i] || '').trim();
    if (due && txt) {
      followups.push({ description: txt, due_date: due, recipient: req.body['fuRecipient' + i] || 'owner' });
    }
  }

  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id)
    || db.prepare('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id);

  var info = db.prepare(
    'INSERT INTO receipts (lead_id, quote_id, service, vehicle, service_date, service_address, parts_labor, shop_supplies, tax, total, payment_method, customer_notes, office_notes) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(lead.id, quote ? quote.id : null, service, vehicle, serviceDate, address, partsLabor, shopSupplies, tax, total, payment, JSON.stringify(notes), officeNotes);
  var receiptId = info.lastInsertRowid;

  followups.forEach(function(f) {
    db.prepare('INSERT INTO followups (lead_id, receipt_id, description, due_date, recipient) VALUES (?,?,?,?,?)')
      .run(lead.id, receiptId, f.description, f.due_date, f.recipient);
  });

  // Baseline: job is done but the receipt isn't delivered yet → 'completed'
  // (this is the "needs receipt sent" state). Once the email goes out below,
  // the lead advances to the 'receipt' stage.
  db.prepare("UPDATE leads SET status = 'completed', status_updated_at = datetime('now') WHERE id = ?").run(lead.id);

  var receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  var receiptDetail = '$' + total.toFixed(2) + (payment ? ' · ' + payment : '') + (followups.length ? ' · ' + followups.length + ' reminder' + (followups.length > 1 ? 's' : '') + ' set' : '');

  if (process.env.SMTP_PASS && lead.email) {
    try {
      var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      await tx.sendMail({
        from:    '"Brake Knights" <greetings@brakeknights.com>',
        to:      lead.email,
        replyTo: 'greetings@brakeknights.com',
        subject: 'Your Brake Knights Service Receipt',
        html:    buildReceiptEmail(lead, receipt, notes)
      });
      db.prepare("UPDATE receipts SET sent_at = datetime('now') WHERE id = ?").run(receiptId);
      db.prepare("UPDATE leads SET status = 'receipt', status_updated_at = datetime('now') WHERE id = ?").run(lead.id);
      logHistory(lead.id, 'Receipt sent to customer', receiptDetail);
      return res.redirect('/admin/quote/' + lead.id + '?msg=receipt_sent');
    } catch (err) {
      console.error('Receipt email error:', err.message);
      logHistory(lead.id, 'Receipt saved (email failed)', receiptDetail);
      return res.redirect('/admin/quote/' + lead.id + '?msg=receipt_err');
    }
  }
  logHistory(lead.id, 'Receipt saved (not emailed)', receiptDetail);
  res.redirect('/admin/quote/' + lead.id + '?msg=receipt_saved');
});

// Read-only view of a sent receipt: the exact customer copy, plus an internal
// panel with office notes and any follow-ups this receipt created.
router.get('/receipt/view/:id', requireAuth, function(req, res) {
  var receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!receipt) return res.status(404).send('Receipt not found');
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(receipt.lead_id);
  if (!lead) return res.status(404).send('Lead not found');

  var notes = [];
  try { notes = JSON.parse(receipt.customer_notes || '[]'); } catch (_) {}
  var when = receipt.sent_at
    ? 'Emailed ' + new Date(receipt.sent_at + 'Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : 'Saved, not emailed';

  var fus = db.prepare('SELECT * FROM followups WHERE receipt_id = ? ORDER BY due_date ASC').all(receipt.id);
  var fuHtml = fus.length
    ? '<div style="margin-top:14px;"><div style="font-size:0.78rem;font-weight:700;color:#0a1f3d;margin-bottom:6px;">Follow-ups created from this receipt</div>'
      + fus.map(function(f) {
          return '<div style="font-size:0.85rem;color:#444;padding:6px 0;border-bottom:1px solid #f4f4f4;">'
            + esc(f.description) + ' <span style="color:#aaa;">&middot; due ' + esc(fmtPrefDate(f.due_date)) + ' &middot; ' + esc(RECIPIENT_LABEL[f.recipient] || f.recipient)
            + (f.sent ? ' &middot; sent' : '') + '</span></div>';
        }).join('')
      + '</div>'
    : '';

  var body = '<a href="/admin/quote/' + lead.id + '" class="back-link">&#8592; Back to Lead</a>'
    + '<div class="card">'
    + '<div class="row-sb" style="margin-bottom:4px;">'
    + '<div class="lead-name">Receipt &middot; ' + esc(lead.first_name) + ' ' + esc(lead.last_name) + '</div>'
    + '<div style="font-weight:700;color:#0a1f3d;">$' + money(receipt.total) + '</div>'
    + '</div>'
    + '<div style="color:#999;font-size:0.82rem;">' + esc(when) + (receipt.payment_method ? ' &middot; ' + esc(receipt.payment_method) : '') + '</div>'
    + '</div>'

    // Internal panel (office notes + follow-ups) — never sent to the customer.
    + ((receipt.office_notes || fus.length)
        ? '<div class="card" style="background:#fffaf0;border:1px solid #f0d080;">'
          + '<div class="section-title" style="color:#7a5a00;">Internal &mdash; not sent to customer</div>'
          + (receipt.office_notes
              ? '<div style="color:#5a4400;font-size:0.9rem;line-height:1.55;white-space:pre-wrap;">' + esc(receipt.office_notes) + '</div>'
              : '<div style="color:#999;font-size:0.85rem;">No office notes.</div>')
          + fuHtml
          + '</div>'
        : '')

    // The exact customer copy.
    + '<div class="section-title" style="margin:18px 0 10px;">Customer copy</div>'
    + '<div style="border:1px solid #e0e7ef;border-radius:8px;overflow:hidden;background:#fff;">'
    + buildReceiptEmail(lead, receipt, notes)
    + '</div>';

  res.send(page('Receipt — ' + lead.first_name + ' ' + lead.last_name, body, req));
});

// Branded service receipt. notes is an array of customer-facing advisory strings.
function buildReceiptEmail(lead, r, notes) {
  var advisoryBlock = (notes && notes.length)
    ? '<div style="margin-bottom:24px;">'
      + '<p style="font-weight:700;color:#0a1f3d;margin:0 0 10px;font-size:0.82rem;text-transform:uppercase;letter-spacing:.5px;">Service Advisory</p>'
      + '<ul style="margin:0;padding-left:20px;color:#444;line-height:1.7;font-size:0.9rem;">'
      + notes.map(function(n) { return '<li style="margin-bottom:6px;">' + esc(n) + '</li>'; }).join('')
      + '</ul></div>'
    : '';

  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">'
    + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
    + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;">'
    + '<img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;">'
    + 'Brake Knights</h1>'
    + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service — Northern Virginia</p>'
    + '</div>'
    + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
    + '<h2 style="color:#0a1f3d;margin:0 0 16px;font-size:1.15rem;">Greetings ' + esc(lead.first_name) + ',</h2>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 24px;">Thank you for choosing Brake Knights. Here is your service receipt for today&rsquo;s visit.</p>'

    + '<div style="background:#f4f7fb;border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<p style="font-weight:700;color:#0a1f3d;margin:0 0 10px;font-size:0.82rem;text-transform:uppercase;letter-spacing:.5px;">Service Details</p>'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
    + '<tr><td style="padding:5px 0;color:#888;width:90px;">Date</td><td style="padding:5px 0;">' + esc(fmtPrefDate(r.service_date)) + '</td></tr>'
    + (r.vehicle ? '<tr><td style="padding:5px 0;color:#888;">Vehicle</td><td style="padding:5px 0;">' + esc(r.vehicle) + '</td></tr>' : '')
    + '<tr><td style="padding:5px 0;color:#888;vertical-align:top;">Service</td><td style="padding:5px 0;font-weight:600;">' + esc(joinServices(r.service) || r.service || '—') + '</td></tr>'
    + '</table></div>'

    + '<div style="background:#f4f7fb;border-radius:8px;padding:20px;margin-bottom:24px;">'
    + '<p style="font-weight:700;color:#0a1f3d;margin:0 0 10px;font-size:0.82rem;text-transform:uppercase;letter-spacing:.5px;">Payment</p>'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
    + '<tr><td style="padding:6px 0;">Parts &amp; Labor</td><td style="text-align:right;">$' + money(r.parts_labor) + '</td></tr>'
    + '<tr><td style="padding:6px 0;">Shop Supplies</td><td style="text-align:right;">$' + money(r.shop_supplies) + '</td></tr>'
    + '<tr><td style="padding:6px 0;color:#888;">Tax</td><td style="text-align:right;color:#888;">$' + money(r.tax) + '</td></tr>'
    + '<tr style="border-top:2px solid #dde3ea;"><td style="padding:10px 0 0;font-weight:700;font-size:1rem;color:#0a1f3d;">Total Paid</td>'
    + '<td style="text-align:right;padding:10px 0 0;font-weight:700;font-size:1.1rem;color:#0a1f3d;">$' + money(r.total) + '</td></tr>'
    + (r.payment_method ? '<tr><td style="padding:8px 0 0;color:#888;">Payment</td><td style="text-align:right;padding:8px 0 0;">' + esc(r.payment_method) + '</td></tr>' : '')
    + '</table></div>'

    + advisoryBlock

    + '<p style="color:#444;line-height:1.6;margin:0 0 24px;font-size:0.9rem;">This service is covered by our <strong>12-month parts and labor warranty</strong> on qualifying brake pad and rotor set replacements using our parts.</p>'

    + '<div style="background:#f4f7fb;border:1px solid #e0e7ef;border-radius:8px;padding:22px;text-align:center;margin-bottom:24px;">'
    + '<img src="https://brakeknights.com/images/favicon.png" alt="" style="width:34px;height:34px;border-radius:7px;margin-bottom:10px;">'
    + '<p style="color:#0a1f3d;font-weight:700;margin:0 0 4px;font-size:1rem;">We appreciate your business</p>'
    + '<p style="color:#667;margin:0 0 16px;font-size:0.9rem;">We&rsquo;d love to hear your feedback.</p>'
    + '<a href="https://g.page/r/CdioLrg4kDAqEAI/review" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 30px;border-radius:8px;">Leave a Google Review</a>'
    + '</div>'

    + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
    + '<p style="color:#fff;font-weight:700;margin:0 0 8px;font-size:0.95rem;">Questions about your service? Call or text:</p>'
    + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
    + '</div></div>'
    + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Call/Text 703-977-4475 &middot; brakeknights.com</div>'
    + '</div>';
}

// ─── Phase 6: Follow-up management ────────────────────────────────────────────
// Receipt advisories (and ad-hoc reminders) live in the followups table. The cron
// in server.js fires the email(s) on the due date; these routes let the owner see
// what's scheduled, reschedule, cancel, or dismiss, and add reminders by hand.

var RECIPIENT_LABEL = { owner: 'Owner only', customer: 'Customer only', both: 'Owner + Customer' };

// Human due-date label relative to today, e.g. "Overdue 3 days", "Due today", "in 2 mo".
function dueLabel(due) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((due || '').trim());
  if (!m) return esc(due || '—');
  var today = easternToday().split('-').map(Number);
  var d0 = Date.UTC(today[0], today[1] - 1, today[2]);
  var d1 = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  var days = Math.round((d1 - d0) / 86400000);
  if (days < 0)  return '<span style="color:#c0392b;font-weight:700;">Overdue ' + (-days) + ' day' + (days === -1 ? '' : 's') + '</span>';
  if (days === 0) return '<span style="color:#e07000;font-weight:700;">Due today</span>';
  if (days === 1) return '<span style="color:#666;">Due tomorrow</span>';
  if (days < 31)  return '<span style="color:#888;">in ' + days + ' days</span>';
  var months = Math.round(days / 30);
  return '<span style="color:#888;">in ' + months + ' month' + (months === 1 ? '' : 's') + '</span>';
}

function recipientBadge(r) {
  var label = RECIPIENT_LABEL[r] || r || 'Owner only';
  return '<span style="font-size:0.72rem;background:#eef2f8;color:#4a5b73;padding:2px 8px;border-radius:10px;font-weight:600;">' + esc(label) + '</span>';
}

// Renders one follow-up as a card with reschedule / cancel / dismiss actions.
// `back` is the URL each action returns to. Pending rows get full controls; sent
// rows render read-only with a "Sent" stamp.
function followupCard(f, back) {
  var name = (f.first_name || '') + ' ' + (f.last_name || '');
  var sentStamp = f.sent
    ? '<span style="font-size:0.74rem;color:#1a7a3a;font-weight:700;">&#10003; Sent' + (f.sent_at ? ' ' + timeAgo(f.sent_at) : '') + '</span>'
    : dueLabel(f.due_date);
  var head = '<div class="row-sb" style="align-items:flex-start;">'
    + '<div><a href="/admin/quote/' + f.lead_id + '" style="font-weight:700;color:#0a1f3d;text-decoration:none;font-size:0.95rem;">' + esc(name.trim()) + '</a>'
    + (f.vehicle ? '<span style="color:#888;font-size:0.83rem;"> &middot; ' + esc(f.vehicle) + '</span>' : '') + '</div>'
    + '<div style="text-align:right;font-size:0.8rem;white-space:nowrap;">' + sentStamp + '</div>'
    + '</div>';
  var desc = '<div style="background:#f4f7fb;border-left:3px solid #4169e1;border-radius:5px;padding:9px 12px;margin:9px 0;color:#1a2a3a;font-size:0.88rem;line-height:1.45;">' + esc(f.description) + '</div>';
  var meta = '<div style="display:flex;align-items:center;gap:10px;font-size:0.78rem;color:#aaa;">'
    + recipientBadge(f.recipient)
    + '<span>Due ' + esc(fmtPrefDate(f.due_date)) + '</span>'
    + '</div>';
  if (f.sent) {
    return '<div class="card" style="opacity:.78;">' + head + desc + meta + '</div>';
  }
  var actions = '<div style="display:flex;gap:8px;margin-top:11px;flex-wrap:wrap;align-items:center;">'
    + '<form method="POST" action="/admin/followup/' + f.id + '/reschedule" style="display:flex;gap:6px;margin:0;align-items:center;">'
    + '<input type="hidden" name="back" value="' + esc(back) + '">'
    + '<input type="date" name="due_date" value="' + esc(f.due_date) + '" style="padding:5px 7px;border:1.5px solid #dde3ea;border-radius:6px;font-size:0.8rem;">'
    + '<button type="submit" class="btn btn-outline btn-sm" style="width:auto;">Reschedule</button>'
    + '</form>'
    + '<form method="POST" action="/admin/followup/' + f.id + '/done" style="margin:0;">'
    + '<input type="hidden" name="back" value="' + esc(back) + '">'
    + '<button type="submit" class="btn btn-sm" style="width:auto;background:#1a7a3a;color:#fff;border:none;">&#10003; Mark done</button>'
    + '</form>'
    + '<form method="POST" action="/admin/followup/' + f.id + '/cancel" style="margin:0;" onsubmit="return confirm(\'Cancel this follow-up? It will not be sent.\');">'
    + '<input type="hidden" name="back" value="' + esc(back) + '">'
    + '<button type="submit" style="background:none;border:none;color:#c0392b;font-size:0.8rem;font-weight:600;cursor:pointer;padding:6px 4px;">Cancel</button>'
    + '</form>'
    + '</div>';
  return '<div class="card">' + head + desc + meta + actions + '</div>';
}

router.get('/followups', requireAuth, function(req, res) {
  var rows = db.prepare(
    'SELECT f.*, l.first_name, l.last_name, l.vehicle, l.email AS lead_email '
    + 'FROM followups f JOIN leads l ON l.id = f.lead_id '
    + "ORDER BY f.sent ASC, f.due_date ASC, f.id ASC"
  ).all();

  var today = easternToday();
  var overdue = [], upcoming = [], sent = [];
  rows.forEach(function(f) {
    if (f.sent) sent.push(f);
    else if (f.due_date <= today) overdue.push(f);
    else upcoming.push(f);
  });
  sent = sent.sort(function(a, b) { return (b.sent_at || '').localeCompare(a.sent_at || ''); }).slice(0, 25);

  var back = '/admin/followups';
  var alert = '';
  if (req.query.msg === 'resched')   alert = '<div class="alert alert-success">Follow-up rescheduled.</div>';
  if (req.query.msg === 'done')      alert = '<div class="alert alert-success">Follow-up marked done.</div>';
  if (req.query.msg === 'cancelled') alert = '<div class="alert alert-success">Follow-up cancelled.</div>';
  if (req.query.msg === 'added')     alert = '<div class="alert alert-success">Follow-up added.</div>';

  function section(title, list, emptyNote) {
    var inner = list.length
      ? list.map(function(f) { return followupCard(f, back); }).join('')
      : '<div class="empty" style="padding:18px;color:#aaa;font-size:0.88rem;">' + emptyNote + '</div>';
    return '<div class="section-title" style="margin:18px 0 10px;">' + title
      + (list.length ? ' <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(' + list.length + ')</span>' : '')
      + '</div>' + inner;
  }

  var body = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">'
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;">Follow-ups</h1>'
    + '<span style="color:#aaa;font-size:0.83rem;">' + (overdue.length + upcoming.length) + ' active</span>'
    + '</div>'
    + alert
    + section('Due now', overdue, 'Nothing due. You&rsquo;re all caught up.')
    + section('Upcoming', upcoming, 'No upcoming follow-ups scheduled.')
    + (sent.length ? section('Recently sent', sent, '') : '');

  res.send(page('Follow-ups', body, req));
});

// Add an ad-hoc follow-up to a lead (from the lead/quote page).
router.post('/followup/new', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var leadId = parseInt(req.body.lead_id, 10);
  var lead = leadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) : null;
  var back = req.body.back || (lead ? '/admin/quote/' + leadId : '/admin/followups');
  var desc = (req.body.description || '').trim();
  var due = (req.body.due_date || '').trim();
  var recipient = ['owner', 'customer', 'both'].indexOf(req.body.recipient) >= 0 ? req.body.recipient : 'owner';
  if (lead && desc && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
    db.prepare('INSERT INTO followups (lead_id, receipt_id, description, due_date, recipient) VALUES (?,?,?,?,?)')
      .run(leadId, null, desc, due, recipient);
    logHistory(leadId, 'Follow-up scheduled', fmtPrefDate(due) + ' · ' + (RECIPIENT_LABEL[recipient] || recipient));
  }
  res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'msg=added');
});

router.post('/followup/:id/reschedule', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var due = (req.body.due_date || '').trim();
  var back = req.body.back || '/admin/followups';
  var f = db.prepare('SELECT * FROM followups WHERE id = ?').get(req.params.id);
  if (f && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
    db.prepare('UPDATE followups SET due_date = ?, sent = 0, sent_at = NULL WHERE id = ?').run(due, req.params.id);
    logHistory(f.lead_id, 'Follow-up rescheduled', f.description + ' · now due ' + fmtPrefDate(due));
  }
  res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'msg=resched');
});

// Dismiss without emailing: flag it sent so the cron skips it.
router.post('/followup/:id/done', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var back = req.body.back || '/admin/followups';
  var f = db.prepare('SELECT * FROM followups WHERE id = ?').get(req.params.id);
  db.prepare("UPDATE followups SET sent = 1, sent_at = datetime('now') WHERE id = ?").run(req.params.id);
  if (f) logHistory(f.lead_id, 'Follow-up marked done', f.description);
  res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'msg=done');
});

router.post('/followup/:id/cancel', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var back = req.body.back || '/admin/followups';
  var f = db.prepare('SELECT * FROM followups WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM followups WHERE id = ?').run(req.params.id);
  if (f) logHistory(f.lead_id, 'Follow-up cancelled', f.description);
  res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'msg=cancelled');
});

// ─── Phase 7A: Quick Quote / Receipt Generator ───────────────────────────────
// A standalone generator, not bound to any lead, for fast phone/text inquiries.
// Reuses the pricing engine, the service multi-select + tier toggle, live
// auto-calc, and the branded buildQuoteEmail / buildReceiptEmail templates.
//
// Three quote outcomes: (1) calculator only (Clear, nothing saved); (2) Send —
// create a "Quick Quote" lead in the Quoted stage, save the quote, email the
// branded quote with its accept link; (3) Copyable link — create the lead +
// quote + token and hand back the customer-facing quote URL to paste into a
// text. Receipt mode mirrors the receipt builder (send or save as a lead).

router.get('/quick', requireAuth, function(req, res) {
  var serviceNames = Object.keys(PRICING.services);
  var pricingJson = JSON.stringify(PRICING.services);
  var taxPct = +(PRICING.taxRate * 100).toFixed(2);

  var serviceCheckboxes = '<div class="svc-check-list">'
    + serviceNames.map(function(s) {
        return '<label class="svc-check-item"><input type="checkbox" class="qsvc-cb" value="' + esc(s) + '" onchange="qUpdateServices()"><span class="svc-box"></span>' + esc(s) + '</label>';
      }).join('')
    + '</div>'
    + '<input type="hidden" name="service" id="qsvcHidden" value="">';

  var paymentOpts = PAYMENT_METHODS.map(function(p) {
    return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
  }).join('');

  var advisoryRows = advisoryRow(1, false);
  for (var i = 2; i <= 4; i++) advisoryRows += advisoryRow(i, true);
  advisoryRows += '<button type="button" id="qqAddAdvBtn" class="svc-clear-btn" style="margin-top:6px;" onclick="qqAddAdvisory()">+ Add Advisory</button>';

  var alert = '';
  if (req.query.err === 'name')  alert = '<div class="alert alert-error">First and last name are required to save or send.</div>';
  if (req.query.err === 'email') alert = '<div class="alert alert-error">An email address is required to send a quote or receipt. Use the copyable link instead, or add an email.</div>';

  var body = '<a href="/admin" class="back-link">&#8592; All Leads</a>'
    + alert
    + '<div class="card">'
    + '<div class="lead-name" style="margin-bottom:4px;">Quick Quote / Receipt</div>'
    + '<div style="color:#888;font-size:0.85rem;">A standalone generator for phone and text inquiries. Pick services, read the live total off to the customer, then send, save, or grab a copyable link.</div>'
    + '</div>'

    + '<form method="POST" action="/admin/quick" id="qqf">'
    + '<input type="hidden" name="mode" id="qmode" value="quote">'
    + '<input type="hidden" name="action" id="qaction" value="">'

    // Mode switch
    + '<div class="card">'
    + '<div class="form-group" style="margin-bottom:0;"><label>Mode</label>'
    + '<div class="tier-toggle">'
    + '<button type="button" class="tier-btn active" id="qModeQuote" onclick="qSetMode(\'quote\')">Quote</button>'
    + '<button type="button" class="tier-btn" id="qModeReceipt" onclick="qSetMode(\'receipt\')">Receipt</button>'
    + '</div></div>'
    + '</div>'

    // Customer (optional for calculator-only; required to save/send)
    + '<div class="card">'
    + '<div class="section-title">Customer <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(needed to save or send, not for calculator-only)</span></div>'
    + '<div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>First name</label><input type="text" name="firstName" id="qfn"></div>'
    + '<div class="form-group"><label>Last name</label><input type="text" name="lastName" id="qln"></div>'
    + '</div>'
    + '<div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Email <span id="qemHint" style="color:#bbb;font-weight:400;">(to send)</span></label><input type="email" name="email" id="qem" placeholder="customer@email.com"></div>'
    + '<div class="form-group"><label>Phone <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="tel" name="phone" id="qph" placeholder="703-555-0123"></div>'
    + '</div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Vehicle <span style="color:#bbb;font-weight:400;">(year make model, optional)</span></label>'
    + '<input type="text" name="vehicle" id="qveh" placeholder="e.g. 2018 Honda Accord"></div>'
    + '</div>'

    // Services + tier
    + '<div class="card">'
    + '<div class="section-title">Service <span style="font-size:0.8rem;color:#bbb;font-weight:400;">(select all that apply)</span></div>'
    + serviceCheckboxes
    + '<button type="button" class="svc-clear-btn" onclick="qClearServices()">&#10005; Clear selection</button>'
    + '<div class="svc-tags" id="qsvcTags"></div>'
    + '<div id="qCustomHint" style="display:none;background:#fff8e1;border:1px solid #f0d080;border-radius:8px;padding:10px 12px;margin-top:10px;font-size:0.83rem;color:#7a5a00;"></div>'
    + '<div class="form-group" style="margin:14px 0 0;"><label>Tier</label>'
    + '<div class="tier-toggle">'
    + '<button type="button" class="tier-btn active" id="qBtnStd" onclick="qSetTier(\'standard\')">Standard</button>'
    + '<button type="button" class="tier-btn" id="qBtnPrem" onclick="qSetTier(\'premium\')">Premium</button>'
    + '</div>'
    + '<input type="hidden" name="tier" id="qtier" value="standard"></div>'
    + '</div>'

    // Receipt-only date / payment / address
    + '<div class="card qReceiptOnly" style="display:none;">'
    + '<div class="section-title">Job Details</div>'
    + '<div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Date of service</label><input type="date" name="serviceDate" value="' + esc(easternToday()) + '"></div>'
    + '<div class="form-group"><label>Payment method</label>'
    + '<select name="paymentMethod" id="qpm" onchange="qPayToggle()">' + paymentOpts + '</select></div>'
    + '</div>'
    + '<div class="form-group" id="qpmOtherWrap" style="display:none;"><label>Specify payment method</label>'
    + '<input type="text" name="paymentOther" id="qpmOther" placeholder="e.g. Zelle, Venmo, Check"></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Service address</label>'
    + '<input type="text" name="serviceAddress" placeholder="Where the work was performed"></div>'
    + '</div>'

    // Price breakdown (internal) — shared by both modes
    + '<div class="card">'
    + '<div class="price-section">'
    + '<div class="price-section-header">Internal Breakdown <span style="font-weight:400;text-transform:none;letter-spacing:0;">(not sent to customer)</span></div>'
    + '<div class="price-row"><span class="price-label">Parts</span>'
    + '<input class="price-input" type="number" name="parts" id="qparts" min="0" step="0.01" value="0.00" oninput="qcalc()"></div>'
    + '<div class="price-row"><span class="price-label">Labor <span class="price-note">(not taxed)</span></span>'
    + '<input class="price-input" type="number" name="labor" id="qlabor" min="0" step="0.01" value="0.00" oninput="qcalc()"></div>'
    + '<div class="price-row"><span class="price-label">Shop Supplies</span>'
    + '<input class="price-input" type="number" name="shopSupplies" id="qss" min="0" step="0.01" value="0.00" oninput="qcalc()"></div>'
    + '<div class="price-row tax-row"><span class="price-label" style="display:flex;align-items:center;gap:5px;">VA Tax (<input class="tax-rate-input" type="number" name="taxRate" id="qtr" min="0" max="20" step="0.1" value="' + fmt(taxPct) + '" oninput="qcalc()">%) on Parts + Supplies</span>'
    + '<span id="qtaxAmt">$0.00</span></div>'
    + '</div>'

    // Customer-facing total
    + '<div class="price-section" style="margin-bottom:0;">'
    + '<div class="price-section-header"><span id="qSummaryLabel">Customer Quote</span></div>'
    + '<div class="price-row"><span class="price-label">Parts &amp; Labor</span><span id="qplDisplay">$0.00</span></div>'
    + '<div class="price-row"><span class="price-label">Shop Supplies</span><span id="qssDisplay">$0.00</span></div>'
    + '<div class="price-row tax-row"><span class="price-label">Tax</span><span id="qtaxDisplay">$0.00</span></div>'
    + '<div class="price-row total-row divider-row"><span id="qTotalLabel">Total</span><span id="qtotalAmt" style="font-size:1.15rem;">$0.00</span></div>'
    + '</div>'
    + '<input type="hidden" name="taxAmt"   id="qtaxH"   value="0.00">'
    + '<input type="hidden" name="totalAmt" id="qtotalH" value="0.00">'
    + '</div>'

    // Receipt-only advisories + office notes
    + '<div class="card qReceiptOnly" style="display:none;">'
    + '<div class="section-title">Notes to Customer <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(each appears on the receipt)</span></div>'
    + advisoryRows
    + '</div>'
    + '<div class="card qReceiptOnly" style="display:none;">'
    + '<div class="form-group" style="margin-bottom:0;"><label>Notes to Office <span style="color:#bbb;font-weight:400;">(internal only, never sent)</span></label>'
    + '<textarea name="officeNotes" placeholder="Torque specs, parts used, condition observations, anything for the record…"></textarea></div>'
    + '</div>'

    // Action buttons
    + '<div class="card">'
    + '<div class="qQuoteActions">'
    + '<button type="button" class="btn btn-blue" onclick="qSubmit(\'quote_send\')">Send Quote to Customer</button>'
    + '<button type="button" class="btn btn-navy" style="margin-top:8px;" onclick="qSubmit(\'quote_link\')">Get Copyable Quote Link</button>'
    + '<button type="button" class="btn" style="margin-top:8px;background:#e0e0e0;border:1.5px solid #b4b4b4;color:#444;" onclick="qSubmit(\'quote_save\')">Save as New Lead (no email)</button>'
    + '</div>'
    + '<div class="qReceiptActions" style="display:none;">'
    + '<button type="button" class="btn btn-blue" onclick="qSubmit(\'receipt_send\')">&#10003; Send Receipt to Customer</button>'
    + '</div>'
    + '<button type="button" id="qPreviewBtn" class="btn btn-outline" style="margin-top:8px;" onclick="qPreview()">Preview Email</button>'
    + '<div id="qPreviewBox" style="display:none;margin-top:8px;"></div>'
    + '<button type="button" class="svc-clear-btn" style="margin-top:12px;width:100%;padding:10px;" onclick="if(confirm(\'Clear the form and start over? Nothing will be saved.\'))qClearAll()">&#10005; Clear &amp; Start Over</button>'
    + '</div>'
    + '</form>'

    + '<script>'
    + 'var QPRICING=' + pricingJson + ';'
    + 'var qtier="standard";var qmode="quote";'

    + 'function qCheckedServices(){return Array.from(document.querySelectorAll(".qsvc-cb:checked")).map(function(c){return c.value;});}'
    + 'function money(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'

    + 'function qSetMode(m){'
    +   'qmode=m;document.getElementById("qmode").value=m;'
    +   'document.getElementById("qModeQuote").classList.toggle("active",m==="quote");'
    +   'document.getElementById("qModeReceipt").classList.toggle("active",m==="receipt");'
    +   'var rec=m==="receipt";'
    +   'document.querySelectorAll(".qReceiptOnly").forEach(function(el){el.style.display=rec?"block":"none";});'
    +   'document.querySelector(".qQuoteActions").style.display=rec?"none":"block";'
    +   'document.querySelector(".qReceiptActions").style.display=rec?"block":"none";'
    +   'document.getElementById("qSummaryLabel").textContent=rec?"Customer Receipt":"Customer Quote";'
    +   'document.getElementById("qTotalLabel").textContent=rec?"Total Paid":"Total";'
    +   'document.getElementById("qemHint").textContent=rec?"(to send receipt)":"(to send)";'
    +   'qSaveState();'
    + '}'

    + 'function qSetTier(t){'
    +   'qtier=t;document.getElementById("qtier").value=t;'
    +   'document.getElementById("qBtnStd").classList.toggle("active",t==="standard");'
    +   'document.getElementById("qBtnPrem").classList.toggle("active",t==="premium");'
    +   'qAutofill();'
    +   'qSaveState();'
    + '}'

    + 'function qRenderTags(){'
    +   'document.getElementById("qsvcTags").innerHTML=qCheckedServices().map(function(n){'
    +     'return "<span class=\'svc-tag\'><button type=\'button\' class=\'svc-tag-x\' onclick=\'qRemoveTag(this)\' data-val=\'"+n+"\'>&#10005;</button>"+n+"</span>";'
    +   '}).join("");'
    + '}'
    + 'function qRemoveTag(btn){'
    +   'var val=btn.getAttribute("data-val");'
    +   'var cb=Array.from(document.querySelectorAll(".qsvc-cb")).find(function(c){return c.value===val;});'
    +   'if(cb)cb.checked=false;qUpdateServices();'
    + '}'
    + 'function qClearServices(){'
    +   'document.querySelectorAll(".qsvc-cb").forEach(function(cb){cb.checked=false;});qUpdateServices();'
    + '}'

    // Auto-fill the price fields from the pricing table for the checked services + tier.
    + 'function qAutofill(){'
    +   'var names=qCheckedServices();'
    +   'document.getElementById("qsvcHidden").value=names.join(", ");'
    +   'if(names.length===0){'
    +     'document.getElementById("qparts").value="0.00";document.getElementById("qlabor").value="0.00";document.getElementById("qss").value="0.00";qcalc();return;'
    +   '}'
    +   'var parts=0,labor=0,ss=0;'
    +   'names.forEach(function(s){var sv=QPRICING[s];if(!sv)return;var p=sv[qtier]||sv.standard;if(!p)return;parts+=p.parts;labor+=p.labor;ss+=p.shopSupplies;});'
    +   'document.getElementById("qparts").value=parts.toFixed(2);'
    +   'document.getElementById("qlabor").value=labor.toFixed(2);'
    +   'document.getElementById("qss").value=ss.toFixed(2);'
    +   'qcalc();'
    + '}'
    + 'function qUpdateServices(){qRenderTags();qHints();qAutofill();}'

    + 'function qHints(){'
    +   'var names=qCheckedServices();var msgs=[];'
    +   'var custom=names.filter(function(n){return QPRICING[n]&&QPRICING[n].customQuote;});'
    +   'if(custom.length){msgs.push("<strong>Custom quote:</strong> "+custom.join(", ")+" "+(custom.length>1?"have":"has")+" no preset price. Look up the exact part(s) and enter Parts and Labor manually.");}'
    +   'names.forEach(function(n){if(QPRICING[n]&&QPRICING[n].note){msgs.push(QPRICING[n].note);}});'
    +   'var box=document.getElementById("qCustomHint");'
    +   'if(msgs.length){box.innerHTML=msgs.join("<br><br>");box.style.display="block";}else{box.style.display="none";}'
    + '}'

    // Tax is on parts + shop supplies only (not labor — Virginia law).
    + 'function qcalc(){'
    +   'var parts=parseFloat(document.getElementById("qparts").value)||0;'
    +   'var labor=parseFloat(document.getElementById("qlabor").value)||0;'
    +   'var ss=parseFloat(document.getElementById("qss").value)||0;'
    +   'var tr=parseFloat(document.getElementById("qtr").value)||0;'
    +   'var tax=(parts+ss)*tr/100;var total=parts+labor+ss+tax;'
    +   'document.getElementById("qtaxAmt").textContent="$"+money(tax);'
    +   'document.getElementById("qplDisplay").textContent="$"+money(parts+labor);'
    +   'document.getElementById("qssDisplay").textContent="$"+money(ss);'
    +   'document.getElementById("qtaxDisplay").textContent="$"+money(tax);'
    +   'document.getElementById("qtotalAmt").textContent="$"+money(total);'
    +   'document.getElementById("qtaxH").value=tax.toFixed(2);'
    +   'document.getElementById("qtotalH").value=total.toFixed(2);'
    + '}'

    + 'function qPayToggle(){'
    +   'var v=document.getElementById("qpm").value;var show=(v==="Other");'
    +   'document.getElementById("qpmOtherWrap").style.display=show?"block":"none";'
    +   'document.getElementById("qpmOther").required=show;'
    + '}'

    + 'function qqAddAdvisory(){'
    +   'for(var i=2;i<=4;i++){'
    +     'var r=document.getElementById("advRow"+i);'
    +     'if(r&&r.style.display==="none"){r.style.display="";'
    +       'if(i===4){var b=document.getElementById("qqAddAdvBtn");if(b)b.style.display="none";}'
    +       'return;}'
    +   '}'
    + '}'

    + 'function qPreview(){'
    +   'var box=document.getElementById("qPreviewBox");'
    +   'var btn=document.getElementById("qPreviewBtn");'
    +   'if(box.style.display!=="none"&&box.innerHTML){box.style.display="none";box.innerHTML="";btn.textContent="Preview Email";return;}'
    +   'var fn=document.getElementById("qfn").value.trim();'
    +   'var ln=document.getElementById("qln").value.trim();'
    +   'var em=document.getElementById("qem").value.trim();'
    +   'var svcs=qCheckedServices();'
    +   'var total=document.getElementById("qtotalAmt").textContent;'
    +   'var rec=qmode==="receipt";'
    +   'var toLine=(fn||ln?(fn+" "+ln).trim()+" ":"")+(em?"&lt;"+em+"&gt;":"<em style=\'color:#e07000\'>(no email entered)</em>");'
    +   'var rows="<table style=\'width:100%;border-collapse:collapse;font-size:0.88rem;\'>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;white-space:nowrap;vertical-align:top;\'>To</td><td style=\'padding:5px 0;\'>"+toLine+"</td></tr>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Subject</td><td style=\'padding:5px 0;\'>"+(rec?"Your Brake Knights Service Receipt":"Your Brake Service Quote — Brake Knights")+"</td></tr>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;vertical-align:top;\'>Services</td><td style=\'padding:5px 0;\'>"+(svcs.length?svcs.join(", "):"<em style=\'color:#e07000\'>(none selected)</em>")+"</td></tr>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+(rec?"Total Paid":"Total")+"</td><td style=\'padding:5px 0;font-weight:700;\'>"+total+"</td></tr>";'
    +   'if(rec){'
    +     'var pm=(document.getElementById("qpm")||{}).value||"";'
    +     'var pmo=(document.getElementById("qpmOther")||{}).value||"";'
    +     'var svcDate=(document.querySelector("[name=serviceDate]")||{}).value||"";'
    +     'var svcAddr=(document.querySelector("[name=serviceAddress]")||{}).value||"";'
    +     'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Payment</td><td style=\'padding:5px 0;\'>"+(pm==="Other"?pmo||"Other":pm)+"</td></tr>";'
    +     'if(svcDate)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Date</td><td style=\'padding:5px 0;\'>"+svcDate+"</td></tr>";'
    +     'if(svcAddr)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Address</td><td style=\'padding:5px 0;\'>"+svcAddr+"</td></tr>";'
    +     'var advs=[];for(var ai=1;ai<=4;ai++){var nt=(document.querySelector("[name=custNote"+ai+"]")||{}).value||"";if(nt)advs.push(nt);}'
    +     'if(advs.length)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;vertical-align:top;\'>Advisories</td><td style=\'padding:5px 0;\'><ul style=\'margin:0;padding-left:18px;\'>"+advs.map(function(a){return"<li>"+a+"</li>";}).join("")+"</ul></td></tr>";'
    +   '}'
    +   'rows+="</table>";'
    +   'box.innerHTML="<div class=\'preview-box\'><h4>"+(rec?"Receipt":"Quote")+" Email Preview</h4>"+rows+"</div>";'
    +   'box.style.display="block";btn.textContent="Hide Preview";'
    + '}'

    + 'function qClearAll(){'
    +   'qClearServices();'
    +   'document.getElementById("qfn").value="";document.getElementById("qln").value="";'
    +   'document.getElementById("qem").value="";document.getElementById("qph").value="";'
    +   'var veh=document.getElementById("qveh");if(veh)veh.value="";'
    +   'document.getElementById("qparts").value="0.00";document.getElementById("qlabor").value="0.00";document.getElementById("qss").value="0.00";'
    +   'var svcAddr=document.querySelector("[name=serviceAddress]");if(svcAddr)svcAddr.value="";'
    +   'var offN=document.querySelector("[name=officeNotes]");if(offN)offN.value="";'
    +   '[1,2,3,4].forEach(function(i){'
    +     'var n=document.querySelector("[name=custNote"+i+"]");if(n)n.value="";'
    +     'var r=document.querySelector("[name=fuRecipient"+i+"]");if(r)r.value="owner";'
    +     'var c=document.querySelector("[name=fuCustom"+i+"]");if(c)c.value="";'
    +     'if(i>1){var row=document.getElementById("advRow"+i);if(row)row.style.display="none";}'
    +   '});'
    +   'var addBtn=document.getElementById("qqAddAdvBtn");if(addBtn)addBtn.style.display="";'
    +   'var pb=document.getElementById("qPreviewBox");if(pb){pb.style.display="none";pb.innerHTML="";}'
    +   'var pbt=document.getElementById("qPreviewBtn");if(pbt)pbt.textContent="Preview Email";'
    +   'qSetMode("quote");qSetTier("standard");qcalc();'
    +   'try{localStorage.removeItem("bk_qq_state");}catch(_){}'
    + '}'

    // Auto-save form state to localStorage so navigating away and back preserves work.
    + 'function qSaveState(){'
    +   'try{'
    +     'var adv=[1,2,3,4].map(function(i){'
    +       'return {'
    +         'note:(document.querySelector("[name=custNote"+i+"]")||{}).value||"",'
    +         'recv:(document.querySelector("[name=fuRecipient"+i+"]")||{}).value||"owner",'
    +         'cust:(document.querySelector("[name=fuCustom"+i+"]")||{}).value||""'
    +       '};'
    +     '});'
    +     'localStorage.setItem("bk_qq_state",JSON.stringify({'
    +       'mode:qmode,tier:qtier,'
    +       'fn:document.getElementById("qfn").value,'
    +       'ln:document.getElementById("qln").value,'
    +       'em:document.getElementById("qem").value,'
    +       'ph:document.getElementById("qph").value,'
    +       'veh:(document.getElementById("qveh")||{}).value||"",'
    +       'svcs:qCheckedServices(),'
    +       'parts:document.getElementById("qparts").value,'
    +       'labor:document.getElementById("qlabor").value,'
    +       'ss:document.getElementById("qss").value,'
    +       'tr:document.getElementById("qtr").value,'
    +       'payMethod:(document.getElementById("qpm")||{}).value||"",'
    +       'payOther:(document.getElementById("qpmOther")||{}).value||"",'
    +       'svcDate:(document.querySelector("[name=serviceDate]")||{}).value||"",'
    +       'svcAddr:(document.querySelector("[name=serviceAddress]")||{}).value||"",'
    +       'offNotes:(document.querySelector("[name=officeNotes]")||{}).value||"",'
    +       'adv:adv'
    +     '}));'
    +   '}catch(_){}'
    + '}'
    + 'function qRestoreState(){'
    +   'try{'
    +     'var raw=localStorage.getItem("bk_qq_state");if(!raw)return;'
    +     'var s=JSON.parse(raw);if(!s)return;'
    +     'if(s.mode)qSetMode(s.mode);'
    +     'if(s.tier)qSetTier(s.tier);'
    +     'if(s.fn)document.getElementById("qfn").value=s.fn;'
    +     'if(s.ln)document.getElementById("qln").value=s.ln;'
    +     'if(s.em)document.getElementById("qem").value=s.em;'
    +     'if(s.ph)document.getElementById("qph").value=s.ph;'
    +     'if(s.veh&&document.getElementById("qveh"))document.getElementById("qveh").value=s.veh;'
    +     'if(s.svcs&&s.svcs.length)document.querySelectorAll(".qsvc-cb").forEach(function(cb){cb.checked=s.svcs.indexOf(cb.value)>=0;});'
    +     'if(s.parts!==undefined)document.getElementById("qparts").value=s.parts;'
    +     'if(s.labor!==undefined)document.getElementById("qlabor").value=s.labor;'
    +     'if(s.ss!==undefined)document.getElementById("qss").value=s.ss;'
    +     'if(s.tr!==undefined)document.getElementById("qtr").value=s.tr;'
    +     'if(s.payMethod&&document.getElementById("qpm"))document.getElementById("qpm").value=s.payMethod;'
    +     'if(s.payOther&&document.getElementById("qpmOther"))document.getElementById("qpmOther").value=s.payOther;'
    +     'var sa=document.querySelector("[name=serviceAddress]");if(s.svcAddr&&sa)sa.value=s.svcAddr;'
    +     'var sd=document.querySelector("[name=serviceDate]");if(s.svcDate&&sd)sd.value=s.svcDate;'
    +     'var on=document.querySelector("[name=officeNotes]");if(s.offNotes&&on)on.value=s.offNotes;'
    +     'if(s.adv)s.adv.forEach(function(a,idx){'
    +       'var i=idx+1;'
    +       'var n=document.querySelector("[name=custNote"+i+"]");if(n&&a.note)n.value=a.note;'
    +       'var r=document.querySelector("[name=fuRecipient"+i+"]");if(r&&a.recv)r.value=a.recv;'
    +       'var c=document.querySelector("[name=fuCustom"+i+"]");if(c&&a.cust)c.value=a.cust;'
    +       'if(i>1&&(a.note||a.cust)){var row=document.getElementById("advRow"+i);if(row)row.style.display="";}'
    +     '});'
    +     'var allVis=[2,3,4].every(function(i){var r=document.getElementById("advRow"+i);return !r||r.style.display!=="none";});'
    +     'if(allVis){var ab=document.getElementById("qqAddAdvBtn");if(ab)ab.style.display="none";}'
    +     'qUpdateServices();qPayToggle();qcalc();'
    +   '}catch(_){}'
    + '}'

    + 'function qSubmit(action){'
    +   'var fn=document.getElementById("qfn").value.trim();'
    +   'var ln=document.getElementById("qln").value.trim();'
    +   'var em=document.getElementById("qem").value.trim();'
    +   'if(!fn||!ln){alert("Enter the customer first and last name to save or send.");return;}'
    +   'if((action==="quote_send"||action==="receipt_send")&&!em){alert("Enter an email to send. For texting, use Get Copyable Quote Link instead.");return;}'
    +   'try{localStorage.removeItem("bk_qq_state");}catch(_){}'
    +   'document.getElementById("qaction").value=action;'
    +   'document.getElementById("qqf").submit();'
    + '}'

    // Wire up auto-save and restore on page load.
    + 'var _qqSaveTimer;'
    + 'document.getElementById("qqf").addEventListener("input",function(){clearTimeout(_qqSaveTimer);_qqSaveTimer=setTimeout(qSaveState,400);});'
    + 'document.getElementById("qqf").addEventListener("change",function(){clearTimeout(_qqSaveTimer);_qqSaveTimer=setTimeout(qSaveState,400);});'
    + 'qRenderTags();qPayToggle();'
    + 'qRestoreState();'
    + 'qcalc();'
    + '</script>';

  res.send(page('Quick Quote', body, req));
});

// Result page for the copyable-link outcome: shows the branded customer URL in a
// read-only field with a one-tap copy button, plus a link to the new lead.
function quickLinkResult(req, lead, acceptUrl) {
  var body = '<a href="/admin/quick" class="back-link">&#8592; New Quick Quote</a>'
    + '<div class="card">'
    + '<div class="section-title" style="color:#1a7a3a;">&#10003; Quote link ready</div>'
    + '<p style="color:#555;font-size:0.9rem;margin-bottom:12px;">A lead for <strong>' + esc(lead.first_name) + ' ' + esc(lead.last_name) + '</strong> was created in the Quoted stage and the quote was saved. Copy the link below and paste it into your text to the customer. They can review the quote and pick a time.</p>'
    + '<div class="form-group" style="margin-bottom:10px;"><label>Customer quote link</label>'
    + '<input type="text" id="qlink" readonly value="' + esc(acceptUrl) + '" onclick="this.select()" style="font-size:0.85rem;"></div>'
    + '<button type="button" class="btn btn-blue" onclick="qCopy()" id="qCopyBtn">Copy Link</button>'
    + '<a href="/admin/quote/' + lead.id + '" class="btn btn-outline" style="margin-top:8px;">Open the Lead</a>'
    + '</div>'
    + '<script>'
    + 'function qCopy(){var el=document.getElementById("qlink");el.select();el.setSelectionRange(0,99999);'
    + 'function done(){var b=document.getElementById("qCopyBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy Link";},1800);}'
    + 'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(el.value).then(done,function(){document.execCommand("copy");done();});}'
    + 'else{document.execCommand("copy");done();}}'
    + '</script>';
  return page('Quote Link', body, req);
}

router.post('/quick', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var mode   = req.body.mode === 'receipt' ? 'receipt' : 'quote';
  var action = req.body.action || '';

  var firstName = (req.body.firstName || '').trim();
  var lastName  = (req.body.lastName  || '').trim();
  var email     = (req.body.email     || '').trim() || null;
  var phone     = (req.body.phone     || '').trim();
  var vehicle   = (req.body.vehicle   || '').trim() || null;
  if (!firstName || !lastName) return res.redirect('/admin/quick?err=name');

  var isSend = (action === 'quote_send' || action === 'receipt_send');
  if (isSend && !email) return res.redirect('/admin/quick?err=email');

  var service      = (req.body.service || '').trim();
  var tier         = req.body.tier === 'premium' ? 'premium' : 'standard';
  var parts        = parseFloat(req.body.parts)        || 0;
  var labor        = parseFloat(req.body.labor)        || 0;
  var shopSupplies = parseFloat(req.body.shopSupplies) || 0;
  var taxRate      = parseFloat(req.body.taxRate)      || 0;
  var taxAmt       = parseFloat(req.body.taxAmt)       || 0;
  var totalAmt     = parseFloat(req.body.totalAmt)     || 0;

  var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');

  // Every save/send outcome creates a Quick Quote lead. Quote mode lands it in
  // Quoted; receipt mode reflects a finished job (set further down).
  var leadInfo = db.prepare(
    'INSERT INTO leads (first_name, last_name, phone, email, vehicle, service, source, status) VALUES (?,?,?,?,?,?,?,?)'
  ).run(firstName, lastName, phone, email, vehicle, service || null, 'Quick Quote', mode === 'receipt' ? 'completed' : 'quoted');
  var leadId = leadInfo.lastInsertRowid;
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  logHistory(leadId, 'Lead created from Quick Quote', (mode === 'receipt' ? 'Receipt' : 'Quote') + (service ? ' — ' + service : ''));

  // ── Quote mode ──────────────────────────────────────────────────────────────
  if (mode === 'quote') {
    var acceptToken = crypto.randomBytes(24).toString('hex');
    var qStatus = action === 'quote_save' ? 'saved' : 'sent';
    var qInfo = db.prepare(
      'INSERT INTO quotes (lead_id, service, tier, price_parts, price_labor, shop_supplies, tax_rate, tax, total, accept_token, sent_at, status) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(leadId, service, tier, parts, labor, shopSupplies, taxRate / 100, taxAmt, totalAmt, acceptToken,
          null, qStatus);
    var quoteId = qInfo.lastInsertRowid;
    var acceptUrl = baseUrl + '/quote/' + quoteId + '/' + acceptToken;
    logHistory(leadId, action === 'quote_save' ? 'Quote saved' : 'Quote sent', service + ' (' + tier + ') — $' + totalAmt.toFixed(2));

    if (action === 'quote_save') return res.redirect('/admin/quote/' + leadId + '?msg=quick_saved');
    if (action === 'quote_link') {
      db.prepare("UPDATE quotes SET sent_at = datetime('now') WHERE id = ?").run(quoteId);
      return res.send(quickLinkResult(req, lead, acceptUrl));
    }
    // quote_send — email the branded quote
    if (!process.env.SMTP_PASS) {
      console.error('SMTP_PASS not set — Quick Quote saved but not emailed');
      return res.redirect('/admin/quote/' + leadId + '?msg=quick_err');
    }
    try {
      var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      await tx.sendMail({
        from:    '"Brake Knights" <greetings@brakeknights.com>',
        to:      email,
        replyTo: 'greetings@brakeknights.com',
        subject: 'Your Brake Service Quote — Brake Knights',
        html:    buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, taxAmt, totalAmt, acceptUrl, req.body.lineItems || 'combined')
      });
      db.prepare("UPDATE quotes SET sent_at = datetime('now') WHERE id = ?").run(quoteId);
      return res.redirect('/admin/quote/' + leadId + '?msg=quick_sent');
    } catch (err) {
      console.error('Quick Quote email error:', err.message);
      return res.redirect('/admin/quote/' + leadId + '?msg=quick_err');
    }
  }

  // ── Receipt mode ────────────────────────────────────────────────────────────
  var serviceDate = (req.body.serviceDate || '').trim() || easternToday();
  var address     = (req.body.serviceAddress || '').trim();
  var payment     = (req.body.paymentMethod || '').trim();
  if (payment === 'Other') payment = (req.body.paymentOther || '').trim() || 'Other';
  var officeNotes = (req.body.officeNotes || '').trim() || null;
  var partsLabor  = parts + labor;

  // Customer advisories + any timed follow-ups attached to them.
  var notes = [];
  var followups = [];
  for (var i = 1; i <= 4; i++) {
    var txt = (req.body['custNote' + i] || '').trim();
    if (txt) notes.push(txt);
    var due = (req.body['fuCustom' + i] || '').trim();
    if (due && txt) {
      followups.push({ description: txt, due_date: due, recipient: req.body['fuRecipient' + i] || 'owner' });
    }
  }

  var rInfo = db.prepare(
    'INSERT INTO receipts (lead_id, service, vehicle, service_date, service_address, parts_labor, shop_supplies, tax, total, payment_method, customer_notes, office_notes) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(leadId, service, vehicle, serviceDate, address, partsLabor, shopSupplies, taxAmt, totalAmt, payment, JSON.stringify(notes), officeNotes);
  var receiptId = rInfo.lastInsertRowid;

  followups.forEach(function(f) {
    db.prepare('INSERT INTO followups (lead_id, receipt_id, description, due_date, recipient) VALUES (?,?,?,?,?)')
      .run(leadId, receiptId, f.description, f.due_date, f.recipient);
  });

  var receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(receiptId);
  var receiptDetail = '$' + totalAmt.toFixed(2) + (payment ? ' · ' + payment : '') + (followups.length ? ' · ' + followups.length + ' reminder' + (followups.length > 1 ? 's' : '') + ' set' : '');

  if (action === 'receipt_send' && process.env.SMTP_PASS && email) {
    try {
      var rtx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      await rtx.sendMail({
        from:    '"Brake Knights" <greetings@brakeknights.com>',
        to:      email,
        replyTo: 'greetings@brakeknights.com',
        subject: 'Your Brake Knights Service Receipt',
        html:    buildReceiptEmail(lead, receipt, notes)
      });
      db.prepare("UPDATE receipts SET sent_at = datetime('now') WHERE id = ?").run(receiptId);
      db.prepare("UPDATE leads SET status = 'receipt', status_updated_at = datetime('now') WHERE id = ?").run(leadId);
      logHistory(leadId, 'Receipt sent to customer', receiptDetail);
      return res.redirect('/admin/quote/' + leadId + '?msg=receipt_sent');
    } catch (err) {
      console.error('Quick receipt email error:', err.message);
      logHistory(leadId, 'Receipt saved (email failed)', receiptDetail);
      return res.redirect('/admin/quote/' + leadId + '?msg=receipt_err');
    }
  }
  logHistory(leadId, 'Receipt saved (not emailed)', receiptDetail);
  res.redirect('/admin/quote/' + leadId + '?msg=receipt_saved');
});

module.exports = router;
