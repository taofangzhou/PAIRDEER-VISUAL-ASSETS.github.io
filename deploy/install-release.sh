#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 || $# -ne 1 ]]; then
  echo 'Usage: sudo bash deploy/install-release.sh /path/to/pairdeer-release.tar.gz' >&2
  exit 1
fi
archive=$(realpath -- "$1")
[[ -f $archive ]] || { echo 'Release archive not found.' >&2; exit 1; }
[[ -f /etc/pairdeer/pairdeer.env ]] || { echo 'Run deploy/init-env.sh first.' >&2; exit 1; }
[[ $(node -p 'process.versions.node.split(".")[0]') -ge 24 ]] || { echo 'Node.js 24+ is required.' >&2; exit 1; }
if ! getent group pairdeer >/dev/null; then groupadd --system pairdeer; fi
if ! id pairdeer >/dev/null 2>&1; then useradd --system --gid pairdeer --home-dir /nonexistent --shell /sbin/nologin pairdeer; fi
install -d -m 755 /opt/pairdeer/releases
install -d -m 750 -o pairdeer -g pairdeer /var/lib/pairdeer
release_dir=$(mktemp -d /opt/pairdeer/releases/release.XXXXXXXX)
tar -xzf "$archive" --no-same-owner -C "$release_dir"
[[ -f $release_dir/server.js && -f $release_dir/deploy/pairdeer.service ]] || { echo 'Invalid standalone release.' >&2; exit 1; }
chown -R root:pairdeer "$release_dir"
chmod -R g+rX "$release_dir"
old_release=$(readlink -f /opt/pairdeer/current 2>/dev/null || true)
if [[ -n $old_release ]]; then
  ln -sfn "$old_release" /opt/pairdeer/previous
fi
ln -s "$release_dir" /opt/pairdeer/current.next
mv -Tf /opt/pairdeer/current.next /opt/pairdeer/current
install -m 644 "$release_dir/deploy/pairdeer.service" /etc/systemd/system/pairdeer.service
systemctl daemon-reload
systemctl enable pairdeer.service
systemctl restart pairdeer.service
if ! curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 2 --max-time 15 http://127.0.0.1:3000/api/health; then
  if [[ -n $old_release ]]; then
    ln -s "$old_release" /opt/pairdeer/current.rollback
    mv -Tf /opt/pairdeer/current.rollback /opt/pairdeer/current
    systemctl restart pairdeer.service
    echo 'Health check failed; restored the previous application release. Inspect journalctl -u pairdeer.' >&2
  else
    systemctl stop pairdeer.service
    echo 'Health check failed on first deployment; service stopped. Inspect journalctl -u pairdeer.' >&2
  fi
  exit 1
fi
echo
echo "Installed $release_dir. DNS and nginx were not changed."
