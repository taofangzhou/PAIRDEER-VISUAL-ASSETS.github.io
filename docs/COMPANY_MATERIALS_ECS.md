# 公司介绍 PDF 与视频：ECS 更新步骤

网站的「双鹿电池介绍PDF」「公司介绍视频」位于首页导航中「素材使用指南」之后。前者使用您提供的 `26双鹿电池介绍PPT.pdf`，访客可以直接预览和下载原 PDF；后者播放、下载原 MP4。管理员登录原后台后可以分别替换 `.pdf`、`.mp4`。所有文件由 **您自己的 ECS** 提供，不需要文档转换软件或外部预览服务。

本说明适用于已经按仓库标准部署的站点：`/opt/pairdeer/current`、systemd `pairdeer`、数据目录 `/var/lib/pairdeer`、nginx 配置 `/etc/nginx/conf.d/pairdeer.conf`。以下命令均在阿里云 ECS **Workbench 终端**执行。它们不会更改管理员密码、域名解析或证书。

## 1. 检查现有网站

先执行：

```bash
node -v
sudo systemctl status pairdeer --no-pager
curl --fail http://127.0.0.1:3000/api/health
free -h
df -h / /tmp /var/lib/pairdeer
```

需要 Node.js 24 或以上。保留足够空间容纳源码、依赖、构建产物及当前数据备份；建议至少有 5 GiB 可用空间。2 GiB ECS 在本机构建时建议有至少 2 GiB SWAP。已有足够 SWAP 时跳过下列命令；无 SWAP 且磁盘充足时，可为此次构建准备：

```bash
set -euo pipefail
if [ "$(awk '/SwapTotal:/ {print $2}' /proc/meminfo)" -lt 2097152 ]; then
  sudo install -d -m 700 /var/swap
  if sudo test -e /var/swap/pairdeer-build.swap; then
    echo '构建 SWAP 文件已存在，请先检查 swapon --show；本段不会覆盖它。'
    exit 1
  fi
  sudo dd if=/dev/zero of=/var/swap/pairdeer-build.swap bs=1M count=2048 status=progress
  sudo chmod 600 /var/swap/pairdeer-build.swap
  sudo mkswap /var/swap/pairdeer-build.swap
  sudo swapon /var/swap/pairdeer-build.swap
fi
swapon --show
```

此 SWAP 不修改 `/etc/fstab`，重启服务器后不会自动启用。它位于应用数据目录之外，不会混入网站资料备份。

仓库已经包含 `public/assets/company/company-introduction.pdf` 与 `company-introduction.mp4`。发布包会同时包含它们；完成下一步部署后即可预览、下载这两个文件，无需再次上传。

## 2. 获取新代码、保留数据并部署

将以下**整个代码块**复制到同一个 Workbench 终端执行。源码放在自动生成的新目录，不会覆盖您原来的源码目录。稀疏检出排除与本次构建无关的历史大备份目录，减少下载量。

```bash
set -euo pipefail
test "$(node -p 'process.versions.node.split(".")[0]')" -ge 24
sudo systemctl is-active --quiet pairdeer
sudo bash /opt/pairdeer/current/deploy/backup.sh

if ! command -v git >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y git
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y git
  else
    sudo yum install -y git
  fi
fi

PAIRDEER_SOURCE_DIR=$(mktemp -d /tmp/pairdeer-company-source.XXXXXX)
git clone --depth 1 --filter=blob:none --sparse --branch main \
  https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io.git \
  "$PAIRDEER_SOURCE_DIR"
git -C "$PAIRDEER_SOURCE_DIR" sparse-checkout set --no-cone '/*' '!/backup/'
cd "$PAIRDEER_SOURCE_DIR"

npm ci --cache "$PAIRDEER_SOURCE_DIR/work/npm-cache"
NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1536 npm run build
bash deploy/package-release.sh --skip-build "$PAIRDEER_SOURCE_DIR/work/releases"

# 只调整本网站的公司素材上传 location，缺少 Python3 时会自动安装。
# 原 nginx 文件会备份，校验或重载失败会恢复它。
sudo bash deploy/update-company-materials.sh

PAIRDEER_ARCHIVE=$(find "$PAIRDEER_SOURCE_DIR/work/releases" -maxdepth 1 -type f -name 'pairdeer-*.tar.gz' -print -quit)
test -n "$PAIRDEER_ARCHIVE"
sudo env PATH=/usr/local/bin:/usr/bin:/bin bash deploy/install-release.sh "$PAIRDEER_ARCHIVE"

curl --fail http://127.0.0.1:3000/api/health
printf '\n本次源码目录：%s\n' "$PAIRDEER_SOURCE_DIR"
```

构建期间旧程序继续运行，构建失败不会安装新版本。安装器会重启服务并检查健康接口，失败时尝试退回上一程序版本。初始 PDF 与视频由发布包原文件直接提供；管理员替换的文件进入 ECS 的永久媒体目录。若现有资料库已经保存过后台替换版本，部署保留该版本，不覆盖管理员的更新。

`update-company-materials.sh` 使用 Python3 安全修改现有 nginx；缺少 Python3 时自动通过 `dnf`、`apt-get` 或 `yum` 安装。它保留现有证书路径、其他服务与根 `location /`，新上传接口单独允许 **250 MiB**、关闭请求缓存以流式写入 ECS，普通图片上传继续为 50 MiB。若您的 nginx 使用自定义路径、符号链接或复杂嵌套 location，脚本会停止并说明原因，请先核对现有配置。

## 3. 后台日常替换

打开 `https://shuanglu-battery.cn/?admin=1`，使用原管理员密码登录。进入「公司介绍资料」选项卡，在「双鹿电池介绍PDF」卡片点击「选择文件并替换发布」，选择新 PDF 并等待上传保存完成。视频卡片也有独立替换按钮，选择新 MP4 即可。文件直接保存到 ECS 并发布，无需重新构建或重启。

