import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pairdeer-operations-'));
const previous={...process.env};
let now=Date.parse('2026-10-31T15:59:00.000Z');
class ClockDate extends Date { constructor(...args){super(...(args.length?args:[now]));} static now(){return now;} }
Object.assign(process.env,{DATA_DIR:directory,APP_ORIGIN:'https://stats.invalid',NODE_ENV:'test',ADMIN_ENTRY_PASSWORD:'test-only-password-123',ADMIN_SESSION_SECRET:'test-only-session-secret-at-least-32-characters'});
delete process.env.ALLOW_INSECURE_COOKIES;
const context=vm.createContext({Date:ClockDate,ReadableStream,TextEncoder,TextDecoder,Request,Response,Headers,File,FormData,URL,URLSearchParams,crypto,console,fetch,Uint8Array,ArrayBuffer,Buffer,process,AbortSignal,setTimeout,clearTimeout});
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
const event=(type='pageview',extra={})=>({id:randomUUID(),type,page:'home',...extra});
const plain=value=>JSON.parse(JSON.stringify(value));

await test('ECS aggregate operations: authentication, China dates, replay, privacy, persistence and publication diffs',async()=>{
 let core;
 try{
  core=await api('lib/operations.ts');
  const publicApi=await api('app/api/analytics/route.ts');
  const privateApi=await api('app/api/admin/operations/route.ts');
  const access=await api('lib/admin-access.ts');
  assert.equal(fs.existsSync(path.join(directory,'operations.sqlite')),false,'importing routes performs no writes');
  for(const suffix of ['','?format=csv','?format=xlsx']){
   const forbidden=await privateApi.GET(request('/api/admin/operations'+suffix));assert.equal(forbidden.status,403);assert.equal(forbidden.headers.get('cache-control'),'no-store');
  }
  assert.equal(fs.existsSync(path.join(directory,'operations.sqlite')),false,'anonymous statistics reads do not open storage');
  const firstEvent=event();
  const first=await publicApi.POST(request('/api/analytics','POST',firstEvent));
  assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
  const cookie=first.headers.get('set-cookie').split(';')[0];assert.match(cookie,/^__Host-pairdeer_ops=/);
  const signedCookieHeader=first.headers.get('set-cookie');assert.match(signedCookieHeader,/HttpOnly/);assert.match(signedCookieHeader,/Secure/);
  assert.equal((await publicApi.POST(request('/api/analytics','POST',firstEvent))).status,200,'missing-cookie retry remains idempotent');
  let snapshot=await core.readOperationsSnapshot(now);
  assert.equal(snapshot.totals.visitors,1);assert.equal(snapshot.currentMonth.pageViews,1);
  assert.deepEqual(plain(snapshot.monthly),[{month:'2026-10',pageViews:1}]);
  now=Date.parse('2026-10-31T16:01:00.000Z');
  await publicApi.POST(request('/api/analytics','POST',event(),{cookie}));
  const search=event('search',{query:'私密客户张某 phone13800000000 5号 LR6 AA CR2016',source:'text'});
  await publicApi.POST(request('/api/analytics','POST',search,{cookie}));
  await publicApi.POST(request('/api/analytics','POST',search,{cookie}));
  await publicApi.POST(request('/api/analytics','POST',event('search',{query:'完全没有规范型号的内部文字',source:'text'}),{cookie}));
  await publicApi.POST(request('/api/analytics','POST',event('search',{source:'image'}),{cookie}));
  assert.equal((await publicApi.POST(request('/api/analytics','POST',event('search',{source:'image',query:'不应发送图片搜索词'}),{cookie}))).status,400);
  assert.equal((await publicApi.POST(request('/api/analytics','POST',event(),{cookie,origin:'https://evil.invalid'}))).status,403);
  assert.equal((await publicApi.POST(request('/api/analytics','POST',{...event(),page:'admin'},{cookie}))).status,400);
  assert.equal((await publicApi.POST(request('/api/analytics','POST',{...event(),visitorId:'raw-browser-id'},{cookie}))).status,400);
  assert.equal((await publicApi.POST(request('/api/analytics','POST',{...event(),query:'x'.repeat(5000)},{cookie}))).status,413);
  const adminToken=await access.issueAccess(process.env.ADMIN_SESSION_SECRET,now);
  const adminCookie=access.accessCookie(adminToken).split(';')[0];
  assert.equal((await publicApi.POST(request('/api/analytics','POST',event(),{cookie:adminCookie}))).status,200);
  assert.equal((await publicApi.POST(request('/api/analytics','POST',event(),{cookie,referer:'https://stats.invalid/?admin=1'}))).status,200);
  const downloadId=randomUUID();
  await core.recordDownload(request('/api/download?company=pdf','GET',undefined,{cookie}),{kind:'pdf',eventId:downloadId});
  await core.recordDownload(request('/api/download?company=pdf','GET',undefined,{cookie}),{kind:'pdf',eventId:downloadId});
  for(const kind of ['video','image','detail','zip'])await core.recordDownload(request('/api/download','GET',undefined,{cookie}),{kind,eventId:randomUUID()});
  await core.recordDownload(request('/api/download','GET',undefined,{cookie:adminCookie}),{kind:'pdf'});
  await core.recordDownload(request('/api/download','HEAD',undefined,{cookie}),{kind:'pdf'});
  await core.recordDownload(request('/api/download','GET',undefined,{cookie,range:'bytes=0-10'}),{kind:'pdf'});
  snapshot=await core.readOperationsSnapshot(now);
  assert.equal(snapshot.totals.visitors,1);assert.equal(snapshot.totals.searches,3);
  assert.equal('pageViews' in snapshot.totals,false);assert.equal('daily' in snapshot,false);assert.equal('range' in snapshot,false);
  assert.deepEqual(plain(snapshot.totals.downloads),{pdf:1,video:1,image:1,detail:1,total:4});
  assert.deepEqual(plain(snapshot.hotModels),[{model:'5号 / AA',count:1},{model:'CR2016',count:1}]);
  assert.equal(snapshot.currentMonth.month,'2026-11');assert.equal(snapshot.currentMonth.pageViews,1);
  assert.equal(snapshot.monthly.length,2);assert.equal(snapshot.monthly[0].pageViews,1);assert.equal(snapshot.monthly[1].pageViews,1);
  now=Date.parse('2026-11-02T01:00:00Z');await publicApi.POST(request('/api/analytics','POST',event(),{cookie}));
  snapshot=await core.readOperationsSnapshot(now);
  assert.deepEqual(plain(snapshot.monthly),[{month:'2026-10',pageViews:1},{month:'2026-11',pageViews:2}]);
  assert.equal(snapshot.currentMonth.pageViews,2,'current month retains full natural-month total');
  const baseline={products:[{id:'a',mainImages:['/a.jpg','/b.jpg'],detailImages:['/detail.jpg'],videos:[]}],banners:[{id:'b',image:'/banner.jpg'}]};
  const after=structuredClone(baseline);after.products[0].mainImages=['/b.jpg','/new.jpg','/extra.jpg'];after.products[0].videos=['/video.mp4'];
  after.companyMaterials={pdf:{url:'/api/media/new.pdf',name:'New.pdf',size:100,updatedAt:new Date(now).toISOString(),previewPages:['/api/media/preview.jpg']}};
  assert.deepEqual(plain(core.countAdminMaterialChanges(baseline,after)),{added:2,replaced:2});
  const reordered=structuredClone(baseline);reordered.products[0].mainImages.reverse();reordered.companyMaterials={...after.companyMaterials};
  assert.deepEqual(plain(core.countAdminMaterialChanges(baseline,{...baseline,companyMaterials:(await api('lib/company-materials.ts')).defaultCompanyMaterials})),{added:0,replaced:0},'persisting bundled defaults is not an upload');
  const previewOnly=structuredClone(after);previewOnly.companyMaterials.pdf.previewPages=['/api/media/other.jpg'];
  assert.deepEqual(plain(core.countAdminMaterialChanges(after,previewOnly)),{added:0,replaced:0});
  await core.recordAdminPublication(baseline,after);
  await core.recordAdminPublication(after,previewOnly);
  const adminStats=await privateApi.GET(request('/api/admin/operations','GET',undefined,{cookie:adminCookie}));
  // Reissue the one-hour session at the later simulated date.
  const freshAdmin=access.accessCookie(await access.issueAccess(process.env.ADMIN_SESSION_SECRET,now)).split(';')[0];
  const protectedStats=await privateApi.GET(request('/api/admin/operations','GET',undefined,{cookie:freshAdmin}));
  assert.equal(protectedStats.status,200);assert.equal(protectedStats.headers.get('cache-control'),'no-store');
  const adminData=await protectedStats.json();assert.deepEqual(adminData.totals.adminMaterials,{added:2,replaced:2});
  assert.equal(adminStats.status,403,'expired administrator session cannot read aggregate reports');
  for(const suffix of ['?format=csv','?format=xlsx','?from=2026-01-01']){
   const response=await privateApi.GET(request('/api/admin/operations'+suffix,'GET',undefined,{cookie:freshAdmin}));
   assert.equal(response.status,400,'minimal reports reject dates and exports');assert.equal(response.headers.get('cache-control'),'no-store');
  }
  const {connection}=await core.getOperationsDatabase();
  const tables=connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
  assert.deepEqual(tables,['aggregates','event_dedup','hot_models','metadata','monthly','visitors']);
  assert.deepEqual(connection.prepare('PRAGMA table_info(visitors)').all().map(row=>row.name),['hash']);
  assert.deepEqual(connection.prepare('PRAGMA table_info(event_dedup)').all().map(row=>row.name),['id','recorded_at']);
  const stored=JSON.stringify(tables.filter(name=>name!=='metadata').map(name=>connection.prepare('SELECT * FROM '+name).all()));
  for(const forbidden of ['张某','13800000000','私密客户','完全没有','/api/download','raw-browser-id',cookie])assert.equal(stored.includes(forbidden),false,'no raw visitor content is persisted');
  const visitorRow=connection.prepare('SELECT * FROM visitors').get();assert.equal(visitorRow.hash.length,32);
  assert.match(connection.prepare("SELECT sql FROM sqlite_master WHERE name='visitors'").get().sql,/WITHOUT ROWID/);
  const beforeBackup=await core.readOperationsSnapshot(now);
  await core.closeOperationsDatabase();
  const backupDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'pairdeer-operations-backup-'));
  fs.cpSync(directory,backupDirectory,{recursive:true});
  process.env.DATA_DIR=backupDirectory;
  const restored=await core.readOperationsSnapshot(now);assert.deepEqual(plain(restored),plain(beforeBackup));
  process.env.ADMIN_SESSION_SECRET='rotated-admin-secret-for-independent-analytics-key';
  await core.recordPublicAnalytics(request('/api/analytics','POST',undefined,{cookie}),event(),now);
  assert.equal((await core.readOperationsSnapshot(now)).totals.visitors,1,'anonymous cookie survives administrator-secret rotation and backup restore');
  await core.closeOperationsDatabase();fs.rmSync(backupDirectory,{recursive:true,force:true});process.env.DATA_DIR=directory;
  assert.deepEqual(plain(core.extractCanonicalModels('AA AAA AAAA LR1 N D C CR2016 CR2016 phone13800000000')),['5号 / AA','7号 / AAA','1号 / D','2号 / C','LR1 / N','9号','CR2016']);
  const capped=(await publicApi.POST(request('/api/analytics','POST',event()))).headers.get('set-cookie').split(';')[0];
  for(let index=0;index<179;index++)assert.equal((await publicApi.POST(request('/api/analytics','POST',event(),{cookie:capped}))).status,200);
  assert.equal((await publicApi.POST(request('/api/analytics','POST',event(),{cookie:capped}))).status,429,'signed anonymous browser has a bounded event rate');
  const declaredSmall=new Request('https://stats.invalid/api/analytics',{method:'POST',headers:{'content-type':'application/json'},body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(5000)));controller.close()}}),duplex:'half'});
  assert.equal((await publicApi.POST(declaredSmall)).status,413,'streamed JSON limit is enforced without content-length');
  now+=2*86400_000;
  await core.recordPublicAnalytics(request('/api/analytics','POST',undefined,{cookie}),event(),now);
  const database=await core.getOperationsDatabase();
  assert.equal(database.connection.prepare('SELECT COUNT(*) AS count FROM event_dedup').get().count,1,'retry keys expire after 24 hours');
 }finally{
  if(core)await core.closeOperationsDatabase();
  fs.rmSync(directory,{recursive:true,force:true});
  for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
 }
});
