import { authorize, fail } from '@/lib/server';
import {
  CompanyMaterialError, companyUploadName, storeCompanyMaterial, validateCompanyUploadType,
} from '@/lib/company-material-storage.mjs';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  try { await authorize(req); } catch (error) { return fail(error, 403); }
  try {
    const { kind } = await params;
    if (kind !== 'pdf' && kind !== 'video') return fail(new Error('介绍栏目不存在'), 404);
    const name = companyUploadName(req.headers.get('x-file-name'), kind);
    validateCompanyUploadType(req.headers.get('content-type'), kind);
    if (!req.body) throw new CompanyMaterialError('请选择文件');
    const length = req.headers.get('content-length');
    const material = await storeCompanyMaterial(kind, name, req.body, length === null ? undefined : Number(length));
    return Response.json({ material }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fail(error, error instanceof CompanyMaterialError ? error.status : 503);
  }
}
