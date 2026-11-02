# ECS 下载完整备份：断点续传与 64 MiB 分片

原备份已经发布在 [GitHub Release](https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/releases/tag/data-backup-20261102T045044Z-41390483790)：

- 文件：`pairdeer-complete-data-backup-20261102T045044Z.tar.gz`
- 完整大小：`575174060` 字节。
- SHA256：`44a07874a52db0a6d85d1d9b84318c3479c93b7d2b4b197610c8b04d790c514a`。

下载中出现 curl 52 或 HTTP/2 `PROTOCOL_ERROR`（92），不代表备份文件已损坏，也不应删除已经下载的约 230 MB。先保留原文件，用 HTTP/1.1 断点续传；如果长连接仍不稳定，可使用同一备份的分片。以下方式都不重新读取旧网站、不涉及 Sites 登录，也不改变服务器配置或 DNS。

## 方式一：保留原文件，用 HTTP/1.1 继续

**在原来下载压缩包的目录执行**，保持相同文件名。以下命令兼容 ECS 中的 curl 7.61.1：

```bash
archive=pairdeer-complete-data-backup-20261102T045044Z.tar.gz
release_url=https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/releases/download/data-backup-20261102T045044Z-41390483790
expected_sha=44a07874a52db0a6d85d1d9b84318c3479c93b7d2b4b197610c8b04d790c514a

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --http1.1 --fail --location --continue-at - \
      --connect-timeout 30 --speed-limit 1024 --speed-time 120 \
      --output "$archive" "$release_url/$archive"; then
    break
  fi
  # If the final connection ended after all bytes arrived, verify rather than
  # requesting a range beyond the complete file.
  if [[ -f $archive ]] && [[ $(stat -c '%s' "$archive") -eq 575174060 ]]; then
    break
  fi
  sleep 5
done

[[ -f $archive ]] && [[ $(stat -c '%s' "$archive") -eq 575174060 ]] \
  && printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c -
```

只有最后出现该文件 `OK` 才表示下载完整。未达到完整大小时保留文件，之后可重新执行相同命令继续；完整大小一致但 SHA 不一致时不要解压，需要改用逐片校验或重新取得正确文件。

注意：

- `--continue-at -` 根据现有文件长度恢复；不要使用 `>>` 追加输出。
- 使用上面的固定 Release 地址，不要复制浏览器中临时签名的重定向地址。
- curl 7.61.1 的 `--retry` 不覆盖所有断连错误，因此这里用外层循环；该版本不支持 `--retry-all-errors`。
- 服务端若不支持 Range，可能返回 33；文件已经完整时，继续请求可能遇到 416。以已知字节数和 SHA 为准，不要无限重试。
- 本说明只校验压缩包一项；原 `SHA256SUMS` 还列出其他下载件，直接全量校验但未下载它们会提示缺少文件。

## 方式二：自动下载和校验 9 个分片

[split-backup-archive.yml](../.github/workflows/split-backup-archive.yml) 只读取已发布的上述压缩包，核对完整大小和 SHA 后分成 64 MiB 的块。它将新资产上传到同一个 Release，不修改原压缩包或原 `SHA256SUMS`。

分片发布任务成功后，同一个 Release 中应包含：

- `<原压缩包名>.part-001` 到 `.part-009`：前 8 片各 `67108864` 字节，第 9 片 `38303148` 字节。
- `PARTS.json`：整包及每片的名称、大小和 SHA256。
- `PARTS.SHA256SUMS`：每片和小型下载工具的 SHA256。
- `download-backup-parts.mjs`：Node.js 24 下载工具。

本说明中的分片下载方式，以该工作流运行成功且 Release 已显示这些新资产为前提。文件名相似不代表已发布齐全；若出现 404，先核对工作流结果。

ECS 需要已安装 Node.js 24。将小型下载工具放在 `/tmp`，指定**现有压缩包所在目录**，例如它在 `/tmp/pairdeer-backup/`：

```bash
release_url=https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/releases/download/data-backup-20261102T045044Z-41390483790
curl --http1.1 --fail --location --retry 5 \
  --connect-timeout 30 --output /tmp/download-backup-parts.mjs \
  "$release_url/download-backup-parts.mjs"
node /tmp/download-backup-parts.mjs --directory /tmp/pairdeer-backup
```

工具会保留已有整包及其已下载前缀，逐片下载并验证，使用 HTTP/1.1、断点续传和有限重试；默认同时下载 2 片。只有全部分片和拼接结果都通过 SHA 校验后，才用完整文件替换原先的未完成下载。

如果 `node` 不在当前 PATH，使用服务器实际的 Node.js 24 路径，例如 `/usr/local/bin/node`。如果原压缩包在其他目录，将 `--directory` 改成那个目录，不要先删除原文件。

## 下载完成后

再核验整包：

```bash
cd /实际备份目录
printf '%s  %s\n' \
  44a07874a52db0a6d85d1d9b84318c3479c93b7d2b4b197610c8b04d790c514a \
  pairdeer-complete-data-backup-20261102T045044Z.tar.gz | sha256sum -c -
```

确认 `OK` 后，将完整压缩包解压到新的空目录，按 [完整备份说明](SITES_DATA_BACKUP.md)逐文件校验，再按 [ECS 部署说明](../ALIYUN_DEPLOY.md)执行离线导入。不要在下载途中解压或拿不完整文件执行数据恢复。
