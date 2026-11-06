// Actual catalog, authentication, download routes, ECS SQLite counters and disk originals.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pairdeer-download-operations-'));
const previous={...process.env};
Object.assign(process.env,{DATA_DIR:directory,APP_ORIGIN:'https://stats.invalid',NODE_ENV:'test',ADMIN_ENTRY_PASSWORD:'test-only-password-123',ADMIN_SESSION_SECRET:'test-only-session-secret-at-least-32-characters'});
delete process.env.ALLOW_INSECURE_COOKIES;
let remoteResponse;
const remoteRequests=[];
const context=vm.createContext({ReadableStream,TextEncoder,TextDecoder,Error,TypeError,RangeError,Request,Response,Headers,File,FormData,URL,URLSearchParams,crypto,console,Uint8Array,ArrayBuffer,Buffer,process,AbortSignal,setTimeout,clearTimeout,fetch:async(url,options)=>{remoteRequests.push({url:String(url),options});if(!remoteResponse)throw new Error('Unexpected network access');return remoteResponse;}});
const modules=new Map();
function synthetic(id,values){const module=new vm.SyntheticModule(Object.keys(values),function(){for(const [name,value]of Object.entries(values))this.setExport(name,value)},{context,identifier:id});modules.set(id,module);return module;}
async function load(id){
 if(modules.has(id))return modules.get(id);
 if(id.startsWith('node:'))return synthetic(id,await import(id));
 if(id.endsWith('.json'))return synthetic(id,{default:JSON.parse(fs.readFileSync(id,'utf8'))});
 const module=new vm.SourceTextModule(ts.transpileModule(fs.readFileSync(id,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,{context,identifier:id});modules.set(id,module);
 await module.link((specifier,ref)=>{let target=specifier.startsWith('@/')?path.resolve(specifier.slice(2)):specifier.startsWith('.')?path.resolve(path.dirname(ref.identifier),specifier):specifier;if(target.startsWith('/')&&!path.extname(target))target+='.ts';return load(target)});return module;
}
async function api(file){const module=await load(path.resolve(file));await module.evaluate();return module.namespace;}
const request=(url,method='GET',body,headers={})=>new Request('https://stats.invalid'+url,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
const plain=value=>JSON.parse(JSON.stringify(value));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');

await test('four catalog-original download counters exclude ZIP, previews and failed publication',async()=>{
 let core,runtime;
 try{
  core=await api('lib/operations.ts');runtime=await api('lib/runtime.ts');
  const catalog=await api('app/api/catalog/route.ts');
  const access=await api('lib/admin-access.ts');
  const download=await api('app/api/download/route.ts');
  const zip=await api('app/api/product-zip/[id]/route.ts');
  const media=await api('app/api/media/[key]/route.ts');
  const upload=await api('app/api/upload/route.ts');
  const company=await api('app/api/company-materials/[kind]/route.ts');
  const sources=await api('lib/download-source.ts');
  const adminCookie=access.accessCookie(await access.issueAccess(process.env.ADMIN_SESSION_SECRET)).split(';')[0];
  const expiredCookie=access.accessCookie(await access.issueAccess(process.env.ADMIN_SESSION_SECRET,Date.now()-7200000)).split(';')[0];
  let current=await(await catalog.GET()).json();
  const put=(data,revision,headers={cookie:adminCookie})=>catalog.PUT(request('/api/catalog','PUT',{data,revision},headers));
  const counts=async()=>plain((await core.readOperationsSnapshot()).totals);
  assert.equal((await put(current.data,current.revision)).status,200);
  assert.deepEqual((await counts()).adminMaterials,{added:0,replaced:0},'first save includes effective company defaults without treating them as additions');
  current=await(await catalog.GET()).json();
  const form=new FormData();form.set('file',new File([png],'测试图片.png',{type:'image/png'}));
  const uploaded=await upload.POST(new Request('https://stats.invalid/api/upload',{method:'POST',body:form,headers:{cookie:adminCookie}}));
  assert.equal(uploaded.status,200);const {url:uploadedUrl}=await uploaded.json();
  const videoBytes=Buffer.from('000000186674797069736F6D0000020069736F6D6D703432','hex');
  const companyUpload=await company.POST(new Request('https://stats.invalid/api/company-materials/video',{method:'POST',body:videoBytes,duplex:'half',headers:{cookie:adminCookie,'content-type':'video/mp4','x-file-name':encodeURIComponent('公司介绍.mp4')}}),{params:Promise.resolve({kind:'video'})});
  assert.equal(companyUpload.status,200);const videoMaterial=(await companyUpload.json()).material;
  assert.deepEqual((await counts()).adminMaterials,{added:0,replaced:0},'draft image and original video uploads do not publish material units');
  const changed=structuredClone(current.data),product=changed.products[0];
  product.mainImages[0]=uploadedUrl;product.detailImages.push(uploadedUrl);product.extraImages=[uploadedUrl];product.videos.push(videoMaterial.url);
  changed.companyMaterials.video=videoMaterial;
  assert.equal((await put(changed,current.revision)).status,200);
  assert.deepEqual((await counts()).adminMaterials,{added:3,replaced:2},'main replacement, detail/extra/video additions and one company original replacement');
  assert.equal((await put(changed,current.revision)).status,409);
  assert.equal((await put(changed,current.revision+100)).status,409,'future revisions cannot describe a newer baseline');
  assert.equal((await put(changed,current.revision+1,{cookie:expiredCookie})).status,403);
  const invalid=structuredClone(changed);invalid.products[0].name='';
  assert.equal((await put(invalid,current.revision+1)).status,400);
  assert.deepEqual((await counts()).adminMaterials,{added:3,replaced:2},'conflicts, invalid publication and expired access never add counts');
  current=await(await catalog.GET()).json();
  const previewOnly=structuredClone(current.data);previewOnly.companyMaterials.pdf.previewPages=['/api/media/preview-only.jpg'];
  assert.equal((await put(previewOnly,current.revision)).status,200);
  assert.deepEqual((await counts()).adminMaterials,{added:3,replaced:2},'automatic PDF page references are not original material units');

  const rawKey=uploadedUrl.split('/').at(-1);
  const raw=await media.GET(request(uploadedUrl+'?download=1'),{params:Promise.resolve({key:rawKey})});
  assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),png);
  const rawRange=await media.GET(request(uploadedUrl,'GET',undefined,{range:'bytes=0-3'}),{params:Promise.resolve({key:rawKey})});assert.equal(rawRange.status,206);await rawRange.arrayBuffer();
  assert.equal((await counts()).downloads.total,0,'ordinary media, preview and Range serving have no instrumentation');
  for(const url of ['/api/download','/api/download?url=https://evil.invalid/a.pdf','/api/download?company=ppt','/api/download?company=pdf&product=p1','/api/download?company=pdf&company=video','/api/download?product=p1&section=main&index=-1','/api/download?company=pdf&eventId=invalid'])assert.equal((await download.GET(request(url))).status,400,url);
  for(const url of ['/api/download?product=missing&section=main&index=0','/api/download?product=p1&section=main&index=999'])assert.equal((await download.GET(request(url))).status,404,url);
  assert.equal((await counts()).downloads.total,0);
  const pdfId=randomUUID(),pdfUrl='/api/download?company=pdf&eventId='+pdfId;
  const pdf=await download.GET(request(pdfUrl));assert.equal(pdf.status,302);assert.equal(pdf.headers.get('location'),'/assets/company/company-introduction.pdf');assert.equal(pdf.headers.get('cache-control'),'no-store');assert.equal(pdf.headers.get('set-cookie'),null);
  assert.equal((await download.GET(request(pdfUrl))).status,302);
  assert.equal((await download.GET(request('/api/download?company=video&eventId='+pdfId))).status,302,'replayed IDs remain globally idempotent across targets');
  const video=await download.GET(request('/api/download?company=video&eventId='+randomUUID()));assert.equal(video.status,302);assert.equal(video.headers.get('location'),videoMaterial.url+'?download=1');
  const trackedVideo=await media.GET(request(video.headers.get('location')),{params:Promise.resolve({key:videoMaterial.url.split('/').at(-1)})});assert.deepEqual(Buffer.from(await trackedVideo.arrayBuffer()),videoBytes,'tracking redirects to identical original bytes');
  for(const section of ['main','detail','extra']){
   const index=section==='detail'?changed.products[0].detailImages.length-1:0;
   const image=await download.GET(request(`/api/download?product=p1&section=${section}&index=${index}&eventId=${randomUUID()}`));assert.equal(image.status,302);assert.equal(image.headers.get('location'),uploadedUrl+'?download=1');
  }
  assert.deepEqual((await counts()).downloads,{pdf:1,video:1,image:2,detail:1,total:5});
  for(const headers of [{cookie:adminCookie},{range:'bytes=0-'},{'sec-fetch-dest':'image'},{'sec-fetch-dest':'iframe'},{referer:'https://stats.invalid/?admin=1'}])assert.equal((await download.GET(request('/api/download?company=pdf&eventId='+randomUUID(),'GET',undefined,headers))).status,302);
  assert.equal((await download.HEAD(request('/api/download?company=pdf','HEAD'))).status,302);
  assert.equal((await counts()).downloads.total,5,'HEAD, resumptions, embedded previews and current admin sessions stay excluded');
  assert.equal((await download.GET(request('/api/download?company=pdf&eventId='+randomUUID(),'GET',undefined,{cookie:expiredCookie}))).status,302);
  assert.equal((await counts()).downloads.pdf,2,'an expired admin cookie no longer suppresses public actions');
  // Preflight failures are rejected before counters or redirect headers are issued.
  const missing=structuredClone((await(await catalog.GET()).json()));missing.data.products[0].mainImages[0]='/api/media/missing.png';
  assert.equal((await put(missing.data,missing.revision)).status,200);
  assert.equal((await download.GET(request('/api/download?product=p1&section=main&index=0&eventId='+randomUUID()))).status,404);
  assert.equal((await counts()).downloads.total,6);
  for(const url of ['/api/media/preview-only.jpg','/api/media/preview-only.jpg?cache=1#page','/api/media/%70review-only.jpg?cache=1','/assets/company/pdf-preview/0000000000000000/page-1.jpg?cache=1']){
   const preview=structuredClone((await(await catalog.GET()).json()));preview.data.products[0].mainImages=[url];
   assert.equal((await put(preview.data,preview.revision)).status,200);
   assert.equal((await download.GET(request('/api/download?product=p1&section=main&index=0'))).status,400,'PDF preview paths remain excluded after query/hash/encoding changes');
  }
  const small=structuredClone((await(await catalog.GET()).json()));small.data.products[0].mainImages=[uploadedUrl];small.data.products[0].detailImages=[uploadedUrl];
  assert.equal((await put(small.data,small.revision)).status,200);
  const zipId=randomUUID(),zipUrl='/api/product-zip/p1?eventId='+zipId,zipContext={params:Promise.resolve({id:'p1'})};
  for(let index=0;index<2;index++){const response=await zip.GET(request(zipUrl),zipContext);assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.readUInt32LE(0),0x04034b50);assert.equal(bytes.readUInt16LE(bytes.length-12),2,'ZIP includes both files');}
  assert.deepEqual((await counts()).downloads,{pdf:2,video:1,image:2,detail:1,total:6},'ZIP packing remains available without a ZIP counter or per-file inflation');
  assert.equal((await zip.HEAD(request('/api/product-zip/p1','HEAD'),zipContext)).status,200);
  const rangeZip=await zip.GET(request('/api/product-zip/p1','GET',undefined,{range:'bytes=0-'}),zipContext);assert.equal(rangeZip.status,200);await rangeZip.arrayBuffer();
  assert.deepEqual((await counts()).downloads,{pdf:2,video:1,image:2,detail:1,total:6});
  assert.equal((await counts()).visitors,0,'downloads do not invent browser visitor records');

  process.env.MEDIA_ALLOWED_HOSTS='cdn.example';
  remoteResponse=new Response(null,{status:200,headers:{'content-type':'image/png','content-length':'12'}});
  const remote=await sources.validateDownloadSource('https://cdn.example/original.png','image');assert.equal(remote.location,'https://cdn.example/original.png');
  assert.equal(remoteRequests.at(-1).options.method,'HEAD');assert.equal(remoteRequests.at(-1).options.redirect,'error');
  const requestCount=remoteRequests.length;
  for(const url of ['https://evil.invalid/a.png','http://cdn.example/a.png','https://user:pass@cdn.example/a.png'])await assert.rejects(sources.validateDownloadSource(url,'image'),/域名/);
  assert.equal(remoteRequests.length,requestCount,'unapproved source addresses never trigger HTTP');
  remoteResponse=new Response(null,{status:404});await assert.rejects(sources.validateDownloadSource('https://cdn.example/original.png','image'),/不存在/);
  remoteResponse=new Response(null,{status:200,headers:{'content-type':'text/html'}});await assert.rejects(sources.validateDownloadSource('https://cdn.example/original.png','image'),/类型/);
 }finally{
  await core?.closeOperationsDatabase();
  (await runtime?.getDatabase())?.close();
  fs.rmSync(directory,{recursive:true,force:true});
  for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
 }
});
