---
name: brakeknights-phone-app
description: >
  Master context file for the Brake Knights Phone App (BK Phone) — a standalone PWA
  for business SMS and calling, built on Telnyx, replacing Ooma Office. Load this
  skill at the start of every session involving the phone app, Telnyx, SMS threads,
  calling, push notifications, Capacitor, or anything in the bk-phone folder.
  Always load alongside the brakeknights-crm skill and the bk-admin-design skill.
---

# BK Phone — Master Context

## What This Is
A custom business phone app for Brake Knights (mobile brake-repair, Northern Virginia)
that replaces Ooma Office. Handles business texting now, calling later. Tightly
integrated with the Brake Knights CRM so the owner sees customer names instead of
raw phone numbers and can jump to a customer's CRM profile in one tap.

Think of it as a second phone living inside the owner's personal iPhone — complete
separation between business and personal. When someone calls or texts the business
number, it behaves exactly as if it were a dedicated physical business phone.

Long-term: may be white-labeled and sold to other mobile service businesses.

**Owner:** Alex. Non-developer. Explain everything in plain English, one step at a
time. Verify things rather than guessing. Show screenshots when possible.

---

## Current Status

### LIVE and working at https://phone-dev.brakeknights.com
- Receiving inbound texts from customers
- Sending outbound texts (delivered to Telnyx; carrier delivery blocked until
  10DLC registration — expected, not a bug)
- Conversation list with unread indicators and timestamps
- Conversation view with chat bubbles (blue = sent, gray = received)
- Quick-reply shortcut buttons in conversation view
- Optimistic send (message appears instantly before server confirms)
- Live updates — new texts appear without page reload
- Customer name matching + one-tap link to CRM profile (activates fully at launch
  when connected to live CRM database)
- Installable PWA — added to iPhone home screen, works like a native app
- Dark/light theme toggle (dark is default)
- Brake Knights branding — navy + royal blue, knight logo
- Password login + security (refuses to run without strong password, verifies
  Telnyx webhook signatures)
- Settings screen — account info, theme toggle, notifications toggle, logout

### NOT working / deferred
- **Push notifications** — server side works perfectly (Apple confirms receipt, 0
  errors). iOS banner never appears. Known Apple limitation with web apps — not a
  code bug. Fix: native app via Capacitor (Phase B). Stop trying to fix in web app.
- **10DLC registration** — not started. Required before texts reach real recipients.
  One-time setup, ~$20-60 total, 3-7 day approval. Save for Phase E (launch).
- **Live call recording + AI notes** — deferred. Alex to decide later.

---

## Architecture

```
[Telnyx] ──webhooks──▶ [BK Phone Express Server]
                              │
                    ┌─────────┴──────────┐
                    │                    │
             [SQLite DB]         [CRM Internal API]
          (comm logs only)      (logs to lead_history)
                    │
             [PWA Frontend]
          (mobile-first, installable)
```

**Key principles:**
- Standalone — works even if CRM is down
- Currently uses its OWN isolated database until launch — owner's privacy decision
- At launch, DB_PATH env var switches to point at live CRM database
- Phone app never writes to CRM business logic tables (leads, quotes, receipts)
- Phase C adds one-tap from CRM profile → opens text thread in phone app (app switch,
  not embedded — embedded version is a later integration)

---

## Tech Stack

**Backend**
- Node.js (>=22) + Express 4
- `better-sqlite3` — synchronous SQLite (no async/await for DB calls)
- Telnyx Node SDK — SMS send/receive; calling in Phase B
- OpenAI Whisper API — voicemail transcription (Phase B)
- Hosted on Hostinger at phone-dev.brakeknights.com

**Frontend**
- Plain HTML/CSS/JS — no framework, no build step
- PWA: manifest.json + service worker
- Mobile-first — iPhone is the primary screen

