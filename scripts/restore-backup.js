#!/usr/bin/env node
// ─── Restore an encrypted database backup ────────────────────────────────────
//
// Decrypts a backup produced by backup.js back into a usable SQLite .db file.
// Encrypted file layout: [12-byte IV][gzipped+encrypted ciphertext][16-byte tag].
//
// Usage:
//   # Decrypt a local file you already downloaded:
//   BACKUP_ENCRYPTION_KEY=... node scripts/restore-backup.js <file.db.gz.enc> <out.db>
//
//   # Pull the newest backup straight from the bucket and decrypt it:
//   BACKUP_ENCRYPTION_KEY=... BACKUP_S3_* env set... \
//     node scripts/restore-backup.js --latest <out.db>
//
//   # Pull a specific object key from the bucket:
//   ... node scripts/restore-backup.js --key brakeknights-db/brakeknights-XXXX.db.gz.enc <out.db>
//
// After restoring, verify with:  sqlite3 out.db "PRAGMA integrity_check; SELECT count(*) FROM leads;"
// Then move out.db into place as the live DB (stop the app, replace the file, restart).

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

function loadKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw) throw new Error('BACKUP_ENCRYPTION_KEY env var is required to decrypt.');
  let key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must decode to 32 bytes.');
  return key;
}

async function decryptFile(encPath, outPath, key) {
  const fd = fs.openSync(encPath, 'r');
  const size = fs.fstatSync(fd).size;
  if (size < 28) throw new Error('File too small to be a valid backup.');
  const iv = Buffer.alloc(12);
  fs.readSync(fd, iv, 0, 12, 0);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // Ciphertext is everything between the 12-byte IV header and the 16-byte tag trailer.
  const cipherStream = fs.createReadStream(encPath, { start: 12, end: size - 17 });
  await pipeline(cipherStream, decipher, zlib.createGunzip(), fs.createWriteStream(outPath));
}

async function downloadFromS3(objKey, destPath) {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: process.env.BACKUP_S3_ENDPOINT,
    region: process.env.BACKUP_S3_REGION || 'us-east-005',
    credentials: { accessKeyId: process.env.BACKUP_S3_KEY_ID, secretAccessKey: process.env.BACKUP_S3_APP_KEY },
    forcePathStyle: true,
  });
  const bucket = process.env.BACKUP_S3_BUCKET;
  if (objKey === '--LATEST--') {
    const prefix = (process.env.BACKUP_S3_PREFIX || 'brakeknights-db').replace(/\/+$/, '') + '/';
    let objs = [], token;
    do {
      const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      objs = objs.concat(r.Contents || []);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    if (!objs.length) throw new Error('No backups found under prefix ' + prefix);
    objs.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
    objKey = objs[0].Key;
    console.log('Latest backup:', objKey);
  }
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objKey }));
  await pipeline(res.Body, fs.createWriteStream(destPath));
  return objKey;
}

async function main() {
  const args = process.argv.slice(2);
  const key = loadKey();
  let encPath, outPath, tmpDir;

  try {
    if (args[0] === '--latest' || args[0] === '--key') {
      outPath = args[0] === '--latest' ? args[1] : args[2];
      if (!outPath) throw new Error('Output path required.');
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-restore-'));
      encPath = path.join(tmpDir, 'download.enc');
      await downloadFromS3(args[0] === '--latest' ? '--LATEST--' : args[1], encPath);
    } else {
      encPath = args[0];
      outPath = args[1];
      if (!encPath || !outPath) throw new Error('Usage: restore-backup.js <file.enc> <out.db>  (or --latest <out.db>)');
    }
    await decryptFile(encPath, outPath, key);
    console.log('Restored to:', outPath, '(' + fs.statSync(outPath).size + ' bytes)');
    console.log('Verify:  sqlite3 ' + outPath + ' "PRAGMA integrity_check; SELECT count(*) FROM leads;"');
  } finally {
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((e) => { console.error('Restore failed:', e.message); process.exit(1); });
