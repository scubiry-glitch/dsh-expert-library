#!/usr/bin/env python3
"""Round 10 controlled adapter; import is inert and never constructs a Client.

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
spec = importlib.util.spec_from_file_location('round10_sealed_controller', BASE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.EVIDENCE = CANDIDATE / 'docs/evidence/team-reliability-round10-20261003'
m.PREVIOUS_SAMPLE = MAIN / 'docs/evidence/team-reliability-round9-20261003/real-rerun'
m.SAMPLE = m.EVIDENCE / 'real-rerun'
m.OLD_CAPTAIN = 'session-cbf2a33a-2a34-400c-b6a9-fc0b809d4d8b'
m.OLD_TEAM_ID = '车公庄置换重跑9-20261003-809d4d8b'
m.OLD_TEAM_CREATED_AT = 1791023189398
m.OLD_RUNTIME_SHA256 = 'f5d748cbd2f3f6176f5bdc070f8ca5b0c1be1fe577c30213f9441e418af2b2f4'
m.OLD_RUNTIME_FILE_COUNT = 129
m.OLD_INSTANCE = {'id': 'a3e84078-decc-4439-9acc-e51ff1c97290', 'pid': 4170245, 'port': 38583}
m.OLD_OUTPUT_REL = 'work/cgz-swap-rerun9-20261003'
m.OUTPUT_REL = 'work/cgz-swap-rerun10-20261003'
m.PAUSED_TEAMS = (*m.PAUSED_TEAMS, m.CWD / 'expert-teams' / m.OLD_TEAM_ID / 'team.json')
QUALIFICATION = m.EVIDENCE / 'candidate-qualification.json'
original_payload_gate = m.payload_gate
original_preparation = m.preparation
original_create_session = m.create_session


def runtime_at(root):
    paths = ['package.json', 'packages/pack-contract/index.mjs', 'packages/pack-artifact/index.mjs']
    paths += [str(p.relative_to(root)) for p in (root / 'lib').rglob('*')
              if p.is_file() and not p.is_symlink() and p.suffix in ('.js', '.mjs', '.cjs', '.json')]
    manifest = [{'path': p, 'bytes': (root / p).stat().st_size, 'sha256': m.sha((root / p).read_bytes())}
                for p in sorted(paths)]
    return {'sha256': m.sha(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode()),
            'fileCount': len(manifest)}


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
    m.need(material_identity(m.REPO) == candidate_material, 'INSTALLED_MATERIALS_DIFFER_FROM_CANDIDATE')
    record = m.load(QUALIFICATION)
    m.need(record.get('status') == 'PASS' and record.get('candidateRoot') == str(CANDIDATE)
           and record.get('runtime') == candidate_runtime and record.get('materialIdentity') == candidate_material,
           'CANDIDATE_QUALIFICATION_MISMATCH')
    build = record.get('build') or {}
    m.need(type(build.get('exitCode')) is int and build['exitCode'] == 0, 'CANDIDATE_BUILD_NOT_PASSED')
    checked_evidence_file(build, m.EVIDENCE)
    tests = record.get('tests')
    m.need(isinstance(tests, list) and bool(tests), 'CANDIDATE_TEST_EVIDENCE_REQUIRED')
    for test in tests:
        m.need(test.get('status') == 'PASS', 'CANDIDATE_TESTS_NOT_PASSED')
        checked_evidence_file(test, m.EVIDENCE)
    gate = original_payload_gate(expected)
    m.need(gate['runtime'] == candidate_runtime, 'INSTALLED_RUNTIME_DIFFERS_FROM_CANDIDATE')
    return {**gate, 'candidateRoot': str(CANDIDATE), 'materialIdentity': candidate_material,
            'qualificationFile': str(QUALIFICATION), 'qualificationSha256': m.sha(QUALIFICATION.read_bytes()),
            'controllerBaseSha256': BASE_SHA256, 'priorTeamCount': 11,
            'artifactAcceptanceRequired': True, 'completionPolicy': 'No automatic Goal completion or completion seal; exact final artifact quality requires independent evidence.'}


def paused_snapshot():
    m.need(len(m.PAUSED_TEAMS) == 11, 'ELEVEN_PRIOR_TEAMS_REQUIRED')
    rows = m.team_snapshot(m.PAUSED_TEAMS[:9], True) + m.team_snapshot(m.PAUSED_TEAMS[9:], False)
    m.need(rows[-1]['captainSessionId'] == m.OLD_CAPTAIN, 'PREVIOUS_RUN_CAPTAIN_MISMATCH')
    return rows


def preparation():
    value = original_preparation()
    m.need(value.get('round') == 10 and value.get('priorTeamCount') == 11
           and value.get('artifactAcceptanceRequired') is True and value.get('controllerBaseSha256') == BASE_SHA256,
           'ROUND10_PREPARATION_POLICY_CHANGED')
    return value


def prepare():
    path = m.SAMPLE / 'preparation.json'
    if path.exists():
        return {'status': 'already_prepared', **preparation()}
    previous = m.load(m.PREVIOUS_SAMPLE / 'preparation.json')
    m.need(previous['sessionId'] == m.OLD_CAPTAIN and previous['tenantId'] == m.UID, 'PREVIOUS_RUN_IDENTITY_MISMATCH')
    prior = m.load(m.PREVIOUS_SAMPLE / 'previous-finalization.json')['teams']
    m.need(len(prior) == 10 and paused_snapshot()[:-1] == prior, 'PRIOR_TEN_TEAM_BASELINE_CHANGED')
    sid = 'session-' + str(uuid.uuid4())
    team = f'车公庄置换重跑10-20261003-{sid[-8:]}'
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
    value = {'round': 10, 'preparedAt': m.now(), 'tenantId': m.UID, 'username': 'real', 'sessionId': sid,
             'cwd': str(m.CWD), 'title': f'车公庄置换｜第十轮质量实跑 2026-10-03 {sid[-8:]}', 'teamName': team,
             'agentPreset': 'zhijian', 'outputRelativePath': m.OUTPUT_REL, 'promptRequestId': str(uuid.uuid4()),
             'promptFile': str(m.SAMPLE / 'prompt.txt'), 'promptSha256': m.sha(prompt.encode()),
             'observerFile': str(m.SAMPLE / 'observe.py'), 'observerSha256': m.sha(observer.encode()),
             'observerBaseFile': str(m.PREVIOUS_SAMPLE / 'observe.py'), 'observerBaseSha256': m.sha(base.encode()),
             'observerVersion': 4, 'permission': 'danger-full-access', 'approval': 'never',
             'modelControl': {k: v for k, v in previous['modelControl'].items() if not k.startswith('changeFrom')},
             'priorPausedTeamsBaseline': prior, 'priorTeamCount': 11, 'previousSessionId': m.OLD_CAPTAIN,
             'previousTeamPath': str(m.PAUSED_TEAMS[-1]), 'state': 'awaiting_previous_finalization',
             'expectedPreviousInstance': m.OLD_INSTANCE, 'hostEvidenceRequired': list(m.HOST_REPORTS),
             'maxActiveMembersRequired': 2, 'productionActionsExecuted': False,
             'controllerBaseSha256': BASE_SHA256, 'artifactAcceptanceRequired': True,
             'baselinePolicy': 'Nine halted teams and two completed teams; all eleven exact snapshots must remain unchanged.',
             'completionPolicy': 'Runtime completion is observation only. This controller never completes the quality Goal or seals artifact acceptance.'}
    m.save(path, value)
    return value


def create_session(client, prep, expected):
    result = original_create_session(client, prep, expected)
    path = m.SAMPLE / 'run.json'
    run = m.load(path)
    run.update({'round': 10, 'artifactAcceptanceRequired': True, 'materialIdentity': payload_gate(expected)['materialIdentity']})
    m.save(path, run)
    return result


m.payload_gate = payload_gate
m.paused_snapshot = paused_snapshot
m.preparation = preparation
m.prepare = prepare
m.create_session = create_session


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
