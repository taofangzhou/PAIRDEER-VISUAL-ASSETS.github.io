#!/usr/bin/env bash
set -euo pipefail
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

# Install conversion software on the user's ECS, never use an online Office
# viewer or send presentations to an external conversion service.
if command -v dnf >/dev/null 2>&1; then
  dnf install -y python3 libreoffice-impress fontconfig
  if [[ -z $(fc-list :lang=zh 2>/dev/null) ]]; then
    font_installed=0
    for font_package in google-noto-sans-cjk-ttc-fonts google-noto-sans-cjk-fonts wqy-zenhei-fonts; do
      if dnf -q info "$font_package" >/dev/null 2>&1; then
        dnf install -y "$font_package"
        font_installed=1
        break
      fi
    done
    [[ $font_installed == 1 ]] || { echo '系统仓库没有可用中文字体，请在 ECS 安装合法中文字体后重试。nginx 未修改。' >&2; exit 1; }
  fi
elif command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y python3 libreoffice-impress fontconfig fonts-noto-cjk
elif command -v yum >/dev/null 2>&1; then
  yum install -y python3 libreoffice-impress fontconfig
  if [[ -z $(fc-list :lang=zh 2>/dev/null) ]]; then
    font_installed=0
    for font_package in google-noto-sans-cjk-ttc-fonts google-noto-sans-cjk-fonts wqy-zenhei-fonts; do
      if yum -q info "$font_package" >/dev/null 2>&1; then
        yum install -y "$font_package"
        font_installed=1
        break
      fi
    done
    [[ $font_installed == 1 ]] || { echo '请在 ECS 安装中文字体后重试。nginx 未修改。' >&2; exit 1; }
  fi
else
  echo '仅自动支持 dnf/apt-get/yum，请手动安装 Python3、LibreOffice Impress 和中文字体。nginx 未修改。' >&2
  exit 1
fi
fc-cache -f
[[ -n $(fc-list :lang=zh 2>/dev/null) ]] || { echo '未检测到中文字体，nginx 未修改。' >&2; exit 1; }
converter=$(command -v libreoffice || true)
[[ -n $converter ]] || { echo 'LibreOffice 安装失败，nginx 未修改。' >&2; exit 1; }
"$converter" --headless --version

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
echo "LibreOffice、中文字体和公司素材上传代理已就绪。nginx 原配置：$backup_dir/pairdeer.conf"
echo '现有证书、其他域名和 /api/upload 的限制均保留。'
