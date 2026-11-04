// Actual API modules, SQLite file, disk media and cookie authentication; no mock identity/storage.
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pairdeer-ecs-api-'));
Object.assign(process.env,{
 DATA_DIR:directory,APP_ORIGIN:'https://test.invalid',NODE_ENV:'test',TRUST_PROXY:'1',
 ADMIN_ENTRY_PASSWORD:'test-only-password-123',ADMIN_SESSION_SECRET:'test-only-session-secret-at-least-32-characters',
});
delete process.env.ALLOW_INSECURE_COOKIES;
const context=vm.createContext({ReadableStream,TextEncoder,TextDecoder,Error,TypeError,RangeError,Request,Response,Headers,File,FormData,URL,URLSearchParams,crypto,console,fetch,Uint8Array,ArrayBuffer,Buffer,process,AbortSignal,setTimeout,clearTimeout});
const modules=new Map();
function synthetic(id,values) {
 const names=Object.keys(values);
 const module=new vm.SyntheticModule(names,function(){for(const key of names)this.setExport(key,values[key])},{context,identifier:id});
 modules.set(id,module);return module;
}
async function load(id) {
 if(modules.has(id))return modules.get(id);
 if(id.startsWith('node:'))return synthetic(id,await import(id));
 if(id.endsWith('.json'))return synthetic(id,{default:JSON.parse(fs.readFileSync(id,'utf8'))});
 const source=ts.transpileModule(fs.readFileSync(id,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 const module=new vm.SourceTextModule(source,{context,identifier:id});modules.set(id,module);
 await module.link((specifier,ref)=>{
  let target=specifier.startsWith('@/')?path.resolve(specifier.slice(2)):specifier.startsWith('.')?path.resolve(path.dirname(ref.identifier),specifier):specifier;
  if(target.startsWith('/')&&!path.extname(target))target+='.ts';
  return load(target);
 });
 return module;
}
async function route(filename){const module=await load(path.resolve(filename));await module.evaluate();return module.namespace;}
const request=(url,method='GET',body,headers={})=>new Request('https://test.invalid'+url,{method,headers:{...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
const cookie=response=>response.headers.get('set-cookie')?.split(';')[0];
try {
 const catalog=await route('app/api/catalog/route.ts');
 const login=await route('app/api/admin-access/route.ts');
 const session=await route('app/api/session/route.ts');
 const favorites=await route('app/api/favorites/route.ts');
 const upload=await route('app/api/upload/route.ts');
 const media=await route('app/api/media/[key]/route.ts');
 const company=await route('app/api/company-materials/[kind]/route.ts');
 const zip=await route('app/api/product-zip/[id]/route.ts');
 const health=await route('app/api/health/route.ts');
 assert.equal((await health.GET()).status,200);
 let snapshot=await (await catalog.GET()).json();
 assert.equal(snapshot.data.products.length,59);
 assert.equal(snapshot.data.companyMaterials.video.url,'/assets/company/company-introduction.mp4');
 assert.equal(snapshot.data.companyMaterials.pdf.url,'/assets/company/company-introduction.pdf');
 const put=(data,revision,cookies,extra={})=>catalog.PUT(request('/api/catalog','PUT',{data,revision},{...(cookies?{cookie:cookies}:{}),...extra}));
 assert.equal((await put(snapshot.data,snapshot.revision)).status,403);
 assert.equal((await put(snapshot.data,snapshot.revision,null,{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@test.invalid'})).status,403);
 assert.equal((await login.POST(request('/api/admin-access','POST',{password:process.env.ADMIN_ENTRY_PASSWORD},{origin:'https://evil.invalid'}))).status,403);
 assert.equal((await login.POST(request('/api/admin-access','POST',{password:'incorrect'},{'x-real-ip':'test-login'}))).status,403);
 const signed=await login.POST(request('/api/admin-access','POST',{password:process.env.ADMIN_ENTRY_PASSWORD},{'x-real-ip':'test-login'}));
 assert.equal(signed.status,200,await signed.clone().text());
 const adminCookie=cookie(signed);
 assert.match(adminCookie,/^__Host-pairdeer_admin=/);
 assert.equal((await (await session.GET(request('/api/session'))).json()).admin,false);
 assert.equal((await (await session.GET(request('/api/session','GET',undefined,{cookie:adminCookie}))).json()).admin,true);
 assert.equal((await put(snapshot.data,snapshot.revision,adminCookie,{origin:'https://evil.invalid'})).status,403);
 for(let index=0;index<5;index++)assert.equal((await login.POST(request('/api/admin-access','POST',{password:'wrong'},{'x-real-ip':'rate-limited'}))).status,403);
 assert.equal((await login.POST(request('/api/admin-access','POST',{password:process.env.ADMIN_ENTRY_PASSWORD},{'x-real-ip':'rate-limited'}))).status,429);
 const initialFavorites=await favorites.GET(request('/api/favorites'));
 const visitorCookie=cookie(initialFavorites);
 assert.deepEqual((await initialFavorites.json()).ids,[]);
 assert.equal((await favorites.PUT(request('/api/favorites','PUT',{ids:['p1']}))).status,401);
 assert.equal((await favorites.PUT(request('/api/favorites','PUT',{ids:['p1']},{cookie:visitorCookie+'x'}))).status,401);
 assert.equal((await favorites.PUT(request('/api/favorites','PUT',{ids:['p1','p1']},{cookie:visitorCookie}))).status,200);
 assert.deepEqual((await (await favorites.GET(request('/api/favorites','GET',undefined,{cookie:visitorCookie}))).json()).ids,['p1']);
 assert.deepEqual((await (await favorites.GET(request('/api/favorites'))).json()).ids,[],'different browser has no access to saved favorites');
 assert.equal((await upload.POST(new Request('https://test.invalid/api/upload',{method:'POST'}))).status,403);
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
 const form=new FormData();form.set('file',new File([bytes],'测试图片.png',{type:'image/png'}));
 const uploaded=await upload.POST(new Request('https://test.invalid/api/upload',{method:'POST',body:form,headers:{cookie:adminCookie}}));
 assert.equal(uploaded.status,200,await uploaded.clone().text());
 const {url}=await uploaded.json();const key=url.split('/').at(-1);
 const getMedia=(headers={})=>media.GET(new Request('https://test.invalid'+url+'?download=1',{headers}),{params:Promise.resolve({key})});
 const downloaded=await getMedia();
 assert.equal(downloaded.status,200);
 assert.equal(downloaded.headers.get('content-type'),'image/png');
 assert.match(downloaded.headers.get('content-disposition'),/%E6%B5%8B%E8%AF%95/);
 assert.equal(Buffer.compare(Buffer.from(await downloaded.arrayBuffer()),bytes),0);
 const partial=await getMedia({range:'bytes=1-5'});
 assert.equal(partial.status,206);assert.equal(Buffer.compare(Buffer.from(await partial.arrayBuffer()),bytes.subarray(1,6)),0);
 const invalid=await getMedia({range:'bytes=999999-'});
 assert.equal(invalid.status,416);assert.equal(invalid.headers.get('content-range'),'bytes */'+bytes.length);

 // Real raw streaming company uploads, filesystem storage and catalog validation.
 const companyRequest=(kind,bytes,name,headers={})=>new Request('https://test.invalid/api/company-materials/'+kind,{
  method:'POST',body:bytes,headers:{cookie:adminCookie,'content-type':kind==='pdf'?'application/pdf':'video/mp4','x-file-name':encodeURIComponent(name),...headers},duplex:'half',
 });
 const companyPost=(kind,req)=>company.POST(req,{params:Promise.resolve({kind})});
 assert.equal((await companyPost('video',new Request('https://test.invalid/api/company-materials/video',{method:'POST'}))).status,403);
 const videoBytes=Buffer.from('000000186674797069736F6D0000020069736F6D6D703432','hex');
 assert.equal((await companyPost('video',companyRequest('video',videoBytes,'公司.mp4',{origin:'https://evil.invalid'}))).status,403);
 assert.equal((await companyPost('video',companyRequest('video',videoBytes,'公司.exe'))).status,400);
 assert.equal((await companyPost('video',companyRequest('video',videoBytes,'公司.mp4',{'content-type':'text/html'}))).status,400);
 assert.equal((await companyPost('video',companyRequest('video',Buffer.from('<html>fake video</html>'),'公司.mp4'))).status,400);
 assert.equal((await companyPost('video',companyRequest('video',videoBytes,'公司.mp4',{'content-length':String(251*1024*1024)}))).status,413);
 const originalRevision=snapshot.revision;
 const companyVideo=await companyPost('video',companyRequest('video',videoBytes,'公司介绍视频.mp4'));
 assert.equal(companyVideo.status,200,await companyVideo.clone().text());
 const videoMaterial=(await companyVideo.json()).material;
 assert.match(videoMaterial.url,/^\/api\/media\/[a-z0-9-]+\.mp4$/);
 const streamedVideo=await media.GET(request(videoMaterial.url+'?download=1'),{params:Promise.resolve({key:videoMaterial.url.split('/').at(-1)})});
 assert.equal(streamedVideo.headers.get('content-length'),String(videoBytes.length));
 assert.deepEqual(Buffer.from(await streamedVideo.arrayBuffer()),videoBytes);
 assert.equal((await (await catalog.GET()).json()).revision,originalRevision,'upload waits for explicit catalog publication');
 const pdfBytes=fs.readFileSync('tests/fixtures/company-preview.pdf');
 assert.equal((await companyPost('ppt',companyRequest('pdf',pdfBytes,'旧版.pptx'))).status,404,'PPTX upload is retired');
 assert.equal((await companyPost('pdf',companyRequest('pdf',pdfBytes,'公司.pptx'))).status,400);
 assert.equal((await companyPost('pdf',companyRequest('pdf',pdfBytes,'公司.pdf',{'content-type':'application/zip'}))).status,400);
 assert.equal((await companyPost('pdf',companyRequest('pdf',Buffer.from('not a PDF'),'公司.pdf'))).status,400);
 assert.equal((await companyPost('pdf',companyRequest('pdf',pdfBytes,'公司.pdf',{'content-length':String(pdfBytes.length+1)}))).status,400,'incomplete raw uploads rejected');
 const companyPdf=await companyPost('pdf',companyRequest('pdf',pdfBytes,'双鹿电池介绍.pdf'));
 assert.equal(companyPdf.status,200,await companyPdf.clone().text());
 const pdfMaterial=(await companyPdf.json()).material;
 assert.match(pdfMaterial.url,/^\/api\/media\/[a-z0-9-]+\.pdf$/);
 assert.equal(pdfMaterial.previewUrl,undefined);
 assert.equal(pdfMaterial.previewPages.length,1,'actual Poppler renders one JPEG page');
 const pageResponse=await media.GET(request(pdfMaterial.previewPages[0]),{params:Promise.resolve({key:pdfMaterial.previewPages[0].split('/').at(-1)})});
 assert.equal(pageResponse.headers.get('content-type'),'image/jpeg');
 assert.deepEqual(Buffer.from(await pageResponse.arrayBuffer()).subarray(0,3),Buffer.from([255,216,255]));
 const pdfDownload=await media.GET(request(pdfMaterial.url+'?download'),{params:Promise.resolve({key:pdfMaterial.url.split('/').at(-1)})});
 assert.equal(pdfDownload.headers.get('content-type'),'application/pdf');
 assert.match(pdfDownload.headers.get('content-disposition'),/attachment/);
 assert.equal(pdfDownload.headers.get('content-length'),String(pdfBytes.length));
 assert.deepEqual(Buffer.from(await pdfDownload.arrayBuffer()),pdfBytes);
 const pdfPreview=await media.GET(request(pdfMaterial.url),{params:Promise.resolve({key:pdfMaterial.url.split('/').at(-1)})});
 assert.equal(pdfPreview.headers.get('content-disposition'),null);
 assert.deepEqual(Buffer.from(await pdfPreview.arrayBuffer()),pdfBytes);
 assert.equal(fs.readdirSync(directory).filter(name=>name.startsWith('.company-upload-')).length,0,'staging is cleaned after success and failure');
 const invalidCompany=structuredClone(snapshot.data);
 invalidCompany.companyMaterials={pdf:{...pdfMaterial,url:'https://external.invalid/deck.pdf'}};
 assert.equal((await put(invalidCompany,snapshot.revision,adminCookie)).status,400,'external company assets rejected');
 invalidCompany.companyMaterials={pdf:{...pdfMaterial,url:'/assets/company/other.pdf'}};
 assert.equal((await put(invalidCompany,snapshot.revision,adminCookie)).status,400,'only known bundled company paths are accepted');
 invalidCompany.companyMaterials={pdf:{...pdfMaterial,previewUrl:'/api/media/another.pdf'}};
 assert.equal((await put(invalidCompany,snapshot.revision,adminCookie)).status,400,'a separate converted preview is not accepted');
 invalidCompany.companyMaterials={pdf:{...pdfMaterial,previewPages:['https://external.invalid/page.jpg']}};
 assert.equal((await put(invalidCompany,snapshot.revision,adminCookie)).status,400,'preview pages must remain on ECS');
 invalidCompany.companyMaterials={pdf:{...pdfMaterial,previewPages:Array(201).fill(pdfMaterial.previewPages[0])}};
 assert.equal((await put(invalidCompany,snapshot.revision,adminCookie)).status,400,'preview page count is bounded');
 const beforeFailure=fs.readdirSync(path.join(directory,'media')).sort();
 assert.equal((await companyPost('pdf',companyRequest('pdf',Buffer.from('%PDF-invalid content'),'broken.pdf'))).status,422);
 process.env.PDFINFO_BIN=path.join(directory,'missing-pdfinfo');
 const missingPoppler=await companyPost('pdf',companyRequest('pdf',pdfBytes,'valid.pdf'));
 assert.equal(missingPoppler.status,503);
 assert.match((await missingPoppler.json()).error,/poppler-utils/);
 delete process.env.PDFINFO_BIN;
 assert.deepEqual(fs.readdirSync(path.join(directory,'media')).sort(),beforeFailure,'failed conversion leaves no stored partial objects');
 assert.equal((await (await catalog.GET()).json()).revision,originalRevision,'uploads and failed validation do not publish replacements');
 // A real existing database with legacy PPTX metadata still reads and saves correctly.
 const {DatabaseSync}=await import('node:sqlite');
 const legacyData=structuredClone(snapshot.data);
 legacyData.companyMaterials={ppt:{url:'/api/media/legacy.pptx',previewUrl:'/api/media/legacy-preview.pdf'},video:videoMaterial};
 const legacyDatabase=new DatabaseSync(path.join(directory,'catalog.sqlite'));
 legacyDatabase.prepare('UPDATE catalog SET data=? WHERE id=1').run(JSON.stringify(legacyData));
 legacyDatabase.close();
 const legacyRead=await (await catalog.GET()).json();
 assert.equal(legacyRead.data.companyMaterials.pdf.url,'/assets/company/company-introduction.pdf');
 assert.equal(legacyRead.data.companyMaterials.video.url,videoMaterial.url);
 assert.equal(legacyRead.data.companyMaterials.ppt,undefined);
 assert.equal(legacyRead.data.companyMaterials.pdf.previewPages.length,38,'bundled PDF uses bundled image previews');
 assert.equal((await put(legacyData,snapshot.revision,adminCookie)).status,200,'saving legacy metadata does not block existing administrators');
 snapshot=await (await catalog.GET()).json();
 assert.equal(snapshot.data.companyMaterials.ppt,undefined);
 snapshot.data.companyMaterials={pdf:pdfMaterial,video:videoMaterial};
 snapshot.data.products[0].name='跨设备更新测试';snapshot.data.products[0].mainImages=[url];snapshot.data.products[0].detailImages=[];snapshot.data.banners=[];
 assert.equal((await put(snapshot.data,snapshot.revision,adminCookie)).status,200);
 assert.equal((await put(snapshot.data,snapshot.revision,adminCookie)).status,409);
 const zipped=await zip.GET(request('/api/product-zip/p1'),{params:Promise.resolve({id:'p1'})});
 assert.equal(zipped.status,200);const zipBytes=Buffer.from(await zipped.arrayBuffer());assert.equal(zipBytes.readUInt32LE(0),0x04034b50);assert.equal(zipBytes.includes(bytes),true);
 const publicRead=await (await catalog.GET()).json();
 assert.deepEqual(publicRead.data.companyMaterials.pdf.previewPages,pdfMaterial.previewPages);
 assert.equal(publicRead.data.companyMaterials.pdf.url,pdfMaterial.url);assert.equal(publicRead.data.companyMaterials.video.url,videoMaterial.url);
 assert.equal(publicRead.data.products[0].name,'跨设备更新测试');assert.equal(publicRead.data.products[0].mainImages[0],url);
 const logout=await login.DELETE(request('/api/admin-access','DELETE',undefined,{cookie:adminCookie}));assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await put(snapshot.data,snapshot.revision,cookie(logout))).status,403);
 console.log('PASS: disk SQLite catalog; password login/logout/session; spoofed identity and cross-origin writes rejected; durable rate limiting; independent signed browser favorites; media upload/download/range/416; ZIP bytes; company PDF/MP4 streaming, exact original bytes, legacy metadata compatibility and publication validation; revision conflict.');
} finally {
 fs.rmSync(directory,{recursive:true,force:true});
}
