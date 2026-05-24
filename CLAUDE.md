# Brakeknights Project

## Overview
Website and customer portal for Brakeknights (brakeknights.com).
Built with Node.js/Express, deployed on Hostinger.

## Key Facts
- Live site at **brakeknights.com** was built using **Hostinger's website builder** — not code-based
- The GitHub repo is a new code-based version being developed separately
- Live site must never be broken — always preview on dev first

## Branch & Deployment Workflow
- `dev` branch → auto-deploys to **dev.brakeknights.com** (sandbox/preview)
- `master` branch → auto-deploys to **brakeknights.com** (live site)
- All changes go on `dev` first. Only merge to `master` when the user approves.
- Never push directly to `master` without explicit user approval.

## Hostinger MCP
A Hostinger MCP server is configured in `.mcp.json`.
It allows direct management of Hostinger hosting from Claude Code.
The API token is entered securely at session start — never hardcode it.

## Project Structure
- `server.js` — Express server, reads PORT from environment
- `public/index.html` — frontend HTML
- `package.json` + `package-lock.json` — Node.js dependencies

## Screenshots with Playwright
- Always use `element.offsetTop` to scroll to a section — never `getBoundingClientRect().top + window.scrollY` (that value changes as the page scrolls and will land on the wrong section)
- Always use `offsetTop` pattern: `const y = await page.evaluate(() => document.querySelector('#section-id').offsetTop); await page.evaluate((y) => window.scrollTo(0, y), y);`
- Never merge to `dev` without explicit user approval — commit and push to the feature branch only

## Dev Workflow Rules — ABSOLUTE NON-NEGOTIABLE
⛔ STOP. READ THIS BEFORE EVERY PUSH. NO EXCEPTIONS. EVER.

1. ALL changes go to the feature branch ONLY (`claude/dreamy-noether-W8Mwi`)
2. After making changes: take a screenshot, show the user, then STOP and WAIT
3. Do NOT merge to `dev` until the user explicitly says "push to dev" or "approved"
4. Do NOT merge to `master` under any circumstances without explicit user approval
5. "I won't do it again" is not enough — CHECK THIS LIST before every single merge

THE WORKFLOW IS:
  feature branch → show screenshot → WAIT FOR APPROVAL → then merge to dev
  dev → WAIT FOR APPROVAL → then merge to master

There is NO shortcut. There is NO exception. Not even "just a small fix."
- Current feature branch: `claude/stoic-maxwell-n9CYe`

## Current Work in Progress
Update this section at the end of each session to stay caught up next time.

- Working branch: `claude/stoic-maxwell-n9CYe`
- Next steps:
  1. Hero badge: Option B (solid gold bg, navy text) is committed but not approved — user needs to pick Option A (dark backdrop, gold text) or Option B
  2. Van photo for hero: user wants to use it but couldn't share via iCloud. Ask them to try Imgur (imgur.com → upload → copy direct link) next session
  3. Fix About page on mobile: background photo too large, font too large and blurry
  4. Feature branch ready for review → merge to dev → then master

## To-Do List

### Completed
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

### Pending
- [ ] Decide on hero badge style (Option A vs B)
- [ ] Add van photo to homepage hero (need direct image URL)
- [ ] Fix About page on mobile: background photo too large, font too large and blurry
- [ ] Upload 5 phone photos and add to site
- [ ] Fix contact form — wire to actually send emails to greetings@brakeknights.com (Formspree, EmailJS, or Hostinger SMTP — decide on method)
- [ ] Fix stale nearby-area links: /brake-repair-fairfax → /brake-repair-fairfax-city (Vienna, Centreville, Burke, Springfield, Merrifield, Fairfax Station, Clifton)
- [ ] Fix stale links to deleted pages: Springfield & Alexandria → lorton, Manassas → dale-city
- [ ] Fix Services page footer missing mailto: email link
- [ ] BIG FEATURE: Automated customer email response on contact form submission (confirm receipt, include booking details, branded reply)
- [ ] Homepage hero CTA redesign (big build — user has specific vision, discuss before implementing)
- [ ] Review and approve feature branch → merge to dev → then master

## Contact
greetings@brakeknights.com
