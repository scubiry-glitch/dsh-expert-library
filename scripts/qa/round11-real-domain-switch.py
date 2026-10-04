#!/usr/bin/env python3
"""One real-tenant workspace overlay switch. Import is inert; no auto-resume.

Center releases are never edited or uninstalled. Only center disable/enable and
one settings/mutate path are writable. Local loopback management access is bound
to the authenticated real instance PID/listener before every center request.
Separate idle/CAS checks are not an atomic tenant maintenance lock.
"""
import argparse
import ctypes
import fcntl
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
import uuid

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('round11_domain_switch_controller', ROOT / 'scripts/qa/round11-real-rerun.py')
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
m = controller.m
PACK = 'zhijian-realestate'
OLD_RELEASE = '5ad0f59f-e497-421d-882e-7eb0a9c7841f'
CENTER = '/plugins/dsh-expert-library/manage/center'
RECEIPT = 'real-domain-switch.json'
PLAN = 'real-domain-switch-plan.json'
need = m.need


def selected_settings(description):
    rows = [v for v in description['namespaces'] if v.get('ns') == 'expert-library']
    need(len(rows) == 1, 'EXPERT_LIBRARY_SETTINGS_AMBIGUOUS')
    row = rows[0]
    need(type(row.get('revision')) is int and 0 <= row['revision'] <= 9007199254740991, 'SETTINGS_REVISION_INVALID')
    user = row.get('user', {})
    need(isinstance(user, dict) and isinstance(row.get('value'), dict), 'SETTINGS_SHAPE_INVALID')
    value = row['value'].get('enabledPacks')
    need(isinstance(value, list) and all(isinstance(s, str) for s in value), 'ENABLED_PACKS_INVALID')
    # No other namespace values or user settings enter a receipt.
    return {'revision': row['revision'], 'value': value,
            'userFieldPresent': 'enabledPacks' in user,
            **({'userValue': user['enabledPacks']} if 'enabledPacks' in user else {})}


def inventory(value):
    need(value.get('mode') == 'normal' and type(value.get('generation')) is int, 'CENTER_NOT_WRITABLE')
    stable, active = {}, {}
    fields = ('releaseId', 'packId', 'version', 'source', 'centerId', 'ownerOrgId', 'installedAt',
              'previousReleaseId', 'artifactSha256', 'contentTreeSha256', 'manifestSha256')
    for row in value['items']:
        need(row.get('integrity') == 'verified', 'CENTER_RELEASE_INTEGRITY_UNVERIFIED')
        rid = row['releaseId']
        need(rid not in stable, 'CENTER_DUPLICATE_RELEASE')
        stable[rid] = {key: row[key] for key in fields if key in row}
        if row['active']:
            need(row['packId'] not in active, 'CENTER_DUPLICATE_ACTIVE')
            active[row['packId']] = rid
    return {'generation': value['generation'], 'active': active, 'releases': stable}


def unchanged_inventory(current, before, disabled):
    need(current['releases'] == before['releases'], 'IMMUTABLE_RELEASE_INVENTORY_CHANGED')
    wanted = {k: v for k, v in before['active'].items() if not disabled or k != PACK}
    need(current['active'] == wanted, 'OTHER_ACTIVE_RELEASE_OR_TARGET_CHANGED')


def original_setting(current, original):
    return all(current.get(key) == original.get(key) for key in ('value', 'userFieldPresent', 'userValue'))


def applied_setting(current, original, expected_revision=None):
    expected_revision = original['revision'] + 1 if expected_revision is None else expected_revision
    return (current['revision'] == expected_revision and current['value'] == [PACK]
            and current['userFieldPresent'] and current.get('userValue') == [PACK])


def no_alias(path):
    path = pathlib.Path(path).absolute()
    for part in (path, *path.parents):
        need(not part.is_symlink(), 'LOCAL_PATH_ALIAS')
    return path


