"""Remove only this release's merged workbench branch, with an atomic Git lease."""
import importlib.util
import json
import os
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_publish', ROOT / 'scripts/publish-release.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)
api = publish.api
run = publish.run
BRANCH = 'codex/unified-workbench-design'
REF = 'refs/heads/' + BRANCH


def branch_refs():
    refs = [ref for ref in api('git/matching-refs/heads/' + BRANCH) if ref['ref'] == REF]
    assert len(refs) <= 1, 'Ambiguous release branch'
    return refs


def main():
    assert os.environ.get('GITHUB_ACTIONS') == 'true'
    assert os.environ.get('GITHUB_REPOSITORY') == publish.REPO
    assert os.environ.get('GITHUB_REF') == 'refs/heads/main'
    assert os.environ.get('GITHUB_EVENT_NAME') == 'push'
    sha = os.environ['GITHUB_SHA']
    assert re.fullmatch(r'[0-9a-f]{40}', sha), 'Invalid main commit'
    assert run('git', 'rev-parse', 'HEAD') == sha
    assert run('git', 'remote', 'get-url', 'origin') in {'https://github.com/' + publish.REPO, 'https://github.com/' + publish.REPO + '.git'}
    publish.assert_repository_identity(api(''))
    assert api('git/ref/heads/main')['object']['sha'] == sha, 'main moved'
    refs = branch_refs()
    if not refs:
        print(BRANCH + ' already absent; no refs changed.')
        return
    release = api('releases/tags/' + publish.TAG)
    assert release['draft'] is False and release['prerelease'] is False and release.get('published_at'), 'Release is not published'
    tag = api('git/ref/tags/' + publish.TAG)['object']
    assert tag['type'] == 'commit' and tag['sha'] == sha, 'Release tag differs'
    prs = [pr for pr in api('commits/' + sha + '/pulls') if pr['head']['ref'] == BRANCH
           and pr['head']['repo']['id'] == publish.REPO_ID and pr['base']['ref'] == 'main']
    assert len(prs) == 1, 'Expected this release merged PR'
    pr = api('pulls/' + str(prs[0]['number']))
    assert pr['merged'] is True and pr['merge_commit_sha'] == sha and pr['base']['ref'] == 'main', 'PR is not merged into this main commit'
    assert pr['head']['ref'] == BRANCH and pr['head']['repo']['id'] == publish.REPO_ID, 'PR branch identity differs'
    head = pr['head']['sha']
    assert re.fullmatch(r'[0-9a-f]{40}', head), 'Invalid PR head'
    assert refs[0]['object']['type'] == 'commit' and refs[0]['object']['sha'] == head, 'Branch head moved'
    # A nonzero exit refuses a branch with commits outside this merged main.
    run('git', 'merge-base', '--is-ancestor', head, sha)
    assert branch_refs()[0]['object']['sha'] == head, 'Branch head moved before cleanup'
    # Git's lease also rejects a concurrent branch update after the final read.
    # gh consumes only the existing ephemeral Actions token; no token is printed.
    run('git', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
        'push', '--force-with-lease=' + REF + ':' + head, 'origin', ':' + REF)
    assert not branch_refs(), 'Release branch remains'
    print(json.dumps({'deleted_branch': BRANCH, 'merged_pr': pr['number'], 'head': head, 'main': sha}))


if __name__ == '__main__':
    main()
