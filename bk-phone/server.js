// ===========================================================================
// bk-phone / server.js
// ---------------------------------------------------------------------------
// The "engine" that starts the phone app. It:
//   - applies site-wide security headers
//   - keeps a copy of each incoming request's raw text (needed to verify that
//     inbound Telnyx webhooks are genuine)
//   - puts the whole app behind a password (so only you can read customer
//     conversations) while leaving the Telnyx webhook publicly reachable
//   - serves the app's screens and connects the SMS routes
//   - refuses to boot in production without a strong password + secret
//
// Runs on its OWN port (default 3001), separate from the CRM. It's a standalone
// app with its own web address; it just happens to live on the same machine.
// ===========================================================================

// Load .env if the dotenv helper is available (optional; Hostinger sets env
// vars directly in production, so we don't hard-require it).
try { require('dotenv').config(); } catch (_) { /* dotenv not installed: fine */ }

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// --- Auth settings ---------------------------------------------------------
// .trim() guards against stray spaces/newlines accidentally pasted into the
// hosting panel's environment-variable fields (a very common gotcha).
const PHONE_PASSWORD = (process.env.PHONE_PASSWORD || '').trim();
const SESSION_SECRET = (process.env.PHONE_SESSION_SECRET || '').trim();
const AUTH_COOKIE = 'bkp_auth';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------------------------------------------------------------------------
// Production safety guard (rule #1).
// In production we will NOT start without a real password and a real secret.
// This is the same "refuse to boot on weak/missing secrets" guard the CRM uses,
// so an unprotected app with customer data can never go live by accident.
// ---------------------------------------------------------------------------
if (isProd) {
  const weak = (v) => !v || v.length < 12 ||
    ['password', 'changeme', 'admin', 'brakeknights'].includes(v.toLowerCase());
  if (weak(PHONE_PASSWORD)) {
    console.error('[bk-phone] FATAL: PHONE_PASSWORD missing or too weak in production.');
    process.exit(1);
  }
  if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
    console.error('[bk-phone] FATAL: PHONE_SESSION_SECRET missing or too short in production.');
    process.exit(1);
  }
  app.set('trust proxy', 1); // behind Hostinger's proxy, so "secure" cookies work
}

// ---------------------------------------------------------------------------
// Security headers on every response (same set the CRM applies).
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (isProd) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ---------------------------------------------------------------------------
// Parse JSON request bodies AND keep the original raw text. We need the raw
// text exactly as Telnyx sent it to verify the webhook signature; once JSON is
// re-stringified the spacing can change and the signature won't match.
// ---------------------------------------------------------------------------
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(express.urlencoded({ extended: false }));

// ===========================================================================
// Simple, dependency-free password gate.
// On correct login we set a signed cookie. Each request re-checks the cookie's
// signature, so the password is never stored in the browser and the cookie
// can't be forged without the secret.
// ===========================================================================

// Read one cookie value out of the Cookie header.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Create a tamper-proof login token: "<issuedAt>.<signature>".
function signToken(issuedAt) {
  const sig = crypto.createHmac('sha256', SESSION_SECRET)
    .update(String(issuedAt)).digest('hex');
  return `${issuedAt}.${sig}`;
}

// Check a token is genuine and not expired.
function validToken(token) {
  if (!token || !SESSION_SECRET) return false;
  const [issuedAt, sig] = token.split('.');
  if (!issuedAt || !sig) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET)
    .update(String(issuedAt)).digest('hex');
  // constant-time compare so timing can't be used to guess the signature
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (Date.now() - Number(issuedAt) > COOKIE_MAX_AGE_MS) return false;
  return true;
}

// Gate: anything wrapped in this requires a valid login cookie.
function requireAuth(req, res, next) {
  if (validToken(readCookie(req, AUTH_COOKIE))) return next();
  // For page requests, send them to the login screen; for API calls, 401.
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'Not authenticated' });
}

// Login screen (minimal for now; we'll style it with the rest of the UI later).
app.get('/login', (req, res) => {
  if (validToken(readCookie(req, AUTH_COOKIE))) return res.redirect('/');
  const err = req.query.e ? '<p style="color:#c00">Incorrect password</p>' : '';
  res.set('Content-Type', 'text/html').send(`<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Brake Knights Phone</title></head>
<body style="font-family:system-ui;max-width:360px;margin:18vh auto;padding:0 20px">
<h2>Brake Knights Phone</h2>${err}
<form method="POST" action="/login">
  <input type="password" name="password" placeholder="Password" autofocus
    style="width:100%;padding:12px;font-size:16px;box-sizing:border-box">
  <button type="submit" style="width:100%;padding:12px;font-size:16px;margin-top:10px">
    Sign in</button>
</form></body></html>`);
});

// Handle login. Constant-time password check, then set the signed cookie.
app.post('/login', (req, res) => {
  const given = String(req.body.password || '').trim();
  const expected = PHONE_PASSWORD;
  let ok = false;
  if (expected && given.length === expected.length) {
    ok = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }
  if (!ok) return res.redirect('/login?e=1');

  const token = signToken(Date.now());
  // Set the cookie directly via the header (no cookie-parser dependency needed).
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; ` +
    `Path=/; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}` +
    (isProd ? '; Secure' : ''));
  res.redirect('/');
});

// Logout clears the cookie.
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Public static assets (no customer data lives in these: stylesheet, client
// scripts, icons, web-app manifest, service worker). The actual conversation
// data is only ever delivered through the gated routes below.
// ---------------------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use('/css', express.static(path.join(PUBLIC_DIR, 'css')));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js')));
app.use('/icons', express.static(path.join(PUBLIC_DIR, 'icons')));
app.get('/manifest.json', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'manifest.json')));
app.get('/sw.js', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'sw.js')));

// Health check (handy for confirming the app is alive). No data, so it's public.
app.get('/health', (_req, res) => res.json({ ok: true, app: 'bk-phone' }));

// ---------------------------------------------------------------------------
// Routes.
// The Telnyx webhook MUST stay public (Telnyx's servers call it and can't log
// in); its own signature check is what protects it. Everything else, the
// screens and the API that return customer conversations, sits behind
// requireAuth. These are filled in by routes/sms.js in the next file.
// ---------------------------------------------------------------------------
const sms = require('./routes/sms');
app.use('/webhooks/telnyx', sms.webhook);   // public, signature-verified
app.use('/', requireAuth, sms.app);         // password-gated UI + API

app.listen(PORT, () => {
  console.log(`[bk-phone] running on port ${PORT} (${isProd ? 'production' : 'development'})`);
});

// Exported so the route files and tests can reuse the auth gate.
module.exports = { app, requireAuth };
