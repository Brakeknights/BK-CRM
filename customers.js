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

// Save contact/address/vehicle details entered on ANY form back to the customer
// record, so data stays unified across the whole dashboard (enter it once, it
// shows everywhere). Non-destructive by design:
//   • phone/email — filled only when the customer is missing it (never clobbered)
//   • address     — added to the saved-address list (deduped); set as the primary
//                   home_address only when none is on file yet
//   • vehicle     — added to customer_vehicles (deduped by year/make/model); VIN /
//                   plate backfilled onto a matching row when newly provided
// `data` = { phone, email, address, vehicle:{year,make,model,vin,license_plate} }.
function syncCustomerData(customerId, data) {
  if (!customerId || !data) return;
  var c = db.prepare('SELECT id, phone, email, home_address FROM customers WHERE id = ?').get(customerId);
  if (!c) return;

  var sets = [], vals = [];
  var phone = (data.phone || '').trim();
  var email = (data.email || '').trim();
  if (!(c.phone || '').trim() && phone) { sets.push('phone = ?'); vals.push(phone); }
  if (!(c.email || '').trim() && email) { sets.push('email = ?'); vals.push(email); }

  var addr = (data.address || '').trim();
  if (addr) {
    if (!(c.home_address || '').trim()) { sets.push('home_address = ?'); vals.push(addr); }
    var existsAddr = db.prepare(
      "SELECT id FROM customer_addresses WHERE customer_id = ? AND LOWER(TRIM(address)) = LOWER(?)"
    ).get(customerId, addr);
    if (!existsAddr) {
      db.prepare('INSERT INTO customer_addresses (customer_id, label, address) VALUES (?,?,?)')
        .run(customerId, null, addr);
    }
  }

  if (sets.length) {
    vals.push(customerId);
    var stmt = db.prepare('UPDATE customers SET ' + sets.join(', ') + ' WHERE id = ?');
    stmt.run.apply(stmt, vals);
  }

  var v = data.vehicle || {};
  var vYear  = (v.year  || '').trim();
  var vMake  = (v.make  || '').trim();
  var vModel = (v.model || '').trim();
  var vVin   = (v.vin   || '').trim();
  var vPlate = (v.license_plate || v.plate || '').trim();
  if (vMake || vModel || vVin || vPlate) {
    var dupe = db.prepare(
      "SELECT id FROM customer_vehicles WHERE customer_id = ? AND IFNULL(year,'')=? AND IFNULL(make,'')=? AND IFNULL(model,'')=?"
    ).get(customerId, vYear, vMake, vModel);
    if (!dupe) {
      db.prepare('INSERT INTO customer_vehicles (customer_id, year, make, model, vin, license_plate) VALUES (?,?,?,?,?,?)')
        .run(customerId, vYear || null, vMake || null, vModel || null, vVin || null, vPlate || null);
    } else if (vVin || vPlate) {
      db.prepare("UPDATE customer_vehicles SET vin = COALESCE(NULLIF(?,''),vin), license_plate = COALESCE(NULLIF(?,''),license_plate) WHERE id = ?")
        .run(vVin, vPlate, dupe.id);
    }
  }
}

// Lifetime stats for one customer, computed from their leads + receipts.
//   leadCount      — total leads (all inquiries) tied to this customer
//   quotesSent     — leads that have had a quote actually sent to the customer
//   completedCount — leads with a sent receipt (finished/paid jobs) = "jobs"
//   revenue        — sum of sent-receipt totals
//   avgJobValue    — revenue / completedCount
//   conversionRate — completedCount / quotesSent, as a 0-100 percent
//   firstLeadDate  — earliest lead created_at
//   firstPaidDate  — earliest sent receipt
//   lastLeadDate   — most recent lead created_at
//   lastJobDate    — most recent sent-receipt service_date
function statsFor(customerId) {
  var lead = db.prepare(
    "SELECT COUNT(*) AS leads, MIN(created_at) AS firstLead, MAX(created_at) AS lastLead FROM leads WHERE customer_id = ?"
  ).get(customerId);
  var rev = db.prepare(
    "SELECT COALESCE(SUM(r.total),0) AS revenue, COUNT(*) AS paidJobs, MIN(r.sent_at) AS firstPaid, MAX(r.service_date) AS lastJob "
    + "FROM receipts r JOIN leads l ON l.id = r.lead_id WHERE l.customer_id = ? AND r.sent_at IS NOT NULL"
  ).get(customerId);
  // Quotes that were actually sent (sent_at set), counted once per lead.
  var quotesSent = db.prepare(
    "SELECT COUNT(DISTINCT l.id) AS n FROM leads l JOIN quotes q ON q.lead_id = l.id WHERE l.customer_id = ? AND q.sent_at IS NOT NULL"
  ).get(customerId).n;
  var revenue = rev.revenue || 0;
  var paidJobs = rev.paidJobs || 0;
  return {
    leadCount:      lead.leads || 0,
    quotesSent:     quotesSent,
    completedCount: paidJobs,
    revenue:        revenue,
    avgJobValue:    paidJobs ? revenue / paidJobs : 0,
    conversionRate: quotesSent ? Math.round((paidJobs / quotesSent) * 100) : 0,
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
  createCustomer,
  findOrCreateForLead,
  linkLead,
  attachSquareId,
  syncCustomerData,
  statsFor,
  runBackfill
};
