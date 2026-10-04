#!/usr/bin/env python3
"""Temporary fixtures only. No production Client, network, Host or model call."""
import copy
import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('round10_controller_guard_target', pathlib.Path(__file__).with_name('round10-real-rerun.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
m = c.m


class Guards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='round10-controller-offline-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.candidate, self.installed, self.evidence = [self.root / p for p in ('candidate', 'installed', 'evidence')]
        self.previous, self.sample, self.cwd = [self.root / p for p in ('previous', 'sample', 'cwd')]
        for path in (self.candidate, self.installed, self.evidence, self.previous, self.sample, self.cwd):
            path.mkdir()
        self.addCleanup(patch.stopall)
        patch.object(c, 'CANDIDATE', self.candidate).start()
        patch.object(c, 'QUALIFICATION', self.evidence / 'candidate-qualification.json').start()
        patch.multiple(m, REPO=self.installed, EVIDENCE=self.evidence, SAMPLE=self.sample,
                       PREVIOUS_SAMPLE=self.previous, CWD=self.cwd).start()
        patch.object(m, 'Client', side_effect=AssertionError('PRODUCTION_CLIENT_FORBIDDEN')).start()
        self.contents = b'Full required material; fixture only.'
        self.entry = {'id': 'required', 'path': 'knowledge/skills/zhijian-report-craft/required.md',
                      'bytes': len(self.contents), 'sha256': m.sha(self.contents), 'roles': ['writer', 'renderer', 'reviewer'],
                      'styles': ['credit-policy', 'designer-paper'], 'kind': 'instruction'}
        self.manifest = {'schemaVersion': 2, 'materialPackId': 'zhijian-report-craft-v2', 'entries': [self.entry]}
        digest = m.sha(json.dumps(self.manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
        for root in (self.candidate, self.installed):
            for name in ('package.json', 'packages/pack-contract/index.mjs', 'packages/pack-artifact/index.mjs'):
                target = root / name; target.parent.mkdir(parents=True, exist_ok=True); target.write_text('{}')
            target = root / self.entry['path']; target.parent.mkdir(parents=True); target.write_bytes(self.contents)
            m.save(root / 'knowledge/skills/zhijian-report-craft/materials.v2.json', self.manifest)
            (root / 'lib').mkdir()
            (root / 'lib/report-craft-materials.js').write_text(f'export const REPORT_CRAFT_MATERIAL_DIGEST = "{digest}";\n')
        self.runtime = c.runtime_at(self.candidate)
        self.identity = c.material_identity(self.candidate)
        (self.evidence / 'build.log').write_text('build succeeded\n')
        (self.evidence / 'tests.log').write_text('fixture test passed\n')
        self.qualification = {'status': 'PASS', 'candidateRoot': str(self.candidate), 'runtime': self.runtime,
            'materialIdentity': self.identity,
            'build': {'path': str(self.evidence / 'build.log'), 'sha256': m.sha((self.evidence / 'build.log').read_bytes()), 'exitCode': 0},
            'tests': [{'path': str(self.evidence / 'tests.log'), 'sha256': m.sha((self.evidence / 'tests.log').read_bytes()), 'status': 'PASS'}]}
        m.save(c.QUALIFICATION, self.qualification)
        self.report = {'status': 'PASS', 'isolated': True, 'productionTouched': False, 'stopped': True,
                       'businessApiCalls': 0, 'realLlmCalls': 0, 'candidateRuntimeSha256': self.runtime['sha256'],
                       'candidateRuntimeFileCount': self.runtime['fileCount']}
        for name in m.HOST_REPORTS: m.save(self.evidence / name, self.report)

    def gate(self): return c.payload_gate(self.runtime['sha256'])

    def test_gate_accepts_same_runtime_complete_materials_qualification_and_four_hosts(self):
        result = self.gate()
        self.assertEqual(result['priorTeamCount'], 11)
        self.assertTrue(result['artifactAcceptanceRequired'])

    def test_each_host_receipt_is_required(self):
        for name in m.HOST_REPORTS:
            with self.subTest(name=name):
                path = self.evidence / name; path.unlink()
                with self.assertRaises(FileNotFoundError): self.gate()
                m.save(path, self.report)

    def test_host_negative_or_unbound_receipts_rejected(self):
        for field, value in [('status', 'FAILED'), ('isolated', False), ('productionTouched', True), ('stopped', False),
                             ('businessApiCalls', 1), ('realLlmCalls', 1), ('candidateRuntimeSha256', 'a'*64), ('candidateRuntimeFileCount', 1)]:
            with self.subTest(field=field):
                m.save(self.evidence / m.HOST_REPORTS[0], {**self.report, field: value})
                with self.assertRaises(RuntimeError): self.gate()
        m.save(self.evidence / m.HOST_REPORTS[0], self.report)

    def test_build_test_or_identity_qualification_invalid(self):
        mutations = [lambda r: r.update(status='FAILED'), lambda r: r.update(candidateRoot='/other'),
                     lambda r: r['runtime'].update(sha256='a'*64), lambda r: r['materialIdentity'].update(materialDigest='b'*64),
                     lambda r: r['build'].update(exitCode=1), lambda r: r['build'].update(exitCode=False),
                     lambda r: r.update(tests=[]), lambda r: r['tests'][0].update(status='FAILED')]
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index):
                changed = copy.deepcopy(self.qualification); mutation(changed); m.save(c.QUALIFICATION, changed)
                with self.assertRaises(RuntimeError): self.gate()

    def test_qualification_log_bytes_change_rejected(self):
        (self.evidence / 'build.log').write_text('different build')
        with self.assertRaisesRegex(RuntimeError, 'QUALIFICATION_EVIDENCE_CHANGED'): self.gate()

    def test_qualification_log_outside_evidence_rejected(self):
        self.qualification['build']['path'] = str(self.candidate / 'package.json')
        m.save(c.QUALIFICATION, self.qualification)
        with self.assertRaisesRegex(RuntimeError, 'QUALIFICATION_EVIDENCE_PATH_INVALID'): self.gate()

    def test_installed_runtime_drift_rejected(self):
        (self.installed / 'lib/extra.js').write_text('not candidate')
        with self.assertRaisesRegex(RuntimeError, 'RUNTIME_PAYLOAD_CHANGED'): self.gate()

    def test_candidate_runtime_drift_rejected(self):
        (self.candidate / 'lib/extra.js').write_text('changed after build')
        with self.assertRaisesRegex(RuntimeError, 'CANDIDATE_RUNTIME_CHANGED'): self.gate()

    def test_material_bytes_drift_rejected(self):
        (self.installed / self.entry['path']).write_text('missing rule')
        with self.assertRaisesRegex(RuntimeError, 'MATERIAL_BYTES_CHANGED'): self.gate()

    def test_material_manifest_not_automatically_trusted(self):
        self.manifest['entries'][0]['bytes'] = 1
        m.save(self.installed / 'knowledge/skills/zhijian-report-craft/materials.v2.json', self.manifest)
        with self.assertRaisesRegex(RuntimeError, 'MATERIAL_COMPILED_DIGEST_MISMATCH'): self.gate()

    def test_material_symlink_rejected(self):
        target = self.installed / self.entry['path']; target.unlink(); target.symlink_to(self.candidate / self.entry['path'])
        with self.assertRaisesRegex(RuntimeError, 'MATERIAL_PATH_ALIAS'): self.gate()

    def test_material_path_escape_rejected(self):
        self.manifest['entries'][0]['path'] = '../outside'
        digest = m.sha(json.dumps(self.manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
        m.save(self.installed / 'knowledge/skills/zhijian-report-craft/materials.v2.json', self.manifest)
        (self.installed / 'lib/report-craft-materials.js').write_text(f'const REPORT_CRAFT_MATERIAL_DIGEST = "{digest}"')
        with self.assertRaisesRegex(RuntimeError, 'MATERIAL_PATH_INVALID'): c.material_identity(self.installed)

    def test_old_runtime_not_admitted_as_new(self):
        with self.assertRaises(RuntimeError): c.payload_gate(m.OLD_RUNTIME_SHA256)

    def baseline(self):
        paths = []
        for index in range(11):
            path = self.cwd / 'expert-teams' / f'team-{index}' / 'team.json'
            m.save(path, {'name': f'team-{index}', 'captainSessionId': m.OLD_CAPTAIN if index == 10 else f'prior-{index}',
                         'halted': index < 9, 'tasks': [{'id': 't1', 'status': 'completed'}], 'taskSeq': 1, 'members': []})
            paths.append(path)
        patch.object(m, 'PAUSED_TEAMS', tuple(paths)).start()
        return paths

    def test_baseline_nine_halted_two_completed_and_exact_eleven(self):
        self.baseline()
        self.assertEqual(len(c.paused_snapshot()), 11)
        self.assertEqual([x['halted'] for x in c.paused_snapshot()], [True]*9+[False]*2)
        with patch.object(m, 'PAUSED_TEAMS', m.PAUSED_TEAMS[:-1]):
            with self.assertRaisesRegex(RuntimeError, 'ELEVEN_PRIOR_TEAMS_REQUIRED'): c.paused_snapshot()

    def test_old_halted_team_resumed_rejected(self):
        paths = self.baseline(); team = m.load(paths[0]); team['halted'] = False; m.save(paths[0], team)
        with self.assertRaises(RuntimeError): c.paused_snapshot()

    def prepare_fixture(self):
        self.baseline()
        old_team = m.OLD_TEAM_ID
        prompt = f'Original business task. Deliver MD/HTML/PDF. Output {m.OLD_OUTPUT_REL}/. Team {old_team}. No old artifacts.'
        observer = f'VERSION = 4\nRUN_FILE = pathlib.Path({str(self.previous / "run.json")!r})\nEXPECTED_CAPTAIN = {m.OLD_CAPTAIN!r}\nartifact_roots = [cwd / {m.OLD_OUTPUT_REL!r}]\n'
        (self.previous / 'prompt.txt').write_text(prompt)
        (self.previous / 'observe.py').write_text(observer)
        m.save(self.previous / 'preparation.json', {'sessionId': m.OLD_CAPTAIN, 'tenantId': m.UID, 'outputRelativePath': m.OLD_OUTPUT_REL,
            'teamName': old_team, 'promptSha256': m.sha(prompt.encode()), 'observerSha256': m.sha(observer.encode()),
            'modelControl': {'provider': m.PROVIDER, 'model': m.MODEL, 'reasoningEffort': 'default'}})
        m.save(self.previous / 'previous-finalization.json', {'teams': c.paused_snapshot()[:-1]})
        return prompt

    def test_prepare_changes_only_two_isolation_labels_and_does_not_claim_quality(self):
        before = self.prepare_fixture(); prep = c.prepare()
        expected = before.replace(m.OLD_OUTPUT_REL, m.OUTPUT_REL).replace(m.OLD_TEAM_ID, prep['teamName'])
        self.assertEqual((self.sample / 'prompt.txt').read_text(), expected)
        self.assertEqual(len(prep['priorPausedTeamsBaseline']), 10)
        self.assertTrue(prep['artifactAcceptanceRequired'])
        self.assertEqual(c.preparation()['sessionId'], prep['sessionId'])
        self.assertEqual(c.prepare()['status'], 'already_prepared')

    def test_prepare_prior_task_change_rejected(self):
        self.prepare_fixture(); team = m.load(m.PAUSED_TEAMS[9]); team['tasks'][0]['status'] = 'pending'; m.save(m.PAUSED_TEAMS[9], team)
        with self.assertRaisesRegex(RuntimeError, 'PRIOR_TEN_TEAM_BASELINE_CHANGED'): c.prepare()

    def test_prepared_prompt_tamper_rejected(self):
        self.prepare_fixture(); c.prepare(); (self.sample / 'prompt.txt').write_text('add defect answers')
        with self.assertRaisesRegex(RuntimeError, 'PREPARED_PROMPT_CHANGED'): c.preparation()

    def test_observer_unchanged_except_scope(self):
        self.prepare_fixture(); prep = c.prepare(); text = (self.sample / 'observe.py').read_text()
        self.assertIn(prep['sessionId'], text); self.assertNotIn(m.OLD_CAPTAIN, text); self.assertNotIn(str(self.previous), text)
        self.assertNotIn('session/prompt', text)

    def test_gate_precedes_client_for_every_production_action(self):
        for action in ('preflight', 'reload', 'reconcile-reload', 'create', 'start'):
            with self.subTest(action=action), patch.object(m, 'preparation', return_value={}), \
                 patch.object(m, 'payload_gate', side_effect=RuntimeError('BLOCK_BEFORE_CLIENT')), \
                 patch.object(sys, 'argv', ['controller', action, '--expected-runtime-sha256', self.runtime['sha256']]):
                with self.assertRaisesRegex(RuntimeError, 'BLOCK_BEFORE_CLIENT'): m.main()

    def test_ambiguous_start_not_resent(self):
        run = {'sessionId': 'session-fixture', 'runtimeSha256': self.runtime['sha256'], 'status': 'start_pending'}
        m.save(self.sample / 'run.json', run)
        class NoRpc:
            def rpc(self, *args, **kwargs): raise AssertionError('AMBIGUOUS_START_RESENT')
        with patch.object(m, 'require_reloaded', return_value={}):
            with self.assertRaisesRegex(RuntimeError, 'START_ALREADY_ATTEMPTED_OR_NOT_READY'):
                m.start_session(NoRpc(), {'sessionId': run['sessionId']}, self.runtime['sha256'])

    def test_no_completion_or_arbitrary_rpc_action(self):
        for action in ('complete', 'seal', 'rpc', 'prompt'):
            with self.subTest(action=action), patch.object(sys, 'argv', ['controller', action]):
                with self.assertRaises(SystemExit) as caught: m.main()
                self.assertEqual(caught.exception.code, 2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
