import { authorize, fail } from '@/lib/server';
import { OperationsError, readOperationsSnapshot } from '@/lib/operations';
import { createOperationsExport } from '@/lib/operations-export';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
function errorResponse(error: unknown, status: number) { const response = fail(error,status); response.headers.set('Cache-Control','no-store'); return response; }
export async function GET(req: Request) {
  try { await authorize(req); } catch (error) { return errorResponse(error,403); }
  try {
    const params = new URL(req.url).searchParams;
    const snapshot = await readOperationsSnapshot(params.get('from') || undefined,params.get('to') || undefined);
    const format = params.get('format');
    if (!format) return Response.json(snapshot,{headers:{'Cache-Control':'no-store'}});
    if (format !== 'csv' && format !== 'xlsx') throw new OperationsError('导出格式无效');
    const result = createOperationsExport(snapshot,format);
    return new Response(result.body,{headers:{'Content-Type':result.contentType,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  } catch (error) { return errorResponse(error,error instanceof OperationsError ? error.status : 503); }
}
