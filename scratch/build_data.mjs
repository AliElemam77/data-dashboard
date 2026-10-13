// Rebuild the encrypted leads dataset (src/data.js) from a leads-hub CSV export.
//
//   node scratch/build_data.mjs <leads-hub.csv> [--dry-run] [--keep-missing]
//
// The master password is read from DASH_PW or prompted for (hidden). It must be the
// password the current src/data.js was encrypted with: the old rows are decrypted so
// leads that already exist keep their cid, and their assignments, stages and notes
// stay attached to the same business.
//   --dry-run       print the matching report without writing anything
//   --keep-missing  also keep old leads that are absent from the new CSV
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ROW_LEN, leadExtras } from '../src/leadFields.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const { subtle } = webcrypto;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'src', 'data.js');
const BACKUP_FILE = path.join(ROOT, 'scratch', 'data.prev.js');
const ITER = 250000;

const args = process.argv.slice(2);
const csvPath = args.find(a => !a.startsWith('--'));
const DRY_RUN = args.includes('--dry-run');
const KEEP_MISSING = args.includes('--keep-missing');
if (!csvPath) {
  console.error('Usage: node scratch/build_data.mjs <leads-hub.csv> [--dry-run] [--keep-missing]');
  process.exit(1);
}

const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(pw, salt) {
  const km = await subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    km,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Same scheme as src/crypto.js decryptAll: gzip(JSON) -> AES-256-GCM, key from PBKDF2-SHA256.
async function decryptBlob(pw, { SALT, IV, DATA }) {
  const key = await deriveKey(pw, unb64(SALT));
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(IV) }, key, unb64(DATA));
  return JSON.parse(zlib.gunzipSync(Buffer.from(plain)).toString('utf8'));
}

async function encryptBlob(pw, obj) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pw, salt);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'), { level: 9 });
  const enc = await subtle.encrypt({ name: 'AES-GCM', iv }, key, gz);
  return { SALT: b64(salt), IV: b64(iv), DATA: b64(new Uint8Array(enc)) };
}

function readDataModule(file) {
  const src = fs.readFileSync(file, 'utf8');
  const get = (name) => (src.match(new RegExp(`export const ${name} = "([^"]*)"`)) || [])[1];
  return { SALT: get('SALT'), IV: get('IV'), DATA: get('DATA') };
}

