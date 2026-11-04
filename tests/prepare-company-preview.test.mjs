import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
const execute = promisify(execFile);
const script = resolve('scripts/prepare-company-preview.mjs');
const originalBytes = await readFile('tests/fixtures/company-preview.pdf');

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pairdeer-prepare-preview-'));
  await mkdir(join(directory, 'media'));
  await writeFile(join(directory, 'media', 'published.pdf'), originalBytes);
  const catalog = {
    products: [{ id: 'retain-this-product' }], banners: [], _imports: ['retain-import'], copy: { heading: 'Keep text' },
    companyMaterials: {
      pdf: { url: '/api/media/published.pdf', name: 'Published.pdf', size: originalBytes.length, updatedAt: '2026-11-03T00:00:00.000Z' },
      video: { url: '/api/media/published.mp4', name: 'Published.mp4', size: 123, updatedAt: '2026-11-02T00:00:00.000Z' },
    },
  };
  const db = new DatabaseSync(join(directory, 'catalog.sqlite'));
  db.exec('CREATE TABLE catalog(id INTEGER PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL)');
  db.prepare('INSERT INTO catalog VALUES(1,?,11)').run(JSON.stringify(catalog)); db.close();
  const run = (extra={}) => execute(process.execPath, [script], { env: { ...process.env, DATA_DIR: directory, ...extra } });
  const snapshot = () => {
    const database = new DatabaseSync(join(directory, 'catalog.sqlite'), { readOnly: true });
    const row = database.prepare('SELECT data,revision FROM catalog WHERE id=1').get(); database.close();
    return { catalog: JSON.parse(row.data), revision: row.revision };
  };
  return { directory, catalog, run, snapshot };
}

test('prepares actual Poppler JPEG pages once, retains exact originals and all other catalog data', async () => {
  const { directory, catalog, run, snapshot } = await fixture();
  try {
    const result = JSON.parse((await run()).stdout);
    assert.equal(result.changed, true); assert.equal(result.pages, 1);
    const first = snapshot();
    assert.equal(first.revision, 12);
    const pages = first.catalog.companyMaterials.pdf.previewPages;
    assert.equal(pages.length, 1); assert.match(pages[0], /^\/api\/media\/[a-z0-9-]+\.jpg$/);
    assert.deepEqual((await readFile(join(directory, 'media', pages[0].split('/').at(-1)))).subarray(0,3), Buffer.from([255,216,255]));
    const retained = structuredClone(first.catalog); delete retained.companyMaterials.pdf.previewPages;
    assert.deepEqual(retained, catalog);
    assert.deepEqual(await readFile(join(directory, 'media', 'published.pdf')), originalBytes);
    const files = (await readdir(join(directory, 'media'))).sort();
    const second = JSON.parse((await run()).stdout);
    assert.equal(second.changed, false);
    assert.deepEqual(snapshot(), first);
    assert.deepEqual((await readdir(join(directory, 'media'))).sort(), files);
    assert.equal((await readdir(directory)).filter(name => name.startsWith('.company-preview-')).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conversion failure never publishes or modifies originals', async () => {
  const { directory, run, snapshot } = await fixture();
  try {
    const before = snapshot();
    await assert.rejects(run({ PDFINFO_BIN: join(directory, 'missing-pdfinfo') }), error => /poppler-utils/.test(error.stderr));
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await readFile(join(directory, 'media', 'published.pdf')), originalBytes);
    assert.deepEqual(await readdir(join(directory, 'media')), ['published.pdf']);
    assert.equal((await readdir(directory)).filter(name => name.startsWith('.company-preview-')).length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cross-process conversion lock rejects concurrent rendering and leaves the catalog intact', async () => {
  const { directory, run, snapshot } = await fixture();
  const holder = spawn('flock', ['--nonblock', '--no-fork', join(directory, '.company-preview.lock'), process.execPath,
    '-e', 'process.stdout.write("LOCKED\\n");setInterval(()=>{},1000)'], { stdio: ['ignore','pipe','pipe'] });
  try {
    await once(holder.stdout, 'data');
    const before = snapshot();
    await assert.rejects(run(), error => /另一份 PDF 正在生成预览/.test(error.stderr));
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(await readdir(join(directory, 'media')), ['published.pdf']);
  } finally {
    const stopped = once(holder, 'exit'); holder.kill('SIGTERM'); await stopped;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a concurrent administrator PDF replacement wins over prepared previews', async () => {
  const { directory, run, snapshot } = await fixture();
  try {
    const wrapper = join(directory, 'convert-and-replace.mjs');
    await writeFile(wrapper, `#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
await promisify(execFile)('pdftoppm',process.argv.slice(2));
const db=new DatabaseSync(join(process.env.DATA_DIR,'catalog.sqlite'));
const data=JSON.parse(db.prepare('SELECT data FROM catalog WHERE id=1').get().data);
data.companyMaterials.pdf.url='/api/media/admin-replacement.pdf';
db.prepare('UPDATE catalog SET data=?,revision=revision+1 WHERE id=1').run(JSON.stringify(data));db.close();
`, { mode: 0o700 });
    await assert.rejects(run({ PDFTOPPM_BIN: wrapper }), error => /PDF 已由管理员替换/.test(error.stderr));
    const after = snapshot();
    assert.equal(after.revision, 12);
    assert.equal(after.catalog.companyMaterials.pdf.url, '/api/media/admin-replacement.pdf');
    assert.equal(after.catalog.companyMaterials.pdf.previewPages, undefined);
    assert.deepEqual(await readdir(join(directory, 'media')), ['published.pdf'], 'unpublished prepared JPGs removed after CAS conflict');
    assert.deepEqual(await readFile(join(directory, 'media', 'published.pdf')), originalBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
