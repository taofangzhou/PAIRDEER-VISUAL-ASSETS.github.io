#!/usr/bin/env python3
"""Reclaim only rebuildable caches in standard ECS build checkouts."""
import argparse
import fcntl
import hmac
import os
from pathlib import Path
import re
import shutil
import shlex
import stat
import sys

BUILD_ROOT = Path('/opt/pairdeer-builds')
LOCK = Path('/run/pairdeer-company-upgrade.lock')
CACHES = ('node_modules', '.next', 'work/npm-cache')
BUILD_NAME = re.compile(r'company\.[A-Za-z0-9]{8}\Z')
OWNER_MARKER = '.pairdeer-created-by-upgrade'


class UnsafeCleanup(RuntimeError):
    pass


def directory(path, owner):
    """Reject symlink components, including a redirected build root."""
    for part in reversed((path, *path.parents)):
        info = part.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise UnsafeCleanup('目录路径包含符号链接或不是目录：' + str(part))
    if path.lstat().st_uid != owner:
        raise UnsafeCleanup('目录拥有者不匹配：' + str(path))


def unescape_mount(value):
    return re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), value)


def mounts_from(filename):
    return [Path(unescape_mount(line.split()[4])) for line in Path(filename).read_text().splitlines() if len(line.split()) > 5]


def within(path, root):
    return path == root or root in path.parents


def owned_path(path, boundary, owner):
    directory(path, owner)
    for part in (path, *path.parents):
        if not within(part, boundary):
            break
        info = part.lstat()
        if info.st_uid != owner or info.st_mode & 0o022:
            raise UnsafeCleanup('缓存路径可被其他用户修改，保留：' + str(part))


def reference(value):
    if value.endswith(' (deleted)'):
        value = value[:-10]
    return Path(value) if value.startswith('/') else None


def process_references(proc_root):
    """No PID, command arguments or individual file references are reported."""
    result = []
    for process in proc_root.iterdir():
        if not process.name.isdigit():
            continue
        try:
            result.append(reference(os.readlink(process / 'cwd')))
            for descriptor in list((process / 'fd').iterdir()):
                try:
                    result.append(reference(os.readlink(descriptor)))
                except FileNotFoundError:
                    pass
            for line in (process / 'maps').read_text().splitlines():
                fields = line.split(maxsplit=5)
                if len(fields) == 6:
                    result.append(reference(fields[5]))
        except (FileNotFoundError, ProcessLookupError):
            # Processes routinely exit while /proc is being examined.
            continue
        except PermissionError as error:
            raise UnsafeCleanup('无法检查所有进程的文件引用，已停止清理') from error
    return [path for path in result if path is not None]


def configured_data_directory(filename):
    result = Path('/var/lib/pairdeer')
    for line in Path(filename).read_text().splitlines():
        match = re.match(r'^\s*(?:export\s+)?DATA_DIR\s*=(.*)$', line)
        if match:
            parts = shlex.split(match[1], comments=True)
            if len(parts) != 1 or not parts[0].startswith('/') or '$' in parts[0] or '`' in parts[0]:
                raise UnsafeCleanup('DATA_DIR 配置需要人工检查，未执行清理')
            result = Path(parts[0]).resolve(strict=False)
    return result


def validate_cache(path, build_root, device, mounts, owner):
    owned_path(path, build_root, owner)
    if any(within(mount, path) for mount in mounts):
        raise UnsafeCleanup('目录包含挂载点：' + str(path))
    if path.lstat().st_dev != device:
        raise UnsafeCleanup('目录位于不同文件系统：' + str(path))
    for root, directories, files in os.walk(path, followlinks=False):
        for name in directories + files:
            item = Path(root) / name
            info = item.lstat()
            # Internal links are unlinked by fd-safe rmtree, never traversed.
            if not stat.S_ISLNK(info.st_mode) and info.st_dev != device:
                raise UnsafeCleanup('目录跨越文件系统：' + str(path))


