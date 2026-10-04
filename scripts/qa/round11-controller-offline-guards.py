#!/usr/bin/env python3
"""Temporary fixtures only. No production Client, network, Host or model call."""
import copy
import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('round11_controller_guard_target', pathlib.Path(__file__).with_name('round11-real-rerun.py'))
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
m = c.m


class Guards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='round11-controller-offline-')
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
            domain = root / 'domain-packs/zhijian-realestate'
            m.save(domain / 'pack.json', {'id':'zhijian-realestate','version':'1.2.0','schemaVersion':2})
            for skill in ('zhijian-report-craft','zhijian-designer-render'):
                m.save(domain / 'skill-packages' / (skill+'.json'), {'id':skill,'craft':{'path':'fixture.json'}})
            (root / 'lib').mkdir()
            (root / 'lib/report-craft-materials.js').write_text(f'export const REPORT_CRAFT_MATERIAL_DIGEST = "{digest}";\n')
        self.runtime = c.runtime_at(self.candidate)
        self.identity = c.material_identity(self.candidate)
        self.domain_identity = c.domain_identity(self.candidate)
        (self.evidence / 'build.log').write_text('build succeeded\n')
        (self.evidence / 'tests.log').write_text('fixture test passed\n')
        self.qualification = {'status': 'PASS', 'candidateRoot': str(self.candidate), 'runtime': self.runtime,
            'materialIdentity': self.identity, 'domainPackIdentity': self.domain_identity,
            'build': {'path': str(self.evidence / 'build.log'), 'sha256': m.sha((self.evidence / 'build.log').read_bytes()), 'exitCode': 0},
            'tests': [{'path': str(self.evidence / 'tests.log'), 'sha256': m.sha((self.evidence / 'tests.log').read_bytes()), 'status': 'PASS'}]}
        m.save(c.QUALIFICATION, self.qualification)
        self.report = {'status': 'PASS', 'isolated': True, 'productionTouched': False, 'stopped': True,
                       'businessApiCalls': 0, 'realLlmCalls': 0, 'candidateRuntimeSha256': self.runtime['sha256'],
                       'candidateRuntimeFileCount': self.runtime['fileCount'], 'domainPackIdentity': self.domain_identity}
        for name in m.HOST_REPORTS: m.save(self.evidence / name, self.report)

    def gate(self): return c.payload_gate(self.runtime['sha256'])

    def domain_install_fixture(self):
        shutil.copytree(self.candidate / 'domain-packs', self.cwd / 'domain-packs')
        m.save(self.evidence / 'real-domain-switch.json', {'status':'APPLIED',
               'domainPackIdentity':self.domain_identity,
               'targetRoot':str(self.cwd / 'domain-packs/zhijian-realestate')})
        return {'sessionId':'session-fixture','skills':[{'packId':'zhijian-realestate','skillId':skill,
                'root':str(self.cwd / 'domain-packs/zhijian-realestate'),'packVersion':'1.2.0',
                'treeDigest':self.domain_identity['contentTreeSha256']}
                for skill in ('zhijian-report-craft','zhijian-designer-render')]}

    def test_scope_installation_and_actual_catalog_are_required_before_business_start(self):
        class NoCalls:
            def request(self,*args,**kwargs):raise AssertionError('CATALOG_BEFORE_INSTALL')
        with self.assertRaises(FileNotFoundError): c.verify_real_domain_catalog(NoCalls(),'session-fixture')
        catalog=self.domain_install_fixture()
        class Fake:
            def request(self,path,tenant=False):
                assert tenant and path.endswith('session_id=session-fixture')
                return catalog
        self.assertEqual(c.verify_real_domain_catalog(Fake(),'session-fixture')['status'],'PASS')
        for field,value in [('root','/wrong'),('packVersion','1.1.0'),('treeDigest','0'*64)]:
            old=catalog['skills'][0][field];catalog['skills'][0][field]=value
            with self.assertRaisesRegex(RuntimeError,'CATALOG_IDENTITY'):c.verify_real_domain_catalog(Fake(),'session-fixture')
            catalog['skills'][0][field]=old
        catalog['skills'].pop()
        with self.assertRaisesRegex(RuntimeError,'SKILLS_MISSING'):c.verify_real_domain_catalog(Fake(),'session-fixture')
        (self.cwd / 'domain-packs/zhijian-realestate/extra.txt').write_text('drift')
        with self.assertRaisesRegex(RuntimeError,'INSTALLED_BYTES_CHANGED'):c.require_real_domain_installation()

    def test_create_and_start_never_mutate_before_current_scope_catalog_passes(self):
        for method,original in [(c.create_session,'original_create_session'),(c.start_session,'original_start_session')]:
            with patch.object(c,'verify_real_domain_catalog',side_effect=RuntimeError('SCOPE_BLOCKED')), \
                 patch.object(c,original,side_effect=AssertionError('BUSINESS_MUTATION_BEFORE_SCOPE')):
                with self.assertRaisesRegex(RuntimeError,'SCOPE_BLOCKED'):method(object(),{'sessionId':'session-fixture'},'sha')

    def test_gate_accepts_same_runtime_complete_materials_qualification_and_four_hosts(self):
        result = self.gate()
        self.assertEqual(result['priorTeamCount'], 12)
        self.assertTrue(result['artifactAcceptanceRequired'])

    def test_domain_pack_drift_and_unbound_host_receipts_block_release(self):
        target=self.installed/'domain-packs/zhijian-realestate/extra.txt'
        target.write_text('unqualified')
        with self.assertRaisesRegex(RuntimeError,'INSTALLED_DOMAIN_PACK'):self.gate()
        target.unlink()
        report={**self.report}; report.pop('domainPackIdentity')
        m.save(self.evidence/m.HOST_REPORTS[0],report)
        with self.assertRaisesRegex(RuntimeError,'HOST_DOMAIN_PACK'):self.gate()

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
        for index in range(12):
            path = self.cwd / 'expert-teams' / f'team-{index}' / 'team.json'
            m.save(path, {'name': f'team-{index}', 'captainSessionId': m.OLD_CAPTAIN if index == 11 else f'prior-{index}',
                         'halted': index < 9, 'tasks': [{'id': 't1', 'status': 'completed'}], 'taskSeq': 1, 'members': []})
            paths.append(path)
        patch.object(m, 'PAUSED_TEAMS', tuple(paths)).start()
        return paths

    def test_baseline_nine_halted_two_completed_one_recent_and_exact_twelve(self):
        self.baseline()
        self.assertEqual(len(c.paused_snapshot()), 12)
        self.assertEqual([x['halted'] for x in c.paused_snapshot()], [True]*9+[False]*3)
        with patch.object(m, 'PAUSED_TEAMS', m.PAUSED_TEAMS[:-1]):
            with self.assertRaisesRegex(RuntimeError, 'TWELVE_PRIOR_TEAMS_REQUIRED'): c.paused_snapshot()

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
        self.assertEqual(len(prep['priorPausedTeamsBaseline']), 11)
        self.assertTrue(prep['artifactAcceptanceRequired'])
        self.assertEqual(c.preparation()['sessionId'], prep['sessionId'])
        self.assertEqual(c.prepare()['status'], 'already_prepared')

    def test_prepare_prior_task_change_rejected(self):
        self.prepare_fixture(); team = m.load(m.PAUSED_TEAMS[9]); team['tasks'][0]['status'] = 'pending'; m.save(m.PAUSED_TEAMS[9], team)
        with self.assertRaisesRegex(RuntimeError, 'PRIOR_ELEVEN_TEAM_BASELINE_CHANGED'): c.prepare()

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
        with patch.object(m, 'require_reloaded', return_value={}), patch.object(c,'verify_real_domain_catalog',return_value={}):
            with self.assertRaisesRegex(RuntimeError, 'START_ALREADY_ATTEMPTED_OR_NOT_READY'):
                m.start_session(NoRpc(), {'sessionId': run['sessionId']}, self.runtime['sha256'])

    def test_no_completion_or_arbitrary_rpc_action(self):
        for action in ('complete', 'seal', 'rpc', 'prompt'):
            with self.subTest(action=action), patch.object(sys, 'argv', ['controller', action]):
                with self.assertRaises(SystemExit) as caught: m.main()
                self.assertEqual(caught.exception.code, 2)

    def pause_fixture(self):
        self.baseline()
        stamp = m.OLD_TEAM_CREATED_AT / 1000
        iso = lambda seconds: m.dt.datetime.fromtimestamp(seconds, m.dt.timezone.utc).isoformat()
        previous = {'tenantId': m.UID, 'sessionId': m.OLD_CAPTAIN,
                    'status': 'paused_for_next_optimization', 'instanceId': m.OLD_INSTANCE['id'],
                    'runtimeSha256': m.OLD_RUNTIME_SHA256, 'createdAt': iso(stamp-10), 'startedAt': iso(stamp-5)}
        team = {'id': m.OLD_TEAM_ID, 'name': m.OLD_TEAM_ID, 'captainSessionId': m.OLD_CAPTAIN,
                'createdAt': m.OLD_TEAM_CREATED_AT, 'halted': True, 'members': [{'id': 'member-1'}],
                'tasks': [{'id': 't4', 'status': 'in_progress'}], 'qualityRuns': {'t4': {'status': 'escalated'}}}
        receipt = {'tenantId': m.UID, 'sessionId': m.OLD_CAPTAIN, 'status': 'paused', 'goalPhase': 'paused',
                   'diagnostics': [], 'errors': [], 'reason': 'Failed sample cleanup; not accepted delivery.',
                   'finishedAt': iso(stamp+5), 'binding': {'tenantId': m.UID, 'sessionId': m.OLD_CAPTAIN,
                       'teamId': m.OLD_TEAM_ID, 'teamPath': str(m.PAUSED_TEAMS[-1]), 'teamPresent': True,
                       'captainHeader': {'id': m.OLD_CAPTAIN, 'parentSession': None, 'cwd': str(m.CWD),
                                         'createdAt': (stamp-8)*1000}},
                   'teams': [{'path': str(m.PAUSED_TEAMS[-1]), 'id': m.OLD_TEAM_ID}],
                   'finalSessions': [{'sessionId': m.OLD_CAPTAIN, 'running': False},
                                     {'sessionId': 'member-1', 'parentSessionId': m.OLD_CAPTAIN, 'running': False}]}
        m.save(self.previous / 'run.json', previous); m.save(m.PAUSED_TEAMS[-1], team)
        path = self.previous / 'pause-for-next-iteration.json'; m.save(path, receipt)
        return path, receipt, previous, team

    def test_failed_paused_quality_sample_is_admissible_without_fabricating_completion(self):
        path, _, _, _ = self.pause_fixture(); proof = c.previous_stop_evidence(path)
        self.assertEqual(proof['status'], 'paused')
        self.assertFalse(proof['artifactQualityAccepted'])
        self.assertTrue(proof['pauseIsCleanupNotSuccessfulDelivery'])

    def test_pause_receipt_identity_live_goal_tree_and_time_mutations_rejected(self):
        path, receipt, _, _ = self.pause_fixture()
        changes = [lambda r:r.update(status='completed'), lambda r:r.update(tenantId='other'),
                   lambda r:r.update(sessionId='session-other'), lambda r:r.update(goalPhase='active'),
                   lambda r:r.update(diagnostics=[{'reason':'unknown child'}]), lambda r:r.update(errors=[{'code':'HTTP_500'}]),
                   lambda r:r.update(reason=''), lambda r:r.update(finishedAt='2020-01-01T00:00:00+00:00'),
                   lambda r:r['binding'].update(teamId='other'), lambda r:r['binding']['captainHeader'].update(parentSession='foreign'),
                   lambda r:r['binding']['captainHeader'].update(createdAt=1),
                   lambda r:r['finalSessions'][1].update(running=True),
                   lambda r:r['finalSessions'][1].update(sessionId='other-member'),
                   lambda r:r['finalSessions'][1].update(parentSessionId='other-parent'),
                   lambda r:r['finalSessions'].append({'sessionId':'unexpected','running':False}),
                   lambda r:r['teams'][0].update(path='/outside/team.json')]
        for i, change in enumerate(changes):
            with self.subTest(i=i):
                value=copy.deepcopy(receipt); change(value); m.save(path,value)
                with self.assertRaises(RuntimeError): c.previous_stop_evidence(path)

    def test_previous_runtime_or_team_not_bound_to_pause_rejected(self):
        path, _, previous, team = self.pause_fixture()
        for field, value in [('runtimeSha256','a'*64), ('instanceId','other'), ('status','completed')]:
            with self.subTest(field=field):
                m.save(self.previous/'run.json',{**previous,field:value})
                with self.assertRaises(RuntimeError):c.previous_stop_evidence(path)
        m.save(self.previous/'run.json',previous)
        for field, value in [('halted',False), ('createdAt',1), ('captainSessionId','other')]:
            with self.subTest(field=field):
                m.save(m.PAUSED_TEAMS[-1],{**team,field:value})
                with self.assertRaises(RuntimeError):c.previous_stop_evidence(path)

    def test_reload_refuses_any_unrelated_live_session_or_active_prior_goal(self):
        prep={'pausedTeamsBaseline':[{'captainSessionId':f'prior-{i}','memberIds':[]} for i in range(12)]}
        class Fake:
            active=False; live=False
            def rpc(self, name, args):
                if name=='session/list':return {'items':[{'sessionId':'unrelated','running':self.live}]}
                if name=='goals/get':return {'phase':'active'} if self.active else None
                if name=='subagents/list':return {'entries':[]}
                raise AssertionError(name)
        fake=Fake()
        with patch.object(c,'original_verify_previous_stopped',return_value={'running':False}):
            self.assertTrue(c.verify_previous_stopped(fake,prep)['allTenantSessionsInactive'])
            fake.live=True
            with self.assertRaisesRegex(RuntimeError,'TENANT_HAS_RUNNING'):c.verify_previous_stopped(fake,prep)
            fake.live=False;fake.active=True
            with self.assertRaisesRegex(RuntimeError,'PRIOR_TEAM_GOAL_ACTIVE'):c.verify_previous_stopped(fake,prep)

    def test_historical_unavailable_descriptor_needs_exact_native_inactive_session(self):
        prep={'pausedTeamsBaseline':[{'captainSessionId':f'prior-{i}','memberIds':['old-member'] if i==0 else [],
               'path':str(self.cwd/'expert-teams'/f'team-{i}'/'team.json')} for i in range(12)]}
        entry={'kind':'diagnostic','id':'old-member','reason':'unavailable'}
        row={'sessionId':'old-member','running':False,'parentSessionId':'prior-0','origin':'subagent','cwd':str(self.cwd)}
        class Fake:
            entries=[entry]; rows=[row]
            def rpc(self,name,args):
                if name=='session/list':return {'items':self.rows}
                if name=='goals/get':return {'phase':'paused'}
                if name=='subagents/list':return {'entries':self.entries if args['parentSessionId']=='prior-0' else []}
                raise AssertionError(name)
        fake=Fake()
        with patch.object(c,'original_verify_previous_stopped',return_value={}):
            proof=c.verify_previous_stopped(fake,prep)['historicalUnavailableMemberActivityProofs']
            self.assertEqual(len(proof),1);self.assertEqual(proof[0]['catalogDiagnostic'],'unavailable')
            self.assertFalse(proof[0]['descriptorRecoverabilityVerified'])
            fake.entries=[]
            absent=c.verify_previous_stopped(fake,prep)['historicalUnavailableMemberActivityProofs']
            self.assertEqual(absent[0]['catalogDiagnostic'],'absent')
            for entries in [[entry,entry],[{**entry,'reason':'corrupt'}],[{**entry,'reason':'unknown'}]]:
                fake.entries=entries
                with self.assertRaisesRegex(RuntimeError,'MEMBER_NOT_IN_CATALOG'):c.verify_previous_stopped(fake,prep)
            fake.entries=[entry]
            for rows in [[],[row,row],[{**row,'parentSessionId':'other'}],[{**row,'origin':'human'}],[{**row,'cwd':'/other'}]]:
                fake.rows=rows
                with self.assertRaisesRegex(RuntimeError,'NOT_PROVEN_INACTIVE'):c.verify_previous_stopped(fake,prep)
            fake.entries=[];fake.rows=[]
            with self.assertRaisesRegex(RuntimeError,'NOT_PROVEN_INACTIVE'):c.verify_previous_stopped(fake,prep)
            for value in [True,None,'inactive']:
                fake.rows=[{**row,'running':value}]
                with self.assertRaisesRegex(RuntimeError,'RUNNING_OR_UNKNOWN'):c.verify_previous_stopped(fake,prep)

    def test_stop_boundary_rechecks_after_payload_work_and_restores_client(self):
        calls=[]
        class Fake:
            def request(self,path,data=None,tenant=False,timeout=30):
                calls.append(('request',path))
                return {'ok':True}
        client=Fake(); original=client.request
        def old_reload(client,prep,expected):
            calls.append(('payload','done'))
            return client.request('/api/dsh/stop',{})
        with patch.object(c,'require_real_domain_installation',return_value={}), patch.object(c,'verify_real_domain_catalog',return_value={}), patch.object(c,'original_reload_tenant',side_effect=old_reload), patch.object(c,'verify_previous_stopped',side_effect=lambda *_: calls.append(('verify','idle'))):
            self.assertEqual(c.reload_tenant(client,{},'digest'),{'ok':True})
        self.assertEqual(calls,[('payload','done'),('verify','idle'),('request','/api/dsh/stop')])
        self.assertEqual(client.request,original)
        calls.clear()
        with patch.object(c,'require_real_domain_installation',return_value={}), patch.object(c,'verify_real_domain_catalog',return_value={}), patch.object(c,'original_reload_tenant',side_effect=old_reload), patch.object(c,'verify_previous_stopped',side_effect=RuntimeError('TENANT_HAS_RUNNING_OR_UNKNOWN_SESSION')):
            with self.assertRaisesRegex(RuntimeError,'TENANT_HAS_RUNNING'):
                c.reload_tenant(client,{},'digest')
        self.assertEqual(calls,[('payload','done')])
        self.assertEqual(client.request,original)


if __name__ == '__main__':
    unittest.main(verbosity=2)
