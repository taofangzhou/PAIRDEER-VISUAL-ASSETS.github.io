'use client';

import {useEffect,useRef,useState,type RefObject} from 'react';
import {ArrowLeft,ArrowUpRight,Download,FileText,Play,Upload} from 'lucide-react';
import {toast} from 'sonner';
import {COMPANY_MATERIAL_MAX_BYTES,type CompanyMaterial,type CompanyMaterials} from '@/lib/company-materials';
import {CompanyPdfPreview} from '@/components/company-pdf-preview';

type MaterialKind='pdf'|'video';
const titles={pdf:'双鹿电池介绍PDF',video:'公司介绍视频'};

function fileSize(size:number){return (size/1024/1024).toLocaleString('zh-CN',{maximumFractionDigits:1})+' MB'}
function downloadLink(material:CompanyMaterial){return material.url.startsWith('/api/media/')?material.url+'?download=1':material.url}
function recordCompanyDownload(kind:MaterialKind){void fetch('/api/analytics',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'download',value:kind}),keepalive:true}).catch(()=>{})}
function updatedDate(value:string){return new Date(value).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}

export function CompanyMaterialView({kind,material,onBack}:{kind:MaterialKind;material?:CompanyMaterial;onBack:()=>void}){
 const [failedVideo,setFailedVideo]=useState('');
 return <section className="company-material" aria-labelledby="company-material-title">
  <div className="breadcrumb"><button onClick={onBack}><ArrowLeft size={15}/>返回首页</button><span>/</span><span>{titles[kind]}</span></div>
  <div className="company-material-heading"><div><span className="company-material-kicker">PAIRDEER · 品牌资料</span><h1 id="company-material-title">{titles[kind]}</h1><p>{kind==='pdf'?'了解双鹿电池，在线阅览品牌与产品介绍。':'走近双鹿，了解我们的品牌与实力。'}</p></div>{material&&<a className="primary" href={downloadLink(material)} download={material.name} onClick={()=>recordCompanyDownload(kind)}><Download size={18}/>下载{kind==='pdf'?'PDF原文件':'视频原文件'}</a>}</div>
  {material?<><div className="company-material-meta"><span className="company-material-file">{kind==='pdf'?<FileText size={17}/>:<Play size={17}/>}<strong>{material.name}</strong></span><span>{fileSize(material.size)}</span><span>更新于 {updatedDate(material.updatedAt)}</span></div>
   {kind==='video'?<><div className="company-video-frame"><video key={material.url} src={material.url} controls playsInline preload="metadata" onError={()=>setFailedVideo(material.url)} aria-label="公司介绍视频">您的浏览器暂不支持视频播放，请下载后观看。</video></div>{failedVideo===material.url&&<p className="company-preview-note" role="alert">暂时无法播放此视频，您可以下载原文件后观看。</p>}</>:<CompanyPdfPreview key={material.url+'|'+(material.previewPages||[]).join('|')} material={material}/>}
  </>:<div className="company-material-empty"><FileText size={38}/><h2>资料即将上线</h2><p>管理员发布后，您可以在这里预览和下载{kind==='pdf'?'双鹿电池介绍PDF':'公司介绍视频'}。</p></div>}
 </section>;
}

type UploadState={kind:MaterialKind;percent:number;phase:'upload'|'publish'};

function uploadMaterial(kind:MaterialKind,file:File,onProgress:(percent:number)=>void,xhrRef:RefObject<XMLHttpRequest|null>){
 return new Promise<CompanyMaterial>((resolve,reject)=>{
  const xhr=new XMLHttpRequest();xhrRef.current=xhr;xhr.open('POST','/api/company-materials/'+kind);xhr.timeout=300000;
  xhr.setRequestHeader('Content-Type',kind==='pdf'?'application/pdf':'video/mp4');
  xhr.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
  xhr.upload.onprogress=event=>{if(event.lengthComputable)onProgress(Math.round(event.loaded/event.total*100))};
  xhr.onload=()=>{try{const result=JSON.parse(xhr.responseText);if(xhr.status<200||xhr.status>=300)throw new Error(result.error||'上传失败，请重试');if(!result.material)throw new Error('上传结果无效，请重试');resolve(result.material)}catch(error){reject(error instanceof Error?error:new Error('上传失败，请重试'))}};
  xhr.onerror=()=>reject(new Error('网络连接中断，请检查网络后重试'));
  xhr.ontimeout=()=>reject(new Error('文件上传超时，请稍后重试'));
  xhr.onabort=()=>reject(new Error('上传已取消'));
  xhr.send(file);
 });
}

