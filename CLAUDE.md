# Brakeknights Project

## Overview
Website and customer portal for Brakeknights (brakeknights.com).
Built with Node.js/Express, deployed on Hostinger.

## Key Facts
- Live site at **brakeknights.com** was built using **Hostinger's website builder** — not code-based
- The GitHub repo is a new code-based version being developed separately
- Live site must never be broken — always preview on dev first

## Branch & Deployment Workflow
- `dev` branch → **auto-deploys to dev.brakeknights.com** via Hostinger git integration (Branch: dev, Node 22) — just push to `dev` and it deploys automatically
- `master` branch → deploys to **brakeknights.com** (live site)
- All changes go on feature branch first. Only merge to `dev` when user approves. Only merge to `master` when user approves.
- Never push directly to `master` without explicit user approval.
- **Deployment note:** Hostinger git auto-deploy is configured to watch the `dev` branch. Pushing to `dev` triggers deployment. Archive uploads also work but git push is simpler. SMTP_PASS env var is already set in Hostinger for dev.brakeknights.com.

## Hostinger MCP
A Hostinger MCP server is configured in `.mcp.json`.
It allows direct management of Hostinger hosting from Claude Code.
The API token is entered securely at session start — never hardcode it.

## Project Structure
- `server.js` — Express server, reads PORT from environment
- `public/index.html` — frontend HTML
- `package.json` + `package-lock.json` — Node.js dependencies

## Screenshots with Playwright
⛔ HARD RULE: ALWAYS use `locator().scrollIntoViewIfNeeded()` to scroll before screenshots. NEVER use `window.scrollTo()` or `offsetTop` — headless Playwright does not guarantee the scroll fires before the capture, causing screenshots of the wrong section. This wastes the user's time and is not acceptable.

✅ CORRECT pattern — use this every time:
```javascript
const el = page.locator('#section-id'); // or any CSS selector
await el.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/screenshot.png' });
```

❌ NEVER do this:
```javascript
const y = await page.evaluate(() => document.querySelector('#id').offsetTop);
await page.evaluate(y => window.scrollTo(0, y), y); // unreliable in headless mode
```

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
- Current feature branch: `claude/determined-euler-N4DKp`

## Current Work in Progress
Update this section at the end of each session to stay caught up next time.

- Working branch: `claude/determined-euler-N4DKp`
- `dev` branch is live at dev.brakeknights.com — auto-deploys on every push to `dev` ✅
- Form emails fully working: internal notification + customer confirmation ✅
- All QA fixes from this session are pushed to dev and confirmed working
- Next steps:
  1. User to finish manual mobile checklist items (hamburger menu, spot-checks, legal pages)
  2. Upload 5 phone photos and add to site
  3. Once all approved → merge to master

## Pre-Launch Checklist (Before Merging to Master)

### Functional
- [x] Submit a test contact form on dev — confirm internal notification arrives at greetings@brakeknights.com
- [x] Submit a test contact form on dev — confirm customer confirmation email arrives
- [x] Click every nav link (desktop + mobile) — no 404s (all 45 pages return 200)
- [x] Click every footer link — no 404s
- [ ] Test mobile hamburger menu on a real phone — opens, closes, submenus expand/collapse

### Content Accuracy
- [ ] Phone number (703-977-4475) in header and footer — correct
- [ ] Phone number does NOT appear inside CTA buttons (all say "Call" now — confirm on real device)
- [ ] Service area list on site matches the actual 32 cities served
- [ ] Legal pages (privacy policy, terms) — no placeholder or dummy text

### Visual / Rendering
- [ ] Spot-check homepage on mobile — layout, text size, images all correct
- [ ] Spot-check one service page on mobile — buttons styled, no broken layout
- [ ] Spot-check one location page on mobile — looks correct
- [x] Font Awesome icons rendering correctly — 40 icons confirmed rendering on homepage
- [x] Google Reviews widget showing on homepage
- [x] All content icons updated to royal blue site-wide (service, why, pillar icons)
- [x] Value props icons: unique icons, royal blue color
- [x] Pricing table: aligned, "Starting at $X" format, correct wait times

