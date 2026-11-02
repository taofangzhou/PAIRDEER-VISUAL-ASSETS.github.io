import {bindings,db,sameOrigin,fail} from '@/lib/server';
import {accessCookie,constantEqual,issueAccess} from '@/lib/admin-access';
export const dynamic = 'force-dynamic';
const headers = {'Cache-Control':'no-store'};
export async function POST(req:Request) {
 try {sameOrigin(req)} catch(e) {return fail(e,403)}
 try {
  if(!bindings.ADMIN_ENTRY_PASSWORD || bindings.ADMIN_ENTRY_PASSWORD.length < 12 || !bindings.ADMIN_SESSION_SECRET || bindings.ADMIN_SESSION_SECRET.length < 32) throw new Error('管理员验证暂不可用，请联系网站拥有者');
  // Nginx overwrites X-Real-IP; trust it only when the loopback app is behind that proxy.
  // Without TRUST_PROXY, all clients share one durable limiter instead of trusting spoofed headers.
  const address=bindings.TRUST_PROXY==='1'?(req.headers.get('x-real-ip')||'anonymous'):'anonymous';
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(address));
  const key=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  const window=Math.floor(Date.now()/900000);
  await db().prepare('CREATE TABLE IF NOT EXISTS admin_login_attempts (key TEXT PRIMARY KEY, window INTEGER NOT NULL, attempts INTEGER NOT NULL)').run();
  const row=await db().prepare('INSERT INTO admin_login_attempts (key,window,attempts) VALUES (?,?,1) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window=excluded.window THEN attempts+1 ELSE 1 END, window=excluded.window RETURNING attempts').bind(key,window).first<{attempts:number}>();
  if(!row||row.attempts>5) return Response.json({error:'尝试次数过多，请15分钟后重试'},{status:429,headers:{...headers,'Retry-After':'900'}});
  const body=await req.text();
  if(body.length>512) return fail(new Error('密码格式无效'),400);
  let password:unknown;try{password=JSON.parse(body).password}catch{return fail(new Error('密码格式无效'),400)}
  if(typeof password!=='string'||!(await constantEqual(password,bindings.ADMIN_ENTRY_PASSWORD))) return Response.json({error:'密码不正确，请重新输入'},{status:403,headers:{...headers,'Set-Cookie':accessCookie('')}});
  const token=await issueAccess(bindings.ADMIN_SESSION_SECRET);
  return Response.json({ok:true},{headers:{...headers,'Set-Cookie':accessCookie(token)}});
 }catch(e){return fail(e)}
}
export async function DELETE(req:Request){try{sameOrigin(req);return Response.json({ok:true},{headers:{...headers,'Set-Cookie':accessCookie('')}})}catch(e){return fail(e,403)}}
