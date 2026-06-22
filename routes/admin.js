const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const db = require('../db');
const customers = require('../customers');
const { sendStagePush } = require('../push');
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

// Display a phone number with dashes: 7039774475 -> 703-977-4475 (and a leading
// 1 country code as 1-703-977-4475). Non-standard lengths are returned as-is.
function fmtPhone(p) {
  if (!p) return '';
  var d = String(p).replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') return '1-' + d.slice(1, 4) + '-' + d.slice(4, 7) + '-' + d.slice(7);
  if (d.length === 10) return d.slice(0, 3) + '-' + d.slice(3, 6) + '-' + d.slice(6);
  return String(p).trim();
}

// Returns a clickable Google Maps anchor for an address string, or plain escaped
// text if addr is falsy. Used wherever addresses appear in the admin UI.
function mapsLink(addr, opts) {
  if (!addr) return '';
  opts = opts || {};
  var style = opts.style || 'color:#1a6fc4;text-decoration:none;';
  var url = 'https://maps.google.com/?q=' + encodeURIComponent(addr);
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener" style="' + style + '">' + esc(addr) + '</a>';
}

// ─── Shared contact-info block (canonical: customer profile look) ─────────────
// One source of truth for how a person's contact details render, used on the
// customer profile, the lead detail page, and anywhere a person is shown. `p`
// has { phone, email, home_address }. Phone is always formatted with fmtPhone
// and falls back to a gray "None on file"; same for email — so the lead page and
// the customer profile read identically. Pass `extraRows` (pre-built info-grid
// <span> pairs) for context-specific fields (vehicle/service on a lead, lifetime
// dates on a customer).
function contactInfoRows(p, extraRows) {
  var addr = p.home_address || p.address;
  return '<span class="info-key">Phone</span><span class="info-val">'
      + (p.phone ? '<a href="tel:' + esc(p.phone) + '" style="color:#1a6fc4;">' + esc(fmtPhone(p.phone)) + '</a>' : '<span style="color:#bbb;">None on file</span>')
      + '</span>'
    + '<span class="info-key">Email</span><span class="info-val">'
      + (p.email ? esc(p.email) : '<span style="color:#bbb;">None on file</span>')
      + '</span>'
    + (addr ? '<span class="info-key">Address</span><span class="info-val">' + mapsLink(addr) + '</span>' : '')
    + (extraRows || '');
}

// Call / Text / Email action buttons for a person. Identical wherever a person
// is shown. `p` has { phone, email }.
function contactActions(p, marginTop) {
  return '<div style="display:flex;gap:8px;margin-top:' + (marginTop != null ? marginTop : 14) + 'px;flex-wrap:wrap;">'
    + (p.phone ? '<a href="tel:' + esc(p.phone) + '" class="btn btn-outline btn-sm" style="width:auto;">' + ic('phone') + 'Call</a>' : '')
    + (p.phone ? '<a href="sms:' + esc(p.phone) + '" class="btn btn-outline btn-sm" style="width:auto;">' + ic('chat') + 'Text</a>' : '')
    + (p.email ? '<button type="button" onclick="copyEmail(this,\'' + esc(p.email) + '\')" class="btn btn-outline btn-sm" style="width:auto;">' + ic('envelope') + 'Email</button>' : '')
    + '</div>';
}

// ─── Canonical lead card ──────────────────────────────────────────────────────
// One card for a lead, shown identically in the Leads list and the customer
// profile's job history (and anywhere else a lead appears). The shell is always
// the same: status stripe, name + status badge, customer tags, service, vehicle,
// service address, meta line, and the shared Call/Text/Email buttons. Context
// detail slots in: opts.management adds the pipeline tools (scheduling panel,
// Send Receipt, status dropdown, archive/delete) on the Leads list; opts.extra
// is raw HTML appended in the body (e.g. the job total in the profile history).
function leadCard(l, opts) {
  opts = opts || {};
  var back = opts.back || '/admin';
  var sched = (l.status === 'quote_accepted' || l.status === 'booked')
    ? db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(l.id)
    : null;
  var cust = l.customer_id ? db.prepare('SELECT tags, home_address FROM customers WHERE id = ?').get(l.customer_id) : null;
  var addrDisplay = (sched && sched.pref_location) ? sched.pref_location : (cust && cust.home_address ? cust.home_address : null);
  var statusOptions = ['new','quoted','follow_up','quote_accepted','booked','completed','receipt'];
  var statusLabels = { new:'New', quoted:'Quoted', follow_up:'Follow Up', quote_accepted:'Quote Accepted', booked:'Booked', completed:'Completed', receipt:'Receipt Sent' };

  return '<div class="card" onclick="if(!event.target.closest(\'a,button,select,form\')){window.location=\'/admin/quote/' + l.id + '\';}" style="cursor:pointer;border-left:3px solid ' + (STATUS_COLOR[l.status] || STATUS_COLOR.new) + ';' + (l.archived ? 'opacity:.72;' : '') + '">'
    + '<div class="row-sb">'
    + '<div class="lead-name">' + esc(l.first_name) + ' ' + esc(l.last_name) + '</div>'
    + statusBadge(l.status)
    + '</div>'
    + (cust && cust.tags ? customerTagBadges(cust.tags) : '')
    + '<div class="lead-service">' + esc(l.service || 'Service not specified') + '</div>'
    + (l.vehicle ? '<div class="lead-vehicle">' + esc(l.vehicle) + '</div>' : '')
    + (addrDisplay ? '<div class="lead-meta" style="margin-top:2px;">' + mapsLink(addrDisplay, { style: 'color:#1a6fc4;font-size:0.83rem;text-decoration:none;' }) + '</div>' : '')
    + '<div class="lead-meta">' + timeAgo(l.created_at) + (l.preferred_contact ? ' &middot; Prefers ' + esc(l.preferred_contact) : '') + '</div>'
    + (l.message ? '<div class="lead-note">&ldquo;' + esc(l.message) + '&rdquo;</div>' : '')
    + (opts.extra || '')
    + (opts.management ? '<div style="margin-top:12px;">' + schedulingPanel(l, sched, true) + '</div>' : '')
    + contactActions(l, 12)
    + (opts.management
        ? (l.archived ? '' : '<a href="/admin/receipt/' + l.id + '" class="btn btn-navy btn-sm" style="width:100%;margin-top:8px;text-align:center;">' + ic('receipt') + 'Send Receipt</a>')
          + (l.archived
              ? '<div style="margin-top:10px;display:flex;align-items:center;gap:8px;justify-content:space-between;">'
                + '<span style="font-size:0.78rem;color:#aaa;">Archived' + (l.archived_at ? ' ' + timeAgo(l.archived_at) : '') + '</span>'
                + '<form method="POST" action="/admin/lead/' + l.id + '/restore" style="margin:0;">'
                + '<input type="hidden" name="back" value="' + esc(back) + '">'
                + '<button type="submit" class="btn btn-outline btn-sm" style="width:auto;">&#8634; Restore</button>'
                + '</form></div>'
              : '<form method="POST" action="/admin/lead/' + l.id + '/status" style="margin-top:10px;display:flex;align-items:center;gap:8px;">'
                + '<input type="hidden" name="back" value="' + esc(back) + '">'
                + '<label style="font-size:0.78rem;color:#aaa;font-weight:600;white-space:nowrap;">Status:</label>'
                + '<select name="status" onchange="this.form.submit()" style="flex:1;padding:6px 8px;border:1.5px solid #dde3ea;border-radius:6px;font-size:0.82rem;color:#1a2a3a;background:#fff;">'
                + statusOptions.map(function(s) { return '<option value="' + s + '"' + (l.status === s ? ' selected' : '') + '>' + statusLabels[s] + '</option>'; }).join('')
                + '</select></form>'
                + '<div style="display:flex;gap:0;margin-top:8px;">'
                + '<form method="POST" action="/admin/lead/' + l.id + '/archive" style="flex:1;" onsubmit="return confirm(\'Archive this lead? It stays saved and can be restored from the Archived tab.\');">'
                + '<input type="hidden" name="back" value="' + esc(back) + '">'
                + '<button type="submit" style="width:100%;background:none;border:none;color:#888;font-size:0.8rem;font-weight:600;cursor:pointer;padding:4px;">' + ic('archive') + 'Archive</button>'
                + '</form>'
                + '<form method="POST" action="/admin/lead/' + l.id + '/delete" style="flex:1;">'
                + '<input type="hidden" name="back" value="' + esc(back) + '">'
                + '<button type="button" data-name="' + esc(l.first_name + ' ' + l.last_name) + '" onclick="showDeleteConfirm(this)" style="width:100%;background:none;border:none;color:#c0392b;font-size:0.8rem;font-weight:600;cursor:pointer;padding:4px;">' + ic('trash') + 'Delete</button>'
                + '</form></div>')
        : '')
    + '</div>';
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
  return new Date(dateStr + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

// Pipeline status color (full-color text; the pill uses a 15% tint of it as the
// background, per the design skill). Amber stays for Completed (receipt owed).
var STATUS_COLOR = {
  new:            '#3b82f6',
  quoted:         '#8b5cf6',
  follow_up:      '#f97316',
  quote_accepted: '#06b6d4',
  booked:         '#0d9488',
  completed:      '#d97706',
  receipt:        '#16a34a'
};
// Hex -> rgba string at the given alpha, for the 15% badge tint.
function hexA(hex, a) {
  var h = hex.replace('#', '');
  var r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}
function statusBadge(status) {
  const labels = { new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', quote_accepted: 'Quote Accepted', booked: 'Booked', completed: 'Completed', receipt: 'Receipt Sent' };
  const color = STATUS_COLOR[status] || STATUS_COLOR.new;
  const label = labels[status] || status;
  return '<span style="background:' + hexA(color, 0.15) + ';color:' + color + ';padding:3px 10px;border-radius:999px;font-size:0.72rem;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;white-space:nowrap;">' + label + '</span>';
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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' });
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

// Returns effective pricing data: DB overrides take precedence over pricing.js static file.
// Called at request time so edits on the settings page take effect immediately.
function getEffectivePricing() {
  var rows = [];
  try { rows = db.prepare('SELECT * FROM pricing_overrides').all(); } catch (_) {}
  if (!rows.length) return PRICING.services;
  var result = {};
  rows.forEach(function(row) {
    var entry = {
      minutes:     row.minutes,
      customQuote: !!row.custom_quote,
      standard:    { parts: row.std_parts, labor: row.std_labor, shopSupplies: row.std_supplies }
    };
    if (row.note) entry.note = row.note;
    if (row.has_premium) {
      entry.premium = { parts: row.prem_parts, labor: row.prem_labor, shopSupplies: row.prem_supplies };
    }
    result[row.service_name] = entry;
  });
  return result;
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
      + (quote.pref_location ? '<div style="font-size:0.83rem;margin-top:2px;">' + mapsLink(quote.pref_location, { style: 'color:#1a6fc4;text-decoration:none;' }) + '</div>' : '')
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
    + (quote.pref_location ? '<div style="font-size:0.83rem;margin-top:2px;">' + mapsLink(quote.pref_location, { style: 'color:#1a6fc4;text-decoration:none;' }) + '</div>' : '')
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
    booked:         { text: 'Job is booked. After the service, click Send Receipt to wrap it up.', bg: '#e6f9ee', border: '#bfe3cb', color: '#1a7a3a' },
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
:root{
--navy:#0d1b2a;--navy-mid:#1b2c3e;--blue:#1a4a7a;--blue-light:#2563a8;
--cta:#4169e1;--cta-hover:#6b8ff5;--white:#fff;
--gray-50:#f8fafc;--gray-100:#f1f5f9;--gray-200:#e2e8f0;--gray-400:#94a3b8;--gray-600:#475569;--gray-900:#0f172a;
--danger:#ef4444;--success:#22c55e;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--gray-50);min-height:100vh;color:#1a2a3a}
/* ── Sidebar nav ── */
.sidebar{position:fixed;top:0;left:0;bottom:0;width:240px;background:var(--navy);display:flex;flex-direction:column;z-index:200;transform:translateX(-100%);transition:transform .22s ease;overflow-y:auto;-webkit-overflow-scrolling:touch}
.sidebar.open{transform:translateX(0)}
.sidebar-logo{display:flex;align-items:center;gap:10px;padding:18px 16px;color:#fff;font-weight:700;font-size:1rem;letter-spacing:.3px;text-decoration:none;border-bottom:1px solid rgba(255,255,255,.07)}
.sidebar-logo img{width:26px;height:26px;border-radius:6px}
.nav-section{padding:12px 0 4px}
.nav-label{font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--gray-400);padding:6px 16px}
.nav-item{display:flex;align-items:center;gap:12px;min-height:48px;padding:0 16px;color:#cbd5e1;text-decoration:none;font-weight:500;font-size:0.92rem;border-left:3px solid transparent;transition:background .12s,color .12s}
.nav-item svg{width:22px;height:22px;flex-shrink:0}
.nav-item:hover{background:var(--navy-mid);color:#fff}
.nav-item.active{background:var(--navy-mid);color:#fff;border-left-color:var(--cta)}
.nav-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:150;opacity:0;visibility:hidden;transition:opacity .2s}
.nav-overlay.show{opacity:1;visibility:visible}
/* ── App shell + header ── */
.app{min-height:100vh;display:flex;flex-direction:column}
.appbar{position:sticky;top:0;z-index:100;height:56px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);display:flex;align-items:center;gap:10px;padding:0 12px}
.hamburger{background:none;border:none;color:var(--navy);cursor:pointer;display:flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px}
.hamburger:hover{background:var(--gray-100)}
.hamburger svg{width:24px;height:24px}
.appbar-title{font-weight:600;font-size:1.02rem;color:var(--gray-900);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.appbar-right{display:flex;align-items:center;gap:4px}
.appbar-bell{position:relative;display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;color:var(--gray-600);text-decoration:none}
.appbar-bell:hover{background:var(--gray-100)}
.appbar-bell svg{width:22px;height:22px}
.appbar-bell .cnt{position:absolute;top:5px;right:4px;background:var(--cta);color:#fff;font-size:0.64rem;font-weight:700;min-width:16px;height:16px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;padding:0 4px}
.appbar-bell-wrap{position:relative;display:inline-flex}
.bell-preview{position:absolute;top:calc(100% + 4px);right:0;width:320px;max-width:calc(100vw - 24px);background:#fff;border:1px solid var(--gray-200);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.16);padding:6px;opacity:0;visibility:hidden;transform:translateY(-6px);transition:opacity .14s ease,transform .14s ease;z-index:200}
.bell-preview::before{content:"";position:absolute;top:-8px;left:0;right:0;height:8px}
.appbar-bell-wrap:hover .bell-preview,.appbar-bell-wrap:focus-within .bell-preview{opacity:1;visibility:visible;transform:translateY(0)}
.bell-preview-hd{font-size:0.72rem;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--gray-400);padding:8px 10px 6px}
.bell-preview-item{display:block;padding:9px 10px;border-radius:8px;text-decoration:none}
.bell-preview-item:hover{background:var(--gray-100)}
.bell-preview-item .nm{font-size:0.86rem;font-weight:600;color:#0a1f3d}
.bell-preview-item .ds{font-size:0.8rem;color:var(--gray-600);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bell-preview-item .dt{font-size:0.74rem;font-weight:600;color:var(--cta);margin-top:2px}
.bell-preview-ft{display:block;text-align:center;padding:9px;margin-top:4px;border-top:1px solid var(--gray-100);font-size:0.82rem;font-weight:600;color:var(--cta);text-decoration:none}
.bell-preview-empty{padding:20px 12px;text-align:center;color:var(--gray-400);font-size:0.85rem}
.appbar-logout{color:var(--gray-600);font-size:0.84rem;text-decoration:none;padding:8px 10px;border-radius:8px}
.appbar-logout:hover{background:var(--gray-100);color:var(--gray-900)}
.content{max-width:960px;width:100%;margin:0 auto;padding:24px 16px}
@media(min-width:769px){
.sidebar{transform:translateX(0)}
.hamburger{display:none}
.nav-overlay{display:none}
.app{margin-left:240px}
.content{padding:24px 32px}
}
/* ── Collapsible sections (lead profile) ── */
.collapse{background:#fff;border:1px solid var(--gray-200);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);margin-bottom:12px;overflow:hidden}
.collapse-head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;background:none;border:none;cursor:pointer;padding:14px 16px;min-height:48px;font-family:inherit;text-align:left}
.collapse-head:hover{background:var(--gray-50)}
.collapse-title{font-size:0.95rem;font-weight:700;color:#0a1f3d;display:flex;align-items:center;gap:8px}
.collapse-chev{width:20px;height:20px;color:#94a3b8;flex-shrink:0;transition:transform .18s}
.collapse.collapsed .collapse-chev{transform:rotate(-90deg)}
.collapse-body{padding:2px 16px 16px}
.collapse.collapsed .collapse-body{display:none}
.collapse-body>.card{box-shadow:none;border-color:var(--gray-200)}
.ic{width:16px;height:16px;flex-shrink:0;vertical-align:-3px;margin-right:5px}
.empty svg{width:44px;height:44px;color:#cbd5e1}
.stat-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(min-width:769px){.stat-grid{grid-template-columns:repeat(4,1fr)}}
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
.back-link{display:inline-flex;align-items:center;gap:7px;min-height:44px;padding:9px 16px 9px 13px;color:#0a1f3d;background:var(--gray-100);border:1px solid var(--gray-200);border-radius:8px;text-decoration:none;font-weight:600;font-size:0.92rem;margin-bottom:14px;-webkit-tap-highlight-color:transparent;transition:background .12s,border-color .12s}
.back-link:hover,.back-link:active{background:var(--gray-200);border-color:#cbd5e1}
.back-link .bk-arrow{font-size:1.15rem;line-height:1;font-weight:700;margin-top:-1px}
/* Row that holds the back button on the left and a forward/profile link on the right,
   spaced apart so they are never mistaken for each other or mis-tapped. */
.nav-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.nav-row .back-link{margin-bottom:0}
.fwd-link{display:inline-flex;align-items:center;gap:7px;min-height:44px;padding:9px 14px;color:#1a6fc4;background:#eaf2ff;border:1px solid #b9d2ff;border-radius:8px;text-decoration:none;font-weight:600;font-size:0.9rem;-webkit-tap-highlight-color:transparent;transition:background .12s}
.fwd-link:hover,.fwd-link:active{background:#d8e8ff}
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
#deleteModal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;align-items:center;justify-content:center;}
#deleteModal.active{display:flex;}
#deleteModalBox{background:#fff;border-radius:12px;padding:28px 24px;max-width:380px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.28);}
#deleteModalTitle{font-size:1.1rem;font-weight:700;color:#0a1f3d;margin-bottom:8px;}
#deleteModalName{font-size:0.95rem;color:#444;margin-bottom:8px;}
#deleteModalWarn{font-size:0.82rem;color:#c0392b;font-weight:600;margin-bottom:20px;}
#deleteModalBtns{display:flex;gap:10px;}
#deleteModalBtns button{flex:1;padding:11px;border-radius:8px;font-weight:700;font-size:0.92rem;cursor:pointer;}
#deleteModalCancel{border:1.5px solid #dde3ea;background:#fff;color:#444;}
#deleteModalConfirm{border:none;background:#c0392b;color:#fff;}
.push-btn{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:8px;color:#94a3b8;cursor:pointer;background:none;border:none;position:relative;-webkit-tap-highlight-color:transparent}
/* Only hover-capable devices get the background. On touch (iPhone) :hover sticks
   after a tap and leaves a gray box around the bell, so scope it to real hover. */
@media (hover:hover){.push-btn:hover{background:var(--gray-100)}}
.push-btn svg{width:22px;height:22px}
.push-btn.on{color:#1a7a3a}
.push-btn.unsupported{color:#94a3b8}
.nav-new-badge{background:#e07000;color:#fff;font-size:0.6rem;font-weight:700;min-width:16px;height:16px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;padding:0 4px;margin-left:auto;flex-shrink:0}
`;

// Heroicons (outline, 1.5px stroke). Inline so the admin stays dependency-free
// and emoji-free per the design skill. 24px in the nav.
var ICON_PATHS = {
  home:        '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"/>',
  clipboard:   '<path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z"/>',
  users:       '<path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"/>',
  bolt:        '<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"/>',
  bell:        '<path stroke-linecap="round" stroke-linejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"/>',
  receipt:     '<path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"/>',
  currency:    '<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  chart:       '<path stroke-linecap="round" stroke-linejoin="round" d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"/>',
  wrench:      '<path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26"/>',
  tag:         '<path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z"/><path stroke-linecap="round" stroke-linejoin="round" d="M6 6h.008v.008H6V6z"/>',
  document:    '<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 00-3.375-3.375h-1.5a1.125 1.125 0 01-1.125-1.125v-1.5a3.375 3.375 0 00-3.375-3.375H9.75"/>',
  bars:        '<path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"/>',
  phone:       '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z"/>',
  chat:        '<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"/>',
  envelope:    '<path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"/>',
  trash:       '<path stroke-linecap="round" stroke-linejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"/>',
  archive:     '<path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z"/>',
  user:        '<path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z"/>',
  calendar:    '<path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5"/>',
  edit:        '<path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10"/>',
  clock:       '<path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  'bell-slash': '<path stroke-linecap="round" stroke-linejoin="round" d="M9.143 17.082a24.248 24.248 0 003.844.148m-3.844-.148a23.856 23.856 0 01-5.455-1.31A8.967 8.967 0 012.25 9c0-.06 0-.12.003-.18m5.894 8.262a24.265 24.265 0 003.844.148m-3.844-.148L9 21m-6-4.5A8.967 8.967 0 012.25 9c0-.06 0-.12.003-.18M21 21L3 3m18 0a8.967 8.967 0 011.003 3.82M21.003 8.82A8.97 8.97 0 0121.75 12c0 3.26-1.74 6.12-4.357 7.773m-1.393-1.39a23.848 23.848 0 01-4.143.699m4.143-.699L15 21m-3-3.75a3 3 0 005.714 0"/>'
};
function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
}
// Small inline icon for buttons/links (16px, sits on the text baseline).
function ic(name) {
  return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' + (ICON_PATHS[name] || '') + '</svg>';
}

// Notification bell, two states, drawn as one SOLID bell shape so on/off look
// identical except color + slash. The outline Heroicons bell-slash fragments the
// bell at small sizes and reads as broken; this keeps a clean, single silhouette.
var SOLID_BELL_PATHS =
    '<path d="M5.85 3.5a.75.75 0 00-1.117-1 9.719 9.719 0 00-2.348 4.876.75.75 0 001.479.248A8.219 8.219 0 015.85 3.5zM19.267 2.5a.75.75 0 10-1.118 1 8.22 8.22 0 011.987 4.124.75.75 0 001.48-.248A9.72 9.72 0 0019.266 2.5z"/>'
  + '<path fill-rule="evenodd" d="M12 2.25A6.75 6.75 0 005.25 9v.75a8.217 8.217 0 01-2.119 5.52.75.75 0 00.298 1.206c1.544.57 3.16.99 4.831 1.243a3.75 3.75 0 107.48 0 24.583 24.583 0 004.83-1.244.75.75 0 00.298-1.205 8.217 8.217 0 01-2.118-5.52V9A6.75 6.75 0 0012 2.25zM9.75 18c0-.034 0-.067.002-.1a25.05 25.05 0 004.496 0l.002.1a2.25 2.25 0 11-4.5 0z" clip-rule="evenodd"/>';
// ON: solid filled bell (color set by the button's .on class).
var BELL_ON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + SOLID_BELL_PATHS + '</svg>';
// OFF/unsupported: same solid bell with a single clean diagonal slash. A white
// stroke under the slash carves a crisp gap so the line reads clearly over the bell.
var BELL_OFF = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + SOLID_BELL_PATHS
  + '<line x1="3.6" y1="3.2" x2="20.4" y2="20.8" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/>'
  + '<line x1="3.6" y1="3.2" x2="20.4" y2="20.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// Sidebar nav: [section label, [[id, label, href, icon], ...]].
var NAV = [
  ['MAIN', [
    ['dashboard',    'Dashboard',    '/admin/dashboard',    'home'],
    ['leads',        'Leads',        '/admin',              'clipboard'],
    ['customers',    'Customers',    '/admin/customers',    'users'],
    ['appointments', 'Appointments', '/admin/appointments', 'calendar'],
    ['quick',        'Quick Quote',  '/admin/quick',        'bolt']
  ]],
  ['TOOLS', [
    ['followups', 'Follow-Ups',  '/admin/followups',  'bell'],
    ['receipts',  'Receipts',    '/admin/receipts',   'receipt']
  ]],
  ['REPORTS', [
    ['revenue',     'Revenue',     '/admin/reports/revenue',     'currency'],
    ['conversions', 'Conversions', '/admin/reports/conversions', 'chart'],
    ['services',    'Services',    '/admin/reports/services',    'wrench']
  ]],
  ['SETTINGS', [
    ['pricing',   'Pricing & Tiers', '/admin/settings/pricing',   'tag'],
    ['templates', 'Templates',       '/admin/settings/templates', 'document']
  ]]
];

// Maps the current request path to the active nav item id.
function navActive(p) {
  if (p === '/dashboard') return 'dashboard';
  if (p === '/customers' || p.indexOf('/customer/') === 0) return 'customers';
  if (p === '/appointments' || p.indexOf('/appointments') === 0) return 'appointments';
  if (p === '/quick') return 'quick';
  if (p.indexOf('/followup') === 0) return 'followups';
  if (p === '/receipts') return 'receipts';
  if (p.indexOf('/reports/revenue') === 0) return 'revenue';
  if (p.indexOf('/reports/conversions') === 0) return 'conversions';
  if (p.indexOf('/reports/services') === 0) return 'services';
  if (p.indexOf('/settings/pricing') === 0) return 'pricing';
  if (p.indexOf('/settings/templates') === 0) return 'templates';
  return 'leads';
}

// Collapsible section (accordion) for the lead profile. Open/closed state is
// remembered per key in localStorage (see toggleCollapse in the page script).
function collapseOpen(key, title, open, extraClass, extraStyle) {
  // Sections always start collapsed; the owner opens the ones they want and that
  // choice is remembered per section in localStorage (see the page init script).
  // The `open` argument is kept for signature compatibility but intentionally
  // ignored so every section defaults to closed.
  return '<div class="collapse collapsed' + (extraClass || '') + '" data-ckey="' + esc(key) + '"' + (extraStyle ? ' style="' + extraStyle + '"' : '') + '>'
    + '<button type="button" class="collapse-head" onclick="toggleCollapse(this)">'
    + '<span class="collapse-title">' + title + '</span>'
    + '<svg class="collapse-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg>'
    + '</button><div class="collapse-body">';
}
var COLLAPSE_CLOSE = '</div></div>';
// Whole-section helper: returns '' when there's no inner content so empty
// sections don't render a dangling header.
function collapsible(key, title, inner, open) {
  if (inner == null || String(inner).trim() === '') return '';
  return collapseOpen(key, title, open) + inner + COLLAPSE_CLOSE;
}

// ─── Shared vehicle Year/Make/Model picker ───────────────────────────────────
// Every admin vehicle input uses this cascading dropdown trio so the data is
// always structured (no free-typed makes/models) and Phase 8 tier lookup has
// clean values. Make list mirrors the public contact form; models load on demand
// from our curated bundled dataset (/assets/vehicle-models.json) when a make is chosen.
var ADMIN_VEHICLE_MAKES = ['Acura','Alfa Romeo','Audi','Bentley','BMW','Buick','Cadillac',
  'Chevrolet','Chrysler','Dodge','Ferrari','Ford','Genesis','GMC','Honda',
  'Hyundai','Infiniti','Jeep','Kia','Lamborghini','Land Rover','Lexus',
  'Lincoln','Maserati','Mazda','Mercedes-Benz','Mitsubishi','Nissan',
  'Porsche','Ram','Rolls-Royce','Subaru','Tesla','Toyota','Volkswagen','Volvo'];

function adminYearOptions(sel) {
  var cur = new Date().getFullYear() + 1;
  var o = '<option value="">Year</option>';
  for (var y = cur; y >= 1985; y--) {
    o += '<option value="' + y + '"' + (String(sel) === String(y) ? ' selected' : '') + '>' + y + '</option>';
  }
  return o;
}
function adminMakeOptions(sel) {
  return '<option value="">Make</option>' + ADMIN_VEHICLE_MAKES.map(function(m) {
    return '<option value="' + esc(m) + '"' + (sel === m ? ' selected' : '') + '>' + esc(m) + '</option>';
  }).join('');
}

// Renders a Year / Make / Model cascading dropdown trio. `prefix` namespaces the
// element ids so multiple pickers coexist on one page. `names` sets the form field
// names (defaults veh_year/veh_make/veh_model). `vals` optionally pre-selects
// {year,make,model} for edit or customer auto-fill; a preset model stays selectable
// until the NHTSA list loads.
function vehicleCascadeHtml(prefix, names, vals) {
  names = names || {}; vals = vals || {};
  var nYear = names.year || 'veh_year', nMake = names.make || 'veh_make', nModel = names.model || 'veh_model';
  var modelOpt = '<option value="">Model</option>';
  if (vals.model) modelOpt += '<option value="' + esc(vals.model) + '" selected>' + esc(vals.model) + '</option>';
  return '<div style="display:grid;grid-template-columns:90px 1fr 1fr;gap:8px;" data-veh-cascade="' + esc(prefix) + '">'
    + '<div class="form-group" style="margin-bottom:8px;"><label>Year</label>'
    + '<select name="' + nYear + '" id="' + prefix + '-year">' + adminYearOptions(vals.year) + '</select></div>'
    + '<div class="form-group" style="margin-bottom:8px;"><label>Make</label>'
    + '<select name="' + nMake + '" id="' + prefix + '-make">' + adminMakeOptions(vals.make) + '</select></div>'
    + '<div class="form-group" style="margin-bottom:8px;"><label>Model</label>'
    + '<select id="' + prefix + '-model"' + (vals.model ? ' data-preset="' + esc(vals.model) + '"' : '') + '>' + modelOpt + '</select>'
    + '<input type="text" id="' + prefix + '-model-other" placeholder="Type model…" autocomplete="off" style="display:none;margin-top:6px;">'
    + '<input type="hidden" name="' + nModel + '" id="' + prefix + '-model-hid" value="' + esc(vals.model || '') + '">'
    + '</div>'
    + '</div>';
}

// One-time client script that wires every cascade on the page. Include once per
// page that renders a vehicleCascadeHtml block. Models come from our curated
// bundled dataset (/data/vehicle-models.json), fetched once and cached, so the
// list is consumer models only (no NHTSA chassis/body codes or sub-companies).
var VEHICLE_CASCADE_JS = '<script>'
  + '(function(){'
  + 'var dataPromise=null;'
  + 'function getData(){'
  +   'if(!dataPromise){dataPromise=fetch("/assets/vehicle-models.json").then(function(r){return r.json();}).then(function(d){return (d&&d.makes)||{};}).catch(function(){return {};});}'
  +   'return dataPromise;'
  + '}'
  + 'function syncHidden(prefix){'
  +   'var mo=document.getElementById(prefix+"-model"),hid=document.getElementById(prefix+"-model-hid"),ot=document.getElementById(prefix+"-model-other");'
  +   'if(!mo||!hid)return;'
  +   'if(mo.value==="__other__"){'
  +     'if(ot){ot.style.display="";ot.focus();}hid.value=ot?ot.value:"";'
  +   '}else{'
  +     'hid.value=mo.value;if(ot){ot.style.display="none";ot.value="";}'
  +   '}'
  + '}'
  + 'function loadModels(prefix){'
  +   'var mk=document.getElementById(prefix+"-make"),mo=document.getElementById(prefix+"-model");'
  +   'if(!mk||!mo)return;'
  +   'var make=mk.value;'
  +   'var preset=mo.getAttribute("data-preset")||"";'
  +   'if(!make){mo.innerHTML="<option value=\\"\\">Model</option>";syncHidden(prefix);return;}'
  +   'mo.innerHTML="<option value=\\"\\">Loading…</option>";'
  +   'getData().then(function(makes){'
  +     'var models=(makes[make]||[]).slice();'
  +     'var html="<option value=\\"\\">Model</option>";'
  +     'models.forEach(function(m){html+="<option value=\\""+m+"\\""+(m===preset?" selected":"")+">"+m+"</option>";});'
  +     'if(preset&&models.indexOf(preset)<0)html+="<option value=\\""+preset+"\\" selected>"+preset+"</option>";'
  +     'html+="<option value=\\"__other__\\">Other…</option>";'
  +     'mo.innerHTML=html;'
  +     'syncHidden(prefix);'
  +   '});'
  + '}'
  + 'window.bkVehInit=function(){'
  +   'document.querySelectorAll("[data-veh-cascade]").forEach(function(box){'
  +     'var prefix=box.getAttribute("data-veh-cascade");'
  +     'var y=document.getElementById(prefix+"-year"),mk=document.getElementById(prefix+"-make");'
  +     'if(!mk||mk.getAttribute("data-wired"))return;'
  +     'mk.setAttribute("data-wired","1");'
  +     'mk.addEventListener("change",function(){loadModels(prefix);});'
  +     'var mo=document.getElementById(prefix+"-model"),ot=document.getElementById(prefix+"-model-other");'
  +     'if(mo)mo.addEventListener("change",function(){syncHidden(prefix);});'
  +     'if(ot)ot.addEventListener("input",function(){var hid=document.getElementById(prefix+"-model-hid");if(hid)hid.value=ot.value;});'
  +     'if(mk.value)loadModels(prefix);'
  +   '});'
  + '};'
  + 'window.bkVehFill=function(prefix,v){'
  +   'v=v||{};var y=document.getElementById(prefix+"-year"),mk=document.getElementById(prefix+"-make"),mo=document.getElementById(prefix+"-model"),hid=document.getElementById(prefix+"-model-hid");'
  +   'if(y)y.value=v.year||"";if(mk)mk.value=v.make||"";'
  +   'if(mo){if(v.model){mo.setAttribute("data-preset",v.model);}else{mo.removeAttribute("data-preset");mo.innerHTML="<option value=\\"\\">Model</option>";}}'
  +   'if(hid)hid.value=v.model||"";'
  +   'if(mk&&mk.value)loadModels(prefix);'
  + '};'
  + 'if(document.readyState!=="loading")window.bkVehInit();else document.addEventListener("DOMContentLoaded",window.bkVehInit);'
  + '})();'
  + '</script>';

function page(title, body, req) {
  var authed = req.session && req.session.adminAuthed;
  var head = '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<link rel="icon" type="image/png" href="/images/favicon.png">'
    // PWA manifest + Apple meta so the admin can be added to the iPhone Home Screen.
    // iOS Safari only delivers web push to a Home-Screen-installed PWA, so these are
    // required for push notifications to work on the owner's phone.
    + '<link rel="manifest" href="/manifest.webmanifest">'
    + '<meta name="theme-color" content="#0a1f3d">'
    + '<meta name="apple-mobile-web-app-capable" content="yes">'
    + '<meta name="mobile-web-app-capable" content="yes">'
    + '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">'
    + '<meta name="apple-mobile-web-app-title" content="BK Admin">'
    + '<link rel="apple-touch-icon" href="/images/favicon.png">'
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">'
    + '<title>BK Admin' + (title && title !== 'Leads' ? ' — ' + esc(title) : '') + '</title>'
    + '<style>' + CSS + '</style>'
    + '</head>';

  // Login (and any unauthed) page: no sidebar/header chrome, just centered content.
  if (!authed) {
    return head + '<body><div class="content" style="max-width:420px;">' + body + '</div></body></html>';
  }

  // Count of follow-ups due now (overdue or due today) for the header bell badge.
  var dueCount = 0;
  try {
    dueCount = db.prepare("SELECT COUNT(*) AS n FROM followups WHERE sent = 0 AND date(due_date) <= date('now')").get().n;
  } catch (_) {}

  // Due-now items for the bell hover preview (snapshot without leaving the page).
  var dueItems = [];
  try {
    dueItems = db.prepare(
      'SELECT f.id, f.description, f.due_date, f.lead_id, l.first_name, l.last_name '
      + 'FROM followups f JOIN leads l ON l.id = f.lead_id '
      + "WHERE f.sent = 0 AND date(f.due_date) <= date('now') "
      + 'ORDER BY f.due_date ASC, f.id ASC LIMIT 6'
    ).all();
  } catch (_) {}

  // Count of unactioned new leads for the sidebar badge.
  var newLeadCount = 0;
  try {
    newLeadCount = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status = 'new' AND archived = 0").get().n;
  } catch (_) {}

  var vapidKey = process.env.VAPID_PUBLIC_KEY || '';

  var active = navActive(req.path || '/');
  var sidebar = '<aside class="sidebar" id="sidebar">'
    + '<a href="/admin" class="sidebar-logo"><img src="/images/favicon.png" alt=""> Brake Knights</a>'
    + NAV.map(function(sec) {
        return '<div class="nav-section"><div class="nav-label">' + sec[0] + '</div>'
          + sec[1].map(function(it) {
              var badge = (it[0] === 'leads' && newLeadCount > 0)
                ? '<span class="nav-new-badge">' + newLeadCount + '</span>'
                : '';
              return '<a href="' + it[2] + '" class="nav-item' + (active === it[0] ? ' active' : '') + '">'
                + icon(it[3]) + '<span>' + it[1] + '</span>' + badge + '</a>';
            }).join('')
          + '</div>';
      }).join('')
    + '</aside>';

  var bellPreviewItems = dueItems.map(function(f) {
    var nm = ((f.first_name || '') + ' ' + (f.last_name || '')).trim() || 'Lead #' + f.lead_id;
    return '<a href="/admin/quote/' + f.lead_id + '" class="bell-preview-item">'
      + '<div class="nm">' + esc(nm) + '</div>'
      + '<div class="ds">' + esc(f.description || 'Follow-up') + '</div>'
      + '<div class="dt">Due ' + esc(fmtPrefDate(f.due_date)) + '</div>'
      + '</a>';
  }).join('');
  var bellPanel = '<div class="bell-preview">'
    + '<div class="bell-preview-hd">Needs action' + (dueCount > 0 ? ' (' + dueCount + ')' : '') + '</div>'
    + (dueItems.length
        ? bellPreviewItems
          + (dueCount > dueItems.length ? '<a href="/admin/followups" class="bell-preview-ft">View all ' + dueCount + ' follow-ups</a>' : '<a href="/admin/followups" class="bell-preview-ft">Open follow-ups</a>')
        : '<div class="bell-preview-empty">You&rsquo;re all caught up.</div>')
    + '</div>';
  var bell = '<div class="appbar-bell-wrap">'
    + '<a href="/admin/followups" class="appbar-bell" aria-label="Follow-ups">'
    + icon('clock') + (dueCount > 0 ? '<span class="cnt">' + dueCount + '</span>' : '') + '</a>'
    + bellPanel
    + '</div>';

  var pushBtn = vapidKey
    ? '<button id="push-btn" class="push-btn" onclick="togglePush()" title="Notifications off — tap to enable" aria-label="Toggle push notifications">'
      + BELL_OFF + '</button>'
    : '';

  var appbar = '<header class="appbar">'
    + '<button class="hamburger" onclick="openNav()" aria-label="Open menu">' + icon('bars') + '</button>'
    + '<div class="appbar-title">' + esc(title) + '</div>'
    + '<div class="appbar-right">' + pushBtn + bell + '<a href="/admin/logout" class="appbar-logout">Log out</a></div>'
    + '</header>';

  return head
    + '<body>'
    + '<div id="navOverlay" class="nav-overlay" onclick="closeNav()"></div>'
    + sidebar
    + '<div class="app">' + appbar + '<main class="content">' + body + '</main></div>'
    + '<div id="deleteModal"><div id="deleteModalBox">'
    + '<div id="deleteModalTitle">' + ic('trash') + 'Permanently Delete Lead?</div>'
    + '<div id="deleteModalName"></div>'
    + '<div id="deleteModalWarn">All quotes, receipts, and follow-ups will be permanently erased. This cannot be undone.</div>'
    + '<div id="deleteModalBtns">'
    + '<button id="deleteModalCancel" onclick="closeDeleteModal()">Cancel</button>'
    + '<button id="deleteModalConfirm" onclick="submitDeleteForm()">Yes, Delete</button>'
    + '</div></div></div>'
    + '<script>'
    + 'function fmtPhoneInput(el){var v=el.value.replace(/\\D/g,"");if(v.length===11&&v.charAt(0)==="1")v=v.slice(1);v=v.slice(0,10);if(v.length>=7)v=v.slice(0,3)+"-"+v.slice(3,6)+"-"+v.slice(6);else if(v.length>=4)v=v.slice(0,3)+"-"+v.slice(3);el.value=v;}'
    + 'document.querySelectorAll("input[type=\'tel\']").forEach(function(el){if(el.value)fmtPhoneInput(el);});'
    + 'function toggleCollapse(btn){var el=btn.closest(".collapse");if(!el)return;el.classList.toggle("collapsed");try{localStorage.setItem("bkc_"+el.getAttribute("data-ckey"),el.classList.contains("collapsed")?"0":"1");}catch(e){}}'
    + 'function openSection(k){var el=document.querySelector(".collapse[data-ckey=\\""+k+"\\"]");if(el){el.classList.remove("collapsed");try{localStorage.setItem("bkc_"+k,"1");}catch(e){}el.scrollIntoView({behavior:"smooth",block:"start"});}}'
    + '(function(){try{var els=document.querySelectorAll(".collapse");for(var i=0;i<els.length;i++){var v=localStorage.getItem("bkc_"+els[i].getAttribute("data-ckey"));if(v==="0")els[i].classList.add("collapsed");}}catch(e){}})();'
    // Keep the Build Quote section open after toggling Edit/New (those links reload the page with ?bq=1).
    + '(function(){try{if(/[?&]bq=1(&|$)/.test(location.search)){var el=document.querySelector(".collapse[data-ckey=\\"buildquote\\"]");if(el)el.classList.remove("collapsed");}}catch(e){}})();'
    + 'function openNav(){document.getElementById("sidebar").classList.add("open");document.getElementById("navOverlay").classList.add("show");}'
    + 'function closeNav(){document.getElementById("sidebar").classList.remove("open");document.getElementById("navOverlay").classList.remove("show");}'
    + 'function copyEmail(btn,addr){var orig=btn.innerHTML;navigator.clipboard.writeText(addr).then(function(){btn.innerHTML="&#10003; Copied!";btn.style.color="#1a7a3a";setTimeout(function(){btn.innerHTML=orig;btn.style.color="";},1600);}).catch(function(){window.location.href="mailto:"+addr;});}'
    + 'var _delForm=null;'
    + 'function showDeleteConfirm(btn){_delForm=btn.closest("form");var n=btn.getAttribute("data-name");document.getElementById("deleteModalName").textContent="You are about to delete: "+n;document.getElementById("deleteModal").classList.add("active");}'
    + 'function closeDeleteModal(){document.getElementById("deleteModal").classList.remove("active");_delForm=null;}'
    + 'function submitDeleteForm(){if(_delForm)_delForm.submit();}'
    + 'document.getElementById("deleteModal").addEventListener("click",function(e){if(e.target===this)closeDeleteModal();});'
    + (vapidKey ? (
        'var _VAPID_KEY=' + JSON.stringify(vapidKey) + ';'
      + 'function _b64u(b){var p="=".repeat((4-b.length%4)%4);var s=(b+p).replace(/-/g,"+").replace(/_/g,"/");var r=atob(s);var o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o;}'
      // ON = solid green bell (filled). OFF = gray bell with a slash. UNSUPPORTED =
      // faint slashed bell with guidance, for browsers that can't do push yet
      // (e.g. an iPhone Safari tab not yet added to the Home Screen).
      + 'var _pushBellOn=' + JSON.stringify(BELL_ON) + ';'
      + 'var _pushBellOff=' + JSON.stringify(BELL_OFF) + ';'
      + 'function _pushSetOn(btn){if(!btn)return;btn.classList.remove("unsupported");btn.classList.add("on");btn.title="Notifications on — tap to turn off";btn.innerHTML=_pushBellOn;}'
      + 'function _pushSetOff(btn){if(!btn)return;btn.classList.remove("on");btn.classList.remove("unsupported");btn.title="Notifications off — tap to enable";btn.innerHTML=_pushBellOff;}'
      + 'function _pushSetUnsupported(btn){if(!btn)return;btn.classList.remove("on");btn.classList.add("unsupported");btn.title="Notifications unavailable in this browser. On iPhone: tap Share, Add to Home Screen, then open Brake Knights from that icon.";btn.innerHTML=_pushBellOff;}'
      + 'function _pushSaveSub(sub,btn){'
      +   'var j=sub.toJSON();'
      +   'fetch("/admin/push/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({endpoint:j.endpoint,p256dh:j.keys.p256dh,auth:j.keys.auth})})'
      +   '.then(function(r){return r.json();})'
      +   '.then(function(d){if(d.ok&&btn)_pushSetOn(btn);})'
      +   '.catch(function(e){console.error("Push save error:",e);});'
      + '}'
      + '(function(){'
      +   'var btn=document.getElementById("push-btn");if(!btn)return;'
      +   'var supported=("serviceWorker" in navigator)&&("PushManager" in window)&&("Notification" in window);'
      +   'if(!supported){_pushSetUnsupported(btn);return;}'
      +   'navigator.serviceWorker.register("/sw.js").then(function(reg){'
      +     'reg.pushManager.getSubscription().then(function(sub){'
      +       'if(!sub){_pushSetOff(btn);return;}'
      +       'fetch("/admin/push/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({endpoint:sub.endpoint})})'
      +       '.then(function(r){return r.json();})'
      +       '.then(function(d){'
      +         'if(d.found){_pushSetOn(btn);}else{'
      +           '_pushSaveSub(sub,btn);'
      +         '}'
      +       '})'
      +       '.catch(function(){_pushSetOn(btn);});'
      +     '});'
      +   '}).catch(function(){_pushSetOff(btn);});'
      + '})();'
      + 'function togglePush(){'
      +   'var btn=document.getElementById("push-btn");'
      +   'if(btn&&btn.classList.contains("unsupported")){alert("To get notifications on your iPhone: open brakeknights.com/admin in Safari, tap the Share button, choose \\"Add to Home Screen,\\" then open Brake Knights from that new icon and tap the bell again.");return;}'
      +   'if(!("serviceWorker" in navigator&&"PushManager" in window))return;'
      +   'navigator.serviceWorker.ready.then(function(reg){'
      +     'reg.pushManager.getSubscription().then(function(sub){'
      +       'if(sub){'
      +         'sub.unsubscribe().then(function(){'
      +           'fetch("/admin/push/unsubscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({endpoint:sub.endpoint})});'
      +           '_pushSetOff(btn);'
      +         '});'
      +       '}else{'
      +         'Notification.requestPermission().then(function(p){'
      +           'if(p!=="granted")return;'
      +           'reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:_b64u(_VAPID_KEY)}).then(function(s){'
      +             '_pushSaveSub(s,btn);'
      +           '}).catch(function(e){console.error("Push subscribe error:",e);});'
      +         '});'
      +       '}'
      +     '});'
      +   '});'
      + '}'
    ) : '')
    // Form draft autosave. Saves every named field of a form to localStorage as the
    // owner types and restores it on next load, so the 30-min idle logout never costs
    // unsaved work: the owner re-authenticates and resumes the exact same draft. Drafts
    // older than 24h are discarded. The optional after() hook lets each form re-derive
    // its widget state (service checkboxes, tier buttons, totals) without re-pulling
    // prices from the pricing table, so manual price overrides are preserved.
    + 'window.bkAutosave=function(form,key,after){'
    +   'if(!form)return;var SK="bkdraft_"+key;var MAX=24*60*60*1000;'
    +   'function flds(){return form.querySelectorAll("input[name],select[name],textarea[name]");}'
    +   'function save(){try{var d={};flds().forEach(function(el){var n=el.name;if(!n)return;if(el.type==="checkbox"){if(!d[n])d[n]=[];if(el.checked)d[n].push(el.value);}else if(el.type==="radio"){if(el.checked)d[n]=el.value;}else{d[n]=el.value;}});localStorage.setItem(SK,JSON.stringify({savedAt:Date.now(),data:d}));}catch(_){}}'
    +   'function restore(){try{var raw=localStorage.getItem(SK);if(!raw)return;var b=JSON.parse(raw);if(!b||!b.data)return;if(b.savedAt&&Date.now()-b.savedAt>MAX){localStorage.removeItem(SK);return;}var d=b.data;flds().forEach(function(el){var n=el.name;if(!(n in d))return;if(el.type==="checkbox"){el.checked=(d[n]||[]).indexOf(el.value)>=0;}else if(el.type==="radio"){el.checked=(d[n]===el.value);}else{el.value=d[n];}});form.querySelectorAll("[data-veh-cascade]").forEach(function(box){var p=box.getAttribute("data-veh-cascade");var y=document.getElementById(p+"-year"),mk=document.getElementById(p+"-make"),hid=document.getElementById(p+"-model-hid");if(window.bkVehFill)window.bkVehFill(p,{year:y?y.value:"",make:mk?mk.value:"",model:hid?hid.value:""});});if(typeof after==="function"){try{after(d);}catch(_){}}}catch(_){}}'
    +   'var t;function deb(){clearTimeout(t);t=setTimeout(save,400);}'
    +   'form.addEventListener("input",deb);form.addEventListener("change",deb);'
    +   'form.addEventListener("submit",function(){try{localStorage.removeItem(SK);}catch(_){}});'
    +   'restore();'
    + '};'
    + 'window.bkClearDraft=function(key){try{localStorage.removeItem("bkdraft_"+key);}catch(_){}};'
    // Auto-init: any form tagged data-autosave is wired here (this runs at end of body,
    // so every form and its helper scripts are already defined). An optional
    // data-autosave-after names a global finalizer the form's own script defines.
    + '(function(){try{document.querySelectorAll("form[data-autosave]").forEach(function(f){var fn=f.getAttribute("data-autosave-after");var after=(fn&&window[fn])?window[fn]:null;bkAutosave(f,f.getAttribute("data-autosave"),after);});}catch(_){}})();'
    // Idle guard: auto-log-out after 30 min of no interaction, and verify the session
    // the instant the tab regains focus after being away. This is the safety net for
    // "I came back hours later" — instead of letting a stale form attempt an action
    // (Send Quote, etc.) on a dead session, it sends the owner to a clean login.
    + '(function(){'
    +   'var IDLE_MS=30*60*1000;var t;'
    +   'function expire(){window.location.href="/admin/logout";}'
    +   'function reset(){clearTimeout(t);t=setTimeout(expire,IDLE_MS);}'
    +   '["mousedown","keydown","touchstart","scroll","click"].forEach(function(ev){document.addEventListener(ev,reset,{passive:true});});'
    +   'reset();'
    +   'document.addEventListener("visibilitychange",function(){'
    +     'if(document.visibilityState!=="visible")return;'
    +     'fetch("/admin/session-status",{headers:{"X-Requested-With":"fetch"}}).then(function(r){return r.json();}).then(function(d){'
    +       'if(!d||!d.authed){window.location.href="/admin/login?error=expired";}else{reset();}'
    +     '}).catch(function(){});'
    +   '});'
    + '})();'
    + '</script>'
    + '</body></html>';
}

// ─── Push notification subscription routes ────────────────────────────────────

router.post('/push/subscribe', requireAuth, express.json(), function(req, res) {
  var b = req.body;
  if (!b || !b.endpoint || !b.p256dh || !b.auth) return res.status(400).json({ ok: false });
  db.prepare(
    'INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth'
  ).run(b.endpoint, b.p256dh, b.auth);
  res.json({ ok: true });
});

router.post('/push/unsubscribe', requireAuth, express.json(), function(req, res) {
  if (req.body && req.body.endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(req.body.endpoint);
  }
  res.json({ ok: true });
});

router.post('/push/verify', requireAuth, express.json(), function(req, res) {
  if (!req.body || !req.body.endpoint) return res.json({ found: false });
  var row = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(req.body.endpoint);
  res.json({ found: !!row });
});

// ─── Auth routes ─────────────────────────────────────────────────────────────

router.get('/login', function(req, res) {
  if (req.session && req.session.adminAuthed) return res.redirect('/admin/appointments');
  var errorHtml = '';
  if (req.query.error === 'locked') {
    errorHtml = '<div class="alert alert-error">Too many failed attempts. Try again in a few minutes.</div>';
  } else if (req.query.error === 'expired') {
    errorHtml = '<div class="alert" style="background:#eef3ff;color:#1a4a7a;border:1px solid #c5d6ef;">You were signed out after 30 minutes of inactivity. Please sign in again to continue.</div>';
  } else if (req.query.error) {
    errorHtml = '<div class="alert alert-error">Incorrect password. Try again.</div>';
  }
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

// Brute-force guard: track failed logins per IP. After MAX_FAILS within the
// window, lock that IP out for LOCK_MS. In-memory is fine for a single-process
// app; it resets on restart, which is acceptable for a sole-owner admin.
var loginFails = new Map(); // ip -> { count, lockedUntil }
var LOGIN_MAX_FAILS = 5;
var LOGIN_LOCK_MS = 15 * 60 * 1000;

function loginClientIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

// Constant-time password check so response timing can't reveal how much of the
// password matched.
function passwordMatches(input) {
  var a = Buffer.from(String(input || ''));
  var b = Buffer.from(String(ADMIN_PASSWORD));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.post('/login', express.urlencoded({ extended: false }), function(req, res) {
  var ip = loginClientIp(req);
  var now = Date.now();
  var rec = loginFails.get(ip);

  if (rec && rec.lockedUntil && rec.lockedUntil > now) {
    return res.redirect('/admin/login?error=locked');
  }

  if (passwordMatches(req.body.password)) {
    loginFails.delete(ip);
    // Prevent session fixation: issue a fresh session id on privilege change.
    req.session.regenerate(function(err) {
      if (err) return res.redirect('/admin/login?error=1');
      req.session.adminAuthed = true;
      res.redirect('/admin/appointments');
    });
    return;
  }

  var next = rec && rec.lockedUntil && rec.lockedUntil > now ? rec : { count: 0, lockedUntil: 0 };
  next.count = (rec ? rec.count : 0) + 1;
  if (next.count >= LOGIN_MAX_FAILS) {
    next.lockedUntil = now + LOGIN_LOCK_MS;
    next.count = 0;
  }
  loginFails.set(ip, next);
  res.redirect('/admin/login?error=' + (next.lockedUntil > now ? 'locked' : '1'));
});

// Lightweight session check for the client-side idle guard. Deliberately NOT behind
// requireAuth so it returns JSON (never a redirect): the browser polls this when the
// tab regains focus to learn whether the session is still alive. Reading the session
// also refreshes the rolling 30-min window when it is valid, which is correct (the
// owner just returned and is active). Returns no customer data.
router.get('/session-status', function(req, res) {
  res.set('Cache-Control', 'no-store');
  res.json({ authed: !!(req.session && req.session.adminAuthed) });
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
  if (!lead) return res.redirect('/admin');
  if (lead.status !== status) {
    var statusLabels = { new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', quote_accepted: 'Quote Accepted', booked: 'Booked', completed: 'Completed', receipt: 'Receipt Sent' };
    db.prepare("UPDATE leads SET status = ?, status_updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
    logHistory(lead.id, 'Status changed to ' + (statusLabels[status] || status));
    sendStagePush(lead, status);
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
  if (!lead) return res.redirect('/admin');
  db.prepare("UPDATE leads SET archived = 1, archived_at = datetime('now') WHERE id = ?").run(lead.id);
  logHistory(lead.id, 'Lead archived');
  res.redirect(req.body.back || '/admin');
});

router.post('/lead/:id/restore', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.redirect('/admin');
  db.prepare("UPDATE leads SET archived = 0, archived_at = NULL WHERE id = ?").run(lead.id);
  logHistory(lead.id, 'Lead restored from archive');
  res.redirect(req.body.back || '/admin?status=archived');
});

router.post('/lead/:id/delete', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.redirect(req.body.back || '/admin');
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
  if (!lead) return res.redirect('/admin');
  var vin = (req.body.vin || '').trim() || null;
  var notes = (req.body.internalNotes || '').trim() || null;
  db.prepare('UPDATE leads SET vin = ?, internal_notes = ? WHERE id = ?').run(vin, notes, lead.id);
  if ((lead.vin || '') !== (vin || '') || (lead.internal_notes || '') !== (notes || '')) {
    logHistory(lead.id, 'VIN / internal notes updated');
  }
  res.redirect('/admin/quote/' + lead.id + '?msg=notes_saved');
});

// Lead-level customer interaction notes — a running log of calls/texts/conversations,
// stored separately from internal notes. Saved independently of any quote.
router.post('/lead/:id/interaction-notes', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.redirect('/admin');
  var notes = (req.body.interactionNotes || '').trim() || null;
  db.prepare('UPDATE leads SET interaction_notes = ? WHERE id = ?').run(notes, lead.id);
  if ((lead.interaction_notes || '') !== (notes || '')) {
    logHistory(lead.id, 'Interaction notes updated');
  }
  res.redirect('/admin/quote/' + lead.id + '?msg=interaction_saved');
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
  if (!lead) return res.redirect('/admin');
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id);
  if (!quote) return res.redirect('/admin/quote/' + lead.id + '?msg=no_accepted_quote');

  db.prepare("UPDATE leads SET status = 'booked', status_updated_at = datetime('now') WHERE id = ?").run(lead.id);
  // Mark the accepted quote as approved so it appears on the appointments calendar
  // and powers the reschedule/cancel flows, which all key off status = 'approved'.
  db.prepare("UPDATE quotes SET status = 'approved' WHERE id = ?").run(quote.id);
  logHistory(lead.id, 'Time approved', (quote.pref_date || '') + (quote.pref_time ? ' at ' + quote.pref_time : '') + (quote.pref_location ? ', ' + quote.pref_location : ''));
  if (lead.status !== 'booked') sendStagePush(lead, 'booked');

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
        + (gcalUrl ? '<a href="' + gcalUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 28px;border-radius:8px;margin:0 4px 8px;">' + ic('calendar') + 'Add to Google Calendar</a>' : '')
        + '<a href="' + calendarUrl + '" style="display:inline-block;background:#0a1f3d;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 28px;border-radius:8px;margin:0 4px 8px;">' + ic('calendar') + 'Apple / Outlook (.ics)</a>'
        + '<p style="color:#888;font-size:0.8rem;margin:6px 0 0;">Google Calendar opens in your browser. The .ics works with Apple Calendar and Outlook.</p>'
        + '</div>'
        + '<p style="color:#6b5900;background:#fffbea;border:1px solid #e8d87a;border-radius:6px;padding:10px 14px;line-height:1.55;margin:0 0 24px;font-size:0.84rem;"><strong>Inspection note:</strong> If we arrive and determine no brake service is needed, a $60 inspection fee applies. If repairs are needed, the inspection fee is applied toward the cost of the repair — no extra charge.</p>'
        + '<div style="text-align:center;margin:0 0 24px;">'
        + '<p style="color:#888;font-size:0.85rem;margin:0 0 10px;">Need to make a change?</p>'
        + '<a href="' + baseUrl + '/quote/' + quote.id + '/' + quote.accept_token + '?action=reschedule" style="display:inline-block;background:#fff;border:2px solid #4169e1;color:#4169e1;font-weight:700;font-size:0.9rem;text-decoration:none;padding:11px 22px;border-radius:8px;margin:0 4px 8px;">Reschedule</a>'
        + '<a href="' + baseUrl + '/quote/' + quote.id + '/' + quote.accept_token + '?action=cancel" style="display:inline-block;background:#fff;border:2px solid #c0392b;color:#c0392b;font-weight:700;font-size:0.9rem;text-decoration:none;padding:11px 22px;border-radius:8px;margin:0 4px 8px;">Cancel Appointment</a>'
        + '</div>'
        + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
        + '<p style="color:#fff;font-weight:700;margin:0 0 8px;">Questions? Call or text:</p>'
        + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
        + '</div></div>'
        + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div></div>';
      await tx.sendMail({ from: '"Brake Knights" <greetings@brakeknights.com>', to: lead.email, cc: 'greetings@brakeknights.com', subject: 'Your appointment is confirmed — Brake Knights', html });
    } catch (err) { console.error('Approve schedule email error:', err.message); }
  }
  res.redirect('/admin/quote/' + lead.id + '?msg=approved');
});

router.get('/quote/:id/deny-schedule', requireAuth, function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.redirect('/admin');
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id);
  var reqTime = quote ? fmtPrefDate(quote.pref_date) + (quote.pref_time ? ' at ' + quote.pref_time : '') : 'the requested time';

  var body = '<a href="/admin/quote/' + lead.id + '" class="back-link"><span class="bk-arrow">&#8592;</span>Back</a>'
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
  if (!lead) return res.redirect('/admin');
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
      await tx.sendMail({ from: '"Brake Knights" <greetings@brakeknights.com>', to: lead.email, cc: 'greetings@brakeknights.com', replyTo: 'greetings@brakeknights.com', subject: 'Scheduling update from Brake Knights', html });
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
      "SELECT * FROM leads WHERE status != 'receipt' AND archived = 0 AND (first_name || ' ' || last_name LIKE ? OR phone LIKE ? OR email LIKE ? OR vehicle LIKE ? OR service LIKE ?) ORDER BY id DESC"
    ).all(sp, sp, sp, sp, sp);
  } else if (status === 'archived') {
    leads = db.prepare('SELECT * FROM leads WHERE archived = 1 ORDER BY archived_at DESC, id DESC').all();
  } else if (status === 'all') {
    leads = db.prepare("SELECT * FROM leads WHERE archived = 0 AND status != 'receipt' ORDER BY id DESC").all();
  } else {
    leads = db.prepare("SELECT * FROM leads WHERE status = ? AND archived = 0 ORDER BY id DESC").all(status);
  }

  var counts = db.prepare("SELECT status, COUNT(*) as n FROM leads WHERE archived = 0 AND status != 'receipt' GROUP BY status").all()
    .reduce(function(acc, r) { acc[r.status] = r.n; return acc; }, {});
  var total = db.prepare("SELECT COUNT(*) as n FROM leads WHERE archived = 0 AND status != 'receipt'").get().n;
  var archivedCount = db.prepare('SELECT COUNT(*) as n FROM leads WHERE archived = 1').get().n;
  // Receipt Sent leads are kept out of the active pipeline (All view + counts above)
  // but still reachable via this tab so they can be found, edited, or deleted.
  var receiptCount = db.prepare("SELECT COUNT(*) as n FROM leads WHERE archived = 0 AND status = 'receipt'").get().n;

  var tabs = [
    ['all',            'All',            total],
    ['new',            'New',            counts.new            || 0],
    ['quoted',         'Quoted',         counts.quoted         || 0],
    ['follow_up',      'Follow Up',      counts.follow_up      || 0],
    ['quote_accepted', 'Quote Accepted', counts.quote_accepted || 0],
    ['booked',         'Booked',         counts.booked         || 0],
    ['completed',      'Completed',      counts.completed      || 0],
    ['receipt',        'Receipt Sent',   receiptCount          || 0],
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
    ? '<div class="empty"><div style="margin-bottom:10px;">' + icon('clipboard') + '</div>' + emptyMsg + '</div>'
    : leads.map(function(l) {
        return leadCard(l, { management: true, back: '/admin?status=' + status + (search ? '&q=' + encodeURIComponent(search) : '') });
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

// ─── Custom line items (e.g. OEM parts upgrade) ───────────────────────────────
// A custom line item is { label, amount }. It renders as its own priced row in the
// customer quote/receipt email, is taxed as parts (added to the taxable base), and
// is stored separate from `service` so it never affects per-service reporting.
// Both the quote builder and receipt builder use these shared helpers; each page
// defines bkRecalc() so a line-item change re-runs that form's price calc.

// Parses a stored JSON array safely; always returns an array of normalized items
// { label, amount, taxed }. taxed defaults to true unless explicitly false, so
// items saved before the taxed/not-taxed toggle existed keep being taxed as parts.
function parseLineItems(json) {
  try {
    var a = JSON.parse(json || '[]');
    if (!Array.isArray(a)) return [];
    return a.filter(function(it){ return it && it.label; }).map(function(it){
      return { label: String(it.label), amount: Number(it.amount) || 0, taxed: it.taxed !== false };
    });
  } catch (_) { return []; }
}

// Server-rendered row used to prefill saved line items. The Taxed/Not-taxed
// button carries its state in data-taxed; cliInit() applies its label and style
// on page load so server and client rows look identical.
function cliRowServer(label, amount, taxed) {
  return '<div class="cli-row" style="display:flex;gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap;">'
    + '<input type="text" class="cli-label" placeholder="e.g. OEM Brake Pads &amp; Rotors" value="' + esc(label || '') + '" oninput="cliChanged()" style="flex:1;min-width:140px;padding:9px 11px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.92rem;">'
    + '<input type="number" class="cli-amount" placeholder="0" min="0" step="0.01" value="' + (amount != null && amount !== '' ? esc(String(amount)) : '') + '" oninput="cliChanged()" onfocus="this.select()" style="width:90px;flex-shrink:0;padding:9px 8px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.92rem;text-align:right;">'
    + '<button type="button" class="cli-tax" data-taxed="' + (taxed === false ? '0' : '1') + '" onclick="cliToggleTax(this)"></button>'
    + '<button type="button" class="cli-x" onclick="cliRemove(this)" title="Remove" style="background:none;border:none;color:#c0392b;font-size:1.05rem;cursor:pointer;padding:0 4px;flex-shrink:0;">&#10005;</button>'
    + '</div>';
}

// The form section (label + prefilled rows + Add button + hidden JSON field).
function customLineItemsSection(items) {
  items = Array.isArray(items) ? items : [];
  return '<div class="form-group" style="margin-bottom:0;">'
    + '<label>Custom line items <span style="color:#bbb;font-weight:400;">(optional — e.g. OEM parts; shows as its own priced line, taxed as parts, not counted in service reports)</span></label>'
    + '<div id="cliRows">' + items.map(function(it){ return cliRowServer(it.label, it.amount, it.taxed); }).join('') + '</div>'
    + '<button type="button" class="svc-clear-btn" style="margin-top:6px;" onclick="cliAdd()">+ Add line item</button>'
    + '<input type="hidden" name="customLineItems" id="cliJson" value="' + esc(JSON.stringify(items)) + '">'
    + '</div>';
}

// Client JS shared by both forms. cliSum() feeds each form's calc; cliChanged()
// re-runs the page's bkRecalc(). Guarded so it is a no-op when the section is absent.
var CLI_JS = ''
  + 'var CLI_ON="background:#eef2ff;border:1.5px solid #c3d4f5;color:#1a3a7a;";'
  + 'var CLI_OFF="background:#f4f4f5;border:1.5px solid #e0e0e3;color:#777;";'
  + 'var CLI_BASE="padding:8px 9px;border-radius:8px;font-size:0.76rem;font-weight:600;cursor:pointer;flex-shrink:0;white-space:nowrap;width:84px;text-align:center;";'
  + 'function cliSetTax(btn,taxed){btn.setAttribute("data-taxed",taxed?"1":"0");btn.textContent=taxed?"Taxed":"Not taxed";btn.style.cssText=CLI_BASE+(taxed?CLI_ON:CLI_OFF);}'
  + 'function cliToggleTax(btn){cliSetTax(btn,btn.getAttribute("data-taxed")==="0");cliChanged();}'
  + 'function cliInit(){document.querySelectorAll("#cliRows .cli-tax").forEach(function(b){cliSetTax(b,b.getAttribute("data-taxed")!=="0");});}'
  + 'function cliRowHtml(){'
  +   'return "<div class=\'cli-row\' style=\'display:flex;gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap;\'>"'
  +     '+"<input type=\'text\' class=\'cli-label\' placeholder=\'e.g. OEM Brake Pads &amp; Rotors\' oninput=\'cliChanged()\' style=\'flex:1;min-width:140px;padding:9px 11px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.92rem;\'>"'
  +     '+"<input type=\'number\' class=\'cli-amount\' placeholder=\'0\' min=\'0\' step=\'0.01\' oninput=\'cliChanged()\' onfocus=\'this.select()\' style=\'width:90px;flex-shrink:0;padding:9px 8px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.92rem;text-align:right;\'>"'
  +     '+"<button type=\'button\' class=\'cli-tax\' data-taxed=\'1\' onclick=\'cliToggleTax(this)\'><\\/button>"'
  +     '+"<button type=\'button\' class=\'cli-x\' onclick=\'cliRemove(this)\' title=\'Remove\' style=\'background:none;border:none;color:#c0392b;font-size:1.05rem;cursor:pointer;padding:0 4px;flex-shrink:0;\'>&#10005;<\\/button>"'
  +   '+"<\\/div>";'
  + '}'
  + 'function cliAdd(){var w=document.createElement("div");w.innerHTML=cliRowHtml();var row=w.firstChild;document.getElementById("cliRows").appendChild(row);cliSetTax(row.querySelector(".cli-tax"),true);}'
  + 'function cliRemove(btn){var r=btn.closest(".cli-row");if(r)r.remove();cliChanged();}'
  + 'function cliCollect(){var items=[];document.querySelectorAll("#cliRows .cli-row").forEach(function(row){var label=(row.querySelector(".cli-label").value||"").trim();var amount=parseFloat(row.querySelector(".cli-amount").value)||0;var taxed=(row.querySelector(".cli-tax").getAttribute("data-taxed")!=="0");if(label)items.push({label:label,amount:amount,taxed:taxed});});var h=document.getElementById("cliJson");if(h)h.value=JSON.stringify(items);return items;}'
  + 'function cliTaxedSum(){return cliCollect().reduce(function(a,it){return a+(it.taxed?(it.amount||0):0);},0);}'
  + 'function cliSum(){return cliCollect().reduce(function(a,it){return a+(it.amount||0);},0);}'
  + 'function cliChanged(){if(typeof bkRecalc==="function")bkRecalc();}';

// ─── Shared QUOTE pricing block (canonical: per-service breakdown) ─────────────
// One renderer + one JS wiring for the quote pricing UI, used by every quote
// surface (Build Quote, Quick Quote, New/Edit Appointment). Each surface passes a
// unique id `pfx` so multiple instances never collide, but the STRUCTURE, classes,
// fields, and math are identical everywhere. The model is the Quick Quote style:
// each selected service gets its own auto-filled Parts/Labor row (with a per-row
// Combined / Split P/L toggle), plus Shop Supplies, VA tax, custom line items, a
// Discount (applied after tax), a customer summary, and a Notes-to-customer box.
//
// Submitted field names (identical on every surface):
//   service            comma-joined service string (hidden, kept in sync)
//   customService      free-text extra service
//   tier               standard | premium
//   shopSupplies       number
//   taxRate            percent
//   parts, labor       aggregate parts/labor totals (hidden, summed from rows)
//   svcLineItems       JSON array of {service, parts, labor, mode}
//   customLineItems    JSON array (custom priced rows; see customLineItemsSection)
//   discount           number (applied after tax)
//   taxAmt, totalAmt   computed numbers (hidden)
//   customerNotes      free text shown in the quote email
//
// `quoteParseBody(req.body)` on the server turns those back into a normalized
// object every POST handler can use.

// Services that book per-wheel position (caliper, hose). Mirrors the Quick Quote
// position map so position picking is identical on every quote surface.
var QUOTE_POSITION_SVCS = {
  'Caliper Replacement':    { prefix: 'Caliper',    label: 'Caliper',    positions: ['Front Left', 'Front Right', 'Rear Left', 'Rear Right'] },
  'Brake Hose Replacement': { prefix: 'Brake Hose', label: 'Brake Hose', positions: ['Front Left', 'Front Right', 'Rear Left', 'Rear Right'] }
};

// Service checkbox list (with per-position groups for caliper/hose) for a quote
// surface. `pfx` namespaces the checkbox handlers/ids; `serviceNames` is the list
// of services; `selected` is an array of already-selected plain service names.
function quoteServiceCheckboxes(pfx, serviceNames, selected) {
  selected = selected || [];
  return '<div class="svc-check-list">'
    + serviceNames.map(function(s) {
        var posCfg = QUOTE_POSITION_SVCS[s];
        if (posCfg) {
          return '<div class="svc-pos-group" style="margin:4px 0 8px;">'
            + '<div style="font-size:0.78rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.4px;padding:4px 0 6px;">' + esc(posCfg.label) + '</div>'
            + '<div style="padding-left:4px;">'
            + posCfg.positions.map(function(pos) {
                var nm = posCfg.prefix + ' - ' + pos;
                var checked = selected.indexOf(nm) !== -1 ? ' checked' : '';
                return '<label class="svc-check-item" style="margin-bottom:3px;">'
                  + '<input type="checkbox" class="' + pfx + '-pos-cb" data-parent="' + esc(s) + '" data-prefix="' + esc(posCfg.prefix) + '" data-pos="' + esc(pos) + '"' + checked + ' onchange="' + pfx + 'PosCbChange(this)">'
                  + '<span class="svc-box"></span>' + esc(pos) + '</label>';
              }).join('')
            + '</div></div>';
        }
        var checked = selected.indexOf(s) !== -1 ? ' checked' : '';
        return '<label class="svc-check-item"><input type="checkbox" class="' + pfx + '-svc-cb" value="' + esc(s) + '"' + checked + ' onchange="' + pfx + 'SvcCbChange(this)"><span class="svc-box"></span>' + esc(s) + '</label>';
      }).join('')
    + '</div>'
    + '<input type="hidden" name="service" id="' + pfx + 'svcHidden" value="' + esc(selected.join(', ')) + '">';
}

// The full quote pricing block markup. `pfx` is the unique id prefix. `opts`:
//   serviceNames  array of service names (required)
//   selected      array of selected plain service names
//   customSvc     prefill for the custom-service field
//   tier          'standard' | 'premium'
//   shopSupplies  number prefill
//   taxPct        tax rate percent prefill
//   discount      number prefill
//   lineItems     custom line items (customLineItemsSection)
//   customerNotes prefill for the notes-to-customer textarea
//   showTier      include the Tier toggle + service picker (default true)
//   showCustomerNotes  include the Notes-to-customer block (default true)
function quotePricingBlock(pfx, opts) {
  opts = opts || {};
  var tier = opts.tier === 'premium' ? 'premium' : 'standard';
  var taxPct = opts.taxPct != null ? opts.taxPct : +(PRICING.taxRate * 100).toFixed(2);
  var discount = Math.round(Number(opts.discount) || 0);
  var discountLabel = opts.discountLabel || '';
  var ss = Math.round(Number(opts.shopSupplies) || 0);
  var showNotes = opts.showCustomerNotes !== false;
  return ''
    // Tier
    + '<div class="form-group" style="margin:0 0 14px;"><label>Tier</label>'
    + '<div class="tier-toggle">'
    + '<button type="button" class="tier-btn' + (tier === 'standard' ? ' active' : '') + '" id="' + pfx + 'BtnStd" onclick="' + pfx + 'SetTier(\'standard\')">Standard</button>'
    + '<button type="button" class="tier-btn' + (tier === 'premium' ? ' active' : '') + '" id="' + pfx + 'BtnPrem" onclick="' + pfx + 'SetTier(\'premium\')">Premium</button>'
    + '</div>'
    + '<input type="hidden" name="tier" id="' + pfx + 'tier" value="' + esc(tier) + '"></div>'
    // Services
    + '<div class="form-group" style="margin-bottom:6px;"><label>Service <span style="color:#bbb;font-weight:400;">(select all that apply)</span></label>'
    + quoteServiceCheckboxes(pfx, opts.serviceNames || [], opts.selected || [])
    + '<button type="button" class="svc-clear-btn" onclick="' + pfx + 'ClearServices()">&#10005; Clear selection</button>'
    + '<div class="svc-tags" id="' + pfx + 'svcTags"></div>'
    + '<div id="' + pfx + 'CustomHint" style="display:none;background:#fff8e1;border:1px solid #f0d080;border-radius:8px;padding:10px 12px;margin-top:10px;font-size:0.83rem;color:#7a5a00;"></div>'
    + '<div class="form-group" style="margin:14px 0 6px;">'
    + '<label>Custom service <span style="color:#bbb;font-weight:400;">(optional, type any service not listed above)</span></label>'
    + '<input type="text" id="' + pfx + 'CustomSvc" name="customService" value="' + esc(opts.customSvc || '') + '" placeholder="e.g. Tie Rod End Replacement, Wheel Bearing" oninput="' + pfx + 'OnCustomSvc()" style="width:100%;padding:10px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.95rem;">'
    + '</div>'
    + '</div>'
    // Internal per-service price breakdown
    + '<div class="price-section">'
    + '<div class="price-section-header">Internal Breakdown <span style="font-weight:400;text-transform:none;letter-spacing:0;">(not sent to customer — Combined/Split P/L per service above)</span></div>'
    + '<div id="' + pfx + 'SvcPriceRows"></div>'
    + '<div class="price-row"><span class="price-label">Shop Supplies</span>'
    + '<input class="price-input" type="number" name="shopSupplies" id="' + pfx + 'ss" min="0" step="0.01" value="' + ss + '" oninput="' + pfx + 'calc()" onfocus="this.select()"></div>'
    + '<div class="price-row tax-row"><span class="price-label" style="display:flex;align-items:center;gap:5px;">VA Tax (<input class="tax-rate-input" type="number" name="taxRate" id="' + pfx + 'tr" min="0" max="20" step="0.1" value="' + fmt(taxPct) + '" oninput="' + pfx + 'calc()">%) on Parts + Supplies</span>'
    + '<span id="' + pfx + 'taxAmt">$0.00</span></div>'
    + '</div>'
    // Custom line items
    + '<div style="margin:4px 0 16px;">' + customLineItemsSection(opts.lineItems || []) + '</div>'
    // Customer-facing summary
    + '<div class="price-section" style="margin-bottom:0;">'
    + '<div class="price-section-header"><span id="' + pfx + 'SummaryLabel">Customer Quote</span></div>'
    + '<div id="' + pfx + 'SvcCustomerRows"></div>'
    + '<div id="cliDisplayRows"></div>'
    + '<div class="price-row"><span class="price-label">Shop Supplies</span><span id="' + pfx + 'ssDisplay">$0.00</span></div>'
    + '<div class="price-row tax-row"><span class="price-label">Tax</span><span id="' + pfx + 'taxDisplay">$0.00</span></div>'
    + '<div class="price-row"><span class="price-label" style="flex:1;min-width:0;">Discount <span class="price-note">(applied after tax)</span>'
    + '<input class="price-input" type="text" name="discount_label" id="' + pfx + 'discLabel" value="' + esc(discountLabel) + '" placeholder="reason shown to customer (optional)" style="display:block;width:100%;max-width:260px;margin-top:5px;font-size:0.82rem;text-align:left;padding:5px 8px;"></span>'
    + '<input class="price-input" type="number" name="discount" id="' + pfx + 'disc" min="0" step="0.01" value="' + discount + '" oninput="' + pfx + 'calc()" onfocus="this.select()"></div>'
    + '<div class="price-row total-row divider-row"><span id="' + pfx + 'TotalLabel">Total</span><span id="' + pfx + 'totalAmt" style="font-size:1.15rem;">$0.00</span></div>'
    + '</div>'
    + '<input type="hidden" name="parts"   id="' + pfx + 'partsH"   value="0.00">'
    + '<input type="hidden" name="labor"   id="' + pfx + 'laborH"   value="0.00">'
    + '<input type="hidden" name="svcLineItems" id="' + pfx + 'svcLiH" value="[]">'
    + '<input type="hidden" name="taxAmt"  id="' + pfx + 'taxH"  value="0.00">'
    + '<input type="hidden" name="totalAmt" id="' + pfx + 'totalH" value="0.00">'
    + (showNotes
        ? '<div class="form-group" style="margin:16px 0 6px;"><label>Notes to customer <span style="color:#bbb;font-weight:400;">(optional — included in the quote email)</span></label>'
          + '<textarea name="customerNotes" id="' + pfx + 'CustNotes" placeholder="e.g. Parts are in stock; we can usually schedule within 1-2 business days. Reach out anytime with questions." style="width:100%;min-height:74px;padding:10px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.9rem;resize:vertical;box-sizing:border-box;">' + esc(opts.customerNotes || '') + '</textarea></div>'
        : '');
}

// The JS wiring for a quote pricing block. `pfx` must match quotePricingBlock.
// Requires CLI_JS, a `money()` helper, and a `<pfx>PRICING` global (the effective
// pricing JSON) to be emitted on the page before this. Optionally a surface can
// define `<pfx>AfterChange()` to react to any service/price change (e.g. autosave).
function quotePricingJs(pfx) {
  var P = pfx;
  return ''
    + 'var ' + P + 'tier="standard";'
    + 'function ' + P + 'CheckedServices(){return Array.from(document.querySelectorAll(".' + P + '-svc-cb:checked")).map(function(c){return c.value;});}'
    + 'function ' + P + 'CustomSvcVal(){var el=document.getElementById("' + P + 'CustomSvc");return el?el.value.trim():"";}'
    + 'function ' + P + 'GetAllServiceNames(){'
    +   'var names=[];'
    +   'document.querySelectorAll(".' + P + '-svc-cb:checked").forEach(function(cb){names.push(cb.value);});'
    +   'document.querySelectorAll(".' + P + '-pos-cb:checked").forEach(function(pos){names.push(pos.getAttribute("data-prefix")+" - "+pos.getAttribute("data-pos"));});'
    +   'return names;'
    + '}'
    + 'function ' + P + 'UpdateServiceHidden(){'
    +   'var all=' + P + 'GetAllServiceNames().slice();var cv=' + P + 'CustomSvcVal();if(cv)all.push(cv);'
    +   'document.getElementById("' + P + 'svcHidden").value=all.join(", ");'
    + '}'
    + 'var ' + P + 'PFX_MAP={"Caliper":"Caliper Replacement","Brake Hose":"Brake Hose Replacement"};'
    + 'function ' + P + 'AddPriceRow(svcName){'
    +   'if(document.querySelector("#' + P + 'SvcPriceRows .svc-price-row[data-base=\'"+svcName+"\']"))return;'
    +   'var pfx=svcName.split(" - ");var lookupKey=pfx.length===2&&' + P + 'PFX_MAP[pfx[0]]?' + P + 'PFX_MAP[pfx[0]]:svcName;'
    +   'var p=' + P + 'PRICING[lookupKey];var td=p&&(p[' + P + 'tier]||p.standard);'
    +   'var dParts=td?td.parts:0;var dLabor=td?td.labor:0;var dSS=td?td.shopSupplies:0;'
    +   'var row=document.createElement("div");row.className="svc-price-row";row.setAttribute("data-base",svcName);'
    +   'row.innerHTML='
    +     '"<div class=\'svc-price-title\' style=\'font-size:0.82rem;font-weight:700;color:#0a1f3d;padding:6px 0 4px;display:flex;align-items:center;justify-content:space-between;\'>"'
    +     '+"<span>"+svcName+"</span>"'
    +     '+"<div class=\'tier-toggle\' style=\'margin:0;\'>"'
    +     '+"<button type=\'button\' class=\'tier-btn active svc-disp-btn\' onclick=\'' + P + 'RowMode(this,\\\"combined\\\")\' style=\'padding:3px 9px;font-size:0.75rem;\'>Combined</button>"'
    +     '+"<button type=\'button\' class=\'tier-btn svc-disp-btn\' onclick=\'' + P + 'RowMode(this,\\\"split\\\")\' style=\'padding:3px 9px;font-size:0.75rem;\'>Split P/L</button>"'
    +     '+"</div></div>"'
    +     '+"<input type=\'hidden\' class=\'svc-row-mode\' value=\'combined\'>"'
    +     '+"<div class=\'price-row\'><span class=\'price-label\'>Parts</span><input class=\'price-input ' + P + '-parts-in\' type=\'number\' min=\'0\' step=\'0.01\' value=\'"+(dParts.toFixed(2))+"\' oninput=\'' + P + 'calc()\' onfocus=\'this.select()\'></div>"'
    +     '+"<div class=\'price-row\'><span class=\'price-label\'>Labor <span class=\'price-note\'>(not taxed)</span></span><input class=\'price-input ' + P + '-labor-in\' type=\'number\' min=\'0\' step=\'0.01\' value=\'"+(dLabor.toFixed(2))+"\' oninput=\'' + P + 'calc()\' onfocus=\'this.select()\'></div>"'
    +     '+"<hr style=\'border:none;border-top:1px solid #eef1f5;margin:6px 0 4px;\'>";'
    +   'if(dSS>0){var curSS=parseFloat(document.getElementById("' + P + 'ss").value)||0;document.getElementById("' + P + 'ss").value=(curSS+dSS).toFixed(2);}'
    +   'document.getElementById("' + P + 'SvcPriceRows").appendChild(row);'
    + '}'
    + 'function ' + P + 'RowMode(btn,mode){'
    +   'var row=btn.closest(".svc-price-row");'
    +   'row.querySelectorAll(".svc-disp-btn").forEach(function(b){b.classList.toggle("active",b===btn);});'
    +   'row.querySelector(".svc-row-mode").value=mode;' + P + 'calc();if(typeof ' + P + 'AfterChange==="function")' + P + 'AfterChange();'
    + '}'
    + 'function ' + P + 'RemovePriceRow(svcName){'
    +   'var row=document.querySelector("#' + P + 'SvcPriceRows .svc-price-row[data-base=\'"+svcName+"\']");'
    +   'if(row)row.parentNode.removeChild(row);'
    + '}'
    + 'function ' + P + 'SvcCbChange(cb){'
    +   'if(cb.checked)' + P + 'AddPriceRow(cb.value);else ' + P + 'RemovePriceRow(cb.value);'
    +   P + 'UpdateServiceHidden();' + P + 'RenderTags();' + P + 'Hints();' + P + 'calc();if(typeof ' + P + 'AfterChange==="function")' + P + 'AfterChange();'
    + '}'
    + 'function ' + P + 'PosCbChange(cb){'
    +   'var rowName=cb.getAttribute("data-prefix")+" - "+cb.getAttribute("data-pos");'
    +   'if(cb.checked)' + P + 'AddPriceRow(rowName);else ' + P + 'RemovePriceRow(rowName);'
    +   P + 'UpdateServiceHidden();' + P + 'RenderTags();' + P + 'Hints();' + P + 'calc();if(typeof ' + P + 'AfterChange==="function")' + P + 'AfterChange();'
    + '}'
    + 'function ' + P + 'UpdateRowPrices(){'
    +   'Array.from(document.querySelectorAll("#' + P + 'SvcPriceRows .svc-price-row")).forEach(function(r){'
    +     'var base=r.getAttribute("data-base");var pfx=base.split(" - ");var key=pfx.length===2&&' + P + 'PFX_MAP[pfx[0]]?' + P + 'PFX_MAP[pfx[0]]:base;'
    +     'var p=' + P + 'PRICING[key];if(!p||p.customQuote)return;'
    +     'var td=p[' + P + 'tier]||p.standard;if(!td)return;'
    +     'r.querySelector(".' + P + '-parts-in").value=td.parts.toFixed(2);'
    +     'r.querySelector(".' + P + '-labor-in").value=td.labor.toFixed(2);'
    +   '});'
    + '}'
    + 'function ' + P + 'SetTier(t){'
    +   P + 'tier=t;document.getElementById("' + P + 'tier").value=t;'
    +   'document.getElementById("' + P + 'BtnStd").classList.toggle("active",t==="standard");'
    +   'document.getElementById("' + P + 'BtnPrem").classList.toggle("active",t==="premium");'
    +   P + 'UpdateRowPrices();' + P + 'UpdateServiceHidden();' + P + 'RenderTags();' + P + 'Hints();' + P + 'calc();if(typeof ' + P + 'AfterChange==="function")' + P + 'AfterChange();'
    + '}'
    + 'function ' + P + 'RenderTags(){'
    +   'var tags=' + P + 'GetAllServiceNames().map(function(n){'
    +     'return "<span class=\'svc-tag\'><button type=\'button\' class=\'svc-tag-x\' onclick=\'' + P + 'RemoveTag(this)\' data-val=\'"+n+"\'>&#10005;</button>"+n+"</span>";'
    +   '});'
    +   'var cv=' + P + 'CustomSvcVal();'
    +   'if(cv)tags.push("<span class=\'svc-tag\' style=\'background:#e07000;\'><button type=\'button\' class=\'svc-tag-x\' onclick=\'' + P + 'ClearCustomSvc()\'>&#10005;</button>"+cv+" <em style=\'opacity:.8;font-style:normal;font-size:0.72rem;\'>(custom)</em></span>");'
    +   'document.getElementById("' + P + 'svcTags").innerHTML=tags.join("");'
    + '}'
    + 'function ' + P + 'RemoveTag(btn){'
    +   'var val=btn.getAttribute("data-val");'
    +   'var posCb=Array.from(document.querySelectorAll(".' + P + '-pos-cb")).find(function(c){return(c.getAttribute("data-prefix")+" - "+c.getAttribute("data-pos"))===val;});'
    +   'if(posCb){posCb.checked=false;' + P + 'RemovePriceRow(val);}'
    +   'else{var cb=Array.from(document.querySelectorAll(".' + P + '-svc-cb")).find(function(c){return c.value===val;});if(cb){cb.checked=false;' + P + 'RemovePriceRow(val);}}'
    +   P + 'UpdateServiceHidden();' + P + 'RenderTags();' + P + 'Hints();' + P + 'calc();if(typeof ' + P + 'AfterChange==="function")' + P + 'AfterChange();'
    + '}'
    + 'function ' + P + 'ClearCustomSvc(){var el=document.getElementById("' + P + 'CustomSvc");if(el)el.value="";' + P + 'UpdateServiceHidden();' + P + 'RenderTags();if(typeof ' + P + 'AfterChange==="function")' + P + 'AfterChange();}'
    + 'function ' + P + 'OnCustomSvc(){' + P + 'UpdateServiceHidden();' + P + 'RenderTags();if(typeof ' + P + 'AfterChange==="function")' + P + 'AfterChange();}'
    + 'function ' + P + 'ClearServices(){'
    +   'document.querySelectorAll(".' + P + '-svc-cb").forEach(function(cb){cb.checked=false;});'
    +   'document.querySelectorAll(".' + P + '-pos-cb").forEach(function(c){c.checked=false;});'
    +   'document.getElementById("' + P + 'SvcPriceRows").innerHTML="";'
    +   'document.getElementById("' + P + 'ss").value="0.00";'
    +   P + 'UpdateServiceHidden();' + P + 'RenderTags();' + P + 'Hints();' + P + 'calc();if(typeof ' + P + 'AfterChange==="function")' + P + 'AfterChange();'
    + '}'
    + 'function ' + P + 'Hints(){'
    +   'var names=' + P + 'GetAllServiceNames();var msgs=[];'
    +   'var custom=names.filter(function(n){var pfx=n.split(" - ");var key=pfx.length===2&&' + P + 'PFX_MAP[pfx[0]]?' + P + 'PFX_MAP[pfx[0]]:n;return ' + P + 'PRICING[key]&&' + P + 'PRICING[key].customQuote;});'
    +   'if(custom.length){msgs.push("<strong>Custom quote:</strong> "+custom.join(", ")+" "+(custom.length>1?"have":"has")+" no preset price. Look up the exact part(s) and enter Parts and Labor manually.");}'
    +   'names.forEach(function(n){var pfx=n.split(" - ");var key=pfx.length===2&&' + P + 'PFX_MAP[pfx[0]]?' + P + 'PFX_MAP[pfx[0]]:n;if(' + P + 'PRICING[key]&&' + P + 'PRICING[key].note){msgs.push(' + P + 'PRICING[key].note);}});'
    +   'var box=document.getElementById("' + P + 'CustomHint");'
    +   'if(box){if(msgs.length){box.innerHTML=msgs.join("<br><br>");box.style.display="block";}else{box.style.display="none";}}'
    + '}'
    + 'function ' + P + 'calc(){'
    +   'var parts=0,labor=0;'
    +   'document.querySelectorAll(".' + P + '-parts-in").forEach(function(el){parts+=parseFloat(el.value)||0;});'
    +   'document.querySelectorAll(".' + P + '-labor-in").forEach(function(el){labor+=parseFloat(el.value)||0;});'
    +   'var ss=parseFloat(document.getElementById("' + P + 'ss").value)||0;'
    +   'var tr=parseFloat(document.getElementById("' + P + 'tr").value)||0;'
    +   'var cliItems=(typeof cliCollect==="function")?cliCollect():[];'
    +   'var cliTax=cliItems.reduce(function(a,it){return a+(it.taxed?(it.amount||0):0);},0);'
    +   'var cliAll=cliItems.reduce(function(a,it){return a+(it.amount||0);},0);'
    +   'var disc=parseFloat(document.getElementById("' + P + 'disc").value)||0;'
    +   'var tax=(parts+ss+cliTax)*tr/100;var total=parts+labor+ss+cliAll+tax-disc;'
    +   'var cdr=document.getElementById("cliDisplayRows");'
    +   'if(cdr)cdr.innerHTML=cliItems.map(function(it){return "<div class=\'price-row\'><span class=\'price-label\'>"+(it.label.replace(/</g,"&lt;"))+"</span><span>$"+money(it.amount)+"</span></div>";}).join("");'
    +   'document.getElementById("' + P + 'taxAmt").textContent="$"+money(tax);'
    +   'document.getElementById("' + P + 'ssDisplay").textContent="$"+money(ss);'
    +   'document.getElementById("' + P + 'taxDisplay").textContent="$"+money(tax);'
    +   'document.getElementById("' + P + 'totalAmt").textContent="$"+money(total);'
    +   'document.getElementById("' + P + 'partsH").value=parts.toFixed(2);'
    +   'document.getElementById("' + P + 'laborH").value=labor.toFixed(2);'
    +   'document.getElementById("' + P + 'taxH").value=tax.toFixed(2);'
    +   'document.getElementById("' + P + 'totalH").value=total.toFixed(2);'
    +   'var items=Array.from(document.querySelectorAll("#' + P + 'SvcPriceRows .svc-price-row")).map(function(r){'
    +     'var t=r.querySelector(".svc-price-title span");'
    +     'var p=parseFloat(r.querySelector(".' + P + '-parts-in").value)||0;'
    +     'var l=parseFloat(r.querySelector(".' + P + '-labor-in").value)||0;'
    +     'var m=(r.querySelector(".svc-row-mode")||{}).value||"combined";'
    +     'return{service:t?t.textContent:r.getAttribute("data-base"),parts:p,labor:l,mode:m};'
    +   '});'
    +   'document.getElementById("' + P + 'svcLiH").value=JSON.stringify(items);'
    +   'var qcbox=document.getElementById("' + P + 'SvcCustomerRows");'
    +   'if(qcbox)qcbox.innerHTML=items.map(function(it){'
    +     'if(it.mode==="split"){'
    +       'return "<div class=\'price-row\'><span class=\'price-label\'>"+it.service+" — Parts</span><span>$"+money(it.parts)+"</span></div>"'
    +         '+"<div class=\'price-row\'><span class=\'price-label\'>"+it.service+" — Labor <span class=\'price-note\'>(not taxed)</span></span><span>$"+money(it.labor)+"</span></div>";'
    +     '}'
    +     'return "<div class=\'price-row\'><span class=\'price-label\'>"+it.service+"</span><span>$"+money(it.parts+it.labor)+"</span></div>";'
    +   '}).join("");'
    + '}'
    + 'function ' + P + 'Autofill(){' + P + 'UpdateRowPrices();' + P + 'UpdateServiceHidden();' + P + 'RenderTags();' + P + 'Hints();' + P + 'calc();}'
    // Build price rows for any services pre-selected server-side (edit/prefill).
    + 'function ' + P + 'InitRows(){'
    +   'document.querySelectorAll(".' + P + '-svc-cb:checked").forEach(function(cb){' + P + 'AddPriceRow(cb.value);});'
    +   'document.querySelectorAll(".' + P + '-pos-cb:checked").forEach(function(pos){' + P + 'AddPriceRow(pos.getAttribute("data-prefix")+" - "+pos.getAttribute("data-pos"));});'
    + '}';
}

// Server-side: normalize a submitted quote pricing block into one object.
// Works identically for every quote surface because the field names are shared.
function quoteParseBody(body) {
  var service = (body.service || '').trim();
  var customSvc = (body.customService || '').trim();
  if (customSvc && service.split(',').map(function(s){ return s.trim().toLowerCase(); }).indexOf(customSvc.toLowerCase()) === -1) {
    service = service ? service + ', ' + customSvc : customSvc;
  }
  var svcLineItems = [];
  try {
    var arr = JSON.parse(body.svcLineItems || '[]');
    if (Array.isArray(arr)) svcLineItems = arr;
  } catch (_) {}
  return {
    service: service,
    tier: body.tier === 'premium' ? 'premium' : 'standard',
    parts: parseFloat(body.parts) || 0,
    labor: parseFloat(body.labor) || 0,
    shopSupplies: parseFloat(body.shopSupplies) || 0,
    taxRate: parseFloat(body.taxRate) || 0,
    taxAmt: parseFloat(body.taxAmt) || 0,
    totalAmt: parseFloat(body.totalAmt) || 0,
    discount: parseFloat(body.discount) || 0,
    svcLineItems: svcLineItems,
    customLineItems: parseLineItems(body.customLineItems),
    customerNotes: (body.customerNotes || '').trim() || null
  };
}

// ─── Quote tool ───────────────────────────────────────────────────────────────

router.get('/quote/:id', requireAuth, function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.redirect('/admin');

  var allQuotes = db.prepare('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC').all(lead.id);
  var existing = allQuotes[0] || {};
  // True once a quote has actually gone out on this lead. When set, the owner can
  // either edit that quote ("Update") or start a fresh, separate quote ("New").
  var hasSentQuote = allQuotes.some(function(qq) { return !!qq.sent_at; });
  // "New separate quote" mode (?new=1): start from a clean slate so picking services
  // pulls today's pricing, rather than carrying the prior quote's (possibly stale)
  // numbers. Only meaningful once a quote already exists; the customer's vehicle is
  // kept since it's the same car. This mode saves its draft under a separate key.
  var newQuote = req.query.new === '1' && hasSentQuote;
  var q = newQuote ? {} : existing;
  var currentService = newQuote ? '' : (q.service || lead.service || '');
  var currentTier    = q.tier || 'standard';
  var currentTaxRate = q.tax_rate != null ? +(q.tax_rate * 100).toFixed(2) : +(PRICING.taxRate * 100).toFixed(2);
  var currentLineItems    = newQuote ? [] : parseLineItems(q.line_items);
  var currentCustomerNotes = newQuote ? '' : (q.customer_notes || '');
  var currentDiscount     = newQuote ? 0 : Math.round(Number(q.discount) || 0);
  var currentDiscountLabel = newQuote ? '' : (q.discount_label || '');
  // Which send action this page is set up for, used by the single Send button below.
  var sendMode = newQuote ? 'separate' : (hasSentQuote ? 'update' : 'new');
  var autosaveKey = 'quote-' + lead.id + (newQuote ? '-new' : '');

  // Best-effort split of the lead's free-text vehicle ("2018 Honda Accord") into
  // year / make / model to pre-select the cascade dropdowns. The make must match a
  // dropdown option to pre-select; the model is kept as a preset option regardless.
  var vehParts = String(lead.vehicle || '').trim().split(/\s+/).filter(Boolean);
  var prefYear = '', prefMake = '', prefModel = '';
  if (vehParts.length && /^(19|20)\d{2}$/.test(vehParts[0])) prefYear = vehParts.shift();
  if (vehParts.length) prefMake = vehParts.shift();
  prefModel = vehParts.join(' ');

  var effectivePricing = getEffectivePricing();
  var serviceNames = Object.keys(effectivePricing);
  var currentServices = currentService ? currentService.split(', ').map(function(s) { return s.trim(); }) : [];

  var pricingJson = JSON.stringify(effectivePricing);
  var noEmail = !lead.email;
  // Build Quote opens by default only at the quoting stages; later stages keep it
  // collapsed so the page stays compact. Owner's manual toggle is remembered.
  var buildQuoteOpen = ['new', 'quoted', 'follow_up'].indexOf(lead.status) !== -1;

  var quoteAlert = '';
  if (req.query.msg === 'approved')   quoteAlert = '<div class="alert alert-success">Time confirmed. Customer notified.</div>';
  if (req.query.msg === 'denied')     quoteAlert = '<div class="alert alert-error" style="background:#fff8e1;color:#7a5a00;border-color:#f0d080;">Time denied. Customer notified — we\'ll reach out to reschedule.</div>';
  if (req.query.msg === 'quote_sent') quoteAlert = '<div class="alert alert-success">Quote sent to customer successfully.</div>';
  if (req.query.msg === 'quote_sent_sep') quoteAlert = '<div class="alert alert-success">Sent as a separate quote. This is a new lead, so both quotes now track through the pipeline independently.</div>';
  if (req.query.msg === 'quote_saved_noemail') quoteAlert = '<div class="alert alert-success">Quote saved. No email on file for this lead, so it was not emailed.</div>';
  if (req.query.msg === 'quote_err')  quoteAlert = '<div class="alert alert-error">Quote was saved but the email failed to send. Check your connection and hit Send Quote again from the form below.</div>';
  if (req.query.msg === 'receipt_sent')  quoteAlert = '<div class="alert alert-success">Receipt sent to the customer. Lead moved to Receipt.</div>';
  if (req.query.msg === 'receipt_saved') quoteAlert = '<div class="alert alert-success">Receipt saved. No email on file for this lead.</div>';
  if (req.query.msg === 'receipt_err')   quoteAlert = '<div class="alert alert-error">Receipt saved, but the email failed to send. Try again.</div>';
  if (req.query.msg === 'quick_sent')    quoteAlert = '<div class="alert alert-success">Quick Quote sent to the customer. Lead created in the Quoted stage.</div>';
  if (req.query.msg === 'quick_saved')   quoteAlert = '<div class="alert alert-success">Lead created from Quick Quote and the quote was saved (not emailed).</div>';
  if (req.query.msg === 'quick_err')     quoteAlert = '<div class="alert alert-error">Lead and quote saved, but the email failed to send. Try resending from this page.</div>';
  if (req.query.msg === 'appt_created')  quoteAlert = '<div class="alert alert-success">Appointment created and confirmation email sent.</div>';
  // Saves made from the embedded customer-profile cards redirect back here.
  if (req.query.msg === 'saved')         quoteAlert = '<div class="alert alert-success">Customer profile saved.</div>';
  if (req.query.msg === 'veh_removed')   quoteAlert = '<div class="alert alert-success">Vehicle removed.</div>';
  if (req.query.msg === 'addr_removed')  quoteAlert = '<div class="alert alert-success">Address removed.</div>';
  if (req.query.msg === 'added')         quoteAlert = '<div class="alert alert-success">Follow-up added.</div>';

  var custLink = lead.customer_id
    ? '<a href="/admin/customer/' + lead.customer_id + '" class="fwd-link">' + ic('user') + 'Customer Profile <span class="bk-arrow">&rarr;</span></a>'
    : '';

  // Full customer-profile cards embedded on the lead page so the owner has the
  // complete, editable customer record (tags, contact, vehicles, saved addresses,
  // job history, follow-ups, lifetime stats) without leaving the lead. Edits post
  // to the same /admin/customer/:id/* endpoints and redirect back here. Only shown
  // when this lead is linked to a customer record.
  var custProfile = lead.customer_id
    ? db.prepare('SELECT * FROM customers WHERE id = ?').get(lead.customer_id)
    : null;
  var custSec = custProfile
    ? customerProfileSections(custProfile, { back: '/admin/quote/' + lead.id })
    : null;
  var custProfileBlock = custSec
    ? '<div class="section-title" style="margin:26px 0 10px;">Customer Profile</div>'
      + '<div style="font-size:0.8rem;color:#aaa;margin:-4px 0 12px;">The full customer record, shared across all their jobs. Edits here update the customer profile everywhere.</div>'
      + custSec.tags + custSec.form + custSec.saveBar + custSec.jobs + custSec.fups + custSec.stats + custSec.script
    : '';

  // Back (left) and Customer Profile (right) sit in a spaced row so they are large,
  // distinct tap targets and never mistaken for one another.
  var body = '<div class="nav-row"><a href="/admin" class="back-link"><span class="bk-arrow">&#8592;</span> All Leads</a>' + custLink + '</div>'
    + quoteAlert
    + stageTracker(lead.status)
    + nextStageHint(lead)

    // Scheduling request / Approve-Deny (pending) or confirmed banner
    + schedulingPanel(lead, q, false)

    // Customer info card (collapsible, open by default)
    + collapseOpen('cust', 'Customer Information', true)
    + '<div class="row-sb" style="margin-bottom:10px;">'
    + '<div><div class="lead-name">' + esc(lead.first_name) + ' ' + esc(lead.last_name) + '</div>'
    + '<div style="color:#aaa;font-size:0.8rem;">' + timeAgo(lead.created_at) + '</div></div>'
    + statusBadge(lead.status)
    + '</div>'
    + '<div class="info-grid">'
    + contactInfoRows(lead,
        (lead.vehicle ? '<span class="info-key">Vehicle</span><span class="info-val">' + esc(lead.vehicle) + '</span>' : '')
        + '<span class="info-key">Service</span><span class="info-val">' + esc(lead.service || 'Not specified') + '</span>'
        + (lead.preferred_contact ? '<span class="info-key">Contact via</span><span class="info-val">' + esc(lead.preferred_contact) + '</span>' : '')
        + (lead.message ? '<span class="info-key">Notes</span><span class="info-val" style="font-style:italic;">' + esc(lead.message) + '</span>' : ''))
    + '</div>'
    + contactActions(lead, 12)
    // Primary job actions live right inside the Customer Information box, next to
    // Call/Text/Email: Book Appointment (when still pre-booking) and Send Receipt.
    + (!lead.archived
        ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">'
          + (['quoted','quote_accepted','new','follow_up'].indexOf(lead.status) !== -1
              ? '<a href="/admin/appointments/new?from_lead=' + lead.id + '" class="btn btn-navy btn-sm" style="width:auto;">' + ic('calendar') + 'Book Appointment</a>'
              : '')
          + '<a href="/admin/receipt/' + lead.id + '" class="btn btn-blue btn-sm" style="width:auto;">' + ic('receipt') + 'Send Receipt</a>'
          + '</div>'
        : '')
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
    + '<button type="submit" style="width:100%;background:none;border:none;color:#888;font-size:0.8rem;font-weight:600;cursor:pointer;padding:4px;">' + ic('archive') + 'Archive lead</button>'
    + '</form>'
    + '<form method="POST" action="/admin/lead/' + lead.id + '/delete" style="flex:1;">'
    + '<input type="hidden" name="back" value="/admin">'
    + '<button type="button" data-name="' + esc(lead.first_name + ' ' + lead.last_name) + '" onclick="showDeleteConfirm(this)" style="width:100%;background:none;border:none;color:#c0392b;font-size:0.8rem;font-weight:600;cursor:pointer;padding:4px;">' + ic('trash') + 'Delete lead permanently</button>'
    + '</form>'
    + '</div>'
    + COLLAPSE_CLOSE

    // Customer Interaction Notes — a quick running log of calls, texts, and
    // conversations, kept separate from internal notes so the owner can see customer
    // contact history at a glance. Open by default. Internal only, never sent.
    + collapseOpen('interaction', 'Customer Interaction Notes', true)
    + (req.query.msg === 'interaction_saved' ? '<div class="alert alert-success" style="margin-bottom:10px;">Saved.</div>' : '')
    + '<div style="font-size:0.78rem;color:#aaa;margin-bottom:10px;">Log of calls, texts, and conversations with the customer. Internal only, never sent.</div>'
    + '<form method="POST" action="/admin/lead/' + lead.id + '/interaction-notes">'
    + '<div class="form-group" style="margin-bottom:10px;"><label>Interaction Notes</label>'
    + '<textarea name="interactionNotes" rows="5" placeholder="e.g. 6/19 called, left voicemail. 6/20 texted the quote, customer asked about Saturday.">' + esc(lead.interaction_notes || '') + '</textarea></div>'
    + '<button type="submit" class="btn btn-outline" style="width:auto;">Save</button>'
    + '</form>' + COLLAPSE_CLOSE

    // Lead-level VIN + Internal Notes — collapsible, collapsed by default.
    + collapseOpen('notes', 'VIN &amp; Internal Notes', false)
    + (req.query.msg === 'notes_saved' ? '<div class="alert alert-success" style="margin-bottom:10px;">Saved.</div>' : '')
    + '<div style="font-size:0.78rem;color:#aaa;margin-bottom:10px;">Internal only, never sent.</div>'
    + '<form method="POST" action="/admin/lead/' + lead.id + '/notes">'
    + '<div class="form-group"><label>VIN</label>'
    + '<input type="text" name="vin" placeholder="17-character VIN" value="' + esc(lead.vin || '') + '" maxlength="17"></div>'
    + '<div class="form-group" style="margin-bottom:10px;"><label>Internal Notes</label>'
    + '<textarea name="internalNotes" placeholder="Running notes about this customer or vehicle...">' + esc(lead.internal_notes || '') + '</textarea></div>'
    + '<button type="submit" class="btn btn-outline" style="width:auto;">Save</button>'
    + '</form>' + COLLAPSE_CLOSE

    // Sections below are reordered client-side based on the pipeline stage
    + '<div id="sects">'

    // Send Receipt now lives in the Customer Information box above; this section is
    // kept (empty) so the stage-based section reorder script still has its anchor.
    + '<div data-section="complete-job"></div>'

    // Receipt history
    + '<div data-section="receipts">'
    + (function() {
        var receipts = db.prepare('SELECT * FROM receipts WHERE lead_id = ? ORDER BY id DESC').all(lead.id);
        if (receipts.length === 0) return '';
        var cards = receipts.map(function(rc) {
          var when = rc.sent_at
            ? 'Sent ' + new Date(rc.sent_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
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
        return collapsible('receipts',
          'Receipts <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(' + receipts.length + ')</span>',
          cards, false);
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
        return collapsible('followups',
          'Follow-ups' + (fus.length ? ' <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(' + fus.length + ')</span>' : ''),
          cards + '<div class="card">' + addForm + '</div>', false);
      })()
    + '</div>'

    // Quote history
    + '<div data-section="quote-history">'
    + (allQuotes.length > 0
        ? collapseOpen('quotehist', 'Quote History <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(' + allQuotes.length + ')</span>', false)
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
              var sentDate = pq.sent_at ? new Date(pq.sent_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit', timeZone: 'America/New_York' }) : '—';
              var tierLabel = pq.tier === 'premium' ? 'Premium' : 'Standard';
              return '<tr style="border-bottom:1px solid #f0f0f0;' + (isLatest ? 'font-weight:600;' : 'color:#666;') + '">'
                + '<td style="padding:7px 8px 7px 0;white-space:nowrap;">' + sentDate
                  + (isLatest ? ' <span style="font-size:0.72rem;background:#e3f0ff;color:#1a6fc4;padding:1px 6px;border-radius:10px;font-weight:700;">Latest</span>' : '')
                  + (isLatest && allQuotes.length > 1 ? ' <span style="font-size:0.72rem;background:#fdeccb;color:#9a6a16;padding:1px 6px;border-radius:10px;font-weight:700;">Updated</span>' : '')
                  + '</td>'
                + '<td style="padding:7px 8px;">' + esc(pq.service || '—') + '</td>'
                + '<td style="padding:7px 8px;">' + tierLabel + '</td>'
                + '<td style="padding:7px 0 7px 8px;text-align:right;">$' + money(pq.total) + '</td>'
                + '</tr>';
            }).join('')
          + '</tbody></table></div>' + COLLAPSE_CLOSE
        : '')
    + '</div>'

    // Lead history
    + '<div data-section="lead-history">'
    + (function() {
        var history = db.prepare('SELECT * FROM lead_history WHERE lead_id = ? ORDER BY id DESC').all(lead.id);
        if (history.length === 0) return '';
        var rows = history.map(function(h) {
          return '<div style="display:flex;gap:12px;padding:8px 0;border-bottom:1px solid #f4f4f4;">'
            + '<div style="width:10px;height:10px;border-radius:50%;background:#4169e1;flex-shrink:0;margin-top:5px;"></div>'
            + '<div><div style="font-size:0.88rem;color:#1a2a3a;font-weight:600;">' + esc(h.event) + '</div>'
            + (h.detail ? '<div style="font-size:0.82rem;color:#888;margin-top:2px;">' + esc(h.detail) + '</div>' : '')
            + '<div style="font-size:0.78rem;color:#bbb;margin-top:2px;">' + fmtHistoryTime(h.created_at) + '</div>'
            + '</div></div>';
        }).join('');
        return collapsible('leadhist', 'Lead History',
          '<div style="padding-left:4px;">' + rows + '</div>', false);
      })()
    + '</div>'

    // Build Quote form
    + '<div data-section="build-quote">'
    + collapseOpen('buildquote', 'Build Quote', buildQuoteOpen)
    // Mode toggle (only once a quote already exists): edit the saved quote, or start
    // a clean new/separate quote for the same customer that pulls today's pricing.
    + (hasSentQuote
        ? '<div class="tier-toggle" style="margin-bottom:6px;">'
          + '<a href="/admin/quote/' + lead.id + '?bq=1" class="tier-btn' + (newQuote ? '' : ' active') + '" style="text-align:center;text-decoration:none;line-height:1.2;display:flex;align-items:center;justify-content:center;">Edit existing quote</a>'
          + '<a href="/admin/quote/' + lead.id + '?new=1&bq=1" class="tier-btn' + (newQuote ? ' active' : '') + '" style="text-align:center;text-decoration:none;line-height:1.2;display:flex;align-items:center;justify-content:center;">New separate quote</a>'
          + '</div>'
          + '<div style="font-size:0.8rem;color:#888;margin-bottom:12px;line-height:1.5;">'
          + (newQuote
              ? 'Starting a <strong>new separate quote</strong> for this customer. Pick services to pull today&rsquo;s pricing. Sending creates its own lead so both quotes track separately.'
              : 'Editing the quote you already sent. Sending again <strong>updates</strong> this same quote.')
          + '</div>'
        : '')

    + '<form method="POST" action="/admin/quote/' + lead.id + '/send" id="qf" data-autosave="' + autosaveKey + '" data-autosave-after="bkQuoteAfter">'

    // Vehicle (shown on the customer quote)
    + '<div class="form-group"><label>Vehicle <span style="color:#bbb;font-weight:400;">(shown on the customer quote)</span></label>'
    + vehicleCascadeHtml('qbveh', {}, { year: prefYear, make: prefMake, model: prefModel })
    + '</div>'

    // Shared quote pricing block (per-service breakdown, custom line items,
    // discount, customer summary, notes) — identical on every quote surface.
    + quotePricingBlock('bq', {
        serviceNames: serviceNames,
        selected: currentServices,
        tier: currentTier,
        taxPct: currentTaxRate,
        discount: currentDiscount,
        discountLabel: currentDiscountLabel,
        shopSupplies: Math.round(Number(q.shop_supplies) || 0),
        lineItems: currentLineItems,
        customerNotes: currentCustomerNotes
      })

    + (noEmail ? '<div class="alert alert-error" style="margin-bottom:8px;">No email on file. Quote will be saved but not emailed.</div>' : '')
    + '<input type="hidden" name="sendMode" value="' + sendMode + '">'
    + '<button type="button" class="btn btn-outline" onclick="togglePreview()" id="prevBtn">Preview Email</button>'
    + '<div id="previewBox" style="display:none;"></div>'
    + '<button type="submit" class="btn btn-blue" style="margin-top:10px;">'
    + (sendMode === 'separate' ? 'Send as a Separate Quote' : sendMode === 'update' ? 'Update This Quote' : 'Send Quote')
    + '</button>'
    + '</form>'
    + COLLAPSE_CLOSE
    + '</div>'
    + '</div>'

    // Full editable customer profile, mirrored from /admin/customer/:id
    + custProfileBlock

    + '<script>'
    + 'var bqPRICING=' + pricingJson + ';'
    + 'var firstName="' + esc(lead.first_name) + '";'
    + 'var vehicle="' + esc(lead.vehicle || '') + '";'
    + 'var leadEmail="' + esc(lead.email || '') + '";'
    + 'function money(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'
    + CLI_JS
    + 'function bkRecalc(){bqcalc();}'
    // Shared quote pricing wiring (per-service rows, tier, calc, tags, hints).
    + quotePricingJs('bq')

    // Preview the customer quote email from the live per-service rows.
    + 'function togglePreview(){'
    +   'var box=document.getElementById("previewBox");'
    +   'if(box.style.display!=="none"){box.style.display="none";document.getElementById("prevBtn").textContent="Preview Email";return;}'
    +   'var svcNames=bqGetAllServiceNames();var cv=bqCustomSvcVal();if(cv)svcNames=svcNames.concat([cv]);'
    +   'var items=JSON.parse(document.getElementById("bqsvcLiH").value||"[]");'
    +   'var ss=parseFloat(document.getElementById("bqss").value)||0;'
    +   'var tax=parseFloat(document.getElementById("bqtaxH").value)||0;'
    +   'var tot=parseFloat(document.getElementById("bqtotalH").value)||0;'
    +   'var disc=parseFloat(document.getElementById("bqdisc").value)||0;'
    +   'var vehNow=[(document.getElementById("qbveh-year")||{}).value||"",(document.getElementById("qbveh-make")||{}).value||"",(document.getElementById("qbveh-model-hid")||{}).value||""].filter(Boolean).join(" ")||vehicle;'
    +   'var veh=vehNow?" for your <strong>"+vehNow+"</strong>":"";'
    +   'var toLine=leadEmail||"<em style=\'color:#e07000\'>(no email on file)</em>";'
    +   'var svcLine=svcNames.length<=1?(svcNames[0]||"(no service selected)"):svcNames.slice(0,-1).join(", ")+", and "+svcNames[svcNames.length-1];'
    +   'var rowsHtml=items.map(function(it){return it.mode==="split"?("<tr><td>"+it.service+" — Parts</td><td style=\'text-align:right;\'>$"+money(it.parts)+"</td></tr><tr><td>"+it.service+" — Labor</td><td style=\'text-align:right;\'>$"+money(it.labor)+"</td></tr>"):("<tr><td>"+it.service+"</td><td style=\'text-align:right;\'>$"+money(it.parts+it.labor)+"</td></tr>");}).join("");'
    +   'box.innerHTML='
    +     '"<div class=\'preview-box\'>"'
    +     '+"<h4>Email Preview</h4>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:4px;\'>To: "+toLine+"</div>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:8px;\'>Subject: Your Brake Service Quote — Brake Knights</div>"'
    +     '+"<hr class=\'preview-divider\'>"'
    +     '+"<p>Greetings "+firstName+",</p>"'
    +     '+"<p style=\'margin-top:8px;\'>Here is your quote"+veh+":</p>"'
    +     '+(svcNames.length?("<div style=\'margin:10px 0 4px;font-size:0.8rem;font-weight:700;color:#0a1f3d;text-transform:uppercase;letter-spacing:.4px;\'>Service Requested</div>"+"<p style=\'margin:0 0 6px;font-size:0.92rem;font-weight:600;color:#1a2a3a;\'>"+svcLine+"</p>"):"")'
    +     '+"<table style=\'width:100%;margin:12px 0;font-size:0.88rem;border-collapse:collapse;\'>"'
    +     '+rowsHtml'
    +     '+cliCollect().map(function(it){return "<tr><td>"+it.label.replace(/</g,"&lt;")+"</td><td style=\'text-align:right;\'>$"+money(it.amount)+"</td></tr>";}).join("")'
    +     '+(ss>0?"<tr><td>Shop Supplies</td><td style=\'text-align:right;\'>$"+money(ss)+"</td></tr>":"")'
    +     '+(tax>0?"<tr><td>Tax</td><td style=\'text-align:right;\'>$"+money(tax)+"</td></tr>":"")'
    +     '+(disc>0?"<tr><td>Discount"+(((document.getElementById("bqdiscLabel")||{}).value||"").trim()?" ("+document.getElementById("bqdiscLabel").value.trim().replace(/</g,"&lt;")+")":"")+"</td><td style=\'text-align:right;\'>-$"+money(disc)+"</td></tr>":"")'
    +     '+"<tr style=\'font-weight:700;font-size:1rem;border-top:2px solid #dde3ea;\'><td style=\'padding-top:8px;\'>Total</td><td style=\'text-align:right;padding-top:8px;\'>$"+money(tot)+"</td></tr>"'
    +     '+"</table>"'
    +     '+svcNames.map(function(s){return bqPRICING[s]&&bqPRICING[s].note;}).filter(Boolean).map(function(n){return "<p style=\'color:#7a5a00;background:#fff8e1;border:1px solid #f0d080;border-radius:6px;padding:11px 13px;font-size:0.85rem;line-height:1.6;margin:18px 0;\'>"+n+"</p>";}).join("")'
    +     '+((((document.getElementById("bqCustNotes")||{}).value||"").trim())?("<p style=\'color:#1a3a7a;background:#eaf2ff;border:1px solid #b9d2ff;border-radius:6px;padding:12px 14px;font-size:0.86rem;line-height:1.6;margin:18px 0;\'>"+document.getElementById("bqCustNotes").value.trim().replace(/</g,"&lt;")+"</p>"):"")'
    +     '+"<p style=\'margin:18px 0 0;line-height:1.6;\'>Includes all parts and labor. Qualifying pad and rotor replacements carry a <strong>12-month / 12,000-mile warranty</strong>.</p>"'
    +     '+"<p style=\'margin:16px 0 0;line-height:1.6;\'>We come to your home or office. No shop visit needed.</p>"'
    +     '+"<p style=\'margin:16px 0 0;line-height:1.6;\'>Reply to this email or call/text <strong>703-977-4475</strong> to confirm.</p>"'
    +     '+"</div>";'
    +   'box.style.display="block";'
    +   'document.getElementById("prevBtn").textContent="Hide Preview";'
    + '}'

    // On load: build the per-service rows from the selected services, then total up.
    + 'cliInit();'
    + 'bqInitRows();'
    + 'bqUpdateServiceHidden();bqRenderTags();bqHints();bqcalc();'
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
    // Draft restore finalizer: re-check services + rebuild per-service price rows
    // from the restored fields, restore tier + custom line items, then recompute
    // without re-pulling prices so any manual price overrides in the draft are kept.
    + 'window.bkQuoteAfter=function(d){'
    +   'var svc=(document.getElementById("bqsvcHidden").value||"").split(",").map(function(s){return s.trim();}).filter(Boolean);'
    +   'document.querySelectorAll(".bq-svc-cb").forEach(function(cb){cb.checked=svc.indexOf(cb.value)>=0;});'
    +   'document.querySelectorAll(".bq-pos-cb").forEach(function(cb){cb.checked=svc.indexOf(cb.getAttribute("data-prefix")+" - "+cb.getAttribute("data-pos"))>=0;});'
    +   'bqtier=(document.getElementById("bqtier").value)||"standard";'
    +   'document.getElementById("bqBtnStd").classList.toggle("active",bqtier==="standard");'
    +   'document.getElementById("bqBtnPrem").classList.toggle("active",bqtier==="premium");'
    // Rebuild the per-service rows from the saved svcLineItems (preserves overrides).
    +   'var rowsBox=document.getElementById("bqSvcPriceRows");if(rowsBox){rowsBox.innerHTML="";try{var sli=JSON.parse((document.getElementById("bqsvcLiH")||{}).value||"[]");if(Array.isArray(sli)&&sli.length){sli.forEach(function(it){bqAddPriceRow(it.service);var row=document.querySelector("#bqSvcPriceRows .svc-price-row[data-base=\'"+it.service+"\']");if(row){row.querySelector(".bq-parts-in").value=it.parts;row.querySelector(".bq-labor-in").value=it.labor;var mode=it.mode||"combined";row.querySelector(".svc-row-mode").value=mode;row.querySelectorAll(".svc-disp-btn").forEach(function(b,i){b.classList.toggle("active",(mode==="split")?i===1:i===0);});}});}else{bqInitRows();}}catch(e){bqInitRows();}}'
    +   'try{var ci=JSON.parse((document.getElementById("cliJson")||{}).value||"[]");if(Array.isArray(ci)){var c=document.getElementById("cliRows");if(c){c.innerHTML="";ci.forEach(function(it){var w=document.createElement("div");w.innerHTML=cliRowHtml();var row=w.firstChild;row.querySelector(".cli-label").value=it.label||"";row.querySelector(".cli-amount").value=(it.amount!=null?it.amount:"");cliSetTax(row.querySelector(".cli-tax"),it.taxed!==false);c.appendChild(row);});}}}catch(e){}'
    +   'bqUpdateServiceHidden();bqRenderTags();bqHints();bqcalc();'
    + '};'
    + '</script>'
    + VEHICLE_CASCADE_JS;

  res.send(page('Quote — ' + lead.first_name + ' ' + lead.last_name, body, req));
});

// ─── Send quote ───────────────────────────────────────────────────────────────

router.post('/quote/:id/send', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.redirect('/admin');

  var service       = (req.body.service || '').trim();
  var customSvc     = (req.body.customService || '').trim();
  if (customSvc && service.split(',').map(function(s){return s.trim().toLowerCase();}).indexOf(customSvc.toLowerCase()) === -1) service = service ? service + ', ' + customSvc : customSvc;
  var tier          = req.body.tier          || 'standard';
  var parts         = parseFloat(req.body.parts)         || 0;
  var labor         = parseFloat(req.body.labor)         || 0;
  var shopSupplies  = parseFloat(req.body.shopSupplies)  || 0;
  var taxRate       = parseFloat(req.body.taxRate)       || 0;
  var taxAmt        = parseFloat(req.body.taxAmt)        || 0;
  var totalAmt      = parseFloat(req.body.totalAmt)      || 0;
  var vin           = req.body.vin            || null;
  var internalNotes = req.body.internalNotes  || null;
  var lineItems     = parseLineItems(req.body.customLineItems);
  var lineItemsJson = lineItems.length ? JSON.stringify(lineItems) : null;
  var customerNotes = (req.body.customerNotes || '').trim() || null;
  var discount      = parseFloat(req.body.discount)      || 0;
  var discountLabel = (req.body.discount_label || '').trim() || null;
  // Per-service breakdown [{service,parts,labor,mode}] from the shared pricing block,
  // shown line-by-line in the customer quote email.
  var svcLineItems  = (function(){ try { var a = JSON.parse(req.body.svcLineItems || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } })();

  // 'new'      = first quote on this lead
  // 'update'   = revise the existing quote in place (stays this lead)
  // 'separate' = spin off a brand-new lead so both quotes track independently
  var sendMode = req.body.sendMode || 'new';

  // Vehicle picked on the Build Quote form (year/make/model cascade).
  var vehicle = [req.body.veh_year, req.body.veh_make, req.body.veh_model]
    .map(function(v) { return (v || '').trim(); }).filter(Boolean).join(' ');

  // "Send as a separate quote": clone the customer onto a brand-new lead so this
  // quote and the earlier one each move through the pipeline on their own. The
  // original lead is left exactly as it is. Everything below targets the new lead.
  if (sendMode === 'separate') {
    var newInfo = db.prepare(
      'INSERT INTO leads (first_name, last_name, phone, email, vehicle, service, source, status, customer_id, vin, internal_notes) '
      + "VALUES (?,?,?,?,?,?,?,'quoted',?,?,?)"
    ).run(lead.first_name, lead.last_name, lead.phone, lead.email,
          (vehicle || lead.vehicle || null), service || null, lead.source || 'Build Quote',
          lead.customer_id || null, lead.vin || null, lead.internal_notes || null);
    logHistory(lead.id, 'Separate quote started', 'New lead #' + newInfo.lastInsertRowid + ' created for a separate quote');
    lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(newInfo.lastInsertRowid);
    logHistory(lead.id, 'Separate quote', 'Split from lead #' + req.params.id);
  }

  // Save the chosen vehicle onto the target lead (so it shows on the email/profile).
  if (vehicle && vehicle !== lead.vehicle) {
    db.prepare('UPDATE leads SET vehicle = ? WHERE id = ?').run(vehicle, lead.id);
    lead.vehicle = vehicle;
  }

  var acceptToken = crypto.randomBytes(24).toString('hex');

  // Has a quote already gone out on THIS lead before? If so, this send is a revision,
  // so the email subject should say the quote was updated. Checked before the INSERT
  // below so the new quote doesn't count itself. Scoped to the lead, not the email: a
  // repeat customer starting a fresh inquiry (new lead, even with the same email)
  // always gets a "new" quote. Only a re-send on the same lead counts as an update.
  var isRevisedQuote = db.prepare(
    'SELECT COUNT(*) AS n FROM quotes WHERE lead_id = ? AND sent_at IS NOT NULL'
  ).get(lead.id).n > 0;

  var info = db.prepare(
    'INSERT INTO quotes (lead_id, service, tier, price_parts, price_labor, shop_supplies, tax_rate, tax, total, vin, internal_notes, line_items, customer_notes, discount, discount_label, accept_token, sent_at, status) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\'),?)'
  ).run(lead.id, service, tier, parts, labor, shopSupplies, taxRate / 100, taxAmt, totalAmt, vin, internalNotes, lineItemsJson, customerNotes, discount, discountLabel, acceptToken, lead.email ? 'sent' : 'saved');

  // Don't drag a lead backwards: once an appointment is booked or the job is done,
  // re-sending/updating a quote should not silently move it back to the Quoted stage
  // (that would un-book the appointment). To change a booked appointment's details,
  // use Edit Appointment. Early-stage leads still advance to Quoted as before.
  var lockedStage = ['booked', 'completed', 'receipt'].indexOf(lead.status) !== -1;
  if (!lockedStage) {
    db.prepare("UPDATE leads SET status = 'quoted', status_updated_at = datetime('now') WHERE id = ?").run(lead.id);
  }
  logHistory(lead.id, isRevisedQuote ? 'Quote updated' : 'Quote sent', service + (tier ? ' (' + tier + ')' : '') + ' — $' + totalAmt.toFixed(2));
  if (!lockedStage && lead.status !== 'quoted') sendStagePush(lead, 'quoted');

  if (!lead.email) return res.redirect('/admin/quote/' + lead.id + '?msg=quote_saved_noemail');

  // Absolute base URL so the accept link points back to the same site that sent it
  // (dev.brakeknights.com on dev, brakeknights.com on prod) without an env var.
  var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
  var acceptUrl = baseUrl + '/quote/' + info.lastInsertRowid + '/' + acceptToken;

  if (!process.env.SMTP_PASS) {
    console.error('SMTP_PASS not set — quote saved but not emailed');
    return res.redirect('/admin/quote/' + lead.id + '?msg=quote_err');
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
      cc:      'greetings@brakeknights.com',
      replyTo: 'greetings@brakeknights.com',
      subject: isRevisedQuote
        ? 'Your Updated Brake Service Quote — Brake Knights'
        : 'Your Brake Service Quote — Brake Knights',
      html:    buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, taxAmt, totalAmt, acceptUrl, svcLineItems, isRevisedQuote, customerNotes, lineItems, discount, discountLabel)
    });

    res.redirect('/admin/quote/' + lead.id + '?msg=' + (sendMode === 'separate' ? 'quote_sent_sep' : 'quote_sent'));
  } catch (err) {
    console.error('Quote email error:', err.message);
    res.redirect('/admin/quote/' + lead.id + '?msg=quote_err');
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
    return '<p style="color:#444;line-height:1.6;margin:0 0 18px;font-size:0.9rem;">' + partsQuality + ' This job carries a <strong>12-month / 12,000-mile warranty</strong> on parts and labor.</p>';
  }
  return '<p style="color:#444;line-height:1.6;margin:0 0 18px;font-size:0.9rem;">' + partsQuality + ' This job carries a <strong>12-month / 12,000-mile warranty on labor</strong>.</p>';
}

function buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, tax, total, acceptUrl, lineItemsData, isRevised, customerNotes, customLineItems, discount, discountLabel) {
  discount = Number(discount) || 0;
  var discountText = 'Discount' + (discountLabel ? ' (' + esc(discountLabel) + ')' : '');
  var partsLabor  = parts + labor;
  var svcName     = joinServices(service);
  var vehicleBit  = lead.vehicle ? ' for your <strong>' + esc(lead.vehicle) + '</strong>' : '';
  var revisedBanner = isRevised
    ? '<div style="background:#eaf2ff;border:1px solid #b9d2ff;border-left:4px solid #4169e1;border-radius:8px;padding:12px 16px;margin:0 0 20px;">'
      + '<p style="margin:0;color:#1a3a7a;font-size:0.9rem;font-weight:700;">This is an updated quote</p>'
      + '<p style="margin:4px 0 0;color:#3a5280;font-size:0.85rem;line-height:1.5;">It replaces any quote we sent you previously. Please use the details and link below.</p>'
      + '</div>'
    : '';
  var introLine = isRevised
    ? 'Here is your updated quote' + vehicleBit + ':'
    : 'Here is your quote' + vehicleBit + ':';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#ffffff;">'
    + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
    + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;">'
    + '<img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;">'
    + 'Brake Knights</h1>'
    + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service — Northern Virginia</p>'
    + '</div>'
    + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
    + '<h2 style="color:#0a1f3d;margin:0 0 16px;font-size:1.15rem;">Greetings ' + esc(lead.first_name) + ',</h2>'
    + revisedBanner
    + '<p style="color:#444;line-height:1.6;margin:0 0 20px;">' + introLine + '</p>'
    + '<div style="background:#f4f7fb;border-radius:8px;padding:20px;margin-bottom:24px;">'
    + (svcName
        ? '<p style="font-weight:700;color:#0a1f3d;margin:0 0 8px;font-size:0.82rem;text-transform:uppercase;letter-spacing:.5px;">Service Requested</p>'
          + '<p style="margin:0 0 6px;font-size:0.95rem;color:#1a2a3a;font-weight:600;">' + esc(svcName) + '</p>'
        : '')
    + (totalServiceMinutes(service) ? '<p style="margin:0 0 16px;font-size:0.86rem;color:#555;">Estimated time on site: about <strong>' + formatDuration(totalServiceMinutes(service)) + '</strong>. Please pick a time that allows for it.</p>' : '')
    + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
    + (Array.isArray(lineItemsData) && lineItemsData.length
        ? lineItemsData.map(function(it) {
            return it.mode === 'split'
              ? '<tr><td style="padding:6px 0;">' + esc(it.service) + ' — Parts</td><td style="text-align:right;">$' + money(it.parts) + '</td></tr>'
                + '<tr><td style="padding:6px 0;">' + esc(it.service) + ' — Labor</td><td style="text-align:right;">$' + money(it.labor) + '</td></tr>'
              : '<tr><td style="padding:6px 0;">' + esc(it.service) + '</td><td style="text-align:right;">$' + money(it.parts + it.labor) + '</td></tr>';
          }).join('')
        : (partsLabor > 0 ? '<tr><td style="padding:6px 0;">Parts &amp; Labor</td><td style="text-align:right;">$' + money(partsLabor) + '</td></tr>' : ''))
    + (Array.isArray(customLineItems) ? customLineItems.map(function(it) {
        return '<tr><td style="padding:6px 0;">' + esc(it.label) + '</td><td style="text-align:right;">$' + money(it.amount) + '</td></tr>';
      }).join('') : '')
    + (shopSupplies > 0 ? '<tr><td style="padding:6px 0;">Shop Supplies</td><td style="text-align:right;">$' + money(shopSupplies) + '</td></tr>' : '')
    + (tax > 0 ? '<tr><td style="padding:6px 0;color:#888;">Tax</td><td style="text-align:right;color:#888;">$' + money(tax) + '</td></tr>' : '')
    + (discount > 0 ? '<tr><td style="padding:6px 0;color:#1a7a3a;">' + discountText + '</td><td style="text-align:right;color:#1a7a3a;">-$' + money(discount) + '</td></tr>' : '')
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
    + (customerNotes ? '<p style="color:#1a3a7a;background:#eaf2ff;border:1px solid #b9d2ff;border-radius:8px;padding:12px 16px;line-height:1.6;margin:0 0 20px;font-size:0.88rem;">' + esc(customerNotes) + '</p>' : '')
    + buildWarrantyClause(service)
    + '<p style="color:#444;line-height:1.6;margin:0 0 18px;font-size:0.9rem;">Our service is fully mobile. We come directly to your home or office. No shop visit needed.</p>'
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
  if (!lead) return res.redirect('/admin');

  // Prefill from the accepted quote if there is one, otherwise the most recent quote.
  var quote = db.prepare('SELECT * FROM quotes WHERE lead_id = ? AND accepted_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(lead.id)
    || db.prepare('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id)
    || {};

  var service   = quote.service || lead.service || '';
  // Try structured vehicle from customer_vehicles; fall back to parsing lead.vehicle string.
  var rcVehData = lead.customer_id
    ? (db.prepare('SELECT year, make, model FROM customer_vehicles WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(lead.customer_id) || null)
    : null;
  if (!rcVehData && lead.vehicle) {
    var _vp = lead.vehicle.trim().split(/\s+/);
    var _yr = /^(19|20)\d{2}$/.test(_vp[0]) ? _vp.shift() : '';
    var _mk = _vp.length > 1 ? _vp.shift() : (_vp[0] || '');
    var _mo = _vp.length > 0 ? _vp.join(' ') : '';
    rcVehData = { year: _yr, make: _mk, model: _mo };
  }
  rcVehData = rcVehData || {};
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
  var taxPct    = quote.tax_rate != null ? +(quote.tax_rate * 100).toFixed(2) : +(PRICING.taxRate * 100).toFixed(2);
  // Prefill the exact booked breakdown carried over from the quote/appointment.
  // Appointments created via the shared pricing block store line_items as
  // {svc:[...per-service rows...], custom:[...custom line items...]}; older quotes
  // store either a plain custom line-items array or nothing. Parse defensively so the
  // receipt opens pre-filled with what was actually booked (still fully editable).
  var rcSvcRows = [];
  var rcLineItems = [];
  try {
    var _rli = JSON.parse(quote.line_items || 'null');
    if (_rli && Array.isArray(_rli.svc)) {
      rcSvcRows = _rli.svc;
      rcLineItems = parseLineItems(JSON.stringify(_rli.custom || []));
    } else if (Array.isArray(_rli)) {
      rcLineItems = parseLineItems(quote.line_items);
    }
  } catch (_) {}
  // Hidden seed so the page can rebuild the exact per-service price rows on load,
  // preserving any booked-appointment price overrides.
  var rcSvcSeed = JSON.stringify(rcSvcRows);

  // Service picker mirrors the quote tool: a multi-select of every service so the
  // owner can change/add what was actually done if the job grew on arrival.
  var selectedServices = service ? service.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
  var rEffectivePricing = getEffectivePricing();
  var rPricingJson = JSON.stringify(rEffectivePricing);

  var paymentOpts = PAYMENT_METHODS.map(function(p) {
    return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
  }).join('');

  var advisoryRows = advisoryRow(1, false);
  for (var i = 2; i <= 4; i++) advisoryRows += advisoryRow(i, true);
  advisoryRows += '<button type="button" id="rAddAdvBtn" class="svc-clear-btn" style="margin-top:6px;" onclick="bkAddAdvisory(\'r\')">+ Add Advisory</button>';

  // Past receipts for this lead (lightweight history)
  var pastReceipts = db.prepare('SELECT * FROM receipts WHERE lead_id = ? ORDER BY id DESC').all(lead.id);

  var body = '<a href="/admin/quote/' + lead.id + '" class="back-link"><span class="bk-arrow">&#8592;</span>Back to Lead</a>'
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

    + '<form method="POST" action="/admin/receipt/' + lead.id + '/send" id="rf" data-autosave="receipt-' + lead.id + '" data-autosave-after="bkReceiptAfter">'

    + collapseOpen('rc_service', 'Vehicle &amp; Job Details', true)
    + '<div class="form-group"><label>Vehicle</label>'
    + vehicleCascadeHtml('rc-veh', {}, { year: rcVehData.year || '', make: rcVehData.make || '', model: rcVehData.model || '' })
    + '</div>'
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
    + COLLAPSE_CLOSE

    // Shared quote pricing block (per-service breakdown, custom line items,
    // discount, total) — identical to the quote surfaces. The customer summary
    // label reads "Customer Receipt" / "Total Paid" via the init script below.
    + collapseOpen('rc_amount', 'Service &amp; Amount Paid', true)
    + quotePricingBlock('rc', {
        serviceNames: Object.keys(rEffectivePricing),
        selected: selectedServices,
        tier: receiptTier,
        taxPct: taxPct,
        shopSupplies: Math.round(Number(shopSupplies) || 0),
        lineItems: rcLineItems,
        showCustomerNotes: false
      })
    + '<input type="hidden" id="rcSvcSeed" value="' + esc(rcSvcSeed) + '">'
    + COLLAPSE_CLOSE

    + collapseOpen('rc_advisories', 'Notes to Customer <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(each appears on the receipt)</span>', true)
    + advisoryRows
    + COLLAPSE_CLOSE

    + collapseOpen('rc_office', 'Notes to Office <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(internal only, never sent)</span>', true)
    + '<div class="form-group" style="margin-bottom:0;">'
    + '<textarea name="officeNotes" placeholder="Torque specs, parts used, condition observations, anything for the record…"></textarea></div>'
    + COLLAPSE_CLOSE

    + (lead.email ? '' : '<div class="alert alert-error" style="margin-bottom:8px;">No email on file. The receipt will be saved but not emailed.</div>')
    + '<button type="button" class="btn btn-outline" onclick="toggleReceiptPreview()" id="rPrevBtn" style="margin-bottom:10px;">Preview Receipt Email</button>'
    + '<div id="rPreviewBox" style="display:none;margin-bottom:10px;"></div>'
    + '<button type="submit" class="btn btn-blue">&#10003; Complete Job &amp; Send Receipt</button>'
    + '</form>'

    + '<script>'
    + 'var rcPRICING=' + rPricingJson + ';'
    + 'function money(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'
    + 'function rmoney(n){return money(n);}'
    + CLI_JS
    // Shared quote pricing wiring (per-service rows, tier, calc, tags, hints).
    + quotePricingJs('rc')
    + 'function bkRecalc(){rccalc();}'
    // Receipt labels: the customer summary reads "Customer Receipt" / "Total Paid".
    + '(function(){var sl=document.getElementById("rcSummaryLabel");if(sl)sl.textContent="Customer Receipt";var tl=document.getElementById("rcTotalLabel");if(tl)tl.textContent="Total Paid";})();'
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
    + 'rPayToggle();cliInit();'
    // Build the per-service rows. If the booked quote/appointment saved an exact
    // per-service breakdown, rebuild those rows with their booked price overrides;
    // otherwise pull fresh defaults from the pricing table for the selected services.
    + '(function(){var seed=[];try{seed=JSON.parse((document.getElementById("rcSvcSeed")||{}).value||"[]");}catch(e){}'
    +   'if(Array.isArray(seed)&&seed.length){seed.forEach(function(it){rcAddPriceRow(it.service);var row=document.querySelector("#rcSvcPriceRows .svc-price-row[data-base=\'"+it.service+"\']");if(row){row.querySelector(".rc-parts-in").value=it.parts;row.querySelector(".rc-labor-in").value=it.labor;var mode=it.mode||"combined";row.querySelector(".svc-row-mode").value=mode;row.querySelectorAll(".svc-disp-btn").forEach(function(b,i){b.classList.toggle("active",(mode==="split")?i===1:i===0);});}});}'
    +   'else{rcInitRows();}'
    + '})();'
    + 'rcUpdateServiceHidden();rcRenderTags();rcHints();rccalc();'
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
    +   'var svcs=rcGetAllServiceNames();'
    +   'var rcustom=(document.querySelector("[name=customService]")||{}).value.trim();'
    +   'if(rcustom)svcs.push(rcustom);'
    +   'var veh=[(document.querySelector("[name=veh_year]")||{}).value||"",(document.querySelector("[name=veh_make]")||{}).value||"",(document.querySelector("[name=veh_model]")||{}).value||""].filter(Boolean).join(" ");'
    +   'var svcDate=(document.querySelector("[name=serviceDate]")||{}).value||"";'
    +   'var pm=(document.getElementById("rpm")||{}).value||"";'
    +   'var tot=document.getElementById("rctotalAmt").textContent||"$0.00";'
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
    +     '+cliCollect().map(function(it){return "<div style=\'margin-top:4px;\'><strong>"+it.label.replace(/</g,"&lt;")+":</strong> $"+rmoney(it.amount)+"</div>";}).join("")'
    +     '+"<div style=\'margin-top:4px;\'><strong>Total:</strong> "+tot+"</div>"'
    +     '+(pm?"<div style=\'margin-top:4px;\'><strong>Payment:</strong> "+pm+"</div>":"")'
    +     '+"</div>"'
    +     '+(advNotes.length?"<div style=\'margin-top:10px;\'><strong>Notes to customer:</strong><ul style=\'margin:6px 0 0 18px;padding:0;font-size:0.86rem;\'>"+advNotes.map(function(n){return"<li>"+n+"</li>";}).join("")+"</ul></div>":"")'
    +     '+"<p style=\'margin-top:10px;\'>All qualifying pad and rotor replacements come with a <strong>12-month / 12,000-mile warranty</strong>.</p>"'
    +     '+"</div>";'
    +   'box.style.display="block";document.getElementById("rPrevBtn").textContent="Hide Preview";'
    + '}'
    // Draft restore finalizer: re-check services + rebuild per-service price rows from
    // the restored svcLineItems, restore tier/payment/advisories/custom line items,
    // then recompute the total from restored amounts (no price re-pull).
    + 'window.bkReceiptAfter=function(d){'
    +   'var svc=(document.getElementById("rcsvcHidden").value||"").split(",").map(function(s){return s.trim();}).filter(Boolean);'
    +   'document.querySelectorAll(".rc-svc-cb").forEach(function(cb){cb.checked=svc.indexOf(cb.value)>=0;});'
    +   'document.querySelectorAll(".rc-pos-cb").forEach(function(cb){cb.checked=svc.indexOf(cb.getAttribute("data-prefix")+" - "+cb.getAttribute("data-pos"))>=0;});'
    +   'rctier=(document.getElementById("rctier").value)||"standard";'
    +   'document.getElementById("rcBtnStd").classList.toggle("active",rctier==="standard");'
    +   'document.getElementById("rcBtnPrem").classList.toggle("active",rctier==="premium");'
    +   'var rowsBox=document.getElementById("rcSvcPriceRows");if(rowsBox){rowsBox.innerHTML="";try{var sli=JSON.parse((document.getElementById("rcsvcLiH")||{}).value||"[]");if(Array.isArray(sli)&&sli.length){sli.forEach(function(it){rcAddPriceRow(it.service);var row=document.querySelector("#rcSvcPriceRows .svc-price-row[data-base=\'"+it.service+"\']");if(row){row.querySelector(".rc-parts-in").value=it.parts;row.querySelector(".rc-labor-in").value=it.labor;var mode=it.mode||"combined";row.querySelector(".svc-row-mode").value=mode;row.querySelectorAll(".svc-disp-btn").forEach(function(b,i){b.classList.toggle("active",(mode==="split")?i===1:i===0);});}});}else{rcInitRows();}}catch(e){rcInitRows();}}'
    +   'rcRenderTags();'
    +   'if(typeof rPayToggle==="function")rPayToggle();'
    +   'for(var i=2;i<=4;i++){var n=(document.querySelector("[name=custNote"+i+"]")||{}).value||"";var cu=(document.querySelector("[name=fuCustom"+i+"]")||{}).value||"";if(n||cu){var r=document.getElementById("advRow"+i);if(r)r.style.display="block";}}'
    +   'var allVis=true;for(var j=2;j<=4;j++){var rr=document.getElementById("advRow"+j);if(rr&&rr.style.display==="none")allVis=false;}'
    +   'if(allVis){var ab=document.getElementById("rAddAdvBtn");if(ab)ab.style.display="none";}'
    +   'for(var k=1;k<=4;k++){if(typeof toggleCustom==="function")toggleCustom(k);}'
    +   'try{var ci=JSON.parse((document.getElementById("cliJson")||{}).value||"[]");if(Array.isArray(ci)){var c=document.getElementById("cliRows");if(c){c.innerHTML="";ci.forEach(function(it){var w=document.createElement("div");w.innerHTML=cliRowHtml();var row=w.firstChild;row.querySelector(".cli-label").value=it.label||"";row.querySelector(".cli-amount").value=(it.amount!=null?it.amount:"");cliSetTax(row.querySelector(".cli-tax"),it.taxed!==false);c.appendChild(row);});}}}catch(e){}'
    +   'rccalc();'
    + '};'
    + '</script>'
    + VEHICLE_CASCADE_JS
    + (process.env.GOOGLE_MAPS_API_KEY
        ? '<script>function initBkRecAddr(){var el=document.getElementById("receiptAddr");if(!el||!window.google||!google.maps||!google.maps.places)return;var ac=new google.maps.places.Autocomplete(el,{fields:["formatted_address"],componentRestrictions:{country:"us"},types:["address"]});ac.addListener("place_changed",function(){if(ac.getPlace())el.value=ac.getPlace().formatted_address||el.value;});}<\/script>'
          + '<script src="https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(process.env.GOOGLE_MAPS_API_KEY) + '&libraries=places&loading=async&callback=initBkRecAddr" async><\/script>'
        : '');

  res.send(page('Receipt — ' + lead.first_name + ' ' + lead.last_name, body, req));
});

router.post('/receipt/:id/send', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.redirect('/admin');

  var service      = (req.body.service || '').trim();
  var customSvc    = (req.body.customService || '').trim();
  if (customSvc && service.split(',').map(function(s){return s.trim().toLowerCase();}).indexOf(customSvc.toLowerCase()) === -1) service = service ? service + ', ' + customSvc : customSvc;
  var vehicle      = [req.body.veh_year, req.body.veh_make, req.body.veh_model].map(function(v){return (v||'').trim();}).filter(Boolean).join(' ');
  var serviceDate  = (req.body.serviceDate || '').trim() || easternToday();
  var address      = (req.body.serviceAddress || '').trim();
  var parts        = parseFloat(req.body.parts)        || 0;
  var labor        = parseFloat(req.body.labor)        || 0;
  var partsLabor   = parts + labor;
  var shopSupplies = parseFloat(req.body.shopSupplies) || 0;
  // Shared pricing block posts taxAmt (older receipts posted `tax`); accept either.
  var tax          = parseFloat(req.body.taxAmt != null && req.body.taxAmt !== '' ? req.body.taxAmt : req.body.tax) || 0;
  var discount     = parseFloat(req.body.discount)     || 0;
  var lineItems    = parseLineItems(req.body.customLineItems);
  var lineItemsJson = lineItems.length ? JSON.stringify(lineItems) : null;
  var cliSum       = lineItems.reduce(function(a, it){ return a + (Number(it.amount) || 0); }, 0);
  var total        = partsLabor + shopSupplies + cliSum + tax - discount;
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
    'INSERT INTO receipts (lead_id, quote_id, service, vehicle, service_date, service_address, parts_labor, shop_supplies, tax, total, payment_method, customer_notes, office_notes, custom_line_items) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(lead.id, quote ? quote.id : null, service, vehicle, serviceDate, address, partsLabor, shopSupplies, tax, total, payment, JSON.stringify(notes), officeNotes, lineItemsJson);
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
        cc:      'greetings@brakeknights.com',
        replyTo: 'greetings@brakeknights.com',
        subject: 'Your Brake Knights Service Receipt',
        html:    buildReceiptEmail(lead, receipt, notes)
      });
      db.prepare("UPDATE receipts SET sent_at = datetime('now') WHERE id = ?").run(receiptId);
      db.prepare("UPDATE leads SET status = 'receipt', status_updated_at = datetime('now') WHERE id = ?").run(lead.id);
      logHistory(lead.id, 'Receipt sent to customer', receiptDetail);
      sendStagePush(lead, 'receipt');
      return res.redirect('/admin/quote/' + lead.id + '?msg=receipt_sent');
    } catch (err) {
      console.error('Receipt email error:', err.message);
      logHistory(lead.id, 'Receipt saved (email failed)', receiptDetail);
      sendStagePush(lead, 'completed');
      return res.redirect('/admin/quote/' + lead.id + '?msg=receipt_err');
    }
  }
  logHistory(lead.id, 'Receipt saved (not emailed)', receiptDetail);
  sendStagePush(lead, 'completed');
  res.redirect('/admin/quote/' + lead.id + '?msg=receipt_saved');
});

// Read-only view of a sent receipt: the exact customer copy, plus an internal
// panel with office notes and any follow-ups this receipt created.
router.get('/receipt/view/:id', requireAuth, function(req, res) {
  var receipt = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
  if (!receipt) return res.status(404).send('Receipt not found');
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(receipt.lead_id);
  if (!lead) return res.redirect('/admin');

  var notes = [];
  try { notes = JSON.parse(receipt.customer_notes || '[]'); } catch (_) {}
  var when = receipt.sent_at
    ? 'Emailed ' + new Date(receipt.sent_at + 'Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
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

  var body = '<a href="/admin/quote/' + lead.id + '" class="back-link"><span class="bk-arrow">&#8592;</span>Back to Lead</a>'
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
    + parseLineItems(r.custom_line_items).map(function(it) {
        return '<tr><td style="padding:6px 0;">' + esc(it.label) + '</td><td style="text-align:right;">$' + money(it.amount) + '</td></tr>';
      }).join('')
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
    return '<div class="card" onclick="if(!event.target.closest(\'a,button,select,form,input\')){window.location=\'/admin/quote/' + f.lead_id + '\';}" style="cursor:pointer;opacity:.78;">' + head + desc + meta + '</div>';
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
  return '<div class="card" onclick="if(!event.target.closest(\'a,button,select,form,input\')){window.location=\'/admin/quote/' + f.lead_id + '\';}" style="cursor:pointer;">' + head + desc + meta + actions + '</div>';
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
  var qqPricing = getEffectivePricing();
  var serviceNames = Object.keys(qqPricing);
  var pricingJson = JSON.stringify(qqPricing);
  var taxPct = +(PRICING.taxRate * 100).toFixed(2);

  // Customer data for the receipt-mode customer search typeahead.
  var qqCustomers = db.prepare(
    'SELECT c.id, c.first_name, c.last_name, c.email, c.phone,'
    + ' (SELECT cv.year  FROM customer_vehicles cv WHERE cv.customer_id = c.id ORDER BY cv.id DESC LIMIT 1) AS last_veh_year,'
    + ' (SELECT cv.make  FROM customer_vehicles cv WHERE cv.customer_id = c.id ORDER BY cv.id DESC LIMIT 1) AS last_veh_make,'
    + ' (SELECT cv.model FROM customer_vehicles cv WHERE cv.customer_id = c.id ORDER BY cv.id DESC LIMIT 1) AS last_veh_model,'
    + ' (SELECT ca.address FROM customer_addresses ca WHERE ca.customer_id = c.id ORDER BY ca.id DESC LIMIT 1) AS last_address'
    + ' FROM customers c ORDER BY c.last_name, c.first_name'
  ).all();
  var qqCustJson = JSON.stringify(qqCustomers.map(function(c) {
    var name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
    var vehParts = [c.last_veh_year, c.last_veh_make, c.last_veh_model].filter(Boolean);
    return {
      id: c.id,
      fn: c.first_name || '',
      ln: c.last_name || '',
      em: c.email || '',
      ph: c.phone || '',
      veh_year:  c.last_veh_year  || '',
      veh_make:  c.last_veh_make  || '',
      veh_model: c.last_veh_model || '',
      veh: vehParts.join(' '),
      addr: c.last_address || '',
      label: name + (c.phone ? ' (' + fmtPhone(c.phone) + ')' : ''),
      search: (name + ' ' + (c.phone || '') + ' ' + (c.email || '')).toLowerCase()
    };
  }));

  // Drafts list
  var allDrafts = db.prepare('SELECT id, label, created_at FROM quick_drafts ORDER BY id DESC').all();

  // Load a specific draft when ?draft=:id
  var draftJson = 'null';
  if (req.query.draft) {
    var draftRow = db.prepare('SELECT form_data FROM quick_drafts WHERE id = ?').get(req.query.draft);
    if (draftRow) draftJson = draftRow.form_data;
  }

  var draftsHtml = allDrafts.length
    ? '<div class="card" style="margin-bottom:12px;">'
      + '<div class="section-title" style="margin-bottom:10px;">Saved Drafts</div>'
      + allDrafts.map(function(d) {
          return '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #f0f0f0;">'
            + '<div><div style="font-size:0.88rem;font-weight:600;color:#0a1f3d;">' + esc(d.label) + '</div>'
            + '<div style="font-size:0.78rem;color:#aaa;">' + timeAgo(d.created_at) + '</div></div>'
            + '<div style="display:flex;gap:6px;flex-shrink:0;">'
            + '<a href="/admin/quick?draft=' + d.id + '" class="btn btn-navy btn-sm" style="width:auto;padding:6px 12px;font-size:0.8rem;">Load</a>'
            + '<form method="POST" action="/admin/quick/draft/' + d.id + '/delete" style="margin:0;" onsubmit="return confirm(\'Delete this draft?\');">'
            + '<button type="submit" class="btn btn-sm" style="width:auto;padding:6px 10px;font-size:0.8rem;background:#fff;border:1.5px solid #e0c0c0;color:#c0392b;">Delete</button>'
            + '</form></div></div>';
        }).join('')
      + '</div>'
    : '';

  var paymentOpts = PAYMENT_METHODS.map(function(p) {
    return '<option value="' + esc(p) + '">' + esc(p) + '</option>';
  }).join('');

  var advisoryRows = advisoryRow(1, false);
  for (var i = 2; i <= 4; i++) advisoryRows += advisoryRow(i, true);
  advisoryRows += '<button type="button" id="qqAddAdvBtn" class="svc-clear-btn" style="margin-top:6px;" onclick="qqAddAdvisory()">+ Add Advisory</button>';

  var alert = '';
  if (req.query.err === 'name')    alert = '<div class="alert alert-error">First and last name are required to save or send.</div>';
  if (req.query.err === 'email')   alert = '<div class="alert alert-error">An email address is required to send a quote or receipt. Use the copyable link instead, or add an email.</div>';
  if (req.query.msg === 'draft_saved') alert = '<div class="alert alert-success">Draft saved. Load it any time from the Saved Drafts list above.</div>';

  var body = '<a href="/admin" class="back-link"><span class="bk-arrow">&#8592;</span>All Leads</a>'
    + alert
    + draftsHtml
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
    + collapseOpen('qq_customer', 'Customer <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(needed to save or send)</span>', true)
    + '<input type="hidden" name="customer_id" id="qqCustId" value="">'
    + '<div style="margin-bottom:16px;">'
    + '<div class="form-group" style="margin-bottom:6px;">'
    + '<label>Find existing customer <span style="font-weight:400;color:#bbb;">(optional — fills fields below)</span></label>'
    + '<div style="position:relative;">'
    + '<input type="text" id="qqCustSearch" placeholder="Type name, phone, or email..." autocomplete="off" oninput="qqDoSearch()" onfocus="qqDoSearch()" onblur="qqHideDd()" style="width:100%;padding:10px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.95rem;box-sizing:border-box;">'
    + '<div id="qqCustDropdown" onclick="qqDdClick(event)" style="display:none;position:absolute;z-index:200;background:#fff;border:1.5px solid #b0c4e0;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.12);width:100%;max-height:220px;overflow-y:auto;top:calc(100% + 4px);left:0;"></div>'
    + '</div>'
    + '<div id="qqCustChip" style="display:none;margin-top:8px;"></div>'
    + '</div>'
    + '<div style="text-align:center;font-size:0.8rem;color:#bbb;margin:4px 0 4px;">— or enter new customer info below —</div>'
    + '</div>'
    + '<div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>First name</label><input type="text" name="firstName" id="qfn"></div>'
    + '<div class="form-group"><label>Last name</label><input type="text" name="lastName" id="qln"></div>'
    + '</div>'
    + '<div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Email <span id="qemHint" style="color:#bbb;font-weight:400;">(to send)</span></label><input type="email" name="email" id="qem" placeholder="customer@email.com"></div>'
    + '<div class="form-group"><label>Phone <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="tel" name="phone" id="qph" placeholder="703-555-0123" oninput="fmtPhoneInput(this)" maxlength="12"></div>'
    + '</div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Vehicle <span style="color:#bbb;font-weight:400;">(optional)</span></label>'
    + vehicleCascadeHtml('qq-veh')
    + '</div>'
    + COLLAPSE_CLOSE

    // Receipt-only date / payment / address
    + collapseOpen('qq_jobdetails', 'Job Details', true, ' qReceiptOnly', 'display:none;')
    + '<div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Date of service</label><input type="date" name="serviceDate" value="' + esc(easternToday()) + '"></div>'
    + '<div class="form-group"><label>Payment method</label>'
    + '<select name="paymentMethod" id="qpm" onchange="qPayToggle()">' + paymentOpts + '</select></div>'
    + '</div>'
    + '<div class="form-group" id="qpmOtherWrap" style="display:none;"><label>Specify payment method</label>'
    + '<input type="text" name="paymentOther" id="qpmOther" placeholder="e.g. Zelle, Venmo, Check"></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Service address</label>'
    + '<input type="text" name="serviceAddress" placeholder="Where the work was performed"></div>'
    + COLLAPSE_CLOSE

    // Shared quote pricing block (services + per-service breakdown, custom line
    // items, discount, customer summary, notes) — identical on every quote surface.
    + collapseOpen('qq_pricing', 'Service &amp; Pricing', true)
    + quotePricingBlock('q', { serviceNames: serviceNames, taxPct: taxPct })
    + COLLAPSE_CLOSE

    // Receipt-only advisories + office notes
    + collapseOpen('qq_advisories', 'Notes to Customer <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(each appears on the receipt)</span>', true, ' qReceiptOnly', 'display:none;')
    + advisoryRows
    + COLLAPSE_CLOSE
    + collapseOpen('qq_office', 'Notes to Office <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(internal only, never sent)</span>', true, ' qReceiptOnly', 'display:none;')
    + '<div class="form-group" style="margin-bottom:0;">'
    + '<textarea name="officeNotes" placeholder="Torque specs, parts used, condition observations, anything for the record…"></textarea></div>'
    + COLLAPSE_CLOSE

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
    + '<button type="button" class="btn btn-outline" style="margin-top:8px;border-color:#aaa;color:#555;" onclick="qSaveDraft()">' + ic('document') + 'Save Draft</button>'
    + '<button type="button" class="svc-clear-btn" style="margin-top:12px;width:100%;padding:10px;" onclick="if(confirm(\'Clear the form and start over? Nothing will be saved.\'))qClearAll()">&#10005; Clear &amp; Start Over</button>'
    + '</div>'
    + '</form>'

    + '<script>'
    + 'var qPRICING=' + pricingJson + ';'
    + 'var QDRAFT=' + draftJson + ';'
    + 'var QQCUSTS=' + qqCustJson + ';'
    + 'var qtier="standard";var qmode="quote";'
    + 'function qqEsc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}'
    + 'function qqHideDd(){setTimeout(function(){var dd=document.getElementById("qqCustDropdown");if(dd)dd.style.display="none";},150);}'
    + 'function qqDoSearch(){'
    +   'var q=document.getElementById("qqCustSearch").value.toLowerCase().trim();'
    +   'var dd=document.getElementById("qqCustDropdown");'
    +   'if(!q){dd.style.display="none";return;}'
    +   'var matches=QQCUSTS.filter(function(c){return c.search.indexOf(q)>=0;}).slice(0,8);'
    +   'if(!matches.length){dd.innerHTML=\'<div style="padding:10px 12px;color:#888;font-size:0.88rem;">No customers found</div>\';dd.style.display="block";return;}'
    +   'dd.innerHTML=matches.map(function(c){'
    +     'return \'<div data-cid="\'+c.id+\'" style="padding:10px 12px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:0.88rem;">\''
    +       '+\'<div style="font-weight:600;color:#0a1f3d;">\'+qqEsc(c.label)+\'</div>\''
    +       '+(c.em?\'<div style="color:#888;font-size:0.82rem;">\'+qqEsc(c.em)+\'</div>\':"")'
    +       '+(c.veh?\'<div style="color:#6b7a8d;font-size:0.82rem;">\'+qqEsc(c.veh)+\'</div>\':"")+'
    +       '\'</div>\';'
    +   '}).join("");'
    +   'dd.style.display="block";'
    + '}'
    + 'function qqDdClick(e){'
    +   'var item=e.target;'
    +   'while(item&&item!==e.currentTarget){if(item.dataset&&item.dataset.cid){qqCustPick(+item.dataset.cid);return;}item=item.parentElement;}'
    + '}'
    + 'function qqCustPick(id){'
    +   'var c=QQCUSTS.find(function(x){return x.id===id;});if(!c)return;'
    +   'document.getElementById("qqCustId").value=id;'
    +   'document.getElementById("qfn").value=c.fn;'
    +   'document.getElementById("qln").value=c.ln;'
    +   'document.getElementById("qem").value=c.em;'
    +   'document.getElementById("qph").value=c.ph;'
    +   'if(window.bkVehFill)window.bkVehFill("qq-veh",{year:c.veh_year||"",make:c.veh_make||"",model:c.veh_model||""});'
    +   'var addrEl=document.querySelector("[name=serviceAddress]");if(addrEl&&c.addr&&!addrEl.value)addrEl.value=c.addr;'
    +   'var name=(c.fn+" "+c.ln).trim();'
    +   'var chip=document.getElementById("qqCustChip");'
    +   'chip.innerHTML=\'<span style="display:inline-flex;align-items:center;gap:6px;background:#e8f0fe;border:1.5px solid #b8d0f8;border-radius:20px;padding:4px 12px;font-size:0.85rem;color:#0a1f3d;font-weight:600;">\'+qqEsc(name)+\' <button type="button" onclick="qqCustClear()" style="background:none;border:none;cursor:pointer;color:#888;font-size:1.1rem;padding:0 2px;line-height:1;">&#10005;</button></span>\';'
    +   'chip.style.display="block";'
    +   'document.getElementById("qqCustSearch").value="";'
    +   'document.getElementById("qqCustDropdown").style.display="none";'
    +   'qSaveState();'
    + '}'
    + 'function qqCustClear(){'
    +   'document.getElementById("qqCustId").value="";'
    +   'var chip=document.getElementById("qqCustChip");if(chip){chip.innerHTML="";chip.style.display="none";}'
    +   'qSaveState();'
    + '}'

    + 'function money(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'
    + CLI_JS
    // Shared quote pricing wiring (per-service rows, tier, calc, tags, hints). Defines
    // qcalc, qSetTier, qClearServices, qSvcCbChange, qPosCbChange, qAddPriceRow,
    // qRenderTags, qHints, qUpdateServiceHidden, qGetAllServiceNames, qInitRows, etc.
    + quotePricingJs('q')
    // Re-save the autosaved state on any pricing-block change.
    + 'function qAfterChange(){if(typeof qSaveState==="function")qSaveState();}'
    // Back-compat aliases so the surrounding Quick Quote glue keeps its old names.
    + 'function qqUpdateServiceHidden(){return qUpdateServiceHidden();}'
    + 'function qqGetAllServiceNames(){return qGetAllServiceNames();}'
    + 'function qqAddPriceRow(n){return qAddPriceRow(n);}'

    + 'function qSetMode(m){'
    +   'qmode=m;document.getElementById("qmode").value=m;'
    +   'document.getElementById("qModeQuote").classList.toggle("active",m==="quote");'
    +   'document.getElementById("qModeReceipt").classList.toggle("active",m==="receipt");'
    +   'var rec=m==="receipt";'
    +   'document.querySelectorAll(".qReceiptOnly").forEach(function(el){el.style.display=rec?"block":"none";});'
    +   'document.querySelectorAll(".qQuoteOnly").forEach(function(el){var isCard=el.classList.contains("card");el.style.display=rec?"none":(isCard?"block":"flex");});'
    +   'document.querySelector(".qQuoteActions").style.display=rec?"none":"block";'
    +   'document.querySelector(".qReceiptActions").style.display=rec?"block":"none";'
    +   'document.getElementById("qSummaryLabel").textContent=rec?"Customer Receipt":"Customer Quote";'
    +   'document.getElementById("qTotalLabel").textContent=rec?"Total Paid":"Total";'
    +   'document.getElementById("qemHint").textContent=rec?"(to send receipt)":"(to send)";'
    // Notes-to-customer (from the shared pricing block) only applies to a quote.
    +   'var qn=document.getElementById("qCustNotes");if(qn){var qng=qn.closest(".form-group");if(qng)qng.style.display=rec?"none":"";}'
    +   'if(rec){var cc=document.querySelector(\'.collapse[data-ckey="qq_customer"]\');if(cc)cc.classList.remove("collapsed");}'
    +   'qSaveState();'
    + '}'

    + 'function bkRecalc(){qcalc();}'
    + 'function qUpdateServices(){qUpdateServiceHidden();qRenderTags();qHints();qcalc();}'

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
    +   'var svcs=qqGetAllServiceNames();var qcsv=(document.getElementById("qCustomSvc")||{}).value||"";if(qcsv.trim())svcs=svcs.concat(qcsv.trim().split(",").map(function(s){return s.trim();}).filter(Boolean));'
    +   'var total=document.getElementById("qtotalAmt").textContent;'
    +   'var rec=qmode==="receipt";'
    +   'var vy=(document.getElementById("qq-veh-year")||{}).value||"";'
    +   'var vmk=(document.getElementById("qq-veh-make")||{}).value||"";'
    +   'var vmd=(document.getElementById("qq-veh-model-hid")||{}).value||"";'
    +   'var veh=[vy,vmk,vmd].filter(function(x){return x&&x!=="Other";}).join(" ");'
    +   'var toLine=(fn||ln?(fn+" "+ln).trim()+" ":"")+(em?"&lt;"+em+"&gt;":"<em style=\'color:#e07000\'>(no email entered)</em>");'
    +   'var rows="<table style=\'width:100%;border-collapse:collapse;font-size:0.88rem;\'>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;white-space:nowrap;vertical-align:top;\'>To</td><td style=\'padding:5px 0;\'>"+toLine+"</td></tr>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Subject</td><td style=\'padding:5px 0;\'>"+(rec?"Your Brake Knights Service Receipt":"Your Brake Service Quote — Brake Knights")+"</td></tr>";'
    +   'if(veh)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Vehicle</td><td style=\'padding:5px 0;font-weight:600;\'>"+veh+"</td></tr>";'
    +   'if(svcs.length)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;vertical-align:top;\'>Services</td><td style=\'padding:5px 0;\'>"+svcs.join(", ")+"</td></tr>";'
    +   'if(!rec){'
    +     'var qqi=JSON.parse(document.getElementById("qsvcLiH").value||"[]");'
    +     'var qss2=parseFloat(document.getElementById("qss").value)||0;'
    +     'var qtax=parseFloat(document.getElementById("qtaxH").value)||0;'
    +     'var qtot=parseFloat(document.getElementById("qtotalH").value)||0;'
    +     'function pmoney(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'
    +     'if(qqi.length){'
    +       'qqi.forEach(function(it){'
    +         'if(it.mode==="split"){'
    +           'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.service+" — Parts</td><td style=\'padding:5px 0;\'>$"+pmoney(it.parts)+"</td></tr>";'
    +           'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.service+" — Labor</td><td style=\'padding:5px 0;\'>$"+pmoney(it.labor)+"</td></tr>";'
    +         '}else{'
    +           'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.service+"</td><td style=\'padding:5px 0;\'>$"+pmoney(it.parts+it.labor)+"</td></tr>";'
    +         '}'
    +       '});'
    +     '}else{'
    +       'var qp2=parseFloat(document.getElementById("qpartsH").value)||0;'
    +       'var ql2=parseFloat(document.getElementById("qlaborH").value)||0;'
    +       'if(qp2+ql2>0)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Parts &amp; Labor</td><td style=\'padding:5px 0;\'>$"+pmoney(qp2+ql2)+"</td></tr>";'
    +     '}'
    +     'cliCollect().forEach(function(it){rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.label.replace(/</g,"&lt;")+"</td><td style=\'padding:5px 0;\'>$"+pmoney(it.amount)+"</td></tr>";});'
    +     'if(qss2>0)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Shop Supplies</td><td style=\'padding:5px 0;\'>$"+pmoney(qss2)+"</td></tr>";'
    +     'if(qtax>0)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Tax</td><td style=\'padding:5px 0;\'>$"+pmoney(qtax)+"</td></tr>";'
    +     'var qdsc=parseFloat((document.getElementById("qdisc")||{}).value)||0;'
    +     'if(qdsc>0){var qdl=((document.getElementById("qdiscLabel")||{}).value||"").trim();rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#1a7a3a;\'>Discount"+(qdl?" ("+qdl.replace(/</g,"&lt;")+")":"")+"</td><td style=\'padding:5px 0;color:#1a7a3a;\'>-$"+pmoney(qdsc)+"</td></tr>";}'
    +     'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;font-weight:700;\'>Total</td><td style=\'padding:5px 0;font-weight:700;\'>$"+pmoney(qtot)+"</td></tr>";'
    +     'var qcn=(document.getElementById("qCustNotes")||{}).value||"";'
    +     'if(qcn.trim())rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;vertical-align:top;\'>Notes to customer</td><td style=\'padding:5px 0;font-style:italic;\'>"+qcn+"</td></tr>";'
    +   '}'
    +   'if(rec){'
    +     'cliCollect().forEach(function(it){rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.label.replace(/</g,"&lt;")+"</td><td style=\'padding:5px 0;\'>$"+money(it.amount)+"</td></tr>";});'
    +     'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;font-weight:700;\'>Total Paid</td><td style=\'padding:5px 0;font-weight:700;\'>"+total+"</td></tr>";'
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
    +   'if(window.bkVehFill)window.bkVehFill("qq-veh",{});'
    +   'var cse=document.getElementById("qCustomSvc");if(cse)cse.value="";'
    +   'document.getElementById("qss").value="0.00";'
    +   'var cliC=document.getElementById("cliRows");if(cliC)cliC.innerHTML="";var cliH=document.getElementById("cliJson");if(cliH)cliH.value="[]";'
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
    +   'document.getElementById("qqCustId").value="";'
    +   'var qqcChip=document.getElementById("qqCustChip");if(qqcChip){qqcChip.innerHTML="";qqcChip.style.display="none";}'
    +   'var qqcSrch=document.getElementById("qqCustSearch");if(qqcSrch)qqcSrch.value="";'
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
    +       'savedAt:Date.now(),'
    +       'mode:qmode,tier:qtier,'
    +       'fn:document.getElementById("qfn").value,'
    +       'ln:document.getElementById("qln").value,'
    +       'em:document.getElementById("qem").value,'
    +       'ph:document.getElementById("qph").value,'
    +       'veh_year:document.getElementById("qq-veh-year")?(document.getElementById("qq-veh-year").value||""):"",veh_make:document.getElementById("qq-veh-make")?(document.getElementById("qq-veh-make").value||""):"",veh_model:document.getElementById("qq-veh-model-hid")?(document.getElementById("qq-veh-model-hid").value||""):"",veh:"",'
    +       'svcs:qCheckedServices(),'
    +       'posSvcs:Array.from(document.querySelectorAll(".q-pos-cb:checked")).map(function(c){return{par:c.getAttribute("data-parent"),pfx:c.getAttribute("data-prefix"),pos:c.getAttribute("data-pos")};}),'
    +       'svcRows:Array.from(document.querySelectorAll("#qSvcPriceRows .svc-price-row")).map(function(r){var t=r.querySelector(".svc-price-title span");var m=(r.querySelector(".svc-row-mode")||{}).value||"combined";return{base:r.getAttribute("data-base"),label:t?t.textContent:r.getAttribute("data-base"),parts:r.querySelector(".q-parts-in").value,labor:r.querySelector(".q-labor-in").value,mode:m};}),'
    +       'customSvc:qCustomSvcVal(),'
    +       'ss:document.getElementById("qss").value,'
    +       'tr:document.getElementById("qtr").value,'
    +       'disc:(document.getElementById("qdisc")||{}).value||"0",'
    +       'discLabel:(document.getElementById("qdiscLabel")||{}).value||"",'
    +       'custNotes:(document.getElementById("qCustNotes")||{}).value||"",'
    +       'cli:(typeof cliCollect==="function")?cliCollect():[],'
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
    +     'var s=QDRAFT;'
    +     'if(!s){var raw=localStorage.getItem("bk_qq_state");if(!raw)return;s=JSON.parse(raw);if(s&&s.savedAt&&Date.now()-s.savedAt>24*60*60*1000){try{localStorage.removeItem("bk_qq_state");}catch(_){}return;}}'
    +     'if(!s)return;'
    +     'if(s.mode)qSetMode(s.mode);'
    +     'if(s.tier)qSetTier(s.tier);'
    +     'if(s.fn)document.getElementById("qfn").value=s.fn;'
    +     'if(s.ln)document.getElementById("qln").value=s.ln;'
    +     'if(s.em)document.getElementById("qem").value=s.em;'
    +     'if(s.ph)document.getElementById("qph").value=s.ph;'
    +     'if(window.bkVehFill&&(s.veh_year||s.veh_make||s.veh_model))window.bkVehFill("qq-veh",{year:s.veh_year||"",make:s.veh_make||"",model:s.veh_model||""});'
    +     'if(s.svcs&&s.svcs.length){document.querySelectorAll(".q-svc-cb").forEach(function(cb){cb.checked=s.svcs.indexOf(cb.value)>=0;});}'
    +     'if(s.posSvcs&&s.posSvcs.length){s.posSvcs.forEach(function(q){var el=document.querySelector(".q-pos-cb[data-parent=\'"+q.par+"\'][data-pos=\'"+q.pos+"\']");if(el)el.checked=true;});}'
    +     'if(s.svcRows&&s.svcRows.length){'
    // Rebuild each saved per-service row via the shared helper, then apply its
    // saved parts/labor/mode (preserves any manual price overrides in the draft).
    +       's.svcRows.forEach(function(r){'
    +         'qAddPriceRow(r.base);'
    +         'var row=document.querySelector("#qSvcPriceRows .svc-price-row[data-base=\'"+r.base+"\']");'
    +         'if(row){row.querySelector(".q-parts-in").value=(r.parts||0);row.querySelector(".q-labor-in").value=(r.labor||0);'
    +           'var m=r.mode||"combined";row.querySelector(".svc-row-mode").value=m;'
    +           'row.querySelectorAll(".svc-disp-btn").forEach(function(b,i){b.classList.toggle("active",(m==="split")?i===1:i===0);});}'
    +       '});'
    +     '}else if(s.svcs&&s.svcs.length){'
    +       'document.querySelectorAll(".q-svc-cb:checked").forEach(function(cb){qAddPriceRow(cb.value);});'
    +       'if(s.posSvcs&&s.posSvcs.length)s.posSvcs.forEach(function(q){qAddPriceRow(q.pfx+" - "+q.pos);});'
    +     '}'
    +     'var cse=document.getElementById("qCustomSvc");if(cse&&s.customSvc){cse.value=s.customSvc;}'
    +     'if(s.ss!==undefined)document.getElementById("qss").value=s.ss;'
    +     'if(s.tr!==undefined)document.getElementById("qtr").value=s.tr;'
    +     'if(s.disc!==undefined&&document.getElementById("qdisc"))document.getElementById("qdisc").value=s.disc;'
    +     'if(s.discLabel!==undefined&&document.getElementById("qdiscLabel"))document.getElementById("qdiscLabel").value=s.discLabel;'
    +     'if(s.custNotes!==undefined&&document.getElementById("qCustNotes"))document.getElementById("qCustNotes").value=s.custNotes;'
    +     'if(Array.isArray(s.cli)){var cliC=document.getElementById("cliRows");if(cliC){cliC.innerHTML="";s.cli.forEach(function(it){var w=document.createElement("div");w.innerHTML=cliRowHtml();var row=w.firstChild;row.querySelector(".cli-label").value=it.label||"";row.querySelector(".cli-amount").value=(it.amount!=null?it.amount:"");cliSetTax(row.querySelector(".cli-tax"),it.taxed!==false);cliC.appendChild(row);});}}'
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
    +     'qqUpdateServiceHidden();qRenderTags();qHints();qPayToggle();qcalc();'
    +   '}catch(_){}'
    + '}'

    + 'function qSaveDraft(){'
    +   'qSaveState();'
    +   'document.getElementById("qaction").value="draft_save";'
    +   'document.getElementById("qqf").submit();'
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
    + 'qqUpdateServiceHidden();qRenderTags();qPayToggle();'
    + 'qRestoreState();'
    + 'qcalc();'
    + '</script>'
    + VEHICLE_CASCADE_JS;

  res.send(page('Quick Quote', body, req));
});

// Result page for the copyable-link outcome: shows the branded customer URL in a
// read-only field with a one-tap copy button, plus a link to the new lead.
function quickLinkResult(req, lead, acceptUrl) {
  var body = '<a href="/admin/quick" class="back-link"><span class="bk-arrow">&#8592;</span>New Quick Quote</a>'
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
  var vehYear   = (req.body.veh_year  || '').trim();
  var vehMake   = (req.body.veh_make  || '').trim();
  var vehModel  = (req.body.veh_model || '').trim();
  var vehicle   = [vehYear, vehMake, vehModel].filter(Boolean).join(' ') || null;

  // Save Draft: persist form state to quick_drafts, no lead created, no validation.
  if (action === 'draft_save') {
    var customSvcD = (req.body.customService || '').trim();
    var serviceD   = (req.body.service || '').trim();
    var allSvcsD   = serviceD ? serviceD.split(',').map(function(s){return s.trim();}).filter(Boolean) : [];
    var presetSvcsD = allSvcsD.filter(function(s){ return !!PRICING.services[s]; });
    var draftLabel = (firstName || lastName) ? (firstName + ' ' + lastName).trim() : 'Untitled';
    var firstSvcD  = allSvcsD[0] || '';
    if (firstSvcD) draftLabel += ' - ' + firstSvcD.substring(0, 28);
    // Per-service rows [{service,parts,labor,mode}] from the shared block; saved so
    // the draft restores exact prices (and any overrides), not just re-pulled defaults.
    var svcRowsD = [];
    try { var _sr = JSON.parse(req.body.svcLineItems || '[]'); if (Array.isArray(_sr)) svcRowsD = _sr.map(function(it){ return { base: it.service, label: it.service, parts: it.parts, labor: it.labor, mode: it.mode || 'combined' }; }); } catch (_) {}
    var draftData = {
      mode: mode, tier: req.body.tier === 'premium' ? 'premium' : 'standard',
      fn: firstName, ln: lastName, em: email || '', ph: phone, veh: '', veh_year: vehYear, veh_make: vehMake, veh_model: vehModel,
      svcs: presetSvcsD, customSvc: customSvcD,
      svcRows: svcRowsD,
      parts: req.body.parts || '0.00', labor: req.body.labor || '0.00',
      ss: req.body.shopSupplies || '0.00',
      tr: req.body.taxRate || String(+(PRICING.taxRate * 100).toFixed(2)),
      disc: req.body.discount || '0',
      cli: parseLineItems(req.body.customLineItems),
      custNotes: (req.body.customerNotes || ''),
      payMethod: req.body.paymentMethod || '', payOther: req.body.paymentOther || '',
      svcDate: req.body.serviceDate || '', svcAddr: req.body.serviceAddress || '',
      offNotes: req.body.officeNotes || '',
      adv: [1,2,3,4].map(function(i) {
        return { note: req.body['custNote'+i]||'', recv: req.body['fuRecipient'+i]||'owner', cust: req.body['fuCustom'+i]||'' };
      })
    };
    db.prepare("INSERT INTO quick_drafts (label, form_data) VALUES (?, ?)").run(draftLabel, JSON.stringify(draftData));
    return res.redirect('/admin/quick?msg=draft_saved');
  }

  if (!firstName || !lastName) return res.redirect('/admin/quick?err=name');

  var isSend = (action === 'quote_send' || action === 'receipt_send');
  if (isSend && !email) return res.redirect('/admin/quick?err=email');

  var service      = (req.body.service || '').trim();
  var customSvc    = (req.body.customService || '').trim();
  if (customSvc && service.split(',').map(function(s){return s.trim().toLowerCase();}).indexOf(customSvc.toLowerCase()) === -1) service = service ? service + ', ' + customSvc : customSvc;
  var tier         = req.body.tier === 'premium' ? 'premium' : 'standard';
  var parts        = parseFloat(req.body.parts)        || 0;
  var labor        = parseFloat(req.body.labor)        || 0;
  var shopSupplies = parseFloat(req.body.shopSupplies) || 0;
  var taxRate      = parseFloat(req.body.taxRate)      || 0;
  var taxAmt       = parseFloat(req.body.taxAmt)       || 0;
  var totalAmt     = parseFloat(req.body.totalAmt)     || 0;
  var discount     = parseFloat(req.body.discount)     || 0;
  var discountLabel = (req.body.discount_label || '').trim() || null;
  // Per-service breakdown JSON [{service,parts,labor,mode}] from the shared block.
  var lineItemsJson = (req.body.svcLineItems || '').trim() || null;
  var quoteCustomerNotes = (req.body.customerNotes || '').trim() || null;
  var customLineItems = parseLineItems(req.body.customLineItems);
  var customLineItemsJson = customLineItems.length ? JSON.stringify(customLineItems) : null;

  var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');

  // Every save/send outcome creates a Quick Quote lead. Quote mode lands it in
  // Quoted; receipt mode reflects a finished job (set further down).
  var existingCustId = parseInt(req.body.customer_id) || 0;
  var initialStatus = mode === 'receipt' ? 'completed' : 'quoted';
  var leadInfo;
  if (existingCustId) {
    leadInfo = db.prepare(
      'INSERT INTO leads (first_name, last_name, phone, email, vehicle, service, source, status, customer_id) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(firstName, lastName, phone, email, vehicle, service || null, 'Quick Quote', initialStatus, existingCustId);
  } else {
    leadInfo = db.prepare(
      'INSERT INTO leads (first_name, last_name, phone, email, vehicle, service, source, status) VALUES (?,?,?,?,?,?,?,?)'
    ).run(firstName, lastName, phone, email, vehicle, service || null, 'Quick Quote', initialStatus);
  }
  var leadId = leadInfo.lastInsertRowid;
  if (existingCustId) {
    // Backfill any new contact info onto the existing customer record.
    try {
      var eCust = db.prepare('SELECT * FROM customers WHERE id = ?').get(existingCustId);
      if (eCust) {
        var eSets = [], eVals = [];
        if (!eCust.email && email) { eSets.push('email = ?'); eVals.push(email); }
        if (!eCust.phone && phone) { eSets.push('phone = ?'); eVals.push(phone); }
        if (eSets.length) {
          eVals.push(existingCustId);
          var backfillStmt = db.prepare('UPDATE customers SET ' + eSets.join(', ') + ' WHERE id = ?');
          backfillStmt.run.apply(backfillStmt, eVals);
        }
      }
    } catch (err) { console.error('Customer backfill error:', err.message); }
  } else {
    // Phase 7B: attach to an existing customer (email then phone) or create one.
    try { customers.linkLead(leadId); } catch (err) { console.error('Customer auto-link error:', err.message); }
  }
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  logHistory(leadId, 'Lead created from Quick Quote', (mode === 'receipt' ? 'Receipt' : 'Quote') + (service ? ' — ' + service : ''));

  // ── Quote mode ──────────────────────────────────────────────────────────────
  if (mode === 'quote') {
    var acceptToken = crypto.randomBytes(24).toString('hex');
    var qStatus = action === 'quote_save' ? 'saved' : 'sent';
    var qInfo = db.prepare(
      'INSERT INTO quotes (lead_id, service, tier, price_parts, price_labor, shop_supplies, tax_rate, tax, total, line_items, customer_notes, discount, discount_label, accept_token, sent_at, status) '
      + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(leadId, service, tier, parts, labor, shopSupplies, taxRate / 100, taxAmt, totalAmt, customLineItemsJson, quoteCustomerNotes, discount, discountLabel, acceptToken,
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
    // If THIS lead already has a sent quote on file, mark this one as updated. Scoped
    // to the lead, not the email, so a repeat customer's fresh inquiry reads as "new".
    // The new quote above still has sent_at = null, so it won't count itself here.
    var qqRevised = db.prepare(
      'SELECT COUNT(*) AS n FROM quotes WHERE lead_id = ? AND sent_at IS NOT NULL'
    ).get(leadId).n > 0;
    try {
      var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      await tx.sendMail({
        from:    '"Brake Knights" <greetings@brakeknights.com>',
        to:      email,
        cc:      'greetings@brakeknights.com',
        replyTo: 'greetings@brakeknights.com',
        subject: qqRevised
          ? 'Your Updated Brake Service Quote — Brake Knights'
          : 'Your Brake Service Quote — Brake Knights',
        html:    buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, taxAmt, totalAmt, acceptUrl, lineItemsJson ? (function(){try{return JSON.parse(lineItemsJson);}catch(e){return null;}})() : null, qqRevised, quoteCustomerNotes, customLineItems, discount, discountLabel)
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
    'INSERT INTO receipts (lead_id, service, vehicle, service_date, service_address, parts_labor, shop_supplies, tax, total, payment_method, customer_notes, office_notes, custom_line_items) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(leadId, service, vehicle, serviceDate, address, partsLabor, shopSupplies, taxAmt, totalAmt, payment, JSON.stringify(notes), officeNotes, customLineItemsJson);
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
        cc:      'greetings@brakeknights.com',
        replyTo: 'greetings@brakeknights.com',
        subject: 'Your Brake Knights Service Receipt',
        html:    buildReceiptEmail(lead, receipt, notes)
      });
      db.prepare("UPDATE receipts SET sent_at = datetime('now') WHERE id = ?").run(receiptId);
      db.prepare("UPDATE leads SET status = 'receipt', status_updated_at = datetime('now') WHERE id = ?").run(leadId);
      logHistory(leadId, 'Receipt sent to customer', receiptDetail);
      sendStagePush(lead, 'receipt');
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

router.post('/quick/draft/:id/delete', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  db.prepare('DELETE FROM quick_drafts WHERE id = ?').run(req.params.id);
  res.redirect('/admin/quick');
});

// ─── Phase 7B: Customer profiles ─────────────────────────────────────────────
// A customer groups one or more leads (the same person across multiple
// inquiries/jobs). Auto-linked on lead creation by email then phone. See
// customers.js for the matching + stats logic.

var CUSTOMER_TAGS = customers.TAGS;

// Formats a stored datetime ('YYYY-MM-DD HH:MM:SS') or date ('YYYY-MM-DD') as a
// short "Jun 5, 2026". Returns an em-free dash placeholder when empty.
function shortDate(str) {
  if (!str) return '—';
  if (str.length > 10) {
    var d = new Date(str.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return esc(str);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  }
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  var d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(str);
  if (isNaN(d.getTime())) return esc(str);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function customerTagBadge(tag) {
  var colors = {
    'Repeat Customer': 'background:#e6f9ee;color:#0a6b2e;',
    'Fleet':           'background:#e3f0ff;color:#1a6fc4;',
    'Referred':        'background:#fce8ff;color:#8b2fc9;',
    'VIP':             'background:#e0e7ff;color:#3730a3;'
  };
  return '<span style="' + (colors[tag] || 'background:#eef2f8;color:#4a5b73;')
    + 'padding:2px 9px;border-radius:12px;font-size:0.72rem;font-weight:700;white-space:nowrap;">' + esc(tag) + '</span>';
}

function customerTagBadges(str) {
  var t = (str || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  if (!t.length) return '';
  return '<div style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;">' + t.map(customerTagBadge).join('') + '</div>';
}

function statBlock(label, val) {
  return '<div style="background:#fff;border:1px solid var(--gray-200);border-radius:12px;padding:20px 14px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06);">'
    + '<div style="font-size:1.875rem;font-weight:700;color:var(--gray-900);line-height:1.1;">' + val + '</div>'
    + '<div style="font-size:0.875rem;color:var(--gray-400);margin-top:4px;">' + esc(label) + '</div></div>';
}

// Customer list — searchable, with per-customer lifetime stats.
router.get('/customers', requireAuth, function(req, res) {
  // Always load all customers — client-side JS filters in place so no page reload
  // (page reloads dismiss the iOS keyboard on every keystroke, which is unusable).
  var rows = db.prepare('SELECT * FROM customers ORDER BY id DESC').all();

  // Attach stats and surface the most recently active customers first.
  var list = rows.map(function(c) { return { c: c, s: customers.statsFor(c.id) }; });
  list.sort(function(a, b) { return (b.s.lastLeadDate || '').localeCompare(a.s.lastLeadDate || ''); });

  var total = rows.length;

  var searchBar = '<div style="margin-bottom:14px;display:flex;gap:8px;flex-wrap:wrap;">'
    + '<input type="text" id="custSearchInput" placeholder="Search by name, phone, or email..." '
    + 'style="flex:1;min-width:180px;padding:9px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.9rem;background:#fff;" autocomplete="off">'
    + '<select id="custSortSelect" style="flex:0 0 auto;padding:9px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.9rem;background:#fff;color:#0a1f3d;">'
    + '<option value="activity">Recent activity</option>'
    + '<option value="visit">Most jobs</option>'
    + '<option value="fn">First name (A–Z)</option>'
    + '<option value="ln">Last name (A–Z)</option>'
    + '<option value="newest">Newest added</option>'
    + '<option value="oldest">Oldest added</option>'
    + '</select>'
    + '</div>';

  var emptyMsg = 'No customers yet. They are created automatically as leads come in.';

  var cards = list.length === 0
    ? '<div class="empty" id="custEmpty"><div style="margin-bottom:10px;">' + icon('users') + '</div>' + emptyMsg + '</div>'
    : '<div id="custEmpty" style="display:none;padding:32px;text-align:center;color:#888;">No customers match your search.</div>'
      + list.map(function(item) {
          var c = item.c, s = item.s;
          var name = (c.first_name + ' ' + c.last_name).trim() || 'Unnamed customer';
          var searchText = (name + ' ' + (c.phone || '') + ' ' + (c.email || '')).toLowerCase();
          var dataAttrs = ' data-search="' + esc(searchText) + '"'
            + ' data-fn="' + esc((c.first_name || '').toLowerCase()) + '"'
            + ' data-ln="' + esc((c.last_name || '').toLowerCase()) + '"'
            + ' data-created="' + esc(c.created_at || '') + '"'
            + ' data-activity="' + esc(s.lastLeadDate || '') + '"'
            + ' data-visit="' + esc(s.lastJobDate || '') + '"'
            + ' data-jobs="' + String(s.completedCount || 0).padStart(6, '0') + '"';
          return '<div class="card cust-card"' + dataAttrs + ' onclick="if(!event.target.closest(\'a,button,form\')){window.location=\'/admin/customer/' + c.id + '\';}" style="cursor:pointer;border-left:3px solid var(--cta);">'
            + '<div class="row-sb">'
            + '<div class="lead-name">' + esc(name) + '</div>'
            + '<span style="font-size:0.78rem;color:#888;white-space:nowrap;">' + s.completedCount + ' job' + (s.completedCount === 1 ? '' : 's') + '</span>'
            + '</div>'
            + '<div class="lead-meta" style="margin-top:4px;">'
            + (c.phone ? '<a href="tel:' + esc(c.phone) + '" style="color:#1a6fc4;text-decoration:none;" onclick="event.stopPropagation();">' + esc(fmtPhone(c.phone)) + '</a>' : '<span style="color:#bbb;">No phone</span>')
            + (c.email ? ' &middot; ' + esc(c.email) : '')
            + '</div>'
            + customerTagBadges(c.tags)
            + '<div style="display:flex;gap:18px;margin-top:11px;font-size:0.82rem;color:#444;flex-wrap:wrap;">'
            + '<span><strong style="color:#0a1f3d;">$' + money(s.revenue) + '</strong> lifetime</span>'
            + '<span>Last activity ' + shortDate(s.lastLeadDate) + '</span>'
            + (s.lastJobDate ? '<span>Last job ' + shortDate(s.lastJobDate) + '</span>' : '')
            + '</div>'
            + contactActions(c, 11)
            + '<form method="POST" action="/admin/customer/' + c.id + '/delete" style="margin-top:10px;" onsubmit="return confirm(\'Delete this customer? Their leads will be kept but unlinked.\');">'
            + '<button type="submit" style="background:none;border:none;color:#c0392b;font-size:0.78rem;font-weight:600;cursor:pointer;padding:0;">' + ic('trash') + 'Delete customer</button>'
            + '</form>'
            + '</div>';
        }).join('');

  res.send(page('Customers',
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">'
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;">Customers</h1>'
    + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
    + '<a href="/admin/customer/new" class="btn btn-navy btn-sm" style="width:auto;">+ New Customer</a>'
    + '<a href="/admin/customers/import-square" class="btn btn-outline btn-sm" style="width:auto;">Import from Square</a>'
    + '<span style="color:#aaa;font-size:0.83rem;" id="custCount">' + total + ' total</span>'
    + '</div>'
    + '</div>'
    + searchBar
    + '<div id="custList">' + cards + '</div>'
    + '<script>(function(){'
    + 'var inp=document.getElementById("custSearchInput");'
    + 'var count=document.getElementById("custCount");'
    + 'var empty=document.getElementById("custEmpty");'
    + 'if(!inp)return;'
    + 'inp.addEventListener("input",function(){'
    + 'var q=inp.value.trim().toLowerCase();'
    + 'var cards=document.querySelectorAll(".cust-card");'
    + 'var shown=0;'
    + 'cards.forEach(function(el){'
    + 'var match=!q||el.dataset.search.indexOf(q)!==-1;'
    + 'el.style.display=match?"":"none";'
    + 'if(match)shown++;'
    + '});'
    + 'if(count)count.textContent=q?(shown+" of ' + total + '"):"' + total + ' total";'
    + 'if(empty)empty.style.display=(shown===0&&q)?"block":"none";'
    + '});'
    // Client-side sort: reorder the cards in place without a reload.
    + 'var sortSel=document.getElementById("custSortSelect");'
    + 'var listEl=document.getElementById("custList");'
    + 'function applySort(){'
    + 'if(!sortSel||!listEl)return;'
    + 'var mode=sortSel.value;'
    + 'var cards=Array.prototype.slice.call(document.querySelectorAll(".cust-card"));'
    + 'function g(el,k){return el.getAttribute(k)||"";}'
    + 'cards.sort(function(a,b){'
    + 'if(mode==="fn")return g(a,"data-fn").localeCompare(g(b,"data-fn"))||g(a,"data-ln").localeCompare(g(b,"data-ln"));'
    + 'if(mode==="ln")return g(a,"data-ln").localeCompare(g(b,"data-ln"))||g(a,"data-fn").localeCompare(g(b,"data-fn"));'
    + 'if(mode==="newest")return g(b,"data-created").localeCompare(g(a,"data-created"));'
    + 'if(mode==="oldest")return g(a,"data-created").localeCompare(g(b,"data-created"));'
    + 'if(mode==="visit")return g(b,"data-jobs").localeCompare(g(a,"data-jobs"))||g(b,"data-visit").localeCompare(g(a,"data-visit"));'
    + 'var da=g(a,"data-activity"),db2=g(b,"data-activity");'
    + 'if(db2&&!da)return 1;if(da&&!db2)return -1;'
    + 'return db2.localeCompare(da);'
    + '});'
    + 'cards.forEach(function(el){listEl.appendChild(el);});'
    + 'try{localStorage.setItem("bk_cust_sort",mode);}catch(_){}'
    + '}'
    + 'if(sortSel){'
    + 'try{var saved=localStorage.getItem("bk_cust_sort");if(saved)sortSel.value=saved;}catch(_){}'
    + 'sortSel.addEventListener("change",applySort);'
    + 'applySort();'
    + '}'
    + '})();</script>',
    req
  ));
});

// New customer form.
router.get('/customer/new', requireAuth, function(req, res) {
  var alert = '';
  if (req.query.err === 'name') alert = '<div class="alert alert-error">First and last name are required.</div>';

  var body = '<a href="/admin/customers" class="back-link"><span class="bk-arrow">&#8592;</span>All Customers</a>'
    + alert
    + '<form method="POST" action="/admin/customer/new" data-autosave="custnew">'
    + '<div class="card">'
    + '<div class="section-title">Contact</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>First name <span style="color:#c0392b;">*</span></label><input type="text" name="first_name" required autofocus></div>'
    + '<div class="form-group"><label>Last name <span style="color:#c0392b;">*</span></label><input type="text" name="last_name" required></div>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Phone</label><input type="tel" name="phone" placeholder="703-555-0123" oninput="fmtPhoneInput(this)" maxlength="12"></div>'
    + '<div class="form-group"><label>Email</label><input type="email" name="email" placeholder="customer@email.com"></div>'
    + '</div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Address <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="text" name="home_address" placeholder="123 Main St, Burke, VA 22015" autocomplete="off"></div>'
    + '</div>'
    + '<div class="card">'
    + '<div class="section-title">Vehicle <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(optional)</span></div>'
    + vehicleCascadeHtml('custnew-veh')
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
    + '<div class="form-group" style="margin-bottom:0;"><label>VIN <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="text" name="veh_vin" maxlength="17" placeholder="optional"></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>License plate <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="text" name="veh_plate" maxlength="10" placeholder="optional"></div>'
    + '</div>'
    + '</div>'
    + '<div class="card">'
    + '<div class="section-title">Additional Info</div>'
    + '<div class="form-group"><label>Tags <span style="color:#bbb;font-weight:400;">(comma-separated)</span></label><input type="text" name="tags" placeholder="Fleet, HOA, Referral..."></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Internal Notes</label><textarea name="notes" placeholder="Gate code, dog in yard, preferred contact times..."></textarea></div>'
    + '</div>'
    + '<div style="display:flex;gap:10px;align-items:center;margin-top:4px;">'
    + '<button type="submit" class="btn btn-navy" style="flex:1;">Create Customer</button>'
    + '<a href="/admin/customer/new" class="btn btn-outline" style="width:auto;" onclick="bkClearDraft(\'custnew\')">Start Over</a>'
    + '</div>'
    + '</form>'
    + VEHICLE_CASCADE_JS;

  res.send(page('New Customer', body, req));
});

router.post('/customer/new', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var first_name = (req.body.first_name || '').trim();
  var last_name  = (req.body.last_name  || '').trim();
  if (!first_name || !last_name) return res.redirect('/admin/customer/new?err=name');

  var phone  = (req.body.phone  || '').trim() || null;
  var email  = (req.body.email  || '').trim() || null;
  var tags   = (req.body.tags   || '').trim() || null;
  var notes  = (req.body.notes  || '').trim() || null;

  var homeAddress = (req.body.home_address || '').trim() || null;

  var result = db.prepare(
    'INSERT INTO customers (first_name, last_name, phone, email, home_address, tags, notes) VALUES (?,?,?,?,?,?,?)'
  ).run(first_name, last_name, phone, email, homeAddress, tags, notes);
  var newId = result.lastInsertRowid;

  if (homeAddress) {
    db.prepare('INSERT INTO customer_addresses (customer_id, label, address) VALUES (?,?,?)').run(newId, 'Home', homeAddress);
  }

  var vehYear  = (req.body.veh_year  || '').trim() || null;
  var vehMake  = (req.body.veh_make  || '').trim() || null;
  var vehModel = (req.body.veh_model || '').trim() || null;
  var vehVin   = (req.body.veh_vin   || '').trim() || null;
  var vehPlate = (req.body.veh_plate || '').trim() || null;
  if (vehMake || vehModel || vehVin || vehPlate) {
    db.prepare(
      'INSERT INTO customer_vehicles (customer_id, year, make, model, vin, license_plate) VALUES (?,?,?,?,?,?)'
    ).run(newId, vehYear, vehMake, vehModel || null, vehVin || null, vehPlate || null);
  }

  res.redirect('/admin/customer/' + newId + '?msg=created');
});

// ─── Square customer import ───────────────────────────────────────────────────
// Client-driven, one page (100 customers) per request. The browser calls the
// /chunk endpoint repeatedly, passing the Square pagination cursor, and updates
// the on-screen counts after each page. Each request is short so it can never hit
// Hostinger's proxy timeout (the cause of the earlier 503), and progress is fully
// visible. The server keeps no hidden state; dedup makes re-runs safe.

// Upserts one Square customer into the CRM (dedup by email then phone). Shared
// with the background auto-sync cron via square-sync.js.
var processSquareCustomer = require('../square-sync').processSquareCustomer;

// Imports a single page of Square customers and returns the next cursor. Uses the
// search endpoint (JSON body) rather than list (query params): list serializes
// empty sort enum strings that Square rejects, and search is already proven in
// square.js. An empty query returns all customers in the account.
router.post('/customers/import-square/chunk', requireAuth, express.json(), async function(req, res) {
  var cursor = (req.body && req.body.cursor) ? String(req.body.cursor) : null;
  var imported = 0, linked = 0, skipped = 0, errors = 0;

  try {
    var reqBody = { limit: BigInt(100) };
    if (cursor) reqBody.cursor = cursor;

    var resp = await squareClient.customers.search(reqBody);
    var list = (resp && resp.customers) || [];

    for (var i = 0; i < list.length; i++) {
      try {
        var r = processSquareCustomer(list[i]);
        if (r === 'imported') imported++;
        else if (r === 'linked') linked++;
        else skipped++;
      } catch (rowErr) {
        console.error('Square import row error:', rowErr.message);
        errors++;
      }
    }

    res.json({ ok: true, imported: imported, linked: linked, skipped: skipped, errors: errors, processed: list.length, cursor: (resp && resp.cursor) || null });
  } catch (apiErr) {
    console.error('Square import chunk error:', apiErr.message);
    res.json({ ok: false, error: apiErr.message });
  }
});

router.get('/customers/import-square', requireAuth, function(req, res) {
  var sqEnv = (!process.env.SQUARE_ACCESS_TOKEN || process.env.SQUARE_ENV === 'sandbox') ? 'sandbox' : 'production';

  var body = '<a href="/admin/customers" class="back-link"><span class="bk-arrow">&#8592;</span>Customers</a>'
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;margin-bottom:14px;">Import from Square</h1>'
    + '<div class="card">'
    + '<p style="color:#444;line-height:1.6;margin:0 0 12px;">This pulls every customer from your Square account and adds them to the BK CRM. Anyone already in the CRM (matched by email or phone) is linked to their Square record, never duplicated.</p>'
    + '<p style="color:#888;font-size:0.85rem;margin:0 0 18px;">Environment: <strong>' + esc(sqEnv) + '</strong>. The page imports in pages of 100 and updates live. Keep this page open until it finishes. Run it again any time: duplicates are always skipped.</p>'
    + '<button id="impStart" class="btn btn-navy" style="max-width:280px;">Run Import from Square</button>'
    + '<div id="impProgress" style="display:none;">'
    + '<div id="impStatusText" style="font-weight:700;color:#0a1f3d;font-size:1rem;margin-bottom:16px;">Starting…</div>'
    + '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;font-size:0.95rem;color:#444;">'
    + '<div>New customers imported: <strong id="impImported" style="color:#1a7a3a;">0</strong></div>'
    + '<div>Existing linked to Square: <strong id="impLinked">0</strong></div>'
    + '<div>Blank records skipped: <strong id="impSkipped" style="color:#aaa;">0</strong></div>'
    + '<div>Errors: <strong id="impErrors" style="color:#c0392b;">0</strong></div>'
    + '</div>'
    + '<div id="impError" style="display:none;background:#fdecea;border:1px solid #f5c2c0;color:#c0392b;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:0.88rem;"></div>'
    + '<div id="impDone" style="display:none;gap:8px;flex-wrap:wrap;">'
    + '<a href="/admin/customers" class="btn btn-navy" style="width:auto;">View Customers</a>'
    + '<a href="/admin/customers/import-square" class="btn btn-outline" style="width:auto;">Run Again</a>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '<script>(function(){'
    + 'var t={imported:0,linked:0,skipped:0,errors:0,processed:0,total:null};'
    + 'function g(id){return document.getElementById(id);}'
    + 'function render(msg){g("impImported").textContent=t.imported;g("impLinked").textContent=t.linked;g("impSkipped").textContent=t.skipped;g("impErrors").textContent=t.errors;'
    + 'g("impStatusText").textContent=msg+(t.total!=null?" ("+t.processed+" of "+t.total+" read)":" ("+t.processed+" read)");}'
    + 'function chunk(cursor){'
    + 'fetch("/admin/customers/import-square/chunk",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({cursor:cursor})})'
    + '.then(function(r){return r.json();}).then(function(s){'
    + 'if(!s.ok){render("Stopped");var e=g("impError");e.style.display="block";e.textContent="Square error: "+(s.error||"unknown");return;}'
    + 't.imported+=s.imported;t.linked+=s.linked;t.skipped+=s.skipped;t.errors+=s.errors;t.processed+=s.processed;if(s.total!=null)t.total=s.total;'
    + 'if(s.cursor){render("Importing…");chunk(s.cursor);}else{render("Import complete");g("impDone").style.display="flex";}'
    + '}).catch(function(){render("Connection hiccup, retrying…");setTimeout(function(){chunk(cursor);},2500);});'
    + '}'
    + 'g("impStart").addEventListener("click",function(){g("impStart").style.display="none";g("impProgress").style.display="block";render("Importing…");chunk(null);});'
    + '})();</script>';

  res.send(page('Import from Square', body, req));
});

// Shared builder for the editable customer-profile cards (Tags, Contact Info,
// Internal Notes, Vehicles, Saved Addresses, Job History, Follow-ups, Lifetime
// Stats). Rendered both on the customer profile page and embedded on the lead
// page so the two surfaces show identical, fully editable customer data. The
// forms post to the same /admin/customer/:id/* endpoints; `opts.back` controls
// where they redirect afterward (defaults to the profile page).
function customerProfileSections(c, opts) {
  opts = opts || {};
  var back = opts.back || ('/admin/customer/' + c.id);
  var backInput = '<input type="hidden" name="back" value="' + esc(back) + '">';
  var s = customers.statsFor(c.id);

  var vehicles  = db.prepare('SELECT * FROM customer_vehicles WHERE customer_id = ? ORDER BY id DESC').all(c.id);
  var addresses = db.prepare('SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY id DESC').all(c.id);
  var jobs      = db.prepare('SELECT * FROM leads WHERE customer_id = ? ORDER BY id DESC').all(c.id);
  var fups      = db.prepare(
    'SELECT f.*, l.first_name, l.last_name, l.vehicle FROM followups f '
    + 'JOIN leads l ON l.id = f.lead_id WHERE l.customer_id = ? '
    + 'ORDER BY f.sent ASC, f.due_date ASC, f.id ASC'
  ).all(c.id);
  var recentLeadId = jobs.length ? jobs[0].id : null;

  // Contact info edit fields (inside unified save form)
  var contactCard = '<div class="card">'
    + '<div class="section-title" style="margin-bottom:12px;">Contact Info</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>First name</label><input type="text" name="first_name" value="' + esc(c.first_name || '') + '" required></div>'
    + '<div class="form-group"><label>Last name</label><input type="text" name="last_name" value="' + esc(c.last_name || '') + '"></div>'
    + '</div>'
    + '<div class="form-group"><label>Email</label><input type="email" name="email" value="' + esc(c.email || '') + '" placeholder="customer@email.com"></div>'
    + '<div class="form-group"><label>Phone</label><input type="tel" name="phone" value="' + esc(c.phone || '') + '" placeholder="703-555-0123" oninput="fmtPhoneInput(this)" maxlength="12"></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Address <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="text" name="home_address" value="' + esc(c.home_address || '') + '" placeholder="123 Main St, Burke, VA 22015" autocomplete="off"></div>'
    + '</div>';

  // Tags card (collapsible) — removable pills + free-text add + preset quick picks
  var currentTagsList = (c.tags || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  var tagsCard = collapseOpen('cust_tags', 'Tags', false)
    + (currentTagsList.length
        ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;">'
          + currentTagsList.map(function(t) {
              return '<span style="display:inline-flex;align-items:center;gap:5px;background:#eef3ff;border:1.5px solid #4169e1;border-radius:8px;padding:5px 11px;">'
                + '<span style="font-size:0.85rem;color:#1a4fc4;font-weight:600;">' + esc(t) + '</span>'
                + '<form method="POST" action="/admin/customer/' + c.id + '/tag/remove" style="margin:0;line-height:0;">'
                + '<input type="hidden" name="tag" value="' + esc(t) + '">' + backInput
                + '<button type="submit" title="Remove tag" style="background:none;border:none;color:#7a9cd8;font-size:1rem;cursor:pointer;line-height:1;padding:0 0 0 2px;">&#10005;</button>'
                + '</form></span>';
            }).join('')
          + '</div>'
        : '<div style="color:#aaa;font-size:0.85rem;margin-bottom:14px;">No tags yet.</div>')
    + '<form method="POST" action="/admin/customer/' + c.id + '/tag/add" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px;">'
    + backInput
    + '<div class="form-group" style="flex:1;min-width:150px;margin-bottom:0;"><label>Add tag</label><input type="text" name="tag" placeholder="Fleet, HOA, Referral..." maxlength="40"></div>'
    + '<button type="submit" class="btn btn-outline" style="width:auto;">+ Add</button>'
    + '</form>'
    + (function() {
        var quick = CUSTOMER_TAGS.filter(function(t) { return currentTagsList.indexOf(t) === -1; });
        if (!quick.length) return '';
        return '<div style="font-size:0.78rem;color:#888;">Quick add: '
          + quick.map(function(t) {
              return '<form method="POST" action="/admin/customer/' + c.id + '/tag/add" style="display:inline-block;margin:0 4px 4px 0;">'
                + '<input type="hidden" name="tag" value="' + esc(t) + '">' + backInput
                + '<button type="submit" style="background:#f4f7fb;border:1px solid #dde3ea;border-radius:6px;padding:3px 9px;font-size:0.78rem;color:#555;font-weight:500;cursor:pointer;">' + esc(t) + '</button>'
                + '</form>';
            }).join('')
          + '</div>';
      })()
    + COLLAPSE_CLOSE;

  // Internal notes — inside the unified save form so saving notes doesn't wipe unsaved
  // contact/vehicle/address fields the owner was filling in at the same time.
  var notesCard = collapseOpen('cust_notes', 'Internal Notes', true)
    + '<div style="font-size:0.78rem;color:#aaa;margin-bottom:10px;">Visible to the tech before arrival, never sent. Saved with the button below.</div>'
    + '<div class="form-group" style="margin-bottom:0;"><textarea name="notes" placeholder="Gate code, dog in yard, preferred contact times, anything the tech should know...">' + esc(c.notes || '') + '</textarea></div>'
    + COLLAPSE_CLOSE;

  // Vehicles (no inner form — inside unified save form; delete uses formaction)
  var vehList = vehicles.length
    ? vehicles.map(function(v) {
        var title = [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Vehicle';
        return '<div style="border:1px solid #e3e9f1;border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">'
          + '<div><div style="font-weight:600;color:#0a1f3d;font-size:0.9rem;">' + esc(title) + '</div>'
          + (v.vin ? '<div style="font-size:0.78rem;color:#888;margin-top:2px;">VIN ' + esc(v.vin) + '</div>' : '')
          + (v.license_plate ? '<div style="font-size:0.78rem;color:#888;margin-top:1px;">Plate ' + esc(v.license_plate) + '</div>' : '') + '</div>'
          + '<button type="submit" formaction="/admin/customer/' + c.id + '/vehicle/' + v.id + '/delete" formmethod="post" onclick="return confirm(\'Remove this vehicle?\')" style="background:none;border:none;color:#c0392b;font-size:0.78rem;font-weight:600;cursor:pointer;padding:0;">Remove</button>'
          + '</div>';
      }).join('')
    : '<div style="color:#aaa;font-size:0.85rem;margin-bottom:10px;">No vehicles saved yet.</div>';
  var vehCard = collapseOpen('cust_vehicles', 'Vehicles', true)
    + vehList
    + '<div style="border-top:1px solid #eef0f4;padding-top:12px;margin-top:4px;">'
    + '<div style="font-size:0.82rem;font-weight:600;color:#475569;margin-bottom:8px;">Add a vehicle</div>'
    + vehicleCascadeHtml('custprof-veh')
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
    + '<div class="form-group" style="margin-bottom:8px;"><label>Trim</label><input type="text" name="veh_trim" placeholder="EX-L (optional)"></div>'
    + '<div class="form-group" style="margin-bottom:8px;"><label>VIN</label><input type="text" name="veh_vin" maxlength="17" placeholder="optional"></div>'
    + '</div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>License plate <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="text" name="veh_plate" maxlength="10" placeholder="optional"></div>'
    + '</div>'
    + COLLAPSE_CLOSE;

  // Saved addresses (no inner form — inside unified save form; delete uses formaction)
  var addrList = addresses.length
    ? addresses.map(function(a) {
        return '<div style="border:1px solid #e3e9f1;border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">'
          + '<div style="flex:1;min-width:0;">' + (a.label ? '<div style="font-weight:600;color:#0a1f3d;font-size:0.88rem;">' + esc(a.label) + '</div>' : '')
          + '<div style="font-size:0.85rem;color:#444;">' + esc(a.address) + '</div></div>'
          + '<div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">'
          + '<button type="button" onclick="profileUseAddr(' + JSON.stringify(a.address) + ')" style="background:none;border:1px solid #4169e1;border-radius:6px;color:#4169e1;font-size:0.75rem;font-weight:600;cursor:pointer;padding:3px 9px;">Use</button>'
          + '<button type="submit" formaction="/admin/customer/' + c.id + '/address/' + a.id + '/delete" formmethod="post" onclick="return confirm(\'Remove this address?\')" style="background:none;border:none;color:#c0392b;font-size:0.78rem;font-weight:600;cursor:pointer;padding:0;">Remove</button>'
          + '</div>'
          + '</div>';
      }).join('')
    : '<div style="color:#aaa;font-size:0.85rem;margin-bottom:10px;">No saved addresses yet.</div>';
  var addrCard = collapseOpen('cust_addresses', 'Saved Service Addresses', true)
    + addrList
    + '<div style="border-top:1px solid #eef0f4;padding-top:12px;margin-top:4px;">'
    + '<div style="font-size:0.82rem;font-weight:600;color:#475569;margin-bottom:8px;">Add an address</div>'
    + '<div class="form-group" style="margin-bottom:8px;">'
    + '<label>Label</label>'
    + '<select name="addr_label_preset" onchange="profileAddrChange(this)">'
    + '<option value="Home">Home</option>'
    + '<option value="Office">Office</option>'
    + '<option value="Other">Other</option>'
    + '</select>'
    + '</div>'
    + '<div class="form-group" id="addrOtherWrap" style="margin-bottom:8px;display:none;">'
    + '<label>Custom label</label>'
    + '<input type="text" name="addr_label_other" placeholder="Apartment, gym, etc...">'
    + '</div>'
    + '<div class="form-group" style="margin-bottom:0;">'
    + '<label>Address</label>'
    + '<input type="text" name="addr_address" placeholder="123 Main St, Sterling, VA">'
    + '</div>'
    + '</div>'
    + COLLAPSE_CLOSE;

  // Job history
  var jobsHtml = jobs.length
    ? jobs.map(function(l) {
        var rc = db.prepare('SELECT * FROM receipts WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(l.id);
        var qt = db.prepare('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(l.id);
        var totalVal = rc ? rc.total : (qt ? qt.total : null);
        var receiptSent = rc && rc.sent_at;
        var extra = (totalVal != null || receiptSent)
          ? '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:6px;">'
            + '<span style="font-size:0.74rem;color:#1a7a3a;font-weight:700;">' + (receiptSent ? '&#10003; Receipt sent ' + shortDate(rc.sent_at) : '') + '</span>'
            + '<span style="font-size:0.9rem;color:#0a1f3d;font-weight:700;">' + (totalVal != null ? '$' + money(totalVal) : '') + '</span>'
            + '</div>'
          : '';
        return leadCard(l, { management: false, extra: extra });
      }).join('')
    : '<div style="color:#aaa;font-size:0.85rem;">No jobs yet.</div>';
  var jobsCard = collapsible('cust_jobs', 'Job History <span style="font-size:0.8rem;color:#aaa;font-weight:400;">(' + jobs.length + ')</span>', jobsHtml, true);

  // Follow-ups (across all this customer's jobs) + ad-hoc add form
  var fupPending = fups.filter(function(f) { return !f.sent; });
  var fupSent = fups.filter(function(f) { return f.sent; }).slice(0, 8);
  var fupHtml = '';
  if (fupPending.length) fupHtml += fupPending.map(function(f) { return followupCard(f, back); }).join('');
  else fupHtml += '<div style="color:#aaa;font-size:0.85rem;margin-bottom:10px;">No upcoming follow-ups.</div>';
  if (fupSent.length) fupHtml += '<div class="section-title" style="margin:14px 0 10px;font-size:0.85rem;color:#888;">Recently sent</div>'
    + fupSent.map(function(f) { return followupCard(f, back); }).join('');
  var addFuForm = jobs.length
    ? '<form method="POST" action="/admin/followup/new" id="addfu" style="border-top:1px solid #eef0f4;padding-top:12px;margin-top:6px;">'
      + (jobs.length > 1
          ? '<div class="form-group" style="margin-bottom:8px;"><label>Attach to job</label><select name="lead_id">'
            + jobs.map(function(l) {
                return '<option value="' + l.id + '">' + esc(l.service || 'Job #' + l.id) + ' &mdash; ' + shortDate(l.created_at) + '</option>';
              }).join('')
            + '</select></div>'
          : '<input type="hidden" name="lead_id" value="' + recentLeadId + '">')
      + '<input type="hidden" name="back" value="' + esc(back) + '">'
      + '<div class="section-title" style="margin-bottom:10px;font-size:0.85rem;">Add a follow-up reminder</div>'
      + '<div class="form-group" style="margin-bottom:8px;"><label>Description</label><input type="text" name="description" placeholder="Check rear pads, recommend rotor service..."></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
      + '<div class="form-group" style="margin-bottom:10px;"><label>Due date</label><input type="date" name="due_date" value="' + esc(easternToday()) + '"></div>'
      + '<div class="form-group" style="margin-bottom:10px;"><label>Remind</label><select name="recipient"><option value="owner">Owner only</option><option value="customer">Customer only</option><option value="both">Owner + Customer</option></select></div>'
      + '</div>'
      + '<button type="submit" class="btn btn-outline" style="width:auto;">+ Add Follow-Up</button>'
      + '</form>'
    : '<div style="border-top:1px solid #eef0f4;padding-top:12px;margin-top:6px;color:#aaa;font-size:0.85rem;">No jobs on file yet — follow-ups must be attached to a job. Create a lead for this customer first.</div>';
  var fupCard = collapseOpen('cust_followups', 'Follow-ups', false) + fupHtml + addFuForm + COLLAPSE_CLOSE;

  // Lifetime stats
  var statsCard = collapseOpen('cust_stats', 'Lifetime Stats', false)
    + '<div class="stat-grid">'
    + statBlock('Total leads', s.leadCount)
    + statBlock('Quotes sent', s.quotesSent)
    + statBlock('Jobs completed', s.completedCount)
    + statBlock('Conversion rate', s.conversionRate + '%')
    + statBlock('Total revenue', '$' + money(s.revenue))
    + statBlock('Avg job value', '$' + money(s.avgJobValue))
    + '</div>'
    + '<div style="font-size:0.78rem;color:#aaa;margin-top:10px;line-height:1.5;">First lead ' + shortDate(s.firstLeadDate)
    + ' &middot; First paid job ' + shortDate(s.firstPaidDate) + '. A &ldquo;job&rdquo; is a completed service (receipt sent). Conversion rate is jobs completed out of quotes sent.</div>'
    + COLLAPSE_CLOSE;

  var script = '<style>'
    + '@keyframes bkSavePop{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}'
    + '</style>'
    + '<script>'
    + 'function profileAddrChange(sel){'
    +   'var w=document.getElementById("addrOtherWrap");'
    +   'if(w)w.style.display=sel.value==="Other"?"":"none";'
    + '}'
    + 'function profileUseAddr(addr){'
    +   'var el=document.querySelector("[name=\'home_address\']");'
    +   'if(!el)return;'
    +   'el.value=addr;'
    +   'el.scrollIntoView({behavior:"smooth",block:"center"});'
    +   'el.focus();'
    +   'el.style.outline="2px solid #4169e1";'
    +   'setTimeout(function(){el.style.outline="";},1800);'
    + '}'
    + '(function(){'
    +   'var form=document.getElementById("profileSaveForm");'
    +   'var bar=document.getElementById("profileSaveBar");'
    +   'if(!form||!bar)return;'
    +   'function showSave(){'
    +     'if(bar.style.display==="none"||bar.style.display===""){'
    +       'bar.style.display="block";'
    +       'bar.style.animation="none";'
    +       'bar.offsetHeight;'
    +       'bar.style.animation="bkSavePop .18s ease";'
    +     '}'
    +   '}'
    +   'form.addEventListener("input",showSave);'
    +   'form.addEventListener("change",showSave);'
    + '})();'
    + '</script>';

  var saveBar = '<div id="profileSaveBar" style="display:none;position:fixed;top:66px;right:16px;z-index:150;">'
    + '<button type="submit" form="profileSaveForm"'
    + ' style="background:#0d1b2a;color:#fff;border:none;border-radius:10px;padding:8px 16px;font-size:0.85rem;font-weight:600;cursor:pointer;box-shadow:0 3px 14px rgba(13,27,42,.3);display:flex;align-items:center;gap:6px;white-space:nowrap;">'
    + '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>'
    + 'Save</button>'
    + '</div>';

  var form = '<form method="POST" action="/admin/customer/' + c.id + '/save" id="profileSaveForm">'
    + backInput + contactCard + notesCard + vehCard + addrCard
    + '</form>';

  return {
    s: s, recentLeadId: recentLeadId,
    tags: tagsCard, form: form, saveBar: saveBar,
    jobs: jobsCard, fups: fupCard, stats: statsCard, script: script
  };
}

// Customer profile.
router.get('/customer/:id', requireAuth, function(req, res) {
  var c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');
  var name = (c.first_name + ' ' + c.last_name).trim() || 'Unnamed customer';

  var sec = customerProfileSections(c, { back: '/admin/customer/' + c.id });
  var s = sec.s;
  var recentLeadId = sec.recentLeadId;

  var alert = '';
  if (req.query.msg === 'deleted')       alert = '<div class="alert alert-success">Customer deleted.</div>';
  if (req.query.msg === 'created')       alert = '<div class="alert alert-success">Customer created successfully.</div>';
  if (req.query.msg === 'saved')        alert = '<div class="alert alert-success">Saved.</div>';
  if (req.query.msg === 'veh_added')    alert = '<div class="alert alert-success">Vehicle added.</div>';
  if (req.query.msg === 'veh_removed')  alert = '<div class="alert alert-success">Vehicle removed.</div>';
  if (req.query.msg === 'addr_added')   alert = '<div class="alert alert-success">Address saved.</div>';
  if (req.query.msg === 'addr_removed') alert = '<div class="alert alert-success">Address removed.</div>';
  if (req.query.msg === 'added')        alert = '<div class="alert alert-success">Follow-up added.</div>';
  if (req.query.msg === 'contact_saved') alert = '<div class="alert alert-success">Contact info updated.</div>';

  // Header — always visible: name, contact display, action buttons
  var header = '<div class="card">'
    + '<div class="lead-name" style="font-size:1.15rem;margin-bottom:8px;">' + esc(name) + '</div>'
    + '<div class="info-grid">'
    + contactInfoRows(c,
        '<span class="info-key">Customer since</span><span class="info-val">' + shortDate(s.firstLeadDate) + '</span>'
        + '<span class="info-key">First paid job</span><span class="info-val">' + shortDate(s.firstPaidDate) + '</span>'
        + (c.square_customer_id ? '<span class="info-key">Square</span><span class="info-val" style="font-size:0.8rem;color:#888;">' + esc(c.square_customer_id) + '</span>' : ''))
    + '</div>'
    + customerTagBadges(c.tags)
    + contactActions(c)
    + '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">'
    + '<a href="/admin/quick" class="btn btn-navy btn-sm" style="width:auto;">+ New Quote</a>'
    + '<a href="/admin/appointments/new?customer_id=' + c.id + '" class="btn btn-navy btn-sm" style="width:auto;">' + ic('calendar') + 'Schedule Appointment</a>'
    + (recentLeadId ? '<button type="button" onclick="openSection(\'cust_followups\')" class="btn btn-outline btn-sm" style="width:auto;">+ Add Follow-Up</button>' : '')
    + '</div>'
    + '</div>';

  var body = '<a href="/admin/customers" class="back-link"><span class="bk-arrow">&#8592;</span>All Customers</a>'
    + alert
    + header
    + sec.tags
    + sec.form
    + sec.saveBar
    + sec.jobs
    + sec.fups
    + sec.stats
    + sec.script
    + VEHICLE_CASCADE_JS;

  res.send(page(name, body, req));
});

// Redirect a customer-edit POST back to wherever the form was submitted from. When
// the editable profile cards are embedded on a lead page they pass `back` so the
// owner stays on the lead; otherwise we fall back to the customer profile. Only
// internal /admin paths are honored (guards against open-redirect).
function custEditRedirect(req, res, cid, msg) {
  var back = (req.body.back || '').trim();
  if (back && back.indexOf('/admin/') === 0 && back.indexOf('//') !== 0 && back.indexOf('\\') === -1) {
    return res.redirect(back + (back.indexOf('?') >= 0 ? '&' : '?') + 'msg=' + msg);
  }
  return res.redirect('/admin/customer/' + cid + '?msg=' + msg);
}

router.post('/customer/:id/edit', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var c = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');
  var firstName   = (req.body.first_name   || '').trim();
  var lastName    = (req.body.last_name    || '').trim();
  var email       = (req.body.email        || '').trim() || null;
  var phone       = (req.body.phone        || '').trim() || null;
  var homeAddress = (req.body.home_address || '').trim() || null;
  db.prepare('UPDATE customers SET first_name = ?, last_name = ?, email = ?, phone = ?, home_address = ? WHERE id = ?')
    .run(firstName, lastName, email, phone, homeAddress, c.id);
  res.redirect('/admin/customer/' + c.id + '?msg=contact_saved');
});

// Unified profile save — contact info + optional new vehicle + optional new address
router.post('/customer/:id/save', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var c = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');

  var firstName   = (req.body.first_name   || '').trim();
  var lastName    = (req.body.last_name    || '').trim();
  var email       = (req.body.email        || '').trim() || null;
  var phone       = (req.body.phone        || '').trim() || null;
  var homeAddress = (req.body.home_address || '').trim() || null;
  var notes       = (req.body.notes        || '').trim() || null;
  db.prepare('UPDATE customers SET first_name = ?, last_name = ?, email = ?, phone = ?, home_address = ?, notes = ? WHERE id = ?')
    .run(firstName, lastName, email, phone, homeAddress, notes, c.id);

  // Auto-upsert home address into saved addresses so it appears in the service
  // address list and auto-fills appointment forms without a separate step.
  if (homeAddress) {
    var existingHome = db.prepare("SELECT id FROM customer_addresses WHERE customer_id = ? AND LOWER(COALESCE(label,'')) = 'home'").get(c.id);
    if (!existingHome) {
      db.prepare('INSERT INTO customer_addresses (customer_id, label, address) VALUES (?,?,?)').run(c.id, 'Home', homeAddress);
    } else {
      db.prepare('UPDATE customer_addresses SET address = ? WHERE id = ?').run(homeAddress, existingHome.id);
    }
  }

  var vYear  = (req.body.veh_year  || '').trim() || null;
  var vMake  = (req.body.veh_make  || '').trim() || null;
  var vModel = (req.body.veh_model || '').trim() || null;
  var vTrim  = (req.body.veh_trim  || '').trim() || null;
  var vVin   = (req.body.veh_vin   || '').trim() || null;
  var vPlate = (req.body.veh_plate || '').trim() || null;
  if (vMake || vModel || vVin || vPlate) {
    db.prepare('INSERT INTO customer_vehicles (customer_id, year, make, model, trim, vin, license_plate) VALUES (?,?,?,?,?,?,?)')
      .run(c.id, vYear, vMake, vModel, vTrim, vVin, vPlate);
  }

  var addrAddress = (req.body.addr_address || '').trim();
  if (addrAddress) {
    var labelPreset = (req.body.addr_label_preset || 'Home').trim();
    var labelOther  = (req.body.addr_label_other  || '').trim();
    var addrLabel   = labelPreset === 'Other' ? (labelOther || 'Other') : labelPreset;
    var dupAddr = db.prepare('SELECT id FROM customer_addresses WHERE customer_id = ? AND address = ?').get(c.id, addrAddress);
    if (!dupAddr) {
      db.prepare('INSERT INTO customer_addresses (customer_id, label, address) VALUES (?,?,?)')
        .run(c.id, addrLabel, addrAddress);
    }
  }

  custEditRedirect(req, res, c.id, 'saved');
});

router.post('/customer/:id/notes', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var c = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');
  db.prepare('UPDATE customers SET notes = ? WHERE id = ?').run((req.body.notes || '').trim() || null, c.id);
  res.redirect('/admin/customer/' + c.id + '?msg=saved');
});

router.post('/customer/:id/tags', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var c = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');
  var picked = req.body.tags;
  if (!picked) picked = [];
  else if (!Array.isArray(picked)) picked = [picked];
  var clean = CUSTOMER_TAGS.filter(function(t) { return picked.indexOf(t) !== -1; });
  db.prepare('UPDATE customers SET tags = ? WHERE id = ?').run(clean.join(', ') || null, c.id);
  res.redirect('/admin/customer/' + c.id + '?msg=saved');
});

router.post('/customer/:id/tag/add', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');
  var newTag = (req.body.tag || '').trim();
  if (newTag) {
    var current = (c.tags || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    if (current.indexOf(newTag) === -1) {
      current.push(newTag);
      db.prepare('UPDATE customers SET tags = ? WHERE id = ?').run(current.join(', '), c.id);
    }
  }
  custEditRedirect(req, res, c.id, 'saved');
});

router.post('/customer/:id/tag/remove', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');
  var removeTag = (req.body.tag || '').trim();
  var current = (c.tags || '').split(',').map(function(t) { return t.trim(); }).filter(Boolean);
  var updated = current.filter(function(t) { return t !== removeTag; });
  db.prepare('UPDATE customers SET tags = ? WHERE id = ?').run(updated.join(', ') || null, c.id);
  custEditRedirect(req, res, c.id, 'saved');
});

router.post('/customer/:id/vehicle/add', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var c = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');
  var year  = (req.body.year || '').trim() || null;
  var make  = (req.body.make || '').trim() || null;
  var model = (req.body.model || '').trim() || null;
  var trim  = (req.body.trim || '').trim() || null;
  var vin   = (req.body.vin || '').trim() || null;
  if (year || make || model || trim || vin) {
    db.prepare('INSERT INTO customer_vehicles (customer_id, year, make, model, trim, vin) VALUES (?,?,?,?,?,?)')
      .run(c.id, year, make, model, trim, vin);
  }
  res.redirect('/admin/customer/' + c.id + '?msg=veh_added#vehicles');
});

router.post('/customer/:id/vehicle/:vid/delete', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  db.prepare('DELETE FROM customer_vehicles WHERE id = ? AND customer_id = ?').run(req.params.vid, req.params.id);
  custEditRedirect(req, res, req.params.id, 'veh_removed');
});

// Auto-fill source for scheduling forms: returns the customer's most recent saved
// vehicle and saved address so the appointment form can populate them on select.
// Falls back to parsing the latest lead's free-text vehicle string when no
// structured customer_vehicles row exists.
router.get('/customer/:id/autofill', requireAuth, function(req, res) {
  var c = db.prepare('SELECT id, email, home_address, notes FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.json({ ok: false });
  var veh = db.prepare('SELECT year, make, model, vin, license_plate FROM customer_vehicles WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
  if (!veh) {
    var lastLead = db.prepare("SELECT vehicle FROM leads WHERE customer_id = ? AND vehicle IS NOT NULL AND vehicle != '' ORDER BY id DESC LIMIT 1").get(c.id);
    if (lastLead && lastLead.vehicle) {
      var parts = lastLead.vehicle.trim().split(/\s+/);
      var year = /^(19|20)\d{2}$/.test(parts[0]) ? parts.shift() : '';
      var make = parts.shift() || '';
      veh = { year: year, make: make, model: parts.join(' '), vin: '', license_plate: '' };
    }
  }
  var addr = db.prepare('SELECT address FROM customer_addresses WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
  res.json({
    ok: true,
    email: c.email || '',
    notes: c.notes || '',
    vehicle: veh ? { year: veh.year || '', make: veh.make || '', model: veh.model || '', vin: veh.vin || '', license_plate: veh.license_plate || '' } : null,
    address: addr ? addr.address : '',
    home_address: c.home_address || ''
  });
});

router.post('/customer/:id/address/add', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var c = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.redirect('/admin/customers');
  var address = (req.body.address || '').trim();
  var label   = (req.body.label || '').trim() || null;
  if (address) {
    db.prepare('INSERT INTO customer_addresses (customer_id, label, address) VALUES (?,?,?)').run(c.id, label, address);
  }
  res.redirect('/admin/customer/' + c.id + '?msg=addr_added');
});

router.post('/customer/:id/address/:aid/delete', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  db.prepare('DELETE FROM customer_addresses WHERE id = ? AND customer_id = ?').run(req.params.aid, req.params.id);
  custEditRedirect(req, res, req.params.id, 'addr_removed');
});

// Delete a customer and all their child records. Leads are unlinked (customer_id
// set to NULL) rather than deleted so job history is preserved on the Leads tab.
router.post('/customer/:id/delete', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var id = parseInt(req.params.id);
  if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(id)) return res.redirect('/admin/customers');
  db.prepare('UPDATE leads SET customer_id = NULL WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM customer_vehicles WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM customer_addresses WHERE customer_id = ?').run(id);
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  res.redirect('/admin/customers?msg=deleted');
});

// ─── Appointments ─────────────────────────────────────────────────────────────

// Owner/staff appointment time options: 8 AM to 7 PM, every 30 minutes.
// Wider than the customer-facing picker on purpose — the owner has full control.
function ownerTimeOptions(sel) {
  var o = '<option value="">-- Select time --</option>';
  for (var mins = 8 * 60; mins <= 19 * 60; mins += 30) {
    var h24 = Math.floor(mins / 60), m = mins % 60;
    var ampm = h24 < 12 ? 'AM' : 'PM';
    var h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    var label = h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
    o += '<option value="' + label + '"' + (sel === label ? ' selected' : '') + '>' + label + '</option>';
  }
  return o;
}

router.get('/appointments', requireAuth, function(req, res) {
  var today = easternToday();

  // The appointment cards fall back to the customer profile for the service address
  // and vehicle when the booked quote has none, so saving an address or vehicle on
  // the profile is reflected on the card the next time this page loads. cust_addr is
  // the most recent saved service address; cust_home_address backstops that.
  var apptCols = 'SELECT l.*, q.id AS q_id, q.service AS q_service, q.total, q.pref_date, q.pref_time, q.pref_location, '
    + 'cu.home_address AS cust_home_address, '
    + "(SELECT ca.address FROM customer_addresses ca WHERE ca.customer_id = l.customer_id ORDER BY ca.id DESC LIMIT 1) AS cust_addr, "
    + "(SELECT TRIM(COALESCE(cv.year,'') || ' ' || COALESCE(cv.make,'') || ' ' || COALESCE(cv.model,'')) FROM customer_vehicles cv WHERE cv.customer_id = l.customer_id ORDER BY cv.id DESC LIMIT 1) AS cust_vehicle "
    + 'FROM leads l '
    + 'JOIN quotes q ON q.lead_id = l.id AND q.status = \'approved\' AND q.pref_date IS NOT NULL '
    + 'LEFT JOIN customers cu ON cu.id = l.customer_id ';

  var upcoming = db.prepare(
    apptCols
    + 'WHERE l.status = \'booked\' AND l.archived = 0 AND q.pref_date >= ? '
    + 'ORDER BY q.pref_date ASC, q.pref_time ASC'
  ).all(today);

  var past = db.prepare(
    apptCols
    + 'WHERE l.status = \'booked\' AND l.archived = 0 AND q.pref_date < ? '
    + 'ORDER BY q.pref_date DESC, q.pref_time DESC LIMIT 30'
  ).all(today);

  // Owner personal time blocks (visual only — not customer facing).
  var events = db.prepare(
    'SELECT * FROM personal_events WHERE event_date >= ? ORDER BY event_date ASC, start_time ASC'
  ).all(today);

  // Build date → count map for the calendar dots (blue = jobs, amber = personal).
  var dateMap = {};
  upcoming.concat(past).forEach(function(a) {
    if (a.pref_date) dateMap[a.pref_date] = (dateMap[a.pref_date] || 0) + 1;
  });
  var peMap = {};
  events.forEach(function(ev) { peMap[ev.event_date] = (peMap[ev.event_date] || 0) + 1; });

  function apptCard(a) {
    var name = (a.first_name + ' ' + a.last_name).trim() || 'Unknown customer';
    var dateStr = fmtPrefDate(a.pref_date) + (a.pref_time ? ' at ' + a.pref_time : '');
    var tOpts = ownerTimeOptions(a.pref_time);
    // Address + vehicle fall back to the customer profile so profile edits show here.
    var loc = (a.pref_location || '').trim() || (a.cust_addr || '').trim() || (a.cust_home_address || '').trim();
    var veh = (a.vehicle || '').trim() || (a.cust_vehicle || '').trim();
    return '<div class="card appt-card" data-date="' + esc(a.pref_date || '') + '" onclick="if(!event.target.closest(\'a,button,select,form,input\')){window.location=\'/admin/quote/' + a.id + '\';}" style="cursor:pointer;border-left:4px solid ' + STATUS_COLOR.booked + ';margin-bottom:10px;">'
      + '<div class="row-sb">'
      + '<div class="lead-name">' + esc(name) + '</div>'
      + '<span style="font-size:0.82rem;color:#888;">' + esc(fmtPrefDate(a.pref_date)) + '</span>'
      + '</div>'
      + '<div style="font-size:0.9rem;color:#444;margin-top:5px;">' + esc(a.q_service || 'Service TBD') + '</div>'
      + (veh ? '<div style="font-size:0.82rem;color:#666;margin-top:2px;">' + esc(veh) + '</div>' : '')
      + '<div style="font-size:0.85rem;color:#1a6fc4;margin-top:3px;">' + esc(dateStr) + '</div>'
      + (loc ? '<div style="font-size:0.82rem;margin-top:2px;">' + mapsLink(loc, { style: 'color:#1a6fc4;font-size:0.82rem;text-decoration:none;' }) + '</div>' : '')
      + '<div style="font-size:0.85rem;color:#0a1f3d;font-weight:600;margin-top:4px;">$' + money(a.total) + '</div>'
      + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">'
      + '<a href="/admin/appointments/' + a.id + '/edit" class="btn btn-sm" style="width:auto;background:#eef6ee;color:#1a7a3a;border:1px solid #b6dcc0;text-decoration:none;" onclick="event.stopPropagation();">' + ic('edit') + 'Edit</a>'
      + '<button type="button" class="btn btn-sm" style="width:auto;background:#f0f4ff;color:#1a6fc4;border:1px solid #b0c4e0;" onclick="apptToggleReschedule(' + a.id + ');event.stopPropagation();">' + ic('calendar') + 'Reschedule</button>'
      + '<form method="POST" action="/admin/appointments/' + a.id + '/cancel" style="display:inline;margin:0;" onsubmit="return confirm(\'Cancel this appointment? The lead will return to the pipeline.\');">'
      + '<button type="submit" class="btn btn-sm" style="width:auto;background:#fff3f3;color:#c0392b;border:1px solid #f5c6c6;" onclick="event.stopPropagation();">Cancel Appt</button>'
      + '</form>'
      + '</div>'
      + '<div id="rescheduleForm_' + a.id + '" style="display:none;margin-top:12px;padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">'
      + '<form method="POST" action="/admin/appointments/' + a.id + '/reschedule">'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">'
      + '<div class="form-group" style="margin-bottom:0;flex:1;min-width:140px;">'
      + '<label style="font-size:0.82rem;">New Date</label>'
      + '<input type="date" name="pref_date" value="' + esc(a.pref_date || '') + '" required style="padding:8px 10px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.9rem;width:100%;box-sizing:border-box;">'
      + '</div>'
      + '<div class="form-group" style="margin-bottom:0;flex:1;min-width:140px;">'
      + '<label style="font-size:0.82rem;">New Time</label>'
      + '<select name="pref_time" required style="padding:8px 10px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.9rem;width:100%;box-sizing:border-box;">' + tOpts + '</select>'
      + '</div>'
      + '<div style="display:flex;gap:6px;">'
      + '<button type="submit" class="btn btn-navy btn-sm" style="width:auto;" onclick="event.stopPropagation();">Save</button>'
      + '<button type="button" class="btn btn-sm" style="width:auto;background:#f8fafc;color:#475569;border:1px solid #e2e8f0;" onclick="apptToggleReschedule(' + a.id + ');event.stopPropagation();">Cancel</button>'
      + '</div>'
      + '</div>'
      + '</form>'
      + '</div>'
      + '</div>';
  }

  // Personal time block card: amber accent, title + window, remove button.
  function eventCard(ev) {
    var timeStr = (ev.start_time || '') + (ev.end_time ? ' – ' + ev.end_time : '');
    return '<div class="card appt-card" data-date="' + esc(ev.event_date) + '" style="border-left:4px solid #f0b429;background:#fffdf5;margin-bottom:10px;">'
      + '<div class="row-sb">'
      + '<div class="lead-name">' + esc(ev.title) + '</div>'
      + '<span style="font-size:0.82rem;color:#888;">' + esc(fmtPrefDate(ev.event_date)) + '</span>'
      + '</div>'
      + '<div style="font-size:0.85rem;color:#a07800;font-weight:600;margin-top:4px;">Blocked time' + (timeStr ? ' · ' + esc(timeStr) : '') + '</div>'
      + (ev.note ? '<div style="font-size:0.85rem;color:#666;margin-top:4px;">' + esc(ev.note) + '</div>' : '')
      + '<div style="margin-top:10px;">'
      + '<form method="POST" action="/admin/appointments/block/' + ev.id + '/delete" style="display:inline;margin:0;" onsubmit="return confirm(\'Remove this time block?\');">'
      + '<button type="submit" class="btn btn-sm" style="width:auto;background:#fff3f3;color:#c0392b;border:1px solid #f5c6c6;">Remove</button>'
      + '</form>'
      + '</div>'
      + '</div>';
  }

  // Interleave jobs and personal blocks by date + time so the day list reads
  // top to bottom like a schedule.
  function sortMins(t) {
    var m = /(\d+):(\d+)\s*(AM|PM)/i.exec(t || '');
    if (!m) return 9999;
    var h = (+m[1] % 12) + (m[3].toUpperCase() === 'PM' ? 12 : 0);
    return h * 60 + (+m[2]);
  }
  var upcomingItems = upcoming.map(function(a) {
    return { date: a.pref_date, mins: sortMins(a.pref_time), html: apptCard(a) };
  }).concat(events.map(function(ev) {
    return { date: ev.event_date, mins: sortMins(ev.start_time), html: eventCard(ev) };
  }));
  upcomingItems.sort(function(x, y) {
    return x.date < y.date ? -1 : x.date > y.date ? 1 : x.mins - y.mins;
  });

  var allCards = upcomingItems.map(function(i) { return i.html; }).join('') + (past.length
    ? '<div id="pastHeader" class="section-title" style="margin:20px 0 10px;">Recent Past</div>' + past.map(apptCard).join('')
    : '');

  var emptyAll = '<div id="apptEmpty" style="display:none;text-align:center;padding:32px;color:#888;">No appointments on this date.</div>';

  var noUpcoming = (upcoming.length === 0 && events.length === 0)
    ? '<div class="card" style="text-align:center;padding:32px;color:#888;" id="apptNoUpcoming">No upcoming appointments. Create one with the button above.</div>'
    : '';

  var calScript = '<script>(function(){'
    + 'var DATE_MAP=' + JSON.stringify(dateMap) + ';'
    + 'var PE_MAP=' + JSON.stringify(peMap) + ';'
    + 'var TODAY="' + today + '";'
    + 'var MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];'
    + 'var DAYS=["Su","Mo","Tu","We","Th","Fr","Sa"];'
    + 'var curYear,curMonth,selDate=null;'
    // Start on the month of the first upcoming appointment, or today
    + (upcoming.length ? 'var firstDate="' + upcoming[0].pref_date + '";curYear=parseInt(firstDate.slice(0,4));curMonth=parseInt(firstDate.slice(5,7))-1;'
                       : 'var td=new Date();curYear=td.getFullYear();curMonth=td.getMonth();')
    + 'function render(){'
    +   'var cal=document.getElementById("apptCalGrid");'
    +   'if(!cal)return;'
    +   'var firstDay=new Date(curYear,curMonth,1).getDay();'
    +   'var daysInMonth=new Date(curYear,curMonth+1,0).getDate();'
    +   'document.getElementById("apptCalTitle").textContent=MONTHS[curMonth]+" "+curYear;'
    +   'var h=\'<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:4px;">\';'
    +   'DAYS.forEach(function(d){h+=\'<div style="text-align:center;font-size:0.7rem;font-weight:600;color:#94a3b8;padding:4px 0;">\'+d+\'</div>\';});'
    +   'h+=\'</div><div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;">\';'
    +   'for(var i=0;i<firstDay;i++)h+=\'<div></div>\';'
    +   'for(var d=1;d<=daysInMonth;d++){'
    +     'var mm=String(curMonth+1).padStart(2,"0");'
    +     'var dd=String(d).padStart(2,"0");'
    +     'var dateStr=curYear+"-"+mm+"-"+dd;'
    +     'var isToday=dateStr===TODAY;'
    +     'var isSel=dateStr===selDate;'
    +     'var hasAppt=!!DATE_MAP[dateStr];'
    +     'var hasPE=!!PE_MAP[dateStr];'
    +     'var bg=isSel?"#0d1b2a":isToday?"#4169e1":"transparent";'
    +     'var fg=isSel||isToday?"#fff":"#0f172a";'
    +     'h+=\'<div onclick="apptDayClick(\\\'\'+dateStr+\'\\\')" style="text-align:center;padding:6px 2px;border-radius:8px;cursor:pointer;min-height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:\'+bg+\';-webkit-tap-highlight-color:transparent;">\';'
    +     'h+=\'<span style="font-size:0.88rem;font-weight:\'+(isToday||isSel?"700":"400")+\';color:\'+fg+\'">\'+d+\'</span>\';'
    +     'if(hasAppt||hasPE){'
    +       'h+=\'<span style="display:flex;gap:2px;margin-top:2px;">\';'
    +       'if(hasAppt)h+=\'<span style="display:block;width:5px;height:5px;border-radius:50%;background:\'+(isSel||isToday?"#fff":"#4169e1")+\';"></span>\';'
    +       'if(hasPE)h+=\'<span style="display:block;width:5px;height:5px;border-radius:50%;background:\'+(isSel||isToday?"#ffe08a":"#f0b429")+\';"></span>\';'
    +       'h+=\'</span>\';'
    +     '}'
    +     'h+=\'</div>\';'
    +   '}'
    +   'h+=\'</div>\';'
    +   'cal.innerHTML=h;'
    + '}'
    + 'window.apptDayClick=function(date){'
    +   'if(selDate===date){selDate=null;}else{selDate=date;}'
    +   'render();'
    +   'var cards=document.querySelectorAll(".appt-card");'
    +   'var shown=0;'
    +   'cards.forEach(function(c){var show=!selDate||c.dataset.date===selDate;c.style.display=show?"":"none";if(show)shown++;});'
    +   'var empty=document.getElementById("apptEmpty");'
    +   'var noUp=document.getElementById("apptNoUpcoming");'
    +   'var pastHdr=document.getElementById("pastHeader");'
    +   'if(empty)empty.style.display=(selDate&&shown===0)?"block":"none";'
    +   'if(noUp)noUp.style.display=selDate?"none":"";'
    +   'if(pastHdr)pastHdr.style.display=selDate?"none":"";'
    +   'var lbl=document.getElementById("apptFilterLabel");'
    +   'if(lbl)lbl.textContent=selDate?("Showing "+selDate):"All appointments";'
    +   'if(selDate){var el=document.getElementById("apptList");if(el)el.scrollIntoView({behavior:"smooth",block:"start"});}'
    + '};'
    + 'document.getElementById("apptPrev").onclick=function(){curMonth--;if(curMonth<0){curMonth=11;curYear--;}render();};'
    + 'document.getElementById("apptNext").onclick=function(){curMonth++;if(curMonth>11){curMonth=0;curYear++;}render();};'
    + 'window.apptToggleReschedule=function(id){'
    +   'var f=document.getElementById("rescheduleForm_"+id);'
    +   'if(f)f.style.display=f.style.display==="none"?"block":"none";'
    + '};'
    + 'render();'
    + '})();</script>';

  var calHtml = '<div class="card" style="margin-bottom:16px;padding:16px;">'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">'
    + '<button id="apptPrev" type="button" style="background:none;border:1px solid #e2e8f0;border-radius:8px;width:36px;height:36px;font-size:1.1rem;cursor:pointer;color:#475569;display:flex;align-items:center;justify-content:center;">&#8249;</button>'
    + '<span id="apptCalTitle" style="font-weight:700;font-size:1rem;color:#0f172a;"></span>'
    + '<button id="apptNext" type="button" style="background:none;border:1px solid #e2e8f0;border-radius:8px;width:36px;height:36px;font-size:1.1rem;cursor:pointer;color:#475569;display:flex;align-items:center;justify-content:center;">&#8250;</button>'
    + '</div>'
    + '<div id="apptCalGrid"></div>'
    + '</div>';

  var apptMsg = '';
  if (req.query.msg === 'rescheduled') apptMsg = '<div class="alert alert-success" style="margin-bottom:14px;">Appointment rescheduled.</div>';
  if (req.query.msg === 'appt_updated') apptMsg = '<div class="alert alert-success" style="margin-bottom:14px;">Appointment updated. The customer was not emailed.</div>';
  if (req.query.msg === 'appt_updated_email') apptMsg = '<div class="alert alert-success" style="margin-bottom:14px;">Appointment updated and an updated confirmation was emailed to the customer.</div>';
  if (req.query.msg === 'cancelled') apptMsg = '<div class="alert" style="margin-bottom:14px;background:#fff8e1;border:1px solid #f0b429;color:#6b4c00;padding:10px 14px;border-radius:8px;">Appointment cancelled. Lead returned to pipeline.</div>';
  if (req.query.msg === 'blocked') apptMsg = '<div class="alert alert-success" style="margin-bottom:14px;">Time blocked off.</div>';
  if (req.query.msg === 'blockremoved') apptMsg = '<div class="alert alert-success" style="margin-bottom:14px;">Time block removed.</div>';

  var inputStyle = 'width:100%;padding:10px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.95rem;background:#fff;box-sizing:border-box;';
  var blockFormHtml = '<div id="blockForm" class="card" style="display:none;margin-bottom:16px;border-left:4px solid #f0b429;">'
    + '<div class="section-title" style="margin-bottom:10px;">Block Off Time</div>'
    + '<form method="POST" action="/admin/appointments/block">'
    + '<div class="form-group"><label>Title <span style="color:#c0392b;">*</span></label>'
    + '<input type="text" name="title" required placeholder="e.g. Personal, Dentist, Lunch" style="' + inputStyle + '"></div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Date <span style="color:#c0392b;">*</span></label>'
    + '<input type="date" name="event_date" required style="' + inputStyle + '"></div>'
    + '<div class="form-group"><label>Start</label>'
    + '<select name="start_time" style="' + inputStyle + '">' + ownerTimeOptions('') + '</select></div>'
    + '<div class="form-group"><label>End</label>'
    + '<select name="end_time" style="' + inputStyle + '">' + ownerTimeOptions('') + '</select></div>'
    + '</div>'
    + '<div class="form-group"><label>Note <span style="color:#bbb;font-weight:400;">(optional)</span></label>'
    + '<input type="text" name="note" style="' + inputStyle + '"></div>'
    + '<button type="submit" class="btn btn-navy btn-sm" style="width:auto;">Save Time Block</button>'
    + '</form></div>';

  var body = '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:14px;">'
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;">Appointments</h1>'
    + '<div style="display:flex;gap:8px;">'
    + '<button type="button" class="btn btn-sm" style="width:auto;background:#fff8e1;color:#a07800;border:1px solid #f0b429;" onclick="var f=document.getElementById(\'blockForm\');f.style.display=f.style.display===\'none\'?\'block\':\'none\';">+ Block Time</button>'
    + '<a href="/admin/appointments/new" class="btn btn-navy btn-sm" style="width:auto;">' + ic('calendar') + '+ New Appointment</a>'
    + '</div>'
    + '</div>'
    + apptMsg
    + blockFormHtml
    + calHtml
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">'
    + '<div class="section-title" style="margin:0;" id="apptFilterLabel">All appointments</div>'
    + '</div>'
    + '<div id="apptList">'
    + noUpcoming
    + allCards
    + emptyAll
    + '</div>'
    + calScript;

  res.send(page('Appointments', body, req));
});

router.post('/appointments/:lead_id/reschedule', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(req.params.lead_id);
  if (!lead) return res.redirect('/admin/appointments');
  var prefDate = (req.body.pref_date || '').trim();
  var prefTime = (req.body.pref_time || '').trim();
  if (!prefDate || !prefTime) return res.redirect('/admin/appointments');
  db.prepare("UPDATE quotes SET pref_date = ?, pref_time = ? WHERE lead_id = ? AND status = 'approved'")
    .run(prefDate, prefTime, lead.id);
  logHistory(lead.id, 'Appointment rescheduled', prefDate + ' at ' + prefTime);
  res.redirect('/admin/appointments?msg=rescheduled');
});

router.post('/appointments/:lead_id/cancel', requireAuth, function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.lead_id);
  if (!lead) return res.redirect('/admin/appointments');
  db.prepare("UPDATE quotes SET pref_date = NULL, pref_time = NULL WHERE lead_id = ? AND status = 'approved'")
    .run(lead.id);
  db.prepare("UPDATE leads SET status = 'approved', status_updated_at = datetime('now') WHERE id = ?")
    .run(lead.id);
  logHistory(lead.id, 'Appointment cancelled', 'Lead returned to pipeline');
  sendStagePush(lead, 'approved');
  res.redirect('/admin/appointments?msg=cancelled');
});

// ─── Personal time blocks (owner calendar events, visual only) ────────────────

router.post('/appointments/block', requireAuth, express.urlencoded({ extended: false }), function(req, res) {
  var title = (req.body.title || '').trim();
  var date  = (req.body.event_date || '').trim();
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect('/admin/appointments');
  db.prepare('INSERT INTO personal_events (title, event_date, start_time, end_time, note) VALUES (?,?,?,?,?)')
    .run(title, date, (req.body.start_time || '').trim() || null, (req.body.end_time || '').trim() || null, (req.body.note || '').trim() || null);
  res.redirect('/admin/appointments?msg=blocked');
});

router.post('/appointments/block/:id/delete', requireAuth, function(req, res) {
  db.prepare('DELETE FROM personal_events WHERE id = ?').run(req.params.id);
  res.redirect('/admin/appointments?msg=blockremoved');
});

router.get('/appointments/new', requireAuth, function(req, res) {
  var apptPricing = getEffectivePricing();
  var serviceNames = Object.keys(apptPricing);
  var pricingJson = JSON.stringify(apptPricing);
  var taxRate = PRICING.taxRate;

  var allCustomers = db.prepare('SELECT id, first_name, last_name, phone, email FROM customers ORDER BY last_name, first_name').all();

  var fromLeadId = (req.query.from_lead || '').trim();
  var fromLead = fromLeadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(fromLeadId) : null;

  var preselectedCustomerId = (req.query.customer_id || fromLead && String(fromLead.customer_id) || '').trim();
  var preselectedCustomer = preselectedCustomerId
    ? allCustomers.find(function(c) { return String(c.id) === preselectedCustomerId; }) || null
    : null;
  var preselectedName = preselectedCustomer
    ? ((preselectedCustomer.first_name + ' ' + preselectedCustomer.last_name).trim() + (preselectedCustomer.phone ? ' (' + fmtPhone(preselectedCustomer.phone) + ')' : ''))
    : '';

  // Embed minimal customer data for client-side typeahead (id, display name, email, phone digits for search).
  var custJson = JSON.stringify(allCustomers.map(function(c) {
    var name = (c.first_name + ' ' + c.last_name).trim();
    return { id: c.id, label: name + (c.phone ? ' (' + fmtPhone(c.phone) + ')' : ''), email: c.email || '', search: (name + ' ' + (c.phone || '')).toLowerCase() };
  }));

  var fromLeadServices = fromLead && fromLead.service
    ? fromLead.service.split(',').map(function(s) { return s.trim(); })
    : [];
  var timeOpts = ownerTimeOptions('');

  var mapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
  var mapsScript = mapsKey
    ? '<script async defer src="https://maps.googleapis.com/maps/api/js?key=' + esc(mapsKey) + '&libraries=places&callback=apptInitMaps"></script>'
    : '';

  var alert = '';
  if (req.query.err === 'name') alert = '<div class="alert alert-error">Customer first and last name are required for new customers.</div>';

  var fromLeadBanner = fromLead
    ? '<div style="background:#e3f0ff;border:1.5px solid #4169e1;border-radius:10px;padding:12px 16px;margin-bottom:14px;font-size:0.9rem;color:#1a4a7a;">'
      + '<strong>Booking from existing lead:</strong> ' + esc(fromLead.first_name + ' ' + fromLead.last_name)
      + (fromLead.service ? ' &mdash; ' + esc(fromLead.service) : '')
      + '. This appointment will advance that lead to Booked (no duplicate created).'
      + '</div>'
    : '';

  var body = '<a href="/admin/appointments" class="back-link"><span class="bk-arrow">&#8592;</span>Appointments</a>'
    + alert
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;margin-bottom:14px;">New Appointment</h1>'
    + fromLeadBanner
    + '<form method="POST" action="/admin/appointments/new" data-autosave="apptnew-' + esc(fromLeadId || 'new') + '" data-autosave-after="bkApptAfter">'
    + (fromLeadId ? '<input type="hidden" name="from_lead" value="' + esc(fromLeadId) + '">' : '')

    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Customer</div>'
    + '<input type="hidden" name="customer_id" id="apptCustId" value="' + esc(preselectedCustomerId) + '">'
    + '<input type="hidden" id="apptCustEmail" value="' + esc((preselectedCustomer && preselectedCustomer.email) || '') + '">'
    + '<div class="form-group" style="margin-bottom:0;">'
    + '<label>Search existing customer</label>'
    + '<div style="position:relative;">'
    + '<input type="text" id="custPickerInput" autocomplete="off" placeholder="Type name or phone..." '
    + 'value="' + esc(preselectedName) + '" '
    + 'style="width:100%;padding:10px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.95rem;background:#fff;box-sizing:border-box;">'
    + '<div id="custPickerDrop" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1.5px solid #dde3ea;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.10);z-index:200;max-height:220px;overflow-y:auto;"></div>'
    + '</div>'
    + '<div id="custPickerChip" style="display:' + (preselectedName ? 'flex' : 'none') + ';align-items:center;gap:8px;margin-top:8px;padding:8px 12px;background:#e3f0ff;border-radius:8px;">'
    + '<span id="custPickerLabel" style="flex:1;font-size:0.9rem;color:#0a1f3d;font-weight:500;">' + esc(preselectedName) + '</span>'
    + '<button type="button" id="custPickerClearBtn" style="background:none;border:none;font-size:1.1rem;color:#888;cursor:pointer;padding:0 4px;line-height:1;">&#10005;</button>'
    + '</div>'
    + '</div>'
    + '<div id="apptNewCustFields" style="margin-top:14px;display:' + (preselectedCustomerId ? 'none' : 'block') + ';">'
    + '<div class="section-title" style="margin:0 0 10px;">Or create new customer</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>First name <span style="color:#c0392b;">*</span></label><input type="text" name="cust_first" id="apptCustFirst"></div>'
    + '<div class="form-group"><label>Last name <span style="color:#c0392b;">*</span></label><input type="text" name="cust_last" id="apptCustLast"></div>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Phone</label><input type="tel" name="cust_phone" placeholder="703-555-0123" oninput="fmtPhoneInput(this)" maxlength="12"></div>'
    + '<div class="form-group"><label>Email</label><input type="email" name="cust_email" placeholder="customer@email.com"></div>'
    + '</div>'
    + '</div>'
    + '<div class="form-group" style="margin-top:14px;margin-bottom:0;">'
    + '<input type="text" name="pref_location" id="apptAddr" placeholder="Service address" autocomplete="off" style="width:100%;padding:10px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.95rem;background:#fff;box-sizing:border-box;">'
    + '</div>'
    + '</div>'

    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Vehicle</div>'
    + vehicleCascadeHtml('appt-veh')
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">'
    + '<div class="form-group" style="margin-bottom:0;"><label>VIN <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="text" name="veh_vin" id="apptVehVin" maxlength="17" placeholder="optional"></div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>License plate <span style="color:#bbb;font-weight:400;">(optional)</span></label><input type="text" name="veh_plate" id="apptVehPlate" maxlength="10" placeholder="optional"></div>'
    + '</div>'
    + '</div>'

    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Schedule</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Date <span style="color:#c0392b;">*</span></label>'
    + '<input type="date" name="pref_date" id="apptDate" required></div>'
    + '<div class="form-group"><label>Time</label>'
    + '<select name="pref_time" style="width:100%;padding:10px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.95rem;background:#fff;">'
    + timeOpts
    + '</select></div>'
    + '</div>'
    + '</div>'

    // Shared quote pricing block (services + per-service breakdown, custom line
    // items, discount, customer summary, notes) — identical on every quote surface.
    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Service &amp; Pricing</div>'
    + quotePricingBlock('appt', {
        serviceNames: serviceNames,
        selected: fromLeadServices,
        taxPct: +(taxRate * 100).toFixed(2)
      })
    + '</div>'

    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Notes</div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Internal notes <span style="color:#bbb;font-weight:400;">(auto-filled from customer profile)</span></label>'
    + '<textarea name="notes" id="apptNotes" placeholder="Any notes for the job..."></textarea></div>'
    + '</div>'

    + '<div class="card">'
    + '<label style="display:flex;align-items:center;gap:10px;font-weight:500;cursor:pointer;">'
    + '<input type="checkbox" name="send_email" value="1" style="width:18px;height:18px;"> Send confirmation email to customer</label>'
    + '</div>'

    + '<button type="button" id="apptPreviewBtn" class="btn btn-outline" style="margin-bottom:8px;" onclick="apptPreview()">Preview Email</button>'
    + '<div id="apptPreviewBox" style="display:none;margin-bottom:12px;"></div>'
    + '<div style="display:flex;gap:10px;align-items:center;margin-bottom:24px;">'
    + '<button type="submit" id="apptSubmitBtn" class="btn btn-navy" style="flex:1;">Create Appointment</button>'
    + '<a href="/admin/appointments/new" class="btn btn-outline" style="width:auto;" onclick="bkClearDraft(\'apptnew-' + esc(fromLeadId || 'new') + '\')">Start Over</a>'
    + '</div>'
    + '</form>'
    + '<script>(function(){'
    + 'var form=document.querySelector("form[action=\'/admin/appointments/new\']");'
    + 'if(form)form.addEventListener("submit",function(){'
    + 'var btn=document.getElementById("apptSubmitBtn");'
    + 'if(btn){btn.disabled=true;btn.textContent="Creating…";}'
    + '});'
    + '})();</script>'

    + '<script>'
    + 'var apptPRICING=' + pricingJson + ';'
    + 'var CUST_LIST=' + custJson + ';'
    + 'function money(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'
    + CLI_JS
    + 'function bkRecalc(){apptcalc();}'
    // Customer typeahead
    + '(function(){'
    +   'var inp=document.getElementById("custPickerInput");'
    +   'var drop=document.getElementById("custPickerDrop");'
    +   'var hidId=document.getElementById("apptCustId");'
    +   'var chip=document.getElementById("custPickerChip");'
    +   'var chipLbl=document.getElementById("custPickerLabel");'
    +   'var newFields=document.getElementById("apptNewCustFields");'
    +   'var clearBtn=document.getElementById("custPickerClearBtn");'
    +   'function showDrop(items){'
    +     'if(!items.length){drop.style.display="none";return;}'
    +     'drop.innerHTML=items.map(function(c){'
    +       'return "<div data-id=\'"+c.id+"\' style=\'padding:11px 14px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:0.92rem;color:#0f172a;\'>"+c.label+"</div>";'
    +     '}).join("");'
    +     'drop.querySelectorAll("div").forEach(function(el){'
    +       'el.addEventListener("mousedown",function(e){e.preventDefault();selectCust(el.dataset.id,el.textContent);});'
    +       'el.addEventListener("touchend",function(e){e.preventDefault();selectCust(el.dataset.id,el.textContent);});'
    +     '});'
    +     'drop.style.display="block";'
    +   '}'
    +   'var hidEmail=document.getElementById("apptCustEmail");'
    +   'function selectCust(id,label){'
    +     'hidId.value=id;'
    +     'inp.value="";'
    +     'drop.style.display="none";'
    +     'chip.style.display="flex";'
    +     'chipLbl.textContent=label;'
    +     'newFields.style.display="none";'
    +     'var c=CUST_LIST.find(function(x){return String(x.id)===String(id);});'
    +     'if(hidEmail)hidEmail.value=(c&&c.email)||"";'
    +     'fetch("/admin/customer/"+id+"/autofill").then(function(r){return r.json();}).then(function(d){'
    +       'if(!d||!d.ok)return;'
    +       'if(d.vehicle&&window.bkVehFill)window.bkVehFill("appt-veh",d.vehicle);'
    +       'var a=document.getElementById("apptAddr");if(a&&d.address)a.value=d.address;'
    +       'if(hidEmail&&d.email)hidEmail.value=d.email;'
    +       'var vin=document.getElementById("apptVehVin");if(vin&&d.vehicle&&d.vehicle.vin)vin.value=d.vehicle.vin;'
    +       'var plate=document.getElementById("apptVehPlate");if(plate&&d.vehicle&&d.vehicle.license_plate)plate.value=d.vehicle.license_plate;'
    +       'var notes=document.getElementById("apptNotes");if(notes&&d.notes&&!notes.value)notes.value=d.notes;'
    +     '}).catch(function(){});'
    +   '}'
    +   'function clearCust(){'
    +     'hidId.value="";'
    +     'if(hidEmail)hidEmail.value="";'
    +     'inp.value="";'
    +     'chip.style.display="none";'
    +     'chipLbl.textContent="";'
    +     'newFields.style.display="block";'
    +     'if(window.bkVehFill)window.bkVehFill("appt-veh",{});'
    +     'var a=document.getElementById("apptAddr");if(a)a.value="";'
    +     'var vin=document.getElementById("apptVehVin");if(vin)vin.value="";'
    +     'var plate=document.getElementById("apptVehPlate");if(plate)plate.value="";'
    +     'inp.focus();'
    +   '}'
    +   'clearBtn.addEventListener("click",clearCust);'
    +   'if(hidId.value){fetch("/admin/customer/"+hidId.value+"/autofill").then(function(r){return r.json();}).then(function(d){'
    +     'if(!d||!d.ok)return;'
    +     'if(window._apptDraftRestored)return;' // a restored draft takes precedence over profile autofill
    +     'if(d.vehicle&&window.bkVehFill)window.bkVehFill("appt-veh",d.vehicle);'
    +     'var a=document.getElementById("apptAddr");if(a&&d.address)a.value=d.address;'
    +     'if(hidEmail&&d.email)hidEmail.value=d.email;'
    +     'var vin=document.getElementById("apptVehVin");if(vin&&d.vehicle&&d.vehicle.vin)vin.value=d.vehicle.vin;'
    +     'var plate=document.getElementById("apptVehPlate");if(plate&&d.vehicle&&d.vehicle.license_plate)plate.value=d.vehicle.license_plate;'
    +     'var notes=document.getElementById("apptNotes");if(notes&&d.notes&&!notes.value)notes.value=d.notes;'
    +   '}).catch(function(){});}'
    +   'inp.addEventListener("input",function(){'
    +     'var q=inp.value.trim().toLowerCase();'
    +     'if(!q){drop.style.display="none";return;}'
    +     'var hits=CUST_LIST.filter(function(c){return c.search.indexOf(q)!==-1;}).slice(0,8);'
    +     'showDrop(hits);'
    +   '});'
    +   'inp.addEventListener("blur",function(){setTimeout(function(){drop.style.display="none";},150);});'
    +   'inp.addEventListener("focus",function(){'
    +     'var q=inp.value.trim().toLowerCase();'
    +     'if(q){var hits=CUST_LIST.filter(function(c){return c.search.indexOf(q)!==-1;}).slice(0,8);showDrop(hits);}'
    +   '});'
    + '})();'
    // Shared quote pricing wiring (per-service rows, tier, calc, tags, hints).
    + quotePricingJs('appt')
    + 'apptInitRows();apptUpdateServiceHidden();apptRenderTags();apptHints();apptcalc();'
    + (mapsKey ? 'function apptInitMaps(){var input=document.getElementById("apptAddr");if(input&&window.google&&google.maps&&google.maps.places){new google.maps.places.Autocomplete(input,{types:["address"],componentRestrictions:{country:"us"}});}}' : '')
    + 'function apptPreview(){'
    +   'var box=document.getElementById("apptPreviewBox"),btn=document.getElementById("apptPreviewBtn");'
    +   'if(box.style.display!=="none"&&box.innerHTML){box.style.display="none";box.innerHTML="";btn.textContent="Preview Email";return;}'
    +   'var custId=(document.getElementById("apptCustId")||{}).value||"";'
    +   'var toName,toEmail;'
    +   'if(custId){'
    +     'var chipLbl=document.getElementById("custPickerLabel");'
    +     'toName=chipLbl?chipLbl.textContent.replace(/\\s*\\(\\d[\\d\\s\\-\\.]*\\)\\s*$/,"").trim():"(selected customer)";'
    +     'toEmail=(document.getElementById("apptCustEmail")||{}).value||"email on file";'
    +   '}else{'
    +     'var fn=(document.getElementById("apptCustFirst")||{}).value||"";'
    +     'var ln=(document.getElementById("apptCustLast")||{}).value||"";'
    +     'toName=(fn+" "+ln).trim()||"(no name entered)";'
    +     'toEmail=(document.querySelector("[name=cust_email]")||{}).value||"";'
    +   '}'
    +   'var svcs=apptGetAllServiceNames();'
    +   'var customSvc=(document.querySelector("[name=customService]")||{}).value||"";'
    +   'if(customSvc.trim())svcs=svcs.concat(customSvc.trim().split(",").map(function(s){return s.trim();}).filter(Boolean));'
    +   'var date=(document.getElementById("apptDate")||{}).value||"";'
    +   'var time=(document.querySelector("[name=pref_time]")||{}).value||"";'
    +   'var addr=(document.getElementById("apptAddr")||{}).value||"";'
    +   'var total=(document.getElementById("appttotalAmt")||{}).textContent||"$0.00";'
    +   'var toLine=toName+(toEmail?"&nbsp;&lt;"+toEmail+"&gt;":"");'
    +   'var rows="<table style=\'width:100%;border-collapse:collapse;font-size:0.88rem;\'>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;white-space:nowrap;vertical-align:top;\'>To</td><td style=\'padding:5px 0;\'>"+toLine+"</td></tr>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Subject</td><td style=\'padding:5px 0;\'>Your Brake Service Appointment Is Confirmed — Brake Knights</td></tr>";'
    +   'var apvy=(document.getElementById("appt-veh-year")||{}).value||"";'
    +   'var apvmk=(document.getElementById("appt-veh-make")||{}).value||"";'
    +   'var apvmd=(document.getElementById("appt-veh-model-hid")||{}).value||"";'
    +   'var apveh=[apvy,apvmk,apvmd].filter(function(x){return x&&x!=="Other";}).join(" ");'
    +   'var apItems=JSON.parse((document.getElementById("apptsvcLiH")||{}).value||"[]");'
    +   'var apSs=parseFloat((document.getElementById("apptss")||{}).value)||0;'
    +   'var apTax=parseFloat((document.getElementById("appttaxH")||{}).value)||0;'
    +   'var apDisc=parseFloat((document.getElementById("apptdisc")||{}).value)||0;'
    +   'function apMon2(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'
    +   'if(svcs.length)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;vertical-align:top;\'>Services</td><td style=\'padding:5px 0;\'>"+svcs.join(", ")+"</td></tr>";'
    +   'if(apveh)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Vehicle</td><td style=\'padding:5px 0;font-weight:600;\'>"+apveh+"</td></tr>";'
    +   'apItems.forEach(function(it){'
    +     'if(it.mode==="split"){'
    +       'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.service+" — Parts</td><td style=\'padding:5px 0;\'>$"+apMon2(it.parts)+"</td></tr>";'
    +       'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.service+" — Labor</td><td style=\'padding:5px 0;\'>$"+apMon2(it.labor)+"</td></tr>";'
    +     '}else{'
    +       'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.service+"</td><td style=\'padding:5px 0;\'>$"+apMon2(it.parts+it.labor)+"</td></tr>";'
    +     '}'
    +   '});'
    +   'cliCollect().forEach(function(it){rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>"+it.label.replace(/</g,"&lt;")+"</td><td style=\'padding:5px 0;\'>$"+apMon2(it.amount)+"</td></tr>";});'
    +   'if(apSs>0)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Shop Supplies</td><td style=\'padding:5px 0;\'>$"+apMon2(apSs)+"</td></tr>";'
    +   'if(apTax>0)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Tax</td><td style=\'padding:5px 0;\'>$"+apMon2(apTax)+"</td></tr>";'
    +   'var apDl=((document.getElementById("apptdiscLabel")||{}).value||"").trim();'
    +   'if(apDisc>0)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#1a7a3a;\'>Discount"+(apDl?" ("+apDl.replace(/</g,"&lt;")+")":"")+"</td><td style=\'padding:5px 0;color:#1a7a3a;\'>-$"+apMon2(apDisc)+"</td></tr>";'
    +   'rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;font-weight:700;\'>Total</td><td style=\'padding:5px 0;font-weight:700;\'>"+total+"</td></tr>";'
    +   'if(date)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Date &amp; Time</td><td style=\'padding:5px 0;\'>"+date+(time?" at "+time:"")+"</td></tr>";'
    +   'if(addr)rows+="<tr><td style=\'padding:5px 10px 5px 0;color:#888;\'>Address</td><td style=\'padding:5px 0;\'>"+addr+"</td></tr>";'
    +   'rows+="</table>";'
    +   'box.innerHTML="<div class=\'preview-box\'><h4>Confirmation Email Preview</h4>"+rows+"</div>";'
    +   'box.style.display="block";btn.textContent="Hide Preview";'
    + '}'
    // Draft restore finalizer: re-derive widgets from restored fields without re-pulling
    // prices, and rebuild the selected-customer chip without a profile autofill (so the
    // owner's restored vehicle/address/notes are not overwritten).
    + 'window.bkApptAfter=function(d){'
    +   'window._apptDraftRestored=true;'
    +   'var svc=(document.getElementById("apptsvcHidden").value||"").split(",").map(function(s){return s.trim();}).filter(Boolean);'
    +   'document.querySelectorAll(".appt-svc-cb").forEach(function(cb){cb.checked=svc.indexOf(cb.value)>=0;});'
    +   'document.querySelectorAll(".appt-pos-cb").forEach(function(cb){cb.checked=svc.indexOf(cb.getAttribute("data-prefix")+" - "+cb.getAttribute("data-pos"))>=0;});'
    +   'appttier=(document.getElementById("appttier").value)||"standard";'
    +   'document.getElementById("apptBtnStd").classList.toggle("active",appttier==="standard");'
    +   'document.getElementById("apptBtnPrem").classList.toggle("active",appttier==="premium");'
    +   'var rowsBox=document.getElementById("apptSvcPriceRows");if(rowsBox){rowsBox.innerHTML="";try{var sli=JSON.parse((document.getElementById("apptsvcLiH")||{}).value||"[]");if(Array.isArray(sli)&&sli.length){sli.forEach(function(it){apptAddPriceRow(it.service);var row=document.querySelector("#apptSvcPriceRows .svc-price-row[data-base=\'"+it.service+"\']");if(row){row.querySelector(".appt-parts-in").value=it.parts;row.querySelector(".appt-labor-in").value=it.labor;var mode=it.mode||"combined";row.querySelector(".svc-row-mode").value=mode;row.querySelectorAll(".svc-disp-btn").forEach(function(b,i){b.classList.toggle("active",(mode==="split")?i===1:i===0);});}});}else{apptInitRows();}}catch(e){apptInitRows();}}'
    +   'try{var ci=JSON.parse((document.getElementById("cliJson")||{}).value||"[]");if(Array.isArray(ci)){var c=document.getElementById("cliRows");if(c){c.innerHTML="";ci.forEach(function(it){var w=document.createElement("div");w.innerHTML=cliRowHtml();var row=w.firstChild;row.querySelector(".cli-label").value=it.label||"";row.querySelector(".cli-amount").value=(it.amount!=null?it.amount:"");cliSetTax(row.querySelector(".cli-tax"),it.taxed!==false);c.appendChild(row);});}}}catch(e){}'
    +   'apptUpdateServiceHidden();apptRenderTags();apptHints();'
    +   'var cid=(document.getElementById("apptCustId")||{}).value||"";'
    +   'if(cid){var c=(typeof CUST_LIST!=="undefined")?CUST_LIST.find(function(x){return String(x.id)===String(cid);}):null;'
    +     'if(c){var chip=document.getElementById("custPickerChip");if(chip)chip.style.display="flex";'
    +       'var lbl=document.getElementById("custPickerLabel");if(lbl)lbl.textContent=c.label;'
    +       'var nf=document.getElementById("apptNewCustFields");if(nf)nf.style.display="none";'
    +       'var he=document.getElementById("apptCustEmail");if(he&&!he.value)he.value=c.email||"";}}'
    +   'apptcalc();'
    + '};'
    + '</script>'
    + VEHICLE_CASCADE_JS
    + mapsScript;

  res.send(page('New Appointment', body, req));
});

// Branded appointment confirmation email body. Shared by New Appointment and
// Edit Appointment. Pass isUpdate=true to show the "appointment updated" banner
// (used when the owner edits a booked appointment and re-sends the confirmation).
function appointmentEmailHtml(o) {
  var WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function fmtApptDate(val) {
    if (!val) return '-';
    var m2 = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
    if (!m2) return val;
    var dt = new Date(+m2[1], +m2[2] - 1, +m2[3]);
    return WEEKDAYS[dt.getDay()] + ', ' + MONTHS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear();
  }
  var parts = o.parts || 0, labor = o.labor || 0, supplies = o.supplies || 0, tax = o.tax || 0, total = o.total || 0;
  var discount = Number(o.discount) || 0;
  var discountText = 'Discount' + (o.discountLabel ? ' (' + esc(o.discountLabel) + ')' : '');
  var svcLineItems = Array.isArray(o.svcLineItems) ? o.svcLineItems : [];
  var customLineItems = Array.isArray(o.customLineItems) ? o.customLineItems : [];
  var calendarUrl = o.baseUrl + '/quote/' + o.quoteId + '/' + o.token + '/calendar.ics';
  var gcalUrl = '';
  var apptStartRfc = toEasternRfc3339(o.pref_date, o.pref_time);
  if (apptStartRfc) {
    var apptMins = totalServiceMinutes(o.service) || 60;
    var gStart = new Date(apptStartRfc);
    var gEnd = new Date(gStart.getTime() + apptMins * 60000);
    gcalUrl = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + '&text=' + encodeURIComponent('Brake Knights - ' + (o.service || 'Brake Service'))
      + '&dates=' + icsUtcStamp(gStart) + '/' + icsUtcStamp(gEnd)
      + '&details=' + encodeURIComponent('Mobile brake service. Total: $' + money(total) + '. Questions? Call or text 703-977-4475.')
      + '&location=' + encodeURIComponent(o.pref_location || '');
  }
  var headline  = o.isUpdate ? 'Your appointment has been updated' : 'Your appointment is confirmed!';
  var introLine = o.isUpdate
    ? 'Greetings ' + esc(o.firstName) + ', the details of your service appointment have changed. Your latest appointment details are below.'
    : 'Greetings ' + esc(o.firstName) + ', your service appointment has been confirmed. See you then!';
  var updateBanner = o.isUpdate
    ? '<div style="background:#eaf2ff;border:1px solid #b9d2ff;border-left:4px solid #4169e1;border-radius:8px;padding:12px 16px;margin:0 0 20px;">'
      + '<p style="margin:0;color:#1a3a7a;font-size:0.9rem;font-weight:700;">This updates your earlier appointment</p>'
      + '<p style="margin:4px 0 0;color:#3a5280;font-size:0.85rem;line-height:1.5;">Please use the details below. They replace anything we sent you previously.</p>'
      + '</div>'
    : '';
  return '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#fff;">'
    + '<div style="background:#0a1f3d;padding:28px 32px;border-radius:8px 8px 0 0;text-align:center;">'
    + '<h1 style="color:#fff;margin:0 0 4px;font-size:1.4rem;"><img src="https://brakeknights.com/images/favicon.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin-right:10px;border-radius:6px;"> Brake Knights</h1>'
    + '<p style="color:#8aadcf;margin:0;font-size:0.88rem;">Mobile Brake Service - Northern Virginia</p></div>'
    + '<div style="padding:32px;border:1px solid #e0e7ef;border-top:none;border-radius:0 0 8px 8px;">'
    + '<h2 style="color:#1a7a3a;margin:0 0 16px;">' + headline + '</h2>'
    + updateBanner
    + '<p style="color:#444;line-height:1.6;margin:0 0 20px;">' + introLine + '</p>'
    + '<div style="background:#f4f7fb;border-radius:8px;padding:20px;margin-bottom:24px;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
    + '<tr><td style="padding:5px 0;color:#888;width:100px;">Service</td><td style="padding:5px 0;font-weight:600;">' + esc(o.service || 'Brake Service') + '</td></tr>'
    + (o.vehicle ? '<tr><td style="padding:5px 0;color:#888;">Vehicle</td><td style="padding:5px 0;">' + esc(o.vehicle) + '</td></tr>' : '')
    // Prefer the per-service breakdown (shared block); fall back to the legacy
    // combined / separate aggregate for older callers.
    + (svcLineItems.length
        ? svcLineItems.map(function(it) {
            return it.mode === 'split'
              ? '<tr><td style="padding:5px 0;color:#888;">' + esc(it.service) + ' — Parts</td><td style="padding:5px 0;">$' + money(it.parts) + '</td></tr>'
                + '<tr><td style="padding:5px 0;color:#888;">' + esc(it.service) + ' — Labor</td><td style="padding:5px 0;">$' + money(it.labor) + '</td></tr>'
              : '<tr><td style="padding:5px 0;color:#888;">' + esc(it.service) + '</td><td style="padding:5px 0;">$' + money(it.parts + it.labor) + '</td></tr>';
          }).join('')
        : (o.lineItems === 'separate'
            ? (parts + labor > 0
                ? '<tr><td style="padding:5px 0;color:#888;">Parts</td><td style="padding:5px 0;">$' + money(parts) + '</td></tr>'
                  + '<tr><td style="padding:5px 0;color:#888;">Labor</td><td style="padding:5px 0;">$' + money(labor) + '</td></tr>'
                : '')
            : (parts + labor > 0 ? '<tr><td style="padding:5px 0;color:#888;">Parts &amp; Labor</td><td style="padding:5px 0;">$' + money(parts + labor) + '</td></tr>' : '')))
    + customLineItems.map(function(it) {
        return '<tr><td style="padding:5px 0;color:#888;">' + esc(it.label) + '</td><td style="padding:5px 0;">$' + money(it.amount) + '</td></tr>';
      }).join('')
    + (supplies > 0 ? '<tr><td style="padding:5px 0;color:#888;">Shop Supplies</td><td style="padding:5px 0;">$' + money(supplies) + '</td></tr>' : '')
    + (tax > 0 ? '<tr><td style="padding:5px 0;color:#888;">Tax</td><td style="padding:5px 0;color:#888;">$' + money(tax) + '</td></tr>' : '')
    + (discount > 0 ? '<tr><td style="padding:5px 0;color:#1a7a3a;">' + discountText + '</td><td style="padding:5px 0;color:#1a7a3a;">-$' + money(discount) + '</td></tr>' : '')
    + '<tr style="border-top:2px solid #dde3ea;"><td style="padding:10px 0 0;font-weight:700;color:#0a1f3d;">Total</td><td style="padding:10px 0 0;font-weight:700;font-size:1rem;color:#0a1f3d;">$' + money(total) + '</td></tr>'
    + '<tr><td style="padding:10px 0 0;color:#888;">Date</td><td style="padding:10px 0 0;">' + esc(fmtApptDate(o.pref_date)) + '</td></tr>'
    + '<tr><td style="padding:5px 0;color:#888;">Time</td><td style="padding:5px 0;">' + esc(o.pref_time || '-') + '</td></tr>'
    + '<tr><td style="padding:5px 0;color:#888;vertical-align:top;">Location</td><td style="padding:5px 0;">' + esc(o.pref_location || '-') + '</td></tr>'
    + '</table></div>'
    + (o.customerNotes ? '<p style="color:#1a3a7a;background:#eaf2ff;border:1px solid #b9d2ff;border-radius:8px;padding:12px 16px;line-height:1.6;margin:0 0 20px;font-size:0.88rem;">' + esc(o.customerNotes) + '</p>' : '')
    + '<div style="text-align:center;margin:0 0 24px;">'
    + (gcalUrl ? '<a href="' + gcalUrl + '" style="display:inline-block;background:#4169e1;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 28px;border-radius:8px;margin:0 4px 8px;">Add to Google Calendar</a>' : '')
    + '<a href="' + calendarUrl + '" style="display:inline-block;background:#0a1f3d;color:#fff;font-weight:700;font-size:0.95rem;text-decoration:none;padding:13px 28px;border-radius:8px;margin:0 4px 8px;">Apple / Outlook (.ics)</a>'
    + '</div>'
    + '<p style="color:#6b5900;background:#fffbea;border:1px solid #e8d87a;border-radius:6px;padding:10px 14px;line-height:1.55;margin:0 0 24px;font-size:0.84rem;"><strong>Inspection note:</strong> If we arrive and determine no brake service is needed, a $60 inspection fee applies. If repairs are needed, the inspection fee is applied toward the cost of the repair.</p>'
    + '<div style="text-align:center;margin:0 0 24px;">'
    + '<p style="color:#888;font-size:0.85rem;margin:0 0 10px;">Need to make a change?</p>'
    + '<a href="' + o.baseUrl + '/quote/' + o.quoteId + '/' + o.token + '?action=reschedule" style="display:inline-block;background:#fff;border:2px solid #4169e1;color:#4169e1;font-weight:700;font-size:0.9rem;text-decoration:none;padding:11px 22px;border-radius:8px;margin:0 4px 8px;">Reschedule</a>'
    + '<a href="' + o.baseUrl + '/quote/' + o.quoteId + '/' + o.token + '?action=cancel" style="display:inline-block;background:#fff;border:2px solid #c0392b;color:#c0392b;font-weight:700;font-size:0.9rem;text-decoration:none;padding:11px 22px;border-radius:8px;margin:0 4px 8px;">Cancel Appointment</a>'
    + '</div>'
    + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
    + '<p style="color:#fff;font-weight:700;margin:0 0 8px;">Questions? Call or text:</p>'
    + '<a href="tel:7039774475" style="color:#6b8ff5;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
    + '</div></div>'
    + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div></div>';
}

router.post('/appointments/new', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var customerId = (req.body.customer_id || '').trim();
  var fromLeadId = parseInt(req.body.from_lead || '') || null;
  var vehicle    = [
    (req.body.veh_year  || '').trim(),
    (req.body.veh_make  || '').trim(),
    (req.body.veh_model || '').trim()
  ].filter(Boolean).join(' ').trim() || null;
  var service    = (req.body.service || '').trim();
  var customSvc  = (req.body.customService || '').trim();
  if (customSvc && service.split(',').map(function(s){return s.trim().toLowerCase();}).indexOf(customSvc.toLowerCase()) === -1) service = service ? service + ', ' + customSvc : customSvc;
  service = service || null;
  var tier       = (req.body.tier       || 'standard').trim();
  // Shared quote pricing block fields (per-service totals + discount + line items).
  var price_parts  = req.body.parts;
  var price_labor  = req.body.labor;
  var shop_supplies = req.body.shopSupplies;
  var discount     = parseFloat(req.body.discount) || 0;
  var discountLabel = (req.body.discount_label || '').trim() || null;
  var svcLineItems = (function(){ try { var a = JSON.parse(req.body.svcLineItems || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } })();
  var customLineItems = parseLineItems(req.body.customLineItems);
  var customLineItemsJson = customLineItems.length ? JSON.stringify(customLineItems) : null;
  var cliSum = customLineItems.reduce(function(a, it){ return a + (Number(it.amount) || 0); }, 0);
  var cliTaxable = customLineItems.reduce(function(a, it){ return a + (it.taxed ? (Number(it.amount) || 0) : 0); }, 0);
  var customerNotes = (req.body.customerNotes || '').trim() || null;
  var pref_date     = (req.body.pref_date     || '').trim() || null;
  var pref_time     = (req.body.pref_time     || '').trim() || null;
  var pref_location = (req.body.pref_location || '').trim() || null;
  var notes         = (req.body.notes         || '').trim() || null;
  var send_email    = req.body.send_email === '1';

  var cust;
  if (!customerId) {
    var cust_first = (req.body.cust_first || '').trim();
    var cust_last  = (req.body.cust_last  || '').trim();
    if (!cust_first || !cust_last) return res.redirect('/admin/appointments/new?err=name');
    var cust_phone = (req.body.cust_phone || '').trim() || null;
    var cust_email = (req.body.cust_email || '').trim() || null;
    var newCust = db.prepare(
      'INSERT INTO customers (first_name, last_name, phone, email) VALUES (?,?,?,?)'
    ).run(cust_first, cust_last, cust_phone, cust_email);
    customerId = newCust.lastInsertRowid;
    cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  } else {
    cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!cust) return res.redirect('/admin/appointments/new?err=name');
  }

  // Save the structured vehicle to the customer's profile if it's new, so it's
  // reusable on future appointments and feeds Phase 8 tier lookup.
  var vYear  = (req.body.veh_year  || '').trim() || null;
  var vMake  = (req.body.veh_make  || '').trim() || null;
  var vModel = (req.body.veh_model || '').trim() || null;
  var vVin   = (req.body.veh_vin   || '').trim() || null;
  var vPlate = (req.body.veh_plate || '').trim() || null;
  if (vMake || vModel || vVin || vPlate) {
    var dupe = db.prepare(
      'SELECT id FROM customer_vehicles WHERE customer_id = ? AND IFNULL(year,\'\')=? AND IFNULL(make,\'\')=? AND IFNULL(model,\'\')=?'
    ).get(cust.id, vYear || '', vMake || '', vModel || '');
    if (!dupe) {
      db.prepare('INSERT INTO customer_vehicles (customer_id, year, make, model, vin, license_plate) VALUES (?,?,?,?,?,?)')
        .run(cust.id, vYear, vMake, vModel, vVin, vPlate);
    } else if (vVin || vPlate) {
      // Update VIN/plate on existing vehicle row if those fields are new
      db.prepare('UPDATE customer_vehicles SET vin = COALESCE(NULLIF(?,\'\'),vin), license_plate = COALESCE(NULLIF(?,\'\'),license_plate) WHERE id = ?')
        .run(vVin, vPlate, dupe.id);
    }
  }

  // If booking from an existing quoted/quote_accepted lead, advance that lead
  // instead of creating a duplicate. This is the fix for the Daniel Kim case.
  var leadId;
  if (fromLeadId) {
    var existingLead = db.prepare("SELECT * FROM leads WHERE id = ? AND status IN ('quoted','quote_accepted','new','follow_up')").get(fromLeadId);
    if (existingLead) {
      db.prepare("UPDATE leads SET status = 'booked', vehicle = COALESCE(?,vehicle), service = COALESCE(?,service), status_updated_at = datetime('now') WHERE id = ?")
        .run(vehicle, service, existingLead.id);
      db.prepare("INSERT INTO lead_history (lead_id, event, detail) VALUES (?, 'Appointment booked from lead', ?)").run(
        existingLead.id,
        [service, pref_date, pref_time].filter(Boolean).join(' - ')
      );
      leadId = existingLead.id;
    }
  }

  if (!leadId) {
    var leadResult = db.prepare(
      'INSERT INTO leads (first_name, last_name, phone, email, vehicle, service, source, status, customer_id, status_updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime(\'now\'))'
    ).run(cust.first_name, cust.last_name, cust.phone || '', cust.email || null, vehicle, service, 'appointment', 'booked', cust.id);
    leadId = leadResult.lastInsertRowid;
    db.prepare("INSERT INTO lead_history (lead_id, event, detail) VALUES (?, 'Appointment created', ?)").run(
      leadId,
      [service, pref_date, pref_time].filter(Boolean).join(' - ')
    );
  }

  var parts    = parseFloat(price_parts)    || 0;
  var labor    = parseFloat(price_labor)    || 0;
  var supplies = parseFloat(shop_supplies)  || 0;
  // Tax is on parts + shop supplies + taxable custom line items (not labor — VA).
  var tax      = Math.round((parts + supplies + cliTaxable) * PRICING.taxRate * 100) / 100;
  var total    = Math.round((parts + labor + supplies + cliSum + tax - discount) * 100) / 100;
  var svcLineItemsJson = svcLineItems.length ? JSON.stringify(svcLineItems) : null;
  // Store the per-service breakdown + custom line items together so the appointment
  // confirmation email and any later edit can re-render the exact lines.
  var apptLineItemsStore = JSON.stringify({ svc: svcLineItems, custom: customLineItems });

  var token = crypto.randomUUID();
  var quoteResult = db.prepare(
    'INSERT INTO quotes (lead_id, service, tier, price_parts, price_labor, shop_supplies, tax_rate, tax, total, status, accept_token, accepted_at, pref_date, pref_time, pref_location, scheduling_notes, line_items, customer_notes, discount, discount_label, sent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\'),?,?,?,?,?,?,?,?,datetime(\'now\'))'
  ).run(leadId, service, tier, parts, labor, supplies, PRICING.taxRate, tax, total, 'approved', token, pref_date, pref_time, pref_location, notes, apptLineItemsStore, customerNotes, discount, discountLabel);

  if (send_email && cust.email && process.env.SMTP_PASS) {
    try {
      var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
      var html = appointmentEmailHtml({
        firstName: cust.first_name, service: service, vehicle: vehicle,
        parts: parts, labor: labor, supplies: supplies, tax: tax, total: total,
        svcLineItems: svcLineItems, customLineItems: customLineItems, discount: discount, discountLabel: discountLabel, customerNotes: customerNotes,
        pref_date: pref_date, pref_time: pref_time, pref_location: pref_location,
        baseUrl: baseUrl, quoteId: quoteResult.lastInsertRowid, token: token, isUpdate: false
      });
      await tx.sendMail({ from: '"Brake Knights" <greetings@brakeknights.com>', to: cust.email, cc: 'greetings@brakeknights.com', subject: 'Your appointment is confirmed - Brake Knights', html: html });
    } catch (err) { console.error('Appointment confirmation email error:', err.message); }
  }

  res.redirect('/admin/quote/' + leadId + '?msg=appt_created');
});

// ─── Edit a booked appointment (full details, optional updated email) ─────────
router.get('/appointments/:lead_id/edit', requireAuth, function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.lead_id);
  if (!lead) return res.redirect('/admin/appointments');
  var q = db.prepare("SELECT * FROM quotes WHERE lead_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1").get(lead.id);
  if (!q) return res.redirect('/admin/quote/' + lead.id);

  // Contact info can live on the lead, the linked customer, or both (e.g. a lead
  // created from a Quick Quote with no phone still links to a customer who has one).
  // Prefill from the lead, then fall back to the customer record so nothing is blank.
  var cust = lead.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(lead.customer_id) : null;
  var preFirst = lead.first_name || (cust && cust.first_name) || '';
  var preLast  = lead.last_name  || (cust && cust.last_name)  || '';
  var prePhone = lead.phone      || (cust && cust.phone)      || '';
  var preEmail = lead.email      || (cust && cust.email)      || '';

  var apptPricing = getEffectivePricing();
  var serviceNames = Object.keys(apptPricing);
  var pricingJson = JSON.stringify(apptPricing);
  var taxRate = PRICING.taxRate;
  var taxPctLabel = (taxRate * 100).toFixed(0);

  // Split the saved service string: known services pre-check boxes; anything not in
  // the pricing table goes into the custom-service field so it is preserved.
  var svcList = (q.service || '').split(',').map(function(s){ return s.trim(); }).filter(Boolean);
  var checkedSet = {};
  svcList.forEach(function(s){ if (apptPricing[s]) checkedSet[s] = true; });
  var customSvc = svcList.filter(function(s){ return !apptPricing[s]; }).join(', ');

  // Vehicle: best-effort split of the lead's free-text vehicle for the cascade.
  var vehParts = String(lead.vehicle || '').trim().split(/\s+/).filter(Boolean);
  var prefYear = '', prefMake = '', prefModel = '';
  if (vehParts.length && /^(19|20)\d{2}$/.test(vehParts[0])) prefYear = vehParts.shift();
  if (vehParts.length) prefMake = vehParts.shift();
  prefModel = vehParts.join(' ');

  var tier = q.tier === 'premium' ? 'premium' : 'standard';
  var supplies = Math.round(Number(q.shop_supplies) || 0);
  var apptDiscount = Math.round(Number(q.discount) || 0);
  var apptDiscountLabel = q.discount_label || '';
  var apptTaxPct = q.tax_rate != null ? +(q.tax_rate * 100).toFixed(2) : +(taxRate * 100).toFixed(2);
  // Prefill: appointments created via the shared block store line_items as
  // {svc:[...],custom:[...]}; older approved quotes store either a plain custom
  // line-items array or nothing. Parse defensively so edit always works.
  var apptSvcRows = [];
  var apptCustomLI = [];
  try {
    var _li = JSON.parse(q.line_items || 'null');
    if (_li && Array.isArray(_li.svc)) { apptSvcRows = _li.svc; apptCustomLI = parseLineItems(JSON.stringify(_li.custom || [])); }
    else if (Array.isArray(_li)) { apptCustomLI = parseLineItems(q.line_items); }
  } catch (_) {}
  // Hidden seed so the page can rebuild the exact per-service rows on load.
  var apptSvcSeed = JSON.stringify(apptSvcRows);

  var mapsKey = process.env.GOOGLE_MAPS_API_KEY || '';
  var mapsScript = mapsKey
    ? '<script async defer src="https://maps.googleapis.com/maps/api/js?key=' + esc(mapsKey) + '&libraries=places&callback=apptInitMaps"></script>'
    : '';

  var alert = '';
  if (req.query.err === 'name') alert = '<div class="alert alert-error">Customer first and last name are required.</div>';

  var inputStyle = 'width:100%;padding:10px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.95rem;background:#fff;box-sizing:border-box;';

  var body = '<a href="/admin/appointments" class="back-link"><span class="bk-arrow">&#8592;</span>Appointments</a>'
    + alert
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;margin-bottom:4px;">Edit Appointment</h1>'
    + '<div style="color:#888;font-size:0.85rem;margin-bottom:14px;">Update any details and save. Choose whether to email the customer an updated confirmation.</div>'
    + '<form method="POST" action="/admin/appointments/' + lead.id + '/edit">'

    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Customer</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>First name <span style="color:#c0392b;">*</span></label><input type="text" name="cust_first" value="' + esc(preFirst) + '" style="' + inputStyle + '"></div>'
    + '<div class="form-group"><label>Last name <span style="color:#c0392b;">*</span></label><input type="text" name="cust_last" value="' + esc(preLast) + '" style="' + inputStyle + '"></div>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Phone</label><input type="tel" name="cust_phone" value="' + esc(prePhone) + '" oninput="fmtPhoneInput(this)" maxlength="12" style="' + inputStyle + '"></div>'
    + '<div class="form-group"><label>Email</label><input type="email" name="cust_email" value="' + esc(preEmail) + '" placeholder="customer@email.com" style="' + inputStyle + '"></div>'
    + '</div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Service address</label>'
    + '<input type="text" name="pref_location" id="apptAddr" value="' + esc(q.pref_location || '') + '" placeholder="Service address" autocomplete="off" style="' + inputStyle + '"></div>'
    + '</div>'

    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Vehicle</div>'
    + vehicleCascadeHtml('appt-veh', {}, { year: prefYear, make: prefMake, model: prefModel })
    + '</div>'

    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Schedule</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'
    + '<div class="form-group"><label>Date <span style="color:#c0392b;">*</span></label>'
    + '<input type="date" name="pref_date" id="apptDate" value="' + esc(q.pref_date || '') + '" required style="' + inputStyle + '"></div>'
    + '<div class="form-group"><label>Time</label>'
    + '<select name="pref_time" style="' + inputStyle + '">' + ownerTimeOptions(q.pref_time || '') + '</select></div>'
    + '</div>'
    + '</div>'

    // Shared quote pricing block (services + per-service breakdown, custom line
    // items, discount, customer summary, notes) — identical on every quote surface.
    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Service &amp; Pricing</div>'
    + quotePricingBlock('appt', {
        serviceNames: serviceNames,
        selected: Object.keys(checkedSet),
        customSvc: customSvc,
        tier: tier,
        taxPct: apptTaxPct,
        discount: apptDiscount,
        discountLabel: apptDiscountLabel,
        shopSupplies: supplies,
        lineItems: apptCustomLI,
        customerNotes: q.customer_notes || ''
      })
    + '<input type="hidden" id="apptSvcSeed" value="' + esc(apptSvcSeed) + '">'
    + '</div>'

    + '<div class="card">'
    + '<div class="section-title" style="margin-bottom:10px;">Notes</div>'
    + '<div class="form-group" style="margin-bottom:0;"><label>Internal notes</label>'
    + '<textarea name="notes" placeholder="Any notes for the job...">' + esc(q.scheduling_notes || '') + '</textarea></div>'
    + '</div>'

    + (preEmail ? '' : '<div class="alert alert-error" style="margin-bottom:8px;">No email on file. The updated confirmation can\'t be emailed.</div>')
    + '<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:24px;">'
    + (preEmail ? '<button type="submit" name="send_email" value="1" class="btn btn-blue">Save &amp; Email Updated Confirmation</button>' : '')
    + '<button type="submit" name="send_email" value="0" class="btn btn-navy">Save Changes (no email)</button>'
    + '<a href="/admin/appointments" class="btn btn-outline" style="text-align:center;">Cancel</a>'
    + '</div>'
    + '</form>'

    + '<script>'
    + 'var apptPRICING=' + pricingJson + ';'
    + 'function money(n){return Number(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}'
    + CLI_JS
    + 'function bkRecalc(){apptcalc();}'
    // Shared quote pricing wiring (per-service rows, tier, calc, tags, hints).
    + quotePricingJs('appt')
    + (mapsKey ? 'function apptInitMaps(){var input=document.getElementById("apptAddr");if(input&&window.google&&google.maps&&google.maps.places){new google.maps.places.Autocomplete(input,{types:["address"],componentRestrictions:{country:"us"}});}}' : '')
    // On load: rebuild the saved per-service rows (preserving booked-appointment
    // price overrides), or pull fresh defaults if none were stored, then total up.
    + '(function(){'
    +   'var seed=[];try{seed=JSON.parse((document.getElementById("apptSvcSeed")||{}).value||"[]");}catch(e){}'
    +   'if(Array.isArray(seed)&&seed.length){seed.forEach(function(it){apptAddPriceRow(it.service);var row=document.querySelector("#apptSvcPriceRows .svc-price-row[data-base=\'"+it.service+"\']");if(row){row.querySelector(".appt-parts-in").value=it.parts;row.querySelector(".appt-labor-in").value=it.labor;var mode=it.mode||"combined";row.querySelector(".svc-row-mode").value=mode;row.querySelectorAll(".svc-disp-btn").forEach(function(b,i){b.classList.toggle("active",(mode==="split")?i===1:i===0);});}});}'
    +   'else{apptInitRows();}'
    +   'apptUpdateServiceHidden();apptRenderTags();apptHints();apptcalc();'
    + '})();'
    + '</script>'
    + VEHICLE_CASCADE_JS
    + mapsScript;

  res.send(page('Edit Appointment', body, req));
});

router.post('/appointments/:lead_id/edit', requireAuth, express.urlencoded({ extended: false }), async function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.lead_id);
  if (!lead) return res.redirect('/admin/appointments');
  var q = db.prepare("SELECT * FROM quotes WHERE lead_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1").get(lead.id);
  if (!q) return res.redirect('/admin/quote/' + lead.id);

  var firstName = (req.body.cust_first || '').trim();
  var lastName  = (req.body.cust_last  || '').trim();
  if (!firstName || !lastName) return res.redirect('/admin/appointments/' + lead.id + '/edit?err=name');
  var phone = (req.body.cust_phone || '').trim();
  var email = (req.body.cust_email || '').trim() || null;

  var vehicle = [(req.body.veh_year || '').trim(), (req.body.veh_make || '').trim(), (req.body.veh_model || '').trim()]
    .filter(Boolean).join(' ') || null;

  var service   = (req.body.service || '').trim();
  var customSvc = (req.body.customService || '').trim();
  if (customSvc && service.split(',').map(function(s){return s.trim().toLowerCase();}).indexOf(customSvc.toLowerCase()) === -1) service = service ? service + ', ' + customSvc : customSvc;
  service = service || null;
  var tier     = (req.body.tier || 'standard').trim();
  var pref_date = (req.body.pref_date || '').trim() || null;
  var pref_time = (req.body.pref_time || '').trim() || null;
  var pref_location = (req.body.pref_location || '').trim() || null;
  var notes = (req.body.notes || '').trim() || null;
  var sendEmail = req.body.send_email === '1';

  // Shared quote pricing block fields (per-service totals + discount + line items).
  var parts    = parseFloat(req.body.parts)        || 0;
  var labor    = parseFloat(req.body.labor)        || 0;
  var supplies = parseFloat(req.body.shopSupplies) || 0;
  var discount = parseFloat(req.body.discount)     || 0;
  var discountLabel = (req.body.discount_label || '').trim() || null;
  var svcLineItems = (function(){ try { var a = JSON.parse(req.body.svcLineItems || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } })();
  var customLineItems = parseLineItems(req.body.customLineItems);
  var cliSum = customLineItems.reduce(function(a, it){ return a + (Number(it.amount) || 0); }, 0);
  var cliTaxable = customLineItems.reduce(function(a, it){ return a + (it.taxed ? (Number(it.amount) || 0) : 0); }, 0);
  var customerNotes = (req.body.customerNotes || '').trim() || null;
  var tax      = Math.round((parts + supplies + cliTaxable) * PRICING.taxRate * 100) / 100;
  var total    = Math.round((parts + labor + supplies + cliSum + tax - discount) * 100) / 100;
  var apptLineItemsStore = JSON.stringify({ svc: svcLineItems, custom: customLineItems });

  // Update the lead contact + vehicle + service, and the approved quote details.
  db.prepare("UPDATE leads SET first_name = ?, last_name = ?, phone = ?, email = ?, vehicle = COALESCE(?, vehicle), service = ?, status_updated_at = datetime('now') WHERE id = ?")
    .run(firstName, lastName, phone, email, vehicle, service, lead.id);
  db.prepare("UPDATE quotes SET service = ?, tier = ?, price_parts = ?, price_labor = ?, shop_supplies = ?, tax_rate = ?, tax = ?, total = ?, pref_date = ?, pref_time = ?, pref_location = ?, scheduling_notes = ?, line_items = ?, customer_notes = ?, discount = ?, discount_label = ? WHERE id = ?")
    .run(service, tier, parts, labor, supplies, PRICING.taxRate, tax, total, pref_date, pref_time, pref_location, notes, apptLineItemsStore, customerNotes, discount, discountLabel, q.id);

  // Keep the linked customer record's contact info in sync.
  if (lead.customer_id) {
    db.prepare('UPDATE customers SET first_name = ?, last_name = ?, phone = COALESCE(NULLIF(?,\'\'), phone), email = COALESCE(?, email) WHERE id = ?')
      .run(firstName, lastName, phone, email, lead.customer_id);
  }

  logHistory(lead.id, 'Appointment updated', [service, pref_date, pref_time].filter(Boolean).join(' - ') + (sendEmail ? ' (customer emailed)' : ''));

  if (sendEmail && email && process.env.SMTP_PASS) {
    try {
      var tx = nodemailer.createTransport({ host: 'smtp.hostinger.com', port: 465, secure: true, auth: { user: 'greetings@brakeknights.com', pass: process.env.SMTP_PASS } });
      var baseUrl = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
      var html = appointmentEmailHtml({
        firstName: firstName, service: service, vehicle: vehicle,
        parts: parts, labor: labor, supplies: supplies, tax: tax, total: total,
        svcLineItems: svcLineItems, customLineItems: customLineItems, discount: discount, discountLabel: discountLabel, customerNotes: customerNotes,
        pref_date: pref_date, pref_time: pref_time, pref_location: pref_location,
        baseUrl: baseUrl, quoteId: q.id, token: q.accept_token, isUpdate: true
      });
      await tx.sendMail({ from: '"Brake Knights" <greetings@brakeknights.com>', to: email, cc: 'greetings@brakeknights.com', subject: 'Your appointment has been updated - Brake Knights', html: html });
    } catch (err) { console.error('Appointment update email error:', err.message); }
    return res.redirect('/admin/appointments?msg=appt_updated_email');
  }

  res.redirect('/admin/appointments?msg=appt_updated');
});

// ─── Placeholder for not-yet-built sidebar items ──────────────────────────────
function placeholderPage(req, res, title, phase) {
  var body = '<h1 style="font-size:1.2rem;font-weight:700;color:#0f172a;margin-bottom:14px;">' + esc(title) + '</h1>'
    + '<div class="card" style="text-align:center;padding:48px 24px;">'
    + '<div style="color:#94a3b8;width:48px;height:48px;margin:0 auto 14px;">' + icon('chart') + '</div>'
    + '<div style="color:#475569;font-weight:600;margin-bottom:6px;">' + esc(title) + ' is coming soon</div>'
    + '<div style="color:#94a3b8;font-size:0.875rem;">Planned for ' + esc(phase) + '.</div>'
    + '</div>';
  res.send(page(title, body, req));
}

// Small stat block card used on dashboard + report pages.
function statBox(value, label) {
  return '<div class="card" style="text-align:center;padding:20px;">'
    + '<div style="font-size:1.875rem;font-weight:700;color:#0f172a;">' + value + '</div>'
    + '<div style="font-size:0.875rem;color:#94a3b8;margin-top:4px;">' + label + '</div>'
    + '</div>';
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, function(req, res) {
  var now = new Date();
  var monthStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';

  var leadsThisMonth   = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE date(created_at) >= ?").get(monthStr).n;
  var revenueThisMonth = db.prepare("SELECT COALESCE(SUM(total),0) AS n FROM receipts WHERE sent_at IS NOT NULL AND date(sent_at) >= ?").get(monthStr).n;
  var openQuotes       = db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status IN ('quoted','quote_accepted') AND archived = 0").get().n;
  var activeFollowups  = db.prepare("SELECT COUNT(*) AS n FROM followups WHERE sent = 0 AND date(due_date) >= date('now')").get().n;

  var pipeline = db.prepare(
    "SELECT status, COUNT(*) AS n FROM leads WHERE archived = 0 GROUP BY status"
  ).all().reduce(function(acc, r) { acc[r.status] = r.n; return acc; }, {});

  var recent = db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT 10").all();

  var PIPELINE_STAGES = [
    ['new',            'New',            STATUS_COLOR.new],
    ['quoted',         'Quoted',         STATUS_COLOR.quoted],
    ['follow_up',      'Follow Up',      STATUS_COLOR.follow_up],
    ['quote_accepted', 'Quote Accepted', STATUS_COLOR.quote_accepted],
    ['booked',         'Booked',         STATUS_COLOR.booked],
    ['completed',      'Completed',      STATUS_COLOR.completed],
    ['receipt',        'Receipt Sent',   STATUS_COLOR.receipt],
  ];

  var pipelineHtml = '<div class="card" style="margin-bottom:12px;">'
    + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">Pipeline</div>'
    + '<div style="display:flex;flex-wrap:wrap;gap:8px;">'
    + PIPELINE_STAGES.map(function(s) {
        var count = pipeline[s[0]] || 0;
        return '<a href="/admin?status=' + s[0] + '" style="display:flex;align-items:center;gap:8px;background:' + hexA(s[2], 0.1) + ';border:1px solid ' + hexA(s[2], 0.25) + ';border-radius:10px;padding:10px 14px;text-decoration:none;flex:1;min-width:130px;">'
          + '<span style="font-size:1.4rem;font-weight:700;color:' + s[2] + ';line-height:1;">' + count + '</span>'
          + '<span style="font-size:0.78rem;color:#444;font-weight:600;line-height:1.3;">' + esc(s[1]) + '</span>'
          + '</a>';
      }).join('')
    + '</div></div>';

  var activityHtml = '<div class="card">'
    + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">Recent Activity</div>'
    + (recent.length === 0
        ? '<div style="text-align:center;padding:24px 0;color:#94a3b8;font-size:0.875rem;">No leads yet.</div>'
        : recent.map(function(l, i) {
            return '<div onclick="window.location=\'/admin/quote/' + l.id + '\';" style="display:flex;align-items:flex-start;justify-content:space-between;padding:10px 0;cursor:pointer;'
              + (i < recent.length - 1 ? 'border-bottom:1px solid var(--gray-100);' : '')
              + 'gap:10px;">'
              + '<div style="flex:1;min-width:0;">'
              + '<a href="/admin/quote/' + l.id + '" style="font-weight:600;color:#0a1f3d;text-decoration:none;font-size:0.9rem;">' + esc(l.first_name) + ' ' + esc(l.last_name) + '</a>'
              + '<div style="font-size:0.78rem;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(l.service || 'No service specified') + '</div>'
              + '</div>'
              + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">'
              + statusBadge(l.status)
              + '<span style="font-size:0.74rem;color:#aaa;">' + timeAgo(l.created_at) + '</span>'
              + '</div>'
              + '</div>';
          }).join(''))
    + '</div>';

  res.send(page('Dashboard',
    '<h1 style="font-size:1.2rem;font-weight:700;color:#0f172a;margin-bottom:16px;">Dashboard</h1>'
    + '<div class="stat-grid" style="margin-bottom:12px;">'
    + statBox('$' + money(revenueThisMonth), 'Revenue This Month')
    + statBox(leadsThisMonth, 'Leads This Month')
    + statBox(openQuotes, 'Open Quotes')
    + statBox(activeFollowups, 'Active Follow-Ups')
    + '</div>'
    + pipelineHtml
    + activityHtml,
    req
  ));
});

// ─── Revenue Report ────────────────────────────────────────────────────────────
router.get('/reports/revenue', requireAuth, function(req, res) {
  var totalRevenue = db.prepare("SELECT COALESCE(SUM(total),0) AS n FROM receipts WHERE sent_at IS NOT NULL").get().n;
  var totalJobs    = db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE sent_at IS NOT NULL").get().n;
  var avgJobValue  = totalJobs > 0 ? totalRevenue / totalJobs : 0;

  // Period-filtered stats — all receipts with sent_at, used client-side for the dropdown filter
  var allReceiptsForFilter = db.prepare("SELECT total, sent_at FROM receipts WHERE sent_at IS NOT NULL").all();

  // Build last-12-months list
  var revMonths = [];
  for (var ri = 11; ri >= 0; ri--) {
    var rd = new Date();
    rd.setDate(1);
    rd.setMonth(rd.getMonth() - ri);
    revMonths.push({
      key:     rd.getFullYear() + '-' + String(rd.getMonth() + 1).padStart(2, '0'),
      label:   rd.toLocaleDateString('en-US', { month: 'short' }) + ' \'' + String(rd.getFullYear()).slice(2),
      revenue: 0,
      jobs:    0
    });
  }

  var monthData = db.prepare(
    "SELECT strftime('%Y-%m', sent_at) AS month, COALESCE(SUM(total),0) AS revenue, COUNT(*) AS jobs "
    + "FROM receipts WHERE sent_at IS NOT NULL GROUP BY month"
  ).all().reduce(function(acc, r) { acc[r.month] = r; return acc; }, {});

  revMonths.forEach(function(m) {
    var r = monthData[m.key];
    if (r) { m.revenue = r.revenue || 0; m.jobs = r.jobs || 0; }
  });

  var maxRev = Math.max.apply(null, revMonths.map(function(m) { return m.revenue; })) || 1;
  var chartH  = 140;

  var barChart = '<div style="display:flex;align-items:flex-end;gap:3px;height:' + chartH + 'px;padding:0 2px;">'
    + revMonths.map(function(m) {
        var h = m.revenue > 0 ? Math.max(3, Math.round((m.revenue / maxRev) * chartH)) : 0;
        var tip = '$' + money(m.revenue) + (m.jobs > 0 ? ' (' + m.jobs + ' job' + (m.jobs === 1 ? '' : 's') + ')' : '');
        return '<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;min-width:0;" title="' + esc(m.label) + ': ' + esc(tip) + '">'
          + '<div style="width:100%;height:' + h + 'px;background:' + (h > 0 ? 'var(--cta)' : 'var(--gray-200)') + ';border-radius:3px 3px 0 0;"></div>'
          + '</div>';
      }).join('')
    + '</div>'
    + '<div style="display:flex;gap:3px;padding:4px 2px 0;border-top:2px solid var(--gray-200);">'
    + revMonths.map(function(m) {
        return '<div style="flex:1;text-align:center;font-size:0.6rem;color:#94a3b8;overflow:hidden;min-width:0;">' + esc(m.label) + '</div>';
      }).join('')
    + '</div>';

  // Service revenue breakdown (split comma-separated service strings)
  var allReceipts = db.prepare("SELECT service, total FROM receipts WHERE sent_at IS NOT NULL").all();
  var svcMap = {};
  allReceipts.forEach(function(r) {
    var svcs = (r.service || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    if (svcs.length === 0) svcs = ['Unspecified'];
    var share = r.total / svcs.length;
    svcs.forEach(function(name) {
      if (!svcMap[name]) svcMap[name] = { jobs: 0, revenue: 0 };
      svcMap[name].jobs++;
      svcMap[name].revenue += share;
    });
  });
  var svcList = Object.keys(svcMap).map(function(name) {
    return { name: name, jobs: svcMap[name].jobs, revenue: svcMap[name].revenue };
  }).sort(function(a, b) { return b.revenue - a.revenue; });

  var tableHtml = '<div class="card">'
    + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">Revenue by Service</div>'
    + (svcList.length === 0
        ? '<div style="text-align:center;padding:24px 0;color:#94a3b8;font-size:0.875rem;">No receipts yet.</div>'
        : '<table style="width:100%;border-collapse:collapse;font-size:0.875rem;">'
          + '<thead><tr>'
          + '<th style="text-align:left;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Service</th>'
          + '<th style="text-align:right;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Jobs</th>'
          + '<th style="text-align:right;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Revenue</th>'
          + '</tr></thead><tbody>'
          + svcList.map(function(s, i) {
              return '<tr' + (i % 2 ? ' style="background:#f8fafc;"' : '') + '>'
                + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);">' + esc(s.name) + '</td>'
                + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);text-align:right;">' + s.jobs + '</td>'
                + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);text-align:right;font-weight:600;">$' + money(s.revenue) + '</td>'
                + '</tr>';
            }).join('')
          + '</tbody></table>')
    + '</div>';

  var allReceiptsJson = JSON.stringify(allReceiptsForFilter.map(function(r) {
    return { total: r.total, d: (r.sent_at || '').slice(0, 10) };
  }));

  res.send(page('Revenue',
    '<h1 style="font-size:1.2rem;font-weight:700;color:#0f172a;margin-bottom:16px;">Revenue</h1>'
    + '<div class="stat-grid" style="margin-bottom:12px;">'
    + statBox('$' + money(totalRevenue), 'All-Time Revenue')
    + '<div class="stat-box" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">'
    + '<span id="periodRevAmt" style="font-size:1.4rem;font-weight:700;color:#0a1f3d;">$0.00</span>'
    + '<select id="periodSel" style="padding:5px 10px;border:1.5px solid #dde3ea;border-radius:7px;font-size:0.82rem;background:#fff;color:#0a1f3d;font-weight:600;">'
    + '<option value="today">Today</option>'
    + '<option value="week">This Week</option>'
    + '<option value="month" selected>This Month</option>'
    + '<option value="year">This Year</option>'
    + '</select>'
    + '</div>'
    + statBox(totalJobs, 'Jobs Completed')
    + statBox('$' + money(avgJobValue), 'Avg Job Value')
    + '</div>'
    + '<div class="card" style="margin-bottom:12px;">'
    + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:14px;">Monthly Revenue — Last 12 Months</div>'
    + barChart
    + '</div>'
    + tableHtml
    + '<script>(function(){'
    + 'var receipts=' + allReceiptsJson + ';'
    + 'var sel=document.getElementById("periodSel");'
    + 'var amt=document.getElementById("periodRevAmt");'
    + 'function pad(n){return String(n).padStart(2,"0");}'
    + 'function calc(){'
    +   'var now=new Date();'
    +   'var todayStr=now.getFullYear()+"-"+pad(now.getMonth()+1)+"-"+pad(now.getDate());'
    +   'var p=sel.value;'
    +   'var total=receipts.filter(function(r){'
    +     'if(p==="today")return r.d===todayStr;'
    +     'if(p==="week"){'
    +       'var d=new Date(now);d.setDate(d.getDate()-d.getDay());'
    +       'var weekStart=d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate());'
    +       'return r.d>=weekStart&&r.d<=todayStr;'
    +     '}'
    +     'if(p==="month")return r.d.slice(0,7)===todayStr.slice(0,7);'
    +     'if(p==="year")return r.d.slice(0,4)===todayStr.slice(0,4);'
    +     'return true;'
    +   '}).reduce(function(s,r){return s+r.total;},0);'
    +   'amt.textContent="$"+total.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});'
    + '}'
    + 'sel.addEventListener("change",calc);calc();'
    + '})();</script>',
    req
  ));
});

// ─── Conversions Report ────────────────────────────────────────────────────────
router.get('/reports/conversions', requireAuth, function(req, res) {
  var totalQuotesSent = db.prepare("SELECT COUNT(DISTINCT lead_id) AS n FROM quotes WHERE sent_at IS NOT NULL").get().n;
  var totalJobsDone   = db.prepare("SELECT COUNT(DISTINCT lead_id) AS n FROM receipts WHERE sent_at IS NOT NULL").get().n;
  var overallRate     = totalQuotesSent > 0 ? Math.round((totalJobsDone / totalQuotesSent) * 100) : 0;
  var stillOpen       = Math.max(0, totalQuotesSent - totalJobsDone);

  // Last 12 months
  var convMonths = [];
  for (var ci = 11; ci >= 0; ci--) {
    var cd = new Date();
    cd.setDate(1);
    cd.setMonth(cd.getMonth() - ci);
    convMonths.push({
      key:    cd.getFullYear() + '-' + String(cd.getMonth() + 1).padStart(2, '0'),
      label:  cd.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
      quotes: 0,
      jobs:   0
    });
  }

  var qByMonth = db.prepare(
    "SELECT strftime('%Y-%m', sent_at) AS month, COUNT(DISTINCT lead_id) AS n FROM quotes WHERE sent_at IS NOT NULL GROUP BY month"
  ).all().reduce(function(acc, r) { acc[r.month] = r.n; return acc; }, {});

  var rByMonth = db.prepare(
    "SELECT strftime('%Y-%m', sent_at) AS month, COUNT(DISTINCT lead_id) AS n FROM receipts WHERE sent_at IS NOT NULL GROUP BY month"
  ).all().reduce(function(acc, r) { acc[r.month] = r.n; return acc; }, {});

  convMonths.forEach(function(m) {
    m.quotes = qByMonth[m.key] || 0;
    m.jobs   = rByMonth[m.key] || 0;
  });

  var tableRows = convMonths.slice().reverse().map(function(m) {
    var rate = m.quotes > 0 ? Math.round((m.jobs / m.quotes) * 100) + '%' : '<span style="color:#94a3b8;">—</span>';
    return '<tr>'
      + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);">' + esc(m.label) + '</td>'
      + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);text-align:center;">' + m.quotes + '</td>'
      + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);text-align:center;">' + m.jobs + '</td>'
      + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);text-align:center;font-weight:600;">' + rate + '</td>'
      + '</tr>';
  }).join('');

  var convTable = '<div class="card">'
    + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">Quote to Job — Last 12 Months</div>'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.875rem;">'
    + '<thead><tr>'
    + '<th style="text-align:left;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Month</th>'
    + '<th style="text-align:center;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Quotes Sent</th>'
    + '<th style="text-align:center;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Jobs Done</th>'
    + '<th style="text-align:center;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Rate</th>'
    + '</tr></thead><tbody>' + tableRows + '</tbody></table></div>';

  res.send(page('Conversions',
    '<h1 style="font-size:1.2rem;font-weight:700;color:#0f172a;margin-bottom:16px;">Conversions</h1>'
    + '<div class="stat-grid" style="margin-bottom:12px;">'
    + statBox(overallRate + '%', 'Quote-to-Job Rate')
    + statBox(totalQuotesSent, 'Quotes Sent')
    + statBox(totalJobsDone, 'Jobs Completed')
    + statBox(stillOpen, 'Quotes Still Open')
    + '</div>'
    + convTable,
    req
  ));
});

// ─── Services Report ───────────────────────────────────────────────────────────
router.get('/reports/services', requireAuth, function(req, res) {
  // Inquiries by service (leads.service, all leads)
  var allLeads = db.prepare("SELECT service FROM leads").all();
  var inquiryMap = {};
  allLeads.forEach(function(l) {
    var svcs = (l.service || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    svcs.forEach(function(name) { inquiryMap[name] = (inquiryMap[name] || 0) + 1; });
  });

  // Jobs + revenue by service (receipts.service, sent receipts only)
  var svcReceipts = db.prepare("SELECT service, total FROM receipts WHERE sent_at IS NOT NULL").all();
  var jobMap = {};
  svcReceipts.forEach(function(r) {
    var svcs = (r.service || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    if (svcs.length === 0) return;
    var share = r.total / svcs.length;
    svcs.forEach(function(name) {
      if (!jobMap[name]) jobMap[name] = { jobs: 0, revenue: 0 };
      jobMap[name].jobs++;
      jobMap[name].revenue += share;
    });
  });

  var allNames = {};
  Object.keys(inquiryMap).forEach(function(n) { allNames[n] = true; });
  Object.keys(jobMap).forEach(function(n) { allNames[n] = true; });

  var svcRows = Object.keys(allNames).map(function(name) {
    return {
      name:      name,
      inquiries: inquiryMap[name] || 0,
      jobs:      jobMap[name] ? jobMap[name].jobs : 0,
      revenue:   jobMap[name] ? jobMap[name].revenue : 0
    };
  }).sort(function(a, b) { return (b.inquiries + b.jobs) - (a.inquiries + a.jobs); });

  var svcTable = '<div class="card">'
    + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">Services Breakdown</div>'
    + (svcRows.length === 0
        ? '<div style="text-align:center;padding:24px 0;color:#94a3b8;font-size:0.875rem;">No service data yet.</div>'
        : '<table style="width:100%;border-collapse:collapse;font-size:0.875rem;">'
          + '<thead><tr>'
          + '<th style="text-align:left;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Service</th>'
          + '<th style="text-align:right;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Inquiries</th>'
          + '<th style="text-align:right;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Jobs</th>'
          + '<th style="text-align:right;padding:8px 12px;font-size:0.72rem;font-weight:600;text-transform:uppercase;color:#94a3b8;border-bottom:1px solid var(--gray-200);">Revenue</th>'
          + '</tr></thead><tbody>'
          + svcRows.map(function(s, i) {
              return '<tr' + (i % 2 ? ' style="background:#f8fafc;"' : '') + '>'
                + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);">' + esc(s.name) + '</td>'
                + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);text-align:right;">' + s.inquiries + '</td>'
                + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);text-align:right;">' + s.jobs + '</td>'
                + '<td style="padding:10px 12px;border-bottom:1px solid var(--gray-100);text-align:right;font-weight:600;">'
                + (s.revenue > 0 ? '$' + money(s.revenue) : '<span style="color:#94a3b8;">—</span>')
                + '</td>'
                + '</tr>';
            }).join('')
          + '</tbody></table>')
    + '</div>';

  res.send(page('Services',
    '<h1 style="font-size:1.2rem;font-weight:700;color:#0f172a;margin-bottom:16px;">Services</h1>'
    + svcTable,
    req
  ));
});

// ─── Placeholder pages for not-yet-built sidebar items ────────────────────────
router.get('/receipts', requireAuth, function(req, res) {
  var rows = db.prepare(
    "SELECT r.id, r.lead_id, r.service, r.vehicle, r.service_date, r.total, r.payment_method, r.sent_at, "
    + "l.first_name, l.last_name, l.email "
    + "FROM receipts r LEFT JOIN leads l ON l.id = r.lead_id "
    + "WHERE r.sent_at IS NOT NULL "
    + "ORDER BY r.sent_at DESC"
  ).all();

  var totalRevenue = rows.reduce(function(s, r) { return s + (r.total || 0); }, 0);
  var totalCount   = rows.length;
  var now = new Date();
  var monthPfx = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  var thisMonthRows = rows.filter(function(r) { return (r.sent_at || '').slice(0, 7) === monthPfx; });
  var thisMonthRev  = thisMonthRows.reduce(function(s, r) { return s + (r.total || 0); }, 0);

  var cards = rows.length === 0
    ? '<div class="empty" id="rcptEmpty"><div style="margin-bottom:10px;">' + icon('document') + '</div>No receipts sent yet.</div>'
    : '<div id="rcptEmpty" style="display:none;padding:32px;text-align:center;color:#888;">No receipts match your search.</div>'
      + rows.map(function(r) {
          var name = ((r.first_name || '') + ' ' + (r.last_name || '')).trim() || 'Unknown customer';
          var searchText = (name + ' ' + (r.service || '') + ' ' + (r.vehicle || '') + ' ' + (r.email || '')).toLowerCase();
          var dateStr = r.service_date || (r.sent_at || '').slice(0, 10);
          var svcs = (r.service || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          return '<div class="card rcpt-card" data-search="' + esc(searchText) + '" onclick="window.location=\'/admin/quote/' + r.lead_id + '\';" style="cursor:pointer;border-left:3px solid var(--cta);">'
            + '<div class="row-sb">'
            + '<div class="lead-name">' + esc(name) + '</div>'
            + '<span style="font-size:1rem;font-weight:700;color:#0a1f3d;">$' + money(r.total || 0) + '</span>'
            + '</div>'
            + (r.vehicle ? '<div class="lead-meta" style="margin-top:3px;">' + esc(r.vehicle) + '</div>' : '')
            + '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">'
            + svcs.map(function(s) { return '<span style="background:#eef3ff;color:#1a4fc4;border-radius:6px;padding:3px 8px;font-size:0.78rem;font-weight:600;">' + esc(s) + '</span>'; }).join('')
            + '</div>'
            + '<div style="display:flex;gap:18px;margin-top:10px;font-size:0.82rem;color:#555;flex-wrap:wrap;">'
            + '<span>' + esc(r.payment_method || 'Unknown payment') + '</span>'
            + '<span>Sent ' + shortDate(r.sent_at) + '</span>'
            + (dateStr ? '<span>Service date ' + esc(dateStr) + '</span>' : '')
            + '</div>'
            + '</div>';
        }).join('');

  res.send(page('Receipts',
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">'
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;">Receipts</h1>'
    + '<span style="color:#aaa;font-size:0.83rem;" id="rcptCount">' + totalCount + ' total</span>'
    + '</div>'
    + '<div class="stat-grid" style="margin-bottom:14px;">'
    + statBox('$' + money(totalRevenue), 'Total Revenue')
    + statBox(totalCount, 'Receipts Sent')
    + statBox('$' + money(thisMonthRev), 'This Month')
    + statBox(thisMonthRows.length, 'Jobs This Month')
    + '</div>'
    + '<input type="text" id="rcptSearch" placeholder="Search by customer, service, or vehicle..." '
    + 'style="width:100%;padding:9px 12px;border:1.5px solid #dde3ea;border-radius:8px;font-size:0.9rem;background:#fff;box-sizing:border-box;margin-bottom:14px;" autocomplete="off">'
    + '<div id="rcptList">' + cards + '</div>'
    + '<script>(function(){'
    + 'var inp=document.getElementById("rcptSearch");'
    + 'var count=document.getElementById("rcptCount");'
    + 'var empty=document.getElementById("rcptEmpty");'
    + 'var total=' + totalCount + ';'
    + 'if(!inp)return;'
    + 'inp.addEventListener("input",function(){'
    +   'var q=inp.value.trim().toLowerCase();'
    +   'var cards=document.querySelectorAll(".rcpt-card");'
    +   'var shown=0;'
    +   'cards.forEach(function(el){'
    +     'var match=!q||el.dataset.search.indexOf(q)!==-1;'
    +     'el.style.display=match?"":"none";'
    +     'if(match)shown++;'
    +   '});'
    +   'if(count)count.textContent=q?(shown+" of "+total+" total"):(total+" total");'
    +   'if(empty)empty.style.display=(shown===0&&q)?"block":"none";'
    + '});'
    + '})();</script>',
    req
  ));
});
// ─── Phase 8A: Pricing & Tiers settings ────────────────────────────────────────

router.get('/settings/pricing', requireAuth, function(req, res) {
  var services = db.prepare('SELECT * FROM pricing_overrides ORDER BY id').all();
  if (!services.length) {
    services = Object.keys(PRICING.services).map(function(name) {
      var svc = PRICING.services[name];
      var std = svc.standard || { parts: 0, labor: 0, shopSupplies: 0 };
      var prem = svc.premium || std;
      return { service_name: name, std_parts: std.parts || 0, std_labor: std.labor || 0,
               std_supplies: std.shopSupplies || 0, prem_parts: prem.parts || 0,
               prem_labor: prem.labor || 0, prem_supplies: prem.shopSupplies || 0,
               has_premium: svc.premium ? 1 : 0, minutes: svc.minutes || 60,
               custom_quote: svc.customQuote ? 1 : 0, note: svc.note || null };
    });
  }
  var mappings = db.prepare('SELECT * FROM vehicle_tier_mappings ORDER BY tier, make, model').all();
  var unknownRows = [];
  try {
    unknownRows = db.prepare(
      'SELECT uv.*, l.first_name, l.last_name FROM unknown_vehicles uv' +
      ' LEFT JOIN leads l ON l.id = uv.lead_id' +
      ' WHERE uv.classified_tier IS NULL ORDER BY uv.created_at DESC'
    ).all();
  } catch (_) {}

  // Tier badge HTML (no amber, no gold)
  function tierBadge(tier) {
    var cfg = {
      standard:    { bg: 'rgba(37,99,168,0.12)',   color: '#1a4a7a', label: 'Standard' },
      premium:     { bg: 'rgba(139,92,246,0.12)',  color: '#6d28d9', label: 'Premium' },
      not_serviced:{ bg: 'rgba(239,68,68,0.12)',   color: '#b91c1c', label: 'Not Serviced' }
    };
    var c = cfg[tier] || cfg.standard;
    return '<span style="background:' + c.bg + ';color:' + c.color + ';font-size:0.72rem;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em;">' + c.label + '</span>';
  }

  // ── Service Prices tab ─────────────────────────────────────────────────────
  // Chevron SVG for collapsible service headers.
  var p8Chev = '<svg class="p8-svc-chev" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" style="width:18px;height:18px;flex-shrink:0;transition:transform .15s;"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5"/></svg>';

  // Wraps a service in a collapsible card: header (name + summary + chevron) always
  // visible, body (editable inputs) hidden until the header is tapped.
  function svcShell(idx, name, summaryHtml, bodyHtml) {
    return '<div class="card p8-svc-card" data-svc-idx="' + idx + '" style="margin-bottom:8px;padding:0;overflow:hidden;">'
      + '<button type="button" class="p8-svc-head" onclick="p8ToggleSvc(this)" style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;background:none;border:none;cursor:pointer;text-align:left;font-family:inherit;">'
      + '<span style="font-weight:600;color:#0a1f3d;font-size:0.95rem;">' + esc(name) + '</span>'
      + '<span style="display:flex;align-items:center;gap:10px;">'
      + '<span class="p8-svc-summary" id="p8-summary-' + idx + '" style="font-size:0.78rem;color:#94a3b8;white-space:nowrap;">' + summaryHtml + '</span>'
      + p8Chev
      + '</span></button>'
      + '<div class="p8-svc-body" style="display:none;padding:0 16px 16px;">' + bodyHtml + '</div>'
      + '</div>';
  }

  var svcCards = services.map(function(svc, idx) {
    if (svc.custom_quote) {
      return svcShell(idx, svc.service_name,
        '<span style="background:rgba(37,99,168,0.12);color:#1a4a7a;font-weight:700;padding:2px 9px;border-radius:4px;text-transform:uppercase;letter-spacing:.04em;font-size:0.7rem;">Custom Quote</span>',
        '<div style="color:#94a3b8;font-size:0.82rem;">No preset pricing. Owner enters price manually on each job.</div>');
    }

    function priceCol(tierKey, isStd) {
      var p = isStd ? svc.std_parts  : svc.prem_parts;
      var l = isStd ? svc.std_labor  : svc.prem_labor;
      var s = isStd ? svc.std_supplies : svc.prem_supplies;
      var tax = (p + s) * PRICING.taxRate;
      var total = +p + +l + +s + tax;
      var totalId = 'p8-' + (isStd ? 'std' : 'prem') + '-total-' + idx;
      var label = isStd ? 'Standard' : 'Premium';
      function numInput(field, val) {
        return '<div style="margin-bottom:8px;">'
          + '<div style="font-size:0.75rem;font-weight:500;color:#475569;margin-bottom:3px;">' + field.charAt(0).toUpperCase() + field.slice(1) + '</div>'
          + '<div style="display:flex;align-items:center;gap:4px;">'
          + '<span style="color:#94a3b8;font-size:0.85rem;">$</span>'
          + '<input type="number" step="0.01" min="0" class="p8-price-input" data-idx="' + idx + '" data-tier="' + tierKey + '" data-field="' + field + '" value="' + (+val) + '" style="width:82px;padding:7px 8px;border:1px solid var(--gray-200);border-radius:6px;font-size:0.88rem;text-align:right;">'
          + '</div></div>';
      }
      return '<div style="flex:1;min-width:130px;">'
        + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:8px;">' + label + '</div>'
        + numInput('parts',    p)
        + numInput('labor',    l)
        + numInput('supplies', s)
        + '<div style="font-size:0.8rem;color:#475569;border-top:1px solid var(--gray-100);padding-top:6px;">Total: <strong id="' + totalId + '">$' + money(total) + '</strong></div>'
        + '</div>';
    }

    var stdTotal = +svc.std_parts + +svc.std_labor + +svc.std_supplies + (+svc.std_parts + +svc.std_supplies) * PRICING.taxRate;
    var premTotal = +svc.prem_parts + +svc.prem_labor + +svc.prem_supplies + (+svc.prem_parts + +svc.prem_supplies) * PRICING.taxRate;
    var summary = svc.has_premium
      ? 'Std $' + money(stdTotal) + ' &middot; Prem $' + money(premTotal)
      : '$' + money(stdTotal);

    var bodyHtml = '<div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:12px;">'
      + '<span style="font-size:0.75rem;color:#94a3b8;">Duration</span>'
      + '<input type="number" min="0" step="5" class="p8-price-input" data-idx="' + idx + '" data-tier="meta" data-field="minutes" value="' + (+svc.minutes || 60) + '" style="width:54px;padding:4px 6px;border:1px solid var(--gray-200);border-radius:5px;font-size:0.82rem;text-align:right;" title="Duration (minutes)">'
      + '<span style="font-size:0.78rem;color:#94a3b8;">min</span>'
      + '</div>'
      + '<div style="display:flex;gap:16px;flex-wrap:wrap;">'
      + priceCol('std', true)
      + (svc.has_premium
          ? priceCol('prem', false)
          : '<div style="flex:1;min-width:130px;display:flex;align-items:center;justify-content:center;"><span style="color:#94a3b8;font-size:0.82rem;font-style:italic;">Single tier only</span></div>')
      + '</div>';

    return svcShell(idx, svc.service_name, summary, bodyHtml);
  }).join('');

  var pricesTab = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">'
    + '<div style="font-size:0.875rem;color:#475569;">Tax rate (VA): <strong>6%</strong> — applied to parts + supplies only. Labor is not taxed.</div>'
    + '<button class="btn btn-blue btn-sm" onclick="saveAllPrices()">Save All Prices</button>'
    + '</div>'
    + svcCards
    + '<div style="margin-top:6px;text-align:right;"><button class="btn btn-blue btn-sm" onclick="saveAllPrices()">Save All Prices</button></div>';

  // ── Vehicle Tiers tab ──────────────────────────────────────────────────────
  var tierDefs = '<div class="card" style="margin-bottom:14px;">'
    + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">Tier Definitions</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;">'
    + '<div><div style="font-weight:700;color:#1a4a7a;margin-bottom:4px;">Standard</div>'
    + '<div style="font-size:0.82rem;color:#475569;line-height:1.5;">Economy and family vehicles: domestic cars (Chevrolet, Ford, Dodge, GMC cars), Japanese and Korean brands. Regular parts cost and service time.</div></div>'
    + '<div><div style="font-weight:700;color:#6d28d9;margin-bottom:4px;">Premium</div>'
    + '<div style="font-size:0.82rem;color:#475569;line-height:1.5;">Luxury brands (BMW, Mercedes-Benz, Audi, Lexus, Acura, etc.) and all trucks/SUVs regardless of brand. Higher parts cost and service complexity.</div></div>'
    + '<div><div style="font-weight:700;color:#b91c1c;margin-bottom:4px;">Not Serviced</div>'
    + '<div style="font-size:0.82rem;color:#475569;line-height:1.5;">Vehicles requiring specialized equipment we do not carry (e.g., Tesla). Customer sees a friendly message and cannot book.</div></div>'
    + '<div><div style="font-weight:700;color:#94a3b8;margin-bottom:4px;">Unknown Vehicle</div>'
    + '<div style="font-size:0.82rem;color:#475569;line-height:1.5;">Vehicle not matched by any rule below. Defaults to Premium pricing to avoid underquoting. Appears in Unknown Vehicles for review.</div></div>'
    + '</div></div>';

  var addMappingForm = '<div class="card" style="margin-bottom:14px;">'
    + '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:#94a3b8;margin-bottom:12px;">Add Rule</div>'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">'
    + '<div style="flex:1;min-width:110px;">'
    + '<div style="font-size:0.78rem;font-weight:500;color:#475569;margin-bottom:4px;">Make (brand)</div>'
    + '<input id="p8-new-make" type="text" placeholder="e.g. Honda" style="width:100%;padding:9px 11px;border:1px solid var(--gray-200);border-radius:7px;font-size:0.88rem;">'
    + '</div>'
    + '<div style="flex:1;min-width:110px;">'
    + '<div style="font-size:0.78rem;font-weight:500;color:#475569;margin-bottom:4px;">Model (blank = all models)</div>'
    + '<input id="p8-new-model" type="text" placeholder="e.g. Pilot" style="width:100%;padding:9px 11px;border:1px solid var(--gray-200);border-radius:7px;font-size:0.88rem;">'
    + '</div>'
    + '<div style="flex:0 0 150px;">'
    + '<div style="font-size:0.78rem;font-weight:500;color:#475569;margin-bottom:4px;">Tier</div>'
    + '<select id="p8-new-tier" style="width:100%;padding:9px 11px;border:1px solid var(--gray-200);border-radius:7px;font-size:0.88rem;">'
    + '<option value="standard">Standard</option><option value="premium">Premium</option><option value="not_serviced">Not Serviced</option>'
    + '</select>'
    + '</div>'
    + '<button class="btn btn-blue btn-sm" style="flex:0 0 auto;min-height:44px;" onclick="addMapping()">Add Rule</button>'
    + '</div></div>';

  var tierFilterHtml = '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;" id="p8-tier-filters">'
    + ['', 'standard', 'premium', 'not_serviced'].map(function(t, i) {
        var lbl = ['All', 'Standard', 'Premium', 'Not Serviced'][i];
        return '<button class="filter-tab' + (i === 0 ? ' active' : '') + '" onclick="filterMappings(\'' + t + '\',this)">' + lbl + '</button>';
      }).join('')
    + '</div>';

  var mappingCards = mappings.length === 0
    ? '<div style="text-align:center;padding:32px 24px;color:#94a3b8;font-size:0.875rem;">No rules yet. Add your first rule above.</div>'
    : mappings.map(function(m) {
        return '<div class="card" style="display:flex;align-items:center;justify-content:space-between;padding:11px 16px;margin-bottom:8px;gap:12px;" data-tier="' + esc(m.tier) + '">'
          + '<div style="flex:1;min-width:0;">'
          + '<div style="font-weight:600;color:#0a1f3d;font-size:0.9rem;">' + esc(m.make) + '</div>'
          + '<div style="font-size:0.8rem;color:#94a3b8;">' + (m.model ? esc(m.model) : 'All models') + '</div>'
          + '</div>'
          + '<div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">'
          + tierBadge(m.tier)
          + '<button onclick="deleteMapping(' + m.id + ',this)" style="background:none;border:1px solid var(--gray-200);color:#ef4444;font-size:0.78rem;font-weight:600;padding:5px 10px;border-radius:6px;cursor:pointer;min-height:36px;">Delete</button>'
          + '</div></div>';
      }).join('');

  var tiersTab = tierDefs + addMappingForm + tierFilterHtml + '<div id="p8-mapping-list">' + mappingCards + '</div>';

  // ── Unknown Vehicles tab ──────────────────────────────────────────────────
  var unknownTab = unknownRows.length === 0
    ? '<div class="card" style="text-align:center;padding:48px 24px;">'
      + '<div style="color:#94a3b8;width:44px;height:44px;margin:0 auto 12px;">' + icon('wrench') + '</div>'
      + '<div style="color:#475569;font-weight:600;margin-bottom:6px;">No unknown vehicles</div>'
      + '<div style="color:#94a3b8;font-size:0.875rem;">When a customer submits a vehicle that does not match any rule, it will appear here for you to classify.</div>'
      + '</div>'
    : unknownRows.map(function(uv) {
        var leadName = ((uv.first_name || '') + ' ' + (uv.last_name || '')).trim();
        var vehicle  = [uv.year, uv.make, uv.model].filter(Boolean).join(' ');
        return '<div class="card" style="margin-bottom:10px;" id="uv-card-' + uv.id + '">'
          + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">'
          + '<div style="flex:1;min-width:0;">'
          + '<div style="font-weight:600;color:#0a1f3d;margin-bottom:2px;">' + esc(vehicle || 'Unknown vehicle') + '</div>'
          + (leadName ? '<div style="font-size:0.82rem;color:#475569;">Lead: <a href="/admin/quote/' + (uv.lead_id || '') + '" style="color:#1a4a7a;">' + esc(leadName) + '</a></div>' : '')
          + '<div style="font-size:0.8rem;color:#94a3b8;margin-top:4px;">Auto-assigned: ' + tierBadge(uv.auto_tier) + '</div>'
          + '</div>'
          + '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;flex-wrap:wrap;margin-top:4px;">'
          + '<select id="uv-tier-' + uv.id + '" style="padding:8px 10px;border:1px solid var(--gray-200);border-radius:7px;font-size:0.85rem;">'
          + '<option value="standard">Standard</option><option value="premium" selected>Premium</option><option value="not_serviced">Not Serviced</option>'
          + '</select>'
          + '<label style="display:flex;align-items:center;gap:5px;font-size:0.82rem;color:#475569;cursor:pointer;white-space:nowrap;">'
          + '<input type="checkbox" id="uv-save-' + uv.id + '" style="width:16px;height:16px;"> Save to rules'
          + '</label>'
          + '<button class="btn btn-blue btn-sm" onclick="classifyUnknown(' + uv.id + ')" style="min-height:40px;">Classify</button>'
          + '</div></div></div>';
      }).join('');

  // ── Page assembly ──────────────────────────────────────────────────────────
  var tabNav = '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;" id="p8-main-tabs">'
    + '<button class="filter-tab active" data-tab="prices"  onclick="switchP8Tab(\'prices\',this)">Service Prices</button>'
    + '<button class="filter-tab"        data-tab="tiers"   onclick="switchP8Tab(\'tiers\',this)">Vehicle Tiers</button>'
    + '<button class="filter-tab"        data-tab="unknown" onclick="switchP8Tab(\'unknown\',this)">Unknown Vehicles'
    + (unknownRows.length > 0 ? '<span style="background:#ef4444;color:#fff;font-size:0.65rem;font-weight:700;padding:1px 5px;border-radius:8px;margin-left:4px;">' + unknownRows.length + '</span>' : '')
    + '</button></div>';

  var script = '<script>'
    + 'var P8_TAX=' + PRICING.taxRate + ';'
    + 'var P8_SVCS=' + JSON.stringify(services.map(function(s) { return s.service_name; })) + ';'

    + 'function switchP8Tab(tab,btn){'
    + '  [\'prices\',\'tiers\',\'unknown\'].forEach(function(t){'
    + '    document.getElementById(\'p8tab-\'+t).style.display=t===tab?\'\':\'none\';'
    + '  });'
    + '  document.querySelectorAll(\'#p8-main-tabs .filter-tab\').forEach(function(b){b.classList.remove(\'active\');});'
    + '  btn.classList.add(\'active\');'
    + '}'

    + 'document.addEventListener(\'input\',function(e){'
    + '  var el=e.target;if(!el.classList.contains(\'p8-price-input\'))return;'
    + '  var idx=+el.dataset.idx;'
    + '  function gv(tier,field){var i=document.querySelector(\'.p8-price-input[data-idx="\'+idx+\'"][data-tier="\'+tier+\'"][data-field="\'+field+\'"]\');return i?+i.value:0;}'
    + '  function recalcTier(tk,elId){'
    + '    var p=gv(tk,\'parts\'),l=gv(tk,\'labor\'),s=gv(tk,\'supplies\');'
    + '    var t=p+l+s+(p+s)*P8_TAX;'
    + '    var e2=document.getElementById(elId);if(e2)e2.textContent=\'$\'+t.toLocaleString(\'en-US\',{minimumFractionDigits:2,maximumFractionDigits:2});'
    + '  }'
    + '  recalcTier(\'std\',\'p8-std-total-\'+idx);'
    + '  recalcTier(\'prem\',\'p8-prem-total-\'+idx);'
    + '  var sumEl=document.getElementById(\'p8-summary-\'+idx);'
    + '  if(sumEl){'
    + '    function tot(tk){var p=gv(tk,\'parts\'),l=gv(tk,\'labor\'),s=gv(tk,\'supplies\');return p+l+s+(p+s)*P8_TAX;}'
    + '    function fmt(n){return n.toLocaleString(\'en-US\',{minimumFractionDigits:2,maximumFractionDigits:2});}'
    + '    var hasPrem=!!document.querySelector(\'.p8-price-input[data-idx="\'+idx+\'"][data-tier="prem"]\');'
    + '    sumEl.innerHTML=hasPrem?(\'Std $\'+fmt(tot(\'std\'))+\' &middot; Prem $\'+fmt(tot(\'prem\'))):(\'$\'+fmt(tot(\'std\')));'
    + '  }'
    + '});'

    + 'function p8ToggleSvc(btn){'
    + '  var card=btn.closest(\'.p8-svc-card\');if(!card)return;'
    + '  var body=card.querySelector(\'.p8-svc-body\');'
    + '  var chev=card.querySelector(\'.p8-svc-chev\');'
    + '  var open=body.style.display!=="none";'
    + '  body.style.display=open?"none":"block";'
    + '  if(chev)chev.style.transform=open?"":"rotate(180deg)";'
    + '}'

    + 'function saveAllPrices(){'
    + '  var rows=P8_SVCS.map(function(name,idx){'
    + '    function iv(tier,field){var i=document.querySelector(\'.p8-price-input[data-idx="\'+idx+\'"][data-tier="\'+tier+\'"][data-field="\'+field+\'"]\');return i?+i.value:0;}'
    + '    return{name:name,std_parts:iv(\'std\',\'parts\'),std_labor:iv(\'std\',\'labor\'),std_supplies:iv(\'std\',\'supplies\'),'
    + '           prem_parts:iv(\'prem\',\'parts\'),prem_labor:iv(\'prem\',\'labor\'),prem_supplies:iv(\'prem\',\'supplies\'),'
    + '           minutes:iv(\'meta\',\'minutes\')};'
    + '  });'
    + '  fetch(\'/admin/settings/pricing/save-prices\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({services:rows})}).then(function(r){return r.json();}).then(function(r){'
    + '    p8Banner(r.ok?\'Prices saved.\':\'Error: \'+(r.error||\'unknown\'),r.ok);'
    + '  }).catch(function(){p8Banner(\'Network error. Please try again.\',false);});'
    + '}'

    + 'function addMapping(){'
    + '  var make=document.getElementById(\'p8-new-make\').value.trim();'
    + '  var model=document.getElementById(\'p8-new-model\').value.trim();'
    + '  var tier=document.getElementById(\'p8-new-tier\').value;'
    + '  if(!make){alert(\'Please enter a make (brand name).\');return;}'
    + '  fetch(\'/admin/settings/pricing/add-mapping\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({make:make,model:model||null,tier:tier})}).then(function(r){return r.json();}).then(function(r){'
    + '    if(r.ok){location.reload();}else{p8Banner(\'Error: \'+(r.error||\'unknown\'),false);}'
    + '  });'
    + '}'

    + 'function deleteMapping(id,btn){'
    + '  if(!confirm(\'Remove this vehicle rule?\'))return;'
    + '  fetch(\'/admin/settings/pricing/delete-mapping\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({id:id})}).then(function(r){return r.json();}).then(function(r){'
    + '    if(r.ok){var c=btn.closest(\'.card\');if(c)c.remove();}else{p8Banner(\'Error: \'+(r.error||\'unknown\'),false);}'
    + '  });'
    + '}'

    + 'function filterMappings(tier,btn){'
    + '  document.querySelectorAll(\'#p8-mapping-list .card\').forEach(function(c){c.style.display=(!tier||c.dataset.tier===tier)?\'\':\'none\';});'
    + '  document.querySelectorAll(\'#p8-tier-filters .filter-tab\').forEach(function(b){b.classList.remove(\'active\');});'
    + '  btn.classList.add(\'active\');'
    + '}'

    + 'function classifyUnknown(id){'
    + '  var tier=document.getElementById(\'uv-tier-\'+id).value;'
    + '  var save=document.getElementById(\'uv-save-\'+id).checked;'
    + '  fetch(\'/admin/settings/pricing/classify-unknown\',{method:\'POST\',headers:{\'Content-Type\':\'application/json\'},body:JSON.stringify({id:id,tier:tier,save_to_mappings:save})}).then(function(r){return r.json();}).then(function(r){'
    + '    if(r.ok){var c=document.getElementById(\'uv-card-\'+id);if(c){c.style.opacity=\'.45\';c.insertAdjacentHTML(\'beforeend\',\'<div style="padding:5px 0;font-size:0.82rem;color:#22c55e;font-weight:600;">Classified as \'+tier+\'</div>\');}}'
    + '    else{p8Banner(\'Error: \'+(r.error||\'unknown\'),false);}'
    + '  });'
    + '}'

    + 'function p8Banner(msg,ok){'
    + '  var b=document.getElementById(\'p8-banner\');'
    + '  b.textContent=msg;b.style.display=\'\';'
    + '  b.style.background=ok?\'#e6f9ee\':\'#fff0f0\';'
    + '  b.style.color=ok?\'#1a7a3a\':\'#c0392b\';'
    + '  b.style.border=\'1px solid \'+(ok?\'#b2dfcb\':\'#f5c6c6\');'
    + '  setTimeout(function(){b.style.display=\'none\';},4000);'
    + '}'
    + '</script>';

  var body = '<h1 style="font-size:1.2rem;font-weight:700;color:#0f172a;margin-bottom:14px;">Pricing &amp; Tiers</h1>'
    + '<div id="p8-banner" style="display:none;padding:10px 14px;border-radius:8px;margin-bottom:12px;font-size:0.875rem;font-weight:500;"></div>'
    + tabNav
    + '<div id="p8tab-prices">' + pricesTab + '</div>'
    + '<div id="p8tab-tiers"  style="display:none;">' + tiersTab  + '</div>'
    + '<div id="p8tab-unknown" style="display:none;">' + unknownTab + '</div>'
    + script;

  res.send(page('Pricing & Tiers', body, req));
});

router.post('/settings/pricing/save-prices', requireAuth, express.json(), function(req, res) {
  var rows = req.body && req.body.services;
  if (!Array.isArray(rows)) return res.json({ ok: false, error: 'Invalid data' });
  var upsert = db.prepare(`INSERT INTO pricing_overrides
    (service_name, std_parts, std_labor, std_supplies, prem_parts, prem_labor, prem_supplies, minutes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(service_name) DO UPDATE SET
      std_parts=excluded.std_parts, std_labor=excluded.std_labor, std_supplies=excluded.std_supplies,
      prem_parts=excluded.prem_parts, prem_labor=excluded.prem_labor, prem_supplies=excluded.prem_supplies,
      minutes=excluded.minutes, updated_at=excluded.updated_at`);
  try {
    db.transaction(function(rs) {
      rs.forEach(function(s) {
        if (!s.name) return;
        upsert.run(s.name, +s.std_parts || 0, +s.std_labor || 0, +s.std_supplies || 0,
                   +s.prem_parts || 0, +s.prem_labor || 0, +s.prem_supplies || 0, +s.minutes || 60);
      });
    })(rows);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

router.post('/settings/pricing/add-mapping', requireAuth, express.json(), function(req, res) {
  var make  = (req.body.make  || '').trim();
  var model = (req.body.model || '').trim() || null;
  var tier  = req.body.tier;
  if (!make) return res.json({ ok: false, error: 'Make is required' });
  if (!['standard','premium','not_serviced'].includes(tier)) return res.json({ ok: false, error: 'Invalid tier' });
  try {
    var r = db.prepare('INSERT OR REPLACE INTO vehicle_tier_mappings (make, model, tier) VALUES (?, ?, ?)').run(make, model, tier);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});

router.post('/settings/pricing/delete-mapping', requireAuth, express.json(), function(req, res) {
  var id = +req.body.id;
  if (!id) return res.json({ ok: false, error: 'Invalid id' });
  try { db.prepare('DELETE FROM vehicle_tier_mappings WHERE id = ?').run(id); res.json({ ok: true }); }
  catch (err) { res.json({ ok: false, error: err.message }); }
});

router.post('/settings/pricing/classify-unknown', requireAuth, express.json(), function(req, res) {
  var id   = +req.body.id;
  var tier = req.body.tier;
  if (!['standard','premium','not_serviced'].includes(tier)) return res.json({ ok: false, error: 'Invalid tier' });
  try {
    db.prepare("UPDATE unknown_vehicles SET classified_tier=?, classified_at=datetime('now') WHERE id=?").run(tier, id);
    if (req.body.save_to_mappings) {
      var uv = db.prepare('SELECT make, model FROM unknown_vehicles WHERE id = ?').get(id);
      if (uv && uv.make) {
        db.prepare('INSERT OR REPLACE INTO vehicle_tier_mappings (make, model, tier) VALUES (?, ?, ?)').run(uv.make, uv.model || null, tier);
      }
    }
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, error: err.message }); }
});
router.get('/settings/templates', requireAuth, function(req, res) { placeholderPage(req, res, 'Templates', 'an upcoming phase'); });

module.exports = router;
