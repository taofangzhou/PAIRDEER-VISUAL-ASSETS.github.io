#!/usr/bin/env bash
set -euo pipefail
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_dir"
if [[ $(node -p 'process.versions.node.split(".")[0]') -lt 24 ]]; then
  echo 'Node.js 24 LTS or newer is required.' >&2
  exit 1
fi
[[ -f scripts/migrate-sites.mjs && -f lib/download-map.json ]] || {
  echo 'Required migration tool or download map is missing.' >&2
  exit 1
}
# Install with the lockfile before invoking this script. Build on a Linux x64
# machine compatible with the ECS target; keep the archive free of .env/data.
if [[ ${1:-} == --skip-build ]]; then
  shift
else
  npm run build
fi
[[ -f .next/standalone/server.js ]] || { echo 'Standalone build is missing.' >&2; exit 1; }
release_id=$(date -u +%Y%m%dT%H%M%SZ)
output_dir=${1:-"$repo_dir/work/releases"}
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
staging=$(mktemp -d)
trap 'rm -rf -- "$staging"' EXIT
cp -a .next/standalone/. "$staging/"
mkdir -p "$staging/.next/static"
cp -a .next/static/. "$staging/.next/static/"
# Next can already trace public/ for local ZIP reads; merge directory contents
# instead of copying a second public/ directory inside it.
mkdir -p "$staging/public" "$staging/deploy" "$staging/docs"
cp -a public/. "$staging/public/"
cp -a deploy/. "$staging/deploy/"
cp docs/github-pages-domain.md "$staging/docs/"
[[ -f $staging/public/favicon.svg && ! -e $staging/public/public ]] || {
  echo 'Invalid release public/ layout.' >&2
  exit 1
}
cp ALIYUN_DEPLOY.md README.md .env.example "$staging/"
# Keep migration tooling available without installing the development tree.
mkdir -p "$staging/scripts" "$staging/lib"
cp scripts/migrate-sites.mjs "$staging/scripts/"
if [[ -f scripts/import-data.mjs ]]; then cp scripts/import-data.mjs "$staging/scripts/"; fi
for data_file in lib/seed.json lib/download-map.json; do
  if [[ -f $data_file ]]; then cp "$data_file" "$staging/lib/"; fi
done
printf '%s\n' "$release_id" > "$staging/RELEASE_ID"
# Next's trace may copy ignored local env files; deployment secrets are loaded
# exclusively from /etc/pairdeer/pairdeer.env, never from the release archive.
find "$staging" -type f -name '.env*' ! -name '.env.example' -delete
archive=$output_dir/pairdeer-$release_id.tar.gz
tar -C "$staging" -czf "$archive" .
echo "$archive"
