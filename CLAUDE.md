# Brakeknights Project

## Session Startup Checklist (Run These First, Every Session)
1. `git config core.hooksPath .githooks` — activates the master push block
2. `git branch --show-current` — confirm you are on `claude/loving-cerf-c6lME` (or the current feature branch); if not, switch: `git checkout claude/loving-cerf-c6lME`

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
- Current feature branch: `claude/loving-cerf-c6lME`

## Current Work in Progress
Update this section at the end of each session to stay caught up next time.

- Working branch: `claude/loving-cerf-c6lME` — in sync with `dev` ✅
- `dev` branch is live at dev.brakeknights.com — auto-deploys on every push to `dev` ✅
- Form emails fully working: internal notification + customer confirmation ✅
- Pre-push hook in place — direct pushes to `master` are now blocked at the git level ✅
- Images and CSS now served with `Cache-Control: no-cache` — stale browser cache is a solved problem ✅
- CSS version is at `?v=3` across all 45 pages
- **Pre-launch checklist: ALL ITEMS COMPLETE** ✅
- Next steps:
  1. Final review on dev.brakeknights.com (contact form, JSON-LD via Google Rich Results Test, browser console)
  2. Merge dev → master via GitHub UI when approved

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
- [ ] Final review on dev.brakeknights.com before merging to master (contact form, JSON-LD Rich Results Test, console check)
- [ ] Merge dev → master via GitHub UI
- [ ] Automated quote system — vehicle tier pricing, auto-stop rules, quote delivery via email (tabled — pricing structure discussion ready to resume)

### Completed This Session
- [x] Rotate rotor-caliper.jpeg 90 degrees clockwise on brake inspection page
- [x] Fix homepage area list: added 8 missing cities (Annandale, Burke, Springfield, Oakton, Merrifield, Fairfax City, Fairfax Station, Clifton)
- [x] Fix JSON-LD schema: moved Brake Inspection price to outer Offer, added image property to AutoRepair schema
- [x] Increase mobile hero photo opacity to 0.35, background-size to cover, remove forced min-height on mobile
- [x] Complete all pre-launch checklist items

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
