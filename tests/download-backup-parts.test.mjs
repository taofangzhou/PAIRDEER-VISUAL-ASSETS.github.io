import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { downloadBackupParts, validatePartsManifest } from '../scripts/download-backup-parts.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/download-backup-parts.mjs', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pairdeer-parts-'));
  t.after(() => rm(directory, { recursive:true,force:true }));
  const bytes = Buffer.from('abcdefghijklmn');
  const expected = { name:'test-backup.tar.gz',size:bytes.length,sha256:hash(bytes) };
  const partSize = 4;
  const parts = Array.from({ length:Math.ceil(bytes.length / partSize) }, (_, i) => {
    const slice = bytes.subarray(i * partSize, (i + 1) * partSize);
    return { name:expected.name + '.part-' + String(i + 1).padStart(3,'0'),size:slice.length,sha256:hash(slice) };
  });
  const manifest = { schemaVersion:1,archive:{ ...expected },partSize,parts };
  const calls = [];
  const curlRunner = async args => {
    assert.ok(args.includes('--http1.1')); assert.ok(args.includes('-fL'));
    assert.ok(args.includes('--connect-timeout')); assert.ok(args.includes('--speed-time'));
    assert.equal(args.includes('--retry-all-errors'), false);
    const url = new URL(args.at(-1)), output = args[args.indexOf('-o') + 1];
    const name = decodeURIComponent(url.pathname.split('/').at(-1));
    if (name === 'PARTS.json') { calls.push({ name }); await writeFile(output, JSON.stringify(manifest)); return { code:0 }; }
    assert.ok(args.includes('-C')); assert.equal(args[args.indexOf('-C') + 1], '-');
    const i = parts.findIndex(part => part.name === name); assert.ok(i >= 0);
    let existing; try { existing = await readFile(output); } catch (error) { if (error.code !== 'ENOENT') throw error; existing = Buffer.alloc(0); }
    calls.push({ name,offset:existing.length });
    const correct = bytes.subarray(i * partSize, (i + 1) * partSize);
    await writeFile(output, Buffer.concat([existing,correct.subarray(existing.length)]));
    return { code:0 };
  };
  return { directory,expected,partSize,manifest,bytes,parts,calls,curlRunner,sleep:async () => {},releaseUrl:'https://example.test/releases/fixed' };
}

test('reuses the exact original prefix, resumes the partial next part and assembles only listed parts', async t => {
  const f = await fixture(t), target = join(f.directory, f.expected.name);
  await writeFile(target, f.bytes.subarray(0,6));
  const progress = [];
  const result = await downloadBackupParts({ ...f,onProgress:message => progress.push(message) });
  assert.equal(result.complete,true); assert.equal(result.parts,4);
  assert.equal(result.sha256,f.expected.sha256); assert.deepEqual(await readFile(target),f.bytes);
  assert.equal(f.calls.some(call => call.name === f.parts[0].name),false);
  assert.equal(f.calls.find(call => call.name === f.parts[1].name).offset,2);
  assert.ok(progress.some(line => line.includes('Reused 6 bytes')));
  assert.ok(progress.some(line => line.includes('Verified part 4/4')));
  // A complete verified original needs no manifest or part request on the next run.
  const count = f.calls.length;
  assert.equal((await downloadBackupParts(f)).reusedArchive,true);
  assert.equal(f.calls.length,count);
});

test('bad part hashes exhaust bounded retries without changing the original partial archive', async t => {
  const f = await fixture(t), target = join(f.directory,f.expected.name), original = f.bytes.subarray(0,6);
  await writeFile(target,original);
  const runner = async args => {
    const output = args[args.indexOf('-o') + 1];
    if (args.at(-1).endsWith('/PARTS.json')) { await writeFile(output,JSON.stringify(f.manifest)); return { code:0 }; }
    const name = decodeURIComponent(new URL(args.at(-1)).pathname.split('/').at(-1));
    const part = f.parts.find(part => part.name === name);
    await writeFile(output,Buffer.alloc(part.size,0)); return { code:0 };
  };
  await assert.rejects(downloadBackupParts({ ...f,curlRunner:runner,concurrency:1 }),/SHA-256 mismatch/);
  assert.deepEqual(await readFile(target),original);
  const ownFiles = await readdir(join(f.directory,'pairdeer-parts'));
  assert.ok(ownFiles.some(name => name.includes('.bad-')));
  await assert.rejects(readFile(target + '.assembling'),{ code:'ENOENT' });
});

