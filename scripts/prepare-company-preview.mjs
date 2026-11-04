#!/usr/bin/env node
/** Prepare page images for the current ECS PDF without changing its original file. */
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCompanyPdfPreview, discardCompanyPreviewPages } from '../lib/company-material-storage.mjs';
import { resolveCompanyMaterials } from '../lib/company-materials.ts';
import { dataDirectory, getDatabase } from '../lib/runtime.ts';

let database, generated;
let published = false;
try {
  if (!process.env.DATA_DIR || process.argv.length !== 2) throw new Error('Usage: DATA_DIR=/var/lib/pairdeer node scripts/prepare-company-preview.mjs');
  const info = await lstat(join(dataDirectory(), 'catalog.sqlite'));
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('ECS 资料库文件无效');
  database = await getDatabase();
  const original = await database.prepare('SELECT data,revision FROM catalog WHERE id=1').first();
  if (!original) throw new Error('ECS 资料库尚未发布内容');
  const material = resolveCompanyMaterials(JSON.parse(original.data).companyMaterials).pdf;
  if (!material) throw new Error('尚未发布 PDF');
  if (material.previewPages?.length) {
    console.log(JSON.stringify({ ok: true, changed: false, pages: material.previewPages.length }));
  } else {
    const publicDirectory = await realpath(fileURLToPath(new URL('../public', import.meta.url)));
    generated = await createCompanyPdfPreview(material, publicDirectory);
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await database.prepare('SELECT data,revision FROM catalog WHERE id=1').first();
      if (!row) throw new Error('ECS 资料库读取失败');
      const data = JSON.parse(row.data);
      const current = resolveCompanyMaterials(data.companyMaterials);
      if (current.pdf?.url !== material.url || current.pdf?.size !== material.size) {
        throw new Error('PDF 已由管理员替换，未修改资料库，请重新运行');
      }
      if (current.pdf.previewPages?.length) {
        console.log(JSON.stringify({ ok: true, changed: false, pages: current.pdf.previewPages.length }));
        break;
      }
      data.companyMaterials = { ...current, pdf: { ...current.pdf, previewPages: generated.previewPages } };
      const result = await database.prepare('UPDATE catalog SET data=?,revision=revision+1 WHERE id=1 AND revision=?')
        .bind(JSON.stringify(data), row.revision).run();
      if (result.meta.changes) {
        published = true;
        console.log(JSON.stringify({ ok: true, changed: true, pages: generated.previewPages.length, revision: row.revision + 1 }));
        break;
      }
      if (attempt === 4) throw new Error('资料正在被其他管理员修改，请重新运行');
    }
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
} finally {
  if (generated && !published) await discardCompanyPreviewPages(generated.previewPages);
  database?.close();
}
