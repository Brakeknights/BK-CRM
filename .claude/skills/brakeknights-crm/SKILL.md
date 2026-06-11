---
name: brakeknights-crm
description: >
  Master context file for the Brake Knights CRM project. Use this skill at the
  start of every coding session involving the Brake Knights CRM, website, or any
  related code. Trigger whenever the user mentions Brake Knights, the CRM, admin
  routes, quotes, receipts, follow-ups, leads, Square, SQLite, or anything
  related to this project. Also use when the user asks about the tech stack,
  database schema, pricing logic, email flow, branch workflow, or deployment.
  This skill eliminates the need to re-explain the project each session.
---

# Brake Knights CRM — Master Context

## RULE #1 — Customer Data Protection (Always the Top Priority)
Protecting customer data is the number one rule for everything in this project. Customer PII (names, phones, emails, addresses, vehicles, job history) must never be exposed, leaked, or left vulnerable. Security comes before convenience, speed, or features. Defaults to always follow:
- Admin routes stay behind `requireAuth`; never add an unauthenticated route that returns customer data (only public path is the tokenized quote-accept flow).
- All SQL parameterized (`?`); dynamic column names only from a fixed code allowlist, never request input.
- HTML-escape all customer values with `esc()`.
- Secrets only in env vars; DB and `.env` gitignored; never hardcode/commit secrets.
- Do not weaken the security guards in `server.js` / `routes/admin.js`: production secret guard, hardened session cookie (`httpOnly`/`sameSite`/`secure`+`trust proxy`), login rate-limit + constant-time compare + session regeneration, and site-wide security headers.
- When unsure, pick the safer option for customer data and flag the trade-off to the owner (Alex).

## Business Overview
**Brake Knights** is a mobile brake repair service in Northern Virginia / Sterling /
Loudoun County. ASE-certified technicians travel to customers' homes or offices for
same-day brake service. Owner (Alex) is a non-developer building this CRM with
Claude's help. Always explain code changes in plain English. Never assume familiarity
with technical terms.

---

## Tech Stack

**Backend**
- Node.js (>=22) + Express 4
- `better-sqlite3` — synchronous SQLite; all DB calls are sync (no async/await)
- `express-session` + custom `SqliteStore` — sessions persisted in SQLite, survive restarts/deploys
- `nodemailer` — outbound email via Hostinger SMTP (`smtp.hostinger.com:465`, SSL), from `greetings@brakeknights.com`
- `square` SDK v44 — customer sync and (eventually) bookings
- `crypto` (Node built-in) — generates quote accept tokens

**Frontend**
- Plain HTML/CSS/JS — no framework, no build step
- Font Awesome (self-hosted)
- Google Maps JavaScript API + Places API — address autocomplete; gated behind `GOOGLE_MAPS_API_KEY`
- `localStorage` — Quick Quote form auto-save (client-side only)

**Database**
- SQLite (`data/brakeknights.db`) — single file, WAL mode, foreign keys ON
- Tables: `leads`, `quotes`, `lead_history`, `receipts`, `followups`, `sessions`
- Schema created idempotently via `CREATE TABLE IF NOT EXISTS` + migration helpers in `db.js`

**Hosting / Deployment**
- Hostinger git auto-deploy:
  - Push to `dev` → deploys to `dev.brakeknights.com`
  - Push to `master` → deploys to `brakeknights.com`
- Node 22 runtime on Hostinger
- Env vars in Hostinger hPanel: `SMTP_PASS`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `GOOGLE_MAPS_API_KEY`, `SQUARE_APP_ID`, `SQUARE_ACCESS_TOKEN`, `SQUARE_SANDBOX_APP_ID`, `SQUARE_SANDBOX_ACCESS_TOKEN`, `SQUARE_ENV`

**Auth**
- Single password (`ADMIN_PASSWORD` env var, default `brakeknights`)
- All `/admin/*` routes protected by middleware checking `req.session.admin`
- Cookie TTL: 8 hours

---

## Project Structure

```
/
├── server.js                  # Express entry: sessions, static files, contact API, cron
├── db.js                      # SQLite init, all CREATE statements, idempotent migrations
├── pricing.js                 # Service pricing table (parts, labor, shopSupplies, minutes, taxRate)
├── square.js                  # Square SDK init, verifyConnection(), createOrFindSquareCustomer()
├── datetime.js                # toEasternRfc3339() helper for Square API
├── sqlite-session-store.js    # express-session Store subclass backed by SQLite
├── routes/
│   ├── admin.js               # All admin UI (~2,400 lines) — leads, quotes, receipts, followups, quick quote
│   └── quote.js               # Customer-facing quote acceptance flow (~400 lines)
├── public/
│   ├── index.html             # Homepage
│   ├── contact.html, about.html, services.html
│   ├── css/styles.css
│   ├── brake-*.html           # 6 service detail pages
│   ├── brake-repair-*.html    # 32 location pages
│   └── blog/index.html
├── data/brakeknights.db       # SQLite DB file (gitignored)
├── scripts/screenshot.js      # Playwright screenshot helper
├── .githooks/pre-push         # Blocks pushes to master (bypassed with MASTER_OVERRIDE)
├── .claude/skills/            # Claude Code skill files
└── CLAUDE.md                  # Project instructions, phase history, workflow rules
```