def clean(build_root, protected, proc_root, mounts, *, apply=False, owner=0, report=print):
    directory(build_root, owner)
    device = build_root.lstat().st_dev
    removed = []
    for build in sorted(build_root.iterdir()):
        if not BUILD_NAME.fullmatch(build.name):
            continue
        try:
            owned_path(build, build_root, owner)
            if build.lstat().st_dev != device or any(within(mount, build) for mount in mounts):
                raise UnsafeCleanup('构建目录存在挂载或跨文件系统：' + str(build))
            refs = process_references(proc_root)
            if any(within(path, build) or within(build, path) for path in protected) or any(within(path, build) for path in refs):
                report('保留正在使用或受保护的构建目录：' + str(build))
                continue
            for name in CACHES:
                cache = build / name
                if not cache.exists() and not cache.is_symlink():
                    continue
                try:
                    validate_cache(cache, build_root, device, mounts, owner)
                    if apply:
                        shutil.rmtree(cache)
                    removed.append(str(cache))
                    report(('已清理缓存：' if apply else '可清理缓存：') + str(cache))
                except (OSError, UnsafeCleanup) as error:
                    report('保留：' + str(error))
        except (OSError, UnsafeCleanup) as error:
            report('保留：' + str(error))
    return removed


def remove_owned_build(build, token, build_root, protected, proc_root, mounts, *, owner=0, report=print):
    """Only an updater's freshly marked temporary checkout may be removed whole."""
    if build.parent != build_root or not BUILD_NAME.fullmatch(build.name) or not re.fullmatch(r'[a-f0-9]{64}', token):
        raise UnsafeCleanup('本次临时构建标识无效')
    owned_path(build, build_root, owner)
    marker = build / OWNER_MARKER
    info = marker.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != owner or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size != 64:
        raise UnsafeCleanup('本次临时构建标记无效')
    if not hmac.compare_digest(marker.read_text(), token):
        raise UnsafeCleanup('本次临时构建标记不匹配')
    if any(within(path, build) or within(build, path) for path in protected) or any(within(path, build) for path in process_references(proc_root)):
        report('本次构建仍被进程或运行版本引用，保留：' + str(build))
        return False
    validate_cache(build, build_root, build_root.lstat().st_dev, mounts, owner)
    shutil.rmtree(build)
    report('已回收本次临时构建目录：' + str(build))
    return True


def acquire_lock(inherited):
    if inherited is None:
        descriptor = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    else:
        descriptor = inherited
    info = os.fstat(descriptor)
    lock_info = LOCK.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_ISLNK(lock_info.st_mode) or (info.st_dev, info.st_ino) != (lock_info.st_dev, lock_info.st_ino):
        raise UnsafeCleanup('升级锁文件无效')
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise UnsafeCleanup('另一项升级或清理正在运行，请稍后重试') from error
    return descriptor


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='实际清理；默认只列出候选缓存')
    parser.add_argument('--inherited-lock-fd', type=int)
    parser.add_argument('--owned-build', type=Path)
    parser.add_argument('--owner-token')
    args = parser.parse_args()
    if os.geteuid() != 0 or not shutil.rmtree.avoids_symlink_attacks:
        raise UnsafeCleanup('需要 root 和支持安全目录删除的 Python3')
    descriptor = acquire_lock(args.inherited_lock_fd)
    try:
        current = Path('/opt/pairdeer/current').resolve(strict=True)
        previous_link = Path('/opt/pairdeer/previous')
        protected = [current, configured_data_directory('/etc/pairdeer/pairdeer.env'), Path('/var/lib/pairdeer'), Path('/var/backups/pairdeer'), Path('/etc/pairdeer')]
        if previous_link.exists() or previous_link.is_symlink():
            protected.append(previous_link.resolve(strict=True))
        directory(BUILD_ROOT, 0)
        before = shutil.disk_usage(BUILD_ROOT).free
        print('清理前磁盘可用：%.2f GiB' % (before / 1024 ** 3))
        mounts = mounts_from('/proc/self/mountinfo')
        if args.owned_build is not None or args.owner_token is not None:
            if not args.apply or args.owned_build is None or args.owner_token is None:
                raise UnsafeCleanup('本次构建回收参数不完整')
            remove_owned_build(args.owned_build, args.owner_token, BUILD_ROOT, protected, Path('/proc'), mounts)
        else:
            clean(BUILD_ROOT, protected, Path('/proc'), mounts, apply=args.apply)
        after = shutil.disk_usage(BUILD_ROOT).free
        print('清理后磁盘可用：%.2f GiB' % (after / 1024 ** 3))
        if args.owned_build is None:
            print('旧构建仅清 node_modules、.next、work/npm-cache；源码、发布包和线上数据保留。')
    finally:
        # Closing an inherited duplicate does not release the bash-held lock.
        os.close(descriptor)


if __name__ == '__main__':
    try:
        main()
    except (OSError, UnsafeCleanup) as error:
        print('缓存清理已停止：' + str(error), file=sys.stderr)
        sys.exit(1)
