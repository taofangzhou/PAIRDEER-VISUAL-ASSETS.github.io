#!/usr/bin/env bash
# Downloadable recovery updater for the existing standard ECS installation.
set -Eeuo pipefail
[[ $EUID -eq 0 && $# -eq 0 ]] || { echo '请在 Workbench 执行：sudo bash /tmp/pairdeer-company-upgrade.sh' >&2; exit 1; }
export PATH=/usr/local/bin:/usr/bin:/bin
export NEXT_TELEMETRY_DISABLED=1
umask 077
install -d -m 700 /var/log/pairdeer /opt/pairdeer-builds
log_file=/var/log/pairdeer/company-upgrade-$(date -u +%Y%m%dT%H%M%SZ)-$$.log
exec > >(tee -a "$log_file") 2>&1
stage=检查环境
old_release=
expected_release_id=
service_backup=
install_started=0
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
for executable in node npm git curl tar stat awk find tee du; do command -v "$executable" >/dev/null; done
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
available_kib=$(df -Pk /opt/pairdeer-builds | awk 'NR==2 {print $4}')
[[ $available_kib -ge 5242880 ]] || { echo '构建磁盘可用空间不足 5 GiB，请先检查 df -h。'; false; }
echo "原程序：$old_release；进程：$old_pid"

stage=获取并核验源码
source_dir=$(mktemp -d /opt/pairdeer-builds/company.XXXXXXXX)
git clone --depth 1 --filter=blob:none --sparse --branch main \
  https://github.com/taofangzhou/PAIRDEER-VISUAL-ASSETS.github.io.git "$source_dir"
git -C "$source_dir" sparse-checkout set --no-cone '/*' '!/backup/'
cd "$source_dir"
echo "源码目录：$source_dir"
git log -1 --format='源码提交：%H %s'
node --input-type=commonjs <<'NODE'
const fs=require('node:fs');
const assert=require('node:assert/strict');
const source=fs.readFileSync('app/page.tsx','utf8');
for(const label of ['双鹿电池介绍PDF','公司介绍视频']) assert(source.includes(label),'源码缺少栏目：'+label);
for(const [name,size] of [['pdf',23338906],['mp4',29894161]]) {
  assert.equal(fs.statSync('public/assets/company/company-introduction.'+name).size,size,'原始素材不完整：'+name);
}
console.log('源码栏目与两份原始素材核验通过');
NODE

stage=安装依赖与构建
npm ci --cache "$source_dir/work/npm-cache"
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
for(const file of ['server.js','RELEASE_ID','public/assets/company/company-introduction.pdf','public/assets/company/company-introduction.mp4','lib/company-materials-defaults.json']) {
  assert(files.has('./'+file),'发布包缺少：'+file);
}
console.log('发布包包含 PDF、MP4 与栏目默认资料');
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
  }
  console.log('实际首页两个栏目、PDF 与视频接口全部通过');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
NODE
stage=完成
trap - ERR
echo "更新成功。当前程序：$new_release；进程：$new_pid；日志：$log_file"
echo '请刷新 https://shuanglu-battery.cn/ 查看两个新栏目。'