---

## Database Schema

**`leads`** — Core customer/job record, one row per inquiry or quick-quote lead
- `id`, `created_at`
- `first_name`, `last_name`, `phone`, `email`
- `vehicle` (free text: year/make/model)
- `service`, `message`, `preferred_contact` (Call/Text/Email), `source`
- `status` — pipeline stage (see Business Rules)
- `square_customer_id`
- `status_updated_at`, `followup_sent`, `archived`, `archived_at`
- `vin`, `internal_notes` — added Phase 6

**`quotes`** — One quote per lead (one active at a time)
- `id`, `lead_id` (FK), `created_at`, `sent_at`
- `service`, `tier` (standard/premium)
- `price_parts`, `price_labor`, `shop_supplies`, `tax_rate`, `tax`, `total`
- `vin`, `internal_notes`
- `status` — draft/sent/accepted/approved/denied
- `accept_token` — UUID for customer accept URL
- `accepted_at`, `pref_date`, `pref_time`, `pref_location`, `scheduling_notes`
- `quote_followup_sent`, `reminder_24h_sent`, `reminder_2h_sent` — cron flags

**`lead_history`** — Append-only event log per lead
- `id`, `lead_id` (FK), `created_at`, `event`, `detail`

**`receipts`** — One row per receipt emailed to customer
- `id`, `lead_id` (FK), `quote_id` (FK nullable), `created_at`, `sent_at`
- `service`, `vehicle`, `service_date`, `service_address`
- `parts_labor`, `shop_supplies`, `tax`, `total`
- `payment_method`, `customer_notes` (JSON array of advisory strings), `office_notes`

**`followups`** — Timed follow-up reminders from receipt advisories
- `id`, `lead_id` (FK), `receipt_id` (FK nullable), `created_at`
- `description`, `due_date` (YYYY-MM-DD), `recipient` (owner/customer/both)
- `sent` (0/1), `sent_at`

**`sessions`** — SQLite-backed express sessions
- `sid`, `data` (JSON), `expires` (Unix ms timestamp)

---

## Phase History

| Phase | What Was Built |
|-------|---------------|
| 1 | Public website — 45 pages, contact form, email notifications, Hostinger deployment |
| 2 | Square customer upsert on contact form submit; `square_customer_id` stored on lead |
| 3+4 | Owner quote tool — service/tier picker, price auto-fill, quote email with accept token, customer accept page, owner Approve/Deny, confirmation email + .ics links, T-24h/T-2h cron reminders |
| 5 | Receipt builder — service performed, vehicle, date, address, payment method, up to 4 advisories, office notes, receipt email, auto-advance lead to Completed, follow-up storage |
| 6 | Follow-up reminder system — cron every 6h, `/admin/followups` dashboard, due/upcoming/sent sections, reschedule/done/cancel actions, topbar badge, ad-hoc reminders on lead pages. Round 2: receipt service multi-select + tier toggle + price auto-fill, VIN + Internal Notes card, Receipt Sent amber stage, clickable receipt preview link, full lead-history event logging, Text/Email action buttons |
| 7A | Quick Quote / Receipt Generator at `/admin/quick` — standalone tool for phone/text inquiries, quote/receipt mode switch, service multi-select + tier toggle, live price recalc, field overrides, three outcomes (calculator only / Send / Copy Link), receipt mode with Google Maps autocomplete, auto-save to localStorage, Preview Email button, nav active state, SQLite session store, inspection fee note |

**Current status: Phase 7A complete and live on master. Phase 7 (full CRM dashboard) not yet started.**

---

## Phase 7 (Full CRM Dashboard) — Planned, Not Started

- Customer profiles (all leads + jobs per customer, de-duped by email/phone)
- Vehicle history per customer
- Job history with receipt links
- Upcoming follow-ups per customer
- All data owned by Brake Knights (not relying on Square as source of truth)

---

## Key Business Rules

**Lead pipeline status flow:**
`new` → `quoted` → `quote_accepted` → `approved` → `completed` → `receipt_sent`
Plus: `archived` (soft-delete), `denied` (owner denied appointment)
- `receipt_sent` is amber — job done but receipt not yet sent
- Hard-delete (cascade) available via delete button — permanent

