const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// In production (Hostinger), default to one level above the git working directory
// so the DB survives deployments that clean gitignored files. Set DB_PATH to override.
const dbPath = process.env.DB_PATH || (
  process.env.NODE_ENV === 'production'
    ? path.join(__dirname, '..', 'brakeknights-data', 'brakeknights.db')
    : path.join(__dirname, 'data', 'brakeknights.db')
);
console.log('[DB] path:', dbPath);
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
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

  -- Phase 5: job summary + custom receipt. One row per receipt emailed to a customer.
  -- customer_notes is a JSON array of advisory strings shown on the receipt; office_notes
  -- is internal and never sent.
  CREATE TABLE IF NOT EXISTS receipts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER NOT NULL REFERENCES leads(id),
    quote_id        INTEGER REFERENCES quotes(id),
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    sent_at         TEXT,
    service         TEXT,
    vehicle         TEXT,
    service_date    TEXT,
    service_address TEXT,
    parts_labor     REAL    NOT NULL DEFAULT 0,
    shop_supplies   REAL    NOT NULL DEFAULT 0,
    tax             REAL    NOT NULL DEFAULT 0,
    total           REAL    NOT NULL DEFAULT 0,
    payment_method  TEXT,
    customer_notes  TEXT,
    office_notes    TEXT
  );

  -- Phase 7B: Quick Quote drafts. Saved form state the owner can come back to.
  CREATE TABLE IF NOT EXISTS quick_drafts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    label      TEXT NOT NULL DEFAULT 'Untitled',
    form_data  TEXT NOT NULL
  );

  -- Phase 7B: customer records. One row per real person; leads link to a customer
  -- via leads.customer_id. tags is a comma-separated list of simple labels
  -- (Repeat Customer, Fleet, Referred, VIP).
  CREATE TABLE IF NOT EXISTS customers (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
    first_name         TEXT    NOT NULL DEFAULT '',
    last_name          TEXT    NOT NULL DEFAULT '',
    email              TEXT,
    phone              TEXT,
    square_customer_id TEXT,
    notes              TEXT,
    tags               TEXT
  );

  -- Phase 7B: structured vehicles, child records of a customer.
  CREATE TABLE IF NOT EXISTS customer_vehicles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    year        TEXT,
    make        TEXT,
    model       TEXT,
    trim        TEXT,
    vin         TEXT
  );

  -- Phase 7B: saved service addresses, child records of a customer.
  CREATE TABLE IF NOT EXISTS customer_addresses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    label       TEXT,
    address     TEXT    NOT NULL
  );

  -- Phase 6 foundation: timed follow-up reminders created from receipt advisories.
  -- recipient is 'owner', 'customer', or 'both'. The daily cron in server.js fires
  -- the email(s) on/after due_date and flips sent = 1.
  CREATE TABLE IF NOT EXISTS followups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id     INTEGER NOT NULL REFERENCES leads(id),
    receipt_id  INTEGER REFERENCES receipts(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    description TEXT    NOT NULL,
    due_date    TEXT    NOT NULL,
    recipient   TEXT    NOT NULL DEFAULT 'owner',
    sent        INTEGER NOT NULL DEFAULT 0,
    sent_at     TEXT
  );

  -- Owner personal events / time blocks shown on the appointments calendar so the
  -- owner can see what's taken when scheduling jobs. Visual only: not customer
  -- facing, no emails, does not block booking.
  CREATE TABLE IF NOT EXISTS personal_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    title       TEXT    NOT NULL,
    event_date  TEXT    NOT NULL,
    start_time  TEXT,
    end_time    TEXT,
    note        TEXT
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
addQuoteCol('line_items',          'TEXT');
addQuoteCol('alt_times_sent',      'INTEGER DEFAULT 0');
addQuoteCol('alt_token1',          'TEXT');
addQuoteCol('alt_date1',           'TEXT');
addQuoteCol('alt_time1',           'TEXT');
addQuoteCol('alt_token2',          'TEXT');
addQuoteCol('alt_date2',           'TEXT');
addQuoteCol('alt_time2',           'TEXT');
addQuoteCol('alt_token3',          'TEXT');
addQuoteCol('alt_date3',           'TEXT');
addQuoteCol('alt_time3',           'TEXT');

