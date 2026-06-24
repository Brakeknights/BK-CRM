# Brakeknights Project

## RULE #1 — Customer Data Protection (Highest Priority, Always)
Protecting customer data is the number one priority for everything built in this project. Customer information (names, phones, emails, addresses, vehicles, job history) must never be exposed, leaked, or left vulnerable. When designing or changing anything that touches customer data, security comes before convenience, speed, or features. Apply these rules by default:

- **Never log full customer PII** to console or files beyond what is needed for debugging (IDs are fine; avoid dumping full records).
- **All admin routes stay behind `requireAuth`.** Never add an unauthenticated route that returns customer data. The only public data path is the tokenized quote-accept flow (`crypto.randomUUID` tokens).
- **All SQL stays parameterized** (`?` placeholders). Never interpolate user input into a query string. Dynamic column names must come from a fixed code allowlist, never from the request.
- **Always HTML-escape** customer values with `esc()` before rendering.
- **Secrets only in env vars** (`ADMIN_PASSWORD`, `SESSION_SECRET`, tokens, SMTP/Square creds). Never hardcode or commit them. The DB and `.env` are gitignored — keep them that way.
- **Production refuses to boot** without a strong `ADMIN_PASSWORD` and `SESSION_SECRET` (guard in `server.js`). Do not remove this guard.
- **Session cookies** are `httpOnly` + `sameSite:lax` + `secure` in production, behind `trust proxy`. Login is rate-limited and uses a constant-time password check with session regeneration. Do not weaken these.
- When in doubt, choose the option that better protects customer data, and flag the trade-off to the owner.

### Security measures in place (do not weaken without explicit owner approval)
- Production secret guard (refuses known-default / missing `ADMIN_PASSWORD`/`SESSION_SECRET`)
- Hardened session cookie (`httpOnly`, `sameSite:lax`, `secure` in prod), `trust proxy` set
- Login brute-force lockout (5 fails per IP → 15 min lock), constant-time compare, session regeneration on login
- Security headers site-wide: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS in prod
- Parameterized SQL everywhere; admin behind auth; tokenized customer quote links; DB gitignored
- Automated encrypted off-server DB backups (see "Database Backups" below) — the recovery path for the customer database

