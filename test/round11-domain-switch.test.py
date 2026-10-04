"""Offline only: fake official APIs, isolated directory trees, no credentials."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('domain_switch_under_test', ROOT / 'scripts/qa/round11-real-domain-switch.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)


class Fake:
    def __init__(self, source):
        self.source = source
        self.inst = {**s.m.OLD_INSTANCE, 'status': 'running', 'cwd': 'fake-real-workspace'}
        self.setting = {'revision': 0, 'value': ['__none__'], 'userFieldPresent': False}
        self.other_user = {'secret': 'test-only-not-a-credential', 'maxActiveMembers': 2}
        self.items = [{'releaseId': rid, 'packId': pack, 'version': '1.1.0', 'source': 'center',
                       'installedAt': 'fixture', 'active': True, 'integrity': 'verified',
                       'contentTreeSha256': 'a' * 64, 'artifactSha256': 'b' * 64, 'manifestSha256': 'c' * 64}
                      for pack, rid in [(s.PACK, s.OLD_RELEASE), ('other-a', 'a'), ('other-b', 'b'), ('other-c', 'c')]]
        self.gen, self.jobs, self.writes = 21, [], []
        self.idle_calls = self.boundary_calls = 0
        self.baseline = [{'id': str(i)} for i in range(12)]
        self.gate_bad = self.lost_disable_response = self.lost_settings_response = False
        self.settings_conflict = self.running = False
        self.policy = {'mode': 'manual', 'perPack': {}, 'tickInFlight': False}

    def instance(self): return copy.deepcopy(self.inst)
    def idle(self):
        self.idle_calls += 1
        s.need(not self.running, 'TENANT_HAS_RUNNING_OR_UNKNOWN_SESSION')
        return {'baseline': copy.deepcopy(self.baseline)}
    def idle_boundary(self, baseline):
        self.boundary_calls += 1
        s.need(not self.running, 'TENANT_HAS_RUNNING_OR_UNKNOWN_SESSION')
        s.need(self.baseline == baseline, 'PRIOR_TEAM_BASELINE_CHANGED')
        return {'checkedAt': 'fixture', 'allTenantSessionsInactive': True}
    def identity(self, root):
        pack = pathlib.Path(root) / 'domain-packs' / s.PACK
        rows = []
        for f in sorted(pack.rglob('*')):
            s.need(not f.is_symlink(), 'CRAFT_DOMAIN_PACK_ALIAS')
            if f.is_file(): rows.append([str(f.relative_to(pack)), hashlib.sha256(f.read_bytes()).hexdigest(), f.stat().st_size])
        return {'packId': s.PACK, 'version': '1.2.0', 'fileCount': len(rows), 'sizeBytes': sum(r[2] for r in rows),
                'contentTreeSha256': hashlib.sha256(json.dumps(rows).encode()).hexdigest()}
    def gate(self, expected):
        s.need(not self.gate_bad, 'HOST_EVIDENCE_NOT_PASSED')
        return {'domainPackIdentity': self.identity(self.source)}
    def settings(self): return copy.deepcopy(self.setting)
    def mutate(self, before, restore=False):
        if self.settings_conflict:
            self.setting['revision'] += 1
        s.need(self.setting['revision'] == before['revision'], 'SETTINGS_CAS_CONFLICT')
        self.writes.append(('settings', 'unset' if restore and not before['userFieldPresent'] else 'set'))
        if restore:
            self.setting = {**before, 'revision': before['revision'] + 1}
        else:
            self.setting = {'revision': before['revision'] + 1, 'value': [s.PACK], 'userFieldPresent': True, 'userValue': [s.PACK]}
        if self.lost_settings_response:
            self.lost_settings_response = False
            raise OSError('disconnected with sensitive response omitted')
    def center(self, path, data=None):
        if data:
            s.need(data['expectedGeneration'] == self.gen, 'CENTER_CAS_CONFLICT')
            self.writes.append(('center', data['kind']))
            self.gen += 1
            self.items[0]['active'] = data['kind'] == 'enable'
            job = {'operationId': data['operationKey'], 'request': copy.deepcopy(data), 'status': 'succeeded'}
            self.jobs.append(job)
            if self.lost_disable_response:
                self.lost_disable_response = False
                raise OSError('sensitive transport contents must not be journaled')
            return copy.deepcopy(job)
        if path == '/installations': return {'generation': self.gen, 'mode': 'normal', 'items': copy.deepcopy(self.items)}
        if path == '/operations': return copy.deepcopy(self.jobs)
        if path == '/update-policy': return copy.deepcopy(self.policy)
        return copy.deepcopy(next(j for j in self.jobs if j['operationId'] == path.rsplit('/', 1)[1]))


class Guards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.source, self.cwd, self.e = self.root / 'source', self.root / 'tenant/ws/main/bank', self.root / 'evidence'
        for p in (self.source, self.cwd, self.e): p.mkdir(parents=True)
        pack = self.source / 'domain-packs' / s.PACK;pack.mkdir(parents=True)
        (pack / 'pack.json').write_text(json.dumps({'id': s.PACK, 'version': '1.2.0'}))
        for i in range(192): (pack / str(i)).write_text('immutable ' + str(i))
        self.fake = Fake(self.source)
        self.switch = s.Switch(self.fake, self.e, self.source, self.cwd)
        self.patches = [patch.object(s.m, 'TENANT', self.root / 'tenant'), patch.object(s.controller, 'runtime_at', return_value={'sha256': 'd' * 64})]
        for p in self.patches: p.start()
        preview = {'status': 'PASS', 'productionMutations': 0, 'inventoryGeneration': 21,
                   'sourceIdentity': self.fake.identity(self.source),
                   'retainedCenterReleases': [['other-a', 'a'], ['other-b', 'b'], ['other-c', 'c']]}
        s.m.save(self.e / 'real-domain-switch-preview.json', preview)
        self.plan = self.switch.plan()
    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.tmp.cleanup()
    def test_apply_verify_rollback_preserves_other_fields_and_releases(self):
        before = copy.deepcopy(self.fake.other_user)
        result = self.switch.apply()
        self.assertEqual(result['status'], 'APPLIED')
        self.assertEqual(self.fake.writes, [('center', 'disable'), ('settings', 'set')])
        self.assertEqual(self.switch.apply()['status'], 'APPLIED')
        self.assertEqual(len(self.fake.writes), 2)
        self.assertEqual(self.switch.rollback()['status'], 'ROLLED_BACK')
        self.assertEqual(self.fake.writes[-2:], [('settings', 'unset'), ('center', 'enable')])
        self.assertEqual(self.fake.other_user, before)
        self.assertTrue(self.switch.target.exists())
        self.assertEqual(s.inventory(self.fake.center('/installations'))['releases'], self.plan['before']['center']['releases'])
        self.assertEqual(self.switch.rollback()['status'], 'ROLLED_BACK')
        self.assertEqual(len(self.fake.writes), 4)
    def test_settings_revision_changed_no_write(self):
        self.fake.setting['revision'] += 1
        with self.assertRaisesRegex(RuntimeError, 'PLAN_API_SNAPSHOT_CHANGED'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_center_generation_changed_no_write(self):
        self.fake.gen += 1
        with self.assertRaisesRegex(RuntimeError, 'PLAN_API_SNAPSHOT_CHANGED'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_unqualified_build_no_write(self):
        self.fake.gate_bad = True
        with self.assertRaisesRegex(RuntimeError, 'HOST_EVIDENCE_NOT_PASSED'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_live_session_no_write(self):
        self.fake.running = True
        with self.assertRaisesRegex(RuntimeError, 'TENANT_HAS_RUNNING'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_other_active_changed_no_write(self):
        self.fake.items[1]['active'] = False
        with self.assertRaisesRegex(RuntimeError, 'PLAN_API_SNAPSHOT_CHANGED'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_baseline_changed_no_write(self):
        self.fake.baseline[0]['id'] = 'changed'
        with self.assertRaisesRegex(RuntimeError, 'PRIOR_TEAM_BASELINE_CHANGED'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_lost_disable_response_partial_no_blind_retry_then_rollback(self):
        self.fake.lost_disable_response = True
        with self.assertRaises(OSError): self.switch.apply()
        with self.assertRaisesRegex(RuntimeError, 'PARTIAL_SWITCH'): self.switch.apply()
        self.assertEqual(self.switch.verify()['verification']['state']['centerTarget'], 'disabled')
        self.assertEqual(self.switch.rollback()['status'], 'ROLLED_BACK')
        self.assertEqual(self.fake.writes, [('center', 'disable'), ('center', 'enable')])
        self.assertNotIn('sensitive', (self.e / s.RECEIPT).read_text())
    def test_lost_settings_response_readonly_reconcile(self):
        self.fake.lost_settings_response = True
        with self.assertRaises(OSError): self.switch.apply()
        self.assertEqual(self.switch.verify()['status'], 'APPLIED')
        self.assertEqual(len(self.fake.writes), 2)
    def test_settings_cas_rejects_without_overwriting(self):
        self.fake.settings_conflict = True
        with self.assertRaisesRegex(RuntimeError, 'SETTINGS_CAS_CONFLICT'): self.switch.apply()
        self.assertEqual(self.fake.writes, [('center', 'disable')])
        with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_SETTINGS_REVISION_UNKNOWN'): self.switch.rollback()
    def test_postapply_concurrent_settings_blocks_rollback(self):
        self.switch.apply(); self.fake.setting['revision'] += 1
        with self.assertRaisesRegex(RuntimeError, 'ROLLBACK_SETTINGS_STATE_UNKNOWN'): self.switch.rollback()
        self.assertEqual(len(self.fake.writes), 2)
    def test_target_symlink_rejected(self):
        self.switch.target.parent.mkdir();self.switch.target.symlink_to(self.source / 'domain-packs' / s.PACK)
        with self.assertRaisesRegex(RuntimeError, 'LOCAL_PATH_ALIAS'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_changed_candidate_no_write(self):
        (self.source / 'domain-packs' / s.PACK / '0').write_text('different')
        with self.assertRaisesRegex(RuntimeError, 'QUALIFIED_DOMAIN_CHANGED'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_manual_policy_required(self):
        self.fake.policy['mode'] = 'patch_auto'
        with self.assertRaisesRegex(RuntimeError, 'CENTER_UPDATE_POLICY_NOT_QUIET'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_pending_operations_block(self):
        self.fake.jobs.append({'status': 'running'})
        with self.assertRaisesRegex(RuntimeError, 'CENTER_OPERATION_PENDING'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])
    def test_restores_existing_field_instead_of_unset(self):
        # A real previous explicit __none__ field must be restored by set.
        self.plan['before']['settings'].update(userFieldPresent=True, userValue=['__none__'])
        self.fake.setting.update(userFieldPresent=True, userValue=['__none__'])
        s.m.save(self.switch.plan_path, self.plan)
        self.switch.apply();self.switch.rollback()
        self.assertEqual(self.fake.writes[-2], ('settings', 'set'))
    def test_atomic_publish_refuses_existing_empty_directory(self):
        a,b=self.root/'a',self.root/'b';a.mkdir();b.mkdir();(a/'x').write_text('x')
        with self.assertRaisesRegex(RuntimeError, 'ATOMIC_PUBLICATION_REFUSED'): s.atomic_publish(a,b)
        self.assertTrue((a/'x').is_file());self.assertEqual(list(b.iterdir()),[])
    def test_settings_projection_omits_other_fields(self):
        value=s.selected_settings({'namespaces':[{'ns':'expert-library','revision':0,'value':{'enabledPacks':['__none__'],'secret':'NEVER_OUTPUT'},'user':{'other':'ALSO_PRIVATE'}}]})
        self.assertEqual(value, {'revision':0,'value':['__none__'],'userFieldPresent':False})
    def test_immutable_release_changed_after_apply_blocks_verify(self):
        self.switch.apply();self.fake.items[1]['contentTreeSha256']='f'*64
        with self.assertRaisesRegex(RuntimeError, 'IMMUTABLE_RELEASE_INVENTORY_CHANGED'): self.switch.verify()
    def reload_receipt(self):
        old=copy.deepcopy(self.fake.inst)
        self.fake.inst.update(id='new-qualified-instance',pid=987654,port=34567)
        self.fake.setting['revision']=0
        receipt={'status':'PASS','tenantId':s.m.UID,'payloadGate':{'runtime':{'sha256':self.plan['runtimeSha256']}},
                 'instanceBefore':old,'instanceAfter':copy.deepcopy(self.fake.inst),
                 'teamsBefore':self.fake.baseline,'teamsAfter':self.fake.baseline}
        s.m.save(self.e/'production-reload.json',receipt)
        return receipt
    def test_qualified_reload_zero_revision_verify_and_rollback(self):
        self.switch.apply();self.reload_receipt()
        self.assertEqual(self.switch.verify()['status'],'APPLIED')
        self.assertEqual(self.switch.rollback()['status'],'ROLLED_BACK')
        self.assertEqual(self.fake.setting['revision'],1)
        self.assertEqual(self.switch.rollback()['status'],'ROLLED_BACK')
        self.assertEqual(len(self.fake.writes),4)
    def test_new_epoch_nonzero_revision_not_admitted(self):
        self.switch.apply();self.reload_receipt();self.fake.setting['revision']=1
        self.assertEqual(self.switch.verify()['status'],'PARTIAL')
        with self.assertRaisesRegex(RuntimeError,'ROLLBACK_SETTINGS_STATE_UNKNOWN'):self.switch.rollback()
        self.assertEqual(len(self.fake.writes),2)
    def test_unqualified_reload_instance_rejected(self):
        self.switch.apply();receipt=self.reload_receipt();receipt['instanceAfter']['pid']+=1
        s.m.save(self.e/'production-reload.json',receipt)
        with self.assertRaisesRegex(RuntimeError,'RELOAD_EPOCH_INSTANCE_MISMATCH'):self.switch.verify()
    def test_reload_receipt_change_after_epoch_sealed_rejected(self):
        self.switch.apply();receipt=self.reload_receipt();self.switch.verify()
        receipt['extra']='changed';s.m.save(self.e/'production-reload.json',receipt)
        with self.assertRaisesRegex(RuntimeError,'RELOAD_EPOCH_RECEIPT_CHANGED'):self.switch.rollback()
        self.assertEqual(len(self.fake.writes),2)
    def test_reload_without_prior_applied_proof_rejected(self):
        self.fake.lost_settings_response=True
        with self.assertRaises(OSError):self.switch.apply()
        self.reload_receipt()
        with self.assertRaisesRegex(RuntimeError,'RELOAD_WITHOUT_PRIOR_APPLIED_PROOF'):self.switch.verify()
    def test_dangling_unrelated_discovery_root_is_not_a_pack(self):
        work=self.root/'tenant/ws/main/work';work.mkdir()
        (work/'domain-packs').symlink_to('../domain-packs')
        self.assertEqual(self.switch.apply()['status'],'APPLIED')
    def test_resolvable_discovery_alias_still_rejected(self):
        work=self.root/'tenant/ws/main/work';work.mkdir()
        (work/'domain-packs').symlink_to(self.source/'domain-packs')
        with self.assertRaisesRegex(RuntimeError,'LOCAL_PATH_ALIAS'):self.switch.apply()
        self.assertEqual(self.fake.writes,[])
    def test_instance_changed_no_write(self):
        self.fake.inst['pid'] += 1
        with self.assertRaisesRegex(RuntimeError, 'BOUND_INSTANCE_CHANGED'): self.switch.apply()
        self.assertEqual(self.fake.writes, [])


    def interrupted_after_disable(self):
        idle = self.fake.idle
        def interrupted():
            if self.fake.writes == [('center', 'disable')]: raise KeyboardInterrupt()
            return idle()
        with patch.object(self.fake, 'idle', side_effect=interrupted):
            with self.assertRaises(KeyboardInterrupt): self.switch.apply()
        self.fake.idle_calls = self.fake.boundary_calls = 0
        record=s.m.load(self.switch.path)
        self.assertEqual(record['phase'],'disable_succeeded')
        stage=pathlib.Path(next(e['stagingRoot'] for e in record['events'] if e['phase']=='copy_verified'))
        return record,stage
    def publish_interrupted_target(self, record, stage):
        self.switch.event(record,'directory_publish_pending')
        self.switch.target.parent.mkdir(exist_ok=True)
        s.atomic_publish(stage/'domain-packs'/s.PACK,self.switch.target)
    def test_resume_disable_proved_completes_once_with_one_full_idle(self):
        record,stage=self.interrupted_after_disable()
        old_events=copy.deepcopy(record['events'])
        result=self.switch.resume()
        self.assertEqual(result['status'],'APPLIED')
        self.assertEqual(result['events'][:len(old_events)],old_events)
        self.assertEqual(self.fake.writes,[('center','disable'),('settings','set')])
        self.assertEqual(self.fake.idle_calls,1)
        self.assertEqual(self.fake.boundary_calls,2)
        self.assertFalse(stage.exists())
        self.assertEqual(self.switch.resume()['status'],'APPLIED')
        self.assertEqual(self.fake.writes,[('center','disable'),('settings','set')])
    def test_resume_reconciles_rename_before_completion_journal(self):
        record,stage=self.interrupted_after_disable();self.publish_interrupted_target(record,stage)
        self.assertEqual(self.switch.resume()['status'],'APPLIED')
        self.assertEqual(self.fake.idle_calls,1)
        self.assertEqual(self.fake.boundary_calls,1)
        self.assertEqual(self.fake.writes,[('center','disable'),('settings','set')])
    def test_resume_pending_settings_original_is_unresolved_not_resent(self):
        record,stage=self.interrupted_after_disable();self.publish_interrupted_target(record,stage)
        self.switch.event(record,'settings_submission_pending',expectedRevision=0)
        with self.assertRaisesRegex(RuntimeError,'RESUME_SETTINGS_SUBMISSION_UNRESOLVED'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_pending_settings_committed_readback_is_readonly(self):
        record,stage=self.interrupted_after_disable();self.publish_interrupted_target(record,stage)
        self.switch.event(record,'settings_submission_pending',expectedRevision=0)
        self.fake.mutate(self.plan['before']['settings'])
        self.assertEqual(self.switch.resume()['status'],'APPLIED')
        self.assertEqual(self.fake.idle_calls,0)
        self.assertEqual(self.fake.writes,[('center','disable'),('settings','set')])
    def test_resume_keyboard_interrupt_after_rename_is_recoverable(self):
        self.interrupted_after_disable();rename=s.atomic_publish
        def interrupt(a,b):rename(a,b);raise KeyboardInterrupt()
        with patch.object(s,'atomic_publish',side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):self.switch.resume()
        self.assertEqual(s.m.load(self.switch.path)['phase'],'resume_stopped')
        self.assertEqual(self.switch.resume()['status'],'APPLIED')
        self.assertEqual(self.fake.writes,[('center','disable'),('settings','set')])
    def test_resume_keyboard_interrupt_after_settings_commit_no_second_write(self):
        self.interrupted_after_disable();mutate=self.fake.mutate
        def interrupt(before,restore=False):mutate(before,restore);raise KeyboardInterrupt()
        with patch.object(self.fake,'mutate',side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):self.switch.resume()
        self.assertEqual(self.switch.resume()['status'],'APPLIED')
        self.assertEqual(self.fake.writes,[('center','disable'),('settings','set')])
    def test_resume_keyboard_interrupt_before_settings_commit_not_retried(self):
        self.interrupted_after_disable()
        with patch.object(self.fake,'mutate',side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):self.switch.resume()
        with self.assertRaisesRegex(RuntimeError,'RESUME_SETTINGS_SUBMISSION_UNRESOLVED'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_stage_corruption_rejected(self):
        record,stage=self.interrupted_after_disable();(stage/'domain-packs'/s.PACK/'0').write_text('tampered')
        with self.assertRaisesRegex(RuntimeError,'STAGED_DOMAIN_CHANGED'):self.switch.resume()
        self.assertFalse(self.switch.target.exists());self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_disable_operation_readback_must_match(self):
        self.interrupted_after_disable();self.fake.jobs[0]['request']['packId']='other-a'
        with self.assertRaisesRegex(RuntimeError,'RESUME_DISABLE_NOT_CONFIRMED'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_disable_event_required_not_just_generation(self):
        record,stage=self.interrupted_after_disable()
        record['events']=[e for e in record['events'] if e['phase']!='disable_succeeded'];self.switch.write(record)
        with self.assertRaisesRegex(RuntimeError,'RESUME_DISABLE_PROOF_MISSING'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_settings_aba_rejected(self):
        self.interrupted_after_disable();self.fake.setting['revision']=2
        with self.assertRaisesRegex(RuntimeError,'RESUME_SETTINGS_STATE_CHANGED'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_unqualified_build_rejected(self):
        self.interrupted_after_disable();self.fake.gate_bad=True
        with self.assertRaisesRegex(RuntimeError,'HOST_EVIDENCE_NOT_PASSED'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_wrong_generation_rejected(self):
        self.interrupted_after_disable();self.fake.gen+=1
        with self.assertRaisesRegex(RuntimeError,'CENTER_GENERATION_UNEXPECTED'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_other_release_change_rejected(self):
        self.interrupted_after_disable();self.fake.items[2]['active']=False
        with self.assertRaisesRegex(RuntimeError,'OTHER_ACTIVE_RELEASE_CHANGED'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_stage_path_escape_rejected(self):
        record,stage=self.interrupted_after_disable()
        for e in record['events']:
            if e['phase'] in ('copy_verified','copy_pending'):e['stagingRoot']=str(self.root/'external')
        self.switch.write(record)
        with self.assertRaisesRegex(RuntimeError,'RESUME_STAGE_PATH_INVALID'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_unowned_present_target_rejected(self):
        record,stage=self.interrupted_after_disable();self.switch.target.parent.mkdir(exist_ok=True)
        s.atomic_publish(stage/'domain-packs'/s.PACK,self.switch.target)
        with self.assertRaisesRegex(RuntimeError,'RESUME_TARGET_WITHOUT_PUBLISH_INTENT'):self.switch.resume()
        self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_boundary_detects_new_activity_before_publish(self):
        self.interrupted_after_disable()
        def active(baseline):raise RuntimeError('TENANT_HAS_RUNNING_OR_UNKNOWN_SESSION')
        with patch.object(self.fake,'idle_boundary',side_effect=active):
            with self.assertRaisesRegex(RuntimeError,'TENANT_HAS_RUNNING'):self.switch.resume()
        self.assertFalse(self.switch.target.exists());self.assertEqual(self.fake.writes,[('center','disable')])
    def test_resume_journal_changed_during_full_idle_rejected(self):
        self.interrupted_after_disable();idle=self.fake.idle
        def change():
            record=s.m.load(self.switch.path);record['otherWriter']=True;self.switch.write(record)
            return idle()
        with patch.object(self.fake,'idle',side_effect=change):
            with self.assertRaisesRegex(RuntimeError,'RESUME_JOURNAL_CHANGED'):self.switch.resume()
        self.assertFalse(self.switch.target.exists());self.assertEqual(self.fake.writes,[('center','disable')])


if __name__ == '__main__': unittest.main(verbosity=2)
