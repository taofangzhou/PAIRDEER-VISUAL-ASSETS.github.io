#!/usr/bin/env node
// Explicit public-media export only. No network or filesystem mutation on import.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const KEY = /^[a-z0-9-]+\.(png|jpg|webp|gif|mp4|webm)$/;
const HASH = /^[a-f0-9]{64}$/;
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' };
const JSON_LIMIT = 16 * 1024 ** 2;
const FILE_LIMIT = 64 * 1024 ** 2;
const TOTAL_LIMIT = 2 * 1024 ** 3;
const HELP = `Export the supplied latest catalog and ALL registered public media into a verified backup.

Usage:
  node scripts/export-sites-backup.mjs --source https://shuanglu-battery.cn --catalog-file migration/source-catalog-20261102-r5.json --output backup

Options:
  --replace          Replace an existing backup only after a complete verified export
  --concurrency N    Concurrent requests (default 4, maximum 4)
  --timeout-ms N     Per-request timeout (default 300000, maximum 600000)
  --help             Show this message

The source must be a standard HTTPS origin. No authentication, proxy spoofing,
redirect following, or retry after a denied request is supported. An HTTP 403
fails the export. The original catalog bytes are preserved; no seed is used.
public/ stays in the repository and is fully checksummed by backup-manifest.json.
Archive public/, lib/download-map.json and docs/import-*-objects.json with backup/.
`;