## Database Backups (Rule #1 recovery path)
The customer database is the crown jewel and now has automatic, encrypted, off-server backups.
- **What runs:** `backup.js` takes a consistent SQLite snapshot (`better-sqlite3` `.backup()`), gzips it, encrypts it with AES-256-GCM, and uploads it to a private Backblaze B2 bucket. Scheduled in `server.js` ~3 min after boot, then every 24h. Logs only sizes/keys/timestamps, never PII.
- **Encrypted at rest:** a leaked bucket exposes no customer data without `BACKUP_ENCRYPTION_KEY`. Dev and prod use **separate** encryption keys (stored in the owner's password manager — losing the prod key means prod backups can never be decrypted).
- **Separation:** prod backups live under prefix `brakeknights-prod/`, dev under `brakeknights-dev/`, in bucket `brakeknights-crm-backups`. Each prefix keeps its 30 newest backups (`BACKUP_RETENTION`), independent of the other.
- **Env vars (set in Hostinger hPanel per site, never committed):** `BACKUP_ENABLED`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_BUCKET`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_APP_KEY`, `BACKUP_ENCRYPTION_KEY`, `BACKUP_S3_PREFIX`. The code is a dormant no-op until these are present, so it can ship before being switched on.
- **Admin tools (behind `requireAuth`):** `GET /admin/backup/status` (config state, no secrets), `POST /admin/backup/run` (manual backup), `GET /admin/backup/verify` (server-side restore drill: downloads the newest backup, decrypts, runs `integrity_check` + leads count).
- **Emergency restore:** `scripts/restore-backup.js --latest restored.db` with the prod env vars set, then swap the file in for the live DB. Verified working on both dev and master (2026-06-23).

## Session Startup Checklist (Run These First, Every Session)
1. `git config core.hooksPath .githooks` — activates the master push block
2. `git branch --show-current` — confirm you are on your feature branch (not `dev` or `master`); create a new one if starting fresh: `git checkout -b claude/<new-branch-name>`

## Master Branch Protection (Two Layers)
Master is protected by two independent layers. Do not weaken or remove either without explicit user approval.

**Layer 1: GitHub ruleset (server-side, primary).**
A repository ruleset named "Protect master" targets the `master` branch on GitHub itself. It blocks direct pushes by non-admins, force pushes, and branch deletion. It cannot be bypassed locally (`--no-verify` does not affect it) and applies no matter what branch a session starts on. The repo owner (Repository admin) is on the bypass list, so the owner can still push directly to master to deploy. Confirm status anytime with `list_branches` — master reports `"protected": true`.

**Layer 2: local pre-push hook (catches accidental admin pushes).**
`.githooks/pre-push` blocks all pushes to master by default and is activated each session by `git config core.hooksPath .githooks` (run by the session-start hook). This is the safety net for the one gap Layer 1 leaves open: the owner accidentally pushing to master.

## Master Push Workflow (Permanent — Do Not Change)
All changes to master go through a GitHub Pull Request. Claude never pushes directly to master.

**The workflow is always:**
1. Merge feature branch to `dev` (on user approval)
2. Verify on dev.brakeknights.com
3. Create a PR from `dev` → `master` using the GitHub MCP
4. User clicks Merge on GitHub to approve and deploy to the live site

Claude creates the PR; the user merges it. No exceptions, no shortcuts.

**"go master"** is the trigger to create a PR from dev → master. When the user says "go master", always create the PR immediately — never push directly.

The pre-push hook and GitHub ruleset remain in place as protection, but the PR workflow is the only path to master going forward.

### New Skill Reminder (Always)
Skills only travel to a new session if they are committed to a branch that session checks out. A skill added on a feature branch or only on `dev` will NOT appear in fresh sessions started from `master`. So: **whenever a new skill is added (or an existing skill file is changed) under `.claude/skills/`, remind the owner to push it through to master** (feature branch to dev, then a dev to master PR) so it does not get left behind. Flag this proactively at the end of any session where a skill was created or edited, even if the owner did not ask.

## Overview
Website and customer portal for Brakeknights (brakeknights.com).
Built with Node.js/Express, deployed on Hostinger.

## Key Facts
- **brakeknights.com is now the code-based Node.js/Express site** — deployed from the `master` branch via Hostinger git auto-deploy
- The old Hostinger website builder site was replaced during launch
- Live site must never be broken — always preview on dev first

## Branch & Deployment Workflow
- `dev` branch → **auto-deploys to dev.brakeknights.com** via Hostinger git integration (Branch: dev, Node 22) — just push to `dev` and it deploys automatically
- `master` branch → deploys to **brakeknights.com** (live site)
- All changes go on feature branch first. Only merge to `dev` when user approves. Master is always updated via PR — Claude creates the PR, user clicks Merge on GitHub.
- Never push directly to `master` under any circumstances.
- **Deployment note:** Both `dev` and `master` branches are configured for Hostinger git auto-deploy. Pushing triggers automatic deployment. SMTP_PASS env var is set in Hostinger for both dev.brakeknights.com and brakeknights.com.

## Hostinger MCP
A Hostinger MCP server is configured in `.mcp.json`.
It allows direct management of Hostinger hosting from Claude Code.
The API token is entered securely at session start — never hardcode it.

## Project Structure
- `server.js` — Express server, reads PORT from environment
- `public/index.html` — frontend HTML
- `package.json` + `package-lock.json` — Node.js dependencies

## Writing & Punctuation Rules
- No em dashes (—) unless grammatically required (e.g., true parenthetical aside). Use a colon for introducing lists/explanations, a comma for brief pauses, or rewrite the sentence. This applies to all copy: HTML, emails, CLAUDE.md, everywhere.

## Screenshots with Playwright
- Always use `element.offsetTop` to scroll to a section — never `getBoundingClientRect().top + window.scrollY` (that value changes as the page scrolls and will land on the wrong section)
- Always use `offsetTop` pattern: `const y = await page.evaluate(() => document.querySelector('#section-id').offsetTop); await page.evaluate((y) => window.scrollTo(0, y), y);`
- Never merge to `dev` without explicit user approval — commit and push to the feature branch only

## Dev Workflow Rules — ABSOLUTE NON-NEGOTIABLE
⛔ STOP. READ THIS BEFORE EVERY PUSH. NO EXCEPTIONS. EVER.

1. ALL changes go to the feature branch ONLY
2. After making changes: take a screenshot, show the user, then STOP and WAIT
3. Do NOT merge to `dev` until the user explicitly says "push to dev" or "merge to dev" or "approved for dev"
4. Do NOT merge to `master` under any circumstances without explicit user approval
5. "I won't do it again" is not enough — CHECK THIS LIST before every single merge
6. ⛔ NEVER auto-merge to dev after a fix, even if it seems small or obvious

THE WORKFLOW IS:
  feature branch → show screenshot → WAIT FOR APPROVAL → then merge to dev
  dev → WAIT FOR APPROVAL → then merge to master

There is NO shortcut. There is NO exception. Not even "just a small fix."
ASKING "should I push to dev?" IS NOT ENOUGH — wait for the user to say it.
- Current feature branch: `claude/eager-ride-SnMeU`

## Square Integration — Platform Build Plan

The long-term vision is a fully owned Brake Knights business platform. Square is used only as the payment processor and appointment calendar backend. All customer communication (quotes, confirmations, receipts, follow-ups) flows through our own system. Eventually white-labeled and sold to other service businesses.

### Architecture Decision
- Admin tools live at `brakeknights.com/admin` (password-protected, same server as public site)
- Square handles: payment processing, appointment calendar, sales reporting
- Our system handles: all customer-facing emails, CRM, quotes, job summaries, follow-up automation

### Square Env Vars (set in Hostinger hPanel for brakeknights.com)
- `SQUARE_APP_ID` — production app ID
- `SQUARE_ACCESS_TOKEN` — production access token
- `SQUARE_SANDBOX_APP_ID` — sandbox app ID
- `SQUARE_SANDBOX_ACCESS_TOKEN` — sandbox access token
- Connection verified: `brakeknights.com/api/square/verify` returns `{"environment":"production","customers":"ok","bookings":"ok"}`

### Square Module
- `square.js` — initializes SquareClient from env vars, exports `client` and `verifyConnection()`
- Defaults to production when `SQUARE_ACCESS_TOKEN` is present and `SQUARE_ENV` is not `sandbox`

### Platform Build Phases

**Phase 2 (complete):** When a customer submits the contact form, automatically create or find them as a Square customer. Foundation of the CRM.

**Phase 3 (complete):** Quote tool — owner enters service + price + proposed time, system sends a branded quote email to the customer. Customer accepts, picks time + address, owner approves/denies. T-24h and T-2h reminder emails sent automatically.

**Phase 4 (complete, merged into Phase 3):** Branded booking confirmation email fires on owner approval with full service details, price, address, duration, and calendar links.

**Phase 5 (complete):** Job summary + custom receipt — owner fills out a receipt form after the job (service, vehicle, pricing, payment method, up to 4 advisory notes). Branded receipt emails to the customer. Lead auto-marked Completed. Each advisory can carry a timed follow-up reminder (owner/customer/both).

**Phase 6 (complete):** Follow-up reminders created from receipt advisories are stored in the `followups` table. A cron job in server.js checks every 6h and fires owner alert and/or customer reminder emails on the due date. Management UI added: `/admin/followups` dashboard (Due Now / Upcoming / Recently Sent) with reschedule, mark-done, cancel; topbar Follow-ups link with an overdue/due-today count badge; ad-hoc reminder creator on lead pages; follow-ups surfaced on the lead profile. Plus a round of receipt/profile refinements: receipt service multi-select with tier + price auto-fill, "Other" payment text box, lead-level VIN + Internal Notes card, "Receipt Sent" pipeline stage (amber Completed = receipt still owed), clickable "View customer copy", full lead-history logging, and Text/Email buttons on lead cards.
- **Auto-fill decision:** the receipt service picker auto-fills price fields from the pricing table. Keep as-is for now; revisit later.

**Phase 6C (deferred — Square auto-trigger):** Instead of the owner manually clicking "Complete Job & Send Receipt," Square events (appointment marked done, or payment taken in the Square POS) automatically fire our receipt + follow-up flow via the Square API/webhooks. Bigger build; spec together when we get there.

**Phase 7 (complete):** Full CRM dashboard at `brakeknights.com/admin` — customer profiles, vehicle history, job history, upcoming follow-ups, all owned by Brake Knights. Live on master.

**Phase 7A (complete — Quick Quote / Receipt Generator):** A standalone generator on the dashboard at `/admin/quick`, not bound to any lead, for fast phone/text inquiries. Reuses the existing pricing engine, service multi-select + tier toggle, live auto-calc, and branded quote/receipt templates. "Quick Quote" link added to the admin topbar nav. Built entirely in `routes/admin.js` (`GET`/`POST /admin/quick`), reusing `buildQuoteEmail` / `buildReceiptEmail`. On dev, not yet on master.
- **Implemented:** Quote/Receipt mode switch on one screen; service multi-select + tier toggle with live auto-fill from the pricing table; any field overridable, total recalcs live. Quote outcomes: (1) calculator only (Clear, nothing saved); (2) Send (create "Quick Quote" lead in Quoted stage, save quote, email branded quote with accept link); (3) Copyable link (create lead + quote + token, return result page with the customer quote URL + one-tap Copy button); plus Save as New Lead (no email). Receipt mode mirrors the receipt builder: vehicle/date/payment(+Other)/address, 4 advisories with timed follow-up reminders, office notes; Send Receipt (emails, advances lead to Receipt Sent + writes followups) or Save as New Lead.
- Original spec (for reference):
- **Quote/Receipt mode switch** on one screen; usable on the front end (brand-new) or back end (within an existing lead). Pick services + tier, override any number, total recalcs live (for reading off on the phone).
- **Three outcomes:** (1) calculator only — nothing saved, can be erased; (2) send to customer — enter first/last name + email → creates a lead (source "Quick Quote") in the Quoted stage, saves the quote, emails the branded quote with the accept link; (3) copyable shareable link — creates the lead + quote + token and returns the customer-facing branded quote URL the owner copy-pastes into their own texting app.
- Also: option to save as a new lead without sending.
- **SMS note:** in-app text sending needs an SMS provider (Twilio etc.) — not wired yet. For text inquiries, use email or the copyable link for now. Real in-app SMS is its own later phase.

**Phase 7 Build Plan:**
- **Key decision (deferred to build session):** Option A — virtual de-duplication (query leads by email/phone, group on the fly, no schema change) vs Option B — real `customers` table with migration (adds a `customer_id` FK to `leads`). Option A is faster to ship; Option B is the correct long-term foundation. Decide at build session start.
- **New `customers` table (Option B):** `id`, `created_at`, `first_name`, `last_name`, `phone`, `email`, `square_customer_id`, `notes`, `vehicles` (JSON array of {year, make, model, vin}).
- **`/admin/customers`:** Searchable list — customer name, phone, email, job count, last service date, lifetime spend. Sortable. Links to customer profile.
- **`/admin/customer/:id`:** Customer profile header (name, phone, email, Square link); Notes card (free-text, auto-save); Vehicles card (add/edit year/make/model/VIN); Job History timeline (all leads + quotes + receipts, newest first); Upcoming Follow-ups; Lifetime stats (total jobs, total spend, last service).
- **Auto-link logic:** When a new lead comes in (form or Quick Quote), match email or phone to existing customer and attach `customer_id`. If no match, create a new customer record automatically.
- **Build order:** 1) customers table + migration, 2) auto-link on lead create, 3) customer list page, 4) customer profile page, 5) admin dashboard home (recent activity, pipeline summary).
- **Not in Phase 7:** SMS, Square Appointments auto-booking, pricing matrix, white-label.

