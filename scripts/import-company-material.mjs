#!/usr/bin/env node
/** Local ECS import: no network or administrator password is needed. */
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { companyUploadName, storeCompanyMaterial } from '../lib/company-material-storage.mjs';
import { dataDirectory, getDatabase } from '../lib/runtime.ts';
import seed from '../lib/seed.json' with { type: 'json' };

const [kind, input, requestedName] = process.argv.slice(2);
if ((kind !== 'ppt' && kind !== 'video') || !input) {
  console.error('Usage: DATA_DIR=/var/lib/pairdeer node scripts/import-company-material.mjs ppt|video /path/to/file [display-name.pptx|.mp4]');
  process.exitCode = 1;
} else {
  try {
    if (!process.env.DATA_DIR) throw new Error('请显式设置 DATA_DIR，避免导入错误资料库');
    const file = await realpath(input);
    const info = await stat(file);
    if (!info.isFile()) throw new Error('请选择普通文件');
    const name = companyUploadName(encodeURIComponent(requestedName || basename(file)), kind);
    const material = await storeCompanyMaterial(kind, name, Readable.toWeb(createReadStream(file)), info.size);
    const database = await getDatabase();
    await database.prepare('INSERT OR IGNORE INTO catalog (id,data,revision) VALUES (1,?,1)').bind(JSON.stringify(seed)).run();
    let published = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await database.prepare('SELECT data,revision FROM catalog WHERE id=1').first();
      if (!row) throw new Error('资料库读取失败');
      const data = JSON.parse(row.data);
      data.companyMaterials = { ...data.companyMaterials, [kind]: material };
      const result = await database.prepare('UPDATE catalog SET data=?,revision=revision+1 WHERE id=1 AND revision=?')
        .bind(JSON.stringify(data), row.revision).run();
      if (result.meta.changes) { published = true; break; }
    }
    if (!published) throw new Error('资料库正在被其他管理员修改，请重新导入');
    console.log(JSON.stringify({ ok: true, directory: dataDirectory(), kind, material }, null, 2));
    database.close();
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}
