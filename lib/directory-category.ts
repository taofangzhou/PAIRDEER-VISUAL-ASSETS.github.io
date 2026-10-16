// Display grouping requested for the product directory; retain technical product series.
export function directoryCategory(series:string):string {
 if(['碱性纽扣电池','极能碱性','智能锁专用碱性'].includes(series))return '碱性电池';
 return ['纽扣锂电池','纽扣电池','锂电池'].includes(series)?'纽扣电池':series;
}
