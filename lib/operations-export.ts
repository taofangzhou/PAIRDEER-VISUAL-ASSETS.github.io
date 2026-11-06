import { zipStream, type ZipEntry } from '@/lib/zip-stream';

type DownloadCounts = { pdf: number; video: number; image: number; detail: number; zip: number; total: number };
type AdminMaterialCounts = { added: number; replaced: number };
type AggregateValues = {
  newVisitors?: number;
  pageViews: number;
  searches?: number;
  downloads?: DownloadCounts;
  adminMaterials?: AdminMaterialCounts;
};
/** Aggregate fields only: no raw events, browser identifiers, queries, or paths. */
export type OperationsExportSnapshot = {
  collectedSince: string | null;
  timeZone: string;
  totals: { visitors: number; pageViews: number; searches: number; downloads: DownloadCounts; adminMaterials: AdminMaterialCounts };
  currentMonth: { month: string; pageViews: number };
  range: { from: string; to: string };
  hotModels: Array<{ model: string; count: number }>;
  daily: Array<AggregateValues & { day: string }>;
  monthly: Array<AggregateValues & { month: string }>;
};
type Cell = string | number;
type Sheet = { name: string; rows: Cell[][] };

const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
const headers = ['日期', '新增访客', '浏览量 PV', '搜索次数', 'PDF 下载', '视频下载', '图片下载', '详情图下载', '压缩包下载', '下载总次数', '管理员新增素材', '管理员替换素材'];
function values(value: AggregateValues): number[] {
  return [value.newVisitors, value.pageViews, value.searches, value.downloads?.pdf, value.downloads?.video,
    value.downloads?.image, value.downloads?.detail, value.downloads?.zip, value.downloads?.total,
    value.adminMaterials?.added, value.adminMaterials?.replaced].map(count);
}
function sheets(snapshot: OperationsExportSnapshot): Sheet[] {
  const totals = snapshot.totals;
  return [{ name: '统计概览', rows: [
    ['指标', '数值', '说明'],
    ['数据时区', snapshot.timeZone, '按中国时间自然日汇总'],
    ['开始采集日期', snapshot.collectedSince || '尚无数据', '仅包含启用统计后采集的数据'],
    ['导出开始日期', snapshot.range.from, '日期范围筛选每日统计、热门型号和月报月份'],
    ['导出结束日期', snapshot.range.to, '累计指标始终为全部已采集数据'],
    ['累计访客', count(totals.visitors), '匿名浏览器首次识别累计数；清除 Cookie 或更换浏览器可能重新计数'],
    ['累计浏览量 PV', count(totals.pageViews), '不含已登录管理员访问'],
    ['累计搜索次数', count(totals.searches), '仅保留次数和规范型号汇总，不保留原始搜索词'],
    ['累计 PDF 下载', count(totals.downloads.pdf), ''],
    ['累计视频下载', count(totals.downloads.video), ''],
    ['累计图片下载', count(totals.downloads.image), ''],
    ['累计详情图下载', count(totals.downloads.detail), ''],
    ['累计压缩包下载', count(totals.downloads.zip), ''],
    ['累计下载总次数', count(totals.downloads.total), ''],
    ['管理员累计新增素材', count(totals.adminMaterials.added), '仅统计成功发布的素材单位'],
    ['管理员累计替换素材', count(totals.adminMaterials.replaced), '仅统计成功发布的素材单位'],
    ['本月浏览量 PV', count(snapshot.currentMonth.pageViews), snapshot.currentMonth.month],
    ['月报口径', '完整自然月', '日期范围用于选择月份，每月数值为该自然月完整合计'],
  ] }, {
    name: '每日统计', rows: [headers, ...snapshot.daily.map(value => [value.day, ...values(value)])],
  }, {
    name: '热门型号', rows: [['规范型号', '搜索次数'], ...snapshot.hotModels.map(value => [value.model, count(value.count)])],
  }, {
    name: '自然月统计', rows: [['月份', ...headers.slice(1)], ...snapshot.monthly.map(value => [value.month, ...values(value)])],
  }];
}

/** Quoting prevents delimiter injection; the apostrophe also prevents spreadsheet formulas. */
export function operationsCsvCell(value: Cell): string {
  let text = String(value);
  if (typeof value === 'string' && (/^[\s\u0000-\u0020]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text))) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function column(index: number): string {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}
function worksheet(rows: Cell[][]): string {
  const data = rows.map((row, index) => '<row r="' + (index + 1) + '">' + row.map((value, offset) => {
    const reference = column(offset) + (index + 1);
    return typeof value === 'number' ? '<c r="' + reference + '"><v>' + count(value) + '</v></c>' :
      '<c r="' + reference + '" t="inlineStr"><is><t xml:space="preserve">' + xml(value) + '</t></is></c>';
  }).join('') + '</row>').join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>' + data + '</sheetData></worksheet>';
}
function workbookEntries(items: Sheet[]): ZipEntry[] {
  const declarations = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files: Array<[string, string]> = [
    ['[Content_Types].xml', declarations + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + items.map((_, index) => '<Override PartName="/xl/worksheets/sheet' + (index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('') + '</Types>'],
    ['_rels/.rels', declarations + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', declarations + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>' + items.map((item, index) => '<sheet name="' + xml(item.name) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>').join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', declarations + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + items.map((_, index) => '<Relationship Id="rId' + (index + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>').join('') + '</Relationships>'],
    ...items.map((item, index): [string, string] => ['xl/worksheets/sheet' + (index + 1) + '.xml', worksheet(item.rows)]),
  ];
  return files.map(([name, content]) => ({ name, open: async () => new Response(content).body! }));
}

export function createOperationsExport(snapshot: OperationsExportSnapshot, format: 'csv' | 'xlsx'): {
  body: string | ReadableStream<Uint8Array>; contentType: string; filename: string;
} {
  const items = sheets(snapshot);
  const basename = 'pairdeer-operations-' + snapshot.range.from + '-' + snapshot.range.to;
  if (format === 'csv') return {
    body: '\ufeff' + items.map(item => [operationsCsvCell(item.name), ...item.rows.map(row => row.map(operationsCsvCell).join(','))].join('\r\n')).join('\r\n\r\n') + '\r\n',
    contentType: 'text/csv; charset=utf-8', filename: basename + '.csv',
  };
  return { body: zipStream(workbookEntries(items)), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: basename + '.xlsx' };
}
