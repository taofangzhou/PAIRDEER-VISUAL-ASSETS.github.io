'use client';

import {useEffect,useState,type FormEvent} from 'react';
import {ChartColumn,Download,FolderSync,RefreshCw,Search,UsersRound} from 'lucide-react';
import {toast} from 'sonner';

type DownloadTotals={pdf:number;video:number;image:number;detail:number;zip:number;total:number};
type MaterialTotals={added:number;replaced:number};
type Summary={newVisitors:number;pageViews:number;searches:number;downloads:DownloadTotals;adminMaterials:MaterialTotals};
type OperationsSnapshot={
 collectedSince:string|null;
 timeZone:string;
 totals:{visitors:number;pageViews:number;searches:number;downloads:DownloadTotals;adminMaterials:MaterialTotals};
 currentMonth:{month:string;pageViews:number};
 range:{from:string;to:string};
 hotModels:{model:string;count:number}[];
 daily:(Summary&{day:string})[];
 monthly:(Summary&{month:string})[];
};
type DateRange={from:string;to:string};
const numberFormat=new Intl.NumberFormat('zh-CN');
const count=(value:number)=>numberFormat.format(value);

function initialRange():DateRange{
 const today=new Date(Date.now()+8*60*60*1000).toISOString().slice(0,10);
 return {from:today.slice(0,8)+'01',to:today};
}
function queryFor(range:DateRange,format?:'csv'|'xlsx'){
 const query=new URLSearchParams(range);
 if(format)query.set('format',format);
 return '/api/admin/operations?'+query.toString();
}
function collectedDate(value:string){return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}
function downloadFiles(downloads:DownloadTotals){return downloads.pdf+downloads.video+downloads.image+downloads.detail}

function SummaryTable({rows,period}:{rows:(Summary&{label:string})[];period:'每日'|'月度'}){
 return <div className="operations-table-scroll" tabIndex={0} role="region" aria-label={period+'汇总表，可横向滚动'}><table className="operations-table"><thead><tr><th scope="col">{period==='每日'?'日期':'月份'}</th><th scope="col">新增访客</th><th scope="col">浏览量 PV</th><th scope="col">搜索次数</th><th scope="col">原文件下载</th><th scope="col">ZIP 打包</th><th scope="col">新增资料</th><th scope="col">替换资料</th></tr></thead><tbody>{rows.length?rows.map(row=><tr key={row.label}><th scope="row">{row.label}</th><td>{count(row.newVisitors)}</td><td>{count(row.pageViews)}</td><td>{count(row.searches)}</td><td>{count(downloadFiles(row.downloads))}</td><td>{count(row.downloads.zip)}</td><td>{count(row.adminMaterials.added)}</td><td>{count(row.adminMaterials.replaced)}</td></tr>):<tr><td colSpan={8} className="operations-empty">所选日期暂无统计数据</td></tr>}</tbody></table></div>;
}

