import {identity,fail,bindings} from '@/lib/server';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
 try {
  const who = await identity(req);
  return Response.json({signedIn:who.admin,admin:who.admin,claimed:true,email:who.user?.email,storage:bindings.ALIYUN_SIGNER_URL?'aliyun':'ecs',favoritesMode:'browser'},{headers:{'Cache-Control':'no-store'}});
 } catch(e) {return fail(e)}
}
