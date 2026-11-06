import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataDirectory, getDatabase } from './runtime';
import { secureCookies, validAccess } from './admin-access';
import { resolveCompanyMaterials } from './company-materials';
import seed from './seed.json';

export type DownloadKind = 'pdf' | 'video' | 'image' | 'detail' | 'zip';
export type PublicAnalyticsEvent = { id: string; type: 'pageview' | 'search'; page: 'home' | 'product' | 'company_pdf' | 'company_video'; query?: string; source?: 'text' | 'image' };
export type DownloadCounts = Record<DownloadKind, number> & { total: number };
export type OperationsCounts = { newVisitors: number; pageViews: number; searches: number; downloads: DownloadCounts; adminMaterials: { added: number; replaced: number } };
export type OperationsSnapshot = {
  collectedSince: string | null; timeZone: 'Asia/Shanghai';
  totals: Omit<OperationsCounts, 'newVisitors'> & { visitors: number };
  currentMonth: { month: string; pageViews: number }; range: { from: string; to: string };
  hotModels: { model: string; count: number }[];
  daily: (OperationsCounts & { day: string })[]; monthly: (OperationsCounts & { month: string })[];
};
export class OperationsError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export const OPERATIONS_EVENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DAY_MS = 86_400_000;
const COOKIE_SECONDS = 365 * 86400;
const metrics = ['new_visitors','page_views','searches','download_pdf','download_video','download_image','download_detail','download_zip','admin_added','admin_replaced'] as const;
type Metric = typeof metrics[number];
type OperationsDatabase = { connection: DatabaseSync; key: string };
const globals = globalThis as typeof globalThis & { __pairdeerOperations?: Map<string, Promise<OperationsDatabase>> };

