# Sites 产品数据和素材完整备份

此功能按网站拥有者要求，将旧站的产品目录、原图、预览图和视频实际保存到本 GitHub 仓库，并生成可下载的完整资料备份包。它不修改旧 Site、不关闭旧站、不改变 ECS 或 DNS，也不作为请求转发代理。

## 当前状态与完成标准

截至本说明编写时（2026-11-02，北京时间），备份工作流已准备，但**尚未确认 GitHub 上已发布完整备份**。只存在目录 JSON、工作流代码或下载清单，不代表原始文件已经备份。

本次来源为 `https://shuanglu-battery.cn`，目录快照为 `migration/source-catalog-20261102-r5.json`（修订版 5）。该快照、下载映射和项目的历史导入对象清单声明了 468 个媒体对象。完整性范围为当前产品引用及这些已登记的历史素材；它不是 R2 桶的全量列举，无法证明未登记、从未被引用的孤立对象也已导出。工作流仅在以下条件全部满足后提交并发布：

- 导出清单明确标记 `complete: true`。
- 468 个媒体文件及对应元数据全部存在，没有缺失、额外文件或越界路径。
- 每个声明文件的实际字节数和 SHA256 与清单一致；`objects.json` 与完整清单逐项一致。
- 目录快照、公共静态素材和必要源清单的哈希通过复核。
- 仅 `backup/` 下指定数据文件作为备份变更提交；推送前再次检查源文件及备份内容。

如旧站返回 Cloudflare 403，导出立即失败。工作流不绕过拦截，不会把拦截页面存成图片，也不会为缺失文件生成占位内容；不会把失败导出标注为完整备份。

## 如何启动和查看结果

工作流为 [backup-sites-media.yml](../.github/workflows/backup-sites-media.yml)。它在首次进入 `main` 或该工作流文件后续改动时自动运行，也支持手动运行：

1. 打开仓库 **Actions → Back up complete Sites product media**。
2. 手动启动时点击 **Run workflow**，选择 `main`。
3. 打开本次运行，确认导出、复核、数据提交、压缩和 Release 发布均成功。

工作流只使用本仓库标准 `GITHUB_TOKEN`，不需要另行上传阿里云密钥或旧平台凭据。需允许仓库 Actions 运行，且具有本仓库内容写入权限；若仓库保护规则禁止机器人直接提交到 `main`，任务会失败并说明原因，不会强制推送或绕过规则。

并发任务串行执行；备份提交不会再次触发工作流，避免循环备份。若主分支同时更新，工作流以普通 fetch/rebase 与非强制 push 方式处理，再次验证后才推送；出现冲突或来源文件变化时停止。

## 仓库中保存的内容

成功后，以下文件是真实保存在 GitHub 的产品数据备份：

```text
backup/
  catalog.json              完整产品目录快照
  objects.json              媒体对象 SHA256、大小及 MIME 清单
  backup-manifest.json      完整性、来源和全部文件校验清单
  media/
    <对象文件名>             原始媒体字节
    <对象文件名>.metadata.json
```

已有的 `public/` 静态素材仍保留在仓库原位置。备份只覆盖产品目录和公开素材，不导出管理员密码、会话密钥、访问令牌或 ChatGPT 账户数据。

## 下载完整资料包

成功发布后，在仓库 **Releases** 找到 `data-backup-时间-运行编号`，下载：

- `pairdeer-complete-data-backup-时间.tar.gz`
- `SHA256SUMS`
- `backup-manifest.json`
- `objects.json`

如果 Release 发布遇到权限或服务故障，而前面的校验、提交及压缩已成功，可先在本次 Actions 运行的 **Artifacts** 下载同一组文件；该备份下载件保留 30 天。Release 下载件保留到仓库拥有者主动删除或平台策略另有变化。

将四个文件放在同一目录后验证：

```bash
sha256sum -c SHA256SUMS
```

全部通过后，将压缩包解压到新目录：

```bash
mkdir -p pairdeer-data-backup
tar -xzf pairdeer-complete-data-backup-实际时间.tar.gz -C pairdeer-data-backup
```

压缩包包含：

- `backup/`：产品目录、全部媒体、元数据及校验清单。
- `public/`：仓库中已有的完整公共静态素材。
- `lib/download-map.json`：预览图到原图的下载映射。
- `scripts/migrate-sites.mjs`、`scripts/export-sites-backup.mjs`：Node.js 24 导入和离线复核工具。
- `migration/source-catalog-20261102-r5.json`：本次导出所依据的目录快照。
- `README.md`、`ALIYUN_DEPLOY.md`、`deploy/` 和 `docs/`：恢复部署参考，以及重建已登记历史素材范围所需的清单。

如需解压后再次逐文件验证，在解压目录运行以下命令；它只读取本地文件，不请求旧站：

```bash
cd pairdeer-data-backup
node --input-type=module <<'NODE'
import {verifySiteBackup} from './scripts/export-sites-backup.mjs';
await verifySiteBackup({
  output: 'backup',
  projectRoot: process.cwd(),
  catalogFile: 'migration/source-catalog-20261102-r5.json',
  source: 'https://shuanglu-battery.cn',
});
console.log('已声明的产品资料及媒体文件全部校验通过');
NODE
```

这是上述清单范围内完整的**产品数据与素材备份**；当前应用源代码仍在仓库 `main`，压缩包不替代完整应用程序发布包。单个文件若超出正常 Git 的限制，或压缩包超过 Release 单文件限制，任务会停止，不会悄悄省略文件后发布。

## 恢复到自己的 ECS

先按 [ECS 部署说明](../ALIYUN_DEPLOY.md)安装应用，再停止新服务器的应用进程，使用备份包中的 `backup/` 作为离线导入来源：

```bash
sudo systemctl stop pairdeer
sudo -u pairdeer /usr/local/bin/node /实际路径/pairdeer-data-backup/scripts/migrate-sites.mjs \
  --backup-dir /实际路径/pairdeer-data-backup/backup \
  --data-dir /var/lib/pairdeer
sudo systemctl start pairdeer
```

请按服务器实际 Node.js 24 安装路径替换 `/usr/local/bin/node`，并确保 `pairdeer` 用户能读取解压目录。若数据目录已有正式产品资料，导入工具默认拒绝覆盖；先制作并验证现有数据备份，确认后才显式使用 `--replace`。

源站仍可用时也可按 ECS 部署说明在线迁移。完整备份核验和新 ECS 上的浏览、原图、ZIP、视频及管理员上传验收通过之前，保留旧站和现有域名解析。
