"""Offline package-link checks; no account, Marketplace authentication or publication."""
import importlib.util
import pathlib
import tempfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location('prepare', pathlib.Path(__file__).resolve().parents[1] / 'scripts/prepare-vsix.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)
SHA = 'a' * 40


class PackageDocs(unittest.TestCase):
    def test_relative_html_and_markdown_links_are_pinned(self):
        data = b'<a href="README_EN.md">English</a><img src="media/logo.png"> [docs](docs/README.md) ![image](media/demo.gif) [here](#anchor)'
        result = prepare.rewrite_document(data, 'extension/readme.md', SHA).decode()
        self.assertIn('/blob/' + SHA + '/README_EN.md', result)
        self.assertIn('/blob/' + SHA + '/docs/README.md', result)
        self.assertIn('/' + SHA + '/media/logo.png', result)
        self.assertIn('/' + SHA + '/media/demo.gif', result)
        self.assertIn('[here](#anchor)', result)

    def test_nested_docs_and_existing_main_links_resolve_to_same_source(self):
        data = ('[back](../README.md) [scope](VALIDATION_0.1.3.md) <a href="https://github.com/' + prepare.REPO + '/blob/main/README_EN.md">English</a>').encode()
        result = prepare.rewrite_document(data, 'extension/docs/RELEASE_0.1.3.md', SHA).decode()
        self.assertIn('/blob/' + SHA + '/README.md', result)
        self.assertIn('/blob/' + SHA + '/docs/VALIDATION_0.1.3.md', result)
        self.assertIn('/blob/' + SHA + '/README_EN.md', result)
        self.assertNotIn('/blob/main/', result)

    def test_package_members_runtime_and_license_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'release.vsix'
            members = {'extension/readme.md': b'[docs](docs/README.md)', 'extension/README_EN.md': b'[Chinese](README.md)', 'extension/out/extension.js': b'unchanged runtime', 'extension/package.json': b'{"version":"0.1.3"}', 'extension/LICENSE.txt': b'unchanged license'}
            with zipfile.ZipFile(file, 'w') as archive:
                for name, data in members.items(): archive.writestr(name, data)
            prepare.normalize(file, SHA)
            first = file.read_bytes()
            with zipfile.ZipFile(file) as archive:
                self.assertEqual(set(archive.namelist()), set(members))
                for name in ['extension/out/extension.js', 'extension/package.json', 'extension/LICENSE.txt']: self.assertEqual(archive.read(name), members[name])
            prepare.normalize(file, SHA)
            self.assertEqual(file.read_bytes(), first)

    def test_invalid_scheme_or_sha_cannot_replace_package(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'release.vsix'
            with zipfile.ZipFile(file, 'w') as archive: archive.writestr('extension/readme.md', '[bad](http://example.invalid)')
            original = file.read_bytes()
            for sha in ['main', SHA]:
                with self.subTest(sha=sha), self.assertRaises(AssertionError): prepare.normalize(file, sha)
                self.assertEqual(file.read_bytes(), original)
            self.assertEqual(list(pathlib.Path(directory).iterdir()), [file])

    def test_duplicate_entries_are_rejected_without_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            file = pathlib.Path(directory) / 'release.vsix'
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                with zipfile.ZipFile(file, 'w') as archive:
                    archive.writestr('extension/readme.md', 'one')
                    archive.writestr('extension/readme.md', 'two')
            original = file.read_bytes()
            with self.assertRaises(AssertionError): prepare.normalize(file, SHA)
            self.assertEqual(file.read_bytes(), original)


if __name__ == '__main__': unittest.main(verbosity=2)
