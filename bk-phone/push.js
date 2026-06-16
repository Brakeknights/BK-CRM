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

// Send a notification to every subscribed device. Fire-and-forget; never throws.
async function sendToAll(payload) {
  if (!ready) return;
  const data = JSON.stringify(payload);
  for (const s of dbm.listPushSubscriptions()) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        data
      );
    } catch (err) {
      // 404/410 = the device unsubscribed or expired, drop it.
      if (err.statusCode === 404 || err.statusCode === 410) {
        dbm.deletePushSubscription(s.endpoint);
      } else {
        console.warn('[push] send error:', err.statusCode || err.message);
      }
    }
  }
}

module.exports = {
  sendToAll,
  publicKey: PUBLIC,
  isReady: () => ready,
};