function numberOption(value, fallback, maximum, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > maximum) throw new Error(`Invalid ${name}`);
  return n;
}
function sourceOrigin(value, allowHttpForTests = false) {
  if (typeof value !== 'string' || !value) throw new Error('--source is required');
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(allowHttpForTests && loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--source must be an HTTPS origin without credentials, path, query, or fragment');
  }
  return url.origin;
}
async function regular(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular file: ${path}`);
  return stat;
}
async function directory(path, create = false) {
  const target = resolve(path), root = parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 }); stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${current}`);
  }
  return target;
}
async function readJsonFile(path) {
  await directory(dirname(path));
  const stat = await regular(path);
  if (stat.size > JSON_LIMIT) throw new Error(`JSON file is too large: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return { bytes, value: JSON.parse(bytes.toString('utf8')), sha256: digest(bytes), size: bytes.length };
  } finally { await handle.close(); }
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function typeFor(key) { return MIME[key.split('.').at(-1)]; }
async function hashFile(path, maximum = TOTAL_LIMIT) {
  const stat = await regular(path);
  if (stat.size > maximum) throw new Error(`File exceeds size limit: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let size = 0;
  try { for await (const chunk of handle.createReadStream()) { size += chunk.length; hash.update(chunk); } }
  finally { await handle.close().catch(() => {}); }
  if (size !== stat.size) throw new Error(`File changed while reading: ${path}`);
  return { size, sha256: hash.digest('hex') };
}
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function fileEntry(path, bytes) { return { path, sha256: digest(bytes), size: bytes.length }; }

function reference(value, origin, keys, staticReferences) {
  if (typeof value !== 'string') throw new Error('Invalid asset reference');
  let path = value;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.origin !== origin) {
      // Never silently claim a complete backup of assets on an unapproved host.
      if (/\/(?:api\/media|assets|downloads)\//.test(url.pathname)) throw new Error(`External asset origin is not authorized: ${url.origin}`);
      return;
    }
    path = url.pathname + url.search + url.hash;
  }
  if (path.startsWith('/api/media/')) {
    const key = path.slice('/api/media/'.length).split(/[?#]/, 1)[0];
    if (!KEY.test(key)) throw new Error(`Invalid media key: ${key}`);
    keys.add(key);
  } else if (/^\/(?:assets|downloads)\//.test(path)) {
    path = decodeURIComponent(path.split(/[?#]/, 1)[0]);
    if (path.includes('\\') || path.split('/').some(part => part === '..' || part === '.')) throw new Error(`Unsafe public asset path: ${path}`);
    staticReferences.add(path);
  }
}
function walk(value, callback, depth = 0) {
  if (depth > 64) throw new Error('Catalog nesting exceeds 64 levels');
  if (typeof value === 'string') callback(value);
  else if (Array.isArray(value)) for (const item of value) walk(item, callback, depth + 1);
  else if (object(value)) for (const item of Object.values(value)) walk(item, callback, depth + 1);
}
async function publicInventory(root) {
  const base = join(root, 'public');
  await directory(base);
  const files = [];
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Public symlink is not allowed: ${full}`);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push({ path: relative(root, full).split(sep).join('/'), ...await hashFile(full),
        mime: typeFor(entry.name) || (entry.name.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream') });
      else throw new Error(`Unsupported public file: ${full}`);
    }
  }
  await visit(base);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function plan(options, origin) {
  const root = resolve(options.projectRoot || REPO);
  await directory(root);
  if (!options.catalogFile) throw new Error('--catalog-file is required');
  const catalog = await readJsonFile(resolve(options.catalogFile));
  const snapshot = catalog.value;
  if (!object(snapshot) || !object(snapshot.data) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 ||
      !Array.isArray(snapshot.data.products) || snapshot.data.products.length > 2000 ||
      !Array.isArray(snapshot.data.banners) || snapshot.data.banners.length > 12 ||
      snapshot.data.products.some(p => !object(p) || typeof p.id !== 'string' || !p.id)) {
    throw new Error('A valid latest catalog envelope {data,revision} is required; no seed fallback is supported');
  }
  const ids = snapshot.data.products.map(p => p.id);
  if (new Set(ids).size !== ids.length) throw new Error('Catalog has duplicate product identifiers');
  const keys = new Set(), staticReferences = new Set(), expected = new Map();
  const collect = value => reference(value, origin, keys, staticReferences);
  walk(snapshot.data, collect);
  const mappingPath = join(root, 'lib', 'download-map.json');
  const mapping = await readJsonFile(mappingPath);
  if (!object(mapping.value)) throw new Error('Invalid download mapping');
  for (const [preview, original] of Object.entries(mapping.value)) { collect(preview); collect(original); }
  const sourceFiles = [fileEntry('lib/download-map.json', mapping.bytes)];
  const docs = join(root, 'docs'); await directory(docs);
  for (const name of (await readdir(docs)).filter(name => /^import-[a-z0-9-]+-objects\.json$/.test(name)).sort()) {
    const registry = await readJsonFile(join(docs, name));
    if (!object(registry.value)) throw new Error(`Invalid object registry: ${name}`);
    sourceFiles.push(fileEntry('docs/' + name, registry.bytes));
    for (const [key, record] of Object.entries(registry.value)) {
      if (!KEY.test(key) || !object(record) || !HASH.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 1 ||
          record.size > FILE_LIMIT || record.mime !== typeFor(key)) throw new Error(`Invalid expected metadata: ${key}`);
      const item = { sha256: record.sha256, size: record.size, mime: record.mime };
      if (expected.has(key) && !equal(expected.get(key), item)) throw new Error(`Conflicting expected metadata: ${key}`);
      expected.set(key, item); keys.add(key);
    }
  }
  if (keys.size > 10000) throw new Error('Too many media objects');
  const publicFiles = await publicInventory(root);
  const available = new Set(publicFiles.map(item => '/' + item.path.slice('public/'.length)));
  for (const path of staticReferences) if (!available.has(path)) throw new Error(`Referenced public file is missing: ${path}`);
  return { root, catalog, snapshot, keys: [...keys].sort(), expected, publicFiles, sourceFiles };
}

function magicMatches(bytes, mime) {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString());
  if (mime === 'video/mp4') return bytes.subarray(4, 8).toString() === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  return false;
}
function originalName(header, key) {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header || '');
  if (encoded) {
    try { return encodeURIComponent(decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''))); }
    catch { throw new Error(`Invalid encoded filename: ${key}`); }
  }
  return encodeURIComponent(/filename\s*=\s*"([^"\r\n]*)"/i.exec(header || '')?.[1] || key);
}
async function download(key, expected, staging, origin, settings, signal) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]);
  const response = await fetch(`${origin}/api/media/${key}?download=1`, { redirect: 'error', signal: combined });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel(); throw new Error(`HTTP ${response.status}: /api/media/${key}`);
  }
  const mime = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  const lengthHeader = response.headers.get('content-length');
  const length = lengthHeader === null ? null : Number(lengthHeader);
  if (mime !== (expected?.mime || typeFor(key)) || (length !== null && (!Number.isSafeInteger(length) || length < 1 || length > settings.maxFileBytes))) {
    await response.body.cancel(); throw new Error(`Invalid media MIME or length: ${key}`);
  }
  if (expected && length !== null && !response.headers.get('content-encoding') && length !== expected.size) {
    await response.body.cancel(); throw new Error(`Media size mismatch: ${key}`);
  }
  let size = 0, prefix = Buffer.alloc(0);
  const hash = createHash('sha256');
  const check = new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length; settings.total += chunk.length;
    if (size > settings.maxFileBytes || settings.total > settings.maxTotalBytes) return done(new Error(`Backup size limit exceeded: ${key}`));
    if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
    hash.update(chunk); done(null, chunk);
  } });
  const path = join(staging, 'media', key);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await pipeline(Readable.fromWeb(response.body), check, handle.createWriteStream(), { signal: combined });
  } finally { await handle?.close().catch(() => {}); }
  const sha256 = hash.digest('hex');
  if (!size || !magicMatches(prefix, mime)) throw new Error(`Media is not a valid ${mime} file (HTML/invalid signature): ${key}`);
  if (expected && (size !== expected.size || sha256 !== expected.sha256)) throw new Error(`Media checksum mismatch: ${key}`);
  if (length !== null && !response.headers.get('content-encoding') && size !== length) throw new Error(`Media length mismatch: ${key}`);
  const metadataPath = 'media/' + key + '.metadata.json';
  const metadataBytes = Buffer.from(JSON.stringify({ httpMetadata: { contentType: mime },
    customMetadata: { name: originalName(response.headers.get('content-disposition'), key) }, etag: sha256 }) + '\n');
  await writeFile(join(staging, metadataPath), metadataBytes, { flag: 'wx', mode: 0o600 });
  return { key, path: 'media/' + key, sha256, size, mime, metadata: fileEntry(metadataPath, metadataBytes) };
}

/** Verify exact bytes and reconstruct the required inventory without network access. */
export async function verifySiteBackup(options = {}) {
  if (!options.output) throw new Error('--output is required');
  const output = await directory(options.output);
  const manifestFile = await readJsonFile(join(output, 'backup-manifest.json'));
  const manifest = manifestFile.value;
  if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.complete !== true) throw new Error('Backup is not complete');
  const origin = sourceOrigin(options.source || manifest.source, options.allowHttpForTests);
  if (manifest.source !== origin) throw new Error('Backup source origin mismatch');
  const expectedPlan = await plan({ ...options, catalogFile: options.catalogFile || join(output, 'catalog.json') }, origin);
  const catalog = await readJsonFile(join(output, 'catalog.json'));
  if (!catalog.bytes.equals(expectedPlan.catalog.bytes) || !equal(manifest.catalog, fileEntry('catalog.json', catalog.bytes))) throw new Error('Backup catalog checksum mismatch');
  if (manifest.revision !== expectedPlan.snapshot.revision || manifest.products !== expectedPlan.snapshot.data.products.length || manifest.banners !== expectedPlan.snapshot.data.banners.length) throw new Error('Backup catalog counts mismatch');
  if (!equal(manifest.public, expectedPlan.publicFiles) || !equal(manifest.sourceFiles, expectedPlan.sourceFiles)) throw new Error('Repository public/source files changed or are missing');
  const objects = await readJsonFile(join(output, 'objects.json'));
  if (!object(objects.value) || !equal(Object.keys(objects.value).sort(), expectedPlan.keys)) throw new Error('Backup object keys are missing or unexpected');
  if (!equal(manifest.objectsManifest, fileEntry('objects.json', objects.bytes))) throw new Error('Objects manifest checksum mismatch');
  if (!Array.isArray(manifest.media) || !equal(manifest.media.map(item => item.key), expectedPlan.keys)) throw new Error('Backup media inventory mismatch');
  const mediaDirectory = await directory(join(output, 'media'));
  const allowedFiles = expectedPlan.keys.flatMap(key => [key, key + '.metadata.json']).sort();
  if (!equal((await readdir(mediaDirectory)).sort(), allowedFiles)) throw new Error('Missing or extra backup media files');
  let mediaBytes = 0, mediaMetadataBytes = 0;
  for (const [i, key] of expectedPlan.keys.entries()) {
    const record = objects.value[key], item = manifest.media[i];
    if (!object(record) || !HASH.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 1 || record.size > FILE_LIMIT || record.mime !== typeFor(key)) throw new Error(`Invalid backup object metadata: ${key}`);
    if (expectedPlan.expected.has(key) && !equal(record, expectedPlan.expected.get(key))) throw new Error(`Backup expected metadata mismatch: ${key}`);
    const actual = await hashFile(join(mediaDirectory, key), FILE_LIMIT);
    if (record.sha256 !== actual.sha256 || record.size !== actual.size || item.path !== 'media/' + key || item.sha256 !== actual.sha256 || item.size !== actual.size || item.mime !== record.mime) throw new Error(`Backup media checksum mismatch: ${key}`);
    const sidecar = await readJsonFile(join(mediaDirectory, key + '.metadata.json'));
    if (!equal(item.metadata, fileEntry('media/' + key + '.metadata.json', sidecar.bytes)) || sidecar.value.etag !== record.sha256 || sidecar.value.httpMetadata?.contentType !== record.mime || typeof sidecar.value.customMetadata?.name !== 'string') throw new Error(`Backup media metadata mismatch: ${key}`);
    mediaBytes += actual.size; mediaMetadataBytes += sidecar.size;
  }
  const publicBytes = expectedPlan.publicFiles.reduce((n, item) => n + item.size, 0);
  if (manifest.mediaCount !== expectedPlan.keys.length || manifest.mediaBytes !== mediaBytes || manifest.mediaMetadataBytes !== mediaMetadataBytes || manifest.publicCount !== expectedPlan.publicFiles.length || manifest.publicBytes !== publicBytes) throw new Error('Backup byte/file totals mismatch');
  return manifest;
}

/** Fetch standard public HTTPS media into a sibling staging directory, then swap. */
export async function exportSiteBackup(options = {}) {
  const origin = sourceOrigin(options.source, options.allowHttpForTests);
  if (!options.output) throw new Error('--output is required');
  const settings = { concurrency: numberOption(options.concurrency, 4, 4, 'concurrency'),
    timeoutMs: numberOption(options.timeoutMs, 300000, 600000, 'timeout-ms'),
    maxFileBytes: numberOption(options.maxFileBytes, FILE_LIMIT, FILE_LIMIT, 'max-file-bytes'),
    maxTotalBytes: numberOption(options.maxTotalBytes, TOTAL_LIMIT, TOTAL_LIMIT, 'max-total-bytes'), total: 0 };
  const expectedPlan = await plan(options, origin);
  const output = resolve(options.output);
  if (output === expectedPlan.root || expectedPlan.root.startsWith(output + sep) ||
      ['public', 'docs', 'lib', 'scripts', 'app', 'deploy'].some(name => output === join(expectedPlan.root, name) || output.startsWith(join(expectedPlan.root, name) + sep))) throw new Error('Backup output must not replace repository source directories');
  await directory(dirname(output), true);
  async function existingOutput() {
    try { const stat = await lstat(output); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Existing backup output is not a safe directory'); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  if (await existingOutput() && !options.replace) throw new Error('Backup output already exists; use --replace');
  settings.total = expectedPlan.publicFiles.reduce((n, item) => n + item.size, 0) + expectedPlan.catalog.size + expectedPlan.sourceFiles.reduce((n, item) => n + item.size, 0);
  const knownMediaBytes = [...expectedPlan.expected.values()].reduce((n, item) => n + item.size, 0);
  if (settings.total + knownMediaBytes > settings.maxTotalBytes) throw new Error('Backup total size limit exceeded');
  const staging = join(dirname(output), '.' + basename(output) + '.staging-' + randomUUID());
  const previous = join(dirname(output), '.' + basename(output) + '.previous-' + randomUUID());
  let previousMoved = false, installed = false;
  try {
    await mkdir(staging, { mode: 0o700 }); await mkdir(join(staging, 'media'), { mode: 0o700 });
    const controller = new AbortController(), media = new Array(expectedPlan.keys.length);
    let index = 0, completed = 0, failure;
    async function worker() {
      while (!failure) {
        const i = index++;
        if (i >= expectedPlan.keys.length) return;
        try {
          const key = expectedPlan.keys[i];
          media[i] = await download(key, expectedPlan.expected.get(key), staging, origin, settings, controller.signal);
          completed++;
          if (completed % 25 === 0 || completed === expectedPlan.keys.length) options.onProgress?.({ completed, total: expectedPlan.keys.length });
        } catch (error) { if (!failure) { failure = error; controller.abort(error); } throw error; }
      }
    }
    await Promise.allSettled(Array.from({ length: settings.concurrency }, worker));
    if (failure) throw failure;
    const objects = Object.fromEntries(media.map(({ key, sha256, size, mime }) => [key, { sha256, size, mime }]));
    const objectsBytes = Buffer.from(JSON.stringify(objects, null, 2) + '\n');
    await writeFile(join(staging, 'catalog.json'), expectedPlan.catalog.bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(staging, 'objects.json'), objectsBytes, { flag: 'wx', mode: 0o600 });
    const manifest = { schemaVersion: 1, complete: true, createdAt: new Date().toISOString(), source: origin,
      revision: expectedPlan.snapshot.revision, products: expectedPlan.snapshot.data.products.length, banners: expectedPlan.snapshot.data.banners.length,
      mediaCount: media.length, mediaBytes: media.reduce((n, item) => n + item.size, 0), mediaMetadataBytes: media.reduce((n, item) => n + item.metadata.size, 0),
      publicCount: expectedPlan.publicFiles.length, publicBytes: expectedPlan.publicFiles.reduce((n, item) => n + item.size, 0),
      catalog: fileEntry('catalog.json', expectedPlan.catalog.bytes), objectsManifest: fileEntry('objects.json', objectsBytes),
      media, public: expectedPlan.publicFiles, sourceFiles: expectedPlan.sourceFiles };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (settings.total + objectsBytes.length + manifest.mediaMetadataBytes + manifestBytes.length > settings.maxTotalBytes) throw new Error('Backup total size limit exceeded');
    await writeFile(join(staging, 'backup-manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 });
    // Recompute current source/static hashes and every exported binary before publication.
    await verifySiteBackup({ ...options, source: origin, output: staging });
    if (await existingOutput()) {
      if (!options.replace) throw new Error('Backup output appeared during export; use --replace');
      await rename(output, previous); previousMoved = true;
    }
    try { await rename(staging, output); installed = true; }
    catch (error) { if (previousMoved) { await rename(previous, output); previousMoved = false; } throw error; }
    // A cleanup failure leaves the old sibling backup available; the verified
    // replacement has already succeeded and must not be reported as a failed export.
    if (previousMoved) await rm(previous, { recursive: true, force: true }).catch(() => {});
    return manifest;
  } finally {
    if (!installed) await rm(staging, { recursive: true, force: true });
    // A failed final rename restores the previous backup before propagating.
  }
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return; }
  const names = { '--source': 'source', '--catalog-file': 'catalogFile', '--output': 'output', '--concurrency': 'concurrency', '--timeout-ms': 'timeoutMs' };
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], name = arg === '--replace' ? 'replace' : names[arg];
    if (!name || Object.hasOwn(options, name)) throw new Error(`Unknown or duplicate option: ${arg}`);
    if (arg === '--replace') options.replace = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[name] = args[++i];
    }
  }
  options.onProgress = ({ completed, total }) => process.stderr.write(`Verified media ${completed}/${total}\n`);
  const manifest = await exportSiteBackup(options);
  process.stdout.write(JSON.stringify({ complete: true, output: resolve(options.output), revision: manifest.revision,
    products: manifest.products, media: manifest.mediaCount, mediaBytes: manifest.mediaBytes, publicFiles: manifest.publicCount, publicBytes: manifest.publicBytes }) + '\n');
}
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Backup export failed: ${error.message}\n`); process.exitCode = 1; });
}