**Carrier**
- Telnyx — test number +1 703-423-0486 (NOT the real business number yet)
- Real number 703-977-4475 ports into Telnyx at launch (Phase E)
- Webhooks for inbound SMS and call events

**Deployment**
- Files pushed directly to Hostinger via MCP tool (hosting_deployJsApplication)
- Target: phone-dev.brakeknights.com
- NEVER goes through git dev/master branch workflow
- Bump ?v=N asset version number + "build N" stamp on EVERY deploy —
  iPhones cache aggressively and won't pick up changes otherwise

---

## Database Tables (Phone App Owns These)

**`comm_threads`** — One row per unique phone number conversation
- `id`, `phone_number` (E.164: +15551234567), `customer_name` (nullable)
- `lead_id` (FK to CRM leads — nullable, linked when match found)
- `last_message_at`, `unread_count`, `created_at`
- `archived` (0/1), `muted` (0/1)

**`comm_messages`** — Every SMS sent or received
- `id`, `thread_id` (FK), `created_at`
- `direction` — inbound or outbound
- `body`, `telnyx_message_id`, `status` (queued/sent/delivered/failed)
- `media_urls` (JSON array — MMS support)

**`comm_calls`** — Every call (Phase B)
- `id`, `thread_id` (FK), `created_at`
- `direction` — inbound or outbound
- `duration_seconds`, `status` (missed/answered/voicemail)
- `telnyx_call_control_id`
- `recording_url` (nullable)
- `voicemail_transcript` (nullable — Whisper output)
- `ai_summary` (nullable — Claude summary for CRM)
- `ai_summary_approved` (0/1 — review before saving to CRM)
- `notes` (nullable)

**`comm_quick_replies`** — Saved quick-reply templates
- `id`, `body`, `sort_order`, `created_at`

**`comm_scheduled_messages`** — Scheduled send queue (Phase A)
- `id`, `thread_id` (FK), `body`, `send_at`, `sent` (0/1), `created_at`

---

## Full Build Roadmap

---

### Phase A — Texting Polish (CURRENT PHASE)

Next item to build: **Compose Screen**

**1. Compose Screen**
- Tap a compose button (top right of Messages tab) to start a new conversation
- Search bar — type a customer name or number
- Results pull from CRM database showing name + number
- Unknown numbers can be typed in manually
- One tap opens a new thread

**2. Message Status Indicators**
- Single checkmark = sent to Telnyx
- Double checkmark = delivered to customer's carrier
- Failed messages show in red with a retry button

**3. Character Counter**
- Live count as you type (e.g. 140/160)
- Turns amber at 140, red at 160
- Shows "2 messages" label when over 160 so user knows it splits

**4. Unread Badge on App Icon**
- Red number badge on iPhone home screen icon when unread messages exist
- Clears when conversation is opened

**5. Search Conversations**
- Search bar at top of Messages tab
- Searches both customer names and message content

**6. MMS / Photo Sending**
- Paperclip or camera icon to attach a photo
- Photos display inline in the conversation bubble

**7. Archive and Mute**
- Swipe left on a thread to reveal Archive and Mute options
- Archived threads hidden from main list but accessible via filter/search
- Muted threads receive messages silently — no notification sound or badge

**8. After-Hours Auto-Reply**
- On/off toggle in Settings → Messages
- Custom message text field
- Business hours selector (start time / end time, set per day)
- Sends auto-reply once per thread per day maximum (no spam if customer sends
  multiple messages)

**9. Quick-Reply Templates**
- Tap lightning bolt icon above keyboard in conversation view
- Shows saved templates — tap any to insert into text box
- Managed in Settings → Messages (add, edit, reorder, delete)

---

### Phase B — Native App + Calling

