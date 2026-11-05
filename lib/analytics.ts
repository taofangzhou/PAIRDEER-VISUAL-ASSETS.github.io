import { createHmac } from 'node:crypto';
import { db, bindings } from '@/lib/server';

type CounterRow = { metric: string; dimension: string; period: string; count: number };
type AssetCatalog = {
  products?: Array<Record<string, unknown> & { id?: string }>;
  banners?: Array<Record<string, unknown> & { id?: string; image?: string }>;
  companyMaterials?: Record<string, unknown>;
};

export async function ensureAnalyticsTables() {
  await db().prepare(\`CREATE TABLE IF NOT EXISTS analytics_counters (
    metric TEXT NOT NULL,
    dimension TEXT NOT NULL DEFAULT '',
    period TEXT NOT NULL DEFAULT 'all',
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (metric, dimension, period)
  )\`).run();
  // Only a one-way keyed digest is retained for unique-browser de-duplication.
  // No page, search, download, IP, user-agent or event history is stored here.
  await db().prepare(\`CREATE TABLE IF NOT EXISTS analytics_visitors (
    visitor_hash TEXT PRIMARY KEY
  )\`).run();
}

export async function incrementAnalytics(metric: string, dimension = '', period = 'all', amount = 1) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return;
  await ensureAnalyticsTables();
  await db().prepare(\`INSERT INTO analytics_counters (metric, dimension, period, count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(metric, dimension, period)
    DO UPDATE SET count = count + excluded.count\`)
    .bind(metric, dimension, period, amount).run();
}

export function shanghaiMonth(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
  }).formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value || '0000';
  const month = parts.find(part => part.type === 'month')?.value || '00';
  return year + '-' + month;
}

export async function addUniqueVisitor(visitorId: string) {
  const secret = bindings.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('统计服务尚未配置');
  await ensureAnalyticsTables();
  const digest = createHmac('sha256', secret).update(visitorId).digest('hex');
  const result = await db().prepare('INSERT OR IGNORE INTO analytics_visitors (visitor_hash) VALUES (?)')
    .bind(digest).run();
  if (result.meta.changes > 0) await incrementAnalytics('unique_visitors');
}

function assetBuckets(catalog: AssetCatalog) {
  const buckets = new Map<string, string[]>();
  const add = (key: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const list = buckets.get(key) || [];
    list.push(value);
    buckets.set(key, list);
  };
  for (const product of catalog.products || []) {
    const id = String(product.id || '');
    if (!id) continue;
    for (const field of ['mainImages', 'detailImages', 'extraImages', 'videos']) {
      const values = product[field];
      if (Array.isArray(values)) for (const value of values) add('product:' + id + ':' + field, value);
    }
  }
  for (const banner of catalog.banners || []) {
    if (banner.id) add('banner:' + String(banner.id), banner.image);
  }
  const company = catalog.companyMaterials;
  if (company && typeof company === 'object') {
    for (const kind of ['pdf', 'video']) {
      const material = (company as Record<string, unknown>)[kind];
      if (material && typeof material === 'object') add('company:' + kind, (material as Record<string, unknown>).url);
    }
  }
  return buckets;
}

export function countAssetChanges(before: AssetCatalog | null, after: AssetCatalog) {
  const oldBuckets = assetBuckets(before || {});
  const newBuckets = assetBuckets(after || {});
  let added = 0;
  let replaced = 0;
  const keys = new Set([...oldBuckets.keys(), ...newBuckets.keys()]);
  for (const key of keys) {
    const oldCounts = new Map<string, number>();
    const newCounts = new Map<string, number>();
    for (const value of oldBuckets.get(key) || []) oldCounts.set(value, (oldCounts.get(value) || 0) + 1);
    for (const value of newBuckets.get(key) || []) newCounts.set(value, (newCounts.get(value) || 0) + 1);
    let additions = 0;
    let removals = 0;
    for (const [value, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(value) || 0));
    for (const [value, count] of oldCounts) removals += Math.max(0, count - (newCounts.get(value) || 0));
    const paired = Math.min(additions, removals);
    replaced += paired;
    added += additions - paired;
  }
  return { added, replaced };
}

export async function recordAssetChanges(before: AssetCatalog | null, after: AssetCatalog) {
  const changes = countAssetChanges(before, after);
  if (changes.added) await incrementAnalytics('asset_added', '', 'all', changes.added);
  if (changes.replaced) await incrementAnalytics('asset_replaced', '', 'all', changes.replaced);
  return changes;
}

export async function readAnalyticsSummary() {
  await ensureAnalyticsTables();
  const result = await db().prepare('SELECT metric, dimension, period, count FROM analytics_counters')
    .all<CounterRow>();
  const rows = result.results || [];
  const get = (metric: string, dimension = '', period = 'all') =>
    rows.find(row => row.metric === metric && row.dimension === dimension && row.period === period)?.count || 0;
  const visitors = await db().prepare('SELECT COUNT(*) AS total FROM analytics_visitors')
    .first<{ total: number }>();
  const popularModels = rows
    .filter(row => row.metric === 'search_model' && row.period === 'all')
    .map(row => ({ model: row.dimension, count: row.count }))
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model, 'zh-CN'))
    .slice(0, 20);
  const monthlyVisits = rows
    .filter(row => row.metric === 'pageview' && row.period !== 'all')
    .map(row => ({ month: row.period, count: row.count }))
    .sort((a, b) => b.month.localeCompare(a.month))
    .slice(0, 24)
    .reverse();
  return {
    uniqueVisitors: Number(visitors?.total || 0),
    pageViewsTotal: get('pageview'),
    searchTotal: get('search'),
    popularModels,
    downloads: {
      pdf: get('download', 'pdf'),
      video: get('download', 'video'),
      image: get('download', 'image'),
      detail: get('download', 'detail'),
    },
    assets: {
      added: get('asset_added'),
      replaced: get('asset_replaced'),
    },
    monthlyVisits,
    generatedAt: new Date().toISOString(),
  };
}
