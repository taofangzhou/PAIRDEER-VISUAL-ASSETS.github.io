#!/usr/bin/env node
// Run explicitly before changing DNS. No network or disk work happens on import.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const KEY = /^[a-z0-9-]+\.(png|jpg|webp|gif|mp4|webm)$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };
const JSON_LIMIT = 10 * 1024 * 1024;
const DEFAULT_MAP = fileURLToPath(new URL('../lib/download-map.json', import.meta.url));
const HELP = `Migrate the public Sites catalog and original media into ECS disk storage.

Usage:
  node scripts/migrate-sites.mjs --source https://old-site.example --data-dir data
  node scripts/migrate-sites.mjs --backup-dir /path/export --data-dir data

Choose exactly one input. Backups contain catalog.json, media/, and optionally
objects.json (SHA256, size, MIME manifest). The default destination is data/.
Existing catalog rows require --replace; other SQLite tables are preserved.
Existing immutable media must have identical bytes. All required media, including
original downloads from lib/download-map.json, are checked before catalog commit.
Use --source before DNS switches, or use the old Sites hostname explicitly.

Options:
  --replace                 Replace the catalog only after successful migration
  --old-origin URL          Rewrite this old origin's media URLs in an offline backup
  --max-file-bytes N        Per-object limit (default 67108864; maximum 2147483648)
  --timeout-ms N            Per-request timeout (default 60000; maximum 600000)
  --help                    Show this message
`;

function sourceOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--source must be an HTTPS origin without credentials, path, query, or fragment');
  }
  return url.origin;
}

function boundedNumber(value, fallback, maximum, label) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error(`Invalid ${label}`);
  return n;
}

async function regular(path, optional = false) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    return stat;
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

// Reject symlinks in any ancestor too, including an existing data/media directory.
async function safeDirectory(path, create = false) {
  const target = resolve(path);
  const root = parse(target).root;
  let current = root;
  for (const component of target.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, component);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      await mkdir(current, { mode: 0o700 });
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe directory: ${current}`);
  }
  return target;
}

async function readJson(path, optional = false) {
  await safeDirectory(dirname(path));
  const stat = await regular(path, optional);
  if (!stat) return null;
  if (stat.size > JSON_LIMIT) throw new Error(`JSON exceeds ${JSON_LIMIT} bytes: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile('utf8')); }
  finally { await handle.close(); }
}

function mediaReference(value, source) {
  let relative = value;
  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    if (source && parsed.origin === source && parsed.pathname.startsWith('/api/media/')) {
      relative = parsed.pathname + parsed.search + parsed.hash;
    } else {
      if (parsed.hostname === 'chatgpt.site' || parsed.hostname.endsWith('.chatgpt.site')) {
        throw new Error(`Unmigrated Sites URL: ${value}`);
      }
      return { value };
    }
  }
  if (!relative.startsWith('/api/media/')) return { value: relative };
  const key = relative.slice('/api/media/'.length).split(/[?#]/, 1)[0];
  if (!KEY.test(key)) throw new Error(`Invalid media key: ${key}`);
  return { value: relative, key };
}

function rewrite(value, source, keys, depth = 0) {
  if (depth > 64) throw new Error('Catalog nesting exceeds 64 levels');
  if (typeof value === 'string') {
    const ref = mediaReference(value, source);
    if (ref.key) keys.add(ref.key);
    // Catch URLs embedded in descriptions as well as URL-valued fields.
    for (const url of ref.value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
      const host = new URL(url[0]).hostname;
      if (host === 'chatgpt.site' || host.endsWith('.chatgpt.site')) throw new Error(`Unmigrated Sites URL: ${url[0]}`);
    }
    return ref.value;
  }
  if (Array.isArray(value)) return value.map(item => rewrite(item, source, keys, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, source, keys, depth + 1)]));
  return value;
}

function normalizeSnapshot(snapshot, source, keys) {
  const data = snapshot?.data ?? snapshot;
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.banners) ||
      data.products.length > 2000 || data.banners.length > 12 ||
      data.products.some(p => !p || typeof p !== 'object' || typeof p.id !== 'string')) {
    throw new Error('Catalog must contain valid products and banners arrays');
  }
  const revision = snapshot?.data ? snapshot.revision ?? 1 : 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid catalog revision');
  return { data: rewrite(data, source, keys), revision };
}

