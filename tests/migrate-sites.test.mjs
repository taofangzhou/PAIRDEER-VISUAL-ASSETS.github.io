import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { migrateSites } from '../scripts/migrate-sites.mjs';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/migrate-sites.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const catalog = (images = ['/api/media/preview.webp']) => ({ products: [{ id: 'p1', name: '双鹿', mainImages: images }], banners: [] });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pairdeer-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const backupDir = join(directory, 'backup');
  const dataDir = join(directory, 'data');
  await mkdir(join(backupDir, 'media'), { recursive: true });
  const downloadMapPath = join(directory, 'download-map.json');
  await writeFile(downloadMapPath, JSON.stringify({ '/api/media/preview.webp': '/api/media/original.png' }));
  const objects = { 'preview.webp': Buffer.from('preview-image'), 'original.png': Buffer.from('original-image') };
  await writeFile(join(backupDir, 'catalog.json'), JSON.stringify({ data: catalog(), revision: 19 }));
  for (const [key, bytes] of Object.entries(objects)) await writeFile(join(backupDir, 'media', key), bytes);
  return { directory, backupDir, dataDir, downloadMapPath, objects };
}

async function savedDatabase(f) {
  await mkdir(f.dataDir, { recursive: true });
  const database = new DatabaseSync(join(f.dataDir, 'catalog.sqlite'));
  database.exec('CREATE TABLE catalog(id INTEGER PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL); CREATE TABLE favorites(user_id TEXT PRIMARY KEY,data TEXT)');
  database.prepare('INSERT INTO catalog VALUES(1,?,7)').run(JSON.stringify(catalog(['/api/media/old.png'])));
  database.prepare('INSERT INTO favorites VALUES(?,?)').run('kept-user', '["p2"]');
  database.close();
}

function readDatabase(f) {
  const database = new DatabaseSync(join(f.dataDir, 'catalog.sqlite'), { readOnly: true });
  try { return database.prepare('SELECT * FROM catalog WHERE id=1').get(); }
  finally { database.close(); }
}

test('offline migration validates originals, rewrites old URLs and preserves other tables', async t => {
  const f = await fixture(t);
  await savedDatabase(f);
  await writeFile(join(f.backupDir, 'catalog.json'), JSON.stringify({ data: catalog(['https://old.chatgpt.site/api/media/preview.webp?download=1']), revision: 23 }));
  const manifest = Object.fromEntries(Object.entries(f.objects).map(([key, bytes]) => [key, {
    size: bytes.length, sha256: hash(bytes), mime: key.endsWith('.png') ? 'image/png' : 'image/webp',
  }]));
  await writeFile(join(f.backupDir, 'objects.json'), JSON.stringify(manifest));
  const result = await migrateSites({ ...f, replace: true, oldOrigin: 'https://old.chatgpt.site' });
  assert.equal(result.media, 2);
  assert.equal(result.revision, 23);
  assert.equal(result.bytes, Object.values(f.objects).reduce((n, b) => n + b.length, 0));
  const row = readDatabase(f);
  assert.equal(row.revision, 23);
  assert.equal(JSON.parse(row.data).products[0].mainImages[0], '/api/media/preview.webp?download=1');
  const database = new DatabaseSync(join(f.dataDir, 'catalog.sqlite'));
  assert.equal(database.prepare('SELECT data FROM favorites WHERE user_id=?').get('kept-user').data, '["p2"]');
  database.close();
  for (const [key, bytes] of Object.entries(f.objects)) {
    assert.deepEqual(await readFile(join(f.dataDir, 'media', key)), bytes);
    const metadata = JSON.parse(await readFile(join(f.dataDir, 'media', key + '.metadata.json'), 'utf8'));
    assert.equal(metadata.etag, hash(bytes));
    assert.equal(metadata.customMetadata.name, encodeURIComponent(key));
  }
  // Same immutable media can be verified and reused on an explicit second import.
  assert.equal((await migrateSites({ ...f, replace: true, oldOrigin: 'https://old.chatgpt.site' })).media, 2);
});

