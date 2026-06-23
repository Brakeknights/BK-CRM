// ─── Off-server database backups (Rule #1) ──────────────────────────────────
//
// Snapshots the live SQLite database, gzips it, encrypts it with AES-256-GCM,
// and uploads it to a private S3-compatible bucket (Backblaze B2 by default).
// The customer database is the crown jewel: this is the recovery path if the
// Hostinger disk fails, a deploy goes wrong, or the site is ever deleted.
//
// SECURITY:
//   - The backup contains all customer PII, so it is ENCRYPTED before it ever
//     leaves the server. A leaked bucket is useless without BACKUP_ENCRYPTION_KEY.
//   - Credentials live only in env vars (never hardcoded, never committed).
//   - Logs only sizes / keys / timestamps, never customer data.
//
// The module is a safe no-op until BACKUP_ENABLED=true and the required env
// vars are present, so it can ship to production dormant and be switched on later.
//
// Required env vars (set in Hostinger hPanel, never committed):
//   BACKUP_ENABLED          "true" to turn the feature on
//   BACKUP_S3_ENDPOINT      e.g. https://s3.us-east-005.backblazeb2.com
//   BACKUP_S3_REGION        e.g. us-east-005  (the region in your B2 endpoint)
//   BACKUP_S3_BUCKET        the private bucket name
//   BACKUP_S3_KEY_ID        B2 application keyID
//   BACKUP_S3_APP_KEY       B2 application key secret
//   BACKUP_ENCRYPTION_KEY   32-byte key as 64 hex chars or base64 (KEEP SAFE — needed to restore)
// Optional:
//   BACKUP_S3_PREFIX        key prefix/folder (default "brakeknights-db")
//   BACKUP_RETENTION        number of newest backups to keep (default 30)

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const db = require('./db');

const ENABLED    = process.env.BACKUP_ENABLED === 'true';
const ENDPOINT   = process.env.BACKUP_S3_ENDPOINT;
const REGION     = process.env.BACKUP_S3_REGION || 'us-east-005';
const BUCKET     = process.env.BACKUP_S3_BUCKET;
const KEY_ID     = process.env.BACKUP_S3_KEY_ID;
const APP_KEY    = process.env.BACKUP_S3_APP_KEY;
const ENC_KEY    = process.env.BACKUP_ENCRYPTION_KEY;
const PREFIX     = (process.env.BACKUP_S3_PREFIX || 'brakeknights-db').replace(/\/+$/, '');
const RETENTION  = Math.max(1, parseInt(process.env.BACKUP_RETENTION || '30', 10));

// Returns the config state without ever exposing secrets. Used by the admin route.
function getStatus() {
  return {
    enabled: ENABLED,
    bucket: BUCKET || null,
    endpoint: ENDPOINT || null,
    prefix: PREFIX,
    retention: RETENTION,
    encrypted: !!ENC_KEY,
    missing: missingConfig(),
  };
}

function missingConfig() {
  const need = { BACKUP_S3_ENDPOINT: ENDPOINT, BACKUP_S3_BUCKET: BUCKET,
    BACKUP_S3_KEY_ID: KEY_ID, BACKUP_S3_APP_KEY: APP_KEY, BACKUP_ENCRYPTION_KEY: ENC_KEY };
  return Object.keys(need).filter((k) => !need[k]);
}

// Parse the encryption key from hex (64 chars) or base64 into a 32-byte Buffer.
function loadKey() {
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(ENC_KEY)) key = Buffer.from(ENC_KEY, 'hex');
  else key = Buffer.from(ENC_KEY, 'base64');
  if (key.length !== 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must decode to 32 bytes (got ' + key.length + ')');
  }
  return key;
}

function s3client() {
  // Lazy-require so the SDK is only loaded when backups are actually used.
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    endpoint: ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: KEY_ID, secretAccessKey: APP_KEY },
    forcePathStyle: true, // required for Backblaze B2 / most S3-compatible stores
  });
}

