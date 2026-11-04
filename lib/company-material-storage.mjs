import { constants, createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { dataDirectory, mediaBucket } from './runtime.ts';
import { COMPANY_MATERIAL_MAX_BYTES, COMPANY_PDF_MAX_PAGES, COMPANY_PDF_TYPE, validateCompanyMaterials } from './company-materials.ts';

export class CompanyMaterialError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function companyUploadName(value, kind) {
  if (kind !== 'pdf' && kind !== 'video') throw new CompanyMaterialError('介绍栏目不存在', 404);
  let name;
  try { name = decodeURIComponent(value || ''); }
  catch { throw new CompanyMaterialError('文件名编码无效'); }
  const extension = kind === 'pdf' ? '.pdf' : '.mp4';
  if (!name.trim() || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) ||
      !name.toLowerCase().endsWith(extension)) throw new CompanyMaterialError('请选择 ' + extension + ' 原文件');
  return name;
}

export function validateCompanyUploadType(type, kind) {
  const mime = type?.split(';')[0].trim().toLowerCase();
  const expected = kind === 'pdf' ? COMPANY_PDF_TYPE : 'video/mp4';
  if (mime !== expected) throw new CompanyMaterialError('文件类型无效，请选择原始 PDF 或 MP4 文件');
}

async function signature(path, kind) {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const valid = kind === 'pdf' ? bytesRead >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-' :
      bytesRead >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
    if (!valid) throw new CompanyMaterialError('文件内容与扩展名不符，请选择有效原文件');
  } finally { await file.close(); }
}


const execute = promisify(execFile);
const previewGlobal = globalThis;

