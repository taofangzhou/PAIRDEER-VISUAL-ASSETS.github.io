import firstBatch from './import-20261012.json';
import secondBatch from './import-20261013.json';
import thirdBatch from './import-20261013b.json';
import fourthBatch from './import-20261014.json';
import titles from './online-titles-20261014.json';
export const IMPORT_ID = 'titles-products-20261014';
const batches=[{id:'products-20261012-20',products:firstBatch},{id:'products-20261013-20',products:secondBatch},{id:'products-20261013-9',products:thirdBatch},{id:'products-20261014-6',products:fourthBatch}];
// Each batch is appended once; preserve administrator edits and subsequent removals.
export function applyCatalogImport<T extends {products:{id:string}[];_imports?:string[]}>(current:T):T {
 let result=current;
 for(const batch of batches){
  if(result._imports?.includes(batch.id))continue;
  const ids=new Set(result.products.map(p=>p.id));
  result={...result,products:[...result.products,...batch.products.filter(p=>!ids.has(p.id))],_imports:[...(result._imports||[]),batch.id]};
 }
 if(!result._imports?.includes(IMPORT_ID)){result={...result,products:result.products.map(p=>({...p,onlineTitle:(p as any).onlineTitle??(titles as Record<string,string>)[p.id]??''})),_imports:[...(result._imports||[]),IMPORT_ID]};}
 return result;
}