如需通过 Workbench 导入新 PDF：先用文件传输面板把原文件上传为 `/tmp/26双鹿电池介绍PPT.pdf`，然后执行下面的命令。此步骤仅供日后替换，首次部署无需执行；无需停止服务或输入管理员密码。

```bash
set -euo pipefail
sudo install -d -m 750 -o pairdeer -g pairdeer /var/lib/pairdeer/imports
sudo install -m 600 -o pairdeer -g pairdeer \
  '/tmp/26双鹿电池介绍PPT.pdf' \
  '/var/lib/pairdeer/imports/26双鹿电池介绍PPT.pdf'
sudo -u pairdeer env DATA_DIR=/var/lib/pairdeer PATH=/usr/local/bin:/usr/bin:/bin \
  node /opt/pairdeer/current/scripts/import-company-material.mjs \
  pdf '/var/lib/pairdeer/imports/26双鹿电池介绍PPT.pdf'
```

输出 `"ok": true` 才表示原 PDF 已保存、栏目引用已写入资料库。CLI 与后台都先完成上传，再使用 SQLite 版本检查更新栏目，保留现有产品、轮播和文字；失败不会替换当前栏目。

## 4. 将后台替换后的文件同步到自己的 GitHub 仓库

初始 PDF 与视频已经随功能代码进入 GitHub，首次部署无需再次推送。日后在后台替换文件后，若要同步仓库，继续在**第 2 步的同一个终端**执行以下内容。导出脚本将当前已发布的 PDF、MP4 与栏目默认信息复制到刚才的 Git 源码目录；不会导出管理员密码、SQLite 或其他私人配置。GitHub 普通 Git 文件最大 100 MiB；超过该大小时本段会停止，需要改用您自己的 Git LFS 或先优化文件。

```bash
set -euo pipefail
cd "$PAIRDEER_SOURCE_DIR"
sudo env DATA_DIR=/var/lib/pairdeer PATH=/usr/local/bin:/usr/bin:/bin \
  node /opt/pairdeer/current/scripts/export-company-materials.mjs "$PAIRDEER_SOURCE_DIR"
sudo chown -R "$(id -u):$(id -g)" \
  public/assets/company lib/company-materials-defaults.json
test -s public/assets/company/company-introduction.pdf
for PAIRDEER_ASSET in public/assets/company/company-introduction.pdf \
  public/assets/company/company-introduction.mp4; do
  if [ "$(stat -c '%s' "$PAIRDEER_ASSET")" -gt 104857600 ]; then
    echo "超过 GitHub 普通文件 100 MiB 限制：$PAIRDEER_ASSET。ECS 已有文件；仓库同步尚未完成。"
    exit 1
  fi
done
git add public/assets/company/company-introduction.pdf \
  public/assets/company/company-introduction.mp4 lib/company-materials-defaults.json
if ! git diff --cached --quiet; then
  git -c user.name='PAIRDEER ECS Asset Sync' \
      -c user.email='pairdeer-ecs@localhost' \
      commit -m 'Sync published company presentation and video from ECS'
  git push origin HEAD:main
else
  echo '仓库已包含相同公司素材，无需新提交。'
fi
```

如 GitHub 要求验证，在 Workbench 私下输入您的 GitHub 用户名和具备本仓库写入权限的凭据。GitHub HTTPS 推送通常需要 Personal Access Token，不能使用网站管理员密码。不要将 Token 发到聊天中、写入仓库或拼到远程 URL。已有 GitHub 凭据配置时，正常沿用它。推送提示版本已更新时，先 `git pull --rebase origin main`，核对后再 `git push origin HEAD:main`；不要强制推送。

后台新版本只有 `git push` 成功且仓库可以看到文件，才表示已同步 GitHub；ECS 上的成功替换不能代替这一步。后台不持有 GitHub Token 或自动推送；需要归档新版本时，再执行导出和提交步骤。新终端请先将 `PAIRDEER_SOURCE_DIR` 设置为第 2 步输出的实际源码目录。

## 5. 浏览器验收

打开 `https://shuanglu-battery.cn/`，刷新后检查新增的两个导航栏目。「双鹿电池介绍PDF」应能浏览并下载原 `.pdf`；视频应可播放、拖动进度并下载 `.mp4`。手机浏览器未内嵌 PDF 阅读器时，使用栏目提供的「打开预览」按钮查看。

单文件最多 250 MiB。上传替换会使用新的文件地址，避免浏览器继续读取旧缓存。

用另一个未登录的浏览器检查更新，再执行一次 `sudo systemctl restart pairdeer`，确认更新仍存在。无需改 DNS、重新配置管理员密码或保持聊天会话在线。

## 6. 日志、备份和回滚

```bash
sudo journalctl -u pairdeer -n 100 --no-pager
sudo nginx -t
sudo bash /opt/pairdeer/current/deploy/backup.sh
```

后台替换的 PDF、MP4 和栏目资料均在 `/var/lib/pairdeer`，会随现有备份脚本保存；初始文件同时保存在仓库和发布包。管理员密码仍只在 `/etc/pairdeer/pairdeer.env`，请单独私下备份。

程序需要退回上一版本时：

```bash
sudo bash /opt/pairdeer/current/deploy/rollback.sh
```

这只回滚程序，不删除资料。nginx 更新前的原文件保存在脚本输出的 `/var/backups/pairdeer-company-materials/时间-进程号/pairdeer.conf`；需恢复时请从该次实际备份恢复，然后 `sudo nginx -t && sudo systemctl reload nginx`。不要用旧数据库覆盖新资料。
