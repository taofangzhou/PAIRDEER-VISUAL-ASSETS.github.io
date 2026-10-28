import {bindings,db,sameOrigin,fail} from '@/lib/server';
import {issueVisitor,visitorCookie,visitorIdentity} from '@/lib/admin-access';
export const dynamic = 'force-dynamic';
const noStore = {'Cache-Control':'private, no-store',Vary:'Cookie'};
function secret() {
 if (!bindings.ADMIN_SESSION_SECRET || bindings.ADMIN_SESSION_SECRET.length < 32) throw new Error('收藏服务尚未配置');
 return bindings.ADMIN_SESSION_SECRET;
}
export async function GET(req: Request) {
 try {
  sameOrigin(req);
  const signingKey = secret();
  const id = await visitorIdentity(req,signingKey);
  if (!id) {
   const token = await issueVisitor(signingKey);
   return Response.json({ids:[],mode:'browser'},{headers:{...noStore,'Set-Cookie':visitorCookie(token)}});
  }
  const row = await db().prepare('SELECT data FROM favorites WHERE user_id=?').bind(id).first<{data:string}>();
  return Response.json({ids:row?JSON.parse(row.data):[],mode:'browser'},{headers:noStore});
 } catch(e) {return fail(e)}
}
export async function PUT(req: Request) {
 try {
  sameOrigin(req);
  const id = await visitorIdentity(req,secret());
  if (!id) return fail(new Error('请刷新页面后再收藏'),401);
  const text = await req.text();
  if (text.length > 150000) return fail(new Error('收藏内容过大'),413);
  const {ids} = JSON.parse(text);
  if (!Array.isArray(ids) || ids.length > 2000 || ids.some(x=>typeof x!=='string'||x.length>200)) return fail(new Error('收藏格式无效'),400);
  await db().prepare('INSERT INTO favorites (user_id,data) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data').bind(id,JSON.stringify([...new Set(ids)])).run();
  return Response.json({ok:true},{headers:noStore});
 } catch(e) {return fail(e,400)}
}
