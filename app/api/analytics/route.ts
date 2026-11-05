import { GET as getCatalog } from '@/app/api/catalog/route';
import { authorize, bindings, db, fail, identity, sameOrigin } from '@/lib/server';
import { addUniqueVisitor, incrementAnalytics, readAnalyticsSummary, shanghaiMonth } from '@/lib/analytics';
import { issueVisitor, visitorCookie, visitorIdentity } from '@/lib/admin-access';

export const dynamic = 'force-dynamic';

function normalized(value: string) {
  return value.normalize('NFKC').toUpperCase().replace(/[\s_-]+/g, '');
}

async function canonicalModel(query: string) {
  const key = normalized(query);
  if (!key) return '';
  const response = await getCatalog();
  if (!response.ok) return '';
  const payload = await response.json() as { data?: { products?: Array<{ model?: string; name?: string }> } };
  const products = payload.data?.products || [];
  const matches = products.filter(product =>
    normalized(String(product.model || '')) === key ||
    normalized(String(product.name || '')) === key
  );
  const models = Array.from(new Set(matches.map(product => String(product.model || '').trim()).filter(Boolean)));
  return models.length === 1 ? models[0] : '';
}

export async function GET(req: Request) {
  try {
    await authorize(req);
    return Response.json(await readAnalyticsSummary(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fail(error, 403);
  }
}

export async function POST(req: Request) {
  try { sameOrigin(req); } catch (error) { return fail(error, 403); }
  try {
    if (!bindings.ADMIN_SESSION_SECRET || bindings.ADMIN_SESSION_SECRET.length < 32) {
      throw new Error('统计服务尚未配置');
    }
    if ((await identity(req)).admin) return Response.json({ ok: true, ignored: true });
    const text = await req.text();
    if (text.length > 512) return fail(new Error('统计请求无效'), 413);
    let body: { type?: unknown; value?: unknown };
    try { body = JSON.parse(text); } catch { return fail(new Error('统计请求无效'), 400); }
    const type = body.type;
    if (type !== 'pageview' && type !== 'search' && type !== 'download') {
      return fail(new Error('统计类型无效'), 400);
    }
    const month = shanghaiMonth();
    if (type === 'pageview') {
      await incrementAnalytics('pageview');
      await incrementAnalytics('pageview', '', month);
      let visitorId = await visitorIdentity(req, bindings.ADMIN_SESSION_SECRET);
      let setCookie = '';
      if (!visitorId) {
        const token = await issueVisitor(bindings.ADMIN_SESSION_SECRET);
        const cookie = visitorCookie(token);
        const cookiePair = cookie.split(';')[0];
        const syntheticRequest = new Request(req.url, { headers: { cookie: cookiePair } });
        visitorId = await visitorIdentity(syntheticRequest, bindings.ADMIN_SESSION_SECRET);
        setCookie = cookie;
      }
      if (visitorId) await addUniqueVisitor(visitorId);
      return Response.json({ ok: true }, {
        headers: { 'Cache-Control': 'no-store', ...(setCookie ? { 'Set-Cookie': setCookie } : {}) },
      });
    }
    if (type === 'search') {
      const query = typeof body.value === 'string' ? body.value.trim().slice(0, 100) : '';
      if (!query) return Response.json({ ok: true });
      await incrementAnalytics('search');
      const model = await canonicalModel(query);
      if (model) await incrementAnalytics('search_model', model);
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const category = body.value;
    if (category !== 'pdf' && category !== 'video' && category !== 'image' && category !== 'detail') {
      return fail(new Error('下载分类无效'), 400);
    }
    await incrementAnalytics('download', category);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fail(error);
  }
}
