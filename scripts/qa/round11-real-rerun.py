#!/usr/bin/env python3
"""Round 11 controlled adapter; import is inert and never constructs a Client.

Reuses the sealed round9 reload/CAS/request-id safety implementation. Defaults
write QA records only below this candidate. Production actions remain explicit
separate commands and require exact candidate/installed bytes and qualification.
There is deliberately no completion/seal or business steering action: lifecycle
completion alone cannot satisfy this iteration's artifact-quality Goal.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib
import re
import sys
import uuid

sys.dont_write_bytecode = True
CANDIDATE = pathlib.Path(__file__).resolve().parents[2]
MAIN = pathlib.Path('/root/zhijian/dsh-expert-library')
BASE = CANDIDATE / 'scripts/qa/round9-real-rerun.py'
BASE_SHA256 = '34a80bfdb200794f7ea8f6f1623e3a1168c6bef7857a311909d628c051c81779'
if hashlib.sha256(BASE.read_bytes()).hexdigest() != BASE_SHA256:
    raise RuntimeError('SEALED_CONTROLLER_IMPLEMENTATION_CHANGED')
spec = importlib.util.spec_from_file_location('round11_sealed_controller', BASE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.EVIDENCE = CANDIDATE / 'docs/evidence/report-quality-round11-20261003'
m.PREVIOUS_SAMPLE = MAIN / 'docs/evidence/report-quality-round10-20261003/real-rerun'
m.SAMPLE = m.EVIDENCE / 'real-rerun'
m.OLD_CAPTAIN = 'session-99c8eed8-0d86-4d32-8421-1008730bf29c'
m.OLD_TEAM_ID = '车公庄置换重跑10-20261003-730bf29c'
m.OLD_TEAM_CREATED_AT = 1791033975977
m.OLD_RUNTIME_SHA256 = '1f0c19a05c7e973844c7f2d4f017aacf305dedba433403fa5950403aa1330900'
m.OLD_RUNTIME_FILE_COUNT = 133
m.OLD_INSTANCE = {'id': '7097b2a9-804d-400d-b136-f525048ce2f3', 'pid': 235669, 'port': 40787}
m.OLD_OUTPUT_REL = 'work/cgz-swap-rerun10-20261003'
m.OUTPUT_REL = 'work/cgz-swap-rerun11-20261003'
m.PAUSED_TEAMS = (*m.PAUSED_TEAMS, m.CWD / 'expert-teams/车公庄置换重跑9-20261003-809d4d8b/team.json', m.CWD / 'expert-teams' / m.OLD_TEAM_ID / 'team.json')
QUALIFICATION = m.EVIDENCE / 'candidate-qualification.json'
original_payload_gate = m.payload_gate
original_preparation = m.preparation
original_create_session = m.create_session
original_start_session = m.start_session
original_verify_previous_stopped = m.verify_previous_stopped
original_reload_tenant = m.reload_tenant


def runtime_at(root):
    paths = ['package.json', 'packages/pack-contract/index.mjs', 'packages/pack-artifact/index.mjs']
    paths += [str(p.relative_to(root)) for p in (root / 'lib').rglob('*')
              if p.is_file() and not p.is_symlink() and p.suffix in ('.js', '.mjs', '.cjs', '.json')]
    manifest = [{'path': p, 'bytes': (root / p).stat().st_size, 'sha256': m.sha((root / p).read_bytes())}
                for p in sorted(paths)]
    return {'sha256': m.sha(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode()),
            'fileCount': len(manifest)}


def domain_identity(root):
    """Independent installed-domain byte identity, using dsh-pack-tree-v1."""
    pack = root.resolve() / 'domain-packs/zhijian-realestate'
    m.need(pack.is_dir() and not pack.is_symlink(), 'CRAFT_DOMAIN_PACK_MISSING')
    files = []
    for target in sorted(pack.rglob('*'), key=lambda p: p.relative_to(pack).as_posix().encode('utf-8')):
        relative = target.relative_to(pack).as_posix()
        m.need(not target.is_symlink(), 'CRAFT_DOMAIN_PACK_ALIAS')
        if target.is_dir():
            continue
        stat = target.stat()
        m.need(target.is_file() and stat.st_nlink == 1, 'CRAFT_DOMAIN_PACK_NOT_REGULAR')
        m.need(not any(x in ('', '.', '..', '.git') for x in relative.split('/'))
               and not any(ord(x) < 32 or x in '\\:' for x in relative), 'CRAFT_DOMAIN_PACK_PATH_INVALID')
        data = target.read_bytes()
        after = target.stat()
        m.need((stat.st_ino, stat.st_size, stat.st_mtime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns), 'CRAFT_DOMAIN_PACK_CHANGED_DURING_READ')
        files.append({'path': relative, 'sizeBytes': len(data), 'sha256': m.sha(data)})
    m.need(0 < len(files) <= 10000 and sum(f['sizeBytes'] for f in files) <= 128 * 1024 * 1024, 'CRAFT_DOMAIN_PACK_SIZE')
    metadata = m.load(pack / 'pack.json')
    m.need(metadata.get('id') == 'zhijian-realestate' and metadata.get('schemaVersion') == 2, 'CRAFT_DOMAIN_PACK_IDENTITY')
    for skill in ('zhijian-report-craft', 'zhijian-designer-render'):
        manifest = m.load(pack / 'skill-packages' / (skill + '.json'))
        m.need(manifest.get('id') == skill and isinstance(manifest.get('craft'), dict), 'CRAFT_DOMAIN_SKILL_MISSING')
    body = json.dumps({'schemaVersion': 1, 'files': files}, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return {'packId': metadata['id'], 'version': metadata['version'], 'contentTreeSha256': m.sha(b'dsh-pack-tree-v1\x00' + body),
            'fileCount': len(files), 'sizeBytes': sum(f['sizeBytes'] for f in files)}


def material_identity(root):
    """Independent byte checks; never executes plugin JS or credential scripts."""
    root = root.resolve()

    def inside(relative):
        m.need(isinstance(relative, str) and relative and '\\' not in relative
               and not relative.startswith('/') and all(x not in ('', '.', '..') for x in relative.split('/')),
               'MATERIAL_PATH_INVALID')
        target = root
        for part in relative.split('/'):
            target /= part
            m.need(not target.is_symlink(), 'MATERIAL_PATH_ALIAS')
        m.need(target.is_file() and target.resolve().is_relative_to(root), 'MATERIAL_FILE_MISSING_OR_ESCAPED')
        return target

    manifest_path = inside('knowledge/skills/zhijian-report-craft/materials.v2.json')
    manifest = m.load(manifest_path)
    m.need(manifest.get('schemaVersion') == 2 and manifest.get('materialPackId') == 'zhijian-report-craft-v2',
           'MATERIAL_MANIFEST_IDENTITY_INVALID')
    digest = m.sha(json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
    compiled = inside('lib/report-craft-materials.js').read_text()
    declared = re.findall(r"REPORT_CRAFT_MATERIAL_DIGEST\s*=\s*['\"]([0-9a-f]{64})['\"]", compiled)
    m.need(declared == [digest], 'MATERIAL_COMPILED_DIGEST_MISMATCH')
    entries = manifest.get('entries')
    m.need(isinstance(entries, list) and 0 < len(entries) <= 128, 'MATERIAL_MANIFEST_ENTRIES_INVALID')
    contents, paths = {}, set()
    for entry in entries:
        m.need(isinstance(entry, dict) and isinstance(entry.get('id'), str)
               and entry['id'] not in contents and entry.get('path') not in paths, 'MATERIAL_DUPLICATE_OR_INVALID')
        raw = inside(entry['path']).read_bytes()
        m.need(type(entry.get('bytes')) is int and len(raw) == entry['bytes']
               and m.sha(raw) == entry.get('sha256'), 'MATERIAL_BYTES_CHANGED')
        raw.decode('utf-8', errors='strict')
        contents[entry['id']] = raw
        paths.add(entry['path'])
    for entry in entries:
        if 'copyOf' in entry:
            m.need(entry['copyOf'] in contents and contents[entry['id']] == contents[entry['copyOf']],
                   'MATERIAL_COPY_CHANGED')
    return {'materialPackId': 'zhijian-report-craft-v2', 'materialDigest': digest, 'entryCount': len(entries)}


def checked_evidence_file(record, root):
    path = pathlib.Path(record['path']).resolve()
    m.need(path.is_relative_to(root.resolve()) and path.is_file(), 'QUALIFICATION_EVIDENCE_PATH_INVALID')
    m.need(m.sha(path.read_bytes()) == record.get('sha256'), 'QUALIFICATION_EVIDENCE_CHANGED')
    return str(path)


def payload_gate(expected):
    # This runs before Client construction/login, and is rechecked by inherited
    # reload/create/start guards. Main runtime cannot silently lag the candidate.
    candidate_runtime = runtime_at(CANDIDATE)
    m.need(candidate_runtime['sha256'] == expected, 'CANDIDATE_RUNTIME_CHANGED')
    candidate_material = material_identity(CANDIDATE)
    candidate_domain = domain_identity(CANDIDATE)
    m.need(domain_identity(m.REPO) == candidate_domain, 'INSTALLED_DOMAIN_PACK_DIFFERS_FROM_CANDIDATE')
    m.need(material_identity(m.REPO) == candidate_material, 'INSTALLED_MATERIALS_DIFFER_FROM_CANDIDATE')
    record = m.load(QUALIFICATION)
    m.need(record.get('status') == 'PASS' and record.get('candidateRoot') == str(CANDIDATE)
           and record.get('runtime') == candidate_runtime and record.get('materialIdentity') == candidate_material
           and record.get('domainPackIdentity') == candidate_domain,
           'CANDIDATE_QUALIFICATION_MISMATCH')
    build = record.get('build') or {}
    m.need(type(build.get('exitCode')) is int and build['exitCode'] == 0, 'CANDIDATE_BUILD_NOT_PASSED')
    checked_evidence_file(build, m.EVIDENCE)
    tests = record.get('tests')
    m.need(isinstance(tests, list) and bool(tests), 'CANDIDATE_TEST_EVIDENCE_REQUIRED')
    for test in tests:
        m.need(test.get('status') == 'PASS', 'CANDIDATE_TESTS_NOT_PASSED')
        checked_evidence_file(test, m.EVIDENCE)
    for name in m.HOST_REPORTS:
        m.need(m.load(m.EVIDENCE / name).get('domainPackIdentity') == candidate_domain, 'HOST_DOMAIN_PACK_IDENTITY_MISMATCH')
    gate = original_payload_gate(expected)
    m.need(gate['runtime'] == candidate_runtime, 'INSTALLED_RUNTIME_DIFFERS_FROM_CANDIDATE')
    return {**gate, 'candidateRoot': str(CANDIDATE), 'materialIdentity': candidate_material, 'domainPackIdentity': candidate_domain,
            'qualificationFile': str(QUALIFICATION), 'qualificationSha256': m.sha(QUALIFICATION.read_bytes()),
            'controllerBaseSha256': BASE_SHA256, 'priorTeamCount': 12,
            'artifactAcceptanceRequired': True, 'completionPolicy': 'No automatic Goal completion or completion seal; exact final artifact quality requires independent evidence.'}


def paused_snapshot():
    m.need(len(m.PAUSED_TEAMS) == 12, 'TWELVE_PRIOR_TEAMS_REQUIRED')
    rows = m.team_snapshot(m.PAUSED_TEAMS[:9], True) + m.team_snapshot(m.PAUSED_TEAMS[9:], False)
    m.need(rows[-1]['captainSessionId'] == m.OLD_CAPTAIN, 'PREVIOUS_RUN_CAPTAIN_MISMATCH')
    return rows


def previous_stop_evidence(path):
    """A failed quality run must be truthfully paused, never relabeled completed."""
    path = pathlib.Path(path).resolve()
    m.need(path == (m.PREVIOUS_SAMPLE / 'pause-for-next-iteration.json').resolve(), 'PREVIOUS_PAUSE_EVIDENCE_PATH_INVALID')
    receipt = m.load(path)
    previous = m.load(m.PREVIOUS_SAMPLE / 'run.json')
    m.need(previous.get('tenantId') == receipt.get('tenantId') == m.UID
           and previous.get('sessionId') == receipt.get('sessionId') == m.OLD_CAPTAIN,
           'PREVIOUS_RUN_IDENTITY_MISMATCH')
    m.need(receipt.get('status') == 'paused' and previous.get('status') == 'paused_for_next_optimization',
           'PREVIOUS_QUALITY_RUN_NOT_PAUSED')
    m.need(receipt.get('goalPhase') in (None, 'paused', 'blocked', 'complete')
           and receipt.get('diagnostics') == [] and receipt.get('errors') == [], 'PREVIOUS_STOP_UNRESOLVED')
    m.need(previous.get('instanceId') == m.OLD_INSTANCE['id'] and previous.get('runtimeSha256') == m.OLD_RUNTIME_SHA256,
           'PREVIOUS_RUNTIME_OR_INSTANCE_MISMATCH')
    m.need(isinstance(receipt.get('reason'), str) and bool(receipt['reason'].strip()), 'PREVIOUS_PAUSE_REASON_MISSING')
    started = m.dt.datetime.fromisoformat(previous['startedAt'])
    created = m.dt.datetime.fromisoformat(previous['createdAt'])
    finished = m.dt.datetime.fromisoformat(receipt['finishedAt'])
    m.need(created <= started <= finished, 'PREVIOUS_STOP_TIME_INVALID')
    binding = receipt.get('binding') or {}
    header = binding.get('captainHeader') or {}
    m.need(binding.get('tenantId') == m.UID and binding.get('sessionId') == m.OLD_CAPTAIN
           and binding.get('teamId') == m.OLD_TEAM_ID and binding.get('teamPath') == str(m.PAUSED_TEAMS[-1])
           and binding.get('teamPresent') is True, 'PREVIOUS_TEAM_BINDING_INVALID')
    m.need(header.get('id') == m.OLD_CAPTAIN and header.get('parentSession') is None and header.get('cwd') == str(m.CWD),
           'PREVIOUS_CAPTAIN_HEADER_INVALID')
    m.need(type(header.get('createdAt')) in (int, float)
           and created.timestamp() * 1000 <= header['createdAt'] <= started.timestamp() * 1000,
           'PREVIOUS_CAPTAIN_HEADER_TIME_INVALID')
    team = m.load(m.PAUSED_TEAMS[-1])
    m.need(team.get('captainSessionId') == m.OLD_CAPTAIN and team.get('id') == team.get('name') == m.OLD_TEAM_ID
           and team.get('createdAt') == m.OLD_TEAM_CREATED_AT and team.get('halted') is True,
           'PREVIOUS_TEAM_NOT_EXACTLY_HALTED')
    m.need(started.timestamp() * 1000 <= team['createdAt'] <= finished.timestamp() * 1000,
           'PREVIOUS_TEAM_TIME_INVALID')
    m.need(receipt.get('teams') == [{'path': str(m.PAUSED_TEAMS[-1]), 'id': m.OLD_TEAM_ID}],
           'PREVIOUS_TEAM_PATH_MISMATCH')
    rows = receipt.get('finalSessions')
    m.need(isinstance(rows, list) and 0 < len(rows) <= 128, 'PREVIOUS_STOPPED_SESSIONS_MISSING')
    ids = [row.get('sessionId') for row in rows]
    m.need(all(isinstance(s, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', s) for s in ids)
           and len(ids) == len(set(ids)) and all(row.get('running') is False for row in rows),
           'PREVIOUS_SESSIONS_NOT_STOPPED')
    m.need(set(ids) == {m.OLD_CAPTAIN, *(member['id'] for member in team['members'])}
           and all(row.get('parentSessionId') == m.OLD_CAPTAIN for row in rows if row['sessionId'] != m.OLD_CAPTAIN),
           'PREVIOUS_STOPPED_TREE_MISMATCH')
    return {'path': str(path), 'sha256': m.sha(path.read_bytes()), 'status': 'paused',
            'finishedAt': receipt['finishedAt'], 'sessionIds': ids, 'actualTeamId': m.OLD_TEAM_ID,
            'actualTeamPath': str(m.PAUSED_TEAMS[-1]), 'teamCreatedAt': m.OLD_TEAM_CREATED_AT,
            'previousRuntimeSha256': m.OLD_RUNTIME_SHA256, 'previousRuntimeFileCount': m.OLD_RUNTIME_FILE_COUNT,
            'artifactQualityAccepted': False, 'pauseIsCleanupNotSuccessfulDelivery': True}


def verify_previous_stopped(client, prep):
    # Reload affects the whole real tenant. Refuse if anyone is currently active,
    # including a session created by the user outside the observed business run.
    result = original_verify_previous_stopped(client, prep)
    unavailable_members = []
    for team in prep['pausedTeamsBaseline']:
        goal = client.rpc('goals/get', args={'agentId': team['captainSessionId']})
        m.need(not goal or goal.get('phase') in ('paused', 'blocked', 'complete'), 'PRIOR_TEAM_GOAL_ACTIVE')
        catalog = client.rpc('subagents/list', args={'parentSessionId': team['captainSessionId']})
        children = [entry for entry in catalog['entries'] if entry.get('kind') == 'child']
        m.need(all(entry.get('activity') == 'inactive' for entry in children), 'PRIOR_TEAM_CHILD_ACTIVE_OR_UNKNOWN')
        child_ids = {entry.get('id') for entry in children}
        for member_id in set(team['memberIds']) - child_ids:
            entries = [entry for entry in catalog['entries'] if entry.get('id') == member_id]
            # A historical cold descriptor can be unavailable while the native
            # session service still has an explicit, non-running session. Never
            # infer inactivity from absence or a corrupt/unknown descriptor.
            m.need(not entries or len(entries) == 1 and entries[0].get('kind') == 'diagnostic'
                   and entries[0].get('reason') == 'unavailable', 'PRIOR_TEAM_MEMBER_NOT_IN_CATALOG')
            unavailable_members.append({'sessionId': member_id, 'parentSessionId': team['captainSessionId'],
                                        'cwd': str(pathlib.Path(team['path']).parents[2]),
                                        'catalogDiagnostic': 'absent' if not entries else 'unavailable'})
    rows = client.rpc('session/list', args={'_request': {}})['items']
    m.need(all(row.get('running') is False for row in rows), 'TENANT_HAS_RUNNING_OR_UNKNOWN_SESSION')
    proofs = []
    for expected in unavailable_members:
        found = [row for row in rows if row.get('sessionId') == expected['sessionId']]
        m.need(len(found) == 1 and all(found[0].get(key) == expected[key] for key in ('sessionId', 'parentSessionId', 'cwd'))
               and found[0].get('origin') == 'subagent' and found[0].get('running') is False,
               'PRIOR_UNAVAILABLE_MEMBER_NOT_PROVEN_INACTIVE')
        proofs.append({**expected, 'origin': 'subagent', 'running': False,
                       'activityEvidence': 'native session/list',
                       'descriptorRecoverabilityVerified': False})
    return {**result, 'allTenantSessionsInactive': True, 'priorCaptainGoalsInactive': 12,
            'historicalUnavailableMemberActivityProofs': proofs}


def require_real_domain_installation():
    """Repository qualification alone is not an installed session-scope pack."""
    receipt = m.load(m.EVIDENCE / 'real-domain-switch.json')
    expected = domain_identity(CANDIDATE)
    m.need(receipt.get('status') == 'APPLIED'
           and receipt.get('targetRoot') == str(m.CWD / 'domain-packs/zhijian-realestate')
           and receipt.get('domainPackIdentity') == expected, 'REAL_DOMAIN_SWITCH_NOT_VERIFIED')
    m.need(domain_identity(m.CWD) == expected, 'REAL_DOMAIN_INSTALLED_BYTES_CHANGED')
    return expected


def verify_real_domain_catalog(client, session_id):
    expected = require_real_domain_installation()
    m.need(isinstance(session_id, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', session_id), 'DOMAIN_SESSION_ID_INVALID')
    catalog = client.request('/plugins/dsh-expert-library/craft-skills?session_id=' + session_id, tenant=True)
    m.need(catalog.get('sessionId') == session_id and isinstance(catalog.get('skills'), list), 'REAL_DOMAIN_CATALOG_INVALID')
    rows = [row for row in catalog['skills'] if row.get('packId') == expected['packId']]
    m.need(sorted(row.get('skillId', '') for row in rows) == ['zhijian-designer-render', 'zhijian-report-craft'], 'REAL_DOMAIN_SKILLS_MISSING')
    root = str(m.CWD / 'domain-packs/zhijian-realestate')
    m.need(all(row.get('root') == root and row.get('packVersion') == expected['version']
               and row.get('treeDigest') == expected['contentTreeSha256'] for row in rows), 'REAL_DOMAIN_CATALOG_IDENTITY_MISMATCH')
    proof = {'status': 'PASS', 'checkedAt': m.now(), 'sessionId': session_id, 'domainPackIdentity': expected,
             'sourceRoot': root, 'skills': rows, 'modelSelectionObserved': False}
    m.save(m.SAMPLE / 'actual-domain-catalog.json', proof)
    return proof


def reload_tenant(client, prep, expected):
    # Recheck directly at the stop request boundary, after slow payload checks.
    # Separate RPCs are not an atomic tenant-idle lock; the receipt states that limit.
    request = client.request
    require_real_domain_installation()

    def guarded_request(path, data=None, tenant=False, timeout=30):
        if path == '/api/dsh/stop':
            require_real_domain_installation()
            verify_previous_stopped(client, prep)
        return request(path, data, tenant=tenant, timeout=timeout)

    client.request = guarded_request
    try:
        result = original_reload_tenant(client, prep, expected)
        verify_real_domain_catalog(client, m.OLD_CAPTAIN)
        return result
    finally:
        client.request = request


def preparation():
    value = original_preparation()
    m.need(value.get('round') == 11 and value.get('priorTeamCount') == 12
           and value.get('artifactAcceptanceRequired') is True and value.get('controllerBaseSha256') == BASE_SHA256,
           'ROUND11_PREPARATION_POLICY_CHANGED')
    return value


def prepare():
    path = m.SAMPLE / 'preparation.json'
    if path.exists():
        return {'status': 'already_prepared', **preparation()}
    previous = m.load(m.PREVIOUS_SAMPLE / 'preparation.json')
    m.need(previous['sessionId'] == m.OLD_CAPTAIN and previous['tenantId'] == m.UID, 'PREVIOUS_RUN_IDENTITY_MISMATCH')
    prior = m.load(m.PREVIOUS_SAMPLE / 'previous-finalization.json')['teams']
    m.need(len(prior) == 11 and paused_snapshot()[:-1] == prior, 'PRIOR_ELEVEN_TEAM_BASELINE_CHANGED')
    sid = 'session-' + str(uuid.uuid4())
    team = f'车公庄置换重跑11-20261003-{sid[-8:]}'
    original = (m.PREVIOUS_SAMPLE / 'prompt.txt').read_bytes()
    m.need(m.sha(original) == previous['promptSha256'], 'PREVIOUS_PROMPT_CHANGED')
    prompt = original.decode('utf-8')
    # Only isolation labels change. No defect answer, craft recipe or review
    # result is added; new plugin material delivery must supply its own workflow.
    for old, new in ((previous['outputRelativePath'], m.OUTPUT_REL), (previous['teamName'], team)):
        m.need(prompt.count(old) == 1, 'PROMPT_BASE_LAYOUT_CHANGED')
        prompt = prompt.replace(old, new, 1)
    base = (m.PREVIOUS_SAMPLE / 'observe.py').read_text()
    m.need(m.sha(base.encode()) == previous['observerSha256'] and 'VERSION = 4' in base, 'PREVIOUS_OBSERVER_CHANGED')
    observer = m.extend_observer(base, sid)
    m.SAMPLE.mkdir(parents=True, exist_ok=True)
    (m.SAMPLE / 'prompt.txt').write_text(prompt)
    (m.SAMPLE / 'observe.py').write_text(observer)
    value = {'round': 11, 'preparedAt': m.now(), 'tenantId': m.UID, 'username': 'real', 'sessionId': sid,
             'cwd': str(m.CWD), 'title': f'车公庄置换｜第十一轮质量实跑 2026-10-03 {sid[-8:]}', 'teamName': team,
             'agentPreset': 'zhijian', 'outputRelativePath': m.OUTPUT_REL, 'promptRequestId': str(uuid.uuid4()),
             'promptFile': str(m.SAMPLE / 'prompt.txt'), 'promptSha256': m.sha(prompt.encode()),
             'observerFile': str(m.SAMPLE / 'observe.py'), 'observerSha256': m.sha(observer.encode()),
             'observerBaseFile': str(m.PREVIOUS_SAMPLE / 'observe.py'), 'observerBaseSha256': m.sha(base.encode()),
             'observerVersion': 4, 'permission': 'danger-full-access', 'approval': 'never',
             'modelControl': {k: v for k, v in previous['modelControl'].items() if not k.startswith('changeFrom')},
             'priorPausedTeamsBaseline': prior, 'priorTeamCount': 12, 'previousSessionId': m.OLD_CAPTAIN,
             'previousTeamPath': str(m.PAUSED_TEAMS[-1]), 'state': 'awaiting_previous_finalization',
             'expectedPreviousInstance': m.OLD_INSTANCE, 'hostEvidenceRequired': list(m.HOST_REPORTS),
             'maxActiveMembersRequired': 2, 'productionActionsExecuted': False,
             'controllerBaseSha256': BASE_SHA256, 'artifactAcceptanceRequired': True,
             'baselinePolicy': 'Nine earlier halted teams, two completed teams and one failed quality run paused after evidence capture; all twelve exact snapshots must remain unchanged.',
             'completionPolicy': 'Runtime completion is observation only. This controller never completes the quality Goal or seals artifact acceptance.'}
    m.save(path, value)
    return value


def create_session(client, prep, expected):
    verify_real_domain_catalog(client, m.OLD_CAPTAIN)
    result = original_create_session(client, prep, expected)
    path = m.SAMPLE / 'run.json'
    run = m.load(path)
    gate = payload_gate(expected)
    run.update({'round': 11, 'artifactAcceptanceRequired': True, 'materialIdentity': gate['materialIdentity'],
                'domainPackIdentity': gate['domainPackIdentity']})
    m.save(path, run)
    return result


def start_session(client, prep, expected):
    verify_real_domain_catalog(client, prep['sessionId'])
    return original_start_session(client, prep, expected)


m.payload_gate = payload_gate
m.paused_snapshot = paused_snapshot
m.previous_stop_evidence = previous_stop_evidence
m.verify_previous_stopped = verify_previous_stopped
m.reload_tenant = reload_tenant
m.preparation = preparation
m.prepare = prepare
m.create_session = create_session
m.start_session = start_session


def main():
    global QUALIFICATION
    config = argparse.ArgumentParser(add_help=False)
    config.add_argument('--evidence-dir', type=pathlib.Path)
    config.add_argument('--qualification-file', type=pathlib.Path)
    options, rest = config.parse_known_args()
    if options.evidence_dir:
        m.EVIDENCE = options.evidence_dir.resolve()
        m.SAMPLE = m.EVIDENCE / 'real-rerun'
    QUALIFICATION = (options.qualification_file or m.EVIDENCE / 'candidate-qualification.json').resolve()
    sys.argv = [sys.argv[0], *rest]
    return m.main()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'FAILED', 'errorCode': m.safe_error(error)}), file=sys.stderr)
        sys.exit(1)
