# ECS 独立托管验收记录

验证日期：2026-10-28（北京时间）。环境：Linux x64、Node.js 24.19.0、Chromium、本地 Next.js 生产发布包。

## 已验证

- `npm ci --dry-run`：新 npm 锁文件与依赖声明一致。
- `npm run typecheck`：类型检查通过。
- `npm test`：管理员/访客签名会话、SQLite 持久化、不可覆盖媒体、上传与原图下载、206/416 分段读取、ZIP 文件内容、版本冲突、跨站写入拒绝、伪造平台身份拒绝均通过。
- 迁移工具测试 10/10 通过，包含线上 HTTP、离线备份及 ECS current 软链接入口；缺失原文件、校验失败、超限、超时或安全拦截 HTML 均不会提交产品目录，原有其他数据表保留。
- `npm run build`：正式 Next.js standalone 构建通过，无 Cloudflare/Sites 构建插件。
- `node tests/production-smoke.mjs /路径/解压后的发布包`：真实生产 Node 服务配合 Chromium，验证页面资源、密码登录、管理工作台、成功/失败退出处理、收藏刷新保留；真实 HTTP 接口验证上传、下载、Range、ZIP 与匿名写入拒绝。浏览器没有异常或向外部托管平台发起请求。测试使用临时数据及固定测试凭据，未使用真实管理员密码。
- `deploy/*.sh` 分别通过 `bash -n`；发布包检查包含静态文件、favicon、迁移工具及域名文档，没有重复 public/public、运行数据或秘密环境文件。

浏览器测试需要本机安装 Chromium，可用 `CHROMIUM_PATH` 指定其可执行文件。该项验证随包静态资源和测试上传素材，不表示旧站全部媒体已迁移；不会访问正式域名或 ECS。业务测试使用临时目录，不会改动线上目录或素材。

## 尚待实际 ECS 完成

当前没有服务器登录通道，因此未在 123.56.252.14 安装运行时、启动 systemd/nginx、部署证书、迁移真实线上资料或修改 DNS。nginx 未安装于本地验证环境，systemd 验证受沙箱限制，需在 ECS 执行 `nginx -t` 并检查服务。

部署步骤见 [ALIYUN_DEPLOY.md](ALIYUN_DEPLOY.md)。正式域名切换之前必须补齐线上媒体并验收；已有 ChatGPT 账户收藏不会自动转换成新的浏览器收藏。
