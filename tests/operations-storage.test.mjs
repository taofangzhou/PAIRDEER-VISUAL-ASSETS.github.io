import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const NOW = Date.parse('2026-11-06T04:00:00.000Z');
const DAY = 86_400_000;
const key = '0123456789abcdef'.repeat(4);
const hmac = value => createHmac('sha256', key).update(value).digest('hex');
const plain = value => JSON.parse(JSON.stringify(value));

async function fixture(t, seed) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pairdeer-operations-storage-'));
  const previous = { ...process.env };
  Object.assign(process.env, { DATA_DIR: directory, NODE_ENV: 'test', ADMIN_SESSION_SECRET: 'storage-test-only-session-secret-at-least-32-characters' });
  delete process.env.ALLOW_INSECURE_COOKIES;
  if (seed) seed(path.join(directory, 'operations.sqlite'));
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW; } }
  const context = vm.createContext({ Date: ClockDate, ReadableStream, TextEncoder, TextDecoder, Request, Response, Headers, File, FormData,
    URL, URLSearchParams, crypto, console, fetch, Uint8Array, ArrayBuffer, Buffer, process, AbortSignal, setTimeout, clearTimeout });
  const modules = new Map();
  function synthetic(id, values) {
    const module = new vm.SyntheticModule(Object.keys(values), function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context, identifier: id });
    modules.set(id, module); return module;
  }
  async function load(id) {
    if (modules.has(id)) return modules.get(id);
    if (id.startsWith('node:')) return synthetic(id, await import(id));
    if (id.endsWith('.json')) return synthetic(id, { default: JSON.parse(fs.readFileSync(id, 'utf8')) });
    const source = ts.transpileModule(fs.readFileSync(id, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const module = new vm.SourceTextModule(source, { context, identifier: id }); modules.set(id, module);
    await module.link((specifier, ref) => {
      let target = specifier.startsWith('@/') ? path.resolve(specifier.slice(2)) : specifier.startsWith('.') ? path.resolve(path.dirname(ref.identifier), specifier) : specifier;
      if (target.startsWith('/') && !path.extname(target)) target += '.ts';
      return load(target);
    }); return module;
  }
  const module = await load(path.resolve('lib/operations.ts')); await module.evaluate();
  const core = module.namespace;
  t.after(async () => {
    await core.closeOperationsDatabase(); fs.rmSync(directory, { recursive: true, force: true });
    for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
  });
  return { directory, core };
}

function legacyDatabase(filename) {
  const database = new DatabaseSync(filename);
  database.exec(`
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE visitors(hash TEXT PRIMARY KEY,first_day TEXT NOT NULL);
    CREATE TABLE daily(day TEXT PRIMARY KEY,new_visitors INTEGER NOT NULL DEFAULT 0,page_views INTEGER NOT NULL DEFAULT 0,
      searches INTEGER NOT NULL DEFAULT 0,download_pdf INTEGER NOT NULL DEFAULT 0,download_video INTEGER NOT NULL DEFAULT 0,
      download_image INTEGER NOT NULL DEFAULT 0,download_detail INTEGER NOT NULL DEFAULT 0,download_zip INTEGER NOT NULL DEFAULT 0,
      admin_added INTEGER NOT NULL DEFAULT 0,admin_replaced INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE hot_models(day TEXT NOT NULL,model TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,model));
    CREATE TABLE event_dedup(id TEXT PRIMARY KEY,recorded_at INTEGER NOT NULL);
    CREATE INDEX event_dedup_expiry ON event_dedup(recorded_at);
    CREATE TABLE rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
    PRAGMA user_version=0;
  `);
  return database;
}

await test('schema-v1 migration preserves cumulative metrics, natural-month PV, canonical model totals and exact anonymous identity', async t => {
  const browser = randomUUID(), otherBrowser = randomUUID(), recent = randomUUID(), stale = randomUUID();
  let beforeSize = 0;
  const { directory, core } = await fixture(t, filename => {
    const db = legacyDatabase(filename);
    db.exec('BEGIN');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('cookie_key', key);
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('collected_since', '2026-10-31T15:59:00.000Z');
    const visitor = db.prepare('INSERT INTO visitors VALUES (?,?)');
    visitor.run(hmac('visitor:' + browser), '2026-10-31'); visitor.run(hmac('visitor:' + otherBrowser), '2026-11-01');
    const daily = db.prepare('INSERT INTO daily VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    daily.run('2026-10-31', 1, 11, 3, 2, 1, 4, 5, 17, 6, 7);
    daily.run('2026-11-01', 1, 13, 8, 3, 2, 6, 7, 19, 4, 2);
    daily.run('2026-11-06', 0, 7, 2, 1, 1, 2, 3, 7, 1, 1);
    const model = db.prepare('INSERT INTO hot_models VALUES (?,?,?)');
    model.run('2026-10-31', 'CR2016', 2); model.run('2026-11-01', 'CR2016', 5);
    model.run('2026-10-31', '5号 / AA', 4); model.run('2026-11-06', '5号 / AA', 3);
    db.prepare('INSERT INTO event_dedup VALUES (?,?)').run(recent, NOW - 60_000);
    db.prepare('INSERT INTO event_dedup VALUES (?,?)').run(stale, NOW - 2 * DAY);
    const rate = db.prepare('INSERT INTO rate_limits VALUES (?,1,?)');
    for (let index = 0; index < 8000; index++) rate.run(createHmac('sha256', key).update('legacy-rate:' + index).digest('hex'), NOW + DAY);
    db.exec('COMMIT'); db.close(); beforeSize = fs.statSync(filename).size;
  });
  const snapshot = await core.readOperationsSnapshot(NOW);
  assert.equal(snapshot.collectedSince, '2026-10-31T15:59:00.000Z');
  assert.deepEqual(plain(snapshot.totals), { visitors: 2, searches: 13,
    downloads: { pdf: 6, video: 4, image: 12, detail: 15, total: 37 }, adminMaterials: { added: 11, replaced: 10 } });
  assert.deepEqual(plain(snapshot.currentMonth), { month: '2026-11', pageViews: 20 });
  assert.deepEqual(plain(snapshot.monthly), [{ month: '2026-10', pageViews: 11 }, { month: '2026-11', pageViews: 20 }]);
  assert.deepEqual(plain(snapshot.hotModels), [{ model: '5号 / AA', count: 7 }, { model: 'CR2016', count: 7 }]);
  const { connection, key: migratedKey } = await core.getOperationsDatabase();
  assert.equal(migratedKey, key, 'existing signed cookies retain their original independent HMAC key');
  assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 2);
  assert.deepEqual(connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name),
    ['aggregates','event_dedup','hot_models','metadata','monthly','visitors']);
  for (const name of ['metadata','visitors']) assert.match(connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql, /WITHOUT\s+ROWID/i);
  assert.deepEqual(connection.prepare('PRAGMA table_info(visitors)').all().map(row => row.name), ['hash']);
  const hashes = connection.prepare('SELECT hash FROM visitors').all().map(row => Buffer.from(row.hash).toString('hex')).sort();
  assert.deepEqual(hashes, [hmac('visitor:' + browser), hmac('visitor:' + otherBrowser)].sort());
  assert.ok(connection.prepare('SELECT hash FROM visitors').all().every(row => row.hash.length === 32));
  const dedup = connection.prepare('SELECT id FROM event_dedup').all();
  assert.equal(dedup.length, 1); assert.equal(dedup[0].id.length, 16);
  assert.equal(Buffer.from(dedup[0].id).toString('hex'), recent.replaceAll('-', ''));
  const expires = Math.floor(NOW / 1000) + 365 * 86400;
  const payload = expires + '.' + browser;
  const cookie = '__Host-pairdeer_ops=' + payload + '.' + hmac('cookie:' + payload);
  await core.recordPublicAnalytics(new Request('https://stats.invalid/api/analytics', { headers: { cookie } }),
    { id: randomUUID(), type: 'pageview', page: 'home' }, NOW);
  assert.equal((await core.readOperationsSnapshot(NOW)).totals.visitors, 2, 'migration does not count the same signed browser again');
  connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const compactSize = fs.statSync(path.join(directory, 'operations.sqlite')).size;
  assert.ok(compactSize < beforeSize / 2, `obsolete rate/daily storage compacted from ${beforeSize} to ${compactSize} bytes`);
  await core.closeOperationsDatabase();
  const reopened = await core.readOperationsSnapshot(NOW);
  assert.equal(reopened.totals.visitors, 2); assert.equal(reopened.currentMonth.pageViews, 21);
  assert.equal((await core.getOperationsDatabase()).key, key);
});

