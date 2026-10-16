import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'双鹿电池 · 网销视觉资料中心',description:'双鹿电池官方产品资料：电商主图、详情页、产品参数与素材下载。',icons:{icon:'/favicon.svg'}};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