function askHidden(question) {
  if (process.env.DASH_PW) return Promise.resolve(process.env.DASH_PW);
  if (!process.stdin.isTTY) {
    console.error('No TTY for the password prompt. Run from PowerShell / VS Code terminal, or set DASH_PW.');
    process.exit(1);
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// ---- matching keys between old and new rows ----
const digits = (s) => String(s || '').replace(/[^0-9]/g, '');
const phoneKey = (p) => {
  const d = digits(p);
  return d.length >= 8 ? d.slice(-9) : '';
};
const norm = (s) => String(s || '').toLowerCase().replace(/[\sـً-ٟ]+/g, ' ').trim();
const nameKey = (name, city) => (norm(name) ? norm(name) + '|' + norm(city) : '');
const mapsKey = (u) => (/google\.[^/]+\/maps\?(q|cid)=/.test(u || '') ? String(u).trim() : '');

function firstNumber(all) {
  return String(all || '').split('|').map(s => s.trim()).find(Boolean) || '';
}

function csvToRows(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const wb = XLSX.read(text, { type: 'string', raw: true });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
}

function toRow(item) {
  const s = (k) => String(item[k] ?? '').trim();
  const name = s('الاسم') || s('الاسم بالإنجليزي');
  const phone = s('الجوال') || s('الرقم الموحد') || s('الهاتف الأرضي') || firstNumber(item['كل الأرقام']);
  if (!name && !phone) return null;

  const site = s('الموقع');
  const firstSeen = Date.parse(s('أول ظهور'));
  return [
    '',                              // 0 cid (assigned below)
    s('القسم') || 'leads-hub',       // 1 sheet
    0,                               // 2 seq (assigned below)
    name,                            // 3
    s('التصنيف') || s('القطاع'),     // 4
    s('المدينة') || s('الدولة'),     // 5
    phone,                           // 6
    s('واتساب'),                     // 7
    site,                            // 8
    s('إنستغرام'),                   // 9
    s('خرائط جوجل'),                 // 10 (table falls back to a maps search when empty)
    s('المنصة'),                     // 11
    !!site,                          // 12
    s('سبب الفرصة (جملة الفتح)'),    // 13
    false,                           // 14 (phone duplicates are detected in the app)
    Number.isFinite(firstSeen) ? firstSeen : Date.now(), // 15
    ...leadExtras(item),             // 16..24
  ];
}

async function main() {
  const items = csvToRows(csvPath);
  const rows = items.map(toRow).filter(Boolean);
  console.log(`CSV: ${items.length.toLocaleString('en')} lines -> ${rows.length.toLocaleString('en')} leads`);

  const pw = await askHidden('Master password: ');
  if (!pw) throw new Error('Empty password');

  let old;
  try {
    old = await decryptBlob(pw, readDataModule(DATA_FILE));
  } catch {
    throw new Error('Could not decrypt the current src/data.js with this password. Nothing was written.');
  }
  const oldRows = old.rows || [];
  console.log(`Current data.js: ${oldRows.length.toLocaleString('en')} leads`);

  // Index old rows by phone+name, phone, maps link, then name+city; each old cid is reused at most once.
  // A phone shared by several leads (placeholders, aggregators) only counts together with the name.
  const strongKey = (r) => (phoneKey(r[6]) && nameKey(r[3], '') ? phoneKey(r[6]) + '|' + nameKey(r[3], '') : '');
  const phoneCount = new Map();
  for (const r of [...oldRows, ...rows]) {
    const k = phoneKey(r[6]);
    if (k) phoneCount.set(k, (phoneCount.get(k) || 0) + 1);
  }
  // 2 = this phone appears on exactly one old lead and one new lead.
  const uniquePhoneKey = (r) => (phoneCount.get(phoneKey(r[6])) === 2 ? phoneKey(r[6]) : '');

  const byStrong = new Map(), byPhone = new Map(), byMaps = new Map(), byName = new Map();
  let maxId = 0;
  for (const r of oldRows) {
    const n = parseInt(String(r[0]).replace(/^c_/, ''), 10);
    if (n > maxId) maxId = n;
    for (const [map, key] of [[byStrong, strongKey(r)], [byPhone, uniquePhoneKey(r)], [byMaps, mapsKey(r[10])], [byName, nameKey(r[3], r[5])]]) {
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r[0]);
    }
  }

  // Strong matches claim their cid first so a weaker key can't hand one
  // business's history to another.
  const used = new Set();
  const stats = { 'phone+name': 0, phone: 0, maps: 0, 'name+city': 0, fresh: 0 };
  const claim = (r, how, cids) => {
    const cid = (cids || []).find(c => !used.has(c));
    if (!cid) return false;
    r[0] = cid;
    used.add(cid);
    stats[how]++;
    return true;
  };
  for (const r of rows) claim(r, 'phone+name', byStrong.get(strongKey(r)));
  for (const r of rows) {
    if (r[0]) continue;
    if (claim(r, 'phone', byPhone.get(uniquePhoneKey(r)))) continue;
    if (claim(r, 'maps', byMaps.get(mapsKey(r[10])))) continue;
    if (claim(r, 'name+city', byName.get(nameKey(r[3], r[5])))) continue;
    r[0] = 'c_' + (++maxId);
    stats.fresh++;
  }

  const missing = oldRows.filter(r => !used.has(r[0]));
  if (KEEP_MISSING) {
    missing.forEach(r => rows.push([...r.slice(0, ROW_LEN), ...Array(Math.max(0, ROW_LEN - r.length)).fill('')]));
  }
  rows.forEach((r, i) => { r[2] = i + 1; });

  const { fresh, ...kept } = stats;
  console.log(`Kept existing cid: ${Object.values(kept).reduce((a, b) => a + b, 0).toLocaleString('en')}` +
    ` (${Object.entries(kept).map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`New cid: ${fresh.toLocaleString('en')}`);
  console.log(`Old leads not in the CSV: ${missing.length.toLocaleString('en')} ${KEEP_MISSING ? '(kept)' : '(dropped; use --keep-missing to keep them)'}`);
  console.log(`Total leads in new dataset: ${rows.length.toLocaleString('en')}`);

  if (DRY_RUN) {
    console.log('Dry run: nothing written.');
    return;
  }

  const blob = await encryptBlob(pw, { rows, nc: rows.length });
  const check = await decryptBlob(pw, blob);
  if (check.rows.length !== rows.length) throw new Error('Round-trip check failed. Nothing was written.');

  const out = `// Encrypted leads dataset from ${path.basename(csvPath)} (${rows.length} leads)
// Protected with PBKDF2 (SHA-256, 250,000 iterations) + AES-256-GCM
// Row layout: see src/leadFields.js (sector, suggested service, ERP grade/score, reach, opening line, email, rating)
export const SALT = "${blob.SALT}";
export const IV = "${blob.IV}";
export const ITER = ${ITER};
export const DATA = "${blob.DATA}";
`;
  fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  fs.writeFileSync(DATA_FILE, out, 'utf8');
  console.log(`Wrote src/data.js (${(out.length / 1024 / 1024).toFixed(2)} MB). Previous version saved to scratch/data.prev.js`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
