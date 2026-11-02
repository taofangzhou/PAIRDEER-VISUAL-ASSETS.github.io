import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {db} from '@/lib/server';
import {dataDirectory} from '@/lib/runtime';
export const dynamic = 'force-dynamic';
export async function GET() {
 try {
  await db().prepare('SELECT 1 AS ok').first();
  await access(path.join(dataDirectory(),'media'),constants.W_OK);
  return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
 } catch {
  return Response.json({ok:false},{status:503,headers:{'Cache-Control':'no-store'}});
 }
}