test('curl range errors check the hash then restart an incomplete unsupported range safely', async t => {
  const f = await fixture(t), target = join(f.directory,f.expected.name);
  await writeFile(target,f.bytes.subarray(0,2));
  let first = true;
  const normal = f.curlRunner;
  const runner = async args => {
    if (!args.at(-1).endsWith('/PARTS.json') && first) { first = false; return { code:33,stderr:'HTTP server does not support byte ranges' }; }
    return normal(args);
  };
  await downloadBackupParts({ ...f,curlRunner:runner,concurrency:1 });
  assert.equal(f.calls.find(call => call.name === f.parts[0].name).offset,0);
  assert.deepEqual(await readFile(target),f.bytes);
});

test('already completed part bytes win over curl 416 and all complete parts skip HTTP', async t => {
  const f = await fixture(t);
  await mkdir(join(f.directory,'pairdeer-parts'));
  await writeFile(join(f.directory,'pairdeer-parts',f.parts[0].name),f.bytes.subarray(0,4));
  const normal = f.curlRunner;
  const runner = async args => {
    const result = await normal(args);
    if (!args.at(-1).endsWith('/PARTS.json')) return { code:22,stderr:'curl: (22) The requested URL returned error: 416' };
    return result;
  };
  const result = await downloadBackupParts({ ...f,curlRunner:runner });
  assert.equal(result.complete,true);
  assert.equal(f.calls.some(call => call.name === f.parts[0].name),false);
});

test('untrusted manifest paths, archive mismatch and symlinks fail without replacing data', async t => {
  const f = await fixture(t);
  const bad = structuredClone(f.manifest); bad.parts[0].name = '../escape';
  assert.throws(() => validatePartsManifest(bad,f.expected,f.partSize),/Invalid part/);
  const mismatch = structuredClone(f.manifest); mismatch.archive.sha256 = '0'.repeat(64);
  assert.throws(() => validatePartsManifest(mismatch,f.expected,f.partSize),/fixed archive/);
  const wrongSize = structuredClone(f.manifest); wrongSize.parts.at(-1).size++;
  assert.throws(() => validatePartsManifest(wrongSize,f.expected,f.partSize),/Invalid part/);
  const outside = join(f.directory,'outside'); await writeFile(outside,'keep');
  await symlink(outside,join(f.directory,f.expected.name));
  await assert.rejects(downloadBackupParts(f),/regular file/);
  assert.equal(await readFile(outside,'utf8'),'keep');
  await assert.rejects(downloadBackupParts({ ...f,directory:'/' }),/filesystem root/);
});

test('full archive SHA mismatch fails assembly and leaves the original archive unchanged', async t => {
  const f = await fixture(t), target = join(f.directory,f.expected.name), original = Buffer.from('keep');
  await writeFile(target,original);
  const wrong = { ...f.expected,sha256:'1'.repeat(64) };
  f.manifest.archive.sha256 = wrong.sha256;
  await assert.rejects(downloadBackupParts({ ...f,expected:wrong }),/Assembled archive size\/SHA-256 mismatch/);
  assert.deepEqual(await readFile(target),original);
  await assert.rejects(readFile(target + '.assembling'),{ code:'ENOENT' });
});

test('CLI accepts only directory and help; malformed options do not request HTTP', async () => {
  const { stdout } = await run(process.execPath,[script,'--help']);
  assert.match(stdout,/curl 7.61/);
  await assert.rejects(run(process.execPath,[script,'--directory']),/Missing value/);
  await assert.rejects(run(process.execPath,[script,'--release','https://bad.example']),/Unknown/);
});
