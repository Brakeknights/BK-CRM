// ===========================================================================
// bk-phone / db.js
// ---------------------------------------------------------------------------
// Opens the SAME SQLite database file the Brake Knights CRM uses, and adds two
// NEW tables for the phone app: comm_threads and comm_messages.
//
// SAFETY: This file only ever runs "CREATE TABLE IF NOT EXISTS" for its own two
// tables. It never alters, drops, or renames any existing CRM table (leads,
// quotes, customers, etc.). If the tables already exist, these statements do
// nothing. That makes startup safe to run over and over (this is what
// "idempotent migration" means: running it again changes nothing).
//
// All database calls in this project are SYNCHRONOUS (no async/await), which is
// how better-sqlite3 works and matches the existing CRM.
// ===========================================================================

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Where is the database file?
// We point at the SAME brakeknights.db the CRM uses so customer matching (later
// phases) works against real data. The cleanest way to guarantee both apps use
// the exact same file is the DB_PATH environment variable, which you'll set in
// .env to the shared database's location.
//
// If DB_PATH is not set, we fall back to sensible defaults so the app can still
// boot during local development.
// ---------------------------------------------------------------------------
const dbPath = process.env.DB_PATH || (
  process.env.NODE_ENV === 'production'
    // On the server, bk-phone sits next to the CRM folder, and the database
    // lives one level above both (so deploys never wipe it).
    ? path.join(__dirname, '..', 'brakeknights-data', 'brakeknights.db')
    // Local/dev fallback: the CRM repo's data folder one level up.
    : path.join(__dirname, '..', 'data', 'brakeknights.db')
);

console.log('[bk-phone DB] using:', dbPath);

// Make sure the folder exists before SQLite tries to open the file.
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Open the database. Same settings the CRM uses so the two apps cooperate:
//  - WAL mode: lets the CRM and the phone app read/write at the same time
//    without locking each other out.
//  - foreign_keys ON: enforces the link between a message and its thread.
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// The two NEW tables.
//
// comm_threads  = one row per conversation (one per customer phone number).
//                 This is what the main screen lists.
// comm_messages = one row per individual text, inbound or outbound.
//                 These are the chat bubbles inside a conversation.
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS comm_threads (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at           TEXT    NOT NULL DEFAULT (datetime('now')),
    -- The customer's phone number, always stored in E.164 format (+15551234567).
    -- One thread per customer number, so this is UNIQUE.
    contact_phone        TEXT    NOT NULL UNIQUE,
    -- Display name if we know it. Filled from the CRM in Phase 3; until then it
    -- may be blank and the UI just shows the phone number.
    contact_name         TEXT,
    -- A short snippet of the most recent message, shown in the thread list.
    last_message_preview TEXT,
    -- When the most recent message happened, used to sort the list newest-first.
    last_message_at      TEXT,
    -- How many inbound messages have not been read yet (the unread badge count).
    unread_count         INTEGER NOT NULL DEFAULT 0,
    -- Which Brake Knights number this conversation belongs to. Single number for
    -- now, but stored so the app is ready for more than one line later.
    -- FUTURE-SETTING: for a multi-business SaaS, this (plus a business/account id)
    -- is how you keep each tenant's conversations separate.
    bk_number            TEXT
  );

  CREATE TABLE IF NOT EXISTS comm_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Which conversation this message belongs to.
    thread_id     INTEGER NOT NULL REFERENCES comm_threads(id),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    -- 'inbound'  = customer texted us (shows on the left, gray).
    -- 'outbound' = we texted the customer (shows on the right, blue).
    direction     TEXT    NOT NULL,
    -- The text content of the message.
    body          TEXT,
    -- Both numbers in E.164 format.
    from_number   TEXT    NOT NULL,
    to_number     TEXT    NOT NULL,
    -- Telnyx's own id for this message. Lets us match delivery updates and avoid
    -- saving the same incoming text twice if Telnyx retries a webhook.
    telnyx_id     TEXT,
    -- Delivery state: received / queued / sent / delivered / sending_failed, etc.
    status        TEXT,
    -- If a send fails, the reason goes here so it can be shown in the app.
    error         TEXT
  );

  -- Speed up loading a conversation's messages in order.
  CREATE INDEX IF NOT EXISTS idx_comm_messages_thread
    ON comm_messages(thread_id, id);

  -- Prevent duplicate rows if Telnyx delivers the same webhook more than once.
  -- (Partial index: only enforces uniqueness when telnyx_id is present.)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_comm_messages_telnyx
    ON comm_messages(telnyx_id) WHERE telnyx_id IS NOT NULL;
