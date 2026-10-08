"""Offline release byte checks; never reads a user account, prompt or log."""
import hashlib
import json
import pathlib
import re
import subprocess
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
# Pin reviewed license texts while allowing native checkout line endings.
# SUL section: n8n LICENSE.md at f754b22a3f49c1528887c52902073ce3c0127645,
# with only the project's copyright line added before the unchanged section.
LICENSE_TEXT_HASHES = {
    'LICENSE': '615e803d285e3ee064dd9bb2b3c9a881b786528364beefa4180b21396dc58056',
    'LICENSES/TypeScript-Apache-2.0.txt': 'a5e9f9b1575301c7a7a03508fdaa2e05a918cc17fd21c6e898096a96d6a34f61',
}


def verify(vsix, source=None):
    package = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))
    lock = json.loads((ROOT / 'package-lock.json').read_text(encoding='utf-8'))
    version = package['version']
    assert version == lock['version'] == lock['packages']['']['version'] == '0.1.1'
    assert package['license'] == lock['packages']['']['license'] == 'SEE LICENSE IN LICENSE'
    for name, expected in LICENSE_TEXT_HASHES.items():
        assert hashlib.sha256((ROOT / name).read_text(encoding='utf-8').encode()).hexdigest() == expected, f'Unreviewed license text: {name}'
    compiler_version = lock['packages']['node_modules/typescript']['version']
    assert compiler_version == '5.9.3', 'Review emitted helper licenses after a compiler update'
    third_party_notices = (ROOT / 'THIRD_PARTY_NOTICES.txt').read_text(encoding='utf-8')
    assert f'TypeScript {compiler_version}' in third_party_notices
    assert 'Copyright (c) Microsoft Corporation. All rights reserved.' in third_party_notices
    assert package['icon'] == 'media/icon.png'
    assert package['contributes']['viewsContainers']['activitybar'][0]['icon'] == 'media/workbench.svg'
    assert package['contributes']['configuration']['properties']['antigravityAccounts.images.endpoint']['default'] == 'daily'
    blocked = re.compile(rb'ya29\.[A-Za-z0-9_-]{20,}|1//[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----', re.I)
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')[:-1]
    for name in tracked:
        file = ROOT / name
        if file.is_file():
            assert not blocked.search(file.read_bytes()), f'Credential pattern in tracked source: {name}'
    result = {'version': version, 'assets': []}
    for asset in [vsix] + ([source] if source else []):
        asset = pathlib.Path(asset)
        with zipfile.ZipFile(asset) as archive:
            assert len(archive.namelist()) == len(set(archive.namelist()))
            for name in archive.namelist():
                parts = pathlib.PurePosixPath(name).parts
                assert '..' not in parts and not name.startswith('/')
                assert not any(p in {'.git', '.gemini', '.codex', '.aws', 'node_modules', 'evidence', '.test-results'} for p in parts), name
                if asset == pathlib.Path(vsix):
                    assert not name.startswith('extension/out/legacy/'), name
                assert not blocked.search(archive.read(name)), f'Private material pattern in {name}'
            if asset == pathlib.Path(vsix):
                assert json.loads(archive.read('extension/package.json')) == package
                manifest = ET.fromstring(archive.read('extension.vsixmanifest'))
                identity = next(e for e in manifest.iter() if e.tag.endswith('Identity'))
                assert identity.attrib['Version'] == version
                assert identity.attrib['Publisher'] == package['publisher']
                license_asset = next(e for e in manifest.iter() if e.attrib.get('Type') == 'Microsoft.VisualStudio.Services.Content.License')
                assert license_asset.attrib['Path'] == 'extension/LICENSE.txt'
                for source_name, member in {
                    'LICENSE': 'extension/LICENSE.txt',
                    'THIRD_PARTY_NOTICES.txt': 'extension/THIRD_PARTY_NOTICES.txt',
                    'LICENSES/TypeScript-Apache-2.0.txt': 'extension/LICENSES/TypeScript-Apache-2.0.txt',
                }.items():
                    assert member in archive.namelist(), f'Missing license notice: {member}'
                    assert archive.read(member) == (ROOT / source_name).read_bytes(), f'Changed license notice: {member}'
                icon_asset = next(e for e in manifest.iter() if e.attrib.get('Type') == 'Microsoft.VisualStudio.Services.Icons.Default')
                assert icon_asset.attrib['Path'] == 'extension/' + package['icon']
                for name, size in [('media/icon.png', 256), ('media/brand-logo.png', 512)]:
                    data = archive.read('extension/' + name)
                    assert data == (ROOT / name).read_bytes(), name
                    assert data[:16] == b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR', name
                    assert struct.unpack('>II', data[16:24]) == (size, size), name
                assert 'media/brand-logo.png' in archive.read('extension/readme.md').decode('utf-8')
                activity_icon = archive.read('extension/media/workbench.svg')
                assert activity_icon == (ROOT / 'media/workbench.svg').read_bytes()
                svg = ET.fromstring(activity_icon)
                assert svg.attrib['viewBox'] == '0 0 24 24'
                assert all(element.tag.rsplit('}', 1)[-1] in {'svg', 'path'} for element in svg.iter())
                assert all(element.attrib.get('fill') == 'currentColor' for element in svg if element.tag.endswith('path'))
                assert 'extension/media/accounts.svg' not in archive.namelist()
                assert not any(n.startswith('extension/assets/') for n in archive.namelist())
                result['icon'] = {'path': package['icon'], 'width': 256, 'height': 256}
                modules = list((ROOT / 'out').glob('*.js'))
                archived_modules = [n for n in archive.namelist() if n.startswith('extension/out/') and n.endswith('.js')]
                assert {f'extension/out/{m.name}' for m in modules} == set(archived_modules)
                assert {'extension.js', 'bridge.js'} <= {m.name for m in modules}
                assert not any('codex' in m.name.lower() for m in modules)
                assert 'codex' not in json.dumps(package).lower()
                for name in archive.namelist():
                    if name.endswith(('.js', '.md', '.json')):
                        assert b'codex' not in archive.read(name).lower(), f'Removed feature in runtime package: {name}'
                for module in modules:
                    assert archive.read(f'extension/out/{module.name}') == module.read_bytes(), module.name
                    for helper in re.findall(rb'var (__\w+) =', module.read_bytes()):
                        assert helper.decode() in third_party_notices, f'Unlisted emitted helper: {helper.decode()}'
                    # Every literal local import in shipped code must remain in the VSIX.
                    for dependency in re.findall(rb'require\([\'"](\.[^\'"]+)[\'"]\)', module.read_bytes()):
                        target = (module.parent / dependency.decode()).resolve().with_suffix('.js')
                        member = 'extension/' + target.relative_to(ROOT).as_posix()
                        assert member in archive.namelist(), f'Missing runtime dependency: {member}'
                result['runtime_modules'] = len(modules)
                result['runtime_sha256'] = {m.name: hashlib.sha256(m.read_bytes()).hexdigest() for m in sorted(modules)}
                result['license'] = 'Sustainable Use License 1.0'
                result['third_party_notices_verified'] = True
            else:
                prefix = f'antigravity-workbench-{version}/'
                members = [n for n in archive.namelist() if not n.endswith('/')]
                assert set(members) == {prefix + n for n in tracked}
                for name in tracked:
                    assert archive.read(prefix + name) == (ROOT / name).read_bytes(), name
                result['source_files'] = len(tracked)
        data = asset.read_bytes()
        result['assets'].append({'name': asset.name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return result


if __name__ == '__main__':
    print(json.dumps(verify(*sys.argv[1:]), indent=2))
