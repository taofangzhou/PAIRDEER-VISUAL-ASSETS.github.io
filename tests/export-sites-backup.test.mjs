import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportSiteBackup, verifySiteBackup } from '../scripts/export-sites-backup.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/export-sites-backup.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const png = text => Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.from(text)]);
const webp = text => Buffer.concat([Buffer.from('RIFF0000WEBP'), Buffer.from(text)]);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pairdeer-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['lib', 'docs', 'public/assets', 'public/downloads']) await mkdir(join(directory, name), { recursive: true });
  const bytes = { 'preview.webp': webp('preview'), 'original.png': png('original'), 'extra.png': png('registry-only'), 'new.png': png('new-object') };
  const registry = Object.fromEntries(Object.entries(bytes).filter(([key]) => key !== 'new.png').map(([key, value]) => [key, {
    sha256: hash(value), size: value.length, mime: key.endsWith('.webp') ? 'image/webp' : 'image/png',
  }]));
  await writeFile(join(directory, 'docs/import-20261102-objects.json'), JSON.stringify(registry));
  await writeFile(join(directory, 'lib/download-map.json'), JSON.stringify({ '/api/media/preview.webp': '/api/media/original.png', '/assets/preview.webp': '/downloads/original.png' }));
  await writeFile(join(directory, 'public/assets/preview.webp'), webp('static-preview'));
  await writeFile(join(directory, 'public/downloads/original.png'), png('static-original'));
  const requests = [];
  let mode = 'normal', active = 0, maxActive = 0;
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    active++; maxActive = Math.max(maxActive, active); res.on('close', () => active--);
    const key = new URL(req.url, 'http://localhost').pathname.slice('/api/media/'.length);
    if (mode === '403') { res.writeHead(403, { 'content-type': 'text/html' }); res.end('blocked'); return; }
    if (mode === 'redirect') { res.writeHead(302, { location: 'https://unapproved.example/media.png' }); res.end(); return; }
    if (mode === 'timeout') return;
    let data = bytes[key];
    if (!data) { res.writeHead(404); res.end(); return; }
    if (mode === 'checksum') data = Buffer.concat([data.subarray(0, 12), Buffer.from('changed-same-size').subarray(0, Math.max(0, data.length - 12))]);
    if (mode === 'html' || mode === 'forged-html') data = Buffer.from('<html>you have been blocked</html>');
    res.setHeader('content-type', mode === 'html' ? 'text/html' : key.endsWith('.webp') ? 'image/webp' : 'image/png');
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent('双鹿原图.' + key.split('.').at(-1))}`);
    res.write(data.subarray(0, 4));
    setTimeout(() => res.end(data.subarray(4)), 3);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const source = `http://127.0.0.1:${server.address().port}`;
  const catalogFile = join(directory, 'catalog-source.json');
  const catalogBytes = Buffer.from(JSON.stringify({ data: { products: [{ id:'p1', name:'最新目录', mainImages:[`${source}/api/media/preview.webp`, '/api/media/new.png', '/assets/preview.webp'] }], banners:[] }, revision:51 }, null, 2) + '\n');
  await writeFile(catalogFile, catalogBytes);
  return { directory, source, catalogFile, catalogBytes, projectRoot: directory, output: join(directory, 'backup'), allowHttpForTests: true,
    bytes, requests, setMode(value) { mode = value; }, maximumActive() { return maxActive; } };
}

test('exports exact latest snapshot, mapped originals, registry extras and new media with verified hashes', async t => {
  const f = await fixture(t);
  const progress = [];
  const result = await exportSiteBackup({ ...f, onProgress: item => progress.push(item) });
  assert.equal(result.complete, true); assert.equal(result.revision, 51); assert.equal(result.products, 1);
  assert.equal(result.mediaCount, 4); assert.equal(result.publicCount, 2);
  assert.ok(f.maximumActive() <= 4);
  assert.deepEqual(progress, [{ completed:4, total:4 }]);
  assert.deepEqual(await readFile(join(f.output, 'catalog.json')), f.catalogBytes);
  const objects = JSON.parse(await readFile(join(f.output, 'objects.json'), 'utf8'));
  assert.deepEqual(Object.keys(objects), Object.keys(f.bytes).sort());
  assert.deepEqual(new Set(f.requests.map(req => new URL(req.url, f.source).pathname.split('/').at(-1))), new Set(Object.keys(f.bytes)));
  for (const [key, bytes] of Object.entries(f.bytes)) {
    assert.deepEqual(await readFile(join(f.output, 'media', key)), bytes);
    assert.equal(objects[key].sha256, hash(bytes)); assert.equal(objects[key].size, bytes.length);
    const metadata = JSON.parse(await readFile(join(f.output, 'media', key + '.metadata.json'), 'utf8'));
    assert.equal(metadata.etag, hash(bytes));
    assert.equal(metadata.customMetadata.name, encodeURIComponent('双鹿原图.' + key.split('.').at(-1)));
  }
  assert.deepEqual(await verifySiteBackup(f), result);
  assert.equal(result.mediaBytes, Object.values(f.bytes).reduce((n, bytes) => n + bytes.length, 0));
  assert.equal(result.catalog.sha256, hash(f.catalogBytes));
  assert.equal(result.sourceFiles.length, 2);
  assert.ok(f.requests.every(req => req.headers.authorization === undefined && req.headers['oai-authenticated-user-id'] === undefined));
});

