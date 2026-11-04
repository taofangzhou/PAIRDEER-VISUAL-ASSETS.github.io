'use client';

import {useState} from 'react';
import {ArrowUpRight,ChevronLeft,ChevronRight,FileText,Maximize2,RefreshCw,X} from 'lucide-react';
import {Dialog,DialogClose,DialogContent,DialogDescription,DialogHeader,DialogTitle} from '@/components/ui/dialog';
import type {CompanyMaterial} from '@/lib/company-materials';

function PreviewPage({url,page,originalUrl,expanded=false}:{url:string;page:number;originalUrl:string;expanded?:boolean}){
 const [state,setState]=useState<'loading'|'loaded'|'error'>('loading');
 const [attempt,setAttempt]=useState(0);
 return <div className={'company-pdf-page'+(expanded?' company-pdf-page-expanded':'')} aria-busy={state==='loading'}>
  {/* These pre-rendered ECS JPEGs must bypass image conversion and load only the active page. */}
  {/* eslint-disable-next-line @next/next/no-img-element */}
  <img key={attempt} className="company-pdf-page-image" data-state={state} src={url+(attempt?'?retry='+attempt:'')} alt={'双鹿电池介绍PDF 第 '+page+' 页'} width={1600} height={900} loading="eager" fetchPriority="high" decoding="async" onLoad={()=>setState('loaded')} onError={()=>setState('error')}/>
  {state==='loading'&&<div className="company-pdf-page-status" role="status"><span className="company-pdf-loading-dot"/>正在加载第 {page} 页…</div>}
  {state==='error'&&<div className="company-pdf-page-status company-pdf-page-error" role="alert"><FileText size={26}/><p>这一页暂时无法加载</p><div><button className="outline" onClick={()=>{setState('loading');setAttempt(value=>value+1)}}><RefreshCw size={15}/>重试本页</button><a href={originalUrl} target="_blank" rel="noopener noreferrer">打开PDF原件<ArrowUpRight size={14}/></a></div></div>}
 </div>;
}

/** The parent keys this reader by the original and page URLs, so polling cannot reset the current page. */
export function CompanyPdfPreview({material}:{material:CompanyMaterial}){
 const pages=material.previewPages||[];
 const [page,setPage]=useState(0),[jump,setJump]=useState('1'),[expanded,setExpanded]=useState(false);
 function goTo(index:number){const next=Math.max(0,Math.min(pages.length-1,index));setPage(next);setJump(String(next+1))}
 if(!pages.length)return <div className="company-material-empty"><FileText size={38}/><h2>打开文件查看完整内容</h2><p>此文件暂未提供逐页预览。</p><a className="outline" href={material.url} target="_blank" rel="noopener noreferrer">打开PDF原件<ArrowUpRight size={16}/></a></div>;
 const current=pages[page];
 return <>
  <section className="company-pdf-reader" aria-label="双鹿电池介绍PDF逐页预览" tabIndex={0} onKeyDown={event=>{if(event.target!==event.currentTarget)return;if(event.key==='ArrowLeft'){event.preventDefault();goTo(page-1)}else if(event.key==='ArrowRight'){event.preventDefault();goTo(page+1)}}}>
   <div className="company-pdf-toolbar">
    <div className="company-pdf-page-controls"><button className="outline" disabled={page===0} onClick={()=>goTo(page-1)}><ChevronLeft size={17}/>上一页</button><span className="company-pdf-page-count" aria-live="polite" aria-atomic="true">第 <strong>{page+1}</strong> / {pages.length} 页</span><button className="outline" disabled={page===pages.length-1} onClick={()=>goTo(page+1)}>下一页<ChevronRight size={17}/></button></div>
    <div className="company-pdf-extra-controls"><form className="company-pdf-jump" onSubmit={event=>{event.preventDefault();const value=Number(jump);if(Number.isInteger(value)&&value>=1&&value<=pages.length)goTo(value-1)}}><input aria-label="跳转页码" type="number" inputMode="numeric" min={1} max={pages.length} step={1} required value={jump} onChange={event=>setJump(event.target.value)}/><button type="submit">跳转</button></form><button className="outline" onClick={()=>setExpanded(true)}><Maximize2 size={16}/>放大查看</button></div>
   </div>
   <PreviewPage key={current} url={current} page={page+1} originalUrl={material.url}/>
  </section>
  <p className="company-preview-note">支持逐页浏览与放大查看。<a href={material.url} target="_blank" rel="noopener noreferrer">打开PDF原件<ArrowUpRight size={14}/></a></p>
  <Dialog open={expanded} onOpenChange={setExpanded}><DialogContent className="company-pdf-zoom" showCloseButton={false}><DialogHeader><DialogTitle>双鹿电池介绍PDF大图预览</DialogTitle><DialogDescription>第 {page+1} 页，共 {pages.length} 页。可滚动查看图片细节。</DialogDescription></DialogHeader><DialogClose className="company-pdf-zoom-close" aria-label="关闭大图预览"><X size={20}/></DialogClose><div className="company-pdf-zoom-controls"><button className="outline" aria-label="大图上一页" disabled={page===0} onClick={()=>goTo(page-1)}><ChevronLeft size={17}/>上一页</button><span>第 {page+1} / {pages.length} 页</span><button className="outline" aria-label="大图下一页" disabled={page===pages.length-1} onClick={()=>goTo(page+1)}>下一页<ChevronRight size={17}/></button></div><div className="company-pdf-zoom-stage"><PreviewPage key={current} url={current} page={page+1} originalUrl={material.url} expanded/></div></DialogContent></Dialog>
 </>;
}