test('existing catalog requires explicit replacement before importing anything', async t => {
  const f = await fixture(t);
  await savedDatabase(f);
  const before = readDatabase(f);
  await assert.rejects(migrateSites(f), /already exists/);
  assert.deepEqual(readDatabase(f), before);
  await assert.rejects(readFile(join(f.dataDir, 'media', 'original.png')), { code: 'ENOENT' });
});

test('missing mapped original or partial import failure leaves catalog untouched', async t => {
  const f = await fixture(t);
  await savedDatabase(f);
  const before = readDatabase(f);
  await rm(join(f.backupDir, 'media', 'original.png'));
  await assert.rejects(migrateSites({ ...f, replace: true }), /ENOENT/);
  assert.deepEqual(readDatabase(f), before);
  // A later missing preview after a verified original also cannot replace the catalog.
  await writeFile(join(f.backupDir, 'media', 'original.png'), f.objects['original.png']);
  await rm(join(f.backupDir, 'media', 'preview.webp'));
  await assert.rejects(migrateSites({ ...f, replace: true }), /ENOENT/);
  assert.deepEqual(readDatabase(f), before);
});

test('checksum mismatch and immutable destination mismatch cannot commit catalog', async t => {
  const f = await fixture(t);
  await writeFile(join(f.backupDir, 'objects.json'), JSON.stringify({ 'original.png': { size: 14, sha256: '0'.repeat(64), mime: 'image/png' } }));
  await assert.rejects(migrateSites(f), /checksum mismatch/);
  await assert.rejects(readFile(join(f.dataDir, 'catalog.sqlite')), { code: 'ENOENT' });
  await rm(join(f.backupDir, 'objects.json'));
  await writeFile(join(f.dataDir, 'media', 'original.png'), 'keep-existing');
  await assert.rejects(migrateSites(f), /Immutable media differs/);
  assert.equal(await readFile(join(f.dataDir, 'media', 'original.png'), 'utf8'), 'keep-existing');
  await assert.rejects(readFile(join(f.dataDir, 'catalog.sqlite')), { code: 'ENOENT' });
});

test('rejects invalid keys and remaining Sites dependencies', async t => {
  const f = await fixture(t);
  for (const value of ['/api/media/../private.png', '/api/media/%2e%2e%2fprivate.png', '/api/media/UPPER.png',
    'https://other.chatgpt.site/api/media/preview.webp', 'https://chatgpt.site/login']) {
    await writeFile(join(f.backupDir, 'catalog.json'), JSON.stringify(catalog([value])));
    await assert.rejects(migrateSites(f), /Invalid media key|Unmigrated Sites URL/);
  }
  await writeFile(join(f.backupDir, 'catalog.json'), JSON.stringify({ ...catalog(), notes: 'Visit https://old.chatgpt.site/login first' }));
  await assert.rejects(migrateSites(f), /Unmigrated Sites URL/);
  await assert.rejects(migrateSites({ ...f, source: 'https://old.example' }), /exactly one/);
  await assert.rejects(migrateSites({ source: 'http://remote.example', dataDir: f.dataDir }), /HTTPS origin/);
});

test('rejects symlink source files, media directories, metadata and database', async t => {
  for (const target of ['backup-media', 'destination-media', 'metadata', 'database', 'catalog']) {
    const f = await fixture(t);
    const outside = join(f.directory, 'outside');
    await writeFile(outside, 'private');
    if (target === 'backup-media') {
      await rm(join(f.backupDir, 'media', 'preview.webp'));
      await symlink(outside, join(f.backupDir, 'media', 'preview.webp'));
    } else if (target === 'destination-media') {
      await mkdir(f.dataDir);
      await symlink(join(f.backupDir, 'media'), join(f.dataDir, 'media'));
    } else if (target === 'metadata') {
      await mkdir(join(f.dataDir, 'media'), { recursive: true });
      await symlink(outside, join(f.dataDir, 'media', 'original.png.metadata.json'));
    } else if (target === 'database') {
      await mkdir(f.dataDir);
      await symlink(outside, join(f.dataDir, 'catalog.sqlite'));
    } else {
      await rm(join(f.backupDir, 'catalog.json'));
      await symlink(outside, join(f.backupDir, 'catalog.json'));
    }
    await assert.rejects(migrateSites(f), /regular file|Unsafe directory/);
    assert.equal(await readFile(outside, 'utf8'), 'private');
  }
});

