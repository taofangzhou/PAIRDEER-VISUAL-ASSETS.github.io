import { validAccess } from '@/lib/admin-access';
import { localDatabase, mediaBucket } from '@/lib/runtime';

// Secrets stay on ECS. No platform identity headers are accepted here.
export const bindings = {
  DB: localDatabase,
  BUCKET: mediaBucket,
  get APP_ORIGIN() { return process.env.APP_ORIGIN; },
  get ADMIN_ENTRY_PASSWORD() { return process.env.ADMIN_ENTRY_PASSWORD; },
  get ADMIN_SESSION_SECRET() { return process.env.ADMIN_SESSION_SECRET; },
  get ADMIN_EMAIL() { return process.env.ADMIN_EMAIL; },
  get TRUST_PROXY() { return process.env.TRUST_PROXY; },
  get ALLOW_INSECURE_COOKIES() { return process.env.ALLOW_INSECURE_COOKIES; },
  get ALIYUN_SIGNER_URL() { return process.env.ALIYUN_SIGNER_URL; },
  get ALIYUN_SIGNER_TOKEN() { return process.env.ALIYUN_SIGNER_TOKEN; },
  get CATALOG_API_URL() { return process.env.CATALOG_API_URL; },
  get CATALOG_API_TOKEN() { return process.env.CATALOG_API_TOKEN; },
};

export const db = () => localDatabase;

export function adminConfigured() {
  return !!bindings.ADMIN_ENTRY_PASSWORD && bindings.ADMIN_ENTRY_PASSWORD.length >= 12 &&
    !!bindings.ADMIN_SESSION_SECRET && bindings.ADMIN_SESSION_SECRET.length >= 32;
}

export async function identity(req: Request) {
  const admin = adminConfigured() && await validAccess(req, bindings.ADMIN_SESSION_SECRET);
  return {
    user: admin ? { userId: 'ecs-admin', displayName: '管理员', email: bindings.ADMIN_EMAIL || '', fullName: null } : null,
    admin,
    claimed: adminConfigured(),
  };
}

export function sameOrigin(req: Request) {
  const expected = new URL(bindings.APP_ORIGIN || req.url).origin;
  const origin = req.headers.get('origin');
  if ((origin && origin !== expected) || req.headers.get('sec-fetch-site') === 'cross-site') {
    throw new Error('请求来源无效');
  }
}

export async function authorize(req: Request) {
  sameOrigin(req);
  const who = await identity(req);
  if (!who.admin) throw new Error('请先输入管理员密码');
  return who;
}

export const fail = (error: unknown, status = 503) => Response.json({
  error: error instanceof Error ? error.message : '服务暂不可用，请稍后重试',
}, { status });

export function validUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  if (/^\/(?:assets|api\/media)\//.test(value)) return !value.includes('..') && !value.includes('\\');
  try {
    const url = new URL(value);
    // An ECS catalog must never retain a link back to the former platform.
    return url.protocol === 'https:' && !url.username && !url.password &&
      !/(^|\.)(?:chatgpt\.site|chatgpt-team\.site|appgardenapps\.(?:com|dev))$/i.test(url.hostname);
  } catch { return false; }
}

export async function externalCatalog(method: string, payload?: unknown) {
  if (!bindings.CATALOG_API_URL || !bindings.CATALOG_API_TOKEN) throw new Error('阿里云数据库接口未配置完整');
  const response = await fetch(bindings.CATALOG_API_URL, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bindings.CATALOG_API_TOKEN },
    ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(30_000),
  });
  return Response.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'no-store' } });
}
