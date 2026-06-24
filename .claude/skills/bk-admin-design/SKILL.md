---
name: bk-admin-design
description: Design system and UI component guide for the Brake Knights admin/CRM platform. Use this skill whenever building, modifying, or styling any page inside the Brake Knights /admin interface — including the CRM dashboard, customer profiles, lead cards, quote tool, receipt builder, follow-up manager, sidebar nav, header, forms, tables, stats blocks, or any other admin UI element. Also use when adding new admin pages, refactoring existing layouts, or making any visual/design decisions inside the admin. This skill is MANDATORY before writing any admin HTML, CSS, or layout code — always read it first.
---

# Brake Knights Admin — Design System

This skill defines the visual language, component patterns, and layout rules for the Brake Knights admin/CRM interface. Read this before writing any admin UI code.

---

## Core Design Principles

- **Mobile-first.** The owner uses this on a phone at job sites. Every layout must be fully functional at 390px wide. Desktop is a bonus, not the primary target.
- **Clean and professional.** No clutter, no gradients, no decorative elements. Every element earns its place.
- **Fast to use.** The owner is often in the field. Tap targets minimum 44px. Key actions reachable in 1–2 taps.
- **Consistent.** Every page feels like the same product. Use the component patterns defined here — don't invent new ones.

---

## Color Palette

**NEVER use gold or any yellow/amber tone as a brand color.** The CSS variable `--gold` exists in the codebase but is mapped to blue — treat it as blue only.

--navy:        #0d1b2a    /* primary background, sidebar, header */
--navy-mid:    #1b2c3e    /* secondary surfaces, cards on dark bg */
--blue:        #1a4a7a    /* links, secondary actions */
--blue-light:  #2563a8    /* hover states */
--cta:         #4169e1    /* primary CTA buttons — this is blue, not gold */
--cta-hover:   #6b8ff5    /* CTA hover */
--white:       #ffffff
--gray-50:     #f8fafc
--gray-100:    #f1f5f9
--gray-200:    #e2e8f0
--gray-400:    #94a3b8
--gray-600:    #475569
--gray-900:    #0f172a
--status-new:         #3b82f6
--status-quoted:      #8b5cf6
--status-confirmed:   #06b6d4
--status-completed:   #22c55e
--status-followup:    #f97316
--status-archived:    #94a3b8
--danger:      #ef4444
--success:     #22c55e

---

## Typography

Font: Inter (already loaded)
--text-xs:   0.75rem
--text-sm:   0.875rem
--text-base: 1rem
--text-lg:   1.125rem
--text-xl:   1.25rem
--text-2xl:  1.5rem
--text-3xl:  1.875rem
Weights: 400 body / 500 labels / 600 subheadings / 700 headings + stat numbers

---

## Layout

Sidebar: 240px fixed desktop, off-canvas overlay mobile (hamburger top-left)
Header: sticky, 56px, white, subtle shadow. Left: hamburger. Center-left: page title (600 weight). Right: follow-ups badge + logout.
Content: max-width 960px, padding 24px 16px mobile / 24px 32px desktop
Page background: --gray-50

Sidebar sections:
MAIN: Dashboard, Leads, Customers, Quick Quote
TOOLS: Follow-Ups, Receipts
REPORTS: Revenue, Conversions, Services
SETTINGS: Pricing, Templates

Sidebar style: --navy background, nav items 48px tall, 16px padding, Inter 500, active = 3px --cta left border + --navy-mid bg, hover = --navy-mid bg, section labels in --gray-400 text-xs uppercase

---

## Components

Cards: white, 1px --gray-200 border, 12px radius, 0 1px 3px rgba(0,0,0,0.06) shadow, 16px padding

Lead/Customer cards: left 3px border = status color, name 600 weight + status badge right, vehicle text-sm --gray-600, service text-sm --gray-600, bottom: timestamp + Call/Text/Email buttons 44px min tap target

Status badges: pill, 2px 10px padding, 999px radius, text-xs, 600 weight, uppercase, 15% opacity background of status color, full color text

Buttons:
Primary: --cta bg, white text, 8px radius, 12px 20px padding, 600 weight, 44px min-height
Secondary: --gray-100 bg, --gray-900 text, 1px --gray-200 border, same sizing
Danger: --danger bg, white text, same sizing
Small: 6px 12px padding, text-sm, 36px min-height

Form fields: 12px 14px padding, 1px --gray-200 border, 8px radius, text-base, 44px min-height. Focus: --cta border + 3px rgba(65,105,225,0.15) shadow. Labels: text-sm 500 weight --gray-600.

Tables: full width, collapse borders. TH: text-xs 600 uppercase --gray-400, 8px 12px padding, bottom border. TD: 12px padding, text-sm --gray-900, bottom border. Row hover: --gray-50. Mobile: collapse to stacked cards — NO horizontal scroll.

Stats blocks: white card, 12px radius, 20px padding, centered. Number: text-3xl 700 --gray-900. Label: text-sm --gray-400 margin-top 4px. Grid: 2col mobile, 4col desktop.

Section titles: text-xs 600 uppercase letter-spacing 0.08em --gray-400, margin 24px 0 12px

Empty states: centered, 48px 24px padding, --gray-400, text-sm, SVG icon above message

---

## Page Patterns

List pages: [search bar] [filter tabs: All|Active|Archived] [card list 12px gap] [load more]
Detail pages: [← back] [title] [primary action top-right] [stats row] [sections]
Form pages: [title] [stacked fields] [live calc] [sticky bottom action bar mobile]

---

## Mobile Rules

- Sidebar = off-canvas drawer, hamburger top-left
- Action bars sticky to bottom on mobile
- NO horizontal scroll — ever
- Min tap target 44×44px
- Min font size 14px
- Forms stack vertically, no side-by-side fields
- Tables → stacked cards under 640px

---

## Icons

Heroicons, stroke-based, 1.5px stroke, 20px inline / 24px nav. No emoji in admin UI ever. (Inline SVG paths live in `ICON_PATHS` in `routes/admin.js`; `icon(name)` = 24px nav, `ic(name)` = 16px inline. Added recently: `folder`, `check`, `check-circle`.)

## Recent components / patterns (2026-06-24)

- **Receipts filing cabinet** (`/admin/receipts`): months as `.folder` cards (folder-tab drawn with `::before`, navy/blue — NOT amber), collapsible, each with job count + month total; a navy "to file" `.file-tray` with a "File them away" button and a calm "All caught up" empty state. Mobile-first rows.
- **Top nav progress bar** `#navProgress`: thin `--cta` bar for the instant client-side navigation (bkBoost). Don't remove.
- **Stale-session banner** `#bkStale`: fixed full-width `#7a1f1f` bar shown when the 30-min session expires while a page sits open. White "Refresh & sign in" button.
- **Instant nav** swaps `<main id="appMain">`; keep that id and don't wrap pages in a way that breaks the swap. See the brakeknights-crm skill "Client-side navigation (bkBoost)" for the scripting rules (re-run-safe scripts, `bkInitPage()`, `data-noswap`).

---

## NEVER

- No gold, yellow, or amber — ever
- No gradients
- No horizontal scroll
- No font below 14px
- No emoji in admin
- No inline styles
- No new fonts or icon libraries
- No decorative elements without function
- Don't invent new component patterns
