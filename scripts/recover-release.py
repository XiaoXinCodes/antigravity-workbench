"""Resume one explicitly reviewed draft; never create, replace or delete assets/tags."""
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = 'XiaoXinCodes/antigravity-workbench'
REPO_ID = 1409536968


def run(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def api(path, *args):
    return json.loads(run('gh', 'api', f'repos/{REPO}/{path}', *args))


def assert_repository_identity(repository):
    assert repository.get('id') == REPO_ID and repository.get('full_name') == REPO, 'Release repository identity changed'


def assert_repository_visibility(repository):
    assert repository.get('private') is True or (
        repository.get('private') is False and os.environ.get('AG_ALLOW_PUBLIC_REPOSITORY') == 'true'
    ), 'Public repository publication requires explicit workflow permission'


def verify_metadata(release, plan):
    assert release['id'] == plan['release_id'] and release['tag_name'] == plan['tag'], 'Release identity changed'
    assert release['target_commitish'] == plan['commit'], 'Release commit changed'
    assert release['prerelease'] is False, 'Release type changed'
    assets = release['assets']
    assert len(assets) == len(plan['assets']) == 4, 'Asset count changed'
    actual = {a['name']: {'id': a['id'], 'sha256': a['digest'].removeprefix('sha256:')} for a in assets}
    assert actual == plan['assets'], 'Asset identity or digest changed'
    if release['draft']:
        assert release.get('published_at') is None, 'Draft publication state changed'
    else:
        assert release.get('published_at'), 'Published release has no timestamp'


def verify_validation(run_data, jobs, plan):
    assert run_data['head_sha'] == plan['commit'] and run_data['event'] == 'push' and run_data['head_branch'] == 'main', 'Validation commit changed'
    wanted = {'validate (ubuntu-latest)', 'validate (windows-latest)', 'validate (macos-latest)'}
    found = [j for j in jobs if j['name'] in wanted]
    assert len(found) == 3 and {j['name'] for j in found} == wanted, 'Missing platform validation'
    assert all(j['status'] == 'completed' and j['conclusion'] == 'success' for j in found), 'Platform validation failed'


def main(plan_path):
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('GITHUB_REPOSITORY') == REPO
    assert os.environ.get('GITHUB_REF') == 'refs/heads/main' and os.environ.get('GITHUB_EVENT_NAME') == 'push'
    head = os.environ['GITHUB_SHA']
    assert run('git', 'rev-parse', 'HEAD') == head
    plan = json.loads(pathlib.Path(plan_path).read_text(encoding='utf-8'))
    assert plan.get('repository_id') == REPO_ID, 'Recovery repository identity changed'
    assert plan['tag'] == 'v' + json.loads((ROOT / 'package.json').read_text())['version']
    repository = json.loads(run('gh', 'api', f'repos/{REPO}'))
    assert_repository_identity(repository)
    assert_repository_visibility(repository)
    assert api('git/ref/heads/main')['object']['sha'] == head
    ref = api('git/ref/tags/' + plan['tag'])['object']
    assert ref['type'] == 'commit' and ref['sha'] == plan['commit'], 'Tag changed'
    release = api(f'releases/{plan["release_id"]}')
    verify_metadata(release, plan)
    if not release['draft']:
        print(json.dumps({'release': release['html_url'], 'already_published': True, 'modified': False}))
        return
    verify_validation(api(f'actions/runs/{plan["validated_run"]}'), api(f'actions/runs/{plan["validated_run"]}/jobs?per_page=100')['jobs'], plan)
    # Only release tooling may differ from the already validated product commit.
    run('git', 'merge-base', '--is-ancestor', plan['commit'], head)
    run('git', 'diff', '--exit-code', plan['commit'], head, '--', '.', ':!scripts/', ':!test/release-safety.test.py', ':!.github/workflows/ci.yml')
    with tempfile.TemporaryDirectory(prefix='ag-verified-draft-') as tmp:
        directory = pathlib.Path(tmp)
        files = {}
        for name, expected in plan['assets'].items():
            assert pathlib.Path(name).name == name
            data = subprocess.check_output(['gh', 'api', f'repos/{REPO}/releases/assets/{expected["id"]}', '-H', 'Accept: application/octet-stream'], cwd=ROOT)
            assert hashlib.sha256(data).hexdigest() == expected['sha256'], f'Download differs: {name}'
            files[name] = directory / name
            files[name].write_bytes(data)
        sums = dict((name, digest) for digest, name in (line.split('  ') for line in files['SHA256SUMS'].read_text().splitlines()))
        assert sums == {name: value['sha256'] for name, value in plan['assets'].items() if name != 'SHA256SUMS'}, 'Checksum document differs'
        source = directory / 'source'
        run('git', 'worktree', 'add', '--detach', str(source), plan['commit'])
        try:
            run('npm', 'ci', '--ignore-scripts', cwd=source)
            run('npm', 'run', 'compile', cwd=source)
            version = plan['tag'].removeprefix('v')
            verified = json.loads(run('python', str(source / 'scripts/verify-release.py'), str(files[f'antigravity-workbench-{version}.vsix']), str(files[f'antigravity-workbench-{version}-source.zip']), cwd=source))
            manifest = json.loads(files['release-manifest.json'].read_text())
            assert all(manifest[key] == value for key, value in verified.items()), 'Manifest differs from verified bytes'
            assert manifest['repository'] == REPO and manifest['commit'] == plan['commit'] and manifest['tag'] == plan['tag']
            assert manifest['repository_id'] == REPO_ID
        finally:
            run('git', 'worktree', 'remove', '--force', str(source))
        latest = api(f'releases/{plan["release_id"]}')
        verify_metadata(latest, plan)
        assert latest['draft'] and latest.get('published_at') is None, 'Draft changed before publication'
        assert api('git/ref/heads/main')['object']['sha'] == head
        assert api('git/ref/tags/' + plan['tag'])['object']['sha'] == plan['commit']
        repository = json.loads(run('gh', 'api', f'repos/{REPO}'))
        assert_repository_identity(repository)
        assert_repository_visibility(repository)
        published = api(f'releases/{plan["release_id"]}', '--method', 'PATCH', '-F', 'draft=false', '-f', 'make_latest=true')
        verify_metadata(published, plan)
        assert published['draft'] is False
        # Verify the same four attachments again after formal publication.
        for name, expected in plan['assets'].items():
            data = subprocess.check_output(['gh', 'api', f'repos/{REPO}/releases/assets/{expected["id"]}', '-H', 'Accept: application/octet-stream'], cwd=ROOT)
            assert data == files[name].read_bytes(), f'Published asset changed: {name}'
        print(json.dumps({'release': published['html_url'], 'commit': plan['commit'], 'manifest': manifest,
            'download_verified_assets': [{'name': name, 'sha256': data['sha256']} for name, data in plan['assets'].items()], 'published_download_verified': True}))


if __name__ == '__main__':
    import sys
    main(sys.argv[1])
