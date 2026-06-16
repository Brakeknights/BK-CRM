# Compose Screen — Full Spec

Part of Phase A (Texting Polish). This is the next item to build in the BK Phone app.
Plain-English behavior first, technical build details second.

## The goal in one sentence
Let the owner start a brand-new text conversation by either searching for a customer
by name or typing a phone number, then land in a normal conversation view ready to type.

## 1. How you get to it
- A **compose button** (a pencil / new-message icon) sits in the **top-right corner of
  the Messages tab header**.
- Tap it → the Compose Screen slides up over the conversation list.
- Tap target is at least 44px.

## 2. What the screen looks like
- **Header bar:** an **X (cancel)** on the left, the title **"New Message"** centered.
- **A "To:" field** right under the header — a single search box. Placeholder:
  *"Name or phone number"*. Keyboard opens automatically, cursor already in this box.
- **A results list** fills the rest of the screen, updating live as you type.

## 3. What happens as you type
- Results update live (with a ~200ms debounce so it isn't searching on every keystroke).
- Searches **two sources** and blends them:
  1. **CRM customers** (by name and by phone number).
  2. **Existing text threads** in the phone app (so recent people show up fast).
- Duplicates removed by phone number — a person never appears twice.
- **Each result row shows:** customer **name in bold**, **phone number** smaller underneath.
  If no name on file, the row just shows the number.

## 4. Typing a raw number (the unknown-number case)
- If the input looks like a phone number (mostly digits), a special row appears **pinned
  at the top**: **"Send to (703) 977-4475"** using the typed number.
- Always lets you start a text to someone not in the system yet.
- Number is normalized to E.164 (`+1` + 10 digits) before saving; displayed friendly:
  **(703) 977-4475**.

## 5. What happens when you tap a result
- **If a conversation with that number already exists** → opens that existing thread (no dup).
- **If it's a brand-new number** → opens a fresh, empty conversation view ready to type.

## 6. Empty and "nothing found" states
- **Before typing:** show **recent contacts** (most recent threads) so common people are
  one tap away. If none, hint: *"Search for a customer or type a phone number."*
- **Letters typed, no match:** *"No matching customers. Type a phone number to start a new text."*
- **Partial/invalid number:** show the "Send to..." row only once it's a complete, valid
  number; otherwise show the hint.

---

## Build details

**New backend endpoint:**
`GET /api/contacts/search?q=...` → returns a combined, de-duplicated list of
`{ name, phone (E.164), source }`, pulling from the CRM internal API **and** the local
`comm_threads` table. Cap results (e.g. 20); order known/recent contacts first.

**Thread lookup / open:**
On tap, look up `comm_threads` by E.164 phone number. If found, open it. If not, open
the conversation view in a "draft" state.

**Recommended decision — lazy thread creation:** do NOT create a `comm_threads` row the
instant a new number is tapped. Create it on the **first message send**. Avoids littering
the list with empty conversations if the owner taps someone then backs out. (Alternative:
create immediately — simpler but leaves empty threads. Lazy is recommended.)

**Phone normalization:** reuse the existing E.164 helper (strip spaces/dashes/parens,
force `+1` for US) before lookups, saves, and comparisons — never compare raw typed text.

**No framework / mobile-first:** plain HTML/CSS/JS, full-screen overlay, 44px tap targets,
no horizontal scroll — same patterns as the rest of the app.

---

## ⚠️ Real-world testing caveat
The phone app currently runs on its **own isolated database** and only connects to the
**live CRM customer list at launch** (Phase E). So **on dev right now, the "search CRM
customers" half will likely return nothing** — no real customers are wired in yet.
Expected, not a bug.

- The **manual-number path fully works** on dev (always testable).
- The **customer-name search** is best tested against existing phone threads now, and will
  fully light up once the live CRM is connected at launch.

Build order: make the manual-number flow rock solid first (testable today), and structure
the CRM search so it just starts working when the database is connected — no rebuild needed.