### Technical
- [x] Browser console on homepage — no real JS errors (2 HTTPS cert warnings are localhost-only, resolve on live site)
- [x] Canonical tags point to `brakeknights.com` (not `dev.brakeknights.com`) — all 45 pages confirmed
- [x] `sitemap.xml` exists and lists all major pages — created, serving correctly
- [x] `robots.txt` exists and is correct — created, serving correctly
- [x] Homepage title/meta fixed — was "Sterling, VA", now "Northern Virginia" across title, description, OG, and Twitter tags
- [x] Google Maps embed fixed — removed loading=lazy (was blocking map on mobile)
- [x] iOS auto-call block fixed — pointer-events:none on FA icons inside tel: links
- [x] All call buttons say "Call" only — no phone number inside buttons (header is the only exception)
- [x] Book Inspection button fixed — now links to /contact instead of tel:
- [x] CSS cache-busting added — styles.css?v=2 across all 45 pages
- [x] Stale PR #1 closed — was incorrectly targeting master instead of dev

### SEO
- [ ] Homepage JSON-LD schema passes Google's Rich Results Test
- [x] Homepage title/description/OG/Twitter all say "Northern Virginia" (not "Sterling, VA")

---

## To-Do List
⚠️ Single source of truth. Update every time an item is completed or added.

### Pending
- [ ] Fix price comparison table on homepage — update to match the corrected prices/wait times already done on services page (Starting at $X format, BK: 1-2hr, Shop: 2-4hr, Dealer: 3-5hr)
- [ ] Upload 5 phone photos and add to the site
- [ ] Automated quote system — vehicle tier pricing, auto-stop rules, quote delivery via email (tabled — pricing structure discussion ready to resume)
- [ ] Merge dev → master (once remaining items complete)

### Completed This Session
- [x] About hero armor stamp — removed from scope
- [x] Homepage hero CTA redesign — removed from scope
- [x] About page mobile fix — reduced tale-section title (64px→2.4rem) and body text on mobile, pushed to dev
- [x] Remove "written report" references — scrubbed from 35 files site-wide, pushed to dev
- [x] Replace all emojis with Font Awesome icons — 27 emoji types replaced across 45 files, FA served locally
- [x] Fix all em dashes site-wide — replaced with correct punctuation (colon, comma, semicolon, period) in all content; title separators left intact
- [x] Hero badge icon — using favicon.png (helmet + rotor logo icon) instead of chess knight or emoji
- [x] Fix btn-secondary missing CSS — "Request Service" button was unstyled on all service pages
- [x] Fix hero CTA button text — "Call 703-977-4475" → "Call Us" on all service pages (number belongs in header only)
- [x] Pre-launch QA checklist created and partially completed
- [x] Homepage SEO fixed — title/meta/OG/Twitter all changed from "Sterling, VA" to "Northern Virginia"
- [x] sitemap.xml created — all 45 pages listed
- [x] robots.txt created — points to sitemap
- [x] Google Maps fix — removed loading=lazy so map loads on mobile
- [x] Book Inspection button — fixed href from tel: to /contact
- [x] iOS auto-call block — fixed with pointer-events:none on FA icons inside links
- [x] All call buttons changed to "Call" only across 42 files (header still shows full number)
- [x] Value props icons — fixed duplicate shield (→ handshake), brightened to royal blue
- [x] All content icons updated to royal blue site-wide (service-icon, why-icon, pillar-icon, service detail headings)
- [x] CSS cache-busting — styles.css?v=2 added across all 45 pages
- [x] Pricing table fixed — aligned, "Starting at $X", updated wait times (BK: 1-2hr, Shop: 2-4hr, Dealer: 3-5hr)
- [x] Screenshot rule locked in CLAUDE.md — must use scrollIntoViewIfNeeded() always
- [x] Stale PR #1 closed — was incorrectly targeting master directly

### Previously Completed This Session
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
