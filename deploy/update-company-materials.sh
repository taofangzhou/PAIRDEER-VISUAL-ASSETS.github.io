#!/usr/bin/env bash
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
if [[ $EUID -ne 0 || $# -gt 1 ]]; then
  echo 'Usage: sudo bash deploy/update-company-materials.sh [/etc/nginx/conf.d/pairdeer.conf]' >&2
  exit 1
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
config_file=${1:-/etc/nginx/conf.d/pairdeer.conf}
[[ -f $config_file && ! -L $config_file ]] || {
  echo "nginx 配置不存在或为符号链接，请核对：$config_file" >&2
  exit 1
}
id pairdeer >/dev/null 2>&1 || { echo '未找到现有 pairdeer 服务账号，请先按 ALIYUN_DEPLOY.md 完成首次部署。' >&2; exit 1; }
nginx -t

# Generate lightweight PDF page previews on this ECS. Python patches nginx;
# Poppler renders the PDF locally without an external preview service.
packages=()
if ! command -v python3 >/dev/null 2>&1; then packages+=(python3); fi
if ! command -v pdfinfo >/dev/null 2>&1 || ! command -v pdftoppm >/dev/null 2>&1; then packages+=(poppler-utils); fi
if ! command -v flock >/dev/null 2>&1; then packages+=(util-linux); fi
if [[ ${#packages[@]} -gt 0 ]]; then
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y "${packages[@]}"
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y "${packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y "${packages[@]}"
  else
    echo '请先安装 Python3、poppler-utils 和 util-linux，再执行本脚本。nginx 未修改。' >&2
    exit 1
  fi
fi
command -v python3 >/dev/null
command -v pdfinfo >/dev/null
command -v pdftoppm >/dev/null
command -v flock >/dev/null
pdfinfo -v
pdftoppm -v

backup_dir=/var/backups/pairdeer-company-materials/$(date -u +%Y%m%dT%H%M%SZ)-$$
install -d -m 700 "$backup_dir"
cp -p -- "$config_file" "$backup_dir/pairdeer.conf"
rollback_config() {
  cp -p -- "$backup_dir/pairdeer.conf" "$config_file"
  echo "已恢复 nginx 配置，备份位于 $backup_dir/pairdeer.conf" >&2
}
if ! python3 "$script_dir/patch-company-nginx.py" "$config_file"; then
  rollback_config
  exit 1
fi
if ! nginx -t; then
  rollback_config
  nginx -t
  exit 1
fi
if ! systemctl reload nginx; then
  rollback_config
  nginx -t && systemctl reload nginx
  exit 1
fi
echo "PDF 分页预览工具和 PDF/MP4 上传代理已就绪。nginx 原配置：$backup_dir/pairdeer.conf"
echo '现有证书、其他域名和 /api/upload 的限制均保留。'
