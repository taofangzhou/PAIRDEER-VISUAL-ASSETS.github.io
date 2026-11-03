// Run: node --experimental-vm-modules tests/product-zip.test.mjs
// Exercise the real route, download mapping and ZIP writer; consume complete streams.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, copyFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const project = fileURLToPath(new URL('../', import.meta.url));
const mapping = JSON.parse(await readFile(path.join(project, 'lib/download-map.json'), 'utf8'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function unzipStored(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50, 'complete ZIP end record');
  const count = bytes.readUInt16LE(end + 10);
  const start = bytes.readUInt32LE(end + 16);
  assert.equal(start + bytes.readUInt32LE(end + 12), end, 'complete central directory');
  const files = new Map();
  let offset = start;
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    assert.equal(bytes.readUInt16LE(offset + 10), 0, 'stored ZIP entry');
    assert.equal(bytes.readUInt16LE(offset + 8) & 0x800, 0x800, 'UTF-8 filename flag');
    const size = bytes.readUInt32LE(offset + 24);
    assert.equal(bytes.readUInt32LE(offset + 20), size);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const localNameLength = bytes.readUInt16LE(local + 26);
    assert.equal(bytes.subarray(local + 30, local + 30 + localNameLength).toString('utf8'), name);
    const dataStart = local + 30 + localNameLength + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(dataStart, dataStart + size);
    assert.equal(crc32(data), bytes.readUInt32LE(offset + 16), 'CRC matches full image bytes');
    assert.equal(bytes.readUInt32LE(dataStart + size), 0x08074b50, 'complete data descriptor');
    assert.equal(bytes.readUInt32LE(dataStart + size + 4), crc32(data));
    assert.equal(bytes.readUInt32LE(dataStart + size + 8), size);
    files.set(name, data);
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  assert.equal(offset, end);
  return files;
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pairdeer-zip-'));
  const previousCwd = process.cwd();
  await mkdir(path.join(root, 'public/assets'), { recursive: true });
  await mkdir(path.join(root, 'public/downloads'), { recursive: true });
  const catalog = { products: [] };
  const context = vm.createContext({ ReadableStream, TextEncoder, Uint8Array, Request, Response, URL, Error, process, fetch, AbortSignal });
  const modules = new Map();
  function synthetic(id, values) {
    const result = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context, identifier: id });
    modules.set(id, result); return result;
  }
  synthetic(path.join(project, 'app/api/catalog/route.ts'), { GET: async () => Response.json({ data: catalog }) });
  synthetic(path.join(project, 'lib/server.ts'), {
    bindings: { BUCKET: { get: async key => key === 'uploaded.png' ? { body: new Response(png).body } : null } },
    fail: (error, status) => Response.json({ error: error.message }, { status }),
  });
  async function load(id) {
    if (modules.has(id)) return modules.get(id);
    if (id.startsWith('node:')) return synthetic(id, await import(id));
    if (id.endsWith('.json')) return synthetic(id, { default: JSON.parse(await readFile(id, 'utf8')) });
    const source = ts.transpileModule(await readFile(id, 'utf8'), { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    } }).outputText;
    const module = new vm.SourceTextModule(source, { context, identifier: id });
    modules.set(id, module);
    await module.link((specifier, ref) => {
      let target = specifier.startsWith('@/') ? path.join(project, specifier.slice(2)) :
        specifier.startsWith('.') ? path.resolve(path.dirname(ref.identifier), specifier) : specifier;
      if (target.startsWith('/') && !path.extname(target)) target += '.ts';
      return load(target);
    });
    return module;
  }
  const route = await load(path.join(project, 'app/api/product-zip/[id]/route.ts'));
  await route.evaluate();
  process.chdir(root);
  t.after(async () => { process.chdir(previousCwd); await rm(root, { recursive: true, force: true }); });
  const getZip = async (mainImages, detailImages = [], id = 'test') => {
    catalog.products = [{ id, name: '双鹿测试', mainImages, detailImages }];
    const response = await route.namespace.GET(new Request('https://test.invalid/api/product-zip/' + id), { params: Promise.resolve({ id }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    return Buffer.from(await response.arrayBuffer());
  };
  return { root, getZip };
}

test('all p1 mapped JPG originals produce a complete readable ZIP with correct bytes', async t => {
  const f = await fixture(t);
  const main = Object.keys(mapping).filter(url => url.startsWith('/assets/products/p1/main/')).sort();
  const detail = Object.keys(mapping).filter(url => url.startsWith('/assets/products/p1/detail/')).sort();
  assert.equal(main.length, 9);
  assert.equal(detail.length, 6);
  const expected = new Map();
  for (const [folder, urls] of [['主图', main], ['详情页', detail]]) {
    for (const [index, url] of urls.entries()) {
      const destination = path.join(f.root, 'public', mapping[url]);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(project, 'public', mapping[url]), destination);
      expected.set(`${folder}/${String(index + 1).padStart(2, '0')}.jpg`, await readFile(destination));
    }
  }
  const files = unzipStored(await f.getZip(main, detail, 'p1'));
  assert.deepEqual([...files.keys()], [...expected.keys()]);
  for (const [name, bytes] of expected) assert.deepEqual(files.get(name), bytes);
});

test('unmapped assets, bundled downloads and uploaded media retain ZIP contents', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'public/assets/plain.png'), png);
  await writeFile(path.join(f.root, 'public/downloads/plain.jpg'), png);
  const files = unzipStored(await f.getZip(['/assets/plain.png', '/downloads/plain.jpg', '/api/media/uploaded.png']));
  assert.deepEqual([...files.keys()], ['主图/01.png', '主图/02.jpg', '主图/03.png']);
  for (const bytes of files.values()) assert.deepEqual(bytes, png);
});

test('assets and downloads cannot escape their own realpath roots', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'public/assets/private.png'), png);
  await writeFile(path.join(f.root, 'public/downloads/private.png'), png);
  await writeFile(path.join(f.root, 'private.png'), png);
  for (const url of ['/assets/../downloads/private.png', '/downloads/../assets/private.png',
    '/assets/%2e%2e/downloads/private.png', '/downloads/%2e%2e/assets/private.png',
    '/assets/../../private.png', '/downloads/../../private.png']) {
    await assert.rejects(f.getZip([url]), /图片地址无效/, url);
  }
});

test('symlinked files cannot cross assets/downloads boundaries or read outside public', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'private.png');
  await writeFile(outside, png);
  for (const directory of ['assets', 'downloads']) {
    await writeFile(path.join(f.root, 'public', directory, 'private.png'), png);
    await symlink(outside, path.join(f.root, 'public', directory, 'outside.png'));
  }
  await symlink(path.join(f.root, 'public/downloads/private.png'), path.join(f.root, 'public/assets/sibling.png'));
  await symlink(path.join(f.root, 'public/assets/private.png'), path.join(f.root, 'public/downloads/sibling.png'));
  for (const url of ['/assets/outside.png', '/downloads/outside.png', '/assets/sibling.png', '/downloads/sibling.png']) {
    await assert.rejects(f.getZip([url]), /图片地址无效/, url);
  }
});
