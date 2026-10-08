"""Publish a new version once after CI; existing releases, tags and assets stay untouched."""
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
from urllib.parse import quote

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = 'XiaoXinCodes/antigravity-workbench'
REPO_ID = 1409536968
VERSION = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
TAG = 'v' + VERSION

def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def api(path, *args):
    return json.loads(run('gh', 'api', f'repos/{REPO}' + (f'/{path}' if path else ''), *args))


def assert_repository_identity(repository):
    assert repository.get('id') == REPO_ID and repository.get('full_name') == REPO, 'Release repository identity changed'


def assert_repository_visibility(repository):
    # Private is the default. The reviewed main workflow explicitly permits
    # this repository to publish after its authorized transition to public.
    assert repository.get('private') is True or (
        repository.get('private') is False and os.environ.get('AG_ALLOW_PUBLIC_REPOSITORY') == 'true'
    ), 'Public repository publication requires explicit workflow permission'


def list_releases():
    pages = json.loads(run('gh', 'api', f'repos/{REPO}/releases', '--paginate', '--slurp'))
    return [release for page in pages for release in page]


def find_created_draft(tag):
    # GET /releases/tags/{tag} only returns published releases, not drafts.
    matches = [release for release in list_releases() if release['tag_name'] == tag]
    assert len(matches) == 1, 'Expected exactly one newly created draft release'
    release = matches[0]
    assert release['draft'] and not release['prerelease'], 'Expected an unpublished formal release draft'
    return release


def assert_draft_identity(release, expected_id):
    assert release['id'] == expected_id and release['tag_name'] == TAG, 'Draft identity changed'
    assert release['draft'] is True and release.get('published_at') is None, 'Draft was published; no overwrite'
    assert release['prerelease'] is False, 'Draft release type changed'



def create_draft(files, sha):
    # Use the creation response's ID; a fresh draft may be absent from listings.
    release = api('releases', '--method', 'POST', '-f', f'tag_name={TAG}',
        '-f', f'target_commitish={sha}', '-f', f'name=Antigravity Workbench {VERSION}',
        '-F', 'draft=true', '-F', 'prerelease=false',
        '-f', 'body=' + (ROOT / f'docs/RELEASE_{VERSION}.md').read_text(encoding='utf-8'))
    assert_draft_identity(release, release['id'])
    for file in files:
        endpoint = f'https://uploads.github.com/repos/{REPO}/releases/{release["id"]}/assets?name={quote(file.name)}'
        run('gh', 'api', endpoint, '--method', 'POST', '--input', str(file), '-H', 'Content-Type: application/octet-stream')
    return release


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('GITHUB_REPOSITORY') == REPO
    assert os.environ.get('GITHUB_REF') == 'refs/heads/main'
    assert os.environ.get('GITHUB_EVENT_NAME') == 'push'
    sha = os.environ['GITHUB_SHA']
    assert run('git', 'rev-parse', 'HEAD') == sha
    repository = api('')
    assert_repository_identity(repository)
    assert_repository_visibility(repository)
    assert api('git/ref/heads/main')['object']['sha'] == sha
    recovery_plan = os.environ.get('AG_RECOVER_RELEASE_PLAN')
    if VERSION == '0.0.7' and recovery_plan:
        print(run('python', str(ROOT / 'scripts/recover-release.py'), recovery_plan))
        return
    # Read-only guard: do not turn any API/auth failure into permission to overwrite.
    existing = [r for r in list_releases() if r['tag_name'] == TAG]
    assert len(existing) <= 1, 'Ambiguous existing release'
    if existing:
        print(f'{TAG} already exists; no release/tag/assets were modified.')
        return
    assert not api(f'git/matching-refs/tags/{TAG}'), 'Existing tag must be reviewed; no overwrite'

    artifacts = ROOT / 'artifacts'
    source = artifacts / f'antigravity-workbench-{VERSION}-source.zip'
    vsix = artifacts / f'antigravity-workbench-{VERSION}.vsix'
    run('git', 'archive', '--format=zip', f'--prefix=antigravity-workbench-{VERSION}/', f'--output={source}', sha)
    spec = importlib.util.spec_from_file_location('verify_release', ROOT / 'scripts/verify-release.py')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    manifest = verifier.verify(vsix, source)
    manifest.update({'repository': REPO, 'repository_id': REPO_ID, 'commit': sha, 'tag': TAG})
    manifest_path = artifacts / 'release-manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    files = [vsix, source, manifest_path]
    sums = artifacts / 'SHA256SUMS'
    sums.write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files), encoding='utf-8')
    files.append(sums)
    api('git/refs', '--method', 'POST', '-f', f'ref=refs/tags/{TAG}', '-f', f'sha={sha}')
    release = create_draft(files, sha)
    assert_draft_identity(release, release['id'])
    ref = api(f'git/ref/tags/{TAG}')['object']
    assert ref['type'] == 'commit' and ref['sha'] == sha
    assets = api(f'releases/{release["id"]}/assets')
    assert {a['name'] for a in assets} == {p.name for p in files}
    with tempfile.TemporaryDirectory(prefix='ag-release-download-') as tmp:
        for asset in assets:
            data = subprocess.check_output(['gh', 'api', f'repos/{REPO}/releases/assets/{asset["id"]}', '-H', 'Accept: application/octet-stream'], cwd=ROOT)
            (pathlib.Path(tmp) / asset['name']).write_bytes(data)
        for file in files:
            downloaded = pathlib.Path(tmp) / file.name
            assert downloaded.read_bytes() == file.read_bytes(), f'Upload differs: {file.name}'
        verifier.verify(pathlib.Path(tmp) / vsix.name, pathlib.Path(tmp) / source.name)
    assert_draft_identity(api(f'releases/{release["id"]}'), release['id'])
    repository = api('')
    assert_repository_identity(repository)
    assert_repository_visibility(repository)
    assert api('git/ref/heads/main')['object']['sha'] == sha
    assert api(f'git/ref/tags/{TAG}')['object']['sha'] == sha
    api(f'releases/{release["id"]}', '--method', 'PATCH', '-F', 'draft=false', '-f', 'make_latest=true')
    assert api(f'releases/{release["id"]}')['draft'] is False
    print(json.dumps({'release': release['html_url'], 'commit': sha, 'manifest': manifest,
        'download_verified_assets': [{'name': p.name, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}))



if __name__ == '__main__':
    main()