async function fetchResponse(url, timeoutMs) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return response;
}

async function onlineSnapshot(source, timeoutMs) {
  const response = await fetchResponse(`${source}/api/catalog`, timeoutMs);
  let total = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > JSON_LIMIT) throw new Error('Catalog response is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function dispositionName(header, fallback) {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header || '');
  if (encoded) {
    try { return encodeURIComponent(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))); }
    catch { throw new Error('Invalid encoded original filename'); }
  }
  const quoted = /filename\s*=\s*"([^"\r\n]*)"/i.exec(header || '');
  return encodeURIComponent(quoted?.[1] || fallback);
}

async function hashFile(path, maximum) {
  const stat = await regular(path);
  if (stat.size > maximum) throw new Error(`Media exceeds limit: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  try { for await (const chunk of handle.createReadStream()) hash.update(chunk); }
  finally { await handle.close(); }
  return { sha256: hash.digest('hex'), size: stat.size };
}

async function installMedia(key, input, directory, settings) {
  const target = join(directory, key);
  const metadataPath = target + '.metadata.json';
  const temporary = join(directory, `.${key}.${randomUUID()}.tmp`);
  const metadataTemporary = temporary + '.json';
  let size = 0;
  const hash = createHash('sha256');
  let handle;
  try {
    await regular(target, true);
    await regular(metadataPath, true);
    handle = await open(temporary, 'wx', 0o600);
    const checking = new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      settings.total += chunk.length;
      if (size > settings.maxFileBytes || settings.total > 20 * 1024 ** 3) return done(new Error('Media migration size limit exceeded'));
      hash.update(chunk); done(null, chunk);
    } });
    await pipeline(input.stream, checking, handle.createWriteStream(), { signal: AbortSignal.timeout(settings.timeoutMs) });
    const sha256 = hash.digest('hex');
    if (!size) throw new Error(`Empty media object: ${key}`);
    if (input.expected && (size !== input.expected.size || sha256 !== input.expected.sha256)) throw new Error(`Media checksum mismatch: ${key}`);
    if (input.length !== undefined && size !== input.length) throw new Error(`Media length mismatch: ${key}`);
    const existing = await regular(target, true);
    if (existing) {
      const saved = await hashFile(target, settings.maxFileBytes);
      if (saved.sha256 !== sha256 || saved.size !== size) throw new Error(`Immutable media differs: ${key}`);
    } else {
      // Hard-link installation fails rather than replacing a concurrently created file.
      await link(temporary, target);
    }
    const metadata = { httpMetadata: { contentType: input.mime || MIME[key.split('.').at(-1)] },
      customMetadata: { name: input.name || encodeURIComponent(key) }, etag: sha256 };
    await writeFile(metadataTemporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
    await regular(metadataPath, true);
    await rename(metadataTemporary, metadataPath);
    return size;
  } finally {
    input.stream.destroy?.();
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    await unlink(metadataTemporary).catch(() => {});
  }
}

async function databaseExists(path) {
  const exists = await regular(path, true);
  for (const suffix of ['-wal', '-shm', '-journal']) await regular(path + suffix, true);
  return !!exists;
}

function assertCatalogReplace(path, replace) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog'").get();
    if (table && database.prepare('SELECT id FROM catalog WHERE id=1').get() && !replace) {
      throw new Error('Destination catalog already exists; use --replace after backing it up');
    }
  } finally { database.close(); }
}

export async function migrateSites(options = {}) {
  if (!!options.source === !!options.backupDir) throw new Error('Choose exactly one of --source or --backup-dir');
  if (options.oldOrigin && !options.backupDir) throw new Error('--old-origin is only for offline backups');
  const source = sourceOrigin(options.source || options.oldOrigin);
  const settings = { maxFileBytes: boundedNumber(options.maxFileBytes, 64 * 1024 ** 2, 2 * 1024 ** 3, 'max-file-bytes'),
    timeoutMs: boundedNumber(options.timeoutMs, 60000, 600000, 'timeout-ms'), total: 0 };
  const directory = await safeDirectory(options.dataDir || 'data', true);
  const mediaDirectory = await safeDirectory(join(directory, 'media'), true);
  const databasePath = join(directory, 'catalog.sqlite');
  if (await databaseExists(databasePath)) assertCatalogReplace(databasePath, options.replace);
  const backup = options.backupDir ? await safeDirectory(options.backupDir) : null;
  if (backup) await safeDirectory(join(backup, 'media'));
  const snapshot = backup ? await readJson(join(backup, 'catalog.json')) : await onlineSnapshot(source, settings.timeoutMs);
  const keys = new Set();
  const normalized = normalizeSnapshot(snapshot, source, keys);
  const map = await readJson(options.downloadMapPath || DEFAULT_MAP);
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('Invalid download mapping');
  for (const value of Object.values(map)) {
    if (typeof value !== 'string') throw new Error('Invalid download mapping value');
    rewrite(value, source, keys);
  }
  if (keys.size > 10000) throw new Error('Too many media objects');
  const manifest = backup ? await readJson(join(backup, 'objects.json'), true) : null;
  if (manifest && (typeof manifest !== 'object' || Array.isArray(manifest))) throw new Error('Invalid objects manifest');
  let imported = 0;
  for (const key of [...keys].sort()) {
    let input;
    if (backup) {
      const file = join(backup, 'media', key);
      const stat = await regular(file);
      if (stat.size > settings.maxFileBytes) throw new Error(`Media exceeds limit: ${key}`);
      const expected = manifest?.[key];
      if (manifest && (!expected || !Number.isSafeInteger(expected.size) || expected.size < 1 || !/^[a-f0-9]{64}$/.test(expected.sha256))) {
        throw new Error(`Missing or invalid manifest entry: ${key}`);
      }
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      input = { stream: handle.createReadStream(), expected, length: stat.size, mime: expected?.mime, name: encodeURIComponent(key) };
    } else {
      const response = await fetchResponse(`${source}/api/media/${key}?download=1`, settings.timeoutMs);
      const lengthHeader = response.headers.get('content-length');
      const length = lengthHeader === null ? undefined : Number(lengthHeader);
      const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if ((length !== undefined && (!Number.isSafeInteger(length) || length < 1 || length > settings.maxFileBytes)) ||
          (mime && mime !== 'application/octet-stream' && mime !== MIME[key.split('.').at(-1)])) {
        await response.body.cancel();
        throw new Error(`Invalid media length or content type: ${key}`);
      }
      input = { stream: Readable.fromWeb(response.body), length, mime: mime === 'application/octet-stream' ? undefined : mime,
        name: dispositionName(response.headers.get('content-disposition'), key) };
    }
    await installMedia(key, input, mediaDirectory, settings);
    imported++;
  }
  // No catalog/database writes until every required original and preview is verified.
  await databaseExists(databasePath);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    database.exec('CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY, data TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1)');
    if (database.prepare('SELECT id FROM catalog WHERE id=1').get() && !options.replace) throw new Error('Destination catalog already exists; use --replace');
    database.prepare('INSERT INTO catalog(id,data,revision) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=excluded.revision')
      .run(JSON.stringify(normalized.data), normalized.revision);
    database.exec('COMMIT');
  } catch (error) { try { database.exec('ROLLBACK'); } catch {} throw error; }
  finally { database.close(); }
  return { products: normalized.data.products.length, media: imported, bytes: settings.total, revision: normalized.revision, dataDir: directory };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return; }
  const names = { '--source': 'source', '--backup-dir': 'backupDir', '--old-origin': 'oldOrigin', '--data-dir': 'dataDir', '--max-file-bytes': 'maxFileBytes', '--timeout-ms': 'timeoutMs' };
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    const key = name === '--replace' ? 'replace' : names[name];
    if (!key || Object.hasOwn(options, key)) throw new Error(`Unknown or duplicate option: ${name}`);
    if (name === '--replace') options.replace = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
      options[key] = args[++i];
    }
  }
  process.stdout.write(JSON.stringify(await migrateSites(options)) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Migration failed: ${error.message}\n`); process.exitCode = 1; });
}
