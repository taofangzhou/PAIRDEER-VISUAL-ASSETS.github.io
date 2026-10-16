import mapping from './download-map.json';
export function downloadUrl(url:string){return (mapping as Record<string,string>)[url]||url;}
export function downloadName(url:string,name:string){const target=downloadUrl(url);const ext=/\.png(?:\?|$)/i.test(target)?'png':'jpg';return name+'.'+ext;}
export function needsConversion(url:string){return !/\.(?:png|jpe?g)(?:\?|$)/i.test(downloadUrl(url));}
export async function imageDownload(url:string,name:string){
 const res=await fetch(downloadUrl(url));if(!res.ok)throw new Error('图片读取失败');let blob=await res.blob();const bytes=new Uint8Array(await blob.slice(0,12).arrayBuffer());let ext='';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255){ext='jpg';blob=new Blob([blob],{type:'image/jpeg'});}
 else if(bytes[0]===137&&bytes[1]===80&&bytes[2]===78&&bytes[3]===71){ext='png';blob=new Blob([blob],{type:'image/png'});}
 else {const bitmap=await createImageBitmap(blob);const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d')!.drawImage(bitmap,0,0);bitmap.close();blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('图片转换失败')),'image/png'));ext='png';}
 const objectUrl=URL.createObjectURL(blob);const a=document.createElement('a');a.href=objectUrl;a.download=name+'.'+ext;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);
}
