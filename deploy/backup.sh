#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
[[ -d /var/lib/pairdeer ]] || { echo 'Data directory is missing.' >&2; exit 1; }
backup_dir=${1:-/var/backups/pairdeer}
install -d -m 700 "$backup_dir"
archive=$backup_dir/pairdeer-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
was_active=false
if systemctl is-active --quiet pairdeer.service; then
  was_active=true
  systemctl stop pairdeer.service
fi
restore_service() {
  if [[ $was_active == true ]]; then systemctl start pairdeer.service; fi
}
trap restore_service EXIT
umask 077
# Pausing writes makes SQLite/WAL and immutable media a consistent backup.
tar -C /var/lib/pairdeer -czf "$archive" .
chmod 600 "$archive"
echo "$archive"
echo 'Back up /etc/pairdeer/pairdeer.env separately in a private location.'
