import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '@/app/chatgpt-auth';
export const bindings = env as unknown as {DB:D1Database;BUCKET:R2Bucket;ADMIN_SETUP_TOKEN?:string;ADMIN_EMAIL?:string;ALIYUN_SIGNER_URL?:string;ALIYUN_SIGNER_TOKEN?:string;CATALOG_API_URL?:string;CATALOG_API_TOKEN?:string};
export const db = () => {if(!bindings.DB) throw new Error('数据库暂不可用');return bindings.DB};
export async function identity(){const user=await getChatGPTUser(); if(bindings.ADMIN_EMAIL)return {user,admin:!!user&&user.email.toLowerCase()===bindings.ADMIN_EMAIL.toLowerCase(),claimed:true}; const owner=await db().prepare('SELECT user_id FROM admin WHERE id=1').first<{user_id:string}>();return {user,admin:!!user&&owner?.user_id===user.userId,claimed:!!owner};}
export function sameOrigin(req:Request){const origin=req.headers.get('origin');if(origin&&origin!==new URL(req.url).origin)throw new Error('请求来源无效');}
export async function authorize(req:Request){sameOrigin(req);const who=await identity();if(!who.admin)throw new Error('仅管理员可修改资料');return who;}
export const fail=(e:unknown,status=503)=>Response.json({error:e instanceof Error?e.message:'服务暂不可用，请稍后重试'},{status});
export function validUrl(s:unknown){return typeof s==='string'&&(s.startsWith('/assets/')||s.startsWith('/api/media/')||/^https:\/\//.test(s));}

export async function externalCatalog(method:string,payload?:unknown){if(!bindings.CATALOG_API_URL||!bindings.CATALOG_API_TOKEN)throw new Error('阿里云数据库接口未配置完整');const r=await fetch(bindings.CATALOG_API_URL,{method,headers:{'Content-Type':'application/json','Authorization':'Bearer '+bindings.CATALOG_API_TOKEN},...(payload?{body:JSON.stringify(payload)}:{})});const d=await r.json();return Response.json(d,{status:r.status,headers:{'Cache-Control':'no-store'}})}
