import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const execute = promisify(execFile);
const script = resolve('scripts/export-company-materials.mjs');

async function fixture(staticPages = false) {
  const root = await mkdtemp(join(tmpdir(), 'pairdeer-company-export-'));
  const data = join(root, 'data'), checkout = join(root, 'checkout');
  await mkdir(join(data, 'media'), { recursive: true });
  for (const directory of ['.git', 'lib', 'public']) await mkdir(join(checkout, directory), { recursive: true });
  const bytes = { pdf: Buffer.from('%PDF-1.4 original document'), video: Buffer.from('0000ftyp original company video'), pages: [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 2, 0xff, 0xd9])] };
  const updatedAt = '2026-11-03T00:00:00.000Z';
  const companyMaterials = {
    pdf: { url: '/api/media/deck.pdf', name: '双鹿介绍.pdf', size: bytes.pdf.length, updatedAt, previewPages: ['/api/media/11111111-1111-4111-8111-111111111111.jpg', '/api/media/22222222-2222-4222-8222-222222222222.jpg'] },
    ppt: { url: '/api/media/legacy.pptx', previewUrl: '/api/media/legacy-preview.pdf' },
    video: { url: '/api/media/company.mp4', name: '公司介绍.mp4', size: bytes.video.length, updatedAt },
  };
  await writeFile(join(data, 'media', 'deck.pdf'), bytes.pdf);
  await writeFile(join(data, 'media', 'company.mp4'), bytes.video);
  await writeFile(join(data, 'media', '11111111-1111-4111-8111-111111111111.jpg'), bytes.pages[0]);
  await writeFile(join(data, 'media', '22222222-2222-4222-8222-222222222222.jpg'), bytes.pages[1]);
  let sourceScript = script;
  if (staticPages) {
    const release = join(root, 'release');
    for (const directory of ['scripts', 'lib', 'public/assets/company/pdf-preview/0123456789abcdef']) await mkdir(join(release, directory), { recursive: true });
    await copyFile(script, join(release, 'scripts', 'export-company-materials.mjs'));
    for (const name of ['company-materials.ts', 'company-materials-defaults.json']) await copyFile(resolve('lib', name), join(release, 'lib', name));
    companyMaterials.pdf.previewPages = bytes.pages.map((_, index) => '/assets/company/pdf-preview/0123456789abcdef/page-' + String(index + 1).padStart(2, '0') + '.jpg');
    for (const [index, url] of companyMaterials.pdf.previewPages.entries()) await writeFile(join(release, 'public', url), bytes.pages[index]);
    sourceScript = join(release, 'scripts', 'export-company-materials.mjs');
  }
  const database = new DatabaseSync(join(data, 'catalog.sqlite'));
  database.exec('CREATE TABLE catalog(id INTEGER PRIMARY KEY,data TEXT NOT NULL,revision INTEGER NOT NULL)');
  database.prepare('INSERT INTO catalog VALUES (1,?,7)').run(JSON.stringify({ products: [{ id: 'untouched' }], companyMaterials }));
  database.close();
  const run = () => execute(process.execPath, [sourceScript, checkout], { env: { ...process.env, DATA_DIR: data } });
  return { root, data, checkout, bytes, companyMaterials, run };
}

