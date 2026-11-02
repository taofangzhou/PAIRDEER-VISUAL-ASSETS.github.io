import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'pairdeer-runtime-'));
const previous = process.env.DATA_DIR;
process.env.DATA_DIR = join(temporary, 'persistent');
const { openDatabase, getDatabase, mediaBucket, RangeNotSatisfiableError } = await import('../lib/runtime.ts');
const bytes = new TextEncoder().encode('0123456789');
const consume = async object => new Uint8Array(await new Response(object.body).arrayBuffer());
let database;
try {
  // Build-time route imports must not write into the runtime volume.
  await assert.rejects(stat(process.env.DATA_DIR), { code: 'ENOENT' });
  database = await getDatabase();
  await database.prepare('INSERT INTO catalog (id,data,revision) VALUES (1,?,1)').bind('{"products":[]}').run();
  assert.equal((await database.prepare('SELECT revision FROM catalog WHERE id=1').first()).revision, 1);
  const changed = await database.prepare('UPDATE catalog SET revision=revision+1 WHERE id=1 AND revision=?').bind(1).run();
  const stale = await database.prepare('UPDATE catalog SET revision=revision+1 WHERE id=1 AND revision=?').bind(1).run();
  assert.equal(changed.meta.changes, 1);
  assert.equal(stale.meta.changes, 0);
  const secondConnection = await openDatabase(process.env.DATA_DIR);
  assert.equal((await secondConnection.prepare('SELECT revision FROM catalog WHERE id=1').first()).revision, 2);
  secondConnection.close();

  const name = encodeURIComponent('双鹿原图.png');
  await mediaBucket.put('test-image.png', bytes, { httpMetadata: { contentType: 'image/png' }, customMetadata: { name } });
  const original = await mediaBucket.get('test-image.png');
  assert.equal(original.customMetadata.name, name);
  assert.match(original.httpEtag, /^"[a-f0-9]{64}"$/);
  const headers = new Headers(); original.writeHttpMetadata(headers);
  assert.equal(headers.get('content-type'), 'image/png');
  assert.deepEqual(await consume(original), bytes);
  await assert.rejects(mediaBucket.put('test-image.png', new Uint8Array([1, 2])), { code: 'EEXIST' });
  assert.deepEqual(await consume(await mediaBucket.get('test-image.png')), bytes);

  for (const [range, expected] of [['bytes=2-5', '2345'], ['bytes=7-', '789'], ['bytes=-3', '789'], ['bytes=8-99', '89']]) {
    const object = await mediaBucket.get('test-image.png', { range: new Headers({ range }) });
    assert.equal(new TextDecoder().decode(await consume(object)), expected);
    assert.equal(object.range.length, expected.length);
    assert.equal(object.size, 10);
  }
  for (const range of ['bytes=10-', 'bytes=8-7', 'bytes=-0', 'bytes=0-1,4-5', 'garbage', 'bytes=']) {
    await assert.rejects(mediaBucket.get('test-image.png', { range: new Headers({ range }) }), error => error instanceof RangeNotSatisfiableError && error.size === 10);
  }
  await mediaBucket.put('streamed-video.mp4', new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 4)); controller.enqueue(bytes.slice(4)); controller.close();
  } }));
  assert.deepEqual(await consume(await mediaBucket.get('streamed-video.mp4')), bytes);
  assert.equal(await mediaBucket.get('missing.png'), null);
  await assert.rejects(mediaBucket.get('../catalog.sqlite'));
  await assert.rejects(mediaBucket.put('../outside.png', bytes));
  await writeFile(join(temporary, 'outside'), 'private');
  await symlink(join(temporary, 'outside'), join(process.env.DATA_DIR, 'media', 'symlink.png'));
  await assert.rejects(mediaBucket.get('symlink.png'));

  database.close(); database = undefined;
  const reopened = await openDatabase(process.env.DATA_DIR);
  assert.equal((await reopened.prepare('SELECT revision FROM catalog WHERE id=1').first()).revision, 2);
  reopened.close();
  const sidecar = JSON.parse(await readFile(join(process.env.DATA_DIR, 'media', 'test-image.png.metadata.json'), 'utf8'));
  assert.equal(sidecar.customMetadata.name, name);
  console.log('PASS: lazy SQLite initialization, persistent revisions, stale-write rejection, immutable disk media, streaming upload/read, byte ranges, traversal/symlink rejection.');
} finally {
  database?.close();
  if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous;
  await rm(temporary, { recursive: true, force: true });
}