**Phase 8E/8F (complete ✅):** Browser push notifications — bell icon in admin appbar, service worker (`/sw.js`), VAPID key configuration, `push_subscriptions` table, `sendNewLeadPush()` fires on every new contact form submission. VAPID keys set in Hostinger for dev + master. Confirmed working in production.

**Phase 8 (planned):** Automated quotes — instant quote emails based on vehicle type and service selected. Requires: (1) pricing table reviewed and finalized, (2) contact form vehicle field structured as year/make/model instead of free text, (3) `vehicle_tier_mappings` and `pricing_overrides` tables already built as foundation in `db.js`.

**Phase 9:** White-label packaging — multi-tenant architecture, per-brand configuration, reseller infrastructure for other service businesses.

### Current Customer Flow (for context)
- Customer calls/texts → verbal price + schedule discussion → owner books in Square → Square sends confirmation (date/time only, no price)
- Customer submits form → owner replies by email with price → customer confirms → owner books in Square → Square sends confirmation (date/time only, no price)
- Payment: credit card via Square POS app on phone; cash/Zelle recorded manually in Square for sales tracking

## Current Work in Progress
Update this section at the end of each session to stay caught up next time.

> ### ⚠️ DEPLOYMENT BROKEN — Hostinger GitHub auto-deploy is DISCONNECTED (as of 2026-06-18)
> Around 6/16 Hostinger migrated both sites to their new "Node.js Web App" deployment system and the GitHub link did not carry over. Both `dev.brakeknights.com` and `brakeknights.com` show **"Disconnected from GitHub"** in hPanel, so **pushing to dev/master no longer auto-deploys.** Git pushes still succeed (code is safe on GitHub); Hostinger just never builds them.
> - **Root cause is on Hostinger's side**, not GitHub: the Hostinger GitHub App still has access to Brakeknights/BK-CRM (both repos verified). Owner has an open ticket with Hostinger support (agent Marwa) to re-link / escalate to their tech team.
> - **HOW TO DEPLOY UNTIL IT'S FIXED (use the Hostinger MCP, not git push):**
>   1. `git archive --format=tar.gz -o /tmp/bk-master.tar.gz origin/master` (and `origin/dev` → `/tmp/bk-dev.tar.gz`). `git archive` auto-excludes node_modules/.git/.env/data so the prod DB and secrets are never touched.
>   2. `mcp__hostinger-mcp__hosting_deployJsApplication` with domain `brakeknights.com` (or `dev.brakeknights.com`) and the archive path. Builds in ~30s.
>   3. Verify with `hosting_listJsDeployments` (state `completed`) + a `curl` 200 check.
> - On 2026-06-18 both sites were force-deployed current this way: master `a6edc3d`, dev `fb05c6e`. Env vars + DB confirmed intact (admin login works).
> - **CHECK BACK:** once Hostinger reconnects GitHub, do a tiny test push and confirm it auto-builds, then auto-deploy is restored and this note can be removed.

