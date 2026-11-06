import { authorize, fail } from '@/lib/server';
import { OperationsError, readOperationsSnapshot } from '@/lib/operations';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
function errorResponse(error: unknown, status: number) { const response = fail(error,status); response.headers.set('Cache-Control','no-store'); return response; }
export async function GET(req: Request) {
  try { await authorize(req); } catch (error) { return errorResponse(error,403); }
  try {
    if (new URL(req.url).searchParams.size) throw new OperationsError('此统计仅提供累计指标和月访问量，不支持日期筛选或导出');
    return Response.json(await readOperationsSnapshot(),{headers:{'Cache-Control':'no-store'}});
  } catch (error) { return errorResponse(error,error instanceof OperationsError ? error.status : 503); }
}
