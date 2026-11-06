'use client';

import {useCallback,useEffect,useRef} from 'react';

type AnalyticsPage='home'|'product'|'company_pdf'|'company_video';
type SearchSource='text'|'image';
type AnalyticsEvent={id:string;type:'pageview'|'search';page:AnalyticsPage;query?:string;source?:SearchSource};

// Keep writes in order so the first response can establish the anonymous cookie.
// Route keys and event IDs only live in memory; no browsing history is retained.
let pending:Promise<void>=Promise.resolve();
function eventId(){
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const value=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
 return value.slice(0,8)+'-'+value.slice(8,12)+'-'+value.slice(12,16)+'-'+value.slice(16,20)+'-'+value.slice(20);
}
function route(){
 const url=new URL(window.location.href);
 if(url.hostname==='admin.shuanglu-battery.cn'||url.searchParams.has('admin')||url.pathname==='/admin'||url.pathname.startsWith('/admin/'))return null;
 const material=url.searchParams.get('material');
 if(material==='pdf'||material==='ppt')return {key:'company_pdf',page:'company_pdf' as const};
 if(material==='video')return {key:'company_video',page:'company_video' as const};
 const product=url.searchParams.get('product');
 return product?{key:'product:'+product,page:'product' as const}:{key:'home',page:'home' as const};
}
function enqueue(event:AnalyticsEvent){
 pending=pending.then(async()=>{
  try{await fetch('/api/analytics',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',keepalive:true,body:JSON.stringify(event)})}catch{/* Analytics never blocks using the site. */}
 });
}

export function useSiteAnalytics(){
 const lastKey=useRef<string|undefined>(undefined);
 useEffect(()=>{
  const trackRoute=()=>{const current=route(),key=current?.key??'admin';if(key===lastKey.current)return;lastKey.current=key;if(current)enqueue({id:eventId(),type:'pageview',page:current.page})};
  const previousPush=history.pushState,previousReplace=history.replaceState;
  const push:History['pushState']=function(this:History,...args){previousPush.apply(this,args);trackRoute()};
  const replace:History['replaceState']=function(this:History,...args){previousReplace.apply(this,args);trackRoute()};
  history.pushState=push;history.replaceState=replace;
  window.addEventListener('popstate',trackRoute);trackRoute();
  return()=>{window.removeEventListener('popstate',trackRoute);if(history.pushState===push)history.pushState=previousPush;if(history.replaceState===replace)history.replaceState=previousReplace};
 },[]);
 const trackSearch=useCallback((query:string,source:SearchSource='text')=>{
  const current=route();if(!current||source==='text'&&!query.trim())return;
  enqueue({id:eventId(),type:'search',page:current.page,source,...(source==='text'?{query:query.slice(0,500)}:{})});
 },[]);
 return {trackSearch};
}

export function productDownloadUrl(product:string,section:'main'|'detail'|'extra',index:number,fresh=false){
 const params=new URLSearchParams({product,section,index:String(index)});if(fresh)params.set('eventId',eventId());return '/api/download?'+params;
}
export function companyDownloadUrl(company:'pdf'|'video',fresh=false){
 const params=new URLSearchParams({company});if(fresh)params.set('eventId',eventId());return '/api/download?'+params;
}
export function zipDownloadUrl(product:string,fresh=false){return '/api/product-zip/'+encodeURIComponent(product)+(fresh?'?eventId='+eventId():'')}