- Last working branch: `claude/blissful-feynman-f0raph` — merged to master via PR #44 ✅
- `dev` branch → dev.brakeknights.com (auto-deploy on push) ✅
- `master` branch → brakeknights.com (live site, auto-deploy on push) ✅ — **site is live**
- Phases 2, 3, 4, 5, 6, 7A, 7B, 7C, 8E/8F all complete and live on master.
- dev and master are in sync.
- `brakeknights-crm` skill installed at `.claude/skills/brakeknights-crm/SKILL.md` — load at the start of every CRM session for full project context ✅
- **Master deploy workflow: Claude creates PR (dev → master), user clicks Merge on GitHub. No direct pushes to master ever.** ✅
- Pre-push hook in place — blocks direct pushes to master ✅
- Session startup hook shows pending dev-vs-master commits at session start ✅
- Screenshot skill in place — `node scripts/screenshot.js [path] [selector]` — now auto-logs in for /admin paths ✅
- Square SDK installed, `square.js` module live, verify endpoint confirmed working on production ✅
- Square auto-booking code-complete but blocked by Square Appointments subscription tier (403 on bookings.create until paid plan active) ✅
- **DB path fix:** `NODE_ENV=production` set in Hostinger hPanel for both dev and master — database now stored outside the git directory and survives all deploys ✅
- **VAPID keys:** Set in Hostinger hPanel for both dev and master. Push notifications confirmed working ✅
- **Square import:** Run at brakeknights.com/admin/customers/import-square to pull all production Square customers into the CRM. Sandbox (dev) has test customers only.
- Next steps:
  1. ~~Set VAPID keys~~ — done, push notifications confirmed working ✅
  3. Phase 8: automated quotes (requires pricing table finalized by vehicle type)
  4. Decide on Square Appointments paid plan (Plus/Premium) to turn on live auto-booking
- Follow-up reminder testing note: the Phase 6 cron fires every 6 hours (not instantly). To test a reminder: set a follow-up date to today, then wait for the next cron run (check server logs for "follow-up cron" entries). On dev, the cron fires on the dev server; on master, it fires on the live server. Don't test on master with real customer leads.

## Full Build Summary (Permanent Reference)

**What it is:** A fully owned business platform for Brake Knights (mobile brake repair, Northern Virginia). Public marketing website plus a password-protected CRM/admin at `/admin`. Square is used only as payment processor and calendar backend; all customer communication (quotes, confirmations, receipts, follow-ups) runs through our own system. Long-term goal: white-label and resell to other service businesses.

**Tech stack:** Node.js (>=22) + Express 4, `better-sqlite3` (synchronous SQLite, WAL), `express-session` with custom SQLite store, `nodemailer` (Hostinger SMTP), Square SDK v44, Node `crypto` for accept tokens. Frontend is plain server-rendered HTML/CSS/JS (no framework, no build step), self-hosted Font Awesome, Google Maps + Places for address autocomplete. Single SQLite file (`data/brakeknights.db`): tables `leads`, `quotes`, `lead_history`, `receipts`, `followups`, `sessions`, `push_subscriptions`, plus pricing/vehicle-mapping foundation tables. Hostinger git auto-deploy: `dev` → dev.brakeknights.com, `master` → brakeknights.com.

**Phases built:**
- **Phase 1 — Public website:** 45 pages (homepage, about, contact, services, 6 service-detail, 32 location, legal, blog). Contact form → owner notification + branded customer confirmation. Full SEO (schema, canonical, OG/Twitter, sitemap, robots), mobile menu, Google Reviews, job photos.
- **Phase 2 — Square CRM foundation:** Contact form auto-creates/finds Square customer; `square_customer_id` stored on lead.
- **Phase 3 + 4 — Quote tool & booking:** Owner quote builder (service/tier, live price auto-fill), tokenized accept link, customer accept page (inline calendar), Approve/Deny, confirmation email with .ics links, T-24h/T-2h reminder cron.
- **Phase 5 — Receipts:** Post-job receipt builder (service, vehicle, date, address, payment, up to 4 advisories, office notes), branded receipt email, lead auto-completes, advisories carry timed follow-ups.
- **Phase 6 — Follow-up automation:** `followups` table + 6h cron fires owner/customer reminders; `/admin/followups` dashboard (Due/Upcoming/Sent), reschedule/done/cancel, topbar badge, ad-hoc reminders; receipt/profile refinements.
- **Phase 7 / 7A / 7B / 7C — Full CRM:** Quick Quote/Receipt generator (`/admin/quick`, three outcomes: calculator-only / Send / copyable link); customer profiles (`customers` table, auto-link by email/phone, list + full profile with vehicles, addresses, notes, tags, job history, follow-ups, lifetime stats); dashboard + revenue/conversions/services reports.
- **Phase 8 (in progress):** NHTSA year/make/model cascading dropdowns site-wide, Appointments tab, Eastern Time timestamps, Square customer import, foundation tables for per-vehicle pricing.
- **Phase 8E/8F — Push notifications:** Bell icon, service worker, VAPID keys, `push_subscriptions`, fires on every new lead. Live in production.

