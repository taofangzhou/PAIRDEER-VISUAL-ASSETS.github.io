'use client';

import {useEffect,useState} from 'react';
import {ChartColumn,Download,FolderSync,RefreshCw,Search,UsersRound} from 'lucide-react';
import {toast} from 'sonner';

type OperationsSnapshot={
 collectedSince:string|null;
 timeZone:string;
 totals:{
  visitors:number;
  searches:number;
  downloads:{pdf:number;video:number;image:number;detail:number;total:number};
  adminMaterials:{added:number;replaced:number};
 };
 currentMonth:{month:string;pageViews:number};
 hotModels:{model:string;count:number}[];
 monthly:{month:string;pageViews:number}[];
};
const numberFormat=new Intl.NumberFormat('zh-CN');
const count=(value:number)=>numberFormat.format(value);
function collectedDate(value:string){return new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}

export function OperationsCenter(){
 const [refresh,setRefresh]=useState(0);
 const [data,setData]=useState<OperationsSnapshot|null>(null);
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();
  let active=true;
  async function load(){
   try{
    const response=await fetch('/api/admin/operations',{cache:'no-store',credentials:'same-origin',signal:controller.signal});
    if(response.status===401||response.status===403){
     if(active){const message='管理员登录已过期，请重新登录后查看运营统计。';setData(null);setError(message);toast.error(message)}
     return;
    }
    const result=await response.json();
    if(!response.ok)throw new Error(typeof result.error==='string'?result.error:'统计加载失败，请稍后重试。');
    if(!result.totals?.downloads||!result.totals.adminMaterials||!result.currentMonth||!Array.isArray(result.monthly)||!Array.isArray(result.hotModels))throw new Error('统计数据暂时不可用，请稍后重试。');
    if(active)setData(result as OperationsSnapshot);
   }catch(failure){
    if(active&&!controller.signal.aborted){setData(null);setError(failure instanceof Error?failure.message:'统计加载失败，请检查网络后重试。')}
   }finally{if(active)setLoading(false)}
  }
  void load();
  return()=>{active=false;controller.abort()};
 },[refresh]);
 function refreshData(){setLoading(true);setError('');setData(null);setRefresh(value=>value+1)}
 return <section className="operations-center" aria-labelledby="operations-title" aria-busy={loading}>
  <div className="operations-heading"><div><h2 id="operations-title">网站运营日志中心</h2><p>查看网站访问、搜索、下载与资料更新的汇总情况。</p></div><button className="outline" disabled={loading} onClick={refreshData}><RefreshCw size={16} className={loading?'operations-spin':undefined}/>刷新统计</button></div>
  <p className="operations-privacy">按北京时间汇总，仅保留统计总量和热门型号。</p>
  {loading&&<p className="operations-loading" role="status" aria-live="polite">正在加载运营统计…</p>}
  {error&&<div className="operations-error" role="alert"><p>{error}</p><button className="outline" onClick={refreshData}>重新加载</button></div>}
  {data&&<>
   <div className="operations-kpis">
    <article className="operations-kpi"><UsersRound size={21}/><h3>累计访客 UV</h3><strong>{count(data.totals.visitors)}</strong><p>按匿名浏览器去重</p></article>
    <article className="operations-kpi"><Search size={21}/><h3>累计搜索</h3><strong>{count(data.totals.searches)}</strong><p>含文字搜索与拍照搜索</p></article>
    <article className="operations-kpi operations-kpi-download"><Download size={21}/><h3>累计下载</h3><strong>{count(data.totals.downloads.total)}</strong><p>四类原文件下载合计</p><dl><div><dt>PDF</dt><dd>{count(data.totals.downloads.pdf)}</dd></div><div><dt>视频</dt><dd>{count(data.totals.downloads.video)}</dd></div><div><dt>主图 / 其他图</dt><dd>{count(data.totals.downloads.image)}</dd></div><div><dt>详情图</dt><dd>{count(data.totals.downloads.detail)}</dd></div></dl></article>
    <article className="operations-kpi"><FolderSync size={21}/><h3>累计资料更新</h3><strong>{count(data.totals.adminMaterials.added+data.totals.adminMaterials.replaced)}</strong><p>新增 {count(data.totals.adminMaterials.added)} · 替换 {count(data.totals.adminMaterials.replaced)}</p></article>
    <article className="operations-kpi"><ChartColumn size={21}/><h3>本月浏览量 PV</h3><strong>{count(data.currentMonth.pageViews)}</strong><p>{data.currentMonth.month} · 页面访问次数</p></article>
   </div>
   <p className="operations-footnote">{data.collectedSince?'统计开始于 '+collectedDate(data.collectedSince)+'。':'尚未收到有效统计记录。'}</p>
   <section className="operations-report" aria-labelledby="operations-monthly-title"><div className="operations-report-title"><h3 id="operations-monthly-title">月度访问次数（自然月）</h3><p>按月份汇总页面浏览量。</p></div><div className="operations-table-scroll" tabIndex={0} role="region" aria-label="月度访问次数表"><table className="operations-table"><thead><tr><th scope="col">月份</th><th scope="col">浏览量 PV</th></tr></thead><tbody>{data.monthly.length?data.monthly.map(month=><tr key={month.month}><th scope="row">{month.month}</th><td>{count(month.pageViews)}</td></tr>):<tr><td colSpan={2} className="operations-empty">暂无月度访问记录</td></tr>}</tbody></table></div></section>
   <section className="operations-report" aria-labelledby="operations-models-title"><div className="operations-report-title"><h3 id="operations-models-title">热门搜索型号</h3><p>累计搜索命中次数，仅展示产品型号。</p></div>{data.hotModels.length?<div className="operations-table-scroll" tabIndex={0} role="region" aria-label="热门搜索型号表"><table className="operations-table operations-models-table"><thead><tr><th scope="col">排名</th><th scope="col">产品型号</th><th scope="col">搜索命中次数</th></tr></thead><tbody>{data.hotModels.map((model,index)=><tr key={model.model}><td>{index+1}</td><th scope="row">{model.model}</th><td>{count(model.count)}</td></tr>)}</tbody></table></div>:<p className="operations-empty">暂无型号搜索记录</p>}</section>
  </>}
 </section>;
}
