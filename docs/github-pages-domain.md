# 完整网站使用 shuanglu-battery.cn

核对日期：2026-10-19（北京时间）。

## 最终访问方式

正式目标为 https://shuanglu-battery.cn/ 。域名直接连接现有 Sites 项目，继续使用原有数据库、文件存储、登录和上传功能。访客浏览页面和使用站内功能时保留自有域名；登录服务自身的授权页面可能显示身份提供方的域名，完成登录后应回到自有域名。

当前可用入口仍为 https://shuanglu-visual-center.taofangzhou1231.chatgpt.site 。自定义域名已登记在同一个公开 Sites 项目中，最新刷新结果为 `pending`，SSL 为 `pending_validation`。这不是已完成上线的状态。

## GitHub Pages 与完整应用的分工

仓库已为 Public，Pages 已启用，最近一次发布源为 `main`。完整应用依赖服务端身份认证、D1 数据库、R2 存储与上传 API，不能由 Pages 静态托管执行。

仓库根目录中将自有域名分配给 Pages 的 `CNAME` 已移除。请检查 [Pages 设置](https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/settings/pages) 的 **Custom domain**；如果仍显示 `shuanglu-battery.cn`，点击 **Remove**。保留 GitHub 账号中的域名所有权验证；不需要删除验证 TXT。

`gh-pages` 分支保留为备用静态跳转页，目前指向已有的 Sites 地址。它不承担自有域名上的完整应用，也不应添加该根域名的 CNAME。Sites 域名验证成功后，可选择将备用跳转页目标改为自有域名。

## 阿里云 DNS 记录

在 `shuanglu-battery.cn` 的 DNS 管理页面设置以下记录。记录值来自 Sites 本次刷新返回结果。

|记录类型|主机记录|记录值|
|---|---|---|
|A|@|162.159.143.30|
|A|@|172.66.3.26|
|TXT|_openai-site-verification|openai-site-verification=yVN5tGyTuIjrSs8a6t3j1nGuLUjxQQFqnDKkuJlwSYE|
|TXT|_cf-custom-hostname|e28387b4-5e70-4655-ac0c-15c5da509220|

主域名只使用以上两项 Sites A 记录。若 `@` 当前存在 GitHub Pages 的 `185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153` 或其他旧网站 A 记录，需要替换为上面的 Sites 记录。不要同时给 `@` 添加 CNAME；若存在旧主机的 AAAA 或 ALIAS/ANAME，也需核对并避免将部分访客导向旧网站。保留邮箱 MX 和必要的 TXT，包括 GitHub 域名所有权验证 TXT。不要只设置 URL 转发或用 iframe 包裹原网站。

截图中的 GitHub Verified 仅证明域名所有权，不代表 DNS 已指向 Sites，也不代表证书已就绪。当前会话未连接阿里云 DNS 管理账号，尚未修改或核验实际解析。

本次只调整主域名方案；已有 `www` / `admin` 子域名的独立配置记录见 [ALIYUN_DEPLOY.md](../ALIYUN_DEPLOY.md#www--admin-子域名记录)。

## 验证完成的条件

1. DNS 生效后，刷新 Sites 域名验证，确认域名与 SSL 状态均为 `active`。
2. 打开 https://shuanglu-battery.cn/ ，确认地址栏保留该域名并显示资料中心首页。
3. 访问 https://shuanglu-battery.cn/api/catalog ，确认同域 API 正常返回产品资料。
4. 从首页进入产品、浏览图片、下载文件，再验证管理员登录及上传；身份验证完成后应回到自有域名。
5. 域名验证与实际使用检查均通过后，再将 README 的“当前可用入口”和可选 Pages 跳转目标统一改为自有域名。

目前 DNS、证书和自有域名上的完整流程尚未验收，不能把配置准备完成视为已上线。
