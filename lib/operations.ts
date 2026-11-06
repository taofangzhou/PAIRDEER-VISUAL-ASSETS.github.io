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
export type DownloadCounts = Record<Exclude<DownloadKind, 'zip'>, number> & { total: number };
export type OperationsSnapshot = {
  collectedSince: string | null; timeZone: 'Asia/Shanghai';
  totals: { visitors: number; searches: number; downloads: DownloadCounts; adminMaterials: { added: number; replaced: number } };
  currentMonth: { month: string; pageViews: number };
  hotModels: { model: string; count: number }[]; monthly: { month: string; pageViews: number }[];
};
export class OperationsError extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export const OPERATIONS_EVENT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const OPERATIONS_RETRY_LIMIT = 10_000;
export const OPERATIONS_RETRY_TTL_MS = 86_400_000;
const COOKIE_SECONDS = 365 * 86400;
const aggregateMetrics = ['searches','download_pdf','download_video','download_image','download_detail','admin_added','admin_replaced'] as const;
type Metric = typeof aggregateMetrics[number];
type OperationsDatabase = { connection: DatabaseSync; key: string; limiter: { window: number; count: number; browsers: Map<string, number> } };
const globals = globalThis as typeof globalThis & { __pairdeerOperations?: Map<string, Promise<OperationsDatabase>> };