**Pricing logic (from `pricing.js`):**
- Tax = 6% Virginia rate, applied to `parts + shopSupplies` only (labor not taxed)
- `total = parts + labor + shopSupplies + tax`
- Services without a `premium` tier silently fall back to `standard`
- Services with `customQuote: true` (Caliper Replacement, Brake Hose Replacement, Describe Issue) have zero preset prices — owner enters manually
- Brake Inspection: flat $60, no tax (`shopSupplies: 0`); note about fee waiver shown in quote email and receipt if repairs are performed

**Quote accept flow:**
Owner sends quote → customer gets tokenized URL (`/quote/accept/:token`) → customer fills date/time/address → owner sees Accepted card → Approve or Deny → Approve fires confirmation email + .ics links + cron reminder flags set

**Follow-up cron:**
- Runs every 6 hours (not real-time)
- Queries `followups WHERE sent=0 AND due_date <= today`
- Fires owner alert and/or customer reminder emails
- Do not test on master with real customer data; use dev

**Dedup guard:**
Same first/last name + phone within 2 minutes → second contact form submission silently ignored

**Square:**
- Defaults to production when `SQUARE_ACCESS_TOKEN` present and `SQUARE_ENV` != `sandbox`
- Auto-booking code-complete but blocked by 403 — requires Square Appointments Plus/Premium
- Location ID and Team Member ID auto-discovered at runtime; hardcoded fallback IDs exist

---

## Established Patterns — Always Follow These

**No frontend framework.** All admin UI is server-rendered HTML strings in `routes/admin.js` using JS template literals. No React, no Vite, no template engine.

**Synchronous SQLite.** All DB calls are plain function calls — no `await`, no `.then()`.

**Idempotent migrations.** New columns added via `ALTER TABLE ADD COLUMN` guarded by `PRAGMA table_info` check. Never drop or rename columns.

**`esc()` for all user content in HTML.** Always HTML-escape DB values before interpolating into rendered pages.

**`money()` for display, raw numbers for form values.** `money(n)` uses `toLocaleString` with commas for display. Hidden inputs always use `Number.toFixed(2)` (no commas) so `parseFloat` works on POST.

**Email from `greetings@brakeknights.com` only.** Reply-to set to customer email on internal notifications so owner can reply directly.

**No em dashes in copy.** House style: use a colon, comma, or rewrite. Applies to HTML, email templates, and all copy.

**Branch workflow:**
- Feature branch → screenshot → wait for Alex's approval → merge to `dev` → wait for approval → merge to `master`
- Master protected by GitHub ruleset + `.githooks/pre-push`
- Override keywords: `"go master"` for direct push, `"go skill"` for tooling-only changes to both branches

---

## Known Issues / Architectural Decisions

| Issue | Status |
|-------|--------|
| Square auto-booking blocked (403) | Code complete; needs paid Appointments Plus/Premium plan |
| Flat pricing (no per-vehicle-class matrix) | Deferred until Phase 8; owner needs to finalize pricing by vehicle type |
| Single SQLite file | Fine for current scale; would need PostgreSQL for Phase 9 multi-tenant |
| No test suite | Accepted trade-off; visual checks via Playwright screenshots |
| Single admin password | Sufficient for sole owner; needs replacement before Phase 9 white-label |
| `routes/admin.js` is ~2,400 lines | Intentionally monolithic; refactor planned for Phase 9 |
| Session secret fallback | Falls back to dev string if `SESSION_SECRET` env var not set |

---

## Roadmap (Post Phase 7)

| Phase | Description |
|-------|-------------|
| 6C | Square webhook auto-trigger for receipt + follow-up when appointment marked done in Square POS |
| 8 | Automated quotes — instant email from vehicle type + service; requires per-vehicle-class pricing matrix |
| 9 | White-label packaging — multi-tenant architecture, per-brand config, reseller infrastructure |

**Other pending items:**
- Vehicle year/make/model cascading dropdowns (NHTSA free API)
- Customer auto-nudge if quote not accepted after X hours
- Email forwarding `greetings@brakeknights.com` → personal Gmail for push notifications
- Review and update service prices in `pricing.js`
- CRM improvements: tag submission source, structured data fields, Square sync failure alerting

---

## Communication Rules (Critical)

Alex is a small business owner, not a developer. Every coding session:
- Explain what each code change does in plain English before or after writing it
- State exactly where to paste code and what file it goes in
- Never assume knowledge of terms like "function," "variable," "array," "middleware," etc. without a brief explanation
- Flag anything that could break existing functionality
- Keep instructions step-by-step and actionable


---

## Available Skills

The following additional skills are available in this project. Load them when the task matches.

| Skill | File | When to use |
|-------|------|-------------|
| humanizer | `.claude/skills/humanizer/SKILL.md` | **Use automatically** whenever writing or editing any customer-facing copy: website pages, blog posts, Google Business Profile posts, email templates (quotes, receipts, confirmations, follow-ups, reminders). Load this skill before generating or revising any of that content — it defines the Brake Knights voice and rewriting rules. |
