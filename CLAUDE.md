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

## Dev Workflow Rules — STRICT
- ALWAYS commit changes to the feature branch ONLY
- NEVER merge to `dev` without explicit user approval — not even after showing a screenshot
- NEVER merge to `master` without explicit user approval (only after reviewing dev)
- Show screenshots and WAIT for the user to say "push to dev" or "approved" before merging
- Current feature branch: `claude/dreamy-noether-W8Mwi`

## Current Work in Progress
Update this section at the end of each session to stay caught up next time.

- Working branch: `claude/dreamy-noether-W8Mwi`
- Next steps: User reviewing knight-on-horse homepage hero (100% auto width, 32% opacity, center position). Awaiting approval to merge to dev. Image at /public/images/knight-on-horse.jpg, CSS in styles.css updated.

## To-Do List

### Completed
- [x] Rebuild homepage
- [x] Add real photos (hero + why-choose section)
- [x] Fix colors to royal blue brand
- [x] Fix warranty language everywhere
- [x] Build all subpages (about, contact, services, location, legal)
- [x] Build 6 service detail pages
- [x] Build 30 location pages
- [x] Rewrite About page with authentic knight-themed content
- [x] Add Google Map embed to homepage
- [x] Add live Google Reviews section to homepage (Elfsight widget, ID: 76cf70b9-2bf0-4d45-a110-c5e3b0e7de57, confirmed working on dev)

### Pending
- [ ] Upload 5 phone photos and add to site
- [ ] Perform SEO analysis of master site and recommend improvements
- [ ] Review and approve feature branch → merge to dev → then master

## Contact
greetings@brakeknights.com