export function OperationsCenter(){
 const [draft,setDraft]=useState(initialRange);
 const [range,setRange]=useState(initialRange);
 const [refresh,setRefresh]=useState(0);
 const [data,setData]=useState<OperationsSnapshot|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const [dateError,setDateError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();
  let active=true;
  async function load(){
   try{
    const response=await fetch(queryFor(range),{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    if(response.status===401||response.status===403){
     if(active){const message='管理员登录已过期，请重新登录后查看运营统计。';setData(null);setError(message);toast.error(message)}
     return;
    }
    const result=await response.json();
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'统计加载失败，请稍后重试。');
    if(!result.totals||!result.currentMonth||!result.range||!Array.isArray(result.daily)||!Array.isArray(result.monthly)||!Array.isArray(result.hotModels))throw new Error('统计数据暂时不可用，请稍后重试。');
    if(active)setData(result as OperationsSnapshot);
   }catch(failure){
    if(active&&!controller.signal.aborted){setData(null);setError(failure instanceof Error?failure.message:'统计加载失败，请检查网络后重试。')}
   }finally{if(active)setLoading(false)}
  }
  void load();
  return()=>{active=false;controller.abort()};
 },[range,refresh]);
 function refreshData(){setLoading(true);setError('');setData(null);setRefresh(value=>value+1)}
 function applyDates(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!draft.from||!draft.to||draft.from>draft.to){setDateError('请选择有效日期，开始日期不能晚于结束日期。');return}
  const days=(Date.parse(draft.to+'T00:00:00Z')-Date.parse(draft.from+'T00:00:00Z'))/86400000;
  if(!Number.isFinite(days)||days>365){setDateError('每次最多查询366天，请缩短日期范围。');return}
  setDateError('');setLoading(true);setError('');setData(null);setRange({...draft});
 }
 return <section className="operations-center" aria-labelledby="operations-title" aria-busy={loading}>
  <div className="operations-heading"><div><h2 id="operations-title">网站运营日志中心</h2><p>汇总网站访问、搜索、下载与资料更新情况，仅展示统计总量和热门型号。</p></div><button className="outline" disabled={loading} onClick={refreshData}><RefreshCw size={16} className={loading?'operations-spin':undefined}/>刷新统计</button></div>
  <p className="operations-privacy">按北京时间汇总。不展示个人搜索、浏览或下载轨迹，也不保留搜索原词。</p>
  {loading&&<p className="operations-loading" role="status" aria-live="polite">正在加载运营统计…</p>}
  {error&&<div className="operations-error" role="alert"><p>{error}</p><button className="outline" onClick={refreshData}>重新加载</button></div>}
  {data&&<>
   <div className="operations-scope"><strong>固定统计卡片</strong><span>前四项为累计数据，第五项为本月数据，不随下方日期筛选变化。</span></div>
   <div className="operations-kpis">
    <article className="operations-kpi"><UsersRound size={21}/><h3>累计访客 UV</h3><strong>{count(data.totals.visitors)}</strong><p>按匿名浏览器去重</p></article>
    <article className="operations-kpi"><Search size={21}/><h3>累计搜索</h3><strong>{count(data.totals.searches)}</strong><p>含文字搜索与拍照搜索</p></article>
    <article className="operations-kpi operations-kpi-download"><Download size={21}/><h3>累计下载</h3><strong>{count(data.totals.downloads.total)}</strong><p>含原文件与 ZIP 打包</p><dl><div><dt>PDF</dt><dd>{count(data.totals.downloads.pdf)}</dd></div><div><dt>视频</dt><dd>{count(data.totals.downloads.video)}</dd></div><div><dt>主图 / 其他图</dt><dd>{count(data.totals.downloads.image)}</dd></div><div><dt>详情图</dt><dd>{count(data.totals.downloads.detail)}</dd></div><div><dt>ZIP 打包</dt><dd>{count(data.totals.downloads.zip)}</dd></div></dl></article>
    <article className="operations-kpi"><FolderSync size={21}/><h3>累计资料更新</h3><strong>{count(data.totals.adminMaterials.added+data.totals.adminMaterials.replaced)}</strong><p>新增 {count(data.totals.adminMaterials.added)} · 替换 {count(data.totals.adminMaterials.replaced)}</p></article>
    <article className="operations-kpi"><ChartColumn size={21}/><h3>本月浏览量 PV</h3><strong>{count(data.currentMonth.pageViews)}</strong><p>{data.currentMonth.month} · 页面访问次数</p></article>
   </div>
   <p className="operations-footnote">{data.collectedSince?'统计开始于 '+collectedDate(data.collectedSince)+'。':'尚未收到有效统计记录。'}访客数按浏览器去重，清理浏览器数据或更换设备会重新计数；新增访客为首次访问的浏览器数量。</p>
  </>}
  <form className="operations-filters" onSubmit={applyDates}>
   <div className="operations-filter-intro"><h3>日期范围</h3><p id="operations-range-help">筛选每日汇总、热门型号及导出数据，并选择月度表的月份；每次最多366天。</p></div>
   <label>开始日期<input type="date" value={draft.from} required onChange={event=>setDraft(value=>({...value,from:event.target.value}))} aria-describedby="operations-range-help"/></label>
   <label>结束日期<input type="date" value={draft.to} required onChange={event=>setDraft(value=>({...value,to:event.target.value}))} aria-describedby="operations-range-help"/></label>
   <button type="submit" className="primary" disabled={loading}>应用日期</button>
   {dateError&&<p className="operations-date-error" role="alert">{dateError}</p>}
  </form>
  {data&&<>
   <div className="operations-report-heading"><p>当前范围：<strong>{data.range.from} 至 {data.range.to}</strong>（含起止日期）</p><div className="operations-exports"><span>导出所选日期</span><a className="outline" href={queryFor(data.range,'csv')}><Download size={15}/>CSV</a><a className="outline" href={queryFor(data.range,'xlsx')}><Download size={15}/>Excel</a></div></div>
   <section className="operations-report" aria-labelledby="operations-daily-title"><div className="operations-report-title"><h3 id="operations-daily-title">每日汇总</h3><p>原文件下载包含 PDF、视频、主图及其他图、详情图；ZIP 单独列出。</p></div><SummaryTable rows={data.daily.map(row=>({...row,label:row.day}))} period="每日"/></section>
   <section className="operations-report" aria-labelledby="operations-monthly-title"><div className="operations-report-title"><h3 id="operations-monthly-title">月度访问次数（自然月）</h3><p>日期范围用于选择月份；每月数值为完整自然月合计。</p></div><SummaryTable rows={data.monthly.map(row=>({...row,label:row.month}))} period="月度"/></section>
   <section className="operations-report" aria-labelledby="operations-models-title"><div className="operations-report-title"><h3 id="operations-models-title">热门搜索型号</h3><p>仅汇总识别到的产品型号，不展示搜索原词。</p></div>{data.hotModels.length?<div className="operations-table-scroll" tabIndex={0} role="region" aria-label="热门搜索型号表"><table className="operations-table operations-models-table"><thead><tr><th scope="col">排名</th><th scope="col">产品型号</th><th scope="col">搜索命中次数</th></tr></thead><tbody>{data.hotModels.map((model,index)=><tr key={model.model}><td>{index+1}</td><th scope="row">{model.model}</th><td>{count(model.count)}</td></tr>)}</tbody></table></div>:<p className="operations-empty">所选日期暂无型号搜索记录</p>}</section>
  </>}
 </section>;
}