def atomic_publish(source, target):
    """Linux renameat2(RENAME_NOREPLACE): never replace a racing empty directory."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    need(rename is not None, 'ATOMIC_NO_REPLACE_UNAVAILABLE')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    result = rename(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    if result != 0:
        raise RuntimeError('ATOMIC_PUBLICATION_REFUSED')


class Backend:
    def __init__(self, client):
        self.client = client

    def instance(self):
        return m.bound_instance(self.client)

    def idle(self):
        prep = m.finalized_preparation()
        result = controller.verify_previous_stopped(self.client, prep)
        return {'baseline': prep['pausedTeamsBaseline'], 'check': result}

    def idle_boundary(self, baseline):
        """Fresh mutation fence without repeating historical child catalog scans."""
        need(controller.paused_snapshot() == baseline, 'PRIOR_TEAM_BASELINE_CHANGED')
        for team in baseline:
            goal = self.client.rpc('goals/get', args={'agentId': team['captainSessionId']})
            need(not goal or goal.get('phase') in ('paused', 'blocked', 'complete'), 'PRIOR_TEAM_GOAL_ACTIVE')
        rows = self.client.rpc('session/list', args={'_request': {}})['items']
        need(all(row.get('running') is False for row in rows), 'TENANT_HAS_RUNNING_OR_UNKNOWN_SESSION')
        return {'allTenantSessionsInactive': True, 'priorCaptainGoalsInactive': len(baseline), 'checkedAt': m.now()}

    def settings(self):
        return selected_settings(self.client.rpc('settings/describe', args={}))

    def mutate(self, before, restore=False):
        need(getattr(self, 'write_instance', None) == self.instance(), 'WRITE_INSTANCE_CHANGED')
        op = ({'op': 'set', 'path': ['enabledPacks'], 'value': before['userValue']}
              if restore and before['userFieldPresent'] else
              {'op': 'unset', 'path': ['enabledPacks']} if restore else
              {'op': 'set', 'path': ['enabledPacks'], 'value': [PACK]})
        self.client.rpc('settings/mutate', args={'ns': 'expert-library', 'expectedRevision': before['revision'], 'ops': [op]})

    def center(self, path, data=None):
        need(path in ('/installations', '/operations', '/update-policy') or re.fullmatch(r'/operations/[A-Za-z0-9_.:-]+', path), 'CENTER_ROUTE_NOT_ALLOWED')
        if data is not None:
            need(path == '/operations' and data['kind'] in ('disable', 'enable'), 'CENTER_WRITE_NOT_ALLOWED')
            need(data.get('packId', PACK) == PACK and data.get('releaseId', OLD_RELEASE) == OLD_RELEASE, 'CENTER_WRITE_TARGET_CHANGED')
        instance = self.instance()
        if data is not None:
            need(getattr(self, 'write_instance', None) == instance, 'WRITE_INSTANCE_CHANGED')
        address = f"http://127.0.0.1:{instance['port']}{CENTER}{path}"
        request = urllib.request.Request(address, data=None if data is None else json.dumps(data).encode(),
                                        headers={'Content-Type': 'application/json', 'X-Pack-Center-UI': '1'},
                                        method='GET' if data is None else 'POST')
        try:
            with self.client.opener.open(request, timeout=30) as response:
                value = json.loads(response.read(8 * 1024 * 1024 + 1))
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'CENTER_HTTP_{error.code}') from None
        need(value.get('ok') is True, 'CENTER_REQUEST_REJECTED')
        return value['data']

    def identity(self, root):
        return controller.domain_identity(root)

    def gate(self, expected):
        return controller.payload_gate(expected)


class Switch:
    def __init__(self, backend, evidence, source=ROOT, cwd=m.CWD):
        self.b = backend
        self.e = no_alias(evidence)
        self.source = no_alias(source)
        self.cwd = no_alias(cwd)
        self.target = self.cwd / 'domain-packs' / PACK
        self.path = self.e / RECEIPT
        self.plan_path = self.e / PLAN

    def write(self, record):
        m.save(self.path, record)

    def event(self, record, phase, **safe):
        record['phase'] = phase
        record.setdefault('events', []).append({'at': m.now(), 'phase': phase, **safe})
        self.write(record)

    def snapshot(self):
        return {'instance': self.b.instance(), 'settings': self.b.settings(),
                'center': inventory(self.b.center('/installations'))}

    def quiet_center(self):
        policy = self.b.center('/update-policy')
        need(policy.get('mode') == 'manual' and not policy.get('tickInFlight')
             and all(v == 'manual' for v in policy.get('perPack', {}).values()), 'CENTER_UPDATE_POLICY_NOT_QUIET')
        operations = self.b.center('/operations')
        need(all(job.get('status') not in ('queued', 'running', 'interrupted') for job in operations), 'CENTER_OPERATION_PENDING_OR_INTERRUPTED')

    def local_roots_clear(self, allow_target=False):
        # The preview covers all three observed tenant workspace roots. Check
        # every one, including bank, for a same-ID discovery conflict.
        roots = (m.TENANT / 'ws', self.cwd, m.TENANT / 'ws/main/work')
        for workspace in roots:
            directory = workspace / 'domain-packs'
            # Existing tenant discovery roots can contain a dangling alias. It
            # contributes no pack; once resolvable it must pass the alias guard.
            if not directory.exists():
                continue
            directory = no_alias(directory)
            need(directory.is_dir(), 'DOMAIN_PACKS_NOT_DIRECTORY')
            for child in directory.iterdir():
                no_alias(child)
                if not child.is_dir():
                    continue
                metadata = child / 'pack.json'
                if metadata.exists():
                    need(m.load(metadata).get('id') != PACK or allow_target and child == self.target, 'LOCAL_PACK_CONFLICT')
        need(allow_target or not self.target.exists(), 'TARGET_ALREADY_EXISTS')

    def preview(self, domain, center):
        path = self.e / 'real-domain-switch-preview.json'
        value = m.load(path)
        need(value.get('status') == 'PASS' and value.get('productionMutations') == 0, 'COMBINED_PREVIEW_NOT_PASSED')
        need(value.get('inventoryGeneration') == center['generation'], 'PREVIEW_GENERATION_CHANGED')
        need(all(value.get('sourceIdentity', {}).get(k) == domain[k] for k in ('contentTreeSha256', 'fileCount', 'sizeBytes')), 'PREVIEW_DOMAIN_CHANGED')
        retained = sorted([k, v] for k, v in center['active'].items() if k != PACK)
        need(sorted(value.get('retainedCenterReleases', [])) == retained, 'PREVIEW_RETAINED_CENTER_CHANGED')
        return {'path': str(path), 'sha256': m.sha(path.read_bytes())}

    def plan(self):
        need(not self.path.exists() and not self.plan_path.exists(), 'PLAN_ALREADY_EXISTS')
        self.local_roots_clear()
        self.quiet_center()
        current = self.snapshot()
        need(all(current['instance'].get(k) == v for k, v in m.OLD_INSTANCE.items()), 'EXPECTED_REAL_INSTANCE_CHANGED')
        before = current['center']
        need(before['generation'] == 21 and before['active'].get(PACK) == OLD_RELEASE and len(before['active']) == 4, 'CENTER_BASELINE_CHANGED')
        need(current['settings']['value'] == ['__none__'], 'LOCAL_PACK_SELECTION_NOT_DISABLED')
        domain = self.b.identity(self.source)
        need(domain['fileCount'] == 193 and domain['packId'] == PACK, 'QUALIFIED_PACK_SHAPE_CHANGED')
        proof = self.b.idle()
        need(len(proof['baseline']) == 12, 'TWELVE_PRIOR_BASELINES_REQUIRED')
        record = {'version': 1, 'status': 'PLANNED', 'tenantId': m.UID, 'createdAt': m.now(),
                  'targetRoot': str(self.target), 'sourceRoot': str(self.source), 'domainPackIdentity': domain,
                  'before': current, 'baseline': proof['baseline'], 'preview': self.preview(domain, before),
                  'runtimeSha256': controller.runtime_at(self.source)['sha256'],
                  'scope': 'real tenant local workspace overlay, not a center release publication or single-session-only change'}
        # Refuse replacing an earlier plan, even if another invocation won race.
        with self.plan_path.open('x') as handle:
            json.dump(record, handle, ensure_ascii=False, indent=2)
            handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        return record

    def load_plan(self):
        record = m.load(self.plan_path)
        need(record.get('status') == 'PLANNED' and record.get('version') == 1
             and record.get('tenantId') == m.UID and record.get('targetRoot') == str(self.target)
             and record.get('sourceRoot') == str(self.source), 'PLAN_IDENTITY_CHANGED')
        need(record['before']['center']['active'].get(PACK) == OLD_RELEASE, 'PLAN_RELEASE_CHANGED')
        need(m.sha(pathlib.Path(record['preview']['path']).read_bytes()) == record['preview']['sha256'], 'PREVIEW_CHANGED')
        return record

    def idle_bound(self, plan, exact_instance=True):
        need(self.b.idle()['baseline'] == plan['baseline'], 'PRIOR_TEAM_BASELINE_CHANGED')
        instance = self.b.instance()
        if exact_instance:
            need(instance == plan['before']['instance'], 'BOUND_INSTANCE_CHANGED')
        return instance

    def operation(self, record, kind, generation):
        key = 'round11-' + kind + '-' + str(uuid.uuid4())
        request = {'operationKey': key, 'kind': kind, 'expectedGeneration': generation,
                   **({'packId': PACK} if kind == 'disable' else {'releaseId': OLD_RELEASE})}
        self.event(record, kind + '_submission_pending', request=request)
        # Exactly one submission. A lost response remains uncertain; no retry.
        job = self.b.center('/operations', request)
        need(job.get('request') == request, 'CENTER_OPERATION_REQUEST_MISMATCH')
        self.event(record, kind + '_accepted', operationId=job['operationId'], operationKey=key)
        deadline = time.monotonic() + 120
        while job['status'] in ('queued', 'running') and time.monotonic() < deadline:
            time.sleep(1)
            job = self.b.center('/operations/' + job['operationId'])
            need(job.get('request') == request, 'CENTER_OPERATION_REQUEST_MISMATCH')
        need(job['status'] == 'succeeded', 'CENTER_OPERATION_NOT_SUCCEEDED')
        self.event(record, kind + '_succeeded', operationId=job['operationId'])

    def apply(self):
        plan = self.load_plan()
        if self.path.exists():
            need(m.load(self.path).get('status') == 'APPLIED', 'PARTIAL_SWITCH_REQUIRES_VERIFY_OR_ROLLBACK_NO_AUTO_RETRY')
            return self.verify()
        self.b.write_instance = plan['before']['instance']
        gate = self.b.gate(plan['runtimeSha256'])
        need(gate['domainPackIdentity'] == plan['domainPackIdentity'], 'QUALIFIED_DOMAIN_CHANGED')
        need(self.b.identity(self.source) == plan['domainPackIdentity'], 'SOURCE_DOMAIN_CHANGED')
        self.idle_bound(plan)
        self.local_roots_clear()
        self.quiet_center()
        need(self.snapshot() == plan['before'], 'PLAN_API_SNAPSHOT_CHANGED')
        record = {'version': 1, 'status': 'PARTIAL', 'tenantId': m.UID, 'targetRoot': str(self.target),
                  'domainPackIdentity': plan['domainPackIdentity'], 'runtimeSha256': plan['runtimeSha256'],
                  'planSha256': m.sha(self.plan_path.read_bytes()), 'events': []}
        self.event(record, 'apply_started')
        try:
            # Staging is outside every discovered domain-packs directory; same
            # workspace filesystem permits atomic publication by rename.
            staging = no_alias(self.cwd / ('.round11-domain-stage-' + uuid.uuid4().hex))
            staged = staging / 'domain-packs' / PACK
            self.event(record, 'copy_pending', stagingRoot=str(staging))
            staged.parent.mkdir(parents=True, exist_ok=False)
            shutil.copytree(self.source / 'domain-packs' / PACK, staged, symlinks=True)
            need(self.b.identity(staging) == plan['domainPackIdentity'], 'STAGED_DOMAIN_HASH_MISMATCH')
            self.event(record, 'copy_verified', stagingRoot=str(staging))
            self.idle_bound(plan)
            self.local_roots_clear()
            self.quiet_center()
            need(self.snapshot() == plan['before'], 'PLAN_CHANGED_BEFORE_DISABLE')
            self.operation(record, 'disable', plan['before']['center']['generation'])
            current = inventory(self.b.center('/installations'))
            unchanged_inventory(current, plan['before']['center'], True)
            need(current['generation'] == plan['before']['center']['generation'] + 1, 'CENTER_GENERATION_UNEXPECTED')
            self.idle_bound(plan)
            need(self.b.settings() == plan['before']['settings'], 'SETTINGS_CHANGED_BEFORE_PUBLICATION')
            self.local_roots_clear()
            need(self.b.identity(staging) == plan['domainPackIdentity'], 'STAGED_DOMAIN_CHANGED')
            no_alias(self.target.parent).mkdir(exist_ok=True)
            self.event(record, 'directory_publish_pending')
            # Fixed parent/target and root-owned maintenance context; no overwrite.
            need(not self.target.exists(), 'TARGET_ALREADY_EXISTS')
            atomic_publish(staged, self.target)
            need(self.b.identity(self.cwd) == plan['domainPackIdentity'], 'PUBLISHED_DOMAIN_HASH_MISMATCH')
            self.event(record, 'directory_published')
            try:
                staged.parent.rmdir()
                staging.rmdir()
                self.event(record, 'owned_empty_staging_removed')
            except OSError:
                self.event(record, 'owned_staging_cleanup_incomplete', stagingRoot=str(staging))
            self.idle_bound(plan)
            unchanged_inventory(inventory(self.b.center('/installations')), plan['before']['center'], True)
            need(self.b.settings() == plan['before']['settings'], 'SETTINGS_CHANGED_BEFORE_MUTATE')
            self.event(record, 'settings_submission_pending', expectedRevision=plan['before']['settings']['revision'])
            self.b.mutate(plan['before']['settings'])
            self.event(record, 'settings_returned')
            return self.verify()
        except Exception as error:
            record['status'] = 'PARTIAL'
            self.event(record, 'apply_stopped', errorCode=m.safe_error(error),
                       recovery='Do not rerun apply. Run verify to inspect exact center/settings/directory state; rollback only accepts recognized states and no pending center operation.')
            raise

    def resume_stage(self, record):
        copies = [e for e in record['events'] if e['phase'] == 'copy_verified']
        need(len(copies) == 1, 'RESUME_VERIFIED_STAGE_AMBIGUOUS')
        staging = pathlib.Path(copies[0].get('stagingRoot', ''))
        need(staging.is_absolute() and staging.parent == self.cwd
             and re.fullmatch(r'\.round11-domain-stage-[0-9a-f]{32}', staging.name), 'RESUME_STAGE_PATH_INVALID')
        need(any(e['phase'] == 'copy_pending' and e.get('stagingRoot') == str(staging)
                 for e in record['events']), 'RESUME_STAGE_COPY_INTENT_MISSING')
        return no_alias(staging)

    def resume_disable_proof(self, plan, record):
        events = record['events']
        succeeded = [e for e in events if e['phase'] == 'disable_succeeded']
        pending = [e for e in events if e['phase'] == 'disable_submission_pending']
        accepted = [e for e in events if e['phase'] == 'disable_accepted']
        need(len(succeeded) == len(pending) == len(accepted) == 1, 'RESUME_DISABLE_PROOF_MISSING_OR_AMBIGUOUS')
        request = pending[0].get('request') or {}
        need(set(request) == {'operationKey', 'kind', 'expectedGeneration', 'packId'}
             and request.get('kind') == 'disable' and request.get('packId') == PACK
             and request.get('expectedGeneration') == plan['before']['center']['generation']
             and isinstance(request.get('operationKey'), str)
             and accepted[0].get('operationKey') == request['operationKey']
             and accepted[0].get('operationId') == succeeded[0].get('operationId'), 'RESUME_DISABLE_PROOF_INVALID')
        identifier = succeeded[0]['operationId']
        need(isinstance(identifier, str) and re.fullmatch(r'[A-Za-z0-9_.:-]+', identifier), 'RESUME_DISABLE_OPERATION_ID_INVALID')
        need(events.index(pending[0]) < events.index(accepted[0]) < events.index(succeeded[0]), 'RESUME_DISABLE_EVENT_ORDER_INVALID')
        job = self.b.center('/operations/' + identifier)
        need(job.get('operationId') == identifier and job.get('request') == request
             and job.get('status') == 'succeeded', 'RESUME_DISABLE_NOT_CONFIRMED')

    def resume_boundary(self, plan):
        check = self.b.idle_boundary(plan['baseline'])
        need(self.b.instance() == plan['before']['instance'], 'BOUND_INSTANCE_CHANGED')
        current = inventory(self.b.center('/installations'))
        unchanged_inventory(current, plan['before']['center'], True)
        need(current['generation'] == plan['before']['center']['generation'] + 1, 'CENTER_GENERATION_UNEXPECTED')
        self.quiet_center()
        self.local_roots_clear(allow_target=True)
        return check

    def resume(self):
        """Explicit continuation after a proved disable; never submits disable.

        A prior settings submission with unchanged readback is unresolved, not
        permission to resend. Only the exact applied revision proves completion.
        """
        plan, record = self.load_plan(), m.load(self.path)
        need(record.get('status') in ('PARTIAL', 'APPLIED'), 'RESUME_STATUS_NOT_SUPPORTED')
        need(record.get('domainPackIdentity') == plan['domainPackIdentity']
             and record.get('runtimeSha256') == plan['runtimeSha256'], 'RESUME_PAYLOAD_BINDING_CHANGED')
        record_hash = m.sha(self.path.read_bytes())
        gate = self.b.gate(plan['runtimeSha256'])
        need(gate['domainPackIdentity'] == plan['domainPackIdentity'], 'QUALIFIED_DOMAIN_CHANGED')
        need(self.b.identity(self.source) == plan['domainPackIdentity'], 'SOURCE_DOMAIN_CHANGED')
        self.b.write_instance = plan['before']['instance']
        current, state = self.inspect(plan, record)
        need(current['instance'] == plan['before']['instance'], 'RESUME_REQUIRES_ORIGINAL_INSTANCE')
        unchanged_inventory(current['center'], plan['before']['center'], True)
        need(current['center']['generation'] == plan['before']['center']['generation'] + 1, 'CENTER_GENERATION_UNEXPECTED')
        need(not any(e['phase'].startswith(('rollback_', 'enable_')) for e in record['events']), 'RESUME_ROLLBACK_ALREADY_STARTED')
        self.resume_disable_proof(plan, record)
        self.quiet_center()
        staging = self.resume_stage(record)
        staged = no_alias(staging / 'domain-packs' / PACK)
        phases = [e['phase'] for e in record['events']]
        if state['localCandidatePresent']:
            need('directory_publish_pending' in phases, 'RESUME_TARGET_WITHOUT_PUBLISH_INTENT')
            need(not staged.exists(), 'RESUME_STAGE_AND_TARGET_BOTH_PRESENT')
        else:
            need('directory_published' not in phases, 'RESUME_PUBLISHED_TARGET_MISSING')
            need(staged.is_dir(), 'RESUME_STAGE_MISSING')
            need(self.b.identity(staging) == plan['domainPackIdentity'], 'STAGED_DOMAIN_CHANGED')
        pending_settings = [e for e in record['events'] if e['phase'] == 'settings_submission_pending']
        need(len(pending_settings) <= 1 and all(e.get('expectedRevision') == plan['before']['settings']['revision']
                                              for e in pending_settings), 'RESUME_SETTINGS_INTENT_INVALID')
        if state['settings'] == 'applied':
            need(state['localCandidatePresent'] and pending_settings, 'RESUME_APPLIED_WITHOUT_SUBMISSION_PROOF')
            # Fully committed before interruption: readback seals, never mutates.
            return self.verify()
        need(current['settings'] == plan['before']['settings'], 'RESUME_SETTINGS_STATE_CHANGED')
        need(not pending_settings and 'settings_returned' not in phases, 'RESUME_SETTINGS_SUBMISSION_UNRESOLVED')
        # One full ownership/catalog audit per invocation. Mutation boundaries
        # below recheck goal/session activity, baseline bytes, instance and CAS.
        self.idle_bound(plan)
        need(m.sha(self.path.read_bytes()) == record_hash, 'RESUME_JOURNAL_CHANGED_DURING_CHECKS')
        self.event(record, 'resume_started', fullIdleScans=1)
        try:
            if not self.target.exists():
                self.resume_boundary(plan)
                need(self.b.settings() == plan['before']['settings'], 'SETTINGS_CHANGED_BEFORE_PUBLICATION')
                need(self.b.identity(staging) == plan['domainPackIdentity'], 'STAGED_DOMAIN_CHANGED')
                no_alias(self.target.parent).mkdir(exist_ok=True)
                self.event(record, 'directory_publish_pending', resumed=True)
                atomic_publish(staged, self.target)
                need(self.b.identity(self.cwd) == plan['domainPackIdentity'], 'PUBLISHED_DOMAIN_HASH_MISMATCH')
                self.event(record, 'directory_published', resumed=True)
            else:
                need(self.b.identity(self.cwd) == plan['domainPackIdentity'], 'PUBLISHED_DOMAIN_HASH_MISMATCH')
                self.event(record, 'directory_publication_reconciled', resumed=True)
            try:
                if staged.parent.exists(): staged.parent.rmdir()
                if staging.exists(): staging.rmdir()
                self.event(record, 'owned_empty_staging_removed')
            except OSError:
                self.event(record, 'owned_staging_cleanup_incomplete', stagingRoot=str(staging))
            self.resume_boundary(plan)
            need(self.b.identity(self.cwd) == plan['domainPackIdentity'], 'PUBLISHED_DOMAIN_HASH_MISMATCH')
            need(self.b.settings() == plan['before']['settings'], 'SETTINGS_CHANGED_BEFORE_MUTATE')
            self.event(record, 'settings_submission_pending', expectedRevision=plan['before']['settings']['revision'], resumed=True)
            self.b.mutate(plan['before']['settings'])
            self.event(record, 'settings_returned', resumed=True)
            return self.verify()
        except BaseException as error:
            # Preserve KeyboardInterrupt's exact boundary for the next explicit
            # operator decision. No automatic retry, undo or second request.
            record['status'] = 'PARTIAL'
            self.event(record, 'resume_stopped', errorCode=m.safe_error(error),
                       recovery='Read verify state. Pending settings with original revision remains unresolved; resume never resends it.')
            raise

    def settings_epoch(self, plan, record, instance):
        original_instance = plan['before']['instance']
        if instance == original_instance:
            return {'kind': 'original', 'appliedRevision': plan['before']['settings']['revision'] + 1}
        # Settings revision starts at zero per registration/process. A changed
        # PID alone is never evidence that an unrelated edit may be ignored.
        admitted = record.get('appliedEvidence') or {}
        need(admitted.get('instance') == original_instance
             and admitted.get('settingsRevision') == plan['before']['settings']['revision'] + 1,
             'RELOAD_WITHOUT_PRIOR_APPLIED_PROOF')
        path = no_alias(self.e / 'production-reload.json')
        reload = m.load(path)
        proof = {'path': str(path), 'sha256': m.sha(path.read_bytes()), 'instance': instance}
        need(not record.get('reloadEpoch') or record['reloadEpoch'] == proof, 'RELOAD_EPOCH_RECEIPT_CHANGED')
        need(reload.get('status') == 'PASS' and reload.get('tenantId') == m.UID
             and reload.get('payloadGate', {}).get('runtime', {}).get('sha256') == plan['runtimeSha256'],
             'RELOAD_EPOCH_NOT_QUALIFIED')
        keys = ('id', 'pid', 'port', 'cwd')
        need(all(reload.get('instanceBefore', {}).get(k) == original_instance.get(k) for k in keys)
             and all(reload.get('instanceAfter', {}).get(k) == instance.get(k) for k in keys)
             and instance['id'] != original_instance['id'] and instance['pid'] != original_instance['pid'],
             'RELOAD_EPOCH_INSTANCE_MISMATCH')
        need(reload.get('teamsBefore') == reload.get('teamsAfter') == plan['baseline'], 'RELOAD_EPOCH_BASELINE_CHANGED')
        record['reloadEpoch'] = proof
        return {'kind': 'qualified_reload', 'appliedRevision': 0}

    def inspect(self, plan, record):
        need(record.get('tenantId') == m.UID and record.get('targetRoot') == str(self.target)
             and record.get('planSha256') == m.sha(self.plan_path.read_bytes()), 'JOURNAL_BINDING_CHANGED')
        current = self.snapshot()
        # Installed release identities and all other active mappings must stay exact.
        before = plan['before']['center']
        need(current['center']['releases'] == before['releases'], 'IMMUTABLE_RELEASE_INVENTORY_CHANGED')
        need({k: v for k, v in current['center']['active'].items() if k != PACK}
             == {k: v for k, v in before['active'].items() if k != PACK}, 'OTHER_ACTIVE_RELEASE_CHANGED')
        target = current['center']['active'].get(PACK)
        need(target in (None, OLD_RELEASE), 'TARGET_CENTER_RELEASE_CHANGED')
        self.local_roots_clear(allow_target=True)
        present = self.target.exists()
        if present:
            need(self.b.identity(self.cwd) == plan['domainPackIdentity'], 'LOCAL_CANDIDATE_BYTES_CHANGED')
        setting = current['settings']
        epoch = self.settings_epoch(plan, record, current['instance'])
        original = original_setting(setting, plan['before']['settings'])
        selected = applied_setting(setting, plan['before']['settings'], epoch['appliedRevision'])
        return current, {'centerTarget': 'original' if target == OLD_RELEASE else 'disabled',
                         'localCandidatePresent': present, 'settings': 'original' if original else 'applied' if selected else 'changed_or_unknown'}

    def verify(self):
        plan, record = self.load_plan(), m.load(self.path)
        current, state = self.inspect(plan, record)
        applied = state == {'centerTarget': 'disabled', 'localCandidatePresent': True, 'settings': 'applied'}
        need(not applied or current['center']['generation'] == plan['before']['center']['generation'] + 1, 'CENTER_GENERATION_UNEXPECTED')
        record['status'] = 'APPLIED' if applied else 'PARTIAL'
        if applied and current['instance'] == plan['before']['instance']:
            record['appliedEvidence'] = {'instance': current['instance'], 'settingsRevision': current['settings']['revision'], 'at': m.now()}
        record['verification'] = {'at': m.now(), 'observed': current, 'state': state,
                                  'runtimeScopeNotYetAsserted': 'Controller must reload and verify actual scoped skill catalog before creating/starting business.'}
        self.event(record, 'verified' if applied else 'partial_verified')
        return record

    def rollback(self):
        plan, record = self.load_plan(), m.load(self.path)
        self.idle_bound(plan, exact_instance=False)
        current, state = self.inspect(plan, record)
        self.b.write_instance = current['instance']
        self.quiet_center()
        # No recovery by guessing a settings revision or replacing a user object.
        original = plan['before']['settings']
        if state['settings'] == 'original':
            epoch = self.settings_epoch(plan, record, current['instance'])
            allowed = (original['revision'], original['revision'] + 2) if epoch['kind'] == 'original' else (1,)
            need(current['settings']['revision'] in allowed, 'ROLLBACK_SETTINGS_REVISION_UNKNOWN')
            if epoch['kind'] == 'qualified_reload':
                need(any(e['phase'] == 'rollback_settings_pending' and e.get('expectedRevision') == 0 for e in record['events']), 'ROLLBACK_NEW_EPOCH_ORIGINAL_UNEXPLAINED')
        else:
            need(state['settings'] == 'applied', 'ROLLBACK_SETTINGS_STATE_UNKNOWN')
        try:
            if state['settings'] == 'applied':
                restore = {**original, 'revision': current['settings']['revision']}
                self.event(record, 'rollback_settings_pending', expectedRevision=restore['revision'])
                self.b.mutate(restore, restore=True)
                after = self.b.settings()
                need(original_setting(after, original) and after['revision'] == restore['revision'] + 1, 'ROLLBACK_SETTINGS_NOT_RESTORED')
                self.event(record, 'rollback_settings_restored')
            self.idle_bound(plan, exact_instance=False)
            current = inventory(self.b.center('/installations'))
            need(current['releases'] == plan['before']['center']['releases'], 'IMMUTABLE_RELEASE_INVENTORY_CHANGED')
            if state['centerTarget'] == 'disabled':
                unchanged_inventory(current, plan['before']['center'], True)
                need(current['generation'] == plan['before']['center']['generation'] + 1, 'ROLLBACK_CENTER_GENERATION_UNKNOWN')
                self.operation(record, 'enable', current['generation'])
            after = inventory(self.b.center('/installations'))
            unchanged_inventory(after, plan['before']['center'], False)
            need(original_setting(self.b.settings(), original), 'ROLLBACK_SETTINGS_NOT_RESTORED')
            record['status'] = 'ROLLED_BACK'
            self.event(record, 'rollback_verified', localCandidateRetainedDisabled=self.target.exists())
            return record
        except Exception as error:
            record['status'] = 'PARTIAL'
            self.event(record, 'rollback_stopped', errorCode=m.safe_error(error), recovery='Inspect exact API state and journal; no automatic retry.')
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-dir', required=True, type=pathlib.Path)
    parser.add_argument('--action', required=True, choices=('plan', 'apply', 'resume', 'verify', 'rollback'))
    args = parser.parse_args()
    evidence = no_alias(args.evidence_dir)
    need(evidence.is_dir(), 'EVIDENCE_DIRECTORY_REQUIRED')
    m.EVIDENCE, m.SAMPLE = evidence, evidence / 'real-rerun'
    controller.QUALIFICATION = evidence / 'candidate-qualification.json'
    # Previous-run stop evidence checked before even reading credentials.
    m.finalized_preparation()
    if args.action in ('apply', 'resume'):
        plan = m.load(evidence / PLAN)
        controller.payload_gate(plan['runtimeSha256'])
    with (evidence / '.real-domain-switch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        client = m.Client()
        try:
            client.login()
            result = getattr(Switch(Backend(client), evidence), args.action)()
            print(json.dumps({'status': result['status'], 'record': str(evidence / (PLAN if args.action == 'plan' else RECEIPT)),
                              'targetRoot': result['targetRoot'], 'domainPackIdentity': result['domainPackIdentity']}, ensure_ascii=False))
        finally:
            client.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'FAILED', 'errorCode': m.safe_error(error),
                          'recovery': 'No automatic retry. Read real-domain-switch.json partial journal; use verify before deciding rollback.'}), file=sys.stderr)
        sys.exit(1)
