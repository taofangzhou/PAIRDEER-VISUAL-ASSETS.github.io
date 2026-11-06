import { sameOrigin, fail } from '@/lib/server';
import { OperationsError, recordPublicAnalytics, validatePublicAnalyticsEvent } from '@/lib/operations';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
function errorResponse(error: unknown, status: number) { const response = fail(error,status); response.headers.set('Cache-Control','no-store'); return response; }
export async function POST(req: Request) {
  try { sameOrigin(req); } catch (error) { return errorResponse(error,403); }
  try {
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new OperationsError('请使用 JSON 请求');
    if (Number(req.headers.get('content-length') || 0) > 4096) throw new OperationsError('统计事件过大',413);
    const reader = req.body?.getReader(); if (!reader) throw new OperationsError('统计事件为空');
    const chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const {value,done} = await reader.read(); if (done) break; length += value.length; if (length > 4096) throw new OperationsError('统计事件过大',413); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new OperationsError('统计事件 JSON 无效'); }
    validatePublicAnalyticsEvent(value);
    const result = await recordPublicAnalytics(req,value);
    const headers = new Headers({ 'Cache-Control':'no-store' });
    if (result.cookie) headers.set('Set-Cookie',result.cookie);
    return Response.json({ok:true,ignored:result.ignored},{headers});
  } catch (error) { return errorResponse(error,error instanceof OperationsError ? error.status : 503); }
}
