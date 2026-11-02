#!/usr/bin/env node
// Downloads only a fixed, checksummed release backup. Never extracts or executes it.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const RELEASE_URL = 'https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/releases/download/data-backup-20261102T045044Z-parts';
export const EXPECTED_ARCHIVE = Object.freeze({
  name: 'pairdeer-complete-data-backup-20261102T045044Z.tar.gz',
  size: 575174060,
  sha256: '44a07874a52db0a6d85d1d9b84318c3479c93b7d2b4b197610c8b04d790c514a',
});
const PART_SIZE = 67108864;
const HASH = /^[a-f0-9]{64}$/;
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const HELP = `Download and verify the complete PAIRDEER data backup using resumable HTTP/1.1 parts.

Usage: node download-backup-parts.mjs [--directory /tmp/pairdeer-backup]

Requires Node.js 24 and curl 7.61 or newer. The release, archive size and full SHA-256
are fixed in this helper. An existing partial archive is preserved and reused as a
prefix; an existing verified complete archive needs no HTTP request. Downloads use
2 concurrent parts, at most 5 attempts per part, and resume after interruption.
The original archive is replaced only after the assembled file passes full SHA-256.
`;

async function safeDirectory(path, create = false) {
  const target = resolve(path), root = parse(target).root;
  if (target === root) throw new Error('The download directory cannot be the filesystem root');
  let current = root;
  for (const component of target.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode:0o700 }); info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe directory: ${current}`);
  }
  return target;
}
async function regular(path, optional = false) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${path}`);
    return info;
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}
async function hashFile(path) {
  const info = await regular(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash('sha256'); let size = 0;
  try { for await (const chunk of handle.createReadStream()) { size += chunk.length; hash.update(chunk); } }
  finally { await handle.close().catch(() => {}); }
  if (size !== info.size) throw new Error(`File changed while reading: ${path}`);
  return { size, sha256:hash.digest('hex') };
}
async function matches(path, expected) {
  const info = await regular(path, true);
  if (!info || info.size !== expected.size) return false;
  const saved = await hashFile(path);
  return saved.sha256 === expected.sha256;
}
function archiveSettings(expected) {
  if (!expected || !SAFE_NAME.test(expected.name) || expected.name.includes('..') || basename(expected.name) !== expected.name ||
      !Number.isSafeInteger(expected.size) || expected.size < 1 || !HASH.test(expected.sha256)) throw new Error('Invalid expected archive');
}
function releaseBase(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Release must be an HTTPS URL without credentials, query or fragment');
  return url.href.replace(/\/+$/, '');
}
export function validatePartsManifest(value, expected = EXPECTED_ARCHIVE, partSize = PART_SIZE) {
  archiveSettings(expected);
  if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > PART_SIZE) throw new Error('Invalid expected part size');
  if (!value || value.schemaVersion !== 1 || value.partSize !== partSize || !value.archive ||
      value.archive.name !== expected.name || value.archive.size !== expected.size || value.archive.sha256 !== expected.sha256 || !Array.isArray(value.parts)) throw new Error('PARTS.json does not match the fixed archive');
  const count = Math.ceil(expected.size / partSize);
  if (value.parts.length !== count) throw new Error('Unexpected part count');
  for (const [i, part] of value.parts.entries()) {
    const name = expected.name + '.part-' + String(i + 1).padStart(3, '0');
    const size = Math.min(partSize, expected.size - i * partSize);
    if (!part || part.name !== name || part.size !== size || !HASH.test(part.sha256)) throw new Error(`Invalid part entry: ${i + 1}`);
  }
  return value;
}

