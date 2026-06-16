# BK Phone — Business Phone App (Brake Knights)

A standalone, installable business phone app (texting now, calling later) that
replaces Ooma. Built to be far better looking and easier to use, with deep
Brake Knights CRM integration. Lives in this `bk-phone/` folder; runs as its own
app, separate from the CRM, but shares the CRM database for customer matching.

**Branch:** all phone-app code lives on `claude/brave-fermat-bore9c` (NOT merged
to dev/master). A session continuing this work must check out that branch.

**Live dev URL:** https://phone-dev.brakeknights.com (password-gated)

---

## ⚠️ Hard rules (do not break)
- **NEVER push to `dev` or `master` without explicit owner approval.** All phone
  code stays on the feature branch.
- **Phone-dev deploys are NOT git pushes.** They are direct archive uploads to
  the `phone-dev.brakeknights.com` subdomain via the Hostinger MCP. They never
  touch the CRM, the `dev` branch, or the live site.
- **The test app is ISOLATED from live customer data.** `DB_PATH` is intentionally
  NOT set, so the app uses its own empty database. We only point it at the live
  CRM database at launch. Do not connect live data during the build phase.
- **Customer-data protection is rule #1** (see root CLAUDE.md). The phone app only
  ever *reads* CRM customers/leads and *adds* its own two tables.

---

## Architecture
- **Express app**, own port (Hostinger sets `PORT`), entry `server.js`.
- **Telnyx** for SMS. Business number: **+1 703-423-0486** (a fresh test number).
- **Shares the CRM SQLite DB** via `DB_PATH` for customer name/profile matching
  (deferred until launch; isolated for now).
- **PWA** — installable to the iPhone Home Screen. Dark/light themed, brand colors
  (navy `#0d1b2a` / royal blue `#4169e1`, Inter font).
- **Push notifications** via web-push + VAPID.

### Files
- `server.js` — app engine: security headers, signed-cookie password gate,
  production secret guard, raw-body capture for webhook verification, route mounts.
- `db.js` — opens the (shared) SQLite DB; creates ONLY its own tables
  (`comm_threads`, `comm_messages`, `push_subscriptions`) with `CREATE TABLE IF NOT
  EXISTS`. All SQL parameterized. Helper functions for threads/messages/push.
- `telnyx.js` — `sendSms()` + `verifyWebhook()` (ed25519 signature) via built-in
  fetch (no SDK). All env values `.trim()`ed.
- `crm.js` — read-only phone→customer lookup (format-agnostic, last-10-digit match),
  lazily prepared so it never crashes if CRM tables are absent. Builds profile URLs.
- `push.js` — web-push sender; `sendToAll()` returns `{ready,total,sent,failed,errors}`;
  high priority (`urgency:'high'`); prunes dead subs (404/410).
- `routes/sms.js` — public signature-verified webhook (inbound + delivery status),
  password-gated API (list/open/send threads, compose), push subscribe/unsubscribe/test.
- `public/` — `index.html` (conversation list), `thread.html` (conversation),
  `settings.html`, `css/app.css` (design system, both themes), `css/settings.css`,
  `js/app.js` (shared helpers + push client), `js/threads.js`, `js/thread.js`,
  `js/settings.js`, `sw.js` (network-first + push handlers), `manifest.json`, `icons/`.
- `package.json`, `.env.example`, `.gitignore`.

---

## Environment variables (set in Hostinger hPanel for phone-dev)
| Var | Notes |
|---|---|
| `NODE_ENV` | `production` |
| `PHONE_PASSWORD` | owner-chosen, **12+ chars, no `$`** (shell expansion eats it) |
| `PHONE_SESSION_SECRET` | long random hex |
| `TELNYX_API_KEY` | |
| `TELNYX_NUMBER` | `+17034230486` |
| `TELNYX_MESSAGING_PROFILE_ID` | |
| `TELNYX_PUBLIC_KEY` | for inbound webhook verification |
| `CRM_BASE_URL` | `https://brakeknights.com` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | push (`mailto:greetings@brakeknights.com`) |
| `DB_PATH` | **NOT set yet** — point at live CRM DB only at launch |

---

## Deploy workflow (how Claude ships updates)
1. Edit code in `bk-phone/`.
2. **Bump the asset version**: increment `?v=N` on the css/js `<link>`/`<script>`
   tags in `index.html`, `thread.html`, `settings.html`, and the `build N` stamp in
   `settings.html`. **This is critical** — iOS PWAs aggressively cache JS; the
   `?v=N` query is what forces fresh code. (Service worker is also network-first.)
3. `zip -r -q /tmp/bk-phone-upload.zip . -x 'node_modules/*' -x '.env' -x '*.db*'`
   from inside `bk-phone/`.
