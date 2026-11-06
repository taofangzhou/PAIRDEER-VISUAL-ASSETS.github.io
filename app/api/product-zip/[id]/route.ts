import {GET as getCatalog} from '@/app/api/catalog/route';
import {bindings,fail} from '@/lib/server';
import {downloadUrl} from '@/lib/downloads';
import {recordDownload} from '@/lib/operations';
import {DownloadSourceError,downloadEventId,shouldRecordDownload,validateDownloadSource} from '@/lib/download-source';
import {zipStream,type ZipEntry} from '@/lib/zip-stream';
import {createReadStream} from 'node:fs';
import {stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
export const dynamic = 'force-dynamic';

async function openImage(original: string): Promise<ReadableStream<Uint8Array>> {
 if (original.startsWith('/api/media/')) {
  const key = original.slice('/api/media/'.length);
  if (!/^[a-z0-9-]+\.(png|jpg|webp|gif)$/.test(key)) throw new Error('图片地址无效');
  const object = await bindings.BUCKET.get(key);
  if (!object) throw new Error('图片不存在');
  return object.body;
 }
 const bundledRoot = original.startsWith('/assets/') ? 'assets' : original.startsWith('/downloads/') ? 'downloads' : null;
 if (bundledRoot) {
  // Read bundled files locally. Never derive an internal fetch target from Host.
  // Keep each URL prefix inside its own directory, including after symlink resolution.
  const base = await realpath(path.resolve('public', bundledRoot));
  const filename = await realpath(path.resolve('public', '.' + decodeURIComponent(original)));
  if (!filename.startsWith(base + path.sep) || !(await stat(filename)).isFile()) throw new Error('图片地址无效');
  return Readable.toWeb(createReadStream(filename)) as ReadableStream<Uint8Array>;
 }
 const url = new URL(original);
 const allowed = (process.env.MEDIA_ALLOWED_HOSTS || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
 if (url.protocol !== 'https:' || url.username || url.password || !allowed.includes(url.host.toLowerCase())) throw new Error('外部素材域名尚未配置下载权限');
 // Do not follow redirects to unapproved/internal addresses.
 const result = await fetch(url, {redirect:'error',signal:AbortSignal.timeout(30000)});
 if (!result.ok || !result.body) throw new Error('图片读取失败');
 return result.body;
}

async function downloadZip(req:Request,{params}:{params:Promise<{id:string}>}) {
 try {
  const eventId=downloadEventId(req);
  const {id}=await params;
  const result=await getCatalog();
  if(!result.ok)return result;
  const {data}=await result.json();
  const product=data.products.find((p:{id:string})=>p.id===id);
  if(!product)return new Response('Not found',{status:404});
  const entries:ZipEntry[]=[];
  for(const [folder,urls] of [['主图',product.mainImages],['详情页',product.detailImages]] as [string,string[]][]) {
   for(const [index,url] of urls.entries()) {
    const original=downloadUrl(url);
    const ext=new URL(original,'https://local.invalid').pathname.match(/\.(jpe?g|png|webp|gif)$/i)?.[1]?.toLowerCase();
    if(!ext)throw new Error('无法识别图片格式');
    await validateDownloadSource(original,'image');
    entries.push({name:`${folder}/${String(index+1).padStart(2,'0')}.${ext}`,open:()=>openImage(original)});
   }
  }
  if(!entries.length)return new Response('No images',{status:404});
  const name=product.name.replace(/[\\/:*?"<>|\r\n]/g,'_').slice(0,100)+'-主图详情页.zip';
  const response=new Response(req.method==='HEAD'?null:zipStream(entries),{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="product.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  if(shouldRecordDownload(req))await recordDownload(req,{kind:'zip',eventId}).catch(()=>{});
  return response;
 } catch(e) {return fail(e,e instanceof DownloadSourceError?e.status:500)}
}

export const GET=downloadZip;
export const HEAD=downloadZip;
