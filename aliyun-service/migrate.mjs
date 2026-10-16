import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
const sql=postgres(process.env.DATABASE_URL,{ssl:'require',max:1});
await sql.unsafe(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));await sql.end();console.log('Schema ready');
