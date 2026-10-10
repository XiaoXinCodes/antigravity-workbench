"""Offline checks for project licensing and independent third-party notices."""
import importlib.util
import json
import pathlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('verify_release', ROOT / 'scripts/verify-release.py')
verify_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify_release)


class LicenseNotices(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        for name in ['LICENSE', 'LICENSES/TypeScript-Apache-2.0.txt', 'THIRD_PARTY_NOTICES.txt']:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        self.package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
        self.lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))

    def verify(self):
        with patch.object(verify_release, 'ROOT', self.root):
            return verify_release.verify_license_notices(self.package, self.lock)

    def test_mit_metadata_and_independent_notices_pass(self):
        self.assertIn('__importStar', self.verify())

    def test_old_manifest_license_is_rejected(self):
        self.package['license'] = 'SEE LICENSE IN LICENSE'
        with self.assertRaises(AssertionError): self.verify()

    def test_old_root_lock_license_is_rejected(self):
        self.lock['packages']['']['license'] = 'SEE LICENSE IN LICENSE'
        with self.assertRaises(AssertionError): self.verify()

    def test_added_project_license_restriction_is_rejected(self):
        with (self.root / 'LICENSE').open('a', encoding='utf-8') as file: file.write('Non-commercial use only.\n')
        with self.assertRaisesRegex(AssertionError, 'Unreviewed license text: LICENSE'): self.verify()

    def test_changed_third_party_license_is_rejected(self):
        (self.root / 'LICENSES/TypeScript-Apache-2.0.txt').write_text('MIT License\n', encoding='utf-8')
        with self.assertRaisesRegex(AssertionError, 'Unreviewed license text: LICENSES/'): self.verify()

    def test_missing_third_party_copyright_is_rejected(self):
        file = self.root / 'THIRD_PARTY_NOTICES.txt'
        file.write_text(file.read_text(encoding='utf-8').replace('Copyright (c) Microsoft Corporation. All rights reserved.', ''), encoding='utf-8')
        with self.assertRaises(AssertionError): self.verify()

    def test_compiler_change_requires_notice_review(self):
        self.lock['packages']['node_modules/typescript']['version'] = '6.0.0'
        with self.assertRaisesRegex(AssertionError, 'Review emitted helper licenses'): self.verify()

    def test_native_checkout_line_endings_are_accepted(self):
        for name in verify_release.LICENSE_TEXT_HASHES:
            file = self.root / name
            file.write_bytes(file.read_text(encoding='utf-8').replace('\n', '\r\n').encode('utf-8'))
        self.verify()


if __name__ == '__main__': unittest.main(verbosity=2)
