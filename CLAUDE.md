# Brakeknights Project

## Session Startup Checklist (Run These First, Every Session)
1. `git config core.hooksPath .githooks` — activates the master push block
2. `git branch --show-current` — confirm you are on `claude/gallant-ptolemy-9gZLb` (or the current feature branch); if not, switch: `git checkout claude/gallant-ptolemy-9gZLb`

## Master Branch Protection (Two Layers)
Master is protected by two independent layers. Do not weaken or remove either without explicit user approval.

**Layer 1: GitHub ruleset (server-side, primary).**
A repository ruleset named "Protect master" targets the `master` branch on GitHub itself. It blocks direct pushes by non-admins, force pushes, and branch deletion. It cannot be bypassed locally (`--no-verify` does not affect it) and applies no matter what branch a session starts on. The repo owner (Repository admin) is on the bypass list, so the owner can still push directly to master to deploy. Confirm status anytime with `list_branches` — master reports `"protected": true`.

**Layer 2: local pre-push hook (catches accidental admin pushes).**
`.githooks/pre-push` blocks all pushes to master by default and is activated each session by `git config core.hooksPath .githooks` (run by the session-start hook). This is the safety net for the one gap Layer 1 leaves open: the owner accidentally pushing to master.

## Master Push Override
The pre-push hook blocks all pushes to master by default.
To override: user says **"go master"** in chat. Claude then runs the push with `MASTER_OVERRIDE="go master"` set as an env var. (This satisfies Layer 2; Layer 1 is satisfied separately by the owner's admin bypass.)

**If the git push fails (e.g. 403 from GitHub's branch protection): STOP. Do NOT create a PR, do NOT use the GitHub MCP to merge, do NOT find any other workaround. Report the failure and wait for the user to complete the merge themselves. The user is the only one who completes merges to master — Claude only initiates the push attempt.**

## Skill/Tooling Push Override
For changes that are dev tooling only (skills, hooks, scripts — nothing that affects the live site):
User says **"go skill"** in chat. Claude merges the feature branch to BOTH `dev` and `master` in one operation, using `MASTER_OVERRIDE="go skill"`.
No dev preview needed for tooling-only changes.

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
- All changes go on feature branch first. Only merge to `dev` when user approves. Only merge to `master` when user approves.
- Never push directly to `master` without explicit user approval.
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
- Current feature branch: `claude/dazzling-planck-U9GXQ`

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

**Phase 2 (current — in progress):** When a customer submits the contact form, automatically create or find them as a Square customer. Foundation of the CRM.

**Phase 3:** Quote tool — owner enters service + price + proposed time, system sends a branded quote email to the customer.

**Phase 4:** Booking confirmation — once price/time agreed, owner books in Square, our system sends a full branded confirmation email: service, price, date, time, address.

**Phase 5:** Job summary + custom receipt — after payment, owner triggers a branded receipt with a proper Technician Notes section (Square's native receipt has no custom notes section).

**Phase 6:** Follow-up automation — notes entered on the job summary trigger timed reminder emails to owner and customer (e.g. "rear brakes have 6 months left" → reminder email sent at that time).

**Phase 7:** Full CRM dashboard at `brakeknights.com/admin` — customer profiles, vehicle history, job history, upcoming follow-ups, all owned by Brake Knights.

**Phase 8:** Automated quotes — instant quote emails based on vehicle type and service selected (requires pricing table to be finalized first).

**Phase 9:** White-label packaging — multi-tenant architecture, per-brand configuration, reseller infrastructure for other service businesses.

### Current Customer Flow (for context)
- Customer calls/texts → verbal price + schedule discussion → owner books in Square → Square sends confirmation (date/time only, no price)
- Customer submits form → owner replies by email with price → customer confirms → owner books in Square → Square sends confirmation (date/time only, no price)
- Payment: credit card via Square POS app on phone; cash/Zelle recorded manually in Square for sales tracking

## Current Work in Progress
Update this section at the end of each session to stay caught up next time.

- Working branch: `claude/dazzling-planck-U9GXQ` — in sync with `dev` and `master` ✅
- `dev` branch → dev.brakeknights.com (auto-deploy on push) ✅
- `master` branch → brakeknights.com (live site, auto-deploy on push) ✅ — **site is live**
- Form emails fully working on both dev and live: internal notification + customer confirmation ✅
- Pre-push hook in place — direct pushes to `master` blocked; override with "go master" keyword ✅
- "go skill" keyword added — pushes tooling-only changes to both dev and master in one shot ✅
- Session startup hook shows pending dev-vs-master commits at session start ✅
- Screenshot skill in place — `node scripts/screenshot.js [path] [selector]` ✅
- Playwright Chromium installed by session hook — no mid-task download delays ✅
- Google Search Console verified (DNS TXT record) and sitemap submitted ✅
- Images and CSS served with `Cache-Control: no-cache` ✅
- CSS version is at `?v=3` across all 45 pages
- Square SDK installed, `square.js` module live, verify endpoint confirmed working on production ✅
- Square auto-booking (Approve → create calendar booking) is **code-complete and validated end-to-end in sandbox** ✅
  - Location + team member now auto-discovered per environment (sandbox vs production), so no code change needed when production upgrades — see `getSquareLocationId` / `getSquareTeamMemberId` in `routes/admin.js`
  - Fixed `catalog.upsert` → `catalog.object.upsert` (correct path for the installed Square SDK)
  - **Only remaining blocker is the Square Appointments subscription tier.** Both sandbox (free) and production (free) return 403 "Merchant subscription does not support write operations" on `bookings.create`. The feature works the moment a paid Appointments plan (Plus/Premium) is active — no further code changes.
  - The Approve action lives only as a link in the customer-acceptance email (`routes/quote.js`), not in the admin UI — possible future improvement: add an Approve button on the lead page.
- Next steps:
  1. Decide on Square Appointments paid plan (Plus/Premium) to turn on live auto-booking, or keep manual booking
  2. Add a good rotor-caliper photo to the brake inspection page (tabled — image rotation issue)

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
- [ ] Phase 5: branded job summary + custom receipt with Technician Notes section
- [ ] Phase 6: follow-up automation from job notes (timed reminder emails)
- [ ] Phase 7: admin CRM dashboard at brakeknights.com/admin
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

### Completed This Session
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
