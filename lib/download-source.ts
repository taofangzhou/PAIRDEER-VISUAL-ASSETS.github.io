import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {dataDirectory} from '@/lib/runtime';

export type OriginalKind='image'|'pdf'|'video';
export type DownloadSource={location:string;size?:number};

export class DownloadSourceError extends Error {
  constructor(message:string,readonly status=400){super(message)}
}

const extensions:Record<OriginalKind,RegExp>={image:/\.(?:jpe?g|png|webp|gif)$/i,pdf:/\.pdf$/i,video:/\.mp4$/i};
const mime:Record<OriginalKind,RegExp>={image:/^image\/(?:jpeg|png|webp|gif)$/i,pdf:/^application\/pdf$/i,video:/^video\/mp4$/i};

async function localFile(filename:string,expectedSize?:number){
  let handle;
  try{
    handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    const info=await handle.stat();
    if(!info.isFile()||info.size<=0||(expectedSize!==undefined&&info.size!==expectedSize))throw new DownloadSourceError('下载文件不存在或不完整',404);
    return info.size;
  }catch(error){
    if(error instanceof DownloadSourceError)throw error;
    throw new DownloadSourceError('下载文件不存在或无法读取',404);
  }finally{await handle?.close()}
}

/** Verify catalog-owned originals without making an HTTP request to a client-provided Host. */
export async function validateDownloadSource(original:string,kind:OriginalKind,expectedSize?:number):Promise<DownloadSource>{
  if(typeof original!=='string'||/[\x00-\x20\x7f\\]/.test(original))throw new DownloadSourceError('下载地址无效');
  if(original.startsWith('/')){
    if(original.startsWith('//'))throw new DownloadSourceError('下载地址无效');
    const rawPath=original.split(/[?#]/,1)[0];
    let decoded:string;
    try{decoded=decodeURIComponent(rawPath)}catch{throw new DownloadSourceError('下载地址无效')}
    if(/[\x00-\x1f\x7f\\%]/.test(decoded)||decoded.split('/').some(part=>part==='.'||part==='..'))throw new DownloadSourceError('下载地址无效');
    if(!extensions[kind].test(decoded))throw new DownloadSourceError('下载文件格式无效');
    if(decoded.startsWith('/api/media/')){
      const key=decoded.slice('/api/media/'.length);
      if(!/^[a-z0-9-]+\.(?:png|jpg|webp|gif|pdf|mp4)$/.test(key))throw new DownloadSourceError('下载地址无效');
      const directory=path.resolve(dataDirectory(),'media');
      try{if((await lstat(directory)).isSymbolicLink()||await realpath(directory)!==directory)throw new DownloadSourceError('下载来源目录无效')}
      catch(error){if(error instanceof DownloadSourceError)throw error;throw new DownloadSourceError('下载文件不存在',404)}
      return {location:'/api/media/'+key+'?download=1',size:await localFile(path.join(directory,key),expectedSize)};
    }
    const prefix=decoded.startsWith('/assets/')?'assets':decoded.startsWith('/downloads/')?'downloads':null;
    if(!prefix)throw new DownloadSourceError('下载地址无效');
    try{
      const publicRoot=await realpath(path.resolve('public'));
      const root=path.join(publicRoot,prefix);
      if((await lstat(root)).isSymbolicLink()||await realpath(root)!==root)throw new DownloadSourceError('下载来源目录无效');
      const filename=await realpath(path.join(publicRoot,decoded));
      if(!filename.startsWith(root+path.sep))throw new DownloadSourceError('下载地址无效');
      const location=new URL(original,'https://local.invalid').pathname;
      return {location,size:await localFile(filename,expectedSize)};
    }catch(error){if(error instanceof DownloadSourceError)throw error;throw new DownloadSourceError('下载文件不存在',404)}
  }
  let url:URL;
  try{url=new URL(original)}catch{throw new DownloadSourceError('下载地址无效')}
  const allowed=(process.env.MEDIA_ALLOWED_HOSTS||'').split(',').map(host=>host.trim().toLowerCase()).filter(Boolean);
  if(url.protocol!=='https:'||url.username||url.password||!allowed.includes(url.host.toLowerCase()))throw new DownloadSourceError('外部素材域名尚未配置下载权限',403);
  if(!extensions[kind].test(url.pathname))throw new DownloadSourceError('下载文件格式无效');
  let response:Response;
  try{response=await fetch(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(15000)})}
  catch{throw new DownloadSourceError('下载文件暂时无法读取',502)}
  if(!response.ok)throw new DownloadSourceError('下载文件不存在或无法读取',404);
  const type=response.headers.get('content-type')?.split(';')[0].trim();
  if(!type||!mime[kind].test(type))throw new DownloadSourceError('下载文件类型无效',502);
  const length=response.headers.get('content-length');
  const size=length===null?undefined:Number(length);
  if(size!==undefined&&(!Number.isSafeInteger(size)||size<=0||(expectedSize!==undefined&&size!==expectedSize)))throw new DownloadSourceError('下载文件不存在或不完整',404);
  url.hash='';
  return {location:url.href,size};
}

export function downloadEventId(req:Request){
  const values=new URL(req.url).searchParams.getAll('eventId');
  if(values.length>1)throw new DownloadSourceError('下载请求标识无效');
  const value=values[0];
  if(value!==undefined&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw new DownloadSourceError('下载请求标识无效');
  return value;
}

/** Media previews and resumptions never create additional download counters. */
export function shouldRecordDownload(req:Request){
  return req.method==='GET'&&!req.headers.has('range')&&!['image','video','audio','iframe'].includes(req.headers.get('sec-fetch-dest')||'');
}
