"""Exercise release refusal paths without a network, token or repository mutation."""
import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publish', pathlib.Path(__file__).resolve().parents[1] / 'scripts/publish-release.py')
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


class ReleaseSafety(unittest.TestCase):
    def test_published_release_cannot_pass_draft_identity_guard(self):
        release = {'id': 123, 'tag_name': publish.TAG, 'draft': False, 'published_at': '2026-10-04T00:00:00Z', 'prerelease': False}
        with self.assertRaisesRegex(AssertionError, 'published'):
            publish.assert_draft_identity(release, 123)

    def test_changed_release_identity_stops(self):
        release = {'id': 124, 'tag_name': publish.TAG, 'draft': True, 'published_at': None, 'prerelease': False}
        with self.assertRaisesRegex(AssertionError, 'identity'):
            publish.assert_draft_identity(release, 123)

    def exercise(self, *, private=True, remote_sha='a' * 40, releases=None, tags=None, event='push', allow_public=False):
        calls = []
        def run(*args):
            calls.append(args)
            if args == ('git', 'rev-parse', 'HEAD'):
                return 'a' * 40
            if args[0:2] == ('gh', 'api') and args[2].endswith('/releases'):
                return json.dumps([releases or []])
            raise AssertionError('Unexpected command; mutation was blocked')
        def api(path, *args):
            calls.append(('api', path, *args))
            if path == '':
                return {'id': publish.REPO_ID, 'full_name': publish.REPO, 'private': private}
            if path == 'git/ref/heads/main':
                return {'object': {'sha': remote_sha}}
            if path == f'git/matching-refs/tags/{publish.TAG}':
                return tags or []
            raise AssertionError('Unexpected API; mutation was blocked')
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': publish.REPO, 'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': event, 'GITHUB_SHA': 'a' * 40}
        if allow_public:
            env['AG_ALLOW_PUBLIC_REPOSITORY'] = 'true'
        with patch.dict(publish.os.environ, env, clear=True), patch.object(publish, 'run', run), patch.object(publish, 'api', api):
            publish.main()
        return calls

    def test_existing_release_is_untouched(self):
        calls = self.exercise(releases=[{'tag_name': publish.TAG, 'draft': True}])
        self.assertFalse(any(c[0:2] == ('gh', 'release') for c in calls))

    def test_published_release_is_untouched_on_future_main_push(self):
        calls = self.exercise(releases=[{'tag_name': publish.TAG, 'id': 123, 'draft': False}])
        self.assertFalse(any(c[0:2] == ('gh', 'release') for c in calls))

    def test_created_draft_is_resolved_across_pages_without_published_tag_endpoint(self):
        draft = {'tag_name': publish.TAG, 'draft': True, 'prerelease': False, 'id': 123}
        pages = [[{'tag_name': 'other', 'draft': False}], [draft]]
        with patch.object(publish, 'run', return_value=json.dumps(pages)) as run, patch.object(publish, 'api', side_effect=AssertionError('Published tag lookup must not be used')):
            self.assertEqual(publish.find_created_draft(publish.TAG), draft)
        run.assert_called_once_with('gh', 'api', f'repos/{publish.REPO}/releases', '--paginate', '--slurp')

    def test_missing_created_draft_stops(self):
        with patch.object(publish, 'run', return_value='[[]]'), self.assertRaisesRegex(AssertionError, 'exactly one'):
            publish.find_created_draft(publish.TAG)

    def test_ambiguous_created_draft_stops(self):
        drafts = [{'tag_name': publish.TAG, 'draft': True, 'prerelease': False}] * 2
        with patch.object(publish, 'run', return_value=json.dumps([drafts])), self.assertRaisesRegex(AssertionError, 'exactly one'):
            publish.find_created_draft(publish.TAG)

    def test_published_release_cannot_be_treated_as_created_draft(self):
        releases = [{'tag_name': publish.TAG, 'draft': False, 'prerelease': False}]
        with patch.object(publish, 'run', return_value=json.dumps([releases])), self.assertRaisesRegex(AssertionError, 'unpublished'):
            publish.find_created_draft(publish.TAG)

    def test_existing_tag_stops_before_mutation(self):
        with self.assertRaisesRegex(AssertionError, 'Existing tag'):
            self.exercise(tags=[{'ref': 'refs/tags/' + publish.TAG}])

    def test_public_repo_stops(self):
        with self.assertRaises(AssertionError):
            self.exercise(private=False)

    def test_explicit_public_workflow_preserves_existing_release_without_mutation(self):
        calls = self.exercise(private=False, allow_public=True, releases=[{'tag_name': publish.TAG, 'id': 123, 'draft': False}])
        self.assertFalse(any(c[0:2] == ('gh', 'release') for c in calls))

    def test_private_visibility_remains_supported_for_publish_and_recovery(self):
        with patch.dict(publish.os.environ, {}, clear=True):
            for module in [publish, recover]:
                module.assert_repository_visibility({'private': True})

    def test_only_the_exact_clean_repository_identity_is_accepted(self):
        for module in [publish, recover]:
            module.assert_repository_identity({'id': module.REPO_ID, 'full_name': module.REPO})
            for invalid in [{}, {'id': module.REPO_ID}, {'id': module.REPO_ID + 1, 'full_name': module.REPO},
                    {'id': module.REPO_ID, 'full_name': module.REPO + '-other'},
                    {'id': str(module.REPO_ID), 'full_name': module.REPO}]:
                with self.assertRaisesRegex(AssertionError, 'identity'):
                    module.assert_repository_identity(invalid)

    def test_public_and_invalid_visibility_require_exact_explicit_permission(self):
        for permission in ['', 'false', 'True', '1']:
            with patch.dict(publish.os.environ, {'AG_ALLOW_PUBLIC_REPOSITORY': permission}, clear=True):
                for module in [publish, recover]:
                    with self.assertRaises(AssertionError):
                        module.assert_repository_visibility({'private': False})
        with patch.dict(publish.os.environ, {'AG_ALLOW_PUBLIC_REPOSITORY': 'true'}, clear=True):
            for module in [publish, recover]:
                module.assert_repository_visibility({'private': False})
                for value in [{}, {'private': None}, {'private': 'false'}, {'private': 0}]:
                    with self.assertRaises(AssertionError):
                        module.assert_repository_visibility(value)

    def test_changed_main_stops(self):
        with self.assertRaises(AssertionError):
            self.exercise(remote_sha='b' * 40)

    def test_pull_request_cannot_publish(self):
        with self.assertRaises(AssertionError):
            self.exercise(event='pull_request')


