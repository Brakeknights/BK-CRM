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

## Contact
greetings@brakeknights.com