async function serverFixture(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('CLI streams HTTP media, includes every original mapping and preserves filenames', async t => {
  const f = await fixture(t);
  const received = new Set();
  let source;
  source = await serverFixture(t, (req, res) => {
    if (req.url === '/api/catalog') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: catalog([`${source}/api/media/test-preview.webp`]), revision: 31 }));
      return;
    }
    const key = new URL(req.url, source).pathname.slice('/api/media/'.length);
    received.add(key);
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' }[key.split('.').at(-1)];
    res.setHeader('content-type', mime);
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent('双鹿原图.' + key.split('.').at(-1))}`);
    // Write several chunks so streaming, not just a buffered response, is exercised.
    res.write('chunk-one'); res.write('chunk-two'); res.end('chunk-three');
  });
  const { stdout } = await run(process.execPath, [script, '--source', source, '--data-dir', f.dataDir]);
  const result = JSON.parse(stdout);
  const map = JSON.parse(await readFile(new URL('../lib/download-map.json', import.meta.url), 'utf8'));
  const expected = new Set(Object.values(map).filter(s => s.startsWith('/api/media/')).map(s => s.split('/').at(-1)));
  expected.add('test-preview.webp');
  assert.deepEqual(received, expected);
  assert.equal(result.media, expected.size);
  assert.equal(JSON.parse(readDatabase(f).data).products[0].mainImages[0], '/api/media/test-preview.webp');
  const metadata = JSON.parse(await readFile(join(f.dataDir, 'media', 'test-preview.webp.metadata.json'), 'utf8'));
  assert.equal(metadata.customMetadata.name, encodeURIComponent('双鹿原图.webp'));
  assert.equal(metadata.etag, hash('chunk-onechunk-twochunk-three'));
});

test('HTTP errors, security HTML, oversized streams and timeouts cannot create a catalog', async t => {
  const f = await fixture(t);
  let mode = 'error';
  const source = await serverFixture(t, (req, res) => {
    if (req.url === '/api/catalog') return res.end(JSON.stringify(catalog()));
    if (mode === 'error') { res.writeHead(503); res.end('failed'); }
    else if (mode === 'html') { res.setHeader('content-type', 'text/html'); res.end('<h1>You have been blocked</h1>'); }
    else if (mode === 'large') { res.setHeader('content-type', 'image/png'); res.write('1234'); res.end('5678'); }
    // timeout deliberately leaves the response pending until fetch aborts.
  });
  const options = { source, dataDir: f.dataDir, downloadMapPath: f.downloadMapPath };
  await assert.rejects(migrateSites(options), /HTTP 503/);
  mode = 'html';
  await assert.rejects(migrateSites(options), /Invalid media length or content type/);
  mode = 'large';
  await assert.rejects(migrateSites({ ...options, maxFileBytes: 4 }), /size limit/);
  mode = 'timeout';
  await assert.rejects(migrateSites({ ...options, timeoutMs: 50 }), /timed out|aborted/i);
  await assert.rejects(readFile(join(f.dataDir, 'catalog.sqlite')), { code: 'ENOENT' });
});

test('CLI help and malformed options do not begin migration', async () => {
  const { stdout } = await run(process.execPath, [script, '--help']);
  assert.match(stdout, /before DNS switches/);
  await assert.rejects(run(process.execPath, [script, '--data-dir']), /Missing value/);
  await assert.rejects(run(process.execPath, [script, '--unknown']), /Unknown or duplicate/);
});

test('CLI executes through the ECS current release symlink', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pairdeer-current-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const current = join(directory, 'current');
  await symlink(dirname(dirname(script)), current, 'dir');
  const entry = join(current, 'scripts', 'migrate-sites.mjs');
  const { stdout } = await run(process.execPath, [entry, '--help']);
  assert.match(stdout, /before DNS switches/);
  await assert.rejects(run(process.execPath, [entry, '--data-dir']), /Missing value/);
});
