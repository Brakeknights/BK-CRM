// Phase 7B — Customer records.
//
// A "customer" is the real person behind one or more leads. Leads still hold the
// per-inquiry detail; a customer row groups them so the owner sees one profile
// with full history, vehicles, saved addresses, notes, tags, and lifetime stats.
//
// Matching is by email first, then phone (both normalized). All DB calls are
// synchronous better-sqlite3 calls, matching the rest of the codebase.
//
// NOTE: this module requires ../db, which sets module.exports = db BEFORE it
// requires this file and runs the backfill, so there is no circular-require gap.

const db = require('./db');

const TAGS = ['Repeat Customer', 'Fleet', 'Referred', 'VIP'];

function normEmail(e) {
  return e ? String(e).trim().toLowerCase() : '';
}

// Digits only, so "703-555-0123", "(703) 555 0123", "+17035550123" all compare.
function normPhone(p) {
  if (!p) return '';
  var d = String(p).replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); // drop US country code
  return d;
}

// Find an existing customer by email (exact, case-insensitive) then by phone
// (digits-only). Returns the customer row or null.
function findCustomer(email, phone) {
  var ne = normEmail(email);
  if (ne) {
    var byEmail = db.prepare(
      "SELECT * FROM customers WHERE email IS NOT NULL AND email != '' AND lower(trim(email)) = ? ORDER BY id LIMIT 1"
    ).get(ne);
    if (byEmail) return byEmail;
  }
  var np = normPhone(phone);
  if (np) {
    var rows = db.prepare("SELECT * FROM customers WHERE phone IS NOT NULL AND phone != ''").all();
    for (var i = 0; i < rows.length; i++) {
      if (normPhone(rows[i].phone) === np) return rows[i];
    }
  }
  return null;
}

function createCustomer(c) {
  return db.prepare(
    "INSERT INTO customers (first_name, last_name, email, phone, square_customer_id) VALUES (?,?,?,?,?)"
  ).run(
    (c.first_name || '').trim(),
    (c.last_name || '').trim(),
    (c.email || '').trim() || null,
    (c.phone || '').trim() || null,
    c.square_customer_id || null
  ).lastInsertRowid;
}

// Returns the customer id for a lead-shaped object {first_name,last_name,email,
// phone,square_customer_id}. Links to an existing customer when email or phone
// matches, otherwise creates a new customer. When linking, backfills any contact
// fields the existing customer was missing.
function findOrCreateForLead(lead) {
  var existing = findCustomer(lead.email, lead.phone);
  if (existing) {
    var sets = [], vals = [];
    if (!existing.email && (lead.email || '').trim()) { sets.push('email = ?'); vals.push(lead.email.trim()); }
    if (!existing.phone && (lead.phone || '').trim()) { sets.push('phone = ?'); vals.push(lead.phone.trim()); }
    if (!existing.square_customer_id && lead.square_customer_id) { sets.push('square_customer_id = ?'); vals.push(lead.square_customer_id); }
    if (sets.length) {
      vals.push(existing.id);
      var stmt = db.prepare('UPDATE customers SET ' + sets.join(', ') + ' WHERE id = ?');
      stmt.run.apply(stmt, vals);
    }
    return existing.id;
  }
  return createCustomer(lead);
}

// Inserts the lead, then links it to a customer, in one step. Used by the live
// lead-creation paths (contact form, Quick Quote). Returns { leadId, customerId }.
function linkLead(leadId) {
  var lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead) return null;
  var customerId = findOrCreateForLead(lead);
  db.prepare('UPDATE leads SET customer_id = ? WHERE id = ?').run(customerId, leadId);
  return customerId;
}

// When the Square sync resolves a customer id later, propagate it to the linked
// customer record if it doesn't already have one.
function attachSquareId(customerId, squareCustomerId) {
  if (!customerId || !squareCustomerId) return;
  db.prepare(
    "UPDATE customers SET square_customer_id = ? WHERE id = ? AND (square_customer_id IS NULL OR square_customer_id = '')"
  ).run(squareCustomerId, customerId);
}

// Lifetime stats for one customer, computed from their leads + receipts.
//   jobCount       — number of leads (inquiries/jobs) tied to this customer
//   completedCount — leads that have a sent receipt (paid/finished jobs)
//   quotedCount    — leads that ever received a quote
//   revenue        — sum of sent-receipt totals
//   avgJobValue    — revenue / completedCount
//   conversionRate — completedCount / quotedCount, as a 0-100 percent
//   firstLeadDate  — earliest lead created_at
//   firstPaidDate  — earliest sent receipt
//   lastLeadDate   — most recent lead created_at
//   lastJobDate    — most recent sent-receipt service_date
function statsFor(customerId) {
  var lead = db.prepare(
    "SELECT COUNT(*) AS jobs, MIN(created_at) AS firstLead, MAX(created_at) AS lastLead FROM leads WHERE customer_id = ?"
  ).get(customerId);
  var rev = db.prepare(
    "SELECT COALESCE(SUM(r.total),0) AS revenue, COUNT(*) AS paidJobs, MIN(r.sent_at) AS firstPaid, MAX(r.service_date) AS lastJob "
    + "FROM receipts r JOIN leads l ON l.id = r.lead_id WHERE l.customer_id = ? AND r.sent_at IS NOT NULL"
  ).get(customerId);
  var quoted = db.prepare(
    "SELECT COUNT(DISTINCT l.id) AS n FROM leads l JOIN quotes q ON q.lead_id = l.id WHERE l.customer_id = ?"
  ).get(customerId).n;
  var revenue = rev.revenue || 0;
  var paidJobs = rev.paidJobs || 0;
  return {
    jobCount:       lead.jobs || 0,
    completedCount: paidJobs,
    quotedCount:    quoted,
    revenue:        revenue,
    avgJobValue:    paidJobs ? revenue / paidJobs : 0,
    conversionRate: quoted ? Math.round((paidJobs / quoted) * 100) : 0,
    firstLeadDate:  lead.firstLead || null,
    firstPaidDate:  rev.firstPaid || null,
    lastLeadDate:   lead.lastLead || null,
    lastJobDate:    rev.lastJob || null
  };
}

// One-time (idempotent) backfill: every lead with no customer_id gets grouped
// into a customer by email, then phone. Safe to run on every boot — it only
// touches leads that are still unlinked, so once a lead is linked it's skipped.
function runBackfill() {
  var unlinked = db.prepare('SELECT * FROM leads WHERE customer_id IS NULL ORDER BY id ASC').all();
  if (!unlinked.length) return;
  var tx = db.transaction(function() {
    unlinked.forEach(function(l) {
      var cid = findOrCreateForLead(l);
      db.prepare('UPDATE leads SET customer_id = ? WHERE id = ?').run(cid, l.id);
    });
  });
  tx();
  console.log('[customers] backfilled ' + unlinked.length + ' lead(s) into customer records');
}

module.exports = {
  TAGS,
  normEmail,
  normPhone,
  findCustomer,
  findOrCreateForLead,
  linkLead,
  attachSquareId,
  statsFor,
  runBackfill
};
