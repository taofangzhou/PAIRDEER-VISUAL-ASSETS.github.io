const enc=new TextEncoder();
const table=Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0});
function block(size:number){const bytes=new Uint8Array(size);return {bytes,v:new DataView(bytes.buffer)}}
export type ZipEntry={name:string;open:()=>Promise<ReadableStream<Uint8Array>>};
export function zipStream(entries:ZipEntry[]){
 async function* generate(){let offset=0;const central:Uint8Array[]=[];
 for(const entry of entries){const name=enc.encode(entry.name),start=offset;const {bytes:h,v}=block(30+name.length);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x808,true);v.setUint16(12,33,true);v.setUint16(26,name.length,true);h.set(name,30);yield h;offset+=h.length;
 const reader=(await entry.open()).getReader();let size=0,crc=0xffffffff;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>0xffffffff)throw Error('ZIP file too large');for(const b of value)crc=table[(crc^b)&255]^(crc>>>8);offset+=value.length;yield value}}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 crc=(crc^0xffffffff)>>>0;const {bytes:d,v:dv}=block(16);dv.setUint32(0,0x08074b50,true);dv.setUint32(4,crc,true);dv.setUint32(8,size,true);dv.setUint32(12,size,true);yield d;offset+=16;
 const {bytes:c,v:cv}=block(46+name.length);cv.setUint32(0,0x02014b50,true);cv.setUint16(4,20,true);cv.setUint16(6,20,true);cv.setUint16(8,0x808,true);cv.setUint16(14,33,true);cv.setUint32(16,crc,true);cv.setUint32(20,size,true);cv.setUint32(24,size,true);cv.setUint16(28,name.length,true);cv.setUint32(42,start,true);c.set(name,46);central.push(c);
 }
 const start=offset;for(const c of central){yield c;offset+=c.length}if(offset>0xffffffff||entries.length>65535)throw Error('ZIP size limit');const {bytes:e,v}=block(22);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,offset-start,true);v.setUint32(16,start,true);yield e;
 }
 const it=generate();return new ReadableStream<Uint8Array>({async pull(c){try{const r=await it.next();if(r.done)c.close();else c.enqueue(r.value)}catch(e){c.error(e)}},async cancel(){await it.return(undefined)}});
}