function tableExists(connection: DatabaseSync, name: string) {
  return !!connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function retryId(id: string) { return Buffer.from(id.replaceAll('-', ''), 'hex'); }
function trimRetryKeys(connection: DatabaseSync, now: number) {
  connection.prepare('DELETE FROM event_dedup WHERE recorded_at<=?').run(now - OPERATIONS_RETRY_TTL_MS);
  const count = Number((connection.prepare('SELECT COUNT(*) AS count FROM event_dedup').get() as {count:number}).count);
  if (count > OPERATIONS_RETRY_LIMIT) connection.prepare('DELETE FROM event_dedup WHERE id IN (SELECT id FROM event_dedup ORDER BY recorded_at,id LIMIT ?)').run(count - OPERATIONS_RETRY_LIMIT);
}
/** Transactionally roll up the former daily schema without resetting any requested lifetime totals or visitor identities. */
function initializeStorage(connection: DatabaseSync) {
  let migrated = false;
  connection.exec('BEGIN IMMEDIATE');
  try {
    const version = Number((connection.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if (version > 2) throw new Error('统计数据库版本较新，请使用匹配的应用版本');
    if (version < 2) {
      const legacy = ['metadata','visitors','hot_models','event_dedup'].filter(name => tableExists(connection,name));
      migrated = legacy.length > 0 || tableExists(connection,'daily');
      for (const name of legacy) connection.exec('ALTER TABLE ' + name + ' RENAME TO ' + name + '_legacy');
      connection.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE visitors (hash BLOB PRIMARY KEY CHECK(length(hash)=32)) WITHOUT ROWID;
        CREATE TABLE aggregates (id INTEGER PRIMARY KEY CHECK(id=1), ${aggregateMetrics.map(name => name + ' INTEGER NOT NULL DEFAULT 0').join(',')});
        INSERT INTO aggregates(id) VALUES (1);
        CREATE TABLE monthly (month TEXT PRIMARY KEY,page_views INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
        CREATE TABLE hot_models (model TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
        CREATE TABLE event_dedup (id BLOB PRIMARY KEY CHECK(length(id)=16),recorded_at INTEGER NOT NULL) WITHOUT ROWID;`);
      if (legacy.includes('metadata')) connection.exec('INSERT INTO metadata SELECT key,value FROM metadata_legacy');
      if (legacy.includes('visitors')) {
        connection.function('operations_hash_blob',{deterministic:true},value => {
          if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value,'hex');
          if (value instanceof Uint8Array && value.byteLength === 32) return value;
          throw new Error('已有访客去重数据格式无效，迁移已取消');
        });
        connection.exec('INSERT OR IGNORE INTO visitors(hash) SELECT operations_hash_blob(hash) FROM visitors_legacy');
      }
      if (tableExists(connection,'daily')) {
        connection.exec('UPDATE aggregates SET ' + aggregateMetrics.map(name => name + '=(SELECT COALESCE(SUM(' + name + '),0) FROM daily)').join(','));
        connection.exec("INSERT INTO monthly(month,page_views) SELECT substr(day,1,7),SUM(page_views) FROM daily GROUP BY substr(day,1,7)");
      }
      if (legacy.includes('hot_models')) connection.exec('INSERT INTO hot_models(model,count) SELECT model,SUM(count) FROM hot_models_legacy GROUP BY model');
      if (legacy.includes('event_dedup')) {
        connection.function('operations_event_blob',{deterministic:true},value => {
          if (typeof value === 'string' && OPERATIONS_EVENT_ID.test(value)) return retryId(value);
          if (value instanceof Uint8Array && value.byteLength === 16) return value;
          return null;
        });
        connection.prepare('INSERT OR IGNORE INTO event_dedup SELECT operations_event_blob(id),recorded_at FROM event_dedup_legacy WHERE recorded_at>? AND operations_event_blob(id) IS NOT NULL').run(Date.now() - OPERATIONS_RETRY_TTL_MS);
      }
      for (const name of [...legacy.map(name => name + '_legacy'),'daily','rate_limits']) if (tableExists(connection,name)) connection.exec('DROP TABLE ' + name);
      connection.exec('CREATE INDEX event_dedup_expiry ON event_dedup(recorded_at); PRAGMA user_version=2;');
    }
    trimRetryKeys(connection,Date.now());
    connection.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('cookie_key', randomBytes(32).toString('hex'));
    connection.exec('COMMIT');
  } catch (error) { connection.exec('ROLLBACK'); throw error; }
  // Compaction is maintenance, not a prerequisite for retaining the migrated counters.
  if (migrated) {
    try { connection.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA auto_vacuum=INCREMENTAL; VACUUM;'); } catch { /* A nearly full volume may defer compaction without losing the committed roll-up. */ }
  }
  connection.exec('PRAGMA optimize;');
}

/** Only five requested aggregates, compact exact-UV hashes and bounded 24-hour retry keys are persisted. */
export function getOperationsDatabase(): Promise<OperationsDatabase> {
  const directory = dataDirectory();
  const databases = globals.__pairdeerOperations ??= new Map();
  let pending = databases.get(directory);
  if (!pending) {
    pending = (async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const connection = new DatabaseSync(join(directory, 'operations.sqlite'));
      try {
        connection.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=262144;');
        if (!tableExists(connection,'metadata')) connection.exec('PRAGMA auto_vacuum=INCREMENTAL;');
        initializeStorage(connection);
        const key = (connection.prepare('SELECT value FROM metadata WHERE key=?').get('cookie_key') as { value: string }).value;
        return { connection, key, limiter: { window:-1, count:0, browsers:new Map<string,number>() } };
      } catch (error) { connection.close(); throw error; }
    })().catch(error => { databases.delete(directory); throw error; });
    databases.set(directory, pending);
  }
  return pending;
}
export async function closeOperationsDatabase() {
  const directory = dataDirectory(), map = globals.__pairdeerOperations;
  const pending = map?.get(directory); map?.delete(directory);
  if (pending) {
    const database = await pending;
    try { database.connection.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum(32); PRAGMA optimize;'); } catch { /* Closing must still release the connection. */ }
    database.connection.close();
  }
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
function increment(connection: DatabaseSync, metric: Metric, amount = 1) {
  connection.prepare('UPDATE aggregates SET ' + metric + '=' + metric + '+? WHERE id=1').run(amount);
}
function acceptEvent(database: OperationsDatabase, id: string, identity: string | null, now: number) {
  const db = database.connection;
  trimRetryKeys(db,now);
  if (db.prepare('SELECT 1 FROM event_dedup WHERE id=?').get(retryId(id))) return false;
  const window = Math.floor(now / 60_000), limit = database.limiter;
  if (limit.window !== window) { limit.window=window; limit.count=0; limit.browsers.clear(); }
  const key = identity ? mac(database.key,'rate:' + window + ':' + identity) : null;
  if (limit.count >= 6000 || key && (limit.browsers.get(key) || 0) >= 180) throw new OperationsError('请求较频繁，请稍后再试',429);
  limit.count++;
  if (key) { if (limit.browsers.size >= 10_000 && !limit.browsers.has(key)) limit.browsers.delete(limit.browsers.keys().next().value!); limit.browsers.set(key,(limit.browsers.get(key) || 0)+1); }
  db.prepare('INSERT INTO event_dedup(id,recorded_at) VALUES (?,?)').run(retryId(id),now);
  trimRetryKeys(db,now);
  db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('collected_since',new Date(now).toISOString());
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
    database.connection.prepare('INSERT OR IGNORE INTO visitors(hash) VALUES (?)').run(Buffer.from(mac(database.key,'visitor:' + browser),'hex'));
    if (event.type === 'pageview') database.connection.prepare('INSERT INTO monthly(month,page_views) VALUES (?,1) ON CONFLICT(month) DO UPDATE SET page_views=page_views+1').run(chinaDay(now).slice(0,7));
    else increment(database.connection,'searches');
    for (const model of models) database.connection.prepare('INSERT INTO hot_models(model,count) VALUES (?,1) ON CONFLICT(model) DO UPDATE SET count=count+1').run(model);
  });
  return { ignored: false, ...(!existing ? { cookie: issueCookie(database.key, browser, now) } : {}) };
}

/** Instrumentation is best effort: analytics never blocks a successful material download. */
export async function recordDownload(req: Request, options: { kind: DownloadKind; eventId?: string }) {
  try {
    const now = Date.now();
    if (!['pdf','video','image','detail'].includes(options.kind) || req.method !== 'GET' || req.headers.has('range') || await excluded(req, now)) return;
    const id = options.eventId || randomUUID(); if (!OPERATIONS_EVENT_ID.test(id)) return;
    const database = await getOperationsDatabase(), browser = cookieIdentity(req, database.key, now);
    transaction(database, () => { if (acceptEvent(database, id, browser, now)) increment(database.connection, ('download_' + options.kind) as Metric); });
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
      if (counts.added) increment(database.connection, 'admin_added', counts.added);
      if (counts.replaced) increment(database.connection, 'admin_replaced', counts.replaced);
    });
  } catch { /* Publication success must not depend on analytics storage. */ }
}

/** Reports expose only the five requested metrics; there are no daily reports, date filters or exports. */
export async function readOperationsSnapshot(now = Date.now()): Promise<OperationsSnapshot> {
  const month = chinaDay(now).slice(0,7);
  const database = await getOperationsDatabase(), db = database.connection;
  trimRetryKeys(db,now);
  const row = db.prepare('SELECT value FROM metadata WHERE key=?').get('collected_since') as { value: string } | undefined;
  const total = db.prepare('SELECT * FROM aggregates WHERE id=1').get() as Record<string,unknown>;
  const n = (key: string) => Number(total[key] || 0);
  const downloads = { pdf:n('download_pdf'),video:n('download_video'),image:n('download_image'),detail:n('download_detail'),total:0 };
  downloads.total = downloads.pdf + downloads.video + downloads.image + downloads.detail;
  const visitors = Number((db.prepare('SELECT COUNT(*) AS count FROM visitors').get() as {count:number}).count);
  const current = db.prepare('SELECT page_views FROM monthly WHERE month=?').get(month) as {page_views:number}|undefined;
  const hotModels = db.prepare('SELECT model,count FROM hot_models ORDER BY count DESC,model ASC LIMIT 50').all() as {model:string;count:number}[];
  const monthly = db.prepare('SELECT month,page_views AS pageViews FROM monthly ORDER BY month').all() as {month:string;pageViews:number}[];
  return { collectedSince:row?.value || null,timeZone:'Asia/Shanghai',totals:{visitors,searches:n('searches'),downloads,adminMaterials:{added:n('admin_added'),replaced:n('admin_replaced')}},currentMonth:{month,pageViews:Number(current?.page_views || 0)},hotModels,monthly };
}
