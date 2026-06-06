---
name: bk-admin-design
description: Design system for the Brake Knights admin (/admin) interface. Use at the start of any session that adds or changes admin UI — leads, customers, quotes, receipts, follow-ups, Quick Quote, or any new admin page. Defines the layout shell, colors, components, and conventions so every admin screen looks like one app. Load this BEFORE writing admin HTML.
---

# Brake Knights Admin Design System

The admin is **server-rendered HTML strings** in `routes/admin.js` (JS template
literals, no framework, no build step). Every page is wrapped by the
`page(title, body, req)` helper, which injects the shared `CSS` constant, the
navy topbar, and the nav. **Reuse the existing CSS classes and helpers — do not
invent a parallel style.** When something genuinely new is needed, add a class to
the `CSS` constant rather than scattering one-off inline styles.

## Golden rules
1. **Mobile-first, single column.** Content lives in `.wrap` (max-width 600px,
   centered). Design for a phone; it scales up fine.
2. **Topbar nav, not a sidebar.** All sections are links in the navy topbar built
   inside `page()`. New top-level pages get a `.topbar-link` there with an
   `activeSection` check.
3. **Cards for everything.** Each logical block is a `.card`. A page is a stack of
   cards.
4. **Escape all DB/user values** with `esc()` before putting them in HTML.
5. **`money()` for display, `fmt()`/`toFixed(2)` for hidden input values** (display
   uses thousands separators; form values must stay comma-free for `parseFloat`).
6. **No em dashes** in any copy. Use a colon, a comma, or rewrite.
7. **Synchronous SQLite.** No `await` on DB calls.
8. **Idempotent migrations** in `db.js` (`ALTER TABLE ADD COLUMN` guarded by a
   `PRAGMA table_info` check). Never drop or rename columns.

## Layout shell
- `page(title, body, req)` renders `<head>` + topbar + `<div class="wrap">body</div>`
  + the shared delete-confirm modal + small JS helpers (`copyEmail`, delete modal).
- Page title pattern: an `<h1>` at 1.2rem/700/`#0a1f3d`, often in a flex row with a
  muted count on the right:
  ```
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
    <h1 style="font-size:1.2rem;font-weight:700;color:#0a1f3d;">Title</h1>
    <span style="color:#aaa;font-size:0.83rem;">N total</span>
  </div>
  ```
- Detail/sub pages start with a back link: `<a class="back-link">&#8592; All X</a>`.

## Color palette
| Role | Hex |
|------|-----|
| Page background | `#f0f4f8` |
| Body text | `#1a2a3a` |
| Brand navy (headings, navy buttons, topbar) | `#0a1f3d` |
| Accent blue (primary action, links-on-card) | `#4169e1` |
| Link blue (phone/email/service text) | `#1a6fc4` |
| Topbar brand text | `#6b8ff5` |
| Muted / secondary text | `#888` / `#aaa` |
| Card border / input border | `#dde3ea` / `#e3e9f1` |
| Success green (text / bg) | `#1a7a3a` / `#e6f9ee` |
| Error red (text / bg) | `#c0392b` / `#fff0f0` |
| Warning amber (text / bg) | `#e07000` / `#fff8e1` |

## Components (use these classes from the `CSS` constant)
- **Card:** `.card` — white, radius 12px, padding 16px, soft shadow.
- **Section title:** `.section-title` — 0.95rem/700/navy. Add a muted
  `(parenthetical)` in 0.8rem/`#aaa` for hints.
- **Buttons:** `.btn` (full-width) with a color modifier:
  - `.btn-navy` primary dark, `.btn-blue` accent action, `.btn-outline` secondary.
  - `.btn-sm` for inline/auto-width buttons (`style="width:auto;"`).
- **Filter tabs:** `.filter-tabs` row of `.filter-tab` pills; active = `.active`.
- **Forms:** wrap each field in `.form-group` (label 0.83rem/600/`#555` + input).
  Two-up grids: `style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"`.
- **Info grid** (read-only key/value): `.info-grid` with `.info-key` / `.info-val`.
- **Alerts:** `.alert` + `.alert-success` / `.alert-error`. Drive them off a
  `?msg=` query param after a POST-redirect.
- **Empty states:** `.empty` (centered, muted) with a big emoji/icon above the text.
- **Search bar:** a `GET` form with a full-width text input + a Clear link shown
  only when a query is active (see the leads + customers lists).

### Status badge (pipeline stage)
Use `statusBadge(status)` — a rounded pill, color-coded per stage
(new/quoted/follow_up/quote_accepted/booked/completed/receipt). Match these colors
for any new status-like pill.

### Customer tags
`customerTagBadge` / `customerTagBadges(commaString)` render the simple labels
(Repeat Customer = green, Fleet = blue, Referred = purple, VIP = amber). Shown on
the customer profile and on lead cards.

### Stat blocks
`statBlock(label, value)` — a `#f4f7fb` tile (big 1.2rem/800 navy value over a
0.72rem uppercase muted label). Lay them out in a
`grid-template-columns:1fr 1fr;gap:10px` for the Lifetime Stats card.

### List cards that open a detail page
Make the whole card clickable but let inner controls work:
```
<div class="card" onclick="if(!event.target.closest('a,button,select,form')){window.location='/admin/...';}" style="cursor:pointer;">
```
Add `onclick="event.stopPropagation();"` to inner links (like a `tel:`) that sit
inside a clickable card.

## Helpers already in `routes/admin.js` (reuse, don't re-create)
`esc`, `fmt`, `money`, `joinServices`, `timeAgo`, `shortDate`, `fmtPrefDate`,
`easternToday`, `statusBadge`, `customerTagBadges`, `statBlock`, `followupCard`,
`stageTracker`, `nextStageHint`, `schedulingPanel`, `logHistory`, `requireAuth`.

## Pattern for a new admin page (checklist)
1. `router.get('/thing', requireAuth, ...)` builds a `body` string of `.card`s.
2. `res.send(page('Thing', body, req))`.
3. Add a `.topbar-link` in `page()` and extend the `activeSection` check.
4. POST handlers use `express.urlencoded({ extended: false })`, mutate via sync
   SQLite, then **redirect with a `?msg=` flag** (Post/Redirect/Get) so refresh is
   safe and the success/error alert shows.
5. Escape every interpolated value. Keep copy em-dash-free.
6. Screenshot at phone width, show the owner, wait for approval before `dev`.

## This is a living document
When a design decision changes or a new shared component appears, update this file
in the same change so future sessions inherit it. Treat it as the source of truth
for how the admin looks and behaves.
