#!/usr/bin/env python3
"""Temporary files only; no production path mutation or network calls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('r12_promotion', Path(__file__).resolve().parents[1] / 'scripts/qa/round12-promote-candidate.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)


class Promotion(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.candidate, self.target, self.evidence, self.backup, self.full = [self.root / n for n in ('candidate','main','evidence','backup','full')]
        for root in (self.candidate,self.target,self.evidence,self.backup,self.full): root.mkdir()
        for root in (self.candidate,self.target):
            (root/'package.json').write_text('old package')
            (root/'src').mkdir(); (root/'src/a.ts').write_text('old code')
        self.files = [{'path':n,'sha256':p.sha(self.target/n)} for n in ('package.json','src/a.ts')]
        (self.candidate/'src/a.ts').write_text('new code')
        for n in p.MISSING_R11:
            path=self.candidate/n;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('new manifest')
        (self.backup/'archive').write_text('fixture archive')
        (self.full/'archive').write_text('fixture complete pack')
        self.manifest={'status':'VERIFIED','sourceRoot':str(self.target),'files':self.files,'missingComparedWithR11':p.MISSING_R11,'archives':[{'name':'archive','sha256':p.sha(self.backup/'archive')}]}
        p.save(self.backup/'manifest.json',self.manifest)
        p.save(self.full/'manifest.json',{'status':'VERIFIED','baselineDomainPack':{'id':'fixture'},'archive':{'name':'archive','sha256':p.sha(self.full/'archive')}})
        p.save(self.evidence/'backup.json',{'status':'VERIFIED','backup':str(self.backup),'candidate':str(self.candidate),'manifestSha256':p.sha(self.backup/'manifest.json'),'missingComparedWithR11':p.MISSING_R11,'completeR11DomainBackup':{'backup':str(self.full),'manifestSha256':p.sha(self.full/'manifest.json'),'identity':{'id':'fixture'}}})

    def plan(self): return p.build_plan(self.candidate,self.evidence)
    def apply(self, plan=None, **kw): return p.apply_plan(plan or self.plan(),self.evidence,kw.pop('verify',lambda _: {'runtime':'fixture'}),**kw)

    def test_absent_manifests_are_explicit_cas_additions(self):
        plan=self.plan()
        self.assertEqual({r['path'] for r in plan['changes'] if r['beforeSha256'] is None},set(p.MISSING_R11))
        self.assertEqual((self.target/'src/a.ts').read_text(),'old code')
        self.assertFalse((self.evidence/'promotion-journal.json').exists())

    def test_success_promotes_only_planned_paths(self):
        (self.target/'user-note.md').write_text('unrelated')
        result=self.apply()
        self.assertEqual(result['status'],'PROMOTED')
        self.assertEqual((self.target/'user-note.md').read_text(),'unrelated')
        self.assertEqual((self.target/'src/a.ts').read_text(),'new code')
        self.assertFalse(result['dependenciesInstalled'])

    def test_main_baseline_edit_blocks(self):
        (self.target/'src/a.ts').write_text('user edit')
        with self.assertRaisesRegex(RuntimeError,'BASELINE_CHANGED'):self.plan()

    def test_missing_manifest_created_by_other_writer_blocks(self):
        path=self.target/p.MISSING_R11[0];path.parent.mkdir(parents=True);path.write_text('user manifest')
        with self.assertRaisesRegex(RuntimeError,'ABSENCE_BASELINE_CHANGED'):self.plan()

    def test_candidate_symlink_parent_blocks(self):
        path=self.candidate/'assets';path.symlink_to(self.target,target_is_directory=True)
        # A file found beneath the alias must never be admitted by scan.
        with self.assertRaisesRegex(RuntimeError,'PROMOTION_PATH_ALIAS'):self.plan()

    def test_backup_archive_tamper_blocks(self):
        (self.backup/'archive').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'BACKUP_ARCHIVE_CHANGED'):self.plan()

    def test_full_domain_archive_tamper_blocks(self):
        (self.full/'archive').write_text('changed')
        with self.assertRaisesRegex(RuntimeError,'COMPLETE_DOMAIN_BACKUP_CHANGED'):self.plan()

    def test_target_change_after_plan_blocks_without_write(self):
        plan=self.plan();(self.target/'src/a.ts').write_text('user edit')
        with self.assertRaisesRegex(RuntimeError,'TARGET_CHANGED_BEFORE_PROMOTION'):self.apply(plan)
        self.assertFalse((self.evidence/'promotion-journal.json').exists())

    def test_failure_rolls_back_existing_and_new_files(self):
        def verify(_): raise RuntimeError('POST_VERIFY_FAILED')
        with self.assertRaisesRegex(RuntimeError,'POST_VERIFY_FAILED'):self.apply(verify=verify)
        self.assertEqual((self.target/'src/a.ts').read_text(),'old code')
        self.assertTrue(all(not (self.target/n).exists() for n in p.MISSING_R11))
        self.assertEqual(p.load(self.evidence/'promotion-journal.json')['status'],'ROLLED_BACK')

    def test_exception_after_atomic_write_is_rolled_back(self):
        def write(path,data,mode):
            p.replace(path,data,mode);raise RuntimeError('WRITE_RECEIPT_LOST')
        with self.assertRaisesRegex(RuntimeError,'WRITE_RECEIPT_LOST'):self.apply(write_file=write)
        self.assertTrue(all(not (self.target/n).exists() for n in p.MISSING_R11))
        self.assertEqual(p.load(self.evidence/'promotion-journal.json')['status'],'ROLLED_BACK')

    def test_rollback_never_overwrites_concurrent_user_edit(self):
        def verify(_):
            (self.target/'src/a.ts').write_text('concurrent user edit')
            raise RuntimeError('POST_VERIFY_FAILED')
        with self.assertRaisesRegex(RuntimeError,'POST_VERIFY_FAILED'):self.apply(verify=verify)
        self.assertEqual((self.target/'src/a.ts').read_text(),'concurrent user edit')
        result=p.load(self.evidence/'promotion-journal.json')
        self.assertEqual(result['status'],'ROLLBACK_CONFLICT')
        self.assertEqual(result['rollbackConflicts'],['src/a.ts'])

    def test_ambiguous_attempt_not_replayed(self):
        plan=self.plan();p.save(self.evidence/'promotion-journal.json',{'status':'APPLYING'})
        with self.assertRaisesRegex(RuntimeError,'EXPLICIT_INSPECTION'):self.apply(plan)


if __name__ == '__main__':unittest.main(verbosity=2)
