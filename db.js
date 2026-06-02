const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'brakeknights.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    first_name        TEXT    NOT NULL,
    last_name         TEXT    NOT NULL,
    phone             TEXT    NOT NULL,
    email             TEXT,
    vehicle           TEXT,
    service           TEXT,
    message           TEXT,
    preferred_contact TEXT,
    source            TEXT,
    status            TEXT    NOT NULL DEFAULT 'new',
    square_customer_id TEXT
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id           INTEGER NOT NULL REFERENCES leads(id),
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    sent_at           TEXT,
    service           TEXT,
    tier              TEXT,
    price_parts       REAL    NOT NULL DEFAULT 0,
    price_labor       REAL    NOT NULL DEFAULT 0,
    shop_supplies     REAL    NOT NULL DEFAULT 0,
    tax_rate          REAL    NOT NULL DEFAULT 0,
    tax               REAL    NOT NULL DEFAULT 0,
    total             REAL    NOT NULL DEFAULT 0,
    vin               TEXT,
    internal_notes    TEXT,
    status            TEXT    NOT NULL DEFAULT 'draft'
  );

  CREATE TABLE IF NOT EXISTS lead_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id    INTEGER NOT NULL REFERENCES leads(id),
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    event      TEXT    NOT NULL,
    detail     TEXT
  );
`);

// ─── Migrations (idempotent — safe to run against existing dev/prod data) ──────
// Adds Phase 3C customer-acceptance + scheduling columns to the quotes table.
const quoteCols = db.prepare("PRAGMA table_info(quotes)").all().map(c => c.name);
const addQuoteCol = (name, def) => {
  if (!quoteCols.includes(name)) db.exec(`ALTER TABLE quotes ADD COLUMN ${name} ${def}`);
};
addQuoteCol('accept_token',        'TEXT');
addQuoteCol('accepted_at',         'TEXT');
addQuoteCol('pref_date',           'TEXT');
addQuoteCol('pref_time',           'TEXT');
addQuoteCol('pref_location',       'TEXT');
addQuoteCol('scheduling_notes',    'TEXT');
addQuoteCol('quote_followup_sent', 'INTEGER DEFAULT 0');
addQuoteCol('reminder_24h_sent',   'INTEGER DEFAULT 0');
addQuoteCol('reminder_2h_sent',    'INTEGER DEFAULT 0');

const leadCols = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
const addLeadCol = (name, def) => {
  if (!leadCols.includes(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${def}`);
};
addLeadCol('status_updated_at',  'TEXT');
addLeadCol('followup_sent',      'INTEGER DEFAULT 0');
addLeadCol('archived',           'INTEGER DEFAULT 0');
addLeadCol('archived_at',        'TEXT');

module.exports = db;
