# 阿里云 ECS 独立部署

本分支把网站本身部署到 ECS，使用 Node.js 24 LTS、Next.js standalone、SQLite 和 ECS 磁盘存储。默认不使用 Sites、ChatGPT 登录、D1、R2、RDS 或 OSS。

目标：Alibaba Cloud Linux 3 x86_64，2 核 / 2 GiB，40 GiB 磁盘，公网 IP `123.56.252.14`，域名 `shuanglu-battery.cn`。公网带宽为 3 Mbps，原图/视频下载速度受此带宽限制；后续可配置自己的 OSS/CDN，但不影响本次独立运行。

这些文件是部署准备，不能替代实际服务器操作。本次源代码修改不会自动连接 ECS、导入线上素材、安装证书或修改 DNS。

## 1. 发布结构

| 路径 | 用途 |
| --- | --- |
| `/opt/pairdeer/releases/` | 每次构建的独立程序版本 |
| `/opt/pairdeer/current` | 当前程序版本软链接 |
| `/opt/pairdeer/previous` | 上一程序版本软链接 |
| `/var/lib/pairdeer/` | SQLite 及媒体文件，升级保留 |
| `/etc/pairdeer/pairdeer.env` | 仅服务器持有的密码、会话密钥和运行配置 |
| `/etc/nginx/conf.d/pairdeer.conf` | HTTPS 反向代理配置 |
| `/etc/nginx/ssl/` | 该域名的证书及私钥 |

Node 进程以 `pairdeer` 非 root 账号运行，仅监听 `127.0.0.1:3000`。nginx 监听 80/443。ECS 安全组与主机防火墙允许 80/443；SSH 仅按您的管理来源开放，不要开放 3000 或数据库端口。`TRUST_PROXY=1` 依赖随包 nginx 覆盖 `X-Real-IP`，不能把 Node 端口直接暴露给互联网。

## 2. 准备运行环境

通过阿里云 ECS 的 Workbench/SSH 登录此实例。安装 Node.js **24 LTS**，确认实际 `node -v` 为 v24 或更高受支持版本，`node` 位于 `/usr/local/bin` 或 `/usr/bin`。若现有系统不带 Node.js 24，可从 Node.js 官网获取 Linux x64 发行包，核验其 SHA256 后安装；不要用旧版本 Node.js 启动本项目的 SQLite 运行时。

Alibaba Cloud Linux 3 上安装 nginx 和脚本所需工具：

```bash
sudo dnf install -y nginx tar gzip curl openssl
node -v
```

先检查现有 nginx、80/443 端口和 `/etc/nginx/conf.d/` 是否承载其他业务，再添加本项目配置。不要直接覆盖其他站点。

## 3. 在构建机器制作发布包

建议在 Linux x64 的开发机或 CI 构建。2 GiB ECS 可运行应用，但构建会占用更多内存；不要在正在服务的进程旁反复构建。如果只能在 ECS 构建，请在维护窗口检查内存及已有 SWAP 后进行。

```bash
# 进入本分支检出目录，按仓库锁文件安装依赖。
npm ci
bash deploy/package-release.sh
```

脚本执行生产构建，生成 `work/releases/pairdeer-时间.tar.gz`，包含 standalone Node 服务、静态资源和部署工具，不含 `.env` 及线上 `data/`。发布包不包含那些从未进入 GitHub 的线上原图。

将生成的包和 `deploy/` 上传到 ECS，例如 `/tmp/pairdeer-deploy/`。也可以先在 ECS 检出本分支，仅从该目录执行部署脚本，而把构建任务放在另一台机器。

## 4. 初始化服务器配置并安装程序

在已上传本项目部署脚本的目录执行：

```bash
sudo bash deploy/init-env.sh
sudo env PATH=/usr/local/bin:/usr/bin:/bin bash deploy/install-release.sh /tmp/pairdeer-deploy/pairdeer-实际时间.tar.gz
sudo systemctl status pairdeer --no-pager
curl --fail http://127.0.0.1:3000/api/health
```

