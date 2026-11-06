import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('cache_cleanup', Path(__file__).resolve().parents[1] / 'deploy/cleanup-build-cache.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.builds = self.root / 'builds'
        self.build = self.builds / 'company.Abc12345'
        self.proc = self.root / 'proc'
        self.live = self.root / 'live'
        for directory in (self.build, self.proc, self.live):
            directory.mkdir(parents=True)
        (self.live / 'original.pdf').write_text('protected original')
        for name in cleanup.CACHES:
            cache = self.build / name
            cache.mkdir(parents=True)
            (cache / 'generated').write_bytes(b'x' * 4096)
        for name in ('public/material.pdf', '.git/config', 'work/releases/old.tar.gz'):
            item = self.build / name
            item.parent.mkdir(parents=True, exist_ok=True)
            item.write_text('retained source/archive')

    def tearDown(self):
        self.temporary.cleanup()

    def clean(self, **kwargs):
        return cleanup.clean(self.builds, kwargs.pop('protected', [self.live]), self.proc, kwargs.pop('mounts', []), owner=os.getuid(), report=lambda text: None, **kwargs)

    def process(self, kind, target):
        process = self.proc / '123'
        (process / 'fd').mkdir(parents=True)
        (process / 'cwd').symlink_to(self.live, target_is_directory=True)
        (process / 'maps').write_text('')
        if kind == 'cwd':
            (process / 'cwd').unlink()
            (process / 'cwd').symlink_to(target, target_is_directory=True)
        elif kind == 'fd':
            (process / 'fd' / '5').symlink_to(target)
        else:
            (process / 'maps').write_text('000-fff r-xp 0000 00:01 123 ' + str(target) + '\n')

    def test_dry_run_and_only_generated_caches(self):
        self.assertEqual(len(self.clean()), 3)
        self.assertTrue((self.build / '.next').exists())
        self.assertEqual(len(self.clean(apply=True)), 3)
        for name in cleanup.CACHES:
            self.assertFalse((self.build / name).exists())
        for name in ('public/material.pdf', '.git/config', 'work/releases/old.tar.gz'):
            self.assertTrue((self.build / name).is_file())
        self.assertEqual((self.live / 'original.pdf').read_text(), 'protected original')

    def test_current_previous_and_process_references_protect_whole_build(self):
        self.assertEqual(self.clean(apply=True, protected=[self.build / '.next/standalone']), [])
        for kind in ('cwd', 'fd', 'maps'):
            with self.subTest(kind=kind):
                self.process(kind, self.build / 'node_modules/generated')
                self.assertEqual(self.clean(apply=True), [])
                import shutil
                shutil.rmtree(self.proc / '123')

    def test_symlink_targets_and_parent_are_never_followed(self):
        import shutil
        shutil.rmtree(self.build / 'node_modules')
        (self.build / 'node_modules').symlink_to(self.live, target_is_directory=True)
        shutil.rmtree(self.build / 'work')
        (self.build / 'work').symlink_to(self.live, target_is_directory=True)
        self.clean(apply=True)
        self.assertTrue((self.build / 'node_modules').is_symlink())
        self.assertTrue((self.build / 'work').is_symlink())
        self.assertTrue((self.live / 'original.pdf').is_file())

    def test_internal_symlink_only_unlinks_link(self):
        (self.build / 'node_modules/link').symlink_to(self.live, target_is_directory=True)
        self.clean(apply=True)
        self.assertFalse((self.build / 'node_modules').exists())
        self.assertTrue((self.live / 'original.pdf').is_file())

    def test_mount_or_untrusted_writable_build_is_skipped(self):
        self.assertEqual(self.clean(apply=True, mounts=[self.build / '.next/bound-data']), [])
        self.build.chmod(0o777)
        self.assertEqual(self.clean(apply=True), [])

    def test_other_directory_names_and_symlink_builds_are_ignored(self):
        outside = self.builds / 'other-project'
        outside.mkdir()
        (outside / '.next').mkdir()
        (self.builds / 'company.Zyx12345').symlink_to(self.live, target_is_directory=True)
        self.clean(apply=True)
        self.assertTrue((outside / '.next').exists())
        self.assertTrue((self.live / 'original.pdf').is_file())

    def test_configured_data_dir_is_protected_without_executing_env(self):
        config = self.root / 'config.env'
        config.write_text('ADMIN_PASSWORD=not-read\nDATA_DIR="' + str(self.build / '.next/data') + '"\n')
        data = cleanup.configured_data_directory(config)
        self.assertEqual(self.clean(apply=True, protected=[data]), [])
        config.write_text('DATA_DIR="$(touch /tmp/should-never-execute)"')
        with self.assertRaises(cleanup.UnsafeCleanup):
            cleanup.configured_data_directory(config)

    def test_whole_owned_checkout_requires_exact_private_token_and_no_live_references(self):
        token = 'a' * 64
        marker = self.build / cleanup.OWNER_MARKER
        marker.write_text(token)
        marker.chmod(0o600)
        args = (self.build, token, self.builds, [self.live], self.proc, [])
        with self.assertRaises(cleanup.UnsafeCleanup):
            cleanup.remove_owned_build(self.build, 'b' * 64, self.builds, [], self.proc, [], owner=os.getuid())
        self.process('cwd', self.build)
        self.assertFalse(cleanup.remove_owned_build(*args, owner=os.getuid(), report=lambda text: None))
        import shutil
        shutil.rmtree(self.proc / '123')
        self.assertTrue(cleanup.remove_owned_build(*args, owner=os.getuid(), report=lambda text: None))
        self.assertFalse(self.build.exists())
        self.assertTrue((self.live / 'original.pdf').exists())


if __name__ == '__main__':
    unittest.main()