// All HTTP goes through the installed curl, preserving its ordinary system
// proxy/CA configuration. Flags below work with Alibaba Cloud Linux curl 7.61.
async function runCurl(args) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('curl', args, { shell:false, stdio:['ignore','ignore','pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.once('error', reject);
    child.once('close', code => resolveResult({ code:code ?? 1, stderr }));
  });
}
function curlArguments(url, output, resume, tiny = false) {
  return ['--http1.1','-fL','--silent','--show-error','--connect-timeout','30','--speed-limit','1024','--speed-time','120',
    ...(resume ? ['-C','-'] : []), ...(tiny ? ['--max-filesize','65536'] : []), '-o',output,url];
}
async function curlResult(runner, args) {
  try { return await runner(args); }
  catch (error) {
    if (Number.isInteger(error.code)) return { code:error.code, stderr:String(error.stderr || error.message || '') };
    throw error;
  }
}
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
async function quarantine(path) {
  if (await regular(path, true)) await rename(path, path + '.bad-' + randomUUID());
}
async function readManifest(directory, release, expected, partSize, runner, pause, log) {
  const path = join(directory, '.PARTS.' + randomUUID() + '.json');
  try {
    let failure;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const result = await curlResult(runner, curlArguments(release + '/PARTS.json', path, false, true));
      if (result.code === 0) {
        const info = await regular(path);
        if (info.size > 65536) throw new Error('PARTS.json exceeds 64 KiB');
        return validatePartsManifest(JSON.parse(await readFile(path, 'utf8')), expected, partSize);
      }
      failure = new Error(`PARTS.json download failed (curl ${result.code}): ${result.stderr || ''}`);
      if (attempt < 5) { log(`Retrying PARTS.json (${attempt + 1}/5)`); await pause(5000); }
    }
    throw failure;
  } finally { await rm(path, { force:true }); }
}
async function seedPrefix(archive, partsDirectory, manifest, log) {
  const info = await regular(archive, true);
  if (!info || !info.size) return;
  const input = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  let seeded = 0;
  try {
    for (const [i, part] of manifest.parts.entries()) {
      const start = i * manifest.partSize;
      if (start >= info.size) break;
      const target = join(partsDirectory, part.name);
      if (await regular(target, true)) continue;
      const end = Math.min(start + part.size, info.size) - 1;
      const output = await open(target, 'wx', 0o600);
      try { await pipeline(input.createReadStream({ start,end,autoClose:false }), output.createWriteStream()); }
      finally { await output.close().catch(() => {}); }
      seeded += end - start + 1;
    }
  } finally { await input.close(); }
  if (seeded) log(`Reused ${seeded} bytes from the original partial archive; original file preserved.`);
}
async function getPart(part, directory, release, runner, pause, log) {
  const path = join(directory, part.name);
  if (await matches(path, part)) return true;
  const initial = await regular(path, true);
  if (initial && initial.size >= part.size) await quarantine(path);
  let failure;
  for (let attempt = 1; attempt <= 5; attempt++) {
    // A prior interrupted attempt can already have finished writing the part.
    if (await matches(path, part)) return true;
    const result = await curlResult(runner, curlArguments(release + '/' + encodeURIComponent(part.name), path, true));
    // A resumed complete file can make old curl report range error 33/HTTP 416.
    // The file hash, rather than the curl exit code, decides whether it is done.
    if (await matches(path, part)) return false;
    const info = await regular(path, true);
    const rangeUnsupported = result.code === 33 || result.code === 416 || /\b416\b/.test(result.stderr || '');
    if (info && (info.size >= part.size || rangeUnsupported)) await quarantine(path);
    failure = new Error(`${part.name}: ${result.code === 0 ? 'size/SHA-256 mismatch' : `curl ${result.code}: ${result.stderr || ''}`}`);
    if (attempt < 5) { log(`Retrying ${part.name} (${attempt + 1}/5)`); await pause(5000); }
  }
  throw failure;
}
async function assemble(directory, partsDirectory, manifest, expected) {
  const target = join(directory, expected.name);
  const staging = target + '.assembling';
  const existing = await regular(staging, true);
  if (existing) await rm(staging);
  const output = await open(staging, 'wx', 0o600);
  const hash = createHash('sha256'); let size = 0;
  try {
    for (const part of manifest.parts) {
      const file = join(partsDirectory, part.name);
      // Recheck each immutable input immediately before concatenation.
      if (!await matches(file, part)) throw new Error(`Part changed before assembly: ${part.name}`);
      const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        for await (const chunk of input.createReadStream()) {
          hash.update(chunk); size += chunk.length;
          // FileHandle.write can be short; writeFile handles the whole buffer.
          await output.writeFile(chunk);
        }
      } finally { await input.close().catch(() => {}); }
    }
    const sha256 = hash.digest('hex');
    if (size !== expected.size || sha256 !== expected.sha256) throw new Error('Assembled archive size/SHA-256 mismatch; original file preserved');
    await output.sync(); await output.close();
    await regular(target, true); // Reject a symlink introduced before replacement.
    await rename(staging, target);
    return { path:target,size,sha256 };
  } catch (error) {
    await output.close().catch(() => {}); await rm(staging, { force:true }); throw error;
  }
}

