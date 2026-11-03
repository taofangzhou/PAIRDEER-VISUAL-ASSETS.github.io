import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { dataDirectory, mediaBucket } from './runtime.ts';
import {
  COMPANY_MATERIAL_MAX_BYTES, COMPANY_PPTX_TYPE,
} from './company-materials.ts';

const execute = promisify(execFile);
const conversionGlobal = globalThis;

export class CompanyMaterialError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function companyUploadName(value, kind) {
  let name;
  try { name = decodeURIComponent(value || ''); }
  catch { throw new CompanyMaterialError('文件名编码无效'); }
  const extension = kind === 'ppt' ? '.pptx' : '.mp4';
  if (!name.trim() || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) ||
      !name.toLowerCase().endsWith(extension)) throw new CompanyMaterialError('请选择 ' + extension + ' 原文件');
  return name;
}

export function validateCompanyUploadType(type, kind) {
  const mime = type?.split(';')[0].trim().toLowerCase();
  const expected = kind === 'ppt' ? COMPANY_PPTX_TYPE : 'video/mp4';
  // Some browsers report PPTX as ZIP or an empty binary type.
  if (mime && mime !== expected && mime !== 'application/octet-stream' &&
      !(kind === 'ppt' && mime === 'application/zip')) {
    throw new CompanyMaterialError('文件类型无效，请选择原始 PPTX 或 MP4 文件');
  }
}

async function signature(path, kind) {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(12);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const valid = kind === 'ppt' ? bytesRead >= 4 && bytes.readUInt32LE(0) === 0x04034b50 :
      kind === 'video' ? bytesRead >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' :
        bytesRead >= 5 && bytes.toString('ascii', 0, 5) === '%PDF-';
    if (!valid) throw new CompanyMaterialError('文件内容与扩展名不符，请选择有效原文件');
  } finally { await file.close(); }
}

async function convertPpt(source, directory) {
  if (conversionGlobal.__pairdeerCompanyConverting) throw new CompanyMaterialError('另一份 PPT 正在生成预览，请稍后重试', 503);
  conversionGlobal.__pairdeerCompanyConverting = true;
  try {
    const profile = pathToFileURL(join(directory, 'office-profile')).href;
    await execute(process.env.LIBREOFFICE_BIN || 'libreoffice', [
      '-env:UserInstallation=' + profile, '--headless', '--nologo', '--nodefault',
      '--norestore', '--convert-to', 'pdf:impress_pdf_Export', '--outdir', directory, source,
    ], { timeout: 120_000, maxBuffer: 1024 * 1024, env: { ...process.env, HOME: directory, TMPDIR: directory, XDG_CACHE_HOME: join(directory, 'cache'), XDG_CONFIG_HOME: join(directory, 'config') } });
    const pdf = join(directory, 'source.pdf');
    const info = await stat(pdf);
    if (info.size <= 0 || info.size > COMPANY_MATERIAL_MAX_BYTES) throw new CompanyMaterialError('生成的预览文件过大，请压缩 PPT 后重试');
    await signature(pdf, 'pdf');
    return pdf;
  } catch (error) {
    if (error instanceof CompanyMaterialError) throw error;
    if (error.code === 'ENOENT' && error.syscall?.startsWith('spawn')) {
      throw new CompanyMaterialError('ECS 尚未安装 LibreOffice，无法生成 PPT 预览，请按部署说明安装后重试', 503);
    }
    throw new CompanyMaterialError('PPT 预览生成失败或超过两分钟；原栏目未变更，请检查文件后重试', 422);
  } finally { conversionGlobal.__pairdeerCompanyConverting = false; }
}

/** Stream originals to the persistent ECS disk, then publish immutable media. */
export async function storeCompanyMaterial(
  kind, name, body, declaredSize,
) {
  name = companyUploadName(encodeURIComponent(name), kind);
  if (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > COMPANY_MATERIAL_MAX_BYTES)) {
    throw new CompanyMaterialError('单个文件不能超过 250 MB', 413);
  }
  const directory = dataDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, '.company-upload-'));
  let size = 0;
  try {
    const source = join(staging, kind === 'ppt' ? 'source.pptx' : 'source.mp4');
    const limit = new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > COMPANY_MATERIAL_MAX_BYTES) done(new CompanyMaterialError('单个文件不能超过 250 MB', 413));
      else done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(body), limit,
      createWriteStream(source, { flags: 'wx', mode: 0o600 }));
    if (!size || (declaredSize !== undefined && size !== declaredSize)) throw new CompanyMaterialError('上传文件不完整，请重试');
    await signature(source, kind);
    // Conversion finishes before any current catalog reference can be changed.
    const pdf = kind === 'ppt' ? await convertPpt(source, staging) : undefined;
    const originalKey = randomUUID() + (kind === 'ppt' ? '.pptx' : '.mp4');
    const asWeb = path => Readable.toWeb(createReadStream(path));
    await mediaBucket.put(originalKey, asWeb(source), {
      httpMetadata: { contentType: kind === 'ppt' ? COMPANY_PPTX_TYPE : 'video/mp4' },
      customMetadata: { name: encodeURIComponent(name) },
    });
    const material = { url: '/api/media/' + originalKey, name, size, updatedAt: new Date().toISOString() };
    if (pdf) {
      const previewKey = randomUUID() + '.pdf';
      await mediaBucket.put(previewKey, asWeb(pdf), {
        httpMetadata: { contentType: 'application/pdf' },
        customMetadata: { name: encodeURIComponent(name.replace(/\.pptx$/i, '-预览.pdf')) },
      });
      material.previewUrl = '/api/media/' + previewKey;
    }
    return material;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
