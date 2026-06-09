// Square customer sync — shared by the admin manual importer (routes/admin.js)
// and the background auto-sync cron (server.js).
//
// processSquareCustomer upserts one Square customer into the CRM, deduping by
// email then phone so re-runs never create duplicates. syncAllSquareCustomers
// paginates the whole Square account and imports any new contacts; it runs
// server-side (no HTTP proxy timeout), so it can page through everything in one
// pass, unlike the client-driven manual import.

const db = require('./db');
const customers = require('./customers');
const { client: squareClient } = require('./square');

// Upserts one Square customer. Returns 'imported', 'linked', or 'skipped'.
function processSquareCustomer(sc) {
  var sqEmail = (sc.emailAddress || '').trim() || null;
  var sqPhone = (sc.phoneNumber  || '').trim() || null;
  var sqFirst = (sc.givenName    || '').trim();
  var sqLast  = (sc.familyName   || '').trim();

  if (!sqFirst && !sqLast && !sqEmail && !sqPhone) return 'skipped';

  var existing = customers.findCustomer(sqEmail, sqPhone);
  if (existing) {
    var sets = [], vals = [];
    if (!existing.square_customer_id && sc.id)  { sets.push('square_customer_id = ?'); vals.push(sc.id); }
    if (!existing.email && sqEmail)              { sets.push('email = ?');              vals.push(sqEmail); }
    if (!existing.phone && sqPhone)              { sets.push('phone = ?');              vals.push(sqPhone); }
    if (!existing.first_name && sqFirst)         { sets.push('first_name = ?');         vals.push(sqFirst); }
    if (!existing.last_name  && sqLast)          { sets.push('last_name = ?');          vals.push(sqLast); }
    if (sets.length) {
      vals.push(existing.id);
      var stmt = db.prepare('UPDATE customers SET ' + sets.join(', ') + ' WHERE id = ?');
      stmt.run.apply(stmt, vals);
    }
    return 'linked';
  }
  customers.createCustomer({
    first_name: sqFirst, last_name: sqLast, email: sqEmail, phone: sqPhone,
    square_customer_id: sc.id || null
  });
  return 'imported';
}

// Paginates the entire Square account and imports any new customers. Returns
// counts. Safe to run repeatedly: dedup skips anyone already in the CRM.
async function syncAllSquareCustomers() {
  var imported = 0, linked = 0, skipped = 0, errors = 0;
  var cursor = null;
  var pages = 0;
  do {
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
        console.error('[square-sync] row error:', rowErr.message);
        errors++;
      }
    }
    cursor = (resp && resp.cursor) || null;
    pages++;
  } while (cursor && pages < 100); // hard page cap as a safety stop
  return { imported: imported, linked: linked, skipped: skipped, errors: errors };
}

module.exports = { processSquareCustomer, syncAllSquareCustomers };
