# 双鹿电池 · 网销视觉资料中心

产品资料浏览、搜索、分类、图片/视频预览、原图及素材 ZIP 下载，以及管理员资料编辑与上传。

本分支将运行方式改为 **阿里云 ECS 独立托管**：Next.js 16 / Node.js 24 LTS + SQLite + ECS 磁盘文件存储。页面、接口、数据库、素材读取和管理员登录均在自己的服务器运行，正常使用不再需要 Sites / `chatgpt.site`。GitHub 用于保存源码，不通过 GitHub Pages 执行这个全栈应用。

目标服务器为 Alibaba Cloud Linux 3、2 核 / 2 GiB、40 GiB 磁盘，公网 IP `123.56.252.14`；目标域名为 `https://shuanglu-battery.cn/`。这些是部署配置目标，**代码变更不代表服务器、素材或 DNS 已完成切换**。

## 本地运行

安装 Node.js 24 LTS，按仓库锁文件安装依赖。复制 `.env.example` 为 `.env.local`，填写至少 12 字符的 `ADMIN_ENTRY_PASSWORD`、至少 32 字符的随机 `ADMIN_SESSION_SECRET`。本地 HTTP 调试另设 `ALLOW_INSECURE_COOKIES=1`，仅在非生产环境生效。

```bash
npm ci
npm run dev
```

打开 `http://localhost:3000`。管理员入口为 `/?admin=1`，使用服务器配置的管理员密码，验证成功后取得一小时的签名 HttpOnly 会话。原 ChatGPT 登录、邮箱白名单及首次认领机制不再用于授权。

## 数据与素材

- `DATA_DIR` 默认 `./data`；生产使用 `/var/lib/pairdeer`，独立于每次发布的程序目录。
- SQLite 数据及媒体文件持久化到此目录，重启或替换程序版本不会清空资料。
- 主分支包含 `public/assets/` 等早期素材，**没有全部线上 R2 原图和最新产品数据库**。切换前必须导出并导入当前线上资料或完整备份，不能以仓库 seed 代替完整迁移。
- 收藏通过签名浏览器标识保存在服务器，限当前浏览器使用；不再按 ChatGPT 账号跨设备同步，旧账号收藏不会自动归属到新浏览器。
- 管理员上传支持 JPG/PNG/WebP/GIF/MP4/WebM，单文件最大 50 MiB。移除素材引用不物理删除共享文件。

导入工具为 `scripts/migrate-sites.mjs`，支持从旧网站导出及从完整离线备份导入。具体命令见 [阿里云部署说明](ALIYUN_DEPLOY.md)。

## 生产部署

使用 Next.js standalone 发布包，在 ECS 上由 systemd 运行 Node 服务，绑定 `127.0.0.1:3000`；nginx 提供 HTTPS，正式域名指向 ECS 公网 IP。默认不需要另购 RDS 或 OSS。

```bash
bash deploy/package-release.sh
```

在 Linux x64 环境构建；2 GiB ECS 建议接收已经构建好的发布包，避免生产主机承担依赖安装和构建峰值。安装、HTTPS、备份、回滚、域名切换流程见 [ALIYUN_DEPLOY.md](ALIYUN_DEPLOY.md)；DNS 最后切换，具体记录见 [域名说明](docs/github-pages-domain.md)。

原 `aliyun-service/` 是可选的 PostgreSQL + OSS 适配器，不是本次独立 ECS 应用的启动入口；默认部署不要另行启用这些接口。

## 验证

执行仓库中的类型检查、测试及生产构建后，再验证一次完整业务流程：匿名浏览和下载 → 管理员登录 → 上传素材并保存产品 → 另一浏览器读取新数据 → 重启服务后数据仍存在。确认匿名请求无法修改资料、过期或篡改的会话无法写入。

迁移后的网络请求应只访问自有站点及显式配置的可选存储服务；浏览、下载、上传及管理均不应调用旧 Sites 身份或存储接口。部署状态以 ECS 实测为准。
