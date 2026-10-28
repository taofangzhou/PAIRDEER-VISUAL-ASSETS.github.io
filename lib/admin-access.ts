// Independent, server-only ECS sessions. Never trust identity supplied in headers.
export const ADMIN_COOKIE = '__Host-pairdeer_admin';
export const SESSION_SECONDS = 3600;
const VISITOR_SECONDS = 365 * 86400;
const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
export function secureCookies() {
 return !(process.env.ALLOW_INSECURE_COOKIES === '1' && process.env.NODE_ENV !== 'production');
}
function cookieName(kind: 'admin' | 'visitor') {
 return `${secureCookies() ? '__Host-' : ''}pairdeer_${kind}`;
}
function readCookie(req: Request, name: string) {
 return req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
}
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
 return `${payload}.${await signature('admin:' + payload,secret)}`;
}
export async function validAccess(req: Request, secret?: string, now = Date.now()) {
 if(!secret) return false;
 const token = readCookie(req, cookieName('admin'));
 if(!token || token.length>200) return false;
 const parts=token.split('.'); if(parts.length!==3) return false;
 const expires=Number(parts[0]);
 if(!Number.isInteger(expires)||expires<=Math.floor(now/1000)||expires>Math.floor(now/1000)+SESSION_SECONDS) return false;
 return constantEqual(parts[2],await signature('admin:' + parts.slice(0,2).join('.'),secret));
}
export function accessCookie(token: string) {
 return `${cookieName('admin')}=${token}; Path=/; HttpOnly;${secureCookies()?' Secure;':''} SameSite=Strict; Max-Age=${token ? SESSION_SECONDS : 0}`;
}
export async function issueVisitor(secret: string, now = Date.now()) {
 const id = crypto.randomUUID();
 const payload = `${Math.floor(now/1000)+VISITOR_SECONDS}.${id}`;
 return `${payload}.${await signature('visitor:' + payload,secret)}`;
}
export async function visitorIdentity(req: Request, secret?: string, now = Date.now()) {
 if (!secret || secret.length < 32) return null;
 const token = readCookie(req, cookieName('visitor'));
 if (!token || token.length > 200) return null;
 const parts = token.split('.');
 if (parts.length !== 3 || !/^[a-f0-9-]{36}$/.test(parts[1])) return null;
 const expires = Number(parts[0]);
 if (!Number.isInteger(expires) || expires <= Math.floor(now/1000) || expires > Math.floor(now/1000)+VISITOR_SECONDS) return null;
 if (!await constantEqual(parts[2], await signature('visitor:' + parts.slice(0,2).join('.'), secret))) return null;
 return 'visitor:' + parts[1];
}
export function visitorCookie(token: string) {
 return `${cookieName('visitor')}=${token}; Path=/; HttpOnly;${secureCookies()?' Secure;':''} SameSite=Lax; Max-Age=${VISITOR_SECONDS}`;
}
