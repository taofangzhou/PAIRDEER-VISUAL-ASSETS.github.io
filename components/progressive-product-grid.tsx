'use client';

import {useCallback,useEffect,useId,useRef,useState,type ReactNode} from 'react';

const initialCount=16;
const batchSize=8;
const unchanged=(text:string)=>text;

export function ProgressiveProductGrid<T>({items,renderItems,translate=unchanged}:{items:readonly T[];renderItems:(items:T[])=>ReactNode;translate?:(text:string)=>string}){
 const [visibleCount,setVisibleCount]=useState(initialCount);
 const marker=useRef<HTMLDivElement>(null),inside=useRef(false);
 const gridId=useId();
 const total=items.length,shown=Math.min(visibleCount,total),hasMore=shown<total;
 const appendBatch=useCallback(()=>setVisibleCount(count=>Math.min(count+batchSize,total)),[total]);

 useEffect(()=>{
  const target=marker.current;
  if(!target||total<=initialCount||typeof IntersectionObserver==='undefined')return;
  let disposed=false;
  const observer=new IntersectionObserver(entries=>{
   if(disposed)return;
   for(const entry of entries){
    if(!entry.isIntersecting){inside.current=false;continue}
    if(inside.current)continue;
    inside.current=true;
    appendBatch();
   }
  },{rootMargin:'200px 0px',threshold:0});
  observer.observe(target);
  return()=>{disposed=true;observer.disconnect()};
 },[appendBatch,total]);

 return <>
  <div id={gridId} className="product-grid">{renderItems(items.slice(0,shown))}</div>
  <div ref={marker} className="catalog-load-marker" aria-hidden="true"/>
  <div className="catalog-load-more">
   <p role="status" aria-live="polite" aria-atomic="true">{hasMore?<>{translate('已显示')} {shown} / {total} {translate('款产品')}<span>{translate('下拉继续浏览')}</span></>:<>{translate('已全部显示，共')} {total} {translate('款产品')}</>}</p>
   {hasMore&&<button className="outline" aria-controls={gridId} onClick={()=>{inside.current=true;appendBatch()}}>{translate('加载更多')}</button>}
  </div>
 </>;
}
