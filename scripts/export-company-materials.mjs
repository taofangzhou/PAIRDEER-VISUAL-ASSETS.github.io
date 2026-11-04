#!/usr/bin/env node
/** Export published ECS company assets into an explicit Git checkout; never invokes Git. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolveCompanyMaterials, validateCompanyMaterials } from '../lib/company-materials.ts';

const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const paths = {
  pdf: '/assets/company/company-introduction.pdf',
  video: '/assets/company/company-introduction.mp4',
};

async function checkedDirectory(path, create = false) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o755 });
      info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('目录不得为符号链接或特殊文件：' + current);
  }
  return absolute;
}

async function checkedFile(path, allowMissing = false) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('文件不得为符号链接或特殊文件：' + path);
    return info;
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function exportMaterials(checkoutArgument) {
  if (!process.env.DATA_DIR || !checkoutArgument || !isAbsolute(checkoutArgument)) {
    throw new Error('Usage: DATA_DIR=/var/lib/pairdeer node scripts/export-company-materials.mjs /absolute/path/to/git-checkout');
  }
  const checkout = await checkedDirectory(checkoutArgument);
  // Confirm an explicit checkout without reading Git configuration or credentials.
  const gitMarker = await lstat(join(checkout, '.git'));
  if (gitMarker.isSymbolicLink() || (!gitMarker.isFile() && !gitMarker.isDirectory())) throw new Error('目标不是普通 Git 工作目录');
  await checkedDirectory(join(checkout, 'public'));
  await checkedDirectory(join(checkout, 'lib'));
  const data = await checkedDirectory(process.env.DATA_DIR);
  await checkedFile(join(data, 'catalog.sqlite'));
  const database = new DatabaseSync(join(data, 'catalog.sqlite'), { readOnly: true });
  let materials;
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const row = database.prepare('SELECT data FROM catalog WHERE id=1').get();
    if (!row) throw new Error('ECS 资料库尚未发布内容');
    const catalog = JSON.parse(row.data);
    validateCompanyMaterials(catalog.companyMaterials);
    materials = resolveCompanyMaterials(catalog.companyMaterials);
    validateCompanyMaterials(materials);
  } finally { database.close(); }

  // Resolve the installed release pointer once. Individual source files are never followed through symlinks.
  const sourceRoot = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const sources = [];
  const manifest = {};
  const staged = [];
  try {
    const addSource = async (url, destination, expectedSize) => {
      let source;
      if (/^\/api\/media\/[a-z0-9-]+\.(pdf|mp4|jpg)$/.test(url)) {
        await checkedDirectory(join(data, 'media'));
        source = join(data, 'media', basename(url));
      } else if (Object.values(paths).includes(url) ||
        /^\/assets\/company\/pdf-preview\/[a-f0-9]{16,64}\/page-\d+\.jpg$/.test(url)) {
        source = join(sourceRoot, 'public', url);
        await checkedDirectory(dirname(source));
      } else throw new Error('资料地址不是允许的 ECS 公司素材路径');
      await checkedFile(source);
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || (expectedSize !== undefined && info.size !== expectedSize)) {
        await handle.close();
        throw new Error('素材大小与已发布资料不一致：' + source);
      }
      const entry = { handle, size: info.size, target: join(checkout, 'public', destination) };
      sources.push(entry);
      return entry;
    };
    for (const kind of ['pdf', 'video']) {
      const material = materials[kind];
      if (!material) continue;
      manifest[kind] = { ...material, url: paths[kind] };
      const original = await addSource(material.url, paths[kind], material.size);
      if (kind === 'pdf' && material.previewPages?.length) {
        const hash = createHash('sha256');
        for await (const chunk of original.handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
        const prefix = '/assets/company/pdf-preview/' + hash.digest('hex').slice(0, 16);
        manifest.pdf.previewPages = [];
        for (const [index, url] of material.previewPages.entries()) {
          const destination = prefix + '/page-' + String(index + 1).padStart(2, '0') + '.jpg';
          await addSource(url, destination);
          manifest.pdf.previewPages.push(destination);
        }
      }
    }
    if (!sources.length) throw new Error('没有可导出的已发布公司素材');
    validateCompanyMaterials(manifest);
    const companyDirectory = await checkedDirectory(join(checkout, 'public', 'assets', 'company'), true);
    const manifestTarget = join(checkout, 'lib', 'company-materials-defaults.json');
    await checkedFile(manifestTarget, true);
    for (const source of sources) {
      await checkedDirectory(dirname(source.target), true);
      await checkedFile(source.target, true);
    }
    for (const source of sources) {
      const temporary = join(companyDirectory, '.' + randomUUID() + '.tmp');
      staged.push(temporary);
      const destination = await open(temporary, 'wx', 0o644);
      try { await pipeline(source.handle.createReadStream({ start: 0 }), destination.createWriteStream()); }
      finally { await destination.close().catch(() => {}); }
      source.temporary = temporary;
    }
    const manifestTemporary = join(dirname(manifestTarget), '.' + randomUUID() + '.tmp');
    staged.push(manifestTemporary);
    await writeFile(manifestTemporary, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    for (const source of sources) {
      await checkedFile(source.target, true);
      await rename(source.temporary, source.target);
    }
    await checkedFile(manifestTarget, true);
    await rename(manifestTemporary, manifestTarget);
    console.log(JSON.stringify({
      ok: true, checkout, manifest: manifestTarget,
      files: sources.map(source => ({ path: source.target, size: source.size, requiresGitLfs: source.size > GITHUB_FILE_LIMIT })),
      next: '仅完成本地导出。请在此 Git 工作目录检查变更，再自行执行 git add、git commit 和 git push。',
    }, null, 2));
  } finally {
    await Promise.all(sources.map(source => source.handle.close().catch(() => {})));
    await Promise.all(staged.map(path => rm(path, { force: true }).catch(() => {})));
  }
}

try {
  if (process.argv.length !== 3) throw new Error('请仅提供一个目标 Git 工作目录');
  await exportMaterials(process.argv[2]);
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
