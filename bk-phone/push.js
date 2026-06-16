// ===========================================================================
// bk-phone / push.js
// ---------------------------------------------------------------------------
// Sends browser push notifications (so your phone buzzes on a new text even
// when the app is closed). Uses the VAPID keys from the environment. If the
// keys aren't set, it stays quietly disabled, the rest of the app is unaffected.
// ===========================================================================

const webpush = require('web-push');
const dbm = require('./db');

const PUBLIC = (process.env.VAPID_PUBLIC_KEY || '').trim();
const PRIVATE = (process.env.VAPID_PRIVATE_KEY || '').trim();
const SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:greetings@brakeknights.com').trim();

let ready = false;
if (PUBLIC && PRIVATE) {
  try { webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE); ready = true; }
  catch (e) { console.warn('[push] VAPID setup failed:', e.message); }
} else {
  console.log('[push] VAPID keys not set, notifications disabled');
}

// Send a notification to every subscribed device. Returns a summary so callers
// (and the Settings "test" button) can see exactly what happened. Never throws.
async function sendToAll(payload) {
  if (!ready) return { ready: false, total: 0, sent: 0, failed: 0, errors: ['VAPID keys not configured on server'] };
  const subs = dbm.listPushSubscriptions();
  const data = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const errors = [];
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        data
      );
      sent++;
    } catch (err) {
      failed++;
      const detail = `${err.statusCode || '?'} ${(err.body || err.message || '').toString().slice(0, 140)}`;
      errors.push(detail);
      console.warn('[push] send error:', detail);
      // 404/410 = the device unsubscribed or expired, drop it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        dbm.deletePushSubscription(s.endpoint);
      }
    }
  }
  return { ready: true, total: subs.length, sent, failed, errors };
}

module.exports = {
  sendToAll,
  publicKey: PUBLIC,
  isReady: () => ready,
};
