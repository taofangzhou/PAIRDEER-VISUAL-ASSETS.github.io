import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
const execute = promisify(execFile);
const script = resolve('scripts/export-company-materials.mjs');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pairdeer-company-export-'));
  const data = join(root, 'data'), checkout = join(root, 'checkout');
  await mkdir(join(data, 'media'), { recursive: true });
  for (const directory of ['.git', 'lib', 'public']) await mkdir(join(checkout, directory), { recursive: true });
  const bytes = { ppt: Buffer.from('PK\x03\x04 original deck'), preview: Buffer.from('%PDF-1.4 preview'), video: Buffer.from('0000ftyp original company video') };
  const updatedAt = '2026-11-03T00:00:00.000Z';
  const companyMaterials = {
    ppt: { url: '/api/media/deck.pptx', previewUrl: '/api/media/deck.pdf', name: '双鹿介绍.pptx', size: bytes.ppt.length, updatedAt },
    video: { url: '/api/media/company.mp4', name: '公司介绍.mp4', size: bytes.video.length, updatedAt },
  };
  await writeFile(join(data, 'media', 'deck.pptx'), bytes.ppt);
  await writeFile(join(data, 'media', 'deck.pdf'), bytes.preview);
  await writeFile(join(data, 'media', 'company.mp4'), bytes.video);
  const database = new DatabaseSync(join(data, 'catalog.sqlite'));
  database.exec('CREATE TABLE catalog(id INTEGER PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL)');
  database.prepare('INSERT INTO catalog VALUES (1,?,7)').run(JSON.stringify({ products: [{ id: 'untouched' }], companyMaterials }));
  database.close();
  const run = () => execute(process.execPath, [script, checkout], { env: { ...process.env, DATA_DIR: data } });
  return { root, data, checkout, bytes, companyMaterials, run };
}

test('exports published originals and PDF with metadata and leaves SQLite and Git untouched', async () => {
  const fixtureData = await fixture();
  const { root, data, checkout, bytes, companyMaterials, run } = fixtureData;
  try {
    await writeFile(join(checkout, '.git', 'sentinel'), 'unchanged');
    const { stdout } = await run();
    const result = JSON.parse(stdout);
    assert.equal(result.files.length, 3);
    assert.ok(result.files.every(file => file.requiresGitLfs === false));
    for (const [key, name] of [['ppt', 'company-introduction.pptx'], ['preview', 'company-introduction-preview.pdf'], ['video', 'company-introduction.mp4']]) {
      assert.deepEqual(await readFile(join(checkout, 'public', 'assets', 'company', name)), bytes[key]);
    }
    const manifest = JSON.parse(await readFile(join(checkout, 'lib', 'company-materials-defaults.json'), 'utf8'));
    assert.equal(manifest.ppt.url, '/assets/company/company-introduction.pptx');
    assert.equal(manifest.ppt.previewUrl, '/assets/company/company-introduction-preview.pdf');
    assert.equal(manifest.ppt.updatedAt, companyMaterials.ppt.updatedAt);
    assert.equal(manifest.video.size, bytes.video.length);
    assert.equal(await readFile(join(checkout, '.git', 'sentinel'), 'utf8'), 'unchanged');
    const database = new DatabaseSync(join(data, 'catalog.sqlite'), { readOnly: true });
    const row = database.prepare('SELECT data,revision FROM catalog').get();
    database.close();
    assert.equal(row.revision, 7);
    assert.equal(JSON.parse(row.data).companyMaterials.ppt.url, companyMaterials.ppt.url);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects symlink sources, symlink destination directories and unrelated company URLs', async () => {
  for (const scenario of ['source', 'destination', 'url']) {
    const { root, data, checkout, run } = await fixture();
    try {
      const outside = join(root, 'outside');
      await writeFile(outside, 'untouched');
      if (scenario === 'source') {
        await rm(join(data, 'media', 'deck.pptx'));
        await symlink(outside, join(data, 'media', 'deck.pptx'));
      } else if (scenario === 'destination') {
        await mkdir(join(root, 'elsewhere'));
        await mkdir(join(checkout, 'public', 'assets'));
        await symlink(join(root, 'elsewhere'), join(checkout, 'public', 'assets', 'company'));
      } else {
        const database = new DatabaseSync(join(data, 'catalog.sqlite'));
        const row = database.prepare('SELECT data FROM catalog').get();
        const catalog = JSON.parse(row.data);
        catalog.companyMaterials.ppt.url = '/assets/company/other.pptx';
        database.prepare('UPDATE catalog SET data=?').run(JSON.stringify(catalog));
        database.close();
      }
      await assert.rejects(run);
      assert.equal(await readFile(outside, 'utf8'), 'untouched');
      await assert.rejects(readFile(join(checkout, 'lib', 'company-materials-defaults.json')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
