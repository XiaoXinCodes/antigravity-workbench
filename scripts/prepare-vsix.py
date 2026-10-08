"""Pin package documentation links to its source commit without changing runtime bytes."""
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = 'XiaoXinCodes/antigravity-workbench'


def rewrite_document(data, member, sha):
    assert re.fullmatch(r'[0-9a-f]{40}', sha), 'A source commit is required'
    relative = member.removeprefix('extension/')
    parent = pathlib.PurePosixPath(relative).parent.as_posix()
    prefix = '' if parent == '.' else parent + '/'
    content = f'https://github.com/{REPO}/blob/{sha}/'
    images = f'https://raw.githubusercontent.com/{REPO}/{sha}/'

    def url(ref, image=False):
        for old, new in [(f'https://github.com/{REPO}/blob/main/', content),
                         (f'https://github.com/{REPO}/raw/main/', images),
                         (f'https://raw.githubusercontent.com/{REPO}/main/', images)]:
            if ref.startswith(old): return new + ref[len(old):]
        if ref.startswith(('#', 'mailto:', 'https://')): return ref
        assert not ref.startswith('//') and not re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', ref), 'Documentation requires HTTPS links'
        return urllib.parse.urljoin(images if image else content, prefix + ref.removeprefix('./'))

    text = data.decode('utf-8')
    text = re.sub(r'(\b(?:href|src)=)(["\'])([^"\']+)\2', lambda match: match[1] + match[2] + url(match[3], match[1].startswith('src')) + match[2], text)
    text = re.sub(r'(!?\[[^\]\n]*\])\(([^\s)]+)\)', lambda match: match[1] + '(' + url(match[2], match[1].startswith('!')) + ')', text)
    return text.encode('utf-8')


def normalize(vsix, sha):
    assert re.fullmatch(r'[0-9a-f]{40}', sha)
    file = pathlib.Path(vsix)
    with tempfile.NamedTemporaryFile(prefix='.' + file.name + '.', suffix='.tmp', dir=file.parent, delete=False) as temporary_file:
        temporary = pathlib.Path(temporary_file.name)
    try:
        with zipfile.ZipFile(file) as source, zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as target:
            assert len(source.namelist()) == len(set(source.namelist())), 'Duplicate package entries'
            for entry in source.infolist():
                data = source.read(entry.filename)
                if entry.filename.lower().endswith('.md'):
                    data = rewrite_document(data, entry.filename, sha)
                target.writestr(entry, data)
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    commit = sys.argv[2] if len(sys.argv) == 3 else subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    normalize(sys.argv[1], commit)