`);

// ===========================================================================
// Helper functions.
//
// All SQL lives here and every value is passed with "?" placeholders (never
// glued into the query text). This is the parameterized-query rule that keeps
// the database safe from injection, and it keeps the rest of the app simple:
// the route files just call these by name.
// ===========================================================================

// --- Threads ---------------------------------------------------------------

// List every conversation, newest activity first. Powers the main screen.
const listThreads = db.prepare(`
  SELECT * FROM comm_threads
  ORDER BY COALESCE(last_message_at, created_at) DESC
`);

// Find one conversation by its id (for the conversation screen).
const getThreadById = db.prepare(`SELECT * FROM comm_threads WHERE id = ?`);

// Find a conversation by the customer's phone number.
const getThreadByPhone = db.prepare(`SELECT * FROM comm_threads WHERE contact_phone = ?`);

const insertThread = db.prepare(`
  INSERT INTO comm_threads (contact_phone, contact_name, bk_number)
  VALUES (?, ?, ?)
`);

// Get the existing conversation for a phone number, or create one if it's new.
// Returns the full thread row either way.
function getOrCreateThread(contactPhone, contactName = null, bkNumber = null) {
  let thread = getThreadByPhone.get(contactPhone);
  if (!thread) {
    const info = insertThread.run(contactPhone, contactName, bkNumber);
    thread = getThreadById.get(info.lastInsertRowid);
  } else if (contactName && !thread.contact_name) {
    // Backfill a name if we learn it later and didn't have one before.
    db.prepare(`UPDATE comm_threads SET contact_name = ? WHERE id = ?`)
      .run(contactName, thread.id);
    thread.contact_name = contactName;
  }
  return thread;
}

// After a message arrives or is sent, update the thread's preview + timestamp,
// and bump the unread count when it's an incoming message.
const touchThreadStmt = db.prepare(`
  UPDATE comm_threads
  SET last_message_preview = ?,
      last_message_at       = datetime('now'),
      unread_count          = unread_count + ?
  WHERE id = ?
`);
function touchThread(threadId, preview, incrementUnread = 0) {
  touchThreadStmt.run(preview, incrementUnread, threadId);
}

// Mark a conversation as read (clears the unread badge) when it's opened.
const markThreadReadStmt = db.prepare(`
  UPDATE comm_threads SET unread_count = 0 WHERE id = ?
`);
function markThreadRead(threadId) {
  markThreadReadStmt.run(threadId);
}

// --- Messages --------------------------------------------------------------

// All messages in a conversation, oldest first (so they read top-to-bottom).
const listMessagesByThread = db.prepare(`
  SELECT * FROM comm_messages WHERE thread_id = ? ORDER BY id ASC
`);

const insertMessageStmt = db.prepare(`
  INSERT INTO comm_messages
    (thread_id, direction, body, from_number, to_number, telnyx_id, status, error)
  VALUES
    (@thread_id, @direction, @body, @from_number, @to_number, @telnyx_id, @status, @error)
`);
function insertMessage(msg) {
  // Fill in any missing optional fields so the INSERT always has every column.
  const row = {
    thread_id:   msg.thread_id,
    direction:   msg.direction,
    body:        msg.body ?? '',
    from_number: msg.from_number,
    to_number:   msg.to_number,
    telnyx_id:   msg.telnyx_id ?? null,
    status:      msg.status ?? null,
    error:       msg.error ?? null,
  };
  const info = insertMessageStmt.run(row);
  return info.lastInsertRowid;
}

// Update a message's delivery status (used when Telnyx tells us delivered/failed).
const updateMessageStatusStmt = db.prepare(`
  UPDATE comm_messages SET status = ?, error = ? WHERE telnyx_id = ?
`);
function updateMessageStatus(telnyxId, status, error = null) {
  updateMessageStatusStmt.run(status, error, telnyxId);
}

// Has this Telnyx message already been saved? Guards against duplicate webhooks.
const messageExistsStmt = db.prepare(`
  SELECT 1 FROM comm_messages WHERE telnyx_id = ? LIMIT 1
`);
function messageExists(telnyxId) {
  if (!telnyxId) return false;
  return !!messageExistsStmt.get(telnyxId);
}

module.exports = {
  db,
  // threads
  listThreads:      () => listThreads.all(),
  getThreadById:    (id) => getThreadById.get(id),
  getThreadByPhone: (phone) => getThreadByPhone.get(phone),
  getOrCreateThread,
  touchThread,
  markThreadRead,
  // messages
  listMessagesByThread: (threadId) => listMessagesByThread.all(threadId),
  insertMessage,
  updateMessageStatus,
  messageExists,
};