**Security (Rule #1):** Production secret guard, hardened session cookies, login brute-force lockout + constant-time compare + session regeneration, site-wide security headers (HSTS in prod), parameterized SQL everywhere, `esc()` escaping, all admin routes behind `requireAuth`, tokenized customer links as the only public data path, DB + `.env` gitignored.

**Status:** Phases 1-7 + 8E/8F live; Phase 8 (automated quotes) in progress. dev and master in sync.

**Next:** Phase 8 automated quotes (needs per-vehicle pricing matrix finalized first), Phase 6C Square webhook auto-trigger, Phase 9 white-label, Square Appointments paid plan to unblock live auto-booking.

## Pre-Launch Checklist (Before Merging to Master)

### Functional
- [x] Submit a test contact form on dev — confirm internal notification arrives at greetings@brakeknights.com
- [x] Submit a test contact form on dev — confirm customer confirmation email arrives
- [x] Click every nav link (desktop + mobile) — no 404s (all 45 pages return 200)
- [x] Click every footer link — no 404s
- [x] Test mobile hamburger menu on a real phone — opens, closes, submenus expand/collapse

### Content Accuracy
- [x] Phone number (703-977-4475) in header and footer — correct
- [x] Phone number does NOT appear inside CTA buttons — header button intentionally shows number (local service best practice), hero CTA says "Call" only
- [x] Service area list on site matches the actual 32 cities served
- [x] Legal pages (privacy policy, terms) — reviewed, no placeholder or dummy text

### Visual / Rendering
- [x] Spot-check homepage on mobile — layout, text size, images all correct
- [x] Spot-check one service page on mobile — buttons styled, no broken layout
- [x] Spot-check one location page on mobile — looks correct
- [x] Font Awesome icons rendering correctly — 40 icons confirmed rendering on homepage
- [x] Google Reviews widget showing on homepage

### Technical
- [x] Browser console on homepage — no real JS errors (2 HTTPS cert warnings are localhost-only, resolve on live site)
- [x] Canonical tags point to `brakeknights.com` (not `dev.brakeknights.com`) — all 45 pages confirmed
- [x] `sitemap.xml` exists and lists all major pages — created, serving correctly
- [x] `robots.txt` exists and is correct — created, serving correctly
- [x] Homepage title/meta fixed — was "Sterling, VA", now "Northern Virginia" across title, description, OG, and Twitter tags

### SEO
- [x] Homepage title tag and meta description are accurate and unique
- [x] About, Contact, Services pages have unique titles and meta descriptions — reviewed and confirmed
- [x] Homepage JSON-LD schema passes Google's Rich Results Test

---

## To-Do List
⚠️ Single source of truth. Update every time an item is completed or added.

### Pending
- [ ] ⚠️ **Hostinger GitHub auto-deploy reconnect** — both sites "Disconnected from GitHub" since ~6/16 (Hostinger Node.js migration dropped the link). Ticket open with Hostinger. Until fixed, deploy via Hostinger MCP archive (see DEPLOYMENT BROKEN note at top). Once Hostinger re-links it, test a push auto-builds, then remove the note. NOTE (2026-06-23): now that encrypted off-server DB backups exist (PR #58), the "delete website and re-add" reconnect path Hostinger suggested is de-risked but still optional — auto-deploy is only a convenience, and the MCP archive deploy works fine. If ever attempting the delete/re-add, take a fresh verified backup first. DECISION (2026-06-23): owner chose to **NOT** do the destructive delete/re-add reconnect and to keep using the MCP archive deploy. ⚠️ Reason: Hostinger's API reports `dev.brakeknights.com` as the plan's **main domain** (`vhost_type: "main"`), with `brakeknights.com` (live) and `phone-dev` as **addons** on the same plan/order. On Hostinger, addons hang off the main domain, so deleting the main domain (dev) to reconnect risks taking the addon sites (including the live site) down with it. Do NOT delete the main domain to reconnect. (Owner believes brakeknights.com is the historically original domain; that's about registration date, separate from which domain the current plan is configured as "main" — verify in hPanel Website Details before ever acting on this.) Preferred path forward: ask Hostinger to re-link GitHub **server-side** rather than delete anything. Auto-deploy is convenience only; MCP archive deploy + verified backups cover everything.
- [x] 🔒 **Upgrade nodemailer 8 → 9** (flagged 2026-06-19 by npm audit) — DONE and verified live on 2026-06-22. Bumped to `^9.0.1`, deployed to dev and master, and confirmed working: a test contact-form submission on dev returned HTTP 200 (the route only responds after both `await transporter.sendMail()` calls resolve, so 200 = send path works under nodemailer 9), and both the internal notification and customer confirmation emails were delivered to greetings@brakeknights.com. Email send code unchanged (plain Hostinger SMTP, port 465). The three flagged CVEs all hit features we don't use (`List-*` headers, `jsonTransport`, `raw` message option). The other two original audit items — `hono` and `form-data` — need no action: `hono` is local-only via the Hostinger MCP and never deployed; `form-data` is internal to the Square SDK with no attacker-controlled input.
- [ ] Custom line items + notes to customer on the **Quick Quote** tool (`/admin/quick`) — already shipped on the per-lead Build Quote + Receipt builder (custom priced lines with Taxed/Not-taxed toggle, taxed-as-parts, hidden from customer; free-text notes). Quick Quote still needs the same treatment for consistency.
- [ ] Phase 6C: Square auto-trigger (Square events fire receipt + follow-up flow) — deferred, spec later
- [ ] Phase 8: automated quotes (requires pricing table to be finalized)
- [ ] Phase 9: white-label packaging for other service businesses
- [ ] Add a good rotor-caliper photo to brake inspection page (tabled — image rotation issue on mobile)
- [x] Vehicle year/make/model cascading dropdowns on contact forms and all admin vehicle entry points (Quick Quote, Receipt Builder, appointments, customer forms) — NHTSA API, "Other" fallback, required validation on public forms. Live on master via PR #29.
- [ ] Finalize pricing table by vehicle type (required before Phase 8) — flat pricing today; Phase 8 needs per-vehicle-class matrix
- [ ] Review/update existing service prices — owner flagged that "some service prices need updating". Walk through the pricing table tier by tier and update any that changed. (IN PROGRESS)
- [ ] CRM improvement: tag submission source (homepage vs contact page) in Square customer note
- [ ] CRM improvement: replace flat note field with structured data fields once Phase 7 CRM is built
- [ ] CRM improvement: add visible alert/logging if Square customer sync fails on a form submission
- [ ] Customer auto-nudge: if a sent quote has not been accepted after X hours, automatically send the customer a gentle follow-up email ("Just checking in — your quote is still available"). Currently manual; add as opt-in feature once Phase 3D is tested in production.
- [ ] Set up email forwarding: greetings@brakeknights.com → personal Gmail for instant push notifications (currently 2-5 min IMAP delay)
- [ ] Job photo feature: upload photos mid-job (from lead profile, before receipt exists) and attach to receipt email; tokenized public serve route (/photos/:token); customer profile gallery across all jobs. Storage in /data/uploads/ outside git. multer for uploads, job_photos table in SQLite.

### Completed This Session
- [x] PR #58: Automated encrypted off-server database backups (Rule #1). `backup.js` snapshots the SQLite DB, gzips + AES-256-GCM encrypts it, uploads to a private Backblaze B2 bucket (`brakeknights-crm-backups`); runs ~3 min after boot then every 24h. Admin routes `/admin/backup/status`, `POST /admin/backup/run`, `/admin/backup/verify`; `scripts/restore-backup.js` recovery path. Prod under `brakeknights-prod/` (separate encryption key), dev under `brakeknights-dev/`. Verified end-to-end on dev and master (live: 24 leads, integrity ok). Closes the single-copy customer-DB risk. Also fixed `.gitignore` (`.env`/`*.db` were not actually ignored). See "Database Backups" section above.
- [x] PR #44: CRM login → Appointments landing; saved-address auto-fill on address forms; prevent duplicate saved addresses on profile save; phone formatting fix for numbers stored with leading country code 1; push notification reliability fix. Merged to master, live. dev and master in sync.
- [x] PR #29: Vehicle cascade dropdowns (NHTSA API, "Other" free-text fallback) applied to Quick Quote and Receipt Builder; appointments Clear Selection now zeroes prices; Preview Email button on New Appointment form; required year/make/model validation on public contact forms (index.html + contact.html).

### Previously Completed This Session
- [x] PR #26: Fix duplicate services on receipts/quotes (dedup customService before appending); fix Square sync re-importing deleted name-only customers (skip Square customers with no email AND no phone).
- [x] PR #25: Home address on customer profile (stored, editable, shown as clickable Maps link in header); clickable Maps links on lead cards, scheduling panel, and appointments tab (falls back to customer home address when no service address); custom service field on quote builder, receipt builder, and appointment form; fix duplicate customers from Square sync (Square ID lookup first); customer list sort fixes (active customers first, "Most jobs" by count); delete button on customer list cards.
- [x] PR #24: Custom service field platform-wide (quote builder, receipt builder, appointments); Quick Quote receipt mode fix (custom service was dropped from email and preview).
- [x] Phase 8 CRM batch merged to master via PR #23: structured vehicle fields on contact forms, NHTSA cascading vehicle dropdowns (new customer/profile/appointment forms), appointment auto-fill from customer profile, Quick Quote receipt mode JS fix + customer section auto-expand, customer sort dropdown (6 options, localStorage), collapsible pricing rows, Square auto-sync cron (60s boot delay, every 6h), customer self-service reschedule + cancel on quote confirm page.
- [x] Updated-quote logic now per-lead: "Updated Quote" email fires only when THIS lead already had a quote sent. Repeat customer on a new lead always gets "New Quote."
- [x] Quote update visible in admin: Lead History logs "Quote updated" with timestamp + service + total; Quote History table shows amber "Updated" badge when a lead has more than one quote.
- [x] Push notifications: dev notifications prefixed `[DEV]` so distinguishable from live on phone. Note: push subscriptions are per-domain — enable bell on brakeknights.com/admin for live notifications.
- [x] Receipt Sent leads tab: added to Leads list so completed leads can be found/edited/deleted without digging through customer profiles (still hidden from All view + pipeline counts).

### Previously Completed This Session
- [x] Quick receipt for off-pipeline jobs: customer search typeahead added to Quick Quote receipt mode — search by name/phone/email, select to auto-fill all fields (name, phone, email, vehicle, address). New customer auto-created in CRM on submit.
- [x] Completed leads hidden from leads tab: status `receipt_sent` (receipt sent) leads no longer appear in the pipeline list or counts. Only accessible via customer profile or new Receipt Sent tab. Leads tab = active pipeline only.
- [x] Customer profile editing: Edit Info button on customer profile — edit first name, last name, email, and phone inline. Saves with green confirmation banner.
- [x] All lead cards clickable: every card across the entire dashboard (appointments, follow-ups, dashboard recent activity) now opens the lead on tap/click anywhere on the card.
- [x] Appointments: Reschedule button — toggles an inline date + time form per card (pre-filled with current values). Save updates the appointment and shows a confirmation banner.
- [x] Appointments: Cancel Appt button — confirm dialog, clears the appointment, returns lead to Approved status in the pipeline. Shows amber banner on redirect.
- [x] Screenshot script fix: auto-logs in for any /admin path — screenshots now show actual admin content instead of the login page.

### Previously Completed This Session
- [x] Appointments calendar: monthly grid with dot indicators, day-tap filtering, prev/next month navigation. Live on master via PR #20.
- [x] Customer search typeahead on New Appointment form: replaces giant dropdown, search by name/phone, tap to select, chip badge with clear button.
- [x] Customer list live client-side filtering: no page reload, keyboard stays open on iOS.
- [x] Customer search crash fix: SQL `" "` identifier rejected by production SQLite, changed to `' '` string literal.
- [x] Appointment form double-submit fix: button disables on form submit event (not onclick) so date field is always serialized correctly.
- [x] Square import createCustomer fix: function was missing from module.exports, caused TypeError on all new records.
- [x] Square import live on brakeknights.com: all production Square customers imported into CRM.

### Previously Completed This Session
- [x] Phase 8E/8F: Browser push notifications for new leads (bell icon toggle, service worker, VAPID keys); new-lead sidebar badge showing unactioned lead count. Merged to master via PR #18. VAPID keys set in Hostinger for dev + master. Push notifications confirmed working in production ✅
- [x] CRM: Create New Customer form/button on Customers tab (/admin/customer/new)
- [x] CRM: Full Appointments tab at /admin/appointments with scheduling, customer search/create, service/pricing, confirmation email
- [x] Eastern Time timestamps: all admin timestamps now display in America/New_York timezone
- [x] Square customer import: /admin/customers/import-square — pulls all Square customers into CRM, dedup by email/phone, client-driven pagination with live progress, 0 errors confirmed on sandbox
- [x] Security hardening: production secret guard, hardened session cookies, login brute-force lockout (5 fails/IP → 15 min), constant-time password compare, session regeneration on login, site-wide security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS in prod)
- [x] Rule #1 documented in CLAUDE.md: customer data protection as top priority

### Previously Completed This Session
- [x] Phase 7B: CRM customer profiles — `customers` table, auto-link logic, customer list at `/admin/customers`, full profile at `/admin/customer/:id` (contact, vehicles, saved addresses, notes, tags, job history, follow-ups, lifetime stats). Sidebar nav replaces old topbar. Full design-token restyle. Collapsible sections on all profile pages (default closed, state saved in localStorage).
- [x] Phase 7C: Dashboard + Reports — `/admin/dashboard` (pipeline tiles, stats row, recent-activity feed); `/admin/reports/revenue` (monthly bar chart + service breakdown); `/admin/reports/conversions` (quote-to-job rate, monthly table); `/admin/reports/services` (inquiries, jobs, revenue per service). All four replace placeholder pages. Merged to master via PR #15.
- [x] DB wipe fix: `NODE_ENV=production` in Hostinger hPanel moves SQLite database outside git directory — survives all future deploys (verified: test lead persisted through a redeploy on dev). PR #10.
- [x] Quote send error feedback: lead detail page now shows green banner on success and red banner if email fails. PR #11.
- [x] Delete lead: "Lead not found" bare page replaced with redirect back to admin list; delete button now shows explicit in-page confirmation modal instead of browser native confirm(). PR #11.
- [x] All bare "Lead not found" pages fixed (12 routes): stale admin links now redirect to /admin dashboard instead of a blank error page. PR #12.
- [x] Updated quote email: when a second quote is sent to the same email address, subject says "Your Updated Brake Service Quote" and a blue banner appears in the email body noting it replaces the prior quote. Applies to both regular quote flow and Quick Quote tool. PR #12.
- [x] Master deploy workflow changed permanently: Claude always creates a PR (dev → master), user clicks Merge on GitHub. No more direct pushes to master. Documented in CLAUDE.md.
- [x] Quick Quote builder: tier toggle moved above service checkboxes; Combined/Separate line items toggle added to Customer Quote section (hides in Receipt mode). PR #13.
- [x] Lead cards: entire card is now clickable to open the lead (click anywhere except action buttons/links). PR #14.
- [x] Phase 7B fixes (merged to dev and master via PR #8): blog page fix (infinite redirect loop on live site); modern inline calendar widget on customer accept page (replaces native selects — month nav, day grid, Sundays blocked, Sat 3pm cutoff, submit blocked until both date+time picked); dynamic admin URL in alt-times emails (no longer hardcoded to brakeknights.com); admin favicon now live on master.
- [x] Phase 7B (previous batch, merged to dev): remove "(not taxed)" label from labor line in quote builder; alt-times form date/time replaced with select dropdowns (no Sundays, business-hour slots); per-service warranty language in quote emails (rotors/drums = full warranty, pads-only = labor warranty, inspection/fluid = none); removed em dashes from scheduling flow; scheduling panel hides Approve/Deny after alt times sent (shows amber waiting state instead); alt time options in customer email are clickable token-based buttons.
- [x] Quick Quote additions (merged to dev): custom service open-text field (combinable with brake services for non-standard jobs); save draft to DB to resume later without rebuilding.
- [x] Phase 7A: Quick Quote / Receipt Generator at `/admin/quick` (standalone, not bound to a lead) — quote/receipt mode switch, service multi-select + tier toggle with live auto-fill, live recalc; quote outcomes (calculator-only/erase, Send + create lead, copyable quote link with Copy button), Save as New Lead; receipt mode (vehicle/date/payment/address, advisories + timed follow-ups, office notes) Send or Save; "Quick Quote" topbar nav link. Merged to dev.
- [x] Phase 7A refinements (round 2): delete lead button (cascade-delete all records permanently); receipt address Google Maps autocomplete; advisory reminder: replaced time-period dropdown with direct date picker, no pre-fill; quick quote receipt mode: removed "Save as New Lead" button; email button on lead list/detail now copies address to clipboard on click (fixes desktop where no email client); receipt builder: 1 advisory shown + 3 hidden + Add Advisory button; quick quote: same advisory 1+Add pattern; quick quote POST handler updated to use direct date for followups; Preview Email button on quick quote page (both quote and receipt modes); auto-save localStorage (navigate away and back restores form); "Clear & Start Over" replaces old Clear button.

### Previously Completed This Session
- [x] Phase 5: receipt form + branded receipt email + lead auto-completes; receipts + followups tables; Phase 6 follow-up reminder cron in server.js; "Complete Job & Send Receipt" button on lead cards and quote page
- [x] CLAUDE.md guardrail: forbid GitHub MCP workaround when master push is blocked (user is the only one who completes master merges)
- [x] Merged pricing updates + quote display polish (5 commits) from dev → master via PR #3/#4

### Previously Completed This Session
- [x] Pricing decisions confirmed by owner: Brake Fluid Flush single-tier (no premium); Drums and Shoes + "Front Pads, Rotors, and Drums and Shoes" standard-only (no premium); Brake Inspection flat $60 no tax; Caliper Replacement + Brake Hose Replacement stay custom-quote permanently (no preset pricing)
- [x] Google Maps API key created + restricted (HTTP referrers to brakeknights.com domains, Maps Platform APIs); Maps JavaScript API + Places API enabled; GOOGLE_MAPS_API_KEY set in Hostinger for dev + prod. Address autocomplete confirmed working on dev (and live by same project/key).
- [x] Deployed Phase 3 + pricing + soft-archive batch to master via PR #2 (live on brakeknights.com)
- [x] Removed the customer quote-acceptance auto-reply email (one fewer customer email): on-screen confirmation covers it, branded confirmation still sends after owner approves; owner notification unchanged
- [x] Quote email: moved "Accept Quote & Choose Your Time" CTA directly under the total so Gmail no longer hides it behind "show trimmed content"
- [x] Soft archive for leads: Archive button per card (confirm), Restore button + Archived tab, search still spans archived; preserves quote/service history for the CRM
- [x] Google Places address autocomplete on the customer accept page Service Address field — code complete, gated behind GOOGLE_MAPS_API_KEY (plain text until the key is set)
- [x] Phase 3: auto-populate quote prices on load; hide Standard/Premium tier wording from customer email
- [x] Phase 3: "Add to Calendar" (.ics) link in confirmation email (Apple/Google/Outlook); per-service block-off durations from pricing.js `minutes`
- [x] Phase 3: Approve/Deny appointment from admin (lead page + Quote Accepted list cards)
- [x] Phase 3: branded appointment reminder emails at T-24h and T-2h (independent of Square plan)
- [x] Lowered sales tax 7% → 6% (VA state); all new quotes recompute at 6%
- [x] Pricing update: shop supplies $10 across both tiers; Brake Fluid Flush ($155 labor + $10 supplies, single tier); Brake Inspection flat $60 (no tax) with conditional-fee note in quote email; Caliper/Hose/"Not Sure" marked custom-quote; Drums and Shoes + Front Pads/Rotors/Drums combo are standard-only (premium falls back to standard in the tool)
- [x] Phase 2: auto-create Square customer when contact form is submitted — live on master
- [x] Square Developer setup complete — sandbox + production credentials generated
- [x] Square env vars saved in Hostinger hPanel for brakeknights.com
- [x] Install Square Node.js SDK (`square` npm package)
- [x] Create `square.js` connection module — SquareClient initialized from env vars
- [x] Add `GET /api/square/verify` endpoint — confirms Locations + Bookings API connectivity
- [x] Verify endpoint confirmed working on live site: both APIs return "ok" in production
- [x] Full platform build plan documented (Phases 2-9)
- [x] Add "Preferred Contact Method" dropdown (Call, Text, Email) to both contact forms — live on master
- [x] Style select dropdown to match other form fields
- [x] Add dev-vs-master pending commit check to session startup hook
- [x] Add "go skill" keyword: merges tooling changes to both dev and master in one shot
- [x] Add screenshot skill: scripts/screenshot.js + .claude/skills/screenshot/SKILL.md
- [x] Install Playwright Chromium via session startup hook — no more mid-task downloads
- [x] Remove rotor-caliper image from brake inspection page (mobile rotation issue — tabled for better photo)
- [x] Set up "go master" override keyword in pre-push hook
- [x] Launch brakeknights.com — new Node.js site deployed from master branch via Hostinger
- [x] Set SMTP_PASS env var on brakeknights.com Hostinger deployment
- [x] Fix email DNS records on brakeknights.com (SPF/DMARC via "Connect automatically")
- [x] Verify Google Search Console for brakeknights.com (DNS TXT record)
- [x] Submit sitemap to Google Search Console

### Previously Completed
- [x] Add 3 worn rotor photos to brake pad/rotor replacement page (5-photo grid, 3-column layout); deployed to dev
- [x] Add 2 mobile service photos to About page ("Mobile Service in Action" section); deployed to dev
- [x] Add hero background photo (driveway + van-tools images) to all service and location pages via .page-hero CSS; deployed to dev
- [x] Fix caliper photo display: portrait images now use object-fit:contain at 360px with navy bg; deployed to dev
- [x] Fix browser cache for all rotated images: added ?v=2 to brembo, rotor, and 4 caliper image srcs
- [x] Fix browser cache for CSS: bumped styles.css to ?v=3 across all 45 pages; deployed to dev
- [x] Add Cache-Control: no-cache for /images in server.js
- [x] Add Cache-Control: no-cache for /css in server.js
- [x] Update copyright to 2026 across all 45 pages
- [x] Rewrite homepage H1: "Based Out of Sterling..." → "Mobile Brake Repair Across Northern Virginia"
- [x] Rewrite homepage hero body copy: removed duplication, added warranty mention, fixed em dash to colon
- [x] Add no-em-dash rule to CLAUDE.md
- [x] Update brake inspection checklist wording: rotor surface condition, caliper assessment of functionality
- [x] Fix Hours of Valor icon on contact page: chess knight → clock (was missed in previous session)
- [x] Replace sword emoji with favicon logo image in notification and confirmation emails
- [x] Rotate new-rotor.jpeg 90 degrees clockwise
- [x] Rotate all 4 caliper photos 90 degrees clockwise (seized-caliper-melted-pads, seized-caliper-removed, cracked-caliper-piston, caliper-piston-seal-torn)
- [x] Shorten all figcaptions site-wide: single line, no em dashes (caliper, inspection, pad/rotor, homepage)
- [x] Add 5 new job photos: worn-rotor-rusted-hub, worn-rotor-grooved-edge, new-rotor-installed-hub, mobile-service-job-driveway, mobile-service-van-tools
- [x] Update desktop hero background to mobile-service-job-driveway.jpeg
- [x] Add mobile hero background: mobile-service-van-tools.jpeg at 99.99% size, cover on mobile

### Previously Completed
- [x] iOS "Allow Phone" dialog fix — format-detection meta added to all 45 pages, all tel: links converted to E.164 (+1) format, Google Maps iframes replaced with click-to-load on index.html and contact.html; deployed to dev
- [x] Add custom brake warning light icon (SVG) — replaces fa-flask across all 45 pages; deployed to dev
- [x] Add real work photos to 3 service pages (caliper, rotor, inspection) and homepage
- [x] Fix inspection page hero buttons — Call primary, Request Service outline, correct order
- [x] About hero armor stamp — removed from scope
- [x] Homepage hero CTA redesign — removed from scope
- [x] About page mobile fix — reduced tale-section title (64px→2.4rem) and body text on mobile
- [x] Remove "written report" references — scrubbed from 35 files site-wide
- [x] Replace all emojis with Font Awesome icons — 27 emoji types replaced across 45 files, FA served locally
- [x] Fix all em dashes site-wide — replaced with correct punctuation
- [x] Hero badge icon — using favicon.png (helmet + rotor logo icon)
- [x] Fix btn-secondary missing CSS — "Request Service" button was unstyled on all service pages
- [x] Fix hero CTA button text — "Call 703-977-4475" → "Call Us" on all service pages

### Previously Completed
- [x] Hero subtitle size — settled at 2.6rem
- [x] Van hero background on mobile — decided to keep hidden (16:9 image doesn't suit portrait mobile)
- [x] `dev` git branch set up — Hostinger auto-deploys from it, Node 22, stable
- [x] Fix deployment reversion — added `engines: node>=22` to package.json, exclude `.claude/` from archive
- [x] Set `SMTP_PASS` env var in Hostinger hPanel ✅
- [x] Contact form emails working — internal notification to greetings@brakeknights.com
- [x] Customer confirmation email — branded, quote inquiry framing, tested working both ways
- [x] Subject line — removed phone number, now just "New Service Request: First Last"

### Previously Completed
- [x] Van photo added to homepage hero — `/images/van.jpg`, 16:9 crop, cover sizing, 18% opacity, hidden on mobile
- [x] Hero badge — Option B (solid blue bg, navy text)
- [x] Hero subtitle added — "We Come To You, At Your Home or Office!" — 2.6rem
- [x] Hero text improved — larger h1, brighter paragraph text, text shadows for legibility
- [x] Hero gradient overlay — darkens left side for text contrast

### Previously Completed
- [x] Rebuild homepage
- [x] Add real photos (hero + why-choose section)
- [x] Fix colors to royal blue brand
- [x] Fix warranty language everywhere
- [x] Build all subpages (about, contact, services, location, legal)
- [x] Build 6 service detail pages
- [x] Build 32 location pages (synced to live site — added Oakton, Fairfax City, Fairfax Station, Annandale, Merrifield, Clifton; removed Woodbridge, Lorton, Dale City)
- [x] Rewrite About page with authentic knight-themed content
- [x] Add Google Map embed to homepage
- [x] Add live Google Reviews section to homepage (Elfsight widget, ID: 76cf70b9-2bf0-4d45-a110-c5e3b0e7de57, confirmed working on dev)
- [x] Add comprehensive SEO improvements (schema, canonical, OG tags, NAP, FAQ schema, BreadcrumbList)
- [x] Fix mobile hamburger menu (was broken — now opens/closes with collapsible submenus)
- [x] Add knight-on-horse background image to homepage hero (100% auto, 32% opacity)
- [x] Context usage indicator — confirmed built-in (small circle, bottom-right, hover to see %)
- [x] Fix Location nav dropdown: trimmed to 10 cities (Purcellville first), removed "View All Areas" button (Safari overlap bug)
- [x] Sync areaServed schema across all 45 pages to match current 32-city service area
- [x] Wire contact forms to send email via nodemailer/Hostinger SMTP — both index.html and contact.html POST to /api/contact; server.js sends branded HTML email to greetings@brakeknights.com
- [x] Fix stale nearby-area links: /brake-repair-fairfax → /brake-repair-fairfax-city (Burke, Centreville, Springfield, Vienna)
- [x] Fix broken links to deleted pages — Springfield & Alexandria → Annandale; Manassas → Gainesville
- [x] Fix Services page footer — added missing mailto: link

## Contact
greetings@brakeknights.com
