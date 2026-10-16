// Server-only password sessions. No password or signing secret belongs in source.
export const ADMIN_COOKIE = '__Host-pairdeer_admin';
export const SESSION_SECONDS = 3600;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export async function constantEqual(a: string, b: string) {
 const [x,y] = await Promise.all([a,b].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
 const u = new Uint8Array(x), v = new Uint8Array(y); let diff = 0;
 for (let i=0;i<u.length;i++) diff |= u[i]^v[i];
 return diff === 0;
}
async function signature(payload: string, secret: string) {
 const key = await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return hex(await crypto.subtle.sign('HMAC',key,encoder.encode(payload)));
}
export async function issueAccess(secret: string, now = Date.now()) {
 const payload = `${Math.floor(now/1000)+SESSION_SECONDS}.${crypto.randomUUID()}`;
 return `${payload}.${await signature(payload,secret)}`;
}
export async function validAccess(req: Request, secret?: string, now = Date.now()) {
 if(!secret) return false;
 const token = req.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(ADMIN_COOKIE+'='))?.slice(ADMIN_COOKIE.length+1);
 if(!token || token.length>200) return false;
 const parts=token.split('.'); if(parts.length!==3) return false;
 const expires=Number(parts[0]);
 if(!Number.isInteger(expires)||expires<=Math.floor(now/1000)||expires>Math.floor(now/1000)+SESSION_SECONDS) return false;
 return constantEqual(parts[2],await signature(parts.slice(0,2).join('.'),secret));
}
export function accessCookie(token: string) {
 return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${token?'':'; Max-Age=0'}`;
}
