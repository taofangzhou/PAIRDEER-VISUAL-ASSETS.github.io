import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const release=path.resolve(process.argv[2]);
const temporary=await mkdtemp(path.join(tmpdir(),'pairdeer-production-'));
const origin='http://localhost:3311';
const secret='test-only-session-secret-at-least-32-characters';
const password='test-only-password-12345';
const env={...process.env,NODE_ENV:'production',HOSTNAME:'127.0.0.1',PORT:'3311',DATA_DIR:path.join(temporary,'data'),APP_ORIGIN:origin,ADMIN_ENTRY_PASSWORD:password,ADMIN_SESSION_SECRET:secret,NEXT_TELEMETRY_DISABLED:'1'};
let logs='',browserLogs='';
const app=spawn(process.execPath,['server.js'],{cwd:release,env,stdio:['ignore','pipe','pipe']});
app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x);
let browser,ws;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){for(let n=0;n<150;n++){try{const value=await check();if(value)return value}catch{}await delay(100)}throw Error('Timed out: '+label)}
try{
 await until(async()=> (await fetch(origin+'/api/health')).ok,'production health');
 const guest=await (await fetch(origin+'/api/session',{headers:{'oai-authenticated-user-id':'forged','oai-authenticated-user-email':'owner@example.com'}})).json();assert.equal(guest.admin,false);
 const catalog=await (await fetch(origin+'/api/catalog')).json();assert.equal(catalog.data.products.length,59);
 assert.equal((await fetch(origin+'/api/catalog',{method:'PUT',headers:{origin,'content-type':'application/json'},body:JSON.stringify(catalog)})).status,403);
 browser=spawn(process.env.CHROMIUM_PATH || '/usr/bin/chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(temporary,'chromium'),'about:blank'],{stdio:['ignore','pipe','pipe']});
 browser.stdout.on('data',x=>browserLogs+=x);browser.stderr.on('data',x=>browserLogs+=x);
 const debuggerPort=await until(async()=>Number((await readFile(path.join(temporary,'chromium','DevToolsActivePort'),'utf8')).split('\n')[0]),'Chromium debugger');
 const targets=await (await fetch('http://localhost:'+debuggerPort+'/json/list')).json();
 const page=targets.find(t=>t.type==='page');
 ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
 let nextId=1;const pending=new Map();const requests=[];const exceptions=[];
 ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const p=pending.get(data.id);if(p){pending.delete(data.id);data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result)}}else if(data.method==='Network.requestWillBeSent')requests.push(data.params.request.url);else if(data.method==='Runtime.exceptionThrown')exceptions.push(data.params.exceptionDetails)});
 function call(method,params={}){return new Promise((resolve,reject)=>{const id=nextId++;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
 async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
 await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
 await call('Page.navigate',{url:origin+'/?admin=1'});
 await until(()=>evaluate('!!document.querySelector("#admin-entry-password")'),'administrator login form');
 await evaluate(`(()=>{const input=document.querySelector('#admin-entry-password');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(password)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
 await delay(150);
 await evaluate('document.querySelector(".admin-password-form").requestSubmit()');
 await until(()=>evaluate('!!document.querySelector(".admin-status")'),'administrator workspace');
 assert.equal((await evaluate('fetch("/api/session").then(r=>r.json())')).admin,true);
 // A failed logout must keep the workspace visible and report failure.
 await evaluate(`window.__realFetch=window.fetch;window.fetch=(url,init)=>url==='/api/admin-access'&&init?.method==='DELETE'?Promise.reject(new Error('test logout failure')):window.__realFetch(url,init);document.querySelector('.admin-lock-bar button').click()`);
 await delay(200);assert.equal(await evaluate('!!document.querySelector(".admin-status")'),true);
 await evaluate(`window.fetch=window.__realFetch;document.querySelector('.admin-lock-bar button').click()`);
 await until(()=>evaluate('!!document.querySelector("#admin-entry-password")'),'successful administrator logout');
 assert.equal((await evaluate('fetch("/api/session").then(r=>r.json())')).admin,false);
 await call('Page.navigate',{url:origin+'/'});
 await until(()=>evaluate('!!document.querySelector(".product-card .heart")'),'product cards');
 await evaluate('document.querySelector(".product-card .heart").click()');
 await until(async()=> (await evaluate('fetch("/api/favorites").then(r=>r.json())')).ids?.length===1,'favorite save');
 await call('Page.reload');
 await until(()=>evaluate('!!document.querySelector(".product-card .heart.saved")'),'favorite after reload');
 const scripts=await evaluate('[...document.scripts].filter(s=>s.src).map(s=>s.src)');assert.ok(scripts.length>0);
 assert.equal(requests.some(u=>/^https?:/.test(u)&&!u.startsWith(origin+'/')),false,JSON.stringify(requests.filter(u=>!u.startsWith(origin+'/'))));
 assert.deepEqual(exceptions,[]);
 const login=await fetch(origin+'/api/admin-access',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({password})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=','base64');
 const form=new FormData();form.set('file',new File([bytes],'生产测试.png',{type:'image/png'}));
 const upload=await fetch(origin+'/api/upload',{method:'POST',headers:{cookie,origin},body:form});assert.equal(upload.status,200,await upload.clone().text());const {url}=await upload.json();
 const file=await fetch(origin+url+'?download=1');assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);assert.match(file.headers.get('content-disposition'),/%E7/);
 const range=await fetch(origin+url,{headers:{range:'bytes=0-7'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,8);
 assert.equal((await fetch(origin+url,{headers:{range:'bytes=999999-'}})).status,416);
 catalog.data.products[0].mainImages=[url];catalog.data.products[0].detailImages=[];
 const save=await fetch(origin+'/api/catalog',{method:'PUT',headers:{origin,cookie,'content-type':'application/json'},body:JSON.stringify(catalog)});assert.equal(save.status,200,await save.clone().text());
 const zip=await fetch(origin+'/api/product-zip/'+catalog.data.products[0].id);assert.equal(zip.status,200);const zipBytes=Buffer.from(await zip.arrayBuffer());assert.equal(zipBytes.readUInt32LE(),0x04034b50);assert.ok(zipBytes.includes(bytes));
 console.log('PASS: packaged production Next server + Chromium: homepage assets, password login/workspace/logout including failed logout, browser favorites after reload, no external platform requests or browser exceptions; real HTTP API upload/download/ranges/ZIP and guest write denial.');
}catch(error){console.error(logs);console.error(browserLogs.slice(-1500));throw error}
finally{ws?.close();browser?.kill('SIGTERM');app.kill('SIGTERM');await delay(300);await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