async function renderPdf(source, staging) {
  if (previewGlobal.__pairdeerPdfPreviewBusy) throw new CompanyMaterialError('另一份 PDF 正在生成预览，请稍后重试', 503);
  previewGlobal.__pairdeerPdfPreviewBusy = true;
  try {
    const env = { ...process.env, HOME: staging, TMPDIR: staging, LC_ALL: 'C' };
    const info = await execute(process.env.PDFINFO_BIN || 'pdfinfo', [source], { env, timeout: 20_000, maxBuffer: 1024 * 1024 });
    const count = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
    if (!Number.isInteger(count) || count < 1 || count > COMPANY_PDF_MAX_PAGES) {
      throw new CompanyMaterialError('PDF 需要包含 1 至 200 页，请检查文件', 422);
    }
    await execute(process.env.FLOCK_BIN || 'flock', [
      '--nonblock', '--conflict-exit-code', '75', '--no-fork', join(dataDirectory(), '.company-preview.lock'),
      process.env.PDFTOPPM_BIN || 'pdftoppm', '-f', '1', '-l', String(count), '-scale-to', '1600', '-jpeg',
      '-jpegopt', 'quality=78,progressive=y,optimize=y', source, join(staging, 'page'),
    ], { env, timeout: 180_000, maxBuffer: 1024 * 1024 });
    const files = (await readdir(staging)).filter(name => /^page-\d+\.jpg$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (files.length !== count) throw new CompanyMaterialError('PDF 页面预览不完整，请重试', 422);
    for (let index = 0; index < files.length; index++) {
      if (Number(files[index].match(/\d+/)[0]) !== index + 1) throw new CompanyMaterialError('PDF 页面顺序无效', 422);
      const file = await open(join(staging, files[index]), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        const header = Buffer.alloc(3);
        const { bytesRead } = await file.read(header, 0, 3, 0);
        if (!info.isFile() || info.size > 20 * 1024 * 1024 || bytesRead !== 3 || !header.equals(Buffer.from([255, 216, 255]))) {
          throw new CompanyMaterialError('PDF 页面图片无效', 422);
        }
      } finally { await file.close(); }
    }
    return files.map(name => join(staging, name));
  } catch (error) {
    if (error instanceof CompanyMaterialError) throw error;
    if (error.code === 75) throw new CompanyMaterialError('另一份 PDF 正在生成预览，请稍后重试', 503);
    if ((error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) || error.code === 69) {
      throw new CompanyMaterialError('ECS 尚未安装 PDF 预览组件，请安装 poppler-utils 和 util-linux 后重试', 503);
    }
    throw new CompanyMaterialError('PDF 预览生成失败或超过三分钟，原栏目未变更，请检查文件后重试', 422);
  } finally { previewGlobal.__pairdeerPdfPreviewBusy = false; }
}

/** Delete only immutable objects created by the current unpublished operation. */
export async function discardCompanyPreviewPages(pages) {
  for (const url of pages || []) {
    if (!/^\/api\/media\/[a-z0-9-]+\.(jpg|pdf)$/.test(url)) continue;
    const file = join(dataDirectory(), 'media', basename(url));
    await unlink(file).catch(() => {});
    await unlink(file + '.metadata.json').catch(() => {});
  }
}

async function storePages(files, name, created) {
  const pages = [];
  for (let index = 0; index < files.length; index++) {
    const key = randomUUID() + '.jpg';
    await mediaBucket.put(key, Readable.toWeb(createReadStream(files[index])), {
      httpMetadata: { contentType: 'image/jpeg' },
      customMetadata: { name: encodeURIComponent(name.replace(/\.pdf$/i, '') + '-第' + (index + 1) + '页.jpg') },
    });
    const url = '/api/media/' + key;
    created.push(url); pages.push(url);
  }
  return pages;
}

/** Generate JPEG pages for an existing published PDF while retaining its exact original URL and bytes. */
export async function createCompanyPdfPreview(material, publicDirectory) {
  validateCompanyMaterials({ pdf: material });
  const directory = dataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, '.company-preview-'));
  const created = [];
  try {
    let source, expectedParent;
    if (/^\/api\/media\/[a-z0-9-]+\.pdf$/.test(material.url)) {
      expectedParent = join(directory, 'media');
      source = join(expectedParent, basename(material.url));
    } else if (material.url === '/assets/company/company-introduction.pdf') {
      expectedParent = join(await realpath(publicDirectory), 'assets', 'company');
      source = join(expectedParent, 'company-introduction.pdf');
    } else throw new CompanyMaterialError('已发布 PDF 地址无效');
    if ((await lstat(expectedParent)).isSymbolicLink() || await realpath(dirname(source)) !== resolve(expectedParent)) {
      throw new CompanyMaterialError('PDF 来源目录不得为符号链接');
    }
    const original = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const snapshot = join(staging, 'source.pdf');
    try {
      const info = await original.stat();
      if (!info.isFile() || info.size !== material.size) throw new CompanyMaterialError('PDF 大小与已发布资料不一致');
      await pipeline(original.createReadStream(), createWriteStream(snapshot, { flags: 'wx', mode: 0o600 }));
    } finally { await original.close().catch(() => {}); }
    await signature(snapshot, 'pdf');
    const pages = await renderPdf(snapshot, staging);
    return { ...material, previewPages: await storePages(pages, material.name, created) };
  } catch (error) {
    await discardCompanyPreviewPages(created);
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

/** Stream unmodified originals to the persistent ECS disk, then publish immutable media. */
export async function storeCompanyMaterial(kind, name, body, declaredSize) {
  name = companyUploadName(encodeURIComponent(name), kind);
  if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > COMPANY_MATERIAL_MAX_BYTES)) {
    throw new CompanyMaterialError('单个文件不能超过 250 MB', 413);
  }
  const directory = dataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, '.company-upload-'));
  let size = 0;
  const created = [];
  try {
    const extension = kind === 'pdf' ? '.pdf' : '.mp4';
    const source = join(staging, 'source' + extension);
    const limit = new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > COMPANY_MATERIAL_MAX_BYTES) done(new CompanyMaterialError('单个文件不能超过 250 MB', 413));
      else done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(body), limit,
      createWriteStream(source, { flags: 'wx', mode: 0o600 }));
    if (!size || (declaredSize !== undefined && size !== declaredSize)) throw new CompanyMaterialError('上传文件不完整，请重试');
    await signature(source, kind);
    const pages = kind === 'pdf' ? await renderPdf(source, staging) : undefined;
    const originalKey = randomUUID() + extension;
    await mediaBucket.put(originalKey, Readable.toWeb(createReadStream(source)), {
      httpMetadata: { contentType: kind === 'pdf' ? COMPANY_PDF_TYPE : 'video/mp4' },
      customMetadata: { name: encodeURIComponent(name) },
    });
    created.push('/api/media/' + originalKey);
    const material = { url: '/api/media/' + originalKey, name, size, updatedAt: new Date().toISOString() };
    if (pages) material.previewPages = await storePages(pages, name, created);
    return material;
  } catch (error) {
    await discardCompanyPreviewPages(created);
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