/** Imports/builds do not touch disk; operational state lives only on the ECS data volume. */
export function getOperationsDatabase(): Promise<OperationsDatabase> {
  const directory = dataDirectory();
  const databases = globals.__pairdeerOperations ??= new Map();
  let pending = databases.get(directory);
  if (!pending) {
    pending = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const connection = new DatabaseSync(join(directory, 'operations.sqlite'));
      connection.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS visitors (hash TEXT PRIMARY KEY,first_day TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, ${metrics.map(name => name + ' INTEGER NOT NULL DEFAULT 0').join(',')});
        CREATE TABLE IF NOT EXISTS hot_models (day TEXT NOT NULL,model TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,model));
        CREATE TABLE IF NOT EXISTS event_dedup (id TEXT PRIMARY KEY,recorded_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS event_dedup_expiry ON event_dedup(recorded_at);
        CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires_at);`);
      connection.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('cookie_key', randomBytes(32).toString('hex'));
      const key = (connection.prepare('SELECT value FROM metadata WHERE key=?').get('cookie_key') as { value: string }).value;
      return { connection, key };
    })().catch(error => { databases.delete(directory); throw error; });
    databases.set(directory, pending);
  }
  return pending;
}
export async function closeOperationsDatabase() {
  const directory = dataDirectory(), map = globals.__pairdeerOperations;
  const pending = map?.get(directory); map?.delete(directory);
  if (pending) (await pending).connection.close();
}
export function chinaDay(now = Date.now()) { return new Date(now + 8 * 3600_000).toISOString().slice(0,10); }
const mac = (key: string, value: string) => createHmac('sha256', key).update(value).digest('hex');
const cookieName = () => (secureCookies() ? '__Host-' : '') + 'pairdeer_ops';
function cookieIdentity(req: Request, key: string, now: number) {
  const token = req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(cookieName() + '='))?.slice(cookieName().length + 1);
  if (!token || token.length > 200) return null;
  const [expires, id, signature, extra] = token.split('.');
  if (extra || !OPERATIONS_EVENT_ID.test(id || '') || !/^\d{10,12}$/.test(expires || '') || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
  const time = Number(expires), seconds = Math.floor(now / 1000);
  if (time <= seconds || time > seconds + COOKIE_SECONDS) return null;
  const expected = mac(key, 'cookie:' + expires + '.' + id);
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')) ? id : null;
}
function issueCookie(key: string, id: string, now: number) {
  const payload = Math.floor(now / 1000) + COOKIE_SECONDS + '.' + id;
  return `${cookieName()}=${payload}.${mac(key, 'cookie:' + payload)}; Path=/; HttpOnly;${secureCookies() ? ' Secure;' : ''} SameSite=Lax; Max-Age=${COOKIE_SECONDS}`;
}
async function excluded(req: Request, now: number) {
  if (await validAccess(req, process.env.ADMIN_SESSION_SECRET, now)) return true;
  for (const raw of [req.url, req.headers.get('referer')]) {
    if (!raw) continue;
    try { const url = new URL(raw); if (url.searchParams.has('admin') || url.hostname.startsWith('admin.') || url.pathname.startsWith('/admin')) return true; } catch { /* No URL is stored. */ }
  }
  return false;
}
function increment(connection: DatabaseSync, day: string, metric: Metric, amount = 1) {
  connection.prepare(`INSERT INTO daily(day,${metric}) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET ${metric}=${metric}+excluded.${metric}`).run(day, amount);
}
function acceptEvent(database: OperationsDatabase, id: string, identity: string | null, now: number) {
  const db = database.connection;
  db.prepare('DELETE FROM event_dedup WHERE recorded_at<?').run(now - 7 * DAY_MS);
  db.prepare('DELETE FROM rate_limits WHERE expires_at<?').run(now);
  if (db.prepare('SELECT 1 FROM event_dedup WHERE id=?').get(id.toLowerCase())) return false;
  const window = Math.floor(now / 60_000);
  const limits: [string, number][] = [['global:' + window, 6000]];
  if (identity) limits.push([mac(database.key, 'rate:' + window + ':' + identity), 180]);
  for (const [key, maximum] of limits) {
    const row = db.prepare('SELECT count FROM rate_limits WHERE key=?').get(key) as { count: number } | undefined;
    if (row && row.count >= maximum) throw new OperationsError('请求较频繁，请稍后再试', 429);
  }
  for (const [key] of limits) db.prepare('INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + 3600_000);
  db.prepare('INSERT INTO event_dedup(id,recorded_at) VALUES (?,?)').run(id.toLowerCase(), now);
  db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('collected_since', new Date(now).toISOString());
  return true;
}
function transaction<T>(database: OperationsDatabase, action: () => T): T {
  database.connection.exec('BEGIN IMMEDIATE');
  try { const value = action(); database.connection.exec('COMMIT'); return value; }
  catch (error) { database.connection.exec('ROLLBACK'); throw error; }
}

const modelAliases: [string, RegExp][] = [
  ['5号 / AA', /(?:^|[^A-Z0-9])(?:LR6|R6P|AA)(?![A-Z0-9])|(?:^|[^0-9])5\s*号|五\s*号/],
  ['7号 / AAA', /(?:^|[^A-Z0-9])(?:LR03|R03P|AAA)(?![A-Z0-9])|(?:^|[^0-9])7\s*号|七\s*号/],
  ['1号 / D', /(?:^|[^A-Z0-9])(?:LR20|R20P|D)(?![A-Z0-9])|(?:^|[^0-9])1\s*号/],
  ['2号 / C', /(?:^|[^A-Z0-9])(?:LR14|C)(?![A-Z0-9])|(?:^|[^0-9])2\s*号/],
  ['9V / 6LR61', /(?:^|[^A-Z0-9])(?:6LR61|9V)(?![A-Z0-9])/],
  ['LR1 / N', /(?:^|[^A-Z0-9])(?:LR1|N)(?![A-Z0-9])/],
  ['9号', /(?:^|[^A-Z0-9])AAAA(?![A-Z0-9])|(?:^|[^0-9])9\s*号/],
];
const fixedModels = ['CR2016','CR2025','CR2032','CR2','CR123A','LR44','SL601','SL701','SL801'];
/** Only catalog model tokens survive this function. The query is never written to SQLite. */
export function extractCanonicalModels(query: string, catalogModels: string[] = []) {
  const normalized = query.normalize('NFKC').toUpperCase();
  const found = modelAliases.filter(([,pattern]) => pattern.test(normalized)).map(([label]) => label);
  const candidates = new Set([...fixedModels, ...catalogModels.flatMap(model => model.toUpperCase().match(/[A-Z]{1,6}[0-9]{1,6}[A-Z]?/g) || [])]);
  const aliases = new Set(['LR6','R6P','LR03','R03P','LR20','R20P','LR14','6LR61','LR1']);
  for (const token of candidates) {
    if (aliases.has(token)) continue;
    if (new RegExp('(?:^|[^A-Z0-9])' + token + '(?![A-Z0-9])').test(normalized)) found.push(token);
  }
  return [...new Set(found)];
}
async function currentCatalogModels() {
  try {
    const row = await (await getDatabase()).prepare('SELECT data FROM catalog WHERE id=1').first<{ data: string }>();
    const products = row ? JSON.parse(row.data).products : seed.products;
    return Array.isArray(products) ? products.map(p => typeof p?.model === 'string' ? p.model : '') : [];
  } catch { return seed.products.map(p => p.model); }
}
export function validatePublicAnalyticsEvent(value: unknown): asserts value is PublicAnalyticsEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperationsError('统计事件格式无效');
  const event = value as Record<string, unknown>;
  if (Object.keys(event).some(key => !['id','type','page','query','source'].includes(key)) || typeof event.id !== 'string' || !OPERATIONS_EVENT_ID.test(event.id) ||
      !['pageview','search'].includes(String(event.type)) || !['home','product','company_pdf','company_video'].includes(String(event.page))) throw new OperationsError('统计事件格式无效');
  if (event.type === 'pageview' && (event.query !== undefined || event.source !== undefined)) throw new OperationsError('页面事件格式无效');
  if (event.type === 'search' && (event.source !== undefined && !['text','image'].includes(String(event.source)) ||
      event.query !== undefined && typeof event.query !== 'string' || typeof event.query === 'string' && event.query.length > 500 ||
      event.source === 'image' && typeof event.query === 'string' && !!event.query.trim() ||
      event.source !== 'image' && (typeof event.query !== 'string' || !event.query.trim()))) throw new OperationsError('搜索事件格式无效');
}
export async function recordPublicAnalytics(req: Request, event: PublicAnalyticsEvent, now = Date.now()) {
  validatePublicAnalyticsEvent(event);
  if (await excluded(req, now)) return { ignored: true };
  const database = await getOperationsDatabase();
  const existing = cookieIdentity(req, database.key, now);
  const browser = existing || randomUUID();
  const models = event.type === 'search' ? extractCanonicalModels(event.query || '', await currentCatalogModels()) : [];
  transaction(database, () => {
    if (!acceptEvent(database, event.id, browser, now)) return;
    const day = chinaDay(now);
    const inserted = database.connection.prepare('INSERT OR IGNORE INTO visitors(hash,first_day) VALUES (?,?)').run(mac(database.key, 'visitor:' + browser), day);
    if (inserted.changes) increment(database.connection, day, 'new_visitors');
    increment(database.connection, day, event.type === 'pageview' ? 'page_views' : 'searches');
    for (const model of models) database.connection.prepare('INSERT INTO hot_models(day,model,count) VALUES (?,?,1) ON CONFLICT(day,model) DO UPDATE SET count=count+1').run(day, model);
  });
  return { ignored: false, ...(!existing ? { cookie: issueCookie(database.key, browser, now) } : {}) };
}

/** Instrumentation is best effort: analytics never blocks a successful material download. */
export async function recordDownload(req: Request, options: { kind: DownloadKind; eventId?: string }) {
  try {
    const now = Date.now();
    if (!['pdf','video','image','detail','zip'].includes(options.kind) || req.method !== 'GET' || req.headers.has('range') || await excluded(req, now)) return;
    const id = options.eventId || randomUUID(); if (!OPERATIONS_EVENT_ID.test(id)) return;
    const database = await getOperationsDatabase(), browser = cookieIdentity(req, database.key, now);
    transaction(database, () => { if (acceptEvent(database, id, browser, now)) increment(database.connection, chinaDay(now), ('download_' + options.kind) as Metric); });
  } catch { /* Serving files remains independent of aggregate analytics availability. */ }
}

/** A material unit is one unique URL within a product section, banner, or company-original slot. Reordering/removing URLs and PDF preview images do not add units. */
export function countAdminMaterialChanges(before: unknown, after: unknown) {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const groups = (value: unknown) => {
    const catalog = object(value);
    const result = new Map<string, Set<string>>();
    const set = (key: string, urls: unknown[]) => result.set(key, new Set(urls.filter((url): url is string => typeof url === 'string' && !!url)));
    for (const item of Array.isArray(catalog.products) ? catalog.products : []) {
      const product = object(item);
      if (typeof product.id !== 'string' || !product.id) continue;
      for (const section of ['mainImages','detailImages','extraImages','videos']) set('product:' + product.id + ':' + section, Array.isArray(product[section]) ? product[section] : []);
    }
    for (const [index,item] of (Array.isArray(catalog.banners) ? catalog.banners : []).entries()) {
      const banner = object(item); set('banner:' + (typeof banner.id === 'string' ? banner.id : index), [banner.image]);
    }
    const company = resolveCompanyMaterials(catalog?.companyMaterials);
    for (const kind of ['pdf','video'] as const) set('company:' + kind, [company[kind]?.url]);
    return result;
  };
  const old = groups(before), current = groups(after); let added = 0, replaced = 0;
  for (const [key, urls] of current) {
    const previous = old.get(key) || new Set<string>();
    const fresh = [...urls].filter(url => !previous.has(url)).length, removed = [...previous].filter(url => !urls.has(url)).length;
    const substitutions = Math.min(fresh, removed); replaced += substitutions; added += fresh - substitutions;
  }
  return { added, replaced };
}
export async function recordAdminPublication(before: unknown, after: unknown) {
  try {
    const counts = countAdminMaterialChanges(before, after); if (!counts.added && !counts.replaced) return;
    const database = await getOperationsDatabase(), now = Date.now();
    transaction(database, () => {
      database.connection.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('collected_since', new Date(now).toISOString());
      if (counts.added) increment(database.connection, chinaDay(now), 'admin_added', counts.added);
      if (counts.replaced) increment(database.connection, chinaDay(now), 'admin_replaced', counts.replaced);
    });
  } catch { /* Publication success must not depend on analytics storage. */ }
}

function counts(row?: Record<string, unknown>): OperationsCounts {
  const n = (key: string) => Number(row?.[key] || 0);
  const downloads = { pdf:n('download_pdf'),video:n('download_video'),image:n('download_image'),detail:n('download_detail'),zip:n('download_zip'),total:0 };
  downloads.total = downloads.pdf + downloads.video + downloads.image + downloads.detail + downloads.zip;
  return { newVisitors:n('new_visitors'),pageViews:n('page_views'),searches:n('searches'),downloads,adminMaterials:{added:n('admin_added'),replaced:n('admin_replaced')} };
}
function parseDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OperationsError('日期格式应为 YYYY-MM-DD');
  const stamp = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0,10) !== value) throw new OperationsError('日期无效');
  return stamp;
}
export async function readOperationsSnapshot(from?: string, to?: string, now = Date.now()): Promise<OperationsSnapshot> {
  const today = chinaDay(now), month = today.slice(0,7);
  from ||= month + '-01'; to ||= today;
  const start = parseDay(from), end = parseDay(to);
  if (end < start || (end - start) / DAY_MS >= 366 || to > today) throw new OperationsError('请选择截至今天、最长 366 天的有效日期范围');
  const database = await getOperationsDatabase(), db = database.connection;
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get('collected_since') as { value: string } | undefined;
  const sums = metrics.map(name => 'COALESCE(SUM(' + name + '),0) AS ' + name).join(',');
  const lifetime = counts(db.prepare('SELECT ' + sums + ' FROM daily').get());
  const visitors = Number((db.prepare('SELECT COUNT(*) AS count FROM visitors').get() as {count:number}).count);
  const dailyRows = new Map((db.prepare('SELECT * FROM daily WHERE day BETWEEN ? AND ? ORDER BY day').all(from,to) as Record<string,unknown>[]).map(item => [String(item.day), item]));
  const daily: OperationsSnapshot['daily'] = [];
  for (let stamp = start; stamp <= end; stamp += DAY_MS) { const day = new Date(stamp).toISOString().slice(0,10); daily.push({ day, ...counts(dailyRows.get(day)) }); }
  const hotModels = db.prepare('SELECT model,SUM(count) AS count FROM hot_models WHERE day BETWEEN ? AND ? GROUP BY model ORDER BY count DESC,model ASC LIMIT 50').all(from,to) as {model:string;count:number}[];
  const monthly: OperationsSnapshot['monthly'] = [];
  const firstMonth = new Date(from.slice(0,7) + '-01T00:00:00Z');
  const lastMonth = to.slice(0,7);
  for (const date = new Date(firstMonth); date.toISOString().slice(0,7) <= lastMonth; date.setUTCMonth(date.getUTCMonth() + 1)) {
    const key = date.toISOString().slice(0,7);
    monthly.push({ month: key, ...counts(db.prepare('SELECT ' + sums + ' FROM daily WHERE day>=? AND day<?').get(key + '-01', new Date(new Date(date).setUTCMonth(date.getUTCMonth()+1)).toISOString().slice(0,10))) });
  }
  const currentMonth = counts(db.prepare('SELECT ' + sums + ' FROM daily WHERE day>=? AND day<=?').get(month + '-01',today));
  const totals = { pageViews:lifetime.pageViews,searches:lifetime.searches,downloads:lifetime.downloads,adminMaterials:lifetime.adminMaterials };
  return { collectedSince:row?.value || null,timeZone:'Asia/Shanghai',totals:{...totals,visitors},currentMonth:{month,pageViews:currentMonth.pageViews},range:{from,to},hotModels,daily,monthly };
}