4. Deploy via Hostinger MCP: `hosting_deployJsApplication(domain:
   "phone-dev.brakeknights.com", archivePath: "/tmp/bk-phone-upload.zip",
   removeArchive: true)`.
5. Verify: poll `https://phone-dev.brakeknights.com/login` for 200; grep a served
   file for the new `build N` / `?v=N`.
6. Env-var changes are done by the owner in hPanel; a code deploy restarts and
   picks them up.

The Node app was first created via hPanel **Add Website → Node.js Apps → Upload
your files** (subfolder app, entry `server.js`, Node 22). After that, MCP archive
deploys work directly.

---

## Status (as of 2026-06-16)

### ✅ Done & confirmed working
- Texting core: conversation list (names over numbers), conversation view (chat
  bubbles, day dividers, delivery status, quick replies, optimistic send),
  compose, password gate, security hardening, PWA install, dark/light theme.
- **Inbound texts** — confirmed landing in the app.
- **Live updates** — list + open thread auto-refresh (8s/5s, pause when hidden).
- **Outbound** — Telnyx ACCEPTS sends (shows "Sent"); actual delivery blocked
  until 10DLC (expected).
- iOS stale-cache problem — **SOLVED** via `?v=N` versioned asset URLs.

### 🔧 In progress — push notifications (iOS delivery)
- Server side **proven**: `/api/push/test` reported "sent to 1 device", and the
  device is registered + subscribed; iOS shows the app under Notifications.
- BUT no banner appears on the phone. Last test: the "Result" popup was **hanging**
  (server awaiting Apple's push service), which suggests the **Hostinger server may
  be slow/unable to reach Apple's push endpoint** (`web.push.apple.com`), OR iOS is
  delaying delivery.
- **Next steps to try:**
  1. Add a request **timeout** to `webpush.sendNotification` so it can't hang;
     surface the timeout/error in the test result.
  2. From the server (enable SSH or a temp diagnostic route), test outbound
     connectivity to `https://web.push.apple.com` — if blocked, that's the root cause.
  3. Confirm the notification shows when the app is **backgrounded/closed** (iOS
     suppresses banners while the app is foreground — this is expected).
  4. Verify VAPID public key used by the browser subscription matches the server's.

### Texting polish roadmap (build order)
1. ✅ Live updates
2. 🔧 Push notifications (finish iOS delivery)
3. Editable **quick-reply templates** (Ooma's "Messaging Templates," better)
4. Real **compose screen** with CRM customer search (type a name, not a number)
5. **Search** conversations · **photos** (MMS) · archive/unread management

### Then
- **Phase B — Calling (mission-critical).** Owner needs reliable **making AND
  receiving** calls. DECISION: this requires a **native shell (Capacitor) wrapping
  this same web app**, because iOS PWAs cannot reliably receive background calls.
  The web app becomes the native app's UI (nothing wasted). Use Telnyx Voice SDK +
  native CallKit (iOS) / ConnectionService (Android) + VoIP push. Needs Apple
  Developer ($99/yr) + Google Play ($25) accounts.
- **Phase C — Deep CRM integration:** caller ID, tap-to-call/text from profiles,
  auto-log calls/texts to customer timeline, create quote/lead from a conversation.
- **Phase D — Polish:** bottom tab nav (Messages · Calls · Keypad · Settings),
  branded splash, Do Not Disturb, notification controls.

### Launch steps (saved for last, per owner)
1. **10DLC registration** (Brand + Campaign in Telnyx) — required for OUTBOUND SMS
   delivery. Sole Proprietor (~$4, no EIN, last-4 SSN, ~1k/day) vs Standard (~$48 +
   EIN). Plus ~$15 campaign vetting. ~3–7 business days carrier approval. The Brand +
   Campaign are reusable across numbers (this number now, real number later — no
   second fee). Owner has NOT started this yet.
2. Set `DB_PATH` to the live CRM database (verify exact path first, no guessing;
   expected `/home/u622313361/domains/brakeknights.com/brakeknights-data/brakeknights.db`).
3. Finalize domain (e.g., `phone.brakeknights.com`); optionally port the real
   business number (703-977-4475) into Telnyx.

### Multi-tenant / SaaS (far future, Phase 9-style)
Built single-tenant but kept clean: `comm_threads.bk_number` is a hook for it.
Selling to other businesses later = add a tenant/account stamp, not a rebuild.

---

## Hosting facts
- Hostinger shared hosting, user `u622313361`, account hosts `brakeknights.com`
  (live CRM), `dev.brakeknights.com` (dev CRM), `phone-dev.brakeknights.com` (this app).
- DNS for `brakeknights.com` is fully Hostinger-managed.
- Server IP `157.173.214.150`, SSH port `65002` (SSH currently off; can enable for
  diagnostics like the Apple-push connectivity check).
