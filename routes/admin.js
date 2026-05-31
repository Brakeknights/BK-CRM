const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
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
    new:       'background:#e3f0ff;color:#1a6fc4;',
    quoted:    'background:#fff8e1;color:#b8860b;',
    follow_up: 'background:#fce8ff;color:#8b2fc9;',
    booked:    'background:#e6f9ee;color:#1a7a3a;',
    completed: 'background:#f0f0f0;color:#555;',
  };
  const labels = { new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', booked: 'Booked', completed: 'Completed' };
  const style = styles[status] || styles.new;
  const label = labels[status] || status;
  return '<span style="' + style + 'padding:3px 10px;border-radius:20px;font-size:0.75rem;font-weight:700;letter-spacing:0.3px;white-space:nowrap;">' + label + '</span>';
}

function requireAuth(req, res, next) {
  if (req.session && req.session.adminAuthed) return next();
  res.redirect('/admin/login');
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;min-height:100vh;color:#1a2a3a}
.topbar{background:#0a1f3d;padding:13px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.topbar-brand{color:#c9a84c;font-weight:700;font-size:0.95rem;letter-spacing:.5px;display:flex;align-items:center;gap:8px;text-decoration:none}
.topbar-brand img{width:22px;height:22px;border-radius:4px}
.topbar-logout{color:#8aadcf;font-size:0.82rem;text-decoration:none}
.topbar-logout:hover{color:#fff}
.wrap{max-width:600px;margin:0 auto;padding:16px}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.section-title{font-size:0.95rem;font-weight:700;color:#0a1f3d;margin-bottom:14px}
.btn{display:block;width:100%;padding:12px;border:none;border-radius:8px;font-size:0.95rem;font-weight:600;cursor:pointer;text-align:center;text-decoration:none;transition:opacity .15s}
.btn:hover{opacity:.88}
.btn-navy{background:#0a1f3d;color:#fff}
.btn-gold{background:#c9a84c;color:#0a1f3d}
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
`;

function page(title, body, req) {
  var logoutLink = (req.session && req.session.adminAuthed)
    ? '<a href="/admin/logout" class="topbar-logout">Log out</a>'
    : '';
  return '<!DOCTYPE html><html lang="en"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<meta name="robots" content="noindex,nofollow">'
    + '<title>' + esc(title) + ' — BK Admin</title>'
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

// ─── Lead list ───────────────────────────────────────────────────────────────

router.get('/', requireAuth, function(req, res) {
  var status = req.query.status || 'all';

  var leads = status === 'all'
    ? db.prepare('SELECT * FROM leads ORDER BY id DESC').all()
    : db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY id DESC').all(status);

  var counts = db.prepare('SELECT status, COUNT(*) as n FROM leads GROUP BY status').all()
    .reduce(function(acc, r) { acc[r.status] = r.n; return acc; }, {});
  var total = db.prepare('SELECT COUNT(*) as n FROM leads').get().n;

  var tabs = [
    ['all',       'All',       total],
    ['new',       'New',       counts.new       || 0],
    ['quoted',    'Quoted',    counts.quoted    || 0],
    ['follow_up', 'Follow Up', counts.follow_up || 0],
    ['booked',    'Booked',    counts.booked    || 0],
    ['completed', 'Completed', counts.completed || 0],
  ];

  var tabsHtml = tabs.map(function(t) {
    var countBit = t[2] > 0 ? ' <span style="opacity:.65">(' + t[2] + ')</span>' : '';
    return '<a href="/admin?status=' + t[0] + '" class="filter-tab' + (status === t[0] ? ' active' : '') + '">'
      + t[1] + countBit + '</a>';
  }).join('');

  var alert = '';
  if (req.query.msg === 'sent')  alert = '<div class="alert alert-success">Quote sent successfully.</div>';
  if (req.query.msg === 'saved') alert = '<div class="alert alert-success">Quote saved. No email on file for this lead.</div>';
  if (req.query.msg === 'err')   alert = '<div class="alert alert-error">Failed to send quote email. Please try again.</div>';

  var cardsHtml = leads.length === 0
    ? '<div class="empty"><div style="font-size:2rem;margin-bottom:10px;">&#128203;</div>No leads' + (status !== 'all' ? ' in this category' : ' yet') + '.</div>'
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
          + '<div style="display:flex;gap:8px;margin-top:12px;">'
          + '<a href="tel:' + esc(l.phone) + '" class="btn btn-outline btn-sm" style="width:auto;">&#128222; Call</a>'
          + '<a href="/admin/quote/' + l.id + '" class="btn btn-navy" style="flex:1;padding:9px;">Open Quote Tool</a>'
          + '</div>'
          + '</div>';
      }).join('');

  res.send(page('Leads',
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">'
    + '<h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;">Leads</h1>'
    + '<span style="color:#aaa;font-size:0.83rem;">' + total + ' total</span>'
    + '</div>'
    + alert
    + '<div class="filter-tabs">' + tabsHtml + '</div>'
    + cardsHtml,
    req
  ));
});

// ─── Quote tool ───────────────────────────────────────────────────────────────

router.get('/quote/:id', requireAuth, function(req, res) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).send('Lead not found');

  var existing = db.prepare('SELECT * FROM quotes WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id);
  var q = existing || {};
  var currentService = q.service || lead.service || '';
  var currentTier    = q.tier || 'standard';
  var currentTaxRate = q.tax_rate != null ? +(q.tax_rate * 100).toFixed(2) : +(PRICING.taxRate * 100).toFixed(2);

  var serviceNames = Object.keys(PRICING.services);
  var serviceOptions = '<option value="" disabled' + (currentService === '' ? ' selected' : '') + '>Select a service...</option>'
    + serviceNames.map(function(s) {
        return '<option value="' + esc(s) + '"' + (currentService === s ? ' selected' : '') + '>' + esc(s) + '</option>';
      }).join('');

  var pricingJson = JSON.stringify(PRICING.services);
  var noEmail = !lead.email;

  var body = '<a href="/admin" class="back-link">&#8592; All Leads</a>'

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
    + '</div></div>'

    // Quote form
    + '<form method="POST" action="/admin/quote/' + lead.id + '/send" id="qf">'
    + '<div class="card">'
    + '<div class="section-title">Build Quote</div>'

    + '<div class="form-group"><label>Service</label>'
    + '<select name="service" id="svc" onchange="updatePrices()">' + serviceOptions + '</select></div>'

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
    + '<button type="submit" class="btn btn-gold" style="margin-top:10px;">Send Quote</button>'
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

    + 'function updatePrices(){'
    +   'var svc=document.getElementById("svc").value;'
    +   'if(!svc||!PRICING[svc])return;'
    +   'var p=PRICING[svc][tier];'
    +   'if(!p)return;'
    +   'document.getElementById("parts").value=p.parts.toFixed(2);'
    +   'document.getElementById("labor").value=p.labor.toFixed(2);'
    +   'document.getElementById("ss").value=p.shopSupplies.toFixed(2);'
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
    +   'var svc=document.getElementById("svc").value||"(not set)";'
    +   'var parts=parseFloat(document.getElementById("parts").value)||0;'
    +   'var labor=parseFloat(document.getElementById("labor").value)||0;'
    +   'var ss=parseFloat(document.getElementById("ss").value)||0;'
    +   'var tax=parseFloat(document.getElementById("taxH").value)||0;'
    +   'var tot=parseFloat(document.getElementById("totalH").value)||0;'
    +   'var tierLabel=tier.charAt(0).toUpperCase()+tier.slice(1);'
    +   'var veh=vehicle?" on your <strong>"+vehicle+"</strong>":"";'
    +   'var toLine=leadEmail||"<em style=\'color:#e07000\'>(no email on file)</em>";'
    +   'box.innerHTML='
    +     '"<div class=\'preview-box\'>"'
    +     '+"<h4>Email Preview</h4>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:4px;\'>To: "+toLine+"</div>"'
    +     '+"<div style=\'font-size:0.82rem;color:#888;margin-bottom:8px;\'>Subject: Your Brake Service Quote — Brake Knights</div>"'
    +     '+"<hr class=\'preview-divider\'>"'
    +     '+"<p>Greetings "+firstName+",</p>"'
    +     '+"<p style=\'margin-top:8px;\'>Here is your <strong>"+tierLabel+"</strong> quote for <strong>"+svc+"</strong>"+veh+":</p>"'
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

  db.prepare(
    'INSERT INTO quotes (lead_id, service, tier, price_parts, price_labor, shop_supplies, tax_rate, tax, total, vin, internal_notes, sent_at, status) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime(\'now\'),?)'
  ).run(lead.id, service, tier, parts, labor, shopSupplies, taxRate / 100, taxAmt, totalAmt, vin, internalNotes, lead.email ? 'sent' : 'saved');

  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run('quoted', lead.id);

  if (!lead.email) return res.redirect('/admin?msg=saved');

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
      html:    buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, taxAmt, totalAmt)
    });

    res.redirect('/admin?msg=sent');
  } catch (err) {
    console.error('Quote email error:', err.message);
    res.redirect('/admin?msg=err');
  }
});

// ─── Quote email (Phase 3C upgrades this to fully branded template) ───────────

function buildQuoteEmail(lead, service, tier, parts, labor, shopSupplies, tax, total) {
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
    + '<p style="font-weight:700;color:#0a1f3d;margin:0 0 4px;font-size:0.82rem;text-transform:uppercase;letter-spacing:.5px;">Service</p>'
    + '<p style="color:#1a2a3a;font-size:1rem;font-weight:600;margin:0 0 16px;">' + esc(service) + '</p>'
    + '<table style="width:100%;border-collapse:collapse;font-size:0.9rem;color:#444;">'
    + '<tr><td style="padding:6px 0;">Parts &amp; Labor</td><td style="text-align:right;">$' + partsLabor.toFixed(2) + '</td></tr>'
    + '<tr><td style="padding:6px 0;">Shop Supplies</td><td style="text-align:right;">$' + shopSupplies.toFixed(2) + '</td></tr>'
    + '<tr><td style="padding:6px 0;color:#888;">Tax</td><td style="text-align:right;color:#888;">$' + tax.toFixed(2) + '</td></tr>'
    + '<tr style="border-top:2px solid #dde3ea;"><td style="padding:10px 0 0;font-weight:700;font-size:1rem;color:#0a1f3d;">Total</td>'
    + '<td style="text-align:right;padding:10px 0 0;font-weight:700;font-size:1.1rem;color:#0a1f3d;">$' + total.toFixed(2) + '</td></tr>'
    + '</table></div>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 12px;font-size:0.9rem;">This quote includes all parts and labor. All qualifying pad and rotor replacements come with a <strong>12-month / 12,000-mile warranty</strong> on parts and labor.</p>'
    + '<p style="color:#444;line-height:1.6;margin:0 0 24px;font-size:0.9rem;">Our service is fully mobile. We come directly to your home or office. No shop visit needed.</p>'
    + '<div style="background:#0a1f3d;border-radius:8px;padding:20px;text-align:center;">'
    + '<p style="color:#fff;font-weight:700;margin:0 0 8px;font-size:0.95rem;">Ready to book? Reply to this email or call/text:</p>'
    + '<a href="tel:7039774475" style="color:#c9a84c;font-size:1.2rem;font-weight:700;text-decoration:none;">703-977-4475</a>'
    + '</div></div>'
    + '<div style="text-align:center;padding:16px;color:#aaa;font-size:0.78rem;">Brake Knights &middot; Sterling, VA &middot; brakeknights.com</div>'
    + '</div>';
}

module.exports = router;
