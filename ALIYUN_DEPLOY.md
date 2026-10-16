# 阿里云接入操作说明

当前网站已经有真实云数据库和云存储。以下步骤将产品资料和后续上传切换到你自己的阿里云；账号收藏与唯一管理员绑定继续由 Sites 数据库维护。

## 1. 准备服务

在阿里云 ECS 或支持 Node.js 22 的托管平台部署本工程中的 `aliyun-service/`，同时保留上一级 `lib/seed.json`。适配器通过 HTTPS 暴露 `/catalog` 和 `/sign`，网站通过带密钥的服务器请求调用，浏览器不会拿到服务密钥。

进入 aliyun-service，运行 `npm install`。复制 `.env.example` 为 `.env`，填写：

- `SERVICE_TOKEN`：至少32字符的高强度随机令牌。
- `DATABASE_URL`：RDS PostgreSQL 的连接串；账号密码和库名按实际填写。服务使用 SSL 验证连接。
- `ALIYUN_OSS_ACCESS_KEY_ID` / `ALIYUN_OSS_ACCESS_KEY_SECRET`：限定 Bucket 权限的 RAM 凭证。
- `ALIYUN_OSS_BUCKET`：Bucket 名。
- `ALIYUN_OSS_REGION`：如 oss-cn-hangzhou，与实际地域一致。
- `ALIYUN_OSS_PUBLIC_BASE_URL`：图片可读取的 HTTPS 基础地址，或已经配置好的 CDN 域名。

先运行 `npm run migrate` 创建 visual_catalog 表，再 `npm start`。服务默认8080，由反向代理提供 HTTPS。RDS 白名单允许该服务主机连接；不要向互联网开放数据库端口。

## 2. OSS Bucket

选择与服务器相近的地域。给 RAM 用户设置仅目标 Bucket/visual-assets 前缀的所需访问权限。

当前适配器返回可读取的图片 URL，因此需要公开只读的素材目录/公开读取策略或已经接通读取的 CDN。不要开放公共写入权限。如必须使用私有 Bucket，需另加带鉴权的读取代理或短时读取签名，当前代码不能直接使用私有 URL 展示。

Bucket 跨域设置：

- 来源：当前 Sites 实际访问域名，以及准备上线的 https://shuanglu-battery.cn；使用精确来源。
- 方法：PUT、GET、HEAD。
- 允许请求头：Content-Type。
- 暴露响应头：ETag。

浏览器使用服务端生成的15分钟 OSS V4 PUT URL直接上传，不经网站中转文件内容。

## 3. 配置 Sites 秘密环境变量

- `ALIYUN_SIGNER_URL=https://你的适配器域名/sign`
- `ALIYUN_SIGNER_TOKEN=与SERVICE_TOKEN一致`
- `CATALOG_API_URL=https://你的适配器域名/catalog`
- `CATALOG_API_TOKEN=与SERVICE_TOKEN一致`

重新发布网站后生效。可单独启用 OSS 或 PostgreSQL；未启用的部分继续使用现有云存储。

第一次启用 PostgreSQL 会导入随工程提供的59款随包产品，**不会自动迁移 Sites 上后来新增的数据**。切换前先从当前 `/api/catalog` 导出 data，用备份替换适配器读取的 seed.json，核对后再启用。已在 Sites 云存储中的文件仍由原站点地址提供；更换整个托管平台时需迁移这些文件并更新 URL。

## 4. 验收一次实际上传

管理员入口 → 编辑产品 → 添加主图 → 选一张 JPG → 保存并发布。看到上传成功后，在另一设备打开产品页面；检查新图能显示和下载，再检查 OSS 对应 visual-assets 对象及 PostgreSQL 记录版本。

如失败：签名失败查服务端环境变量；PUT失败查OSS跨域、地域、权限和凭证；图片无法显示查读取权限与图片基础URL；资料冲突重新加载后再编辑。任何错误都保留尚未发布的产品编辑内容。

## 域名

前台和管理员共用 shuanglu-battery.cn，无需为管理员另购域名。阿里云适配器可使用 api.shuanglu-battery.cn 子域名，或托管服务提供的 HTTPS 域名。按 Sites 返回的实际记录配置主域名，不要自行猜测 A/CNAME 值。解析和证书验证完成之前，使用 Sites 已发布链接验收。

## 本次已申请的域名绑定记录

Sites 已接受 `shuanglu-battery.cn`，目前等待 DNS 验证。请在阿里云 DNS 中设置以下记录；若 `@` 已指向其他正在使用的网站，请先核对，避免直接覆盖现有业务。

|记录类型|主机记录|记录值|
|---|---|---|
|A|@|162.159.143.30|
|A|@|172.66.3.26|
|TXT|_openai-site-verification|openai-site-verification=yVN5tGyTuIjrSs8a6t3j1nGuLUjxQQFqnDKkuJlwSYE|
|TXT|_cf-custom-hostname|e28387b4-5e70-4655-ac0c-15c5da509220|

根域名使用上述 A 记录；不要同时为 @ 添加 CNAME。证书初始化与 DNS 验证可能需要等待。以上记录来自本次 Sites 返回结果，若以后重新建立域名绑定，以届时返回值为准。

## www / admin 子域名记录

|记录类型|主机记录|记录值|
|---|---|---|
|CNAME|www|custom-domains.chatgpt.site.|
|TXT|_openai-site-verification.www|openai-site-verification=dBCEaWO7Fdoy1hjNB2xht8jNEnuqFlB7vx1BgC5ydwE|
|TXT|_cf-custom-hostname.www|173f515f-9656-4a90-99bb-197daa14069b|
|CNAME|admin|custom-domains.chatgpt.site.|
|TXT|_openai-site-verification.admin|openai-site-verification=DceZhfqvv-oW2XBdY6NbKIhEgHYcXXDYaxfb9LdYNtY|
|TXT|_cf-custom-hostname.admin|aefbf8f4-20ba-453b-9a34-9dbb08e71f7b|

www 为浏览首页入口，admin 为管理工作台入口。两者使用同一产品API、数据库及素材仓库。管理员子域名本身不替代权限校验，所有写入与上传 API 均在服务端验证管理员身份。公网浏览者可看资料，但不会获得写入权限。
