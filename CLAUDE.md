# Brakeknights Project

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

The "go master" and "go skill" override keywords are retired. The pre-push hook and GitHub ruleset remain in place as protection, but the PR workflow is the only path to master going forward.

**If the user asks Claude to push to master directly:** decline and create a PR instead.

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
- Current feature branch: `claude/busy-ritchie-GuJOH` (Phase 7A refinements round 2)

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

**Phase 7:** Full CRM dashboard at `brakeknights.com/admin` — customer profiles, vehicle history, job history, upcoming follow-ups, all owned by Brake Knights.

**Phase 7A (complete — Quick Quote / Receipt Generator):** A standalone generator on the dashboard at `/admin/quick`, not bound to any lead, for fast phone/text inquiries. Reuses the existing pricing engine, service multi-select + tier toggle, live auto-calc, and branded quote/receipt templates. "Quick Quote" link added to the admin topbar nav. Built entirely in `routes/admin.js` (`GET`/`POST /admin/quick`), reusing `buildQuoteEmail` / `buildReceiptEmail`. On dev, not yet on master.
- **Implemented:** Quote/Receipt mode switch on one screen; service multi-select + tier toggle with live auto-fill from the pricing table; any field overridable, total recalcs live. Quote outcomes: (1) calculator only (Clear, nothing saved); (2) Send (create "Quick Quote" lead in Quoted stage, save quote, email branded quote with accept link); (3) Copyable link (create lead + quote + token, return result page with the customer quote URL + one-tap Copy button); plus Save as New Lead (no email). Receipt mode mirrors the receipt builder: vehicle/date/payment(+Other)/address, 4 advisories with timed follow-up reminders, office notes; Send Receipt (emails, advances lead to Receipt Sent + writes followups) or Save as New Lead.
- Original spec (for reference):
- **Quote/Receipt mode switch** on one screen; usable on the front end (brand-new) or back end (within an existing lead). Pick services + tier, override any number, total recalcs live (for reading off on the phone).
- **Three outcomes:** (1) calculator only — nothing saved, can be erased; (2) send to customer — enter first/last name + email → creates a lead (source "Quick Quote") in the Quoted stage, saves the quote, emails the branded quote with the accept link; (3) copyable shareable link — creates the lead + quote + token and returns the customer-facing branded quote URL the owner copy-pastes into their own texting app.
- Also: option to save as a new lead without sending.
- **SMS note:** in-app text sending needs an SMS provider (Twilio etc.) — not wired yet. For text inquiries, use email or the copyable link for now. Real in-app SMS is its own later phase.

**Phase 8:** Automated quotes — instant quote emails based on vehicle type and service selected (requires pricing table to be finalized first).

**Phase 9:** White-label packaging — multi-tenant architecture, per-brand configuration, reseller infrastructure for other service businesses.

### Current Customer Flow (for context)
- Customer calls/texts → verbal price + schedule discussion → owner books in Square → Square sends confirmation (date/time only, no price)
- Customer submits form → owner replies by email with price → customer confirms → owner books in Square → Square sends confirmation (date/time only, no price)
- Payment: credit card via Square POS app on phone; cash/Zelle recorded manually in Square for sales tracking

## Current Work in Progress
Update this section at the end of each session to stay caught up next time.

- Last working branch: `claude/funny-ritchie-atzTm` — Phase 7B fixes (merged to dev and master via PR #8 ✅)
- `dev` branch → dev.brakeknights.com (auto-deploy on push) ✅
- `master` branch → brakeknights.com (live site, auto-deploy on push) ✅ — **site is live**
- Phases 2, 3, 4, 5, 6, 7A, 7B all complete and live on master. Includes: receipt builder, follow-up reminders + dashboard, Quick Quote / Receipt Generator at `/admin/quick`, delete lead, advisory date picker, preview email, auto-save localStorage, 1+Add advisory pattern, email-copies-clipboard, Maps autocomplete, nav active states, SQLite session store, blog fix, modern calendar widget on accept page, dynamic admin URL in emails, admin favicon.
- dev and master are in sync.
- `brakeknights-crm` skill installed at `.claude/skills/brakeknights-crm/SKILL.md` — load at the start of every CRM session for full project context ✅
- Pre-push hook in place — direct pushes to `master` blocked; override with "go master" keyword ✅
- "go skill" keyword added — pushes tooling-only changes to both dev and master in one shot ✅
- Session startup hook shows pending dev-vs-master commits at session start ✅
- Screenshot skill in place — `node scripts/screenshot.js [path] [selector]` ✅
- Square SDK installed, `square.js` module live, verify endpoint confirmed working on production ✅
- Square auto-booking code-complete but blocked by Square Appointments subscription tier (403 on bookings.create until paid plan active) ✅
- Next steps:
  1. Phase 7: full CRM dashboard (customer profiles, vehicle history, job history)
  2. Decide on Square Appointments paid plan (Plus/Premium) to turn on live auto-booking
- Follow-up reminder testing note: the Phase 6 cron fires every 6 hours (not instantly). To test a reminder: set a follow-up date to today, then wait for the next cron run (check server logs for "follow-up cron" entries). On dev, the cron fires on the dev server; on master, it fires on the live server. Don't test on master with real customer leads.

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
- [ ] Phase 2: auto-create Square customer when contact form is submitted
- [ ] Phase 3: owner quote tool — enter service + price + time, fire branded quote email
- [ ] Phase 4: branded booking confirmation email (service, price, date, time, address)
- [ ] Phase 7: admin CRM dashboard at brakeknights.com/admin
- [ ] Phase 6C: Square auto-trigger (Square events fire receipt + follow-up flow) — deferred, spec later
- [ ] Phase 8: automated quotes (requires pricing table to be finalized)
- [ ] Phase 9: white-label packaging for other service businesses
- [ ] Add a good rotor-caliper photo to brake inspection page (tabled — image rotation issue on mobile)
- [ ] Vehicle year/make/model cascading dropdowns on contact forms (replace free-text vehicle field) — use NHTSA free API (vpic.nhtsa.dot.gov) for model lookup, no data to maintain; tackle after Phase 3B/3C
- [ ] Finalize pricing table by vehicle type (required before Phase 8) — flat pricing today; Phase 8 needs per-vehicle-class matrix
- [ ] Review/update existing service prices — owner flagged that "some service prices need updating". Walk through the pricing table tier by tier and update any that changed. (IN PROGRESS)
- [ ] CRM improvement: tag submission source (homepage vs contact page) in Square customer note
- [ ] CRM improvement: replace flat note field with structured data fields once Phase 7 CRM is built
- [ ] CRM improvement: add visible alert/logging if Square customer sync fails on a form submission
- [ ] Customer auto-nudge: if a sent quote has not been accepted after X hours, automatically send the customer a gentle follow-up email ("Just checking in — your quote is still available"). Currently manual; add as opt-in feature once Phase 3D is tested in production.
- [ ] Set up email forwarding: greetings@brakeknights.com → personal Gmail for instant push notifications (currently 2-5 min IMAP delay)

### Completed This Session
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
