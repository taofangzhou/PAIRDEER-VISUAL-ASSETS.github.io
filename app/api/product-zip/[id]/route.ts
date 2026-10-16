import {GET as getCatalog} from '@/app/api/catalog/route';
import {bindings,fail} from '@/lib/server';
import {downloadUrl} from '@/lib/downloads';
import {zipStream,ZipEntry} from '@/lib/zip-stream';
export async function GET(req:Request,{params}:{params:Promise<{id:string}>}){try{
 const {id}=await params;const result=await getCatalog();if(!result.ok)return result;const {data}=await result.json() as any;const p=data.products.find((p:any)=>p.id===id);if(!p)return new Response('Not found',{status:404});const entries:ZipEntry[]=[];
 for(const [folder,urls] of [['主图',p.mainImages],['详情页',p.detailImages]] as [string,string[]][]){for(const [i,url] of urls.entries()){
 const original=downloadUrl(url);const ext=new URL(original,req.url).pathname.match(/\.(jpe?g|png|webp|gif)$/i)?.[1]?.toLowerCase();if(!ext)throw Error('无法识别图片格式');
 entries.push({name:`${folder}/${String(i+1).padStart(2,'0')}.${ext}`,open:async()=>{if(original.startsWith('/api/media/')){const object=await bindings.BUCKET.get(original.split('/').at(-1)!);if(!object)throw Error('图片不存在');return object.body}const r=await fetch(new URL(original,req.url));if(!r.ok||!r.body)throw Error('图片读取失败');return r.body}});
 }}
 if(!entries.length)return new Response('No images',{status:404});const name=p.name.replace(/[\\/:*?"<>|\r\n]/g,'_').slice(0,100)+'-主图详情页.zip';return new Response(zipStream(entries),{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="product.zip"; filename*=UTF-8''${encodeURIComponent(name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}catch(e){return fail(e,500)}}
