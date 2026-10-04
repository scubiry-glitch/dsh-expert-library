"""Offline R12 overlay-exchange guards. Isolated files + fake read-only APIs only."""
import copy
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec=importlib.util.spec_from_file_location(name,path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result
u=load('round12_upgrade_under_test',ROOT/'scripts/qa/round12-real-domain-upgrade.py')
old=load('round11_upgrade_test_fake',ROOT/'test/round11-domain-switch.test.py')

class Fake(old.Fake):
    def __init__(self,source):
        super().__init__(source)
        self.inst={**u.m.OLD_INSTANCE,'status':'running','cwd':'isolated-tenant'}
        self.setting={'revision':0,'value':[u.PACK],'userFieldPresent':True,'userValue':[u.PACK]}
        self.items[0]['active']=False;self.gen=22
        self.baseline.append({'id':'12'})
    def identity(self,root):
        result=super().identity(root)
        result['version']=json.loads((Path(root)/'domain-packs'/u.PACK/'pack.json').read_text())['version']
        return result
    def center(self,path,data=None):
        if data is not None:raise AssertionError('R12 must never mutate center')
        return super().center(path,data)
    def mutate(self,*args,**kwargs):raise AssertionError('R12 must never mutate settings')

class Guards(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.source=self.root/'source';self.cwd=self.root/'tenant/ws/main/bank';self.e=self.root/'evidence'
        for root,version in [(self.source,'1.3.0'),(self.cwd,'1.2.0')]:
            target=root/'domain-packs'/u.PACK;target.mkdir(parents=True)
            (target/'pack.json').write_text(json.dumps({'id':u.PACK,'version':version}))
            (target/'keep.txt').write_text('qualified bytes '+version)
        self.e.mkdir();self.fake=Fake(self.source);self.previous=self.root/'previous.json'
        self.old=self.fake.identity(self.cwd);self.new=self.fake.identity(self.source)
        prior={'status':'APPLIED','tenantId':u.m.UID,'targetRoot':str(self.cwd/'domain-packs'/u.PACK),
               'domainPackIdentity':self.old,'verification':{'observed':{'center':u.legacy.inventory(self.fake.center('/installations'))}}}
        self.previous.write_text(json.dumps(prior));self.operator=u.Upgrade(self.fake,self.e,self.previous,self.source,self.cwd)
        self.tenant=patch.object(u.m,'TENANT',self.root/'tenant');self.tenant.start()
    def tearDown(self):self.tenant.stop();self.temp.cleanup()
    def stage_then_crash(self):
        with patch.object(u,'atomic_exchange',side_effect=OSError('synthetic exchange boundary lost')):
            with self.assertRaisesRegex(OSError,'synthetic'):self.operator.apply('d'*64)
        return u.m.load(self.operator.receipt)
    def assert_old(self):self.assertEqual(self.fake.identity(self.cwd),self.old)
    def test_plan_is_readonly(self):
        result=self.operator.plan('d'*64);self.assertEqual(result['status'],'PLANNED');self.assertFalse(self.operator.receipt.exists());self.assert_old();self.assertEqual(self.fake.writes,[])
    def test_atomic_exchange_preserves_old_pack_outside_discovery(self):
        result=self.operator.apply('d'*64)
        self.assertEqual(result['status'],'APPLIED');self.assertEqual(self.fake.identity(self.cwd),self.new)
        stage=Path(result['stagingRoot']);self.assertEqual(self.fake.identity(stage),self.old)
        self.assertEqual(Path(result['retainedPreviousPackRoot']),stage/'domain-packs'/u.PACK)
        self.assertNotIn(stage,self.operator.target.parents);self.assertEqual(self.fake.writes,[])
        self.assertEqual(result['centerMutations'],0);self.assertEqual(result['settingsMutations'],0)
    def test_explicit_resume_required_for_existing_receipt(self):
        self.operator.apply('d'*64)
        with self.assertRaisesRegex(RuntimeError,'EXPLICIT_RESUME'):self.operator.apply('d'*64)
    def test_resume_before_exchange_executes_exactly_one_exchange(self):
        self.stage_then_crash()
        with patch.object(u,'atomic_exchange',wraps=u.atomic_exchange) as exchange:
            result=self.operator.apply('d'*64,resume=True);self.assertEqual(exchange.call_count,1)
        self.assertEqual(result['status'],'APPLIED');self.assertEqual(self.fake.identity(self.cwd),self.new)
    def test_exchange_committed_but_response_lost_reconciles_without_second_swap(self):
        actual=u.atomic_exchange
        def lost(a,b):actual(a,b);raise OSError('synthetic lost response')
        with patch.object(u,'atomic_exchange',side_effect=lost):
            with self.assertRaises(OSError):self.operator.apply('d'*64)
        self.assertEqual(self.fake.identity(self.cwd),self.new)
        with patch.object(u,'atomic_exchange',side_effect=AssertionError('must not swap again')):
            result=self.operator.apply('d'*64,resume=True)
        self.assertEqual(result['status'],'APPLIED');self.assertEqual(self.fake.identity(Path(result['stagingRoot'])),self.old)
    def test_final_receipt_write_lost_is_recoverable(self):
        actual=u.atomic_record
        def lost(path,record):
            if record['status']=='APPLIED':raise OSError('synthetic receipt write lost')
            actual(path,record)
        with patch.object(u,'atomic_record',side_effect=lost):
            with self.assertRaises(OSError):self.operator.apply('d'*64)
        self.assertEqual(u.m.load(self.operator.receipt)['status'],'EXCHANGE_PENDING')
        with patch.object(u,'atomic_exchange',side_effect=AssertionError('second exchange forbidden')):self.assertEqual(self.operator.apply('d'*64,resume=True)['status'],'APPLIED')
    def test_applied_resume_is_idempotent(self):
        self.operator.apply('d'*64)
        with patch.object(u,'atomic_exchange',side_effect=AssertionError('repeat exchange forbidden')):self.assertEqual(self.operator.apply('d'*64,resume=True)['status'],'APPLIED')
    def test_active_tenant_refused_before_copy(self):
        self.fake.running=True
        with self.assertRaisesRegex(RuntimeError,'TENANT_HAS_RUNNING'):self.operator.apply('d'*64)
        self.assertFalse(self.operator.receipt.exists());self.assert_old()
    def test_active_tenant_at_exchange_boundary_refused(self):
        def boundary(_):self.fake.running=True;return Fake.idle_boundary(self.fake,self.fake.baseline)
        with patch.object(self.fake,'idle_boundary',side_effect=boundary):
            with self.assertRaisesRegex(RuntimeError,'TENANT_HAS_RUNNING'):self.operator.apply('d'*64)
        self.assert_old()
    def test_center_policy_changed_at_exchange_boundary_is_refused(self):
        def boundary(baseline):
            result=Fake.idle_boundary(self.fake,baseline);self.fake.policy['mode']='auto';return result
        with patch.object(self.fake,'idle_boundary',side_effect=boundary):
            with self.assertRaisesRegex(RuntimeError,'CENTER_'):self.operator.apply('d'*64)
        self.assert_old()
    def test_center_job_started_at_exchange_boundary_is_refused(self):
        def boundary(baseline):
            result=Fake.idle_boundary(self.fake,baseline);self.fake.jobs=[{'status':'running'}];return result
        with patch.object(self.fake,'idle_boundary',side_effect=boundary):
            with self.assertRaisesRegex(RuntimeError,'CENTER_'):self.operator.apply('d'*64)
        self.assert_old()
    def test_resume_with_no_receipt_refuses_without_copy(self):
        with self.assertRaisesRegex(RuntimeError,'NO_OVERLAY_RECEIPT'):self.operator.apply('d'*64,resume=True)
        self.assert_old();self.assertFalse(self.operator.receipt.exists())
    def test_target_drift_after_staging_refuses_resume(self):
        self.stage_then_crash();(self.operator.target/'keep.txt').write_text('unqualified target change')
        with patch.object(u,'atomic_exchange',side_effect=AssertionError('unknown state cannot be exchanged')):
            with self.assertRaisesRegex(RuntimeError,'STATE_UNKNOWN_OR_CHANGED'):self.operator.apply('d'*64,resume=True)
    def test_center_inventory_drift_at_exchange_boundary_is_refused(self):
        def boundary(baseline):
            result=Fake.idle_boundary(self.fake,baseline);self.fake.gen+=1;return result
        with patch.object(self.fake,'idle_boundary',side_effect=boundary):
            with self.assertRaisesRegex(RuntimeError,'ENVIRONMENT_CHANGED'):self.operator.apply('d'*64)
        self.assert_old()
    def test_center_generation_drift_refused(self):
        self.fake.gen+=1
        with self.assertRaisesRegex(RuntimeError,'CENTER_INVENTORY_CHANGED'):self.operator.apply('d'*64)
        self.assert_old()
    def test_enabled_setting_drift_refused(self):
        self.fake.setting['value']=['__none__']
        with self.assertRaisesRegex(RuntimeError,'ENABLED_PACK_SETTING_CHANGED'):self.operator.apply('d'*64)
        self.assert_old()
    def test_setting_revision_change_after_stage_refuses_resume(self):
        self.stage_then_crash();self.fake.setting['revision']+=1
        with self.assertRaisesRegex(RuntimeError,'ENVIRONMENT_CHANGED_SINCE'):self.operator.apply('d'*64,resume=True)
        self.assert_old()
    def test_center_operations_and_auto_policy_refused(self):
        for field in ('operation','policy'):
            with self.subTest(field=field):
                if field=='operation':self.fake.jobs=[{'status':'running'}]
                else:self.fake.jobs=[];self.fake.policy['mode']='auto'
                with self.assertRaisesRegex(RuntimeError,'CENTER_'):self.operator.apply('d'*64)
                self.assert_old()
    def test_unknown_stage_or_target_bytes_refuse_resume(self):
        record=self.stage_then_crash();(Path(record['stagingRoot'])/'domain-packs'/u.PACK/'keep.txt').write_text('unexpected')
        with self.assertRaisesRegex(RuntimeError,'STATE_UNKNOWN_OR_CHANGED'):self.operator.apply('d'*64,resume=True)
        self.assert_old()
    def test_changed_prior_receipt_refused(self):
        self.stage_then_crash();self.previous.write_text(self.previous.read_text()+' ')
        with self.assertRaisesRegex(RuntimeError,'PREVIOUS_OVERLAY_RECEIPT_CHANGED'):self.operator.apply('d'*64,resume=True)
        self.assert_old()
    def test_changed_candidate_refused(self):
        self.stage_then_crash();(self.source/'domain-packs'/u.PACK/'keep.txt').write_text('changed source')
        with self.assertRaisesRegex(RuntimeError,'QUALIFIED_OVERLAY_CHANGED'):self.operator.apply('d'*64,resume=True)
        self.assert_old()
    def test_copy_crash_cannot_blindly_resume(self):
        with patch.object(u.shutil,'copytree',side_effect=OSError('synthetic copy failure')):
            with self.assertRaises(OSError):self.operator.apply('d'*64)
        with self.assertRaisesRegex(RuntimeError,'COPY_INCOMPLETE'):self.operator.apply('d'*64,resume=True)
        self.assert_old()
    def test_symlink_target_refused(self):
        target=self.operator.target;retained=self.root/'old-pack';target.rename(retained);target.symlink_to(retained,target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError,'LOCAL_PATH_ALIAS'):self.operator.apply('d'*64)
        self.assertTrue(target.is_symlink())
    def test_conflicting_discovery_copy_refused(self):
        conflict=self.root/'tenant/ws/domain-packs/duplicate';shutil.copytree(self.source/'domain-packs'/u.PACK,conflict)
        with self.assertRaisesRegex(RuntimeError,'LOCAL_PACK_CONFLICT'):self.operator.apply('d'*64)
        self.assert_old()
    def test_prior_team_baseline_change_after_stage_refused(self):
        self.stage_then_crash();self.fake.baseline[0]['id']='changed'
        with self.assertRaisesRegex(RuntimeError,'PRIOR_TEAM_BASELINE_CHANGED'):self.operator.apply('d'*64,resume=True)
        self.assert_old()

if __name__=='__main__':unittest.main()