test('exports unmodified PDF and video with metadata and leaves SQLite and Git untouched', async () => {
  const fixtureData = await fixture();
  const { root, data, checkout, bytes, companyMaterials, run } = fixtureData;
  try {
    await writeFile(join(checkout, '.git', 'sentinel'), 'unchanged');
    const { stdout } = await run();
    const result = JSON.parse(stdout);
    assert.equal(result.files.length, 4);
    assert.ok(result.files.every(file => file.requiresGitLfs === false));
    for (const [key, name] of [['pdf', 'company-introduction.pdf'], ['video', 'company-introduction.mp4']]) {
      assert.deepEqual(await readFile(join(checkout, 'public', 'assets', 'company', name)), bytes[key]);
    }
    const manifest = JSON.parse(await readFile(join(checkout, 'lib', 'company-materials-defaults.json'), 'utf8'));
    assert.equal(manifest.pdf.url, '/assets/company/company-introduction.pdf');
    assert.equal(manifest.pdf.updatedAt, companyMaterials.pdf.updatedAt);
    const hash = createHash('sha256').update(bytes.pdf).digest('hex').slice(0, 16);
    const expectedPages = bytes.pages.map((_, index) => '/assets/company/pdf-preview/' + hash + '/page-' + String(index + 1).padStart(2, '0') + '.jpg');
    assert.deepEqual(manifest.pdf.previewPages, expectedPages);
    for (const [index, url] of expectedPages.entries()) assert.deepEqual(await readFile(join(checkout, 'public', url)), bytes.pages[index]);
    assert.equal(manifest.ppt, undefined, 'legacy PPTX metadata is not exported');
    assert.equal(manifest.pdf.previewUrl, undefined);
    assert.equal(manifest.video.size, bytes.video.length);
    assert.equal(await readFile(join(checkout, '.git', 'sentinel'), 'utf8'), 'unchanged');
    const database = new DatabaseSync(join(data, 'catalog.sqlite'), { readOnly: true });
    const row = database.prepare('SELECT data,revision FROM catalog').get();
    database.close();
    assert.equal(row.revision, 7);
    assert.equal(JSON.parse(row.data).companyMaterials.pdf.url, companyMaterials.pdf.url);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exports ordered preview pages from the installed static preview directory', async () => {
  const { root, checkout, bytes, run } = await fixture(true);
  try {
    const { stdout } = await run();
    assert.equal(JSON.parse(stdout).files.length, 4);
    const manifest = JSON.parse(await readFile(join(checkout, 'lib', 'company-materials-defaults.json'), 'utf8'));
    const hash = createHash('sha256').update(bytes.pdf).digest('hex').slice(0, 16);
    assert.equal(manifest.pdf.previewPages[0], '/assets/company/pdf-preview/' + hash + '/page-01.jpg');
    for (const [index, url] of manifest.pdf.previewPages.entries()) assert.deepEqual(await readFile(join(checkout, 'public', url)), bytes.pages[index]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects symlink sources, symlink destination directories and unrelated company URLs', async () => {
  for (const scenario of ['source', 'destination', 'preview-source', 'preview-destination', 'url', 'preview-url']) {
    const { root, data, checkout, run } = await fixture();
    try {
      const outside = join(root, 'outside');
      await writeFile(outside, 'untouched');
      if (scenario === 'source') {
        await rm(join(data, 'media', 'deck.pdf'));
        await symlink(outside, join(data, 'media', 'deck.pdf'));
      } else if (scenario === 'destination') {
        await mkdir(join(root, 'elsewhere'));
        await mkdir(join(checkout, 'public', 'assets'));
        await symlink(join(root, 'elsewhere'), join(checkout, 'public', 'assets', 'company'));
      } else if (scenario === 'preview-source') {
        await rm(join(data, 'media', '11111111-1111-4111-8111-111111111111.jpg'));
        await symlink(outside, join(data, 'media', '11111111-1111-4111-8111-111111111111.jpg'));
      } else if (scenario === 'preview-destination') {
        await mkdir(join(root, 'elsewhere'));
        await mkdir(join(checkout, 'public', 'assets', 'company'), { recursive: true });
        await symlink(join(root, 'elsewhere'), join(checkout, 'public', 'assets', 'company', 'pdf-preview'));
      } else {
        const database = new DatabaseSync(join(data, 'catalog.sqlite'));
        const row = database.prepare('SELECT data FROM catalog').get();
        const catalog = JSON.parse(row.data);
        if (scenario === 'preview-url') catalog.companyMaterials.pdf.previewPages = ['/assets/company/pdf-preview/../../outside.jpg'];
        else catalog.companyMaterials.pdf.url = '/assets/company/other.pdf';
        database.prepare('UPDATE catalog SET data=?').run(JSON.stringify(catalog));
        database.close();
      }
      await assert.rejects(run);
      assert.equal(await readFile(outside, 'utf8'), 'untouched');
      await assert.rejects(readFile(join(checkout, 'lib', 'company-materials-defaults.json')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