**Setup**
- Apple Developer account ($99/year) — walk Alex through setup at start of phase
- Capacitor wrapper — packages existing web app into real iPhone app
- Submitted to App Store (private, not public — just for owner's use)
- This fixes push notifications permanently as a side effect

**Inbound / Outbound Calling**
- Inbound calls ring phone even when screen is locked — exactly like a real call
- Outbound calls show Telnyx business number on customer caller ID
- CNAM registration — "Brake Knights" displays as caller name on customer's screen
- Ring duration before voicemail: user selects 10/20/30/40/50/60 seconds in Settings

**Active Call Screen**
- Customer name or number displayed prominently (never "Unknown Caller")
- Mute, speaker, hold, end call buttons
- Call timer
- One-tap to open customer's CRM profile during the call

**Voicemail**
- Placeholder professional auto-generated greeting (text-to-speech via Telnyx):
  "You've reached Brake Knights. We're unable to take your call right now.
  Please leave a message and we'll get back to you as soon as possible."
  // FUTURE-SETTING: businesses.voicemail_greeting_default
- Custom greeting per time period: business hours greeting + after-hours greeting
- Option to record a personal custom greeting at any time
- AI transcription via OpenAI Whisper — transcript appears automatically after
  voicemail is left, typically within 30-60 seconds
- Play button for audio recording + transcript shown together
- Notification: "New voicemail from [name or number]" with badge on Calls tab

**Sound Design**
- Unique ringtone for inbound business calls (distinct from personal phone calls)
- Notification sound for inbound texts
- Sent message whoosh sound
- All sounds respect Do Not Disturb hours

**Push Notifications (properly fixed in native app)**
- Inbound call notification rings the phone
- Inbound text notification with message preview
- Voicemail notification with sender name/number
- All notifications respect Do Not Disturb hours

---

### Phase C — Deep CRM Integration

**One-tap from CRM to phone app**
- Button on customer's CRM profile opens their text thread in the phone app
- Simple app switch — not embedded (embedded version is a future phase)

**Auto-logging**
- Every call and text logs automatically to customer's history in the CRM
- Matched by phone number normalized to E.164
- Unknown numbers still logged in phone app DB — not synced to CRM until a lead
  is created

**Unknown Caller Flow**
- Shows phone number only — never "Unknown Caller"
- Pulls registered carrier name only if available (shown as secondary info)
- One-tap "Create Lead" button on unknown number threads and call entries
- Pre-fills CRM lead form with phone number ONLY — never pre-fills name
  (registered carrier names are often wrong; let Alex enter the real name)
- After lead is created, thread automatically links to that customer record

**AI Voicemail Summary → CRM**
- After Whisper transcript is generated, Claude produces a structured summary
- Summary goes into a review queue — Alex approves before it saves to CRM
- Edit button available before and after approving
- Setting in Settings → Calls to flip to auto-save at any time
- Saved summaries appear in customer's lead_history in the CRM

---

### Phase D — Polish

- Branded splash screen on app open
- Smooth open/close animations on conversations
- Message timestamps show only when tapping a message (iMessage style — not
  cluttering every bubble)
- Typing indicator if supported by Telnyx
- Bottom nav bar: Messages · Calls · Keypad · Settings

**Calls + Voicemail Tab (combined)**
- Unified timeline per contact — calls and voicemails grouped under name/number
- Missed calls shown in red
- Answered calls shown in gray with duration
- Voicemails shown with play button + AI transcript underneath
- One-tap callback button on every entry

**Keypad Tab**
- Dial pad for manual number entry
- Search bar at top — type a name to find and call a customer directly
- Combined search-and-dial in one screen

**Messages Tab**
- Search bar at top of conversation list

---

### Phase E — Launch

1. **10DLC registration** — required before texts reach real recipients. One-time
   per business. ~$20-60 total, 3-7 business days for approval.
2. **Connect live CRM database** — flip DB_PATH env var to point at live CRM db
3. **Port real business number** — move 703-977-4475 into Telnyx so customers
   keep the same number they already know
4. **Finalize domain** — phone.brakeknights.com
5. **Remove test number** — retire +1 703-423-0486

---

### Far Future
- Multi-user access with roles (owner/tech/dispatcher)
- White-label version for other service businesses
- Live call recording + AI notes (deferred — Alex to decide)
- Integrate text thread directly inside CRM without app switching

---

## Settings — Full Structure

**Calls**
- Ring duration before voicemail: 10 / 20 / 30 / 40 / 50 / 60 seconds (select one)
- Voicemail greeting: business hours greeting (text or custom recording), after-hours
  greeting (text or custom recording)
- AI summary behavior: "Review before saving to CRM" / "Auto-save to CRM" toggle

**Messages**
- After-hours auto-reply: on/off toggle, custom message text, hours per day
- Quick-reply templates: add, edit, reorder, delete

**Notifications**
- Do Not Disturb: on/off, start time, end time
- Notification sounds: on/off per type (calls, texts, voicemails)

**Appearance**
- Theme: dark / light toggle

**Account**
- Business name and phone number (display only)
- Change password
- Logout

---

## Known Gotchas — Do Not Repeat These

- **iPhone caches aggressively.** Always bump ?v=N on asset URLs and the "build N"
  stamp in the UI on every deploy. If changes don't appear, reinstall the home
  screen app.
- **Password cannot contain `$`.** Breaks when stored as Hostinger env var.
  Minimum 12 characters.
- **Notification permission must be triggered by a user tap** — iPhone blocks it
  if requested automatically on page load.
- **iOS hides notification banners while app is actively open** — normal behavior,
  not a bug.
- **Push notifications don't work reliably for web apps on iOS** — Apple limitation,
  not our code. Fully fixed when we go native with Capacitor in Phase B.
- **Never pre-fill customer name from carrier data** — registered names are often
  wrong. Pre-fill phone number only when creating a lead from an unknown caller.
- **Never show "Unknown Caller"** — always show the number if name isn't available.

---

## Environment Variables

```
PORT=3001
TELNYX_API_KEY=KEY...
TELNYX_PHONE_NUMBER=+17034230486   # FUTURE-SETTING: swap to real number at launch
TELNYX_APP_ID=...
TELNYX_MESSAGING_PROFILE_ID=...
PHONE_PASSWORD=...                  # min 12 chars, no $ character
CRM_API_URL=http://localhost:3000
INTERNAL_API_SECRET=...
DB_PATH=./data/bk-phone.db         # FUTURE-SETTING: switch to CRM db path at launch
OPENAI_API_KEY=...                  # for Whisper voicemail transcription (Phase B)
```

---

## Established Patterns — Always Follow These

**No frontend framework.** Plain HTML/CSS/JS only. No React, no Vue, no build step.

**Synchronous SQLite.** DB calls are plain sync function calls — no await.
Telnyx SDK, OpenAI API, and HTTP calls ARE async — those use async/await.

**Idempotent migrations.** Add columns via ALTER TABLE ADD COLUMN guarded by
PRAGMA table_info. Never drop columns.

**E.164 phone format everywhere.** Strip spaces, dashes, parens. Always +1 prefix
for US numbers. Normalize before storing or comparing.

**Mobile-first CSS.** iPhone screen first. No horizontal scroll. Min 44px tap
targets. Bottom nav bar pattern.

**Deployment = direct file push to Hostinger**, not git. Use hosting_deployJsApplication
MCP tool. Bump version stamp every time.

**FUTURE-SETTING comments.** Any value specific to Brake Knights gets a
// FUTURE-SETTING: comment for when this becomes a multi-tenant SaaS product.

---

## Communication Rules (Critical)

Alex is a non-technical small business owner. Every session:
- Explain what each change does in plain English before writing code
- State exactly which file to edit and where
- Never use technical terms without a brief explanation
- Flag anything that could affect the live CRM
- One step at a time — wait for confirmation before moving on
- Verify things rather than assuming they worked
