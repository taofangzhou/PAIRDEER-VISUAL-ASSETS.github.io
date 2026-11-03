import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { dataDirectory, mediaBucket } from './runtime.ts';
import { COMPANY_MATERIAL_MAX_BYTES, COMPANY_PDF_TYPE } from './company-materials.ts';

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
    const originalKey = randomUUID() + extension;
    await mediaBucket.put(originalKey, Readable.toWeb(createReadStream(source)), {
      httpMetadata: { contentType: kind === 'pdf' ? COMPANY_PDF_TYPE : 'video/mp4' },
      customMetadata: { name: encodeURIComponent(name) },
    });
    return { url: '/api/media/' + originalKey, name, size, updatedAt: new Date().toISOString() };
  } finally { await rm(staging, { recursive: true, force: true }); }
}
