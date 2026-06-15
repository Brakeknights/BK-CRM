// ===========================================================================
// bk-phone / telnyx.js
// ---------------------------------------------------------------------------
// The connection to Telnyx (the company that owns your phone number and moves
// the actual texts/calls). This file does two jobs:
//
//   1. sendSms()        - send a text message out through your Telnyx number.
//   2. verifyWebhook()  - prove an INCOMING text really came from Telnyx and
//                         not from a stranger faking a request to our app.
//                         (Customer-data protection is rule #1, so we never
//                         trust an incoming webhook until we've checked this.)
//
// We talk to Telnyx using Node's built-in web request tool (fetch), so there's
// no extra software package to install or keep updated.
// ===========================================================================

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Settings, all read from environment variables (.env). Nothing secret is ever
// written into the code itself.
// ---------------------------------------------------------------------------
// .trim() on every value guards against stray spaces/newlines pasted into the
// hosting panel's environment-variable fields.
const TELNYX_API_KEY = (process.env.TELNYX_API_KEY || '').trim();
// Your Brake Knights number that texts are sent from (E.164, e.g. +17034230486).
const TELNYX_NUMBER = (process.env.TELNYX_NUMBER || process.env.TELNYX_PHONE_NUMBER || '').trim();
// The Messaging Profile your number is attached to.
const TELNYX_MESSAGING_PROFILE_ID = (process.env.TELNYX_MESSAGING_PROFILE_ID || '').trim();
// Telnyx's public key, used only to verify incoming webhooks. Optional for now;
// you'll paste it into .env when you grab it from the portal.
const TELNYX_PUBLIC_KEY = (process.env.TELNYX_PUBLIC_KEY || '').trim();

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';

// ---------------------------------------------------------------------------
// Phone number tidy-up.
// Telnyx requires E.164 format: a "+", country code, then the number, no spaces
// or dashes (e.g. +15715551234). Customers won't type it that way, so we clean
// whatever we're given into that shape before sending.
// ---------------------------------------------------------------------------
function toE164(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/\D/g, '');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;            // US 10-digit
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits; // 1 + 10
  return '+' + digits; // fall back: assume already has a country code
}

// ---------------------------------------------------------------------------
// Send a text message.
// Returns a plain result object instead of throwing, so the rest of the app can
// react calmly:  { ok: true, id, status }  or  { ok: false, error }
// ---------------------------------------------------------------------------
async function sendSms({ to, text }) {
  if (!TELNYX_API_KEY) return { ok: false, error: 'TELNYX_API_KEY not set' };
  if (!TELNYX_NUMBER)  return { ok: false, error: 'TELNYX_NUMBER not set' };

  const toNumber = toE164(to);
  if (!toNumber || toNumber.length < 8) {
    return { ok: false, error: 'Invalid destination number' };
  }

  // What we send to Telnyx. Including the messaging profile id when we have it.
  const payload = {
    from: TELNYX_NUMBER,
    to: toNumber,
    text: text != null ? String(text) : '',
  };
  if (TELNYX_MESSAGING_PROFILE_ID) {
    payload.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;
  }

  try {
    const res = await fetch(`${TELNYX_API_BASE}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      // Telnyx returns a list of errors; surface the first readable one.
      const detail = data?.errors?.[0]?.detail
        || data?.errors?.[0]?.title
        || `Telnyx HTTP ${res.status}`;
      return { ok: false, error: detail, status: res.status };
    }

    return {
      ok: true,
      id: data?.data?.id || null,            // Telnyx's id for this message
      status: data?.data?.to?.[0]?.status    // queued / sending / etc.
        || data?.data?.status
        || 'queued',
    };
  } catch (err) {
    // Network problem, Telnyx down, etc. Never let it crash the app.
    return { ok: false, error: err.message || 'Network error contacting Telnyx' };
  }
}

// ---------------------------------------------------------------------------
// Verify an incoming webhook is genuinely from Telnyx.
//
// Telnyx signs every webhook. It sends two headers:
//   telnyx-signature-ed25519  (the signature)
//   telnyx-timestamp          (when it was signed)
// The signed content is exactly:  `${timestamp}|${rawBody}`
// We check that signature against Telnyx's public key. If it matches, the
// request is authentic and untampered. If not, we reject it.
//
// Returns true (authentic) or false (reject). If no public key is configured
// yet, it returns false and logs a warning, so we fail safe rather than trust
// blindly. (During early local testing you can set TELNYX_SKIP_VERIFY=1 to
// bypass this; never do that in production.)
// ---------------------------------------------------------------------------
function verifyWebhook(rawBody, signatureB64, timestamp, toleranceSeconds = 300) {
  if (process.env.TELNYX_SKIP_VERIFY === '1') return true; // local testing only

  if (!TELNYX_PUBLIC_KEY) {
    console.warn('[telnyx] TELNYX_PUBLIC_KEY not set, rejecting webhook for safety');
    return false;
  }
  if (!signatureB64 || !timestamp) return false;

  // Reject very old requests (guards against someone replaying a captured one).
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    console.warn('[telnyx] webhook timestamp outside tolerance, rejecting');
    return false;
  }

  try {
    const signedPayload = Buffer.from(`${timestamp}|${rawBody}`, 'utf8');
    const signature = Buffer.from(signatureB64, 'base64');

    // Telnyx gives the public key as a base64 raw ed25519 key (32 bytes). Node's
    // crypto needs it wrapped in a standard "SPKI" envelope, so we prepend the
    // fixed header bytes that identify it as an ed25519 public key.
    const rawKey = Buffer.from(TELNYX_PUBLIC_KEY, 'base64');
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const der = Buffer.concat([spkiPrefix, rawKey]);
    const publicKey = crypto.createPublicKey({
      key: der,
      format: 'der',
      type: 'spki',
    });

    // ed25519 verification (algorithm arg is null for this key type).
    return crypto.verify(null, signedPayload, publicKey, signature);
  } catch (err) {
    console.warn('[telnyx] webhook verification error:', err.message);
    return false;
  }
}

module.exports = {
  sendSms,
  verifyWebhook,
  toE164,
  TELNYX_NUMBER,
};
