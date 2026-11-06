import {GET as getCatalog} from '@/app/api/catalog/route';
import {resolveCompanyMaterials} from '@/lib/company-materials';
import {downloadUrl} from '@/lib/downloads';
import {recordDownload} from '@/lib/operations';
import {DownloadSourceError,downloadEventId,shouldRecordDownload,validateDownloadSource,type OriginalKind} from '@/lib/download-source';
import {fail} from '@/lib/server';

export const dynamic='force-dynamic';

function assetPath(value:string){
  try{return decodeURIComponent(new URL(value,'https://local.invalid').pathname)}
  catch{return value.split(/[?#]/,1)[0]}
}

async function download(req:Request){
  try{
    const query=new URL(req.url).searchParams;
    const company=query.get('company');
    const allowed=company!==null?['company','eventId']:['product','section','index','eventId'];
    for(const key of query.keys())if(!allowed.includes(key)||query.getAll(key).length!==1)throw new DownloadSourceError('下载请求格式无效');
    const eventId=downloadEventId(req);
    if(company!==null&&company!=='pdf'&&company!=='video')throw new DownloadSourceError('下载栏目无效');
    const productId=query.get('product');
    const section=query.get('section');
    const indexText=query.get('index');
    if(company===null&&(!productId||productId.length>200||!['main','detail','extra'].includes(section||'')||!indexText||!/^(?:0|[1-9]\d{0,8})$/.test(indexText)))throw new DownloadSourceError('下载请求格式无效');
    const response=await getCatalog();
    if(!response.ok)return response;
    const {data}=await response.json();
    const materials=resolveCompanyMaterials(data.companyMaterials);
    let original:string,kind:OriginalKind,counter:'pdf'|'video'|'image'|'detail',expectedSize:number|undefined;
    if(company==='pdf'||company==='video'){
      const material=materials[company];
      if(!material)throw new DownloadSourceError('资料不存在',404);
      original=material.url;kind=company;counter=company;expectedSize=material.size;
    }else{
      const product=data.products.find((item:{id:string})=>item.id===productId);
      if(!product)throw new DownloadSourceError('产品不存在',404);
      const field=section==='main'?'mainImages':section==='detail'?'detailImages':'extraImages';
      const value=product[field]?.[Number(indexText)];
      if(typeof value!=='string')throw new DownloadSourceError('产品素材不存在',404);
      original=downloadUrl(value);kind='image';counter=section==='detail'?'detail':'image';
      const paths=[assetPath(value),assetPath(original)],previewPages=materials.pdf?.previewPages?.map(assetPath)||[];
      if(paths.some(path=>path.startsWith('/assets/company/pdf-preview/')||previewPages.includes(path)))throw new DownloadSourceError('分页预览图不属于原文件下载',400);
    }
    const source=await validateDownloadSource(original,kind,expectedSize);
    if(shouldRecordDownload(req))await recordDownload(req,{kind:counter,eventId}).catch(()=>{});
    return new Response(null,{status:302,headers:{Location:source.location,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
  }catch(error){return fail(error,error instanceof DownloadSourceError?error.status:503)}
}

export const GET=download;
export const HEAD=download;
