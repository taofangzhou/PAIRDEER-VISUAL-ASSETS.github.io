#!/usr/bin/env bash
# Downloadable recovery updater for the existing standard ECS installation.
set -Eeuo pipefail
[[ $EUID -eq 0 && $# -eq 0 ]] || { echo '请在 Workbench 执行：sudo bash /tmp/pairdeer-company-upgrade.sh' >&2; exit 1; }
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export NEXT_TELEMETRY_DISABLED=1
umask 077
# Keep this shell and the logging process outside disposable build checkouts.
cd /
install -d -m 700 /var/log/pairdeer /opt/pairdeer-builds
log_file=/var/log/pairdeer/company-upgrade-$(date -u +%Y%m%dT%H%M%SZ)-$$.log
exec > >(tee -a "$log_file") 2>&1
stage=检查环境
old_release=
expected_release_id=
service_backup=
install_started=0
source_dir=
owner_token=
cleanup_helper=
cleanup_owned_build() {
  if [[ -n $source_dir && -n $owner_token && -n $cleanup_helper && -f $source_dir/.pairdeer-created-by-upgrade ]]; then
    cd / || return 1
    python3 "$cleanup_helper" --apply --inherited-lock-fd 9 --owned-build "$source_dir" --owner-token "$owner_token" || return 1
  fi
}
on_error() {
  local status=$1 line=$2 current_release
  trap - ERR
  set +e
  echo "更新失败：阶段=$stage，行=$line，退出码=$status。日志：$log_file"
  current_release=$(readlink -f /opt/pairdeer/current 2>/dev/null)
  if [[ $install_started == 1 && -n $old_release && -f $old_release/server.js ]] &&
     { [[ $current_release == "$old_release" ]] ||
       [[ -n $expected_release_id && -f $current_release/RELEASE_ID && $(cat "$current_release/RELEASE_ID") == "$expected_release_id" ]]; }; then
    echo "恢复原程序：$old_release；数据库、素材和密码配置保留。"
    if [[ $current_release != "$old_release" ]]; then
      ln -s "$old_release" "/opt/pairdeer/current.company-rollback.$$" &&
        mv -Tf "/opt/pairdeer/current.company-rollback.$$" /opt/pairdeer/current
    fi
    if [[ $(readlink -f /opt/pairdeer/current) == "$old_release" ]]; then
      [[ -n $service_backup && -f $service_backup ]] && cp -p "$service_backup" /etc/systemd/system/pairdeer.service
      systemctl daemon-reload
      systemctl restart pairdeer.service
      curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 2 --max-time 10 http://127.0.0.1:3000/api/health
    fi
  fi
  if ! cleanup_owned_build; then echo '临时构建仍被使用或无法安全回收，已保留；请查看以上原因。'; fi
  exit "$status"
}
trap 'on_error "$?" "$LINENO"' ERR
echo "更新日志：$log_file"
command -v flock >/dev/null
exec 9>/run/pairdeer-company-upgrade.lock
flock -n 9 || { echo '已有一项公司资料升级正在执行，请等待该次任务完成，不要重复运行。'; exit 1; }
if ! command -v git >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then dnf install -y git
  elif command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y git
  elif command -v yum >/dev/null 2>&1; then yum install -y git
  else echo '请先安装 Git，再执行本脚本。'; false
  fi
fi
for executable in node npm git curl tar stat awk find tee du runuser python3 sha256sum; do command -v "$executable" >/dev/null; done
node -e 'if(Number(process.versions.node.split(".")[0])<24)throw Error("服务运行路径需要 Node.js 24 或以上")'
[[ -L /opt/pairdeer/current && -f /etc/pairdeer/pairdeer.env ]]
[[ $(systemctl show pairdeer.service -p FragmentPath --value) == /etc/systemd/system/pairdeer.service && ! -L /etc/systemd/system/pairdeer.service ]]
old_release=$(readlink -f /opt/pairdeer/current)
[[ $old_release == /opt/pairdeer/releases/* && -f $old_release/server.js && -f $old_release/deploy/backup.sh ]]
systemctl is-active --quiet pairdeer.service
old_pid=$(systemctl show pairdeer.service -p MainPID --value)
[[ $old_pid =~ ^[1-9][0-9]*$ && $(readlink -f "/proc/$old_pid/cwd") == "$old_release" ]]
memory_and_swap=$(awk '/^(MemTotal|SwapTotal):/ {total+=$2} END {print total+0}' /proc/meminfo)
if [[ $memory_and_swap -lt 3145728 ]]; then
  echo '内存与 SWAP 合计不足 3 GiB。请先按 COMPANY_MATERIALS_ECS.md 第 1 步准备 2 GiB 构建 SWAP，再重试。'
  free -h
  false
fi
stage=清理旧构建缓存
cleanup_download=$(mktemp /var/log/pairdeer/cache-cleaner-download.XXXXXXXX)
curl --fail --show-error --location --retry 3 --connect-timeout 15 --max-time 90 \
  -H 'Accept: application/vnd.github.raw+json' \
  'https://api.github.com/repos/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io/contents/deploy/cleanup-build-cache.py?ref=main' \
  -o "$cleanup_download"
echo "0924be61da8283425ef6c62a2cdeb3f1f0a11528b5013759ef95e0f0db3f54b9  $cleanup_download" | sha256sum -c -
cleanup_helper=/var/log/pairdeer/cache-cleaner-0924be61.py
mv -f "$cleanup_download" "$cleanup_helper"
python3 "$cleanup_helper" --apply --inherited-lock-fd 9
stage=检查清理后的磁盘空间
available_kib=$(df -Pk /opt/pairdeer-builds | awk 'NR==2 {print $4}')
[[ $available_kib -ge 5242880 ]] || { echo '旧构建缓存已检查；清理后仍不足 5 GiB，已安全停止。请提供以上清理结果及 df -h；无需重复执行旧升级命令。'; false; }
echo "原程序：$old_release；进程：$old_pid"

stage=获取并核验源码
source_ready=0
for source_attempt in 1 2 3; do
  source_dir=$(mktemp -d /opt/pairdeer-builds/company.XXXXXXXX)
  echo "下载源码：第 $source_attempt 次尝试"
  if git clone --depth 1 --filter=blob:none --sparse --branch main \
       https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io.git "$source_dir" &&
     git -C "$source_dir" sparse-checkout set --no-cone '/*' '!/backup/'; then
    owner_token=$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')
    printf '%s' "$owner_token" > "$source_dir/.pairdeer-created-by-upgrade"
    source_ready=1
    break
  fi
  echo "源码下载未完成，详情保留在日志中。目录：$source_dir"
  owner_token=$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')
  printf '%s' "$owner_token" > "$source_dir/.pairdeer-created-by-upgrade"
  if ! cleanup_owned_build; then echo '未完成的临时下载目录无法安全回收，已保留。'; fi
  source_dir=
  owner_token=
  if [[ $source_attempt -lt 3 ]]; then sleep 2; fi
done
[[ $source_ready == 1 ]] || { echo '三次源码下载均未完成，旧网站保持运行。'; false; }
cd "$source_dir"
echo "源码目录：$source_dir"
git log -1 --format='源码提交：%H %s'
node --input-type=commonjs <<'NODE'
const fs=require('node:fs');
const assert=require('node:assert/strict');
const source=fs.readFileSync('app/page.tsx','utf8');
for(const label of ['双鹿电池介绍PDF','公司介绍视频','网站运营日志中心']) assert(source.includes(label),'源码缺少栏目：'+label);
for(const [name,size] of [['pdf',23338906],['mp4',29894161]]) {
  assert.equal(fs.statSync('public/assets/company/company-introduction.'+name).size,size,'原始素材不完整：'+name);
}
const pages=JSON.parse(fs.readFileSync('lib/company-materials-defaults.json','utf8')).pdf.previewPages;
assert.equal(pages?.length,38,'默认 PDF 应有 38 张分页预览');
for(const page of pages) assert(fs.statSync('public'+page).size>0,'缺少分页预览：'+page);
assert(fs.statSync('public'+pages[0]).size<300*1024,'首页预览图过大');
console.log('源码栏目、原始素材与 38 张轻量分页预览核验通过');
NODE

stage=安装依赖与构建
npm ci --cache "$source_dir/work/npm-cache"
# Downloaded npm tarballs are unnecessary after installation.
rm -rf -- "$source_dir/work/npm-cache"
NODE_OPTIONS=--max-old-space-size=1536 npm run build
node --input-type=commonjs <<'NODE'
const fs=require('node:fs');
const assert=require('node:assert/strict');
const html=fs.readFileSync('.next/server/app/index.html','utf8');
for(const label of ['双鹿电池介绍PDF','公司介绍视频']) assert(html.includes(label),'构建页面缺少栏目：'+label);
console.log('构建页面包含两个新栏目');
NODE

stage=打包并核验发布内容
bash deploy/package-release.sh --skip-build "$source_dir/work/releases"
archive=$(find "$source_dir/work/releases" -maxdepth 1 -type f -name 'pairdeer-*.tar.gz' -print -quit)
[[ -n $archive ]]
tar -tzf "$archive" > "$source_dir/work/release-files.txt"
node --input-type=commonjs <<'NODE'
const fs=require('node:fs');
const assert=require('node:assert/strict');
const files=new Set(fs.readFileSync('work/release-files.txt','utf8').trim().split('\n'));
for(const file of ['server.js','RELEASE_ID','public/assets/company/company-introduction.pdf','public/assets/company/company-introduction.mp4','lib/company-materials-defaults.json','scripts/prepare-company-preview.mjs','.next/server/app/api/admin/operations/route.js','.next/server/app/api/analytics/route.js','.next/server/app/api/download/route.js']) {
  assert(files.has('./'+file),'发布包缺少：'+file);
}
const pages=JSON.parse(fs.readFileSync('lib/company-materials-defaults.json','utf8')).pdf.previewPages;
for(const page of pages) assert(files.has('./public'+page),'发布包缺少分页预览：'+page);
console.log('发布包包含公司素材、分页预览及运营中心接口');
NODE
expected_release_id=$(tar -xOf "$archive" ./RELEASE_ID)
[[ -n $expected_release_id ]]

stage=备份现有资料
install -d -m 700 /var/backups/pairdeer
data_kib=$(du -sk /var/lib/pairdeer | awk '{print $1}')
backup_available_kib=$(df -Pk /var/backups/pairdeer | awk 'NR==2 {print $4}')
[[ $backup_available_kib -ge $((data_kib + 1048576)) ]] || { echo '备份磁盘空间不足以保存完整资料并保留 1 GiB 余量，旧网站未停止。'; false; }
echo '正在备份 ECS 数据；现有备份脚本会短暂停止服务，完成后自动恢复。'
bash "$old_release/deploy/backup.sh"
stage=更新上传代理
bash deploy/update-company-materials.sh
stage=安装新程序
service_backup=$(mktemp /var/log/pairdeer/service-before-company-upgrade.XXXXXXXX)
cp -p /etc/systemd/system/pairdeer.service "$service_backup"
install_started=1
bash deploy/install-release.sh "$archive"

stage=准备当前PDF的快速预览
runuser -u pairdeer -- env DATA_DIR=/var/lib/pairdeer PATH="$PATH" \
  node /opt/pairdeer/current/scripts/prepare-company-preview.mjs

stage=验证实际运行版本
systemctl is-active --quiet pairdeer.service
new_release=$(readlink -f /opt/pairdeer/current)
new_pid=$(systemctl show pairdeer.service -p MainPID --value)
[[ $new_release != "$old_release" && $new_pid =~ ^[1-9][0-9]*$ ]]
[[ $(readlink -f "/proc/$new_pid/cwd") == "$new_release" ]]
node --input-type=commonjs - "$new_release" <<'NODE'
const fs=require('node:fs');
const assert=require('node:assert/strict');
for(const [name,size] of [['pdf',23338906],['mp4',29894161]]) {
  assert.equal(fs.statSync(process.argv[2]+'/public/assets/company/company-introduction.'+name).size,size,'已安装素材不完整：'+name);
}
(async()=>{
  const base='http://127.0.0.1:3000';
  const home=await fetch(base+'/?company-upgrade-check='+Date.now(),{signal:AbortSignal.timeout(15000)});
  assert(home.ok,'首页 HTTP '+home.status);
  const html=await home.text();
  for(const label of ['双鹿电池介绍PDF','公司介绍视频']) assert(html.includes(label),'实际首页缺少：'+label);
  const response=await fetch(base+'/api/catalog',{signal:AbortSignal.timeout(15000)});
  assert(response.ok,'资料接口 HTTP '+response.status);
  const catalog=await response.json();
  const materials=catalog.data?.companyMaterials;
  for(const kind of ['pdf','video']) {
    const asset=materials?.[kind];
    assert(asset?.url?.startsWith('/')&&asset.size>0,'资料接口缺少公司素材：'+kind);
    const media=await fetch(base+asset.url,{method:'HEAD',signal:AbortSignal.timeout(15000)});
    assert(media.ok,'素材读取失败：'+kind+' HTTP '+media.status);
    assert.equal(media.headers.get('content-type')?.split(';')[0].trim(),kind==='pdf'?'application/pdf':'video/mp4','素材类型错误：'+kind);
    assert.equal(Number(media.headers.get('content-length')),asset.size,'素材大小与资料库不一致：'+kind);
    console.log(JSON.stringify({kind,name:asset.name,size:asset.size,status:media.status}));
    if(kind==='pdf') {
      assert(Array.isArray(asset.previewPages)&&asset.previewPages.length>0,'当前 PDF 缺少分页预览');
      const page=await fetch(base+asset.previewPages[0],{method:'HEAD',signal:AbortSignal.timeout(15000)});
      assert(page.ok,'首页预览图读取失败：HTTP '+page.status);
      assert.equal(page.headers.get('content-type')?.split(';')[0].trim(),'image/jpeg','首页预览图类型错误');
      assert(Number(page.headers.get('content-length'))>0,'首页预览图为空');
      console.log(JSON.stringify({previewPages:asset.previewPages.length,firstPageBytes:Number(page.headers.get('content-length')),status:page.status}));
    }
  }
  const report=await fetch(base+'/api/admin/operations',{signal:AbortSignal.timeout(15000)});
  await report.body?.cancel();
  assert.equal(report.status,403,'运营统计必须仅允许管理员');
  console.log('实际页面、素材预览及运营统计管理员访问保护全部通过');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
NODE
stage=完成
trap - ERR
if ! cleanup_owned_build; then echo '网站已更新；本次临时构建目录暂时无法安全回收，已保留。'; fi
echo "更新成功。当前程序：$new_release；进程：$new_pid；日志：$log_file"
echo '请登录 https://shuanglu-battery.cn/?admin=1 查看网站运营日志中心。'
