import {createRequire} from 'node:module';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {Miniflare}=createRequire(require.resolve('wrangler/package.json'))('miniflare');
const args=process.argv.slice(2);const option=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1]};
const state=resolve(option('--state-dir','.wrangler/state/v3'));const dataDir=resolve(option('--data-dir','data'));
const snapshot=JSON.parse(await readFile(join(dataDir,'catalog.json'),'utf8'));
const objects=JSON.parse(await readFile(join(dataDir,'objects.json'),'utf8'));
// Check every byte before changing the local database.
for(const [key,meta] of Object.entries(objects)){if(!/^[a-zA-Z0-9.-]+$/.test(key))throw Error('Invalid object key');const bytes=await readFile(join(dataDir,'media',key));if(bytes.length!==meta.size||createHash('sha256').update(bytes).digest('hex')!==meta.sha256)throw Error('Asset checksum mismatch: '+key)}
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("Local restore")}}',compatibilityDate:'2026-05-15',d1Databases:{DB:'00000000-0000-4000-8000-000000000000'},r2Buckets:{BUCKET:'site-creator-r2'},d1Persist:join(state,'d1'),r2Persist:join(state,'r2')});
try{
 const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUCKET');
 for(const file of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort()){const sql=await readFile(join('drizzle',file),'utf8');for(const statement of sql.split('--> statement-breakpoint'))if(statement.trim())await db.prepare(statement.replace(/CREATE TABLE /g,'CREATE TABLE IF NOT EXISTS ')).run()}
 const old=await db.prepare('SELECT id FROM catalog WHERE id=1').first();if(old&&!args.includes('--replace'))throw Error('Local catalog already exists. Back it up; --replace explicitly replaces it.');
 for(const [key,meta] of Object.entries(objects))await bucket.put(key,await readFile(join(dataDir,'media',key)),{httpMetadata:{contentType:meta.mime},customMetadata:{name:encodeURIComponent(key)}});
 await db.prepare('INSERT OR REPLACE INTO catalog(id,data,revision) VALUES(1,?,?)').bind(JSON.stringify(snapshot.data??snapshot),snapshot.revision??1).run();
 console.log(`Restored ${(snapshot.data??snapshot).products.length} products and ${Object.keys(objects).length} media objects into ${state}`);
}finally{await mf.dispose()}