export function CompanyMaterialsAdmin({materials,disabled,onBusyChange,onSave}:{materials:CompanyMaterials;disabled:boolean;onBusyChange:(busy:boolean)=>void;onSave:(materials:CompanyMaterials)=>Promise<boolean>}){
 const [upload,setUpload]=useState<UploadState|null>(null),[failure,setFailure]=useState('');
 const xhrRef=useRef<XMLHttpRequest|null>(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;xhrRef.current?.abort()}},[]);
 async function replace(kind:MaterialKind,file:File){
  if(disabled||upload)return;
  if(!file.name.toLowerCase().endsWith(kind==='pdf'?'.pdf':'.mp4')){toast.error(kind==='pdf'?'请选择 .pdf 文件':'请选择 .mp4 文件');return}
  if(!file.size||file.size>COMPANY_MATERIAL_MAX_BYTES){toast.error('请选择不超过250MB的文件');return}
  const publish=onSave,next={...materials};setFailure('');setUpload({kind,percent:0,phase:'upload'});onBusyChange(true);
  try{
   const material=await uploadMaterial(kind,file,percent=>{if(mounted.current)setUpload({kind,percent,phase:'upload'})},xhrRef);
   if(!mounted.current)return;setUpload({kind,percent:100,phase:'publish'});next[kind]=material;
   if(!await publish(next))setFailure('本次替换未发布。请刷新资料后重试，当前已发布文件仍可使用。');
  }catch(error){if(mounted.current){const message=error instanceof Error?error.message:'上传失败，请重试';setFailure(message);toast.error(message)}}
  finally{xhrRef.current=null;if(mounted.current)setUpload(null);onBusyChange(false)}
 }
 return <div className="company-material-admin"><p className="muted">分别上传 PDF 和 MP4，上传完成后自动发布到前台。替换过程中，访客仍可使用当前文件。</p><div className="company-material-cards">{(['pdf','video'] as const).map(kind=>{const current=materials[kind],active=upload?.kind===kind;return <article className="company-material-card" key={kind}><div className="company-card-title"><span className="quick-icon">{kind==='pdf'?<FileText size={24}/>:<Play size={24}/>}</span><div><h2>{titles[kind]}</h2><p>{kind==='pdf'?'PDF文件 · 在线预览':'MP4视频 · 在线播放'}</p></div></div>{current?<div className="company-current-file"><strong>{current.name}</strong><span>{fileSize(current.size)} · 更新于 {updatedDate(current.updatedAt)}</span><div><a href={'/?material='+kind} target="_blank" rel="noopener noreferrer">查看前台<ArrowUpRight size={14}/></a><a href={downloadLink(current)} download={current.name}><Download size={14}/>下载当前文件</a></div></div>:<p className="company-no-file">尚未上传，上传发布后将在前台展示。</p>}<label className={'upload-label company-replace-label'+(disabled||upload?' disabled':'')}><Upload size={17}/>{active?'正在替换…':current?'选择文件并替换发布':'上传文件并发布'}<input aria-label={titles[kind]+'上传替换'} type="file" disabled={disabled||!!upload} accept={kind==='pdf'?'.pdf,application/pdf':'.mp4,video/mp4'} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void replace(kind,file)}}/></label><small>支持 {kind==='pdf'?'.pdf':'.mp4'}，单个文件最大250MB。{kind==='pdf'?'上传后自动生成逐页预览，可能需要约3分钟，请保持页面打开。':'请使用可在浏览器播放的 MP4 视频。'}</small>{active&&<div className="company-upload-progress" role="status" aria-live="polite"><progress max={100} value={upload.phase==='upload'?upload.percent:100} aria-label="文件上传进度"/><span>{upload.phase==='publish'?'正在发布更新…':upload.percent===100?(kind==='pdf'?'上传完成，正在生成预览…':'上传完成，正在保存文件…'):'正在上传 '+upload.percent+'%'}</span></div>}</article>})}</div>{failure&&<p className="notice" role="alert">{failure}</p>}</div>;
}