await test('dedup uses bounded compact rows and 24-hour expiry while WAL remains configured for a small aggregate store', async t => {
  const { directory, core } = await fixture(t);
  const { connection } = await core.getOperationsDatabase();
  assert.equal(connection.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 64);
  assert.equal(connection.prepare('PRAGMA journal_size_limit').get().journal_size_limit, 262144);
  const insert = connection.prepare('INSERT INTO event_dedup(id,recorded_at) VALUES (?,?)');
  connection.exec('BEGIN');
  for (let index = 0; index < 10050; index++) {
    const bytes = Buffer.alloc(16); bytes.writeUInt32BE(index, 12);
    insert.run(bytes, NOW - 10_050 + index);
  }
  for (let index = 0; index < 50; index++) {
    const bytes = Buffer.alloc(16); bytes.writeUInt32BE(index + 10050, 12);
    insert.run(bytes, NOW - 2 * DAY);
  }
  connection.exec('COMMIT');
  await core.closeOperationsDatabase();
  await core.readOperationsSnapshot(NOW);
  const current = (await core.getOperationsDatabase()).connection;
  const rows = current.prepare('SELECT id,recorded_at FROM event_dedup ORDER BY recorded_at').all();
  assert.equal(rows.length, 10000, 'only the most recent retry IDs are retained');
  assert.ok(rows.every(row => row.id.length === 16 && row.recorded_at >= NOW - DAY));
  assert.equal(rows[0].recorded_at, NOW - 10000, 'oldest surplus IDs are discarded first');
  const tableNames = current.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  assert.ok(!tableNames.includes('daily') && !tableNames.includes('rate_limits'), 'neither per-day counters nor persisted rate windows are recreated');
  assert.deepEqual(current.prepare('PRAGMA table_info(event_dedup)').all().map(row => row.name), ['id','recorded_at']);
  current.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.ok(fs.statSync(path.join(directory, 'operations.sqlite')).size < 2 * 1024 * 1024, '10,000 compact retry keys fit within a small database');
  await core.closeOperationsDatabase();
  const before = fs.statSync(path.join(directory, 'operations.sqlite')).size;
  await core.readOperationsSnapshot(NOW);
  const second = (await core.getOperationsDatabase()).connection;
  second.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(fs.statSync(path.join(directory, 'operations.sqlite')).size, before, 'a read/reopen cycle does not grow persisted rate history');
});

await test('exact anonymous visitor dedup remains compact at ten thousand browsers', async t => {
  const { directory, core } = await fixture(t);
  const { connection } = await core.getOperationsDatabase();
  const filename = path.join(directory, 'operations.sqlite');
  connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const emptyBytes = fs.statSync(filename).size;
  const insert = connection.prepare('INSERT INTO visitors(hash) VALUES (?)');
  connection.exec('BEGIN');
  for (let index = 0; index < 10_000; index++) insert.run(randomBytes(32));
  connection.exec('COMMIT');
  assert.equal((await core.readOperationsSnapshot(NOW)).totals.visitors, 10_000);
  connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const visitorBytes = fs.statSync(filename).size;
  assert.ok(emptyBytes < 128 * 1024, 'new aggregate database has small fixed overhead');
  assert.ok(visitorBytes < 1024 * 1024, '10,000 exact anonymous browser hashes fit below one MiB');
  t.diagnostic(JSON.stringify({ emptyDatabaseBytes: emptyBytes, databaseBytesWith10000Visitors: visitorBytes,
    walBytesAfterCheckpoint: fs.statSync(filename + '-wal').size }));
});
