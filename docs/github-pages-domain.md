# GitHub Pages 与 shuanglu-battery.cn

核对日期：2026-10-19（北京时间）。

## 当前状态

- GitHub 仓库：`taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io`，当前仍为 private，尚未启用 Pages。
- Sites：现有站点为 public，平台确认的正式入口为 https://shuanglu-visual-center.taofangzhou1231.chatgpt.site 。
- 自定义域名：`shuanglu-battery.cn` 已登记到该 Sites 项目；本次刷新仍为 `pending`，SSL 为 `pending_validation`。
- 当前连接可提交仓库文件，但未提供修改仓库可见性或 Pages 设置的管理接口；命令行 GitHub API 请求返回 `Forbidden`。当前会话也未连接阿里云 DNS 管理账号。

## GitHub 上还需完成的设置

1. 打开 [仓库设置](https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/settings)，在 General 页面底部的 Danger Zone → Change repository visibility 中改为 **Public**。按 GitHub 页面要求完成确认。
2. 打开 [Pages 设置](https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/settings/pages)，Source 选择 **Deploy from a branch**，Branch 选择 **gh-pages**，目录选择 **/(root)**，保存。
3. 等待 Pages 发布成功，访问 https://taofangzhou.github.io/PAIRDEER-VISUAL-ASSETS.github.io/ 。该入口自动打开当前正式 Sites 站点，也提供可手动点击的链接。

`gh-pages` 分支的当前文件树仅包含 `index.html` 和 `.nojekyll`。不需要构建完整应用，也不需要设置 Actions 密钥。Pages 的 Custom domain 留空；完整应用的自定义域名按下一节配置到 Sites。

该项目使用服务端身份认证、D1 数据库、R2 存储及上传 API，不能将整个应用直接部署为 GitHub Pages 静态网站。Pages 跳转页的目标暂时保留已经发布的 Sites 地址；域名验证成功后可再将跳转目标和 canonical 改为 https://shuanglu-battery.cn/ 。

## 阿里云 DNS 记录

在 `shuanglu-battery.cn` 的 DNS 管理页面配置以下记录。这些值来自本次 Sites 刷新结果。

|记录类型|主机记录|记录值|
|---|---|---|
|A|@|162.159.143.30|
|A|@|172.66.3.26|
|TXT|_openai-site-verification|openai-site-verification=yVN5tGyTuIjrSs8a6t3j1nGuLUjxQQFqnDKkuJlwSYE|
|TXT|_cf-custom-hostname|e28387b4-5e70-4655-ac0c-15c5da509220|

根域名使用这两项 A 记录，不同时设置 `@` CNAME。如果网站的 `@` A 记录仍指向 GitHub Pages 或其他旧主机，需要改为上面两项才能将网站流量送到 Sites。保留已有邮箱 MX、其他必要 TXT，以及 GitHub 域名所有权验证 TXT 记录。

截图中 GitHub 账号的 Verified 状态表示已验证域名所有权，不代表域名已经指向 Sites，也不代表 SSL 证书已经签发。

保存 DNS 后等待解析生效，再刷新 Sites 域名验证；只有域名状态和证书状态均为 active，才把 https://shuanglu-battery.cn/ 作为已经完成绑定的正式入口。现有 `www` / `admin` 子域名的配置见 [ALIYUN_DEPLOY.md](../ALIYUN_DEPLOY.md#www--admin-子域名记录)。