// Snapshot -> gzip -> AES-256-GCM encrypt -> upload. Encrypted file layout:
//   [12-byte IV][gzipped+encrypted ciphertext][16-byte GCM auth tag]
async function runBackup() {
  if (!ENABLED) return { ok: false, skipped: 'BACKUP_ENABLED is not true' };
  const missing = missingConfig();
  if (missing.length) return { ok: false, skipped: 'missing config: ' + missing.join(', ') };

  const key = loadKey();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-backup-'));
  const snapPath = path.join(tmpDir, 'snapshot.db');
  const encPath  = path.join(tmpDir, 'snapshot.db.gz.enc');

  try {
    // 1) Consistent snapshot of the live DB (safe while the app is running).
    await db.backup(snapPath);

    // 2) gzip + encrypt to encPath.
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const out = fs.createWriteStream(encPath);
    out.write(iv); // 12-byte header
    await pipeline(fs.createReadStream(snapPath), zlib.createGzip(), cipher, out, { end: false });
    out.write(cipher.getAuthTag()); // 16-byte trailer
    await new Promise((res, rej) => { out.end((e) => (e ? rej(e) : res())); });

    const bytes = fs.statSync(encPath).size;

    // 3) Upload to the private bucket with a timestamped key.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const objKey = `${PREFIX}/brakeknights-${stamp}.db.gz.enc`;
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3client().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: objKey,
      Body: fs.createReadStream(encPath),
      ContentLength: bytes,
      ContentType: 'application/octet-stream',
    }));

    console.log(`[backup] uploaded ${objKey} (${bytes} bytes, encrypted)`);

    let pruned = 0;
    try { pruned = await pruneOld(); }
    catch (e) { console.error('[backup] prune error:', e.message); }

    return { ok: true, key: objKey, bytes, pruned };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// Keep only the RETENTION newest objects under PREFIX; delete the rest.
async function pruneOld() {
  const { ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = s3client();
  let objects = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: PREFIX + '/', ContinuationToken: token,
    }));
    objects = objects.concat(res.Contents || []);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  objects.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
  const stale = objects.slice(RETENTION);
  for (const o of stale) {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.Key }));
  }
  if (stale.length) console.log(`[backup] pruned ${stale.length} old backup(s), kept ${RETENTION}`);
  return stale.length;
}

// Cron-safe wrapper: never throws, always logs.
function safeRunBackup() {
  if (!ENABLED) return;
  runBackup()
    .then((r) => { if (!r.ok && r.skipped) console.warn('[backup] skipped:', r.skipped); })
    .catch((err) => console.error('[backup] error:', err.message));
}

// Restore drill: download the newest backup back from the bucket, decrypt it with
// the same key, and run a SQLite integrity check + row count. Proves the backup is
// genuinely recoverable. All server-side: no secret or customer data leaves the box.
async function verifyLatest() {
  if (!ENABLED) return { ok: false, skipped: 'BACKUP_ENABLED is not true' };
  const missing = missingConfig();
  if (missing.length) return { ok: false, skipped: 'missing config: ' + missing.join(', ') };

  const key = loadKey();
  const { ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
  const client = s3client();

  // Find the newest object under the prefix.
  let objs = [], token;
  do {
    const r = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX + '/', ContinuationToken: token }));
    objs = objs.concat(r.Contents || []);
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  if (!objs.length) return { ok: false, error: 'no backups found in bucket' };
  objs.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
  const objKey = objs[0].Key;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-verify-'));
  const encPath = path.join(tmpDir, 'dl.enc');
  const dbPath  = path.join(tmpDir, 'restored.db');
  try {
    // Download.
    const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: objKey }));
    await pipeline(res.Body, fs.createWriteStream(encPath));

    // Decrypt: [12-byte IV][ciphertext][16-byte tag] -> gunzip -> db file.
    const size = fs.statSync(encPath).size;
    const fd = fs.openSync(encPath, 'r');
    const iv = Buffer.alloc(12); fs.readSync(fd, iv, 0, 12, 0);
    const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, size - 16);
    fs.closeSync(fd);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    await pipeline(fs.createReadStream(encPath, { start: 12, end: size - 17 }), decipher, zlib.createGunzip(), fs.createWriteStream(dbPath));

    // Open the restored DB and sanity-check it.
    const Database = require('better-sqlite3');
    const test = new Database(dbPath, { readonly: true });
    const integrity = test.pragma('integrity_check')[0].integrity_check;
    let leads = null;
    try { leads = test.prepare('SELECT count(*) AS c FROM leads').get().c; } catch (_) {}
    test.close();

    return { ok: integrity === 'ok', key: objKey, integrity, leads };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { runBackup, safeRunBackup, verifyLatest, getStatus };
