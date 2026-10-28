#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
previous=$(readlink -f /opt/pairdeer/previous)
current=$(readlink -f /opt/pairdeer/current)
[[ -f $previous/server.js ]] || { echo 'Previous release is unavailable.' >&2; exit 1; }
ln -s "$previous" /opt/pairdeer/current.rollback
mv -Tf /opt/pairdeer/current.rollback /opt/pairdeer/current
ln -sfn "$current" /opt/pairdeer/previous
systemctl restart pairdeer.service
curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 2 --max-time 15 http://127.0.0.1:3000/api/health
echo
echo 'Application rolled back. Persistent data was kept; database backups are restored separately.'