test('403 stops without retries or a complete output and preserves any previous backup', async t => {
  const f = await fixture(t); f.setMode('403');
  await assert.rejects(exportSiteBackup({ ...f, concurrency:1 }), /HTTP 403/);
  assert.equal(f.requests.length, 1);
  await assert.rejects(stat(f.output), { code:'ENOENT' });
  assert.equal((await readdir(f.directory)).some(name => name.includes('.staging-')), false);
  await mkdir(f.output); await writeFile(join(f.output, 'previous.txt'), 'previous-good-backup');
  await assert.rejects(exportSiteBackup({ ...f, replace:true }), /HTTP 403/);
  assert.equal(await readFile(join(f.output, 'previous.txt'), 'utf8'), 'previous-good-backup');
  await assert.rejects(stat(join(f.output, 'backup-manifest.json')), { code:'ENOENT' });
});

test('checksum mismatch, HTML, forged MIME, redirects and timeouts never publish a backup', async t => {
  for (const [mode, pattern] of [['checksum', /checksum mismatch/], ['html', /MIME/], ['forged-html', /HTML\/invalid signature/], ['redirect', /fetch failed|redirect/], ['timeout', /timed out|aborted/i]]) {
    const f = await fixture(t); f.setMode(mode);
    await assert.rejects(exportSiteBackup({ ...f, concurrency:1, timeoutMs: mode === 'timeout' ? 30 : 1000 }), pattern);
    await assert.rejects(stat(f.output), { code:'ENOENT' });
  }
});

test('missing static originals fail before any source request; malformed snapshots never use seed', async t => {
  const f = await fixture(t);
  await rm(join(f.directory, 'public/downloads/original.png'));
  await assert.rejects(exportSiteBackup(f), /Referenced public file is missing/);
  assert.equal(f.requests.length, 0);
  await writeFile(f.catalogFile, JSON.stringify({ products:[], banners:[] }));
  await assert.rejects(exportSiteBackup(f), /latest catalog envelope/);
  assert.equal(f.requests.length, 0);
});

test('verification rejects altered bytes, missing and extra media and changed repository public files', async t => {
  const f = await fixture(t); await exportSiteBackup(f);
  await writeFile(join(f.output, 'media', 'original.png'), png('tampered'));
  await assert.rejects(verifySiteBackup(f), /checksum mismatch/);
  await writeFile(join(f.output, 'media', 'original.png'), f.bytes['original.png']);
  await writeFile(join(f.output, 'media', 'extra-unlisted.png'), png('extra'));
  await assert.rejects(verifySiteBackup(f), /Missing or extra/);
  await rm(join(f.output, 'media', 'extra-unlisted.png'));
  await writeFile(join(f.directory, 'public/downloads/original.png'), png('different-static'));
  await assert.rejects(verifySiteBackup(f), /public\/source files changed/);
});

test('explicit replacement changes previous output only after a verified complete export', async t => {
  const f = await fixture(t);
  await mkdir(f.output); await writeFile(join(f.output, 'previous.txt'), 'keep');
  await assert.rejects(exportSiteBackup(f), /already exists/);
  assert.equal(f.requests.length, 0);
  const result = await exportSiteBackup({ ...f, replace:true });
  assert.equal(result.complete, true);
  await assert.rejects(stat(join(f.output, 'previous.txt')), { code:'ENOENT' });
  assert.equal((await readdir(f.directory)).some(name => name.includes('.previous-') || name.includes('.staging-')), false);
});

test('source, concurrency, size bounds and CLI flags fail closed', async t => {
  const f = await fixture(t);
  await assert.rejects(exportSiteBackup({ ...f, allowHttpForTests:false }), /HTTPS origin/);
  await assert.rejects(exportSiteBackup({ ...f, source:'http://remote.example' }), /HTTPS origin/);
  await assert.rejects(exportSiteBackup({ ...f, source:'https://user:pass@example.com' }), /HTTPS origin/);
  await assert.rejects(exportSiteBackup({ ...f, concurrency:5 }), /Invalid concurrency/);
  await assert.rejects(exportSiteBackup({ ...f, timeoutMs:600001 }), /Invalid timeout/);
  await assert.rejects(exportSiteBackup({ ...f, maxTotalBytes:1 }), /total size limit/);
  await assert.rejects(exportSiteBackup({ ...f, maxFileBytes:2 }), /size limit/);
  const { stdout } = await run(process.execPath, [script, '--help']);
  assert.match(stdout, /HTTP 403/);
  await assert.rejects(run(process.execPath, [script, '--source']), /Missing value/);
  await assert.rejects(run(process.execPath, [script, '--unknown']), /Unknown or duplicate/);
  await assert.rejects(run(process.execPath, [script, '--source', 'https://example.com', '--source', 'https://other.example']), /duplicate/);
});