const leadCols = db.prepare("PRAGMA table_info(leads)").all().map(c => c.name);
const addLeadCol = (name, def) => {
  if (!leadCols.includes(name)) db.exec(`ALTER TABLE leads ADD COLUMN ${name} ${def}`);
};
addLeadCol('status_updated_at',  'TEXT');
addLeadCol('followup_sent',      'INTEGER DEFAULT 0');
addLeadCol('archived',           'INTEGER DEFAULT 0');
addLeadCol('archived_at',        'TEXT');
addLeadCol('vin',                'TEXT');
addLeadCol('internal_notes',     'TEXT');
addLeadCol('customer_id',        'INTEGER REFERENCES customers(id)');

// ─── Backfill: approved appointments missing the quote 'approved' status ───────
// The owner-approve flow used to set only the lead to 'booked' and left the quote
// status untouched, so booked appointments from the customer accept flow never
// matched the calendar query (which requires quote.status = 'approved'). Heal any
// existing rows: a booked, non-archived lead whose accepted quote has a date but
// isn't marked approved yet. Idempotent — only touches rows still out of sync.
db.exec(`
  UPDATE quotes SET status = 'approved'
  WHERE status != 'approved'
    AND pref_date IS NOT NULL
    AND id IN (
      SELECT MAX(q.id) FROM quotes q
      JOIN leads l ON l.id = q.lead_id
      WHERE l.status = 'booked' AND l.archived = 0 AND q.accepted_at IS NOT NULL
      GROUP BY q.lead_id
    )
`);

// ─── Customer home address ─────────────────────────────────────────────────────
const custCols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
if (!custCols.includes('home_address')) db.exec("ALTER TABLE customers ADD COLUMN home_address TEXT");

// ─── Vehicle license plate ─────────────────────────────────────────────────────
const vehCols = db.prepare("PRAGMA table_info(customer_vehicles)").all().map(c => c.name);
if (!vehCols.includes('license_plate')) db.exec("ALTER TABLE customer_vehicles ADD COLUMN license_plate TEXT");

// ─── Phase 8E: push subscriptions for new-lead browser notifications ─────────
db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    endpoint          TEXT    NOT NULL UNIQUE,
    p256dh            TEXT    NOT NULL,
    auth              TEXT    NOT NULL,
    device_label      TEXT
  );
`);

// ─── Phase 8: pricing overrides, vehicle tier mappings, unknown vehicles ──────
db.exec(`
  CREATE TABLE IF NOT EXISTS pricing_overrides (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    service_name  TEXT    NOT NULL UNIQUE,
    std_parts     REAL    NOT NULL DEFAULT 0,
    std_labor     REAL    NOT NULL DEFAULT 0,
    std_supplies  REAL    NOT NULL DEFAULT 0,
    prem_parts    REAL    NOT NULL DEFAULT 0,
    prem_labor    REAL    NOT NULL DEFAULT 0,
    prem_supplies REAL    NOT NULL DEFAULT 0,
    has_premium   INTEGER NOT NULL DEFAULT 1,
    minutes       INTEGER NOT NULL DEFAULT 60,
    custom_quote  INTEGER NOT NULL DEFAULT 0,
    note          TEXT,
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vehicle_tier_mappings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    make       TEXT    NOT NULL,
    model      TEXT,
    tier       TEXT    NOT NULL DEFAULT 'standard',
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(make, model)
  );

  CREATE TABLE IF NOT EXISTS unknown_vehicles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id         INTEGER REFERENCES leads(id),
    year            TEXT,
    make            TEXT,
    model           TEXT,
    auto_tier       TEXT    NOT NULL DEFAULT 'premium',
    classified_tier TEXT,
    classified_at   TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed pricing_overrides from pricing.js on first run