`init-env.sh` 为本机生成随机管理员密码和签名密钥，已有配置则拒绝覆盖。密码仅保存在 `/etc/pairdeer/pairdeer.env`，请在服务器内私下查看和保管。不要提交该文件。

默认配置：

```dotenv
NODE_ENV=production
APP_ORIGIN=https://shuanglu-battery.cn
DATA_DIR=/var/lib/pairdeer
TRUST_PROXY=1
ADMIN_ENTRY_PASSWORD=由初始化脚本生成
ADMIN_SESSION_SECRET=由初始化脚本生成
```

- `ADMIN_ENTRY_PASSWORD` 至少 12 字符，`ADMIN_SESSION_SECRET` 至少 32 字符；空值不启用管理员访问。
- 改动配置后执行 `sudo systemctl restart pairdeer`。更换会话密钥会使旧会话失效。
- 生产 Cookie 始终为 Secure，只能通过 HTTPS 登录。`ALLOW_INSECURE_COOKIES=1` 只供非生产本地 HTTP 测试，生产环境不会采用它。
- 普通访客浏览、素材下载不要求登录。管理员访问 `https://shuanglu-battery.cn/?admin=1`，输入服务器生成的密码即可，不需要 ChatGPT。

安装脚本更新程序软链接并重启服务，检查 `/api/health`；失败时尝试恢复上一程序版本。它不会配置 nginx、改 DNS 或删除已有数据。

## 5. 迁移产品资料和完整媒体

**必须在正式域名切换前完成。** GitHub 主分支缺少完整线上媒体，不能仅运行样本数据后就切换网站。

先暂停新服务器写入：

```bash
sudo systemctl stop pairdeer
```

如果旧站仍可访问，在 ECS 从旧网站读取当前产品目录与所需媒体：

```bash
sudo -u pairdeer env PATH=/usr/local/bin:/usr/bin:/bin node /opt/pairdeer/current/scripts/migrate-sites.mjs \
  --source https://shuanglu-battery.cn \
  --data-dir /var/lib/pairdeer
```

此时域名仍须指向旧站，否则会误向新站请求。旧平台仍可能拦截此导出请求；如遇到拦截，不要认为数据已迁移完成，改用完整离线备份。

离线完整备份目录应包含 `catalog.json` 和 `media/`，如有 `objects.json` 校验清单一并保留：

```bash
sudo -u pairdeer env PATH=/usr/local/bin:/usr/bin:/bin node /opt/pairdeer/current/scripts/migrate-sites.mjs \
  --backup-dir /路径/完整导出目录 \
  --data-dir /var/lib/pairdeer
```

先确保 `pairdeer` 账号有权读取导出目录。脚本默认拒绝覆盖已有产品目录；若此前接口读取已生成样本目录，应先备份 `/var/lib/pairdeer`，核对导入来源后，才在导入命令末尾显式追加 `--replace`。不要把种子数据误当成线上最新快照。

```bash
sudo systemctl start pairdeer
curl --fail http://127.0.0.1:3000/api/health
```

核对产品数量、轮播、文字、最新产品、原图及视频是否齐全，逐项检查迁移报告；仅目录导入成功不代表媒体文件齐全。旧的 ChatGPT 账号收藏不自动映射到新的签名浏览器收藏。

## 6. 配置 HTTPS 与 nginx

从阿里云证书管理控制台申请或下载 `shuanglu-battery.cn` 的 nginx 证书，将完整证书链和私钥安全上传到 ECS。证书域名必须匹配正式域名；以实际证书文件名为准。

