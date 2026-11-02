import {applyCatalogImport} from '@/lib/catalog-import';
import seed from '@/lib/seed.json';
import {db,authorize,fail,validUrl,bindings,externalCatalog} from '@/lib/server';
export const dynamic = 'force-dynamic';
export async function GET(){try{
 if(bindings.CATALOG_API_URL)return await externalCatalog('GET');
 await db().prepare('INSERT OR IGNORE INTO catalog (id,data,revision) VALUES (1,?,1)').bind(JSON.stringify(seed)).run();
 for(let attempt=0;attempt<5;attempt++){
  const row=await db().prepare('SELECT data,revision FROM catalog WHERE id=1').first<{data:string;revision:number}>();
  if(!row)throw new Error('资料库读取失败');
  const current=JSON.parse(row.data),next=applyCatalogImport(current);
  if(next===current)return Response.json({data:current,revision:row.revision},{headers:{'Cache-Control':'no-store'}});
  const result=await db().prepare('UPDATE catalog SET data=?,revision=revision+1 WHERE id=1 AND revision=?').bind(JSON.stringify(next),row.revision).run();
  if(result.meta.changes)return Response.json({data:next,revision:row.revision+1},{headers:{'Cache-Control':'no-store'}});
 }
 throw new Error('资料正在更新，请稍后重试');
}catch(e){return fail(e)}}
export async function PUT(req:Request){try{await authorize(req)}catch(e){return fail(e,403)}try{if(Number(req.headers.get('content-length'))>2000000)return fail(new Error('资料过大'),413);const text=await req.text();if(text.length>2000000)return fail(new Error('资料过大'),413);const {data,revision}=JSON.parse(text) as any;if(!Number.isInteger(revision)||revision<1)throw new Error('资料版本无效');if(!data||!Array.isArray(data.products)||data.products.length>2000||!Array.isArray(data.banners)||data.banners.length>12)throw new Error('资料格式无效');if(data.copy!==undefined&&(!data.copy||typeof data.copy!=='object'||Array.isArray(data.copy)||Object.keys(data.copy).length>1000||Object.values(data.copy).some(v=>typeof v!=='string'||v.length>20000)))throw new Error('页面文字格式无效');const ids=new Set();for(const p of data.products){if(!p.id||ids.has(p.id)||typeof p.name!=='string'||!p.name.trim()||!Array.isArray(p.mainImages)||p.mainImages.length<1||p.mainImages.length>9||!Array.isArray(p.detailImages)||!Array.isArray(p.videos)||!Array.isArray(p.regions)||!Array.isArray(p.channels))throw new Error('产品信息不完整，主图需要1至9张');if(p.onlineTitle!==undefined&&(typeof p.onlineTitle!=='string'||p.onlineTitle.length>2000))throw new Error('副标题格式无效');ids.add(p.id);if(p.extraImages!==undefined&&(!Array.isArray(p.extraImages)||p.extraImages.length>100))throw new Error('补充素材格式无效');for(const u of [...p.mainImages,...p.detailImages,...(p.extraImages||[]),...p.videos])if(!validUrl(u))throw new Error('素材地址无效');}for(const b of data.banners)if(!validUrl(b.image))throw new Error('轮播地址无效');if(!bindings.CATALOG_API_URL){const existing=await db().prepare('SELECT data FROM catalog WHERE id=1').first<{data:string}>();data._imports=existing?JSON.parse(existing.data)._imports||[]:[];}const payload=JSON.stringify(data);if(payload.length>2000000)throw new Error('资料过大');if(bindings.CATALOG_API_URL)return await externalCatalog('PUT',{data,revision});const r=await db().prepare('UPDATE catalog SET data=?,revision=revision+1 WHERE id=1 AND revision=?').bind(payload,revision).run();if(!r.meta.changes)return fail(new Error('资料已在另一窗口更新，请重新载入后编辑'),409);return Response.json({ok:true,revision:revision+1});}catch(e){return fail(e,400)}}