const pCount = db.prepare('SELECT COUNT(*) AS n FROM pricing_overrides').get().n;
if (pCount === 0) {
  const PSEED = require('./pricing');
  const insP = db.prepare(`INSERT OR IGNORE INTO pricing_overrides
    (service_name, std_parts, std_labor, std_supplies, prem_parts, prem_labor, prem_supplies, has_premium, minutes, custom_quote, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  Object.keys(PSEED.services).forEach(function(name) {
    const svc = PSEED.services[name];
    const std  = svc.standard || { parts: 0, labor: 0, shopSupplies: 0 };
    const prem = svc.premium  || std;
    insP.run(name, std.parts || 0, std.labor || 0, std.shopSupplies || 0,
             prem.parts || 0, prem.labor || 0, prem.shopSupplies || 0,
             svc.premium ? 1 : 0, svc.minutes || 60, svc.customQuote ? 1 : 0, svc.note || null);
  });
}

// Seed vehicle_tier_mappings on first run
const mCount = db.prepare('SELECT COUNT(*) AS n FROM vehicle_tier_mappings').get().n;
if (mCount === 0) {
  const insM = db.prepare('INSERT OR IGNORE INTO vehicle_tier_mappings (make, model, tier) VALUES (?, ?, ?)');
  const SEED = [
    // Standard base brands
    ['Honda','standard'],['Toyota','standard'],['Nissan','standard'],['Mazda','standard'],
    ['Mitsubishi','standard'],['Subaru','standard'],['Hyundai','standard'],['Kia','standard'],
    ['Chevrolet','standard'],['Ford','standard'],['Dodge','standard'],['Chrysler','standard'],
    ['Buick','standard'],['GMC','standard'],['Volkswagen','standard'],['Jeep','standard'],
    // Premium base brands
    ['BMW','premium'],['Mercedes-Benz','premium'],['Audi','premium'],['Volvo','premium'],
    ['Lexus','premium'],['Acura','premium'],['Infiniti','premium'],['Cadillac','premium'],
    ['Lincoln','premium'],['Genesis','premium'],['Land Rover','premium'],['Porsche','premium'],
    ['Maserati','premium'],['Ferrari','premium'],['Lamborghini','premium'],['Bentley','premium'],
    ['Rolls-Royce','premium'],['Alfa Romeo','premium'],['Ram','premium'],
    // Not serviced
    ['Tesla','not_serviced'],
  ];
  SEED.forEach(function(r) { insM.run(r[0], null, r[1]); });

  // Model overrides: Jeep Standard (reinforce base)
  [['Jeep','Wrangler','standard'],['Jeep','Renegade','standard'],
   ['Jeep','Compass','standard'],['Jeep','Cherokee','standard'],
   // Jeep Premium overrides
   ['Jeep','Grand Cherokee','premium'],['Jeep','Grand Wagoneer','premium'],['Jeep','Gladiator','premium'],
   // Ford trucks/SUVs
   ['Ford','F-150','premium'],['Ford','F-250','premium'],['Ford','F-350','premium'],['Ford','F-450','premium'],
   ['Ford','Expedition','premium'],['Ford','Ranger','premium'],
   // Chevy trucks/SUVs
   ['Chevrolet','Silverado','premium'],['Chevrolet','Suburban','premium'],['Chevrolet','Tahoe','premium'],
   ['Chevrolet','Colorado','premium'],['Chevrolet','Traverse','premium'],
   // GMC trucks/SUVs
   ['GMC','Sierra','premium'],['GMC','Yukon','premium'],['GMC','Canyon','premium'],
   // Toyota trucks/SUVs
   ['Toyota','Tacoma','premium'],['Toyota','Tundra','premium'],
   ['Toyota','4Runner','premium'],['Toyota','Sequoia','premium'],['Toyota','Land Cruiser','premium'],
   // Nissan trucks/SUVs
   ['Nissan','Titan','premium'],['Nissan','Armada','premium'],['Nissan','Frontier','premium'],
   // Honda SUVs
   ['Honda','Pilot','premium'],['Honda','Passport','premium'],['Honda','Ridgeline','premium'],
   // Dodge trucks/SUVs
   ['Dodge','Durango','premium'],
  ].forEach(function(r) { insM.run(r[0], r[1], r[2]); });
}

module.exports = db;

// Phase 7B: group any leads that aren't yet attached to a customer into customer
// records (by email, then phone). Runs after module.exports is set so customers.js
// can require this db instance without a circular-require gap. Idempotent.
try {
  require('./customers').runBackfill();
} catch (err) {
  console.error('[customers] backfill error:', err.message);
}

// Flush WAL to the main DB file every 5 minutes so recent data is never stranded
// in the side-file if the process is stopped abruptly for a deployment.
setInterval(function() {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) {}
}, 5 * 60 * 1000);
