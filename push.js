// Shared browser-push helper. Used by server.js (new-lead + Square alerts) and
// routes/admin.js (pipeline stage-change alerts) so the webpush wiring lives in
// one place. VAPID keys come from env; with no keys set, every call is a no-op.
const webpush = require('web-push');
const db = require('./db');

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:greetings@brakeknights.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// Sends a browser push to every registered admin device. Generic so new leads,
// Square sync alerts, and stage changes can all reuse it.
function sendPush(title, body, url) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  var subs = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!subs.length) return;
  // Push subscriptions are per-domain, so a dev-subscribed device only ever gets
  // dev pushes and a live device only gets live pushes; no prefix needed.
  var payload = JSON.stringify({ title: title, body: body, url: url || '/admin' });
  subs.forEach(function(row) {
    var sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    webpush.sendNotification(sub, payload).catch(function(err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id);
      } else {
        console.error('Push send error:', err.message);
      }
    });
  });
}

function sendNewLeadPush(lead) {
  var name = lead.first_name + ' ' + lead.last_name;
  var body = [lead.service, lead.vehicle].filter(Boolean).join(' — ') || lead.phone;
  sendPush('New Lead: ' + name, body, '/admin?status=new');
}

// Human-readable pipeline stage labels, shared so push + email + history all match.
var STAGE_LABELS = {
  new: 'New', quoted: 'Quoted', follow_up: 'Follow Up', quote_accepted: 'Quote Accepted',
  approved: 'Approved', booked: 'Booked', completed: 'Completed', receipt: 'Receipt Sent'
};

// Fires a push when a lead advances (or moves) to a new pipeline stage.
function sendStagePush(lead, newStatus) {
  var name = lead.first_name + ' ' + lead.last_name;
  var label = STAGE_LABELS[newStatus] || newStatus;
  var body = [name, lead.service].filter(Boolean).join(' — ');
  sendPush('Lead → ' + label, body, '/admin/quote/' + lead.id);
}

module.exports = { sendPush, sendNewLeadPush, sendStagePush, STAGE_LABELS };