/** Overrides exist for local fixture tests; the CLI exposes only --directory. */
export async function downloadBackupParts(options = {}) {
  const expected = options.expected || EXPECTED_ARCHIVE;
  archiveSettings(expected);
  const release = releaseBase(options.releaseUrl || RELEASE_URL);
  const concurrency = options.concurrency ?? 2;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Concurrency must be between 1 and 3');
  const directory = await safeDirectory(options.directory || '/tmp/pairdeer-backup', true);
  const target = join(directory, expected.name);
  if (await matches(target, expected)) return { complete:true,reusedArchive:true,...expected,path:target };
  const runner = options.curlRunner || runCurl, pause = options.sleep || wait, log = options.onProgress || (() => {});
  log('Downloading PARTS.json with curl HTTP/1.1');
  const manifest = await readManifest(directory, release, expected, options.partSize || PART_SIZE, runner, pause, log);
  const partsDirectory = await safeDirectory(join(directory, 'pairdeer-parts'), true);
  await seedPrefix(target, partsDirectory, manifest, log);
  let index = 0, completed = 0, failure;
  async function worker() {
    while (!failure) {
      const i = index++;
      if (i >= manifest.parts.length) return;
      try {
        const reused = await getPart(manifest.parts[i], partsDirectory, release, runner, pause, log);
        completed++; log(`Verified part ${completed}/${manifest.parts.length}${reused ? ' (reused)' : ''}`);
      } catch (error) { failure ||= error; throw error; }
    }
  }
  await Promise.allSettled(Array.from({ length:concurrency }, worker));
  if (failure) throw failure;
  const proof = await assemble(directory, partsDirectory, manifest, expected);
  log(`Verified complete archive SHA-256 ${proof.sha256}`);
  return { complete:true,reusedArchive:false,name:expected.name,parts:manifest.parts.length,...proof };
}
async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return; }
  let directory;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--directory' || directory !== undefined) throw new Error(`Unknown or duplicate option: ${args[i]}`);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value for --directory');
    directory = args[++i];
  }
  const progressDirectory = resolve(directory || '/tmp/pairdeer-backup');
  let reporting = false;
  // Long downloads need visible activity even while no part has finished. This
  // timer exists only in the CLI; importing/testing the module creates no timer.
  const timer = setInterval(async () => {
    if (reporting) return;
    reporting = true;
    try {
      let received = 0;
      for (let i = 0; i < Math.ceil(EXPECTED_ARCHIVE.size / PART_SIZE); i++) {
        const name = EXPECTED_ARCHIVE.name + '.part-' + String(i + 1).padStart(3, '0');
        const info = await regular(join(progressDirectory, 'pairdeer-parts', name), true);
        const maximum = Math.min(PART_SIZE, EXPECTED_ARCHIVE.size - i * PART_SIZE);
        if (info) received += Math.min(info.size, maximum);
      }
      process.stderr.write(`Part bytes received ${(received / 1024 ** 2).toFixed(1)}/${(EXPECTED_ARCHIVE.size / 1024 ** 2).toFixed(1)} MiB (${(received * 100 / EXPECTED_ARCHIVE.size).toFixed(1)}%); SHA-256 verification continues.\n`);
    } catch { /* The primary operation reports filesystem errors. */ }
    finally { reporting = false; }
  }, 30000);
  timer.unref();
  try {
    const proof = await downloadBackupParts({ directory,onProgress:message => process.stderr.write(message + '\n') });
    process.stdout.write(JSON.stringify(proof) + '\n');
  } finally { clearInterval(timer); }
}
if (process.argv[1] && await realpath(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`Backup download failed: ${error.message}\n`); process.exitCode = 1; });
}
