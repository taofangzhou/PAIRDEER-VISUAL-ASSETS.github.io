# 完整网站使用 shuanglu-battery.cn

核对日期：2026-10-19（北京时间）。

## 正式入口

正式网址：https://shuanglu-battery.cn/

管理员入口：https://shuanglu-battery.cn/?admin=1

域名直接连接现有公开 Sites 项目，继续使用原有数据库、文件存储、登录和上传功能。站内导航和 API 使用相对路径，不通过 GitHub Pages 跳转回原网站。身份提供方的授权页面可能显示其自身域名，完成登录后应返回自有域名；新域名使用独立 Cookie，需要重新登录。

原地址 https://shuanglu-visual-center.taofangzhou1231.chatgpt.site 保留为备用。

## 已验证状态与范围

2026-10-19 09:39–09:40（北京时间）核验结果：

- 阿里 DNS 与 Google DNS 均返回根域名两条正确 A 记录。
- Sites 域名状态 `active`，提供方状态 `active`，HTTPS 证书状态 `active`。
- 通过 https://shuanglu-battery.cn/ 读取到“ 双鹿电池 · 网销视觉资料中心 ”首页，显示 59 款产品。
- 通过同域 `/api/catalog` 读取并解析到 59 款产品的 JSON。
- 同域 `/api/session` 返回匿名访客状态，`admin: false`、`storage: "cloud"`。

本次使用外部抓取与平台状态核验，未进行真实浏览器的管理员登录、上传、下载或编辑实操，也未获取完整 HTTP 跳转链。源码已确认页面导航、API 和登录返回路径均为相对路径，不写死原 Sites 域名。

## GitHub Pages 与完整应用的分工

仓库为 Public，Pages 保持启用，当前发布源为 `main`。主分支的 `CNAME` 已移除，Pages 最新部署地址已恢复为 https://taofangzhou.github.io/PAIRDEER-VISUAL-ASSETS.github.io/ 。GitHub Pages 的 Custom domain 不再分配 `shuanglu-battery.cn`。

`gh-pages` 分支仅为备用静态跳转页，目标和 canonical 已统一为 https://shuanglu-battery.cn/ ，保留 `?admin=1` 等查询参数和页面锚点。如希望 GitHub 默认网址也自动跳转，可在 [Pages 设置](https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/settings/pages) 中选择 `gh-pages` / `/(root)`；这不影响正式自有域名的运行。

完整应用依赖服务端身份认证、D1 数据库、R2 存储与上传 API，由 Sites 提供，不能由 Pages 静态托管执行。

## 保留的阿里云 DNS 记录

以下记录已配置并核验。保留记录用于域名路由与后续验证，不要因当前已激活而删除验证 TXT。

|记录类型|主机记录|记录值|
|---|---|---|
|A|@|162.159.143.30|
|A|@|172.66.3.26|
|TXT|_openai-site-verification|openai-site-verification=yVN5tGyTuIjrSs8a6t3j1nGuLUjxQQFqnDKkuJlwSYE|
|TXT|_cf-custom-hostname|e28387b4-5e70-4655-ac0c-15c5da509220|

根域名保留以上两项 Sites A 记录，不同时配置旧 GitHub Pages A、其他旧主机地址或 `@` CNAME。保留邮箱 MX、其他必要 TXT 和 GitHub 账号域名所有权验证 TXT。不要使用 URL 转发或 iframe 包裹原网站。

本次只验证根域名；`www` / `admin` 子域名不在本次完成范围，其配置记录见 [ALIYUN_DEPLOY.md](../ALIYUN_DEPLOY.md#www--admin-子域名记录)。
