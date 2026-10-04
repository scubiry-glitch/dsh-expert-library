#!/usr/bin/env python3
"""Upgrade only the already enabled real workspace overlay; no center/settings writes.

Import is inert. Default plan is read-only. Apply requires qualified installed
code and exact prior bytes; resume reconciles both sides of a Linux atomic
exchange before acting. Old pack bytes stay outside discovery for rollback.
"""
import argparse
import ctypes
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value

c = module('r12_overlay_controller', ROOT / 'scripts/qa/round12-real-rerun.py')
m = c.m
legacy = module('r12_overlay_readonly_backend', ROOT / 'scripts/qa/round11-real-domain-switch.py')
# Reuse only the qualified read-only metadata routines with current identities.
legacy.controller, legacy.m = c, m
PACK = 'zhijian-realestate'
need = m.need


def atomic_exchange(source, target):
    rename = getattr(ctypes.CDLL(None, use_errno=True), 'renameat2', None)
    need(rename is not None, 'ATOMIC_EXCHANGE_UNAVAILABLE')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    need(rename(-100, os.fsencode(source), -100, os.fsencode(target), 2) == 0, 'ATOMIC_EXCHANGE_REFUSED')
    for directory in {source.parent, target.parent}:
        fd = os.open(directory, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def atomic_record(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x') as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


def reconciled_state(target_identity, staged_identity, old, new):
    if target_identity == old and staged_identity == new:
        return 'ready_to_exchange'
    if target_identity == new and staged_identity == old:
        return 'already_exchanged'
    raise RuntimeError('OVERLAY_EXCHANGE_STATE_UNKNOWN_OR_CHANGED')


class Upgrade:
    def __init__(self, backend, evidence, previous, source=ROOT, cwd=m.CWD):
        self.b, self.e, self.previous = backend, legacy.no_alias(evidence), legacy.no_alias(previous)
        self.source, self.cwd = legacy.no_alias(source), legacy.no_alias(cwd)
        self.target = self.cwd / 'domain-packs' / PACK
        self.receipt = self.e / 'real-domain-switch.json'

    def snapshot(self):
        return {'instance': self.b.instance(), 'settings': self.b.settings(),
                'center': legacy.inventory(self.b.center('/installations'))}

    def check_environment(self, observed, previous):
        need(all(observed['instance'].get(k) == m.OLD_INSTANCE[k] for k in ('id', 'pid', 'port')), 'OLD_INSTANCE_CHANGED')
        need(observed['center'] == previous['verification']['observed']['center'], 'CENTER_INVENTORY_CHANGED')
        settings = observed['settings']
        need(settings.get('value') == [PACK] and settings.get('userFieldPresent') is True
             and settings.get('userValue') == [PACK], 'ENABLED_PACK_SETTING_CHANGED')
        policy = self.b.center('/update-policy')
        need(policy.get('mode') == 'manual' and not policy.get('tickInFlight')
             and all(v == 'manual' for v in policy.get('perPack', {}).values()), 'CENTER_POLICY_NOT_QUIET')
        jobs = self.b.center('/operations')
        need(all(job.get('status') not in ('queued', 'running', 'interrupted') for job in jobs), 'CENTER_OPERATION_IN_FLIGHT')

    def plan(self, runtime):
        qualification = self.b.gate(runtime)
        prior = m.load(self.previous)
        need(prior.get('status') == 'APPLIED' and prior.get('tenantId') == m.UID
             and prior.get('targetRoot') == str(self.target), 'PREVIOUS_OVERLAY_NOT_VERIFIED')
        new = self.b.identity(self.source)
        old = prior['domainPackIdentity']
        need(new == qualification['domainPackIdentity'] and new != old, 'NEW_DOMAIN_NOT_QUALIFIED_OR_UNCHANGED')
        legacy.no_alias(self.target)
        need(self.b.identity(self.cwd) == old, 'OLD_OVERLAY_BYTES_CHANGED')
        idle = self.b.idle()
        snapshot = self.snapshot()
        self.check_environment(snapshot, prior)
        # The existing checker scans all observed workspace discovery roots.
        legacy.Switch(self.b, self.e, source=self.source, cwd=self.cwd).local_roots_clear(allow_target=True)
        return {'status': 'PLANNED', 'tenantId': m.UID, 'targetRoot': str(self.target),
                'sourceRoot': str(self.source), 'domainPackIdentity': new, 'previousDomainPackIdentity': old,
                'runtimeSha256': runtime, 'previousReceipt': str(self.previous),
                'previousReceiptSha256': m.sha(self.previous.read_bytes()), 'before': snapshot,
                'baseline': idle['baseline'], 'productionMutations': 0,
                'scope': 'Atomic replacement of enabled local overlay only. No center, settings, service or business writes.'}

    def apply(self, runtime, resume=False):
        if self.receipt.exists():
            need(resume, 'OVERLAY_RECEIPT_EXISTS_USE_EXPLICIT_RESUME')
            record = m.load(self.receipt)
            need(record.get('tenantId') == m.UID and record.get('targetRoot') == str(self.target)
                 and record.get('sourceRoot') == str(self.source) and record.get('runtimeSha256') == runtime,
                 'OVERLAY_RECEIPT_IDENTITY_CHANGED')
            need(record.get('status') in ('STAGED', 'EXCHANGE_PENDING', 'APPLIED'), 'OVERLAY_COPY_INCOMPLETE_REQUIRES_INSPECTION')
            need(record.get('previousReceiptSha256') == m.sha(self.previous.read_bytes()), 'PREVIOUS_OVERLAY_RECEIPT_CHANGED')
            need(record.get('domainPackIdentity') == self.b.gate(runtime)['domainPackIdentity'], 'QUALIFIED_OVERLAY_CHANGED')
        else:
            need(not resume, 'NO_OVERLAY_RECEIPT_TO_RESUME')
            record = self.plan(runtime)
            record['stagingRoot'] = str(self.cwd / ('.round12-domain-exchange-' + uuid.uuid4().hex))
            record.update(status='COPY_PENDING', startedAt=m.now())
            atomic_record(self.receipt, record)
            stage = Path(record['stagingRoot'])
            stage.mkdir(mode=0o700)
            shutil.copytree(self.source / 'domain-packs' / PACK, stage / 'domain-packs' / PACK)
            need(self.b.identity(stage) == record['domainPackIdentity'], 'STAGED_DOMAIN_BYTES_CHANGED')
            record['status'] = 'STAGED'
            atomic_record(self.receipt, record)
        stage = legacy.no_alias(record['stagingRoot'])
        need(stage.parent == self.cwd and stage.name.startswith('.round12-domain-exchange-'), 'STAGE_PATH_INVALID')
        need(self.b.identity(self.source) == record['domainPackIdentity'], 'SOURCE_DOMAIN_BYTES_CHANGED')
        idle = self.b.idle()
        need(idle['baseline'] == record['baseline'], 'PRIOR_TEAM_BASELINE_CHANGED')
        now = self.snapshot()
        self.check_environment(now, m.load(self.previous))
        need(now == record['before'], 'ENVIRONMENT_CHANGED_SINCE_OVERLAY_PLAN')
        legacy.Switch(self.b, self.e, source=self.source, cwd=self.cwd).local_roots_clear(allow_target=True)
        state = reconciled_state(self.b.identity(self.cwd), self.b.identity(stage),
                                 record['previousDomainPackIdentity'], record['domainPackIdentity'])
        if state == 'ready_to_exchange':
            need(record['status'] != 'APPLIED', 'APPLIED_OVERLAY_WAS_REVERSED')
            self.b.idle_boundary(record['baseline'])
            boundary = self.snapshot()
            need(boundary == record['before'], 'ENVIRONMENT_CHANGED_AT_EXCHANGE')
            self.check_environment(boundary, m.load(self.previous))
            record['status'] = 'EXCHANGE_PENDING'
            atomic_record(self.receipt, record)
            atomic_exchange(stage / 'domain-packs' / PACK, self.target)
        need(reconciled_state(self.b.identity(self.cwd), self.b.identity(stage),
                              record['previousDomainPackIdentity'], record['domainPackIdentity']) == 'already_exchanged',
             'EXCHANGE_VERIFICATION_FAILED')
        after = self.snapshot()
        need(after == record['before'], 'ENVIRONMENT_CHANGED_AFTER_EXCHANGE')
        self.check_environment(after, m.load(self.previous))
        record.update(status='APPLIED', finishedAt=m.now(), productionMutations=1,
                      retainedPreviousPackRoot=str(stage / 'domain-packs' / PACK), centerMutations=0,
                      settingsMutations=0, servicesReloaded=False, businessSessionsStarted=False,
                      resumed=resume, idleChecksAreNotAtomicMaintenanceLock=True)
        atomic_record(self.receipt, record)
        return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'apply', 'resume'))
    parser.add_argument('--evidence-dir', type=Path, required=True)
    parser.add_argument('--expected-runtime-sha256', required=True)
    args = parser.parse_args()
    m.EVIDENCE = args.evidence_dir.resolve()
    m.SAMPLE = m.EVIDENCE / 'real-rerun'
    c.QUALIFICATION = m.EVIDENCE / 'candidate-qualification.json'
    previous = c.MAIN / 'docs/evidence/report-quality-round11-20261003/real-domain-switch.json'
    m.EVIDENCE.mkdir(parents=True, exist_ok=True)
    with (m.EVIDENCE / '.domain-upgrade.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        client = m.Client()
        try:
            client.login()
            upgrade = Upgrade(legacy.Backend(client), m.EVIDENCE, previous)
            result = upgrade.plan(args.expected_runtime_sha256) if args.action == 'plan' else upgrade.apply(args.expected_runtime_sha256, resume=args.action == 'resume')
            if args.action == 'plan':
                atomic_record(m.EVIDENCE / 'real-domain-upgrade-plan.json', result)
            print(json.dumps(result, ensure_ascii=False))
        finally:
            client.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'ERROR', 'code': m.safe_error(error)}), file=sys.stderr)
        sys.exit(1)
