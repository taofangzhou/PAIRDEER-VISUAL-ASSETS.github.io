#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then
  echo 'Run with sudo: sudo bash deploy/init-env.sh' >&2
  exit 1
fi
config_dir=/etc/pairdeer
config_file=$config_dir/pairdeer.env
install -d -m 700 "$config_dir"
if [[ -e $config_file ]]; then
  echo "$config_file already exists; preserving existing configuration." >&2
  exit 1
fi
umask 077
admin_password=$(openssl rand -hex 24)
session_secret=$(openssl rand -hex 32)
cat > "$config_file" <<ENV
NODE_ENV=production
APP_ORIGIN=https://shuanglu-battery.cn
DATA_DIR=/var/lib/pairdeer
TRUST_PROXY=1
ADMIN_ENTRY_PASSWORD=$admin_password
ADMIN_SESSION_SECRET=$session_secret
ENV
chmod 600 "$config_file"
unset admin_password session_secret
echo "Created $config_file with random secrets. Read the admin password privately with sudo; do not commit this file."
