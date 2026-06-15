// ===========================================================================
// bk-phone / crm.js
// ---------------------------------------------------------------------------
// Read-only bridge to the Brake Knights CRM. Given a phone number, it finds the
// matching customer so the phone app can show their NAME and a one-tap link to
// their full CRM profile.
//
// SAFETY: every query here is a SELECT. This file never inserts, updates, or
// deletes anything in the CRM's tables. Phone matching ignores formatting by
// comparing the last 10 digits, so "+15715551234", "(571) 555-1234", and
// "571.555.1234" all match the same customer.
// ===========================================================================

const { db } = require('./db');

// Where the CRM lives, so we can build a tappable profile link. Defaults to the
// live site; set CRM_BASE_URL=https://dev.brakeknights.com on the dev app.
const CRM_BASE_URL = (process.env.CRM_BASE_URL || 'https://brakeknights.com').replace(/\/$/, '');

// Last 10 digits of any phone format.
function last10(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

// SQL snippet that strips common separators from a stored phone column so we can
// compare just the digits.
const STRIP = "replace(replace(replace(replace(replace(replace(phone,'-',''),' ',''),'(',''),')',''),'+',''),'.','')";

// Prepare the lookups lazily so the phone app never crashes if it happens to
// open the database before the CRM has created its tables. Once prepared, the
// statements are cached.
let _stmts = null;
function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function stmts() {
  if (_stmts) return _stmts;
  if (!tableExists('customers') || !tableExists('leads')) return null; // CRM not ready
  _stmts = {
    findCustomer: db.prepare(
      `SELECT id, first_name, last_name FROM customers WHERE ${STRIP} LIKE '%' || ? ORDER BY id LIMIT 1`
    ),
    findLead: db.prepare(
      `SELECT first_name, last_name, customer_id FROM leads WHERE ${STRIP} LIKE '%' || ? ORDER BY id DESC LIMIT 1`
    ),
  };
  return _stmts;
}

function fullName(first, last) {
  return [first, last].filter(s => s && s.trim()).join(' ').trim() || null;
}

function profileUrl(customerId) {
  return customerId ? `${CRM_BASE_URL}/admin/customer/${customerId}` : null;
}

// Look up a phone number. Returns:
//   { name, customerId, profileUrl }   when matched
//   null                               when no match (unknown number)
function lookupByPhone(phone) {
  const digits = last10(phone);
  if (digits.length < 10) return null;

  const s = stmts();
  if (!s) return null; // CRM tables not present, treat as unknown number

  // 1) Prefer a real customer record (has a profile page).
  const c = s.findCustomer.get(digits);
  if (c) {
    return { name: fullName(c.first_name, c.last_name), customerId: c.id, profileUrl: profileUrl(c.id) };
  }

  // 2) Fall back to a lead. It may already be linked to a customer profile.
  const l = s.findLead.get(digits);
  if (l) {
    return {
      name: fullName(l.first_name, l.last_name),
      customerId: l.customer_id || null,
      profileUrl: profileUrl(l.customer_id),
    };
  }

  return null;
}

module.exports = { lookupByPhone, CRM_BASE_URL };
