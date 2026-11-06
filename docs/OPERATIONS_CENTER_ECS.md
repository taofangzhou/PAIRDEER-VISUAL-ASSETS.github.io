# 运营中心：最小统计与 ECS 缓存清理

登录 `https://shuanglu-battery.cn/?admin=1` 后打开「网站运营日志中心」。仅保留五项汇总，继续使用自己的 ECS、现有管理员密码和 SQLite，不引入外部统计平台。

| 指标 | 口径 |
| --- | --- |
| 累计访问人数 UV | 匿名浏览器首次识别累计数；不同设备、浏览器或清除 Cookie 可能重新计数。只保留 32 字节哈希，不保存首次访问日期或访问轨迹。 |
| 累计搜索及热门型号 | 明确提交非空搜索时累计，图片搜索也计一次；型号规范化汇总，不保存原始搜索词。输入过程与空搜索不计。 |
| 累计下载 | 分别统计 PDF、视频、图片、详情图原文件受理下载次数。预览、视频播放、PDF 翻页、HEAD、Range 和已登录管理员下载不计。ZIP 打包功能保留，不纳入这四类下载数。 |
| 管理员累计新增、替换素材 | 成功发布的原素材引用分别计数；未发布草稿、版本冲突、文字修改、自动生成的 PDF 预览图不计。 |
| 月度访问总次数 PV | 每月保存一条浏览量；打开首页、产品、公司 PDF 或视频栏目计数，后台、轮询、健康检查和预览图片请求不计。 |

日期使用北京时间 `Asia/Shanghai`，月度访问按自然月汇总。后台只展示累计数据、热门型号和月份访问表，不提供每日明细、个人轨迹或报表导出。

## 最小磁盘保存范围

统计库位于 `DATA_DIR/operations.sqlite`，标准位置 `/var/lib/pairdeer/operations.sqlite`。持久化内容只有一条累计计数、每月一条 PV、每个型号一条累计次数、访客去重哈希及短期去重标记。不保存 IP、User-Agent、原始搜索词、访问页面或逐条行为内容。

短期 UUID 去重标记使用 16 字节二进制，24 小时过期、最多 10,000 条；限流仅保存在内存。SQLite 限制 WAL 检查点与日志保留空间，旧表迁移后尝试压缩。精确的匿名浏览器去重仍需要每个浏览器保存一条哈希，空间随访客数增长；计数器与月度表占用很小。

测试环境中空库约 36 KiB；10,000 条匿名访客哈希约 428 KiB，仅代表该测试数据的数据库大小，不含其他实际活动及运行中 WAL 的额外占用。不是 ECS 当前磁盘实测。

若已有上一版运营库，升级会保留四类下载、搜索、管理员计数、月度 PV、热门型号、访客去重和 Cookie 密钥，移除旧逐日与磁盘限流表。统计从首次启用后开始，部署前的历史事件无法还原。

## 更新和清理旧构建缓存

Workbench 选择 **Shell**，使用 root 执行最新升级脚本。脚本会先获取同一升级锁、清理旧构建缓存，再检查构建需要的至少 5 GiB 可用空间。不会通过降低磁盘保护门槛强行构建。

```bash
curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 90 \
  -H 'Accept: application/vnd.github.raw+json' \
  'https://api.github.com/repos/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/contents/deploy/upgrade-company-materials.sh?ref=main' \
  -o /tmp/pairdeer-minimal-upgrade.sh && \
bash -n /tmp/pairdeer-minimal-upgrade.sh && \
bash /tmp/pairdeer-minimal-upgrade.sh
```

升级脚本从 GitHub 官方 API 获取并校验清理程序。旧构建只清理标准 `/opt/pairdeer-builds/company.XXXXXXXX` 内的 `node_modules`、`.next` 和 `work/npm-cache`。运行版本、进程正在引用的目录、符号链接目标、挂载目录和配置的数据目录均受保护。旧源码、公开素材、`.git`、发布包、`current`、`previous`、服务器配置、真实媒体及数据备份保留。

新构建在 npm 安装后立即回收下载缓存。成功安装或失败退出时，脚本尝试回收本次由它创建并持有随机标记的临时目录；仍被进程使用时保留并说明原因。日志在 `/var/log/pairdeer/`。清理日志显示前后可用空间；若仍不足 5 GiB，脚本在切换网站前停止，需要继续检查磁盘或扩容。

仅查看旧缓存清理候选（不删除）：

```bash
sudo python3 /opt/pairdeer/current/deploy/cleanup-build-cache.py
```

实际清理旧缓存（共享升级锁，无需停止网站）：

```bash
sudo python3 /opt/pairdeer/current/deploy/cleanup-build-cache.py --apply
```

这两个独立命令在本次新版安装后可用。首次更新由下载的升级脚本先执行同样的安全清理。

## 数据备份

更新继续备份整个 `/var/lib/pairdeer`，并在备份和切换阶段短暂停止、重启服务。备份包含产品资料、真实媒体、统计数据库及 SQLite WAL；管理员配置 `/etc/pairdeer/pairdeer.env` 独立私下保管。升级不清空现有统计。数据库、凭据及私人备份不会同步到 GitHub；GitHub 只保存源码和公开素材。
