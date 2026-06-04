const session = require('express-session');
const Store = session.Store;

// Minimal SQLite-backed session store for express-session.
// Extends Store (not EventEmitter) so express-session's createSession() is inherited.
// Survives Node process restarts so admin sessions persist across git auto-deploys.
class SqliteStore extends Store {
  constructor(db, ttlMs) {
    super();
    this.db = db;
    this.ttlMs = ttlMs || 8 * 60 * 60 * 1000;
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid     TEXT    PRIMARY KEY,
      data    TEXT    NOT NULL,
      expires INTEGER NOT NULL
    )`);
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }

  get(sid, cb) {
    const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
    if (!row) return cb(null, null);
    if (row.expires < Date.now()) {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return cb(null, null);
    }
    try { cb(null, JSON.parse(row.data)); } catch (_) { cb(null, null); }
  }

  set(sid, session, cb) {
    const expires = Date.now() + this.ttlMs;
    this.db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?,?,?)')
      .run(sid, JSON.stringify(session), expires);
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    if (cb) cb(null);
  }

  touch(sid, session, cb) {
    const expires = Date.now() + this.ttlMs;
    this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(expires, sid);
    if (cb) cb(null);
  }
}

module.exports = SqliteStore;
