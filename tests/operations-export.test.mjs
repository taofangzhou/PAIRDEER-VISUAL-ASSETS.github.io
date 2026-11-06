import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const context = vm.createContext({ TextEncoder, Uint8Array, DataView, ReadableStream, Response, Error });
const modules = new Map();
async function load(id) {
  if (modules.has(id)) return modules.get(id);
  const source = ts.transpileModule(await readFile(id, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const module = new vm.SourceTextModule(source, { context, identifier: id }); modules.set(id,module);
  await module.link((specifier, ref) => {
    let target = specifier.startsWith('@/') ? path.resolve(specifier.slice(2)) : path.resolve(path.dirname(ref.identifier),specifier);
    if (!path.extname(target)) target += '.ts';
    return load(target);
  });
  return module;
}
const module = await load(path.resolve('lib/operations-export.ts')); await module.evaluate();
const { createOperationsExport, operationsCsvCell } = module.namespace;
const downloads = { pdf: 1, video: 2, image: 3, detail: 4, zip: 5, total: 15 };
const adminMaterials = { added: 6, replaced: 7 };
const snapshot = {
  collectedSince: '2026-11-06', timeZone: 'Asia/Shanghai',
  totals: { visitors: 8, pageViews: 99, searches: 42, downloads, adminMaterials },
  currentMonth: { month: '2026-11', pageViews: 99 }, range: { from: '2026-11-01', to: '2026-11-06' },
  hotModels: [{ model: 'LR6 / 5号', count: 23 }],
  daily: [{ day:'2026-11-06', newVisitors:8, pageViews:99, searches:42, downloads, adminMaterials }],
  monthly: [{ month:'2026-11', newVisitors:8, pageViews:99, searches:42, downloads, adminMaterials }],
  visitorId: 'DO-NOT-EXPORT-BROWSER-ID', rawQuery: 'DO-NOT-EXPORT-RAW-QUERY',
};
function crc32(bytes) {
  let crc=0xffffffff;
  for (const value of bytes) { crc ^= value; for (let index=0;index<8;index++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function unzip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end),0x06054b50,'complete ZIP end record');
  const count=bytes.readUInt16LE(end+10), start=bytes.readUInt32LE(end+16);
  assert.equal(start+bytes.readUInt32LE(end+12),end);
  const files=new Map(); let offset=start;
  for (let index=0;index<count;index++) {
    assert.equal(bytes.readUInt32LE(offset),0x02014b50);
    const size=bytes.readUInt32LE(offset+24), nameLength=bytes.readUInt16LE(offset+28), local=bytes.readUInt32LE(offset+42);
    const name=bytes.subarray(offset+46,offset+46+nameLength).toString('utf8');
    assert.equal(bytes.readUInt32LE(local),0x04034b50);
    const dataStart=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    const body=bytes.subarray(dataStart,dataStart+size);
    assert.equal(crc32(body),bytes.readUInt32LE(offset+16),'ZIP CRC covers full OOXML entry');
    files.set(name,body.toString('utf8'));
    offset+=46+nameLength+bytes.readUInt16LE(offset+30)+bytes.readUInt16LE(offset+32);
  }
  assert.equal(offset,end); return files;
}

test('CSV has UTF-8 BOM, aggregate labels and all download/admin units, excludes extra personal fields', () => {
  const result=createOperationsExport(snapshot,'csv');
  assert.equal(result.contentType,'text/csv; charset=utf-8');
  assert.equal(result.filename,'pairdeer-operations-2026-11-01-2026-11-06.csv');
  assert.equal(result.body.charCodeAt(0),0xfeff);
  assert.match(result.body,/累计访客/); assert.match(result.body,/新增访客/);
  assert.match(result.body,/详情图下载/); assert.match(result.body,/压缩包下载/);
  assert.match(result.body,/管理员新增素材/); assert.match(result.body,/管理员替换素材/);
  assert.match(result.body,/"2026-11-06","8","99","42","1","2","3","4","5","15","6","7"/);
  assert.doesNotMatch(result.body,/DO-NOT-EXPORT/);
});

test('CSV prevents formulas even after whitespace and quotes commas/newlines safely', () => {
  for (const value of ['=1+1','+SUM(A1:A2)','-1','@SUM(A1)','  =HYPERLINK("evil")','\t=1','\r=1','\n=1']) {
    assert.equal(operationsCsvCell(value).slice(0,2),'"\'',value);
  }
  assert.equal(operationsCsvCell('plain,"text"\nline'),'"plain,""text""\nline"');
  assert.equal(operationsCsvCell(12),'"12"');
  const malicious=structuredClone(snapshot); malicious.hotModels[0].model='=HYPERLINK("bad")';
  assert.match(createOperationsExport(malicious,'csv').body,/"'=HYPERLINK\(""bad""\)"/);
});

test('XLSX is a complete 4-sheet OOXML workbook with numeric cells, literal strings and no formulas', async () => {
  const input=structuredClone(snapshot); input.hotModels[0].model='=1+1 <tag> & value\u0001';
  const result=createOperationsExport(input,'xlsx');
  assert.equal(result.contentType,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const files=unzip(Buffer.from(await new Response(result.body).arrayBuffer()));
  assert.equal(files.size,8);
  assert.match(files.get('[Content_Types].xml'),/spreadsheetml.sheet.main\+xml/);
  assert.match(files.get('_rels/.rels'),/Target="xl\/workbook.xml"/);
  const workbook=files.get('xl/workbook.xml');
  for (const name of ['统计概览','每日统计','热门型号','自然月统计']) assert.ok(workbook.includes(name));
  const daily=files.get('xl/worksheets/sheet2.xml');
  assert.match(daily,/<c r="B2"><v>8<\/v><\/c>/);
  assert.match(daily,/<c r="C2"><v>99<\/v><\/c>/);
  const hot=files.get('xl/worksheets/sheet3.xml');
  assert.match(hot,/t="inlineStr"/); assert.match(hot,/=1\+1 &lt;tag&gt; &amp; value/);
  for (const value of files.values()) {
    assert.doesNotMatch(value,/<f(?:\s|>)/);
    assert.doesNotMatch(value,/DO-NOT-EXPORT|\u0001/);
  }
});
