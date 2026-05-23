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

## Dev Workflow Rules
- Do NOT merge to `dev` unless the user explicitly says to push/approve for dev
- Always commit to feature branch `claude/practical-cori-46WgI` first
- Show screenshots for approval before pushing to dev

## Current Work in Progress
Update this section at the end of each session to stay caught up next time.

- Elfsight Google Reviews carousel added to homepage (`public/index.html`)
  - Widget ID: `76cf70b9-2bf0-4d45-a110-c5e3b0e7de57`
  - Configured with dark theme, "What Our Customers Say" header, 3-column layout
  - Elfsight platform script already in `<head>`: `https://elfsightcdn.com/platform.js`
- Latest commit: "Add Elfsight Google Reviews carousel to homepage"
- Working branch: `claude/dreamy-noether-W8Mwi`
- Next steps: [update this when you know what's next]

## Contact
greetings@brakeknights.com