```bash
sudo install -d -m 700 /etc/nginx/ssl
sudo install -m 644 /路径/完整证书链.pem /etc/nginx/ssl/shuanglu-battery.cn.pem
sudo install -m 600 /路径/证书私钥.key /etc/nginx/ssl/shuanglu-battery.cn.key
sudo install -m 644 deploy/nginx.conf /etc/nginx/conf.d/pairdeer.conf
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

如使用自己的证书目录，同步修改 nginx 的两条证书路径。证书续期后校验 nginx 并重新加载。

`deploy/nginx-bootstrap.conf` 仅用于切换前的 HTTP 浏览诊断，不能替代正式 HTTPS，不能用来验证生产管理员登录。如果使用 ACME 的 HTTP-01 方式申请证书，应按证书工具要求单独配置 challenge 位置；随包配置不自动申请证书。

nginx 运行但请求返回 502 时，查看应用服务与 SELinux/审计日志。若 SELinux 阻止 nginx 连接回环上游，可按本机策略启用所需权限，例如 `sudo setsebool -P httpd_can_network_connect 1`；不要通过关闭 SELinux 解决。

## 7. 切换前测试与 DNS

先用临时本机 hosts 映射测试，或在能访问 ECS 的机器执行（保留 TLS 校验）：

```bash
curl --resolve shuanglu-battery.cn:443:123.56.252.14 \
  --fail https://shuanglu-battery.cn/api/health
curl --resolve shuanglu-battery.cn:443:123.56.252.14 \
  --fail https://shuanglu-battery.cn/api/catalog
```

浏览器测试需要本机 hosts 将域名临时指向 ECS，测试完成后撤销该临时记录。测试浏览、搜索、筛选、原图与 ZIP 下载、视频、管理员登录、上传、编辑及另一个浏览器读取；重启 Node 服务后确认数据仍在。开发者工具的网络记录应不再出现 Sites / `chatgpt.site` 的应用请求。

验收通过后，在域名的阿里云解析控制台把 `@` 改为 A 记录 `123.56.252.14`，移除同名旧 Sites 的两条 A 记录 `162.159.143.30` 和 `172.66.3.26`。不要删除邮箱 MX 及其他服务必要记录。`www` 如需使用，需另行配置 DNS、nginx、证书和允许的站点来源；当前默认只承接根域名。

已有 ICP 备案还需核对其接入信息适用于本台阿里云实例。具体域名记录与回退方式见 [域名说明](docs/github-pages-domain.md)。

## 8. 日志、备份和回滚

```bash
sudo journalctl -u pairdeer -n 100 --no-pager
sudo systemctl restart pairdeer
sudo bash /opt/pairdeer/current/deploy/backup.sh
```

备份脚本短暂停止应用，保存 SQLite、WAL 及媒体文件的一致快照，然后恢复原先运行状态。默认输出到仅 root 可读的 `/var/backups/pairdeer/`。将备份另存到独立存储，并单独保管 `/etc/pairdeer/pairdeer.env`。40 GiB 磁盘需要监测余量，媒体和多份备份会持续占空间。

只回滚程序版本、不回滚数据：

```bash
sudo bash /opt/pairdeer/current/deploy/rollback.sh
```

需要恢复数据时先停止服务，把当前数据目录整体另行备份，再将已验证的快照解压到空的 `/var/lib/pairdeer`，恢复 `pairdeer:pairdeer` 所有权后启动。不要将旧备份直接混合解压覆盖新媒体目录。数据库结构不兼容时，程序和相应数据备份应一起恢复。

## 可选的 RDS / OSS 适配

默认不要设置 `CATALOG_API_URL`、`CATALOG_API_TOKEN`、`ALIYUN_SIGNER_URL`、`ALIYUN_SIGNER_TOKEN`；SQLite 和磁盘已满足独立部署。

仓库的 `aliyun-service/` 仅保留为可选 PostgreSQL 产品目录和 OSS 签名适配器。若后续启用，需独立部署并验证数据库、RAM 权限、OSS 读取策略和精确来源 CORS。若 ZIP 下载需要读取外部 OSS 原图，再设置 `MEDIA_ALLOWED_HOSTS` 为允许的 HTTPS 存储主机名列表（逗号分隔，仅主机名），不允许未列出的外链或重定向；它不是完整网站启动入口，也不应把阿里云密钥交给浏览器。