recovery_spec = importlib.util.spec_from_file_location('recover', pathlib.Path(__file__).resolve().parents[1] / 'scripts/recover-release.py')
recover = importlib.util.module_from_spec(recovery_spec)
recovery_spec.loader.exec_module(recover)


class RecoverySafety(unittest.TestCase):
    def fixture(self):
        plan = {'release_id': 123, 'tag': 'v0.0.7', 'commit': 'a' * 40, 'validated_run': 1,
            'assets': {name: {'id': index, 'sha256': 'b' * 64} for index, name in enumerate(
                ['antigravity-workbench-0.0.7-source.zip', 'antigravity-workbench-0.0.7.vsix', 'release-manifest.json', 'SHA256SUMS'], start=10)}}
        release = {'id': plan['release_id'], 'tag_name': plan['tag'], 'target_commitish': plan['commit'],
            'draft': True, 'published_at': None, 'prerelease': False,
            'assets': [{'name': name, 'id': value['id'], 'digest': 'sha256:' + value['sha256']} for name, value in plan['assets'].items()]}
        return plan, release

    def test_reviewed_exact_draft_is_accepted(self):
        plan, release = self.fixture()
        recover.verify_metadata(release, plan)

    def test_changed_id_tag_or_commit_is_rejected(self):
        for key in ['id', 'tag_name', 'target_commitish']:
            plan, release = self.fixture()
            release[key] = 'changed'
            with self.assertRaises(AssertionError):
                recover.verify_metadata(release, plan)

    def test_missing_extra_or_changed_asset_is_rejected(self):
        for change in ['missing', 'extra', 'digest', 'id']:
            plan, release = self.fixture()
            if change == 'missing':
                release['assets'].pop()
            elif change == 'extra':
                release['assets'].append(release['assets'][0])
            else:
                release['assets'][0][change] = 'changed'
            with self.assertRaises(AssertionError):
                recover.verify_metadata(release, plan)

    def test_published_metadata_requires_timestamp(self):
        plan, release = self.fixture()
        release['draft'] = False
        with self.assertRaises(AssertionError):
            recover.verify_metadata(release, plan)
        release['published_at'] = '2026-10-05T00:00:00Z'
        recover.verify_metadata(release, plan)

    def test_exact_three_platform_success_is_required(self):
        plan, _ = self.fixture()
        run_data = {'head_sha': plan['commit'], 'event': 'push', 'head_branch': 'main'}
        jobs = [{'name': f'validate ({name}-latest)', 'status': 'completed', 'conclusion': 'success'} for name in ['ubuntu', 'windows', 'macos']]
        recover.verify_validation(run_data, jobs, plan)
        for changed in [jobs[:-1], jobs + [jobs[0]], [{**jobs[0], 'conclusion': 'failure'}, *jobs[1:]]]:
            with self.assertRaises(AssertionError):
                recover.verify_validation(run_data, changed, plan)
        with self.assertRaises(AssertionError):
            recover.verify_validation({**run_data, 'head_sha': 'changed'}, jobs, plan)

    def test_recovery_rejects_pull_request_before_any_command(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': recover.REPO, 'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'pull_request'}
        with patch.dict(recover.os.environ, env, clear=True), patch.object(recover, 'run') as command, self.assertRaises(AssertionError):
            recover.main('unused')
        command.assert_not_called()

    def test_new_draft_upload_uses_creation_response_id_without_listing(self):
        release = {'id': 501, 'tag_name': publish.TAG, 'draft': True, 'published_at': None, 'prerelease': False}
        with patch.object(publish, 'api', return_value=release) as api, patch.object(publish, 'run') as command, patch.object(publish, 'list_releases', side_effect=AssertionError('Do not list a newly created draft')):
            self.assertEqual(publish.create_draft([pathlib.Path('reviewed.vsix')], 'a' * 40), release)
        self.assertEqual(api.call_count, 1)
        self.assertEqual(api.call_args.args[:3], ('releases', '--method', 'POST'))
        self.assertIn('/releases/501/assets?name=reviewed.vsix', command.call_args.args[2])
        self.assertEqual(command.call_args.args[3:7], ('--method', 'POST', '--input', 'reviewed.vsix'))


if __name__ == '__main__':
    unittest.main()
