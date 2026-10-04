#!/usr/bin/env python3
"""Prepare / explicitly execute the single round-6 real-tenant sample.

No side effects on import. `prepare` is offline. Reload/create/start are separate
explicit actions, gated by successful real-Host evidence for the exact payload.
Credentials are parsed into memory from the existing local mechanism only;
tenant-safety.sh is never executed. No arbitrary RPC passthrough is provided.
"""
import argparse
import datetime as dt
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from http.cookies import SimpleCookie
from urllib.parse import urlparse

REPO = pathlib.Path('/root/zhijian/dsh-expert-library')
EVIDENCE = REPO / 'docs/evidence/team-reliability-round6-20261003'
PREVIOUS_SAMPLE = REPO / 'docs/evidence/team-reliability-round5-20261003/real-rerun'
SAMPLE = EVIDENCE / 'real-rerun'
UID = '54485b72-c5b9-4fbd-be13-bc0c2c82e0a5'
TENANT = pathlib.Path('/var/lib/dsh-server-login/users') / UID
CWD = TENANT / 'ws/main/bank'
ORIGIN = 'http://127.0.0.1:3082'
PROVIDER, MODEL = 'zai', 'glm-5.3-flash'
OUTPUT_REL = 'work/cgz-swap-rerun6-20261003'
HOST_REPORTS = ('member-host.json', 'quality-host.json', 'plan-host.json', 'goal-wait-host.json')
OLD_CAPTAIN = 'session-e3effc9f-a4c7-426b-bf98-81b6d75ad21b'
PAUSED_TEAMS = (
    TENANT / 'ws/expert-teams/宏观与资本市场观点看板-2026q4/team.json',
    CWD / 'expert-teams/香江红海园三期12-103估值分析/team.json',
    CWD / 'expert-teams/车公庄置换重跑20261003/team.json',
    CWD / 'expert-teams/车公庄置换重跑2-20261003-f172cf9f/team.json',
    CWD / 'expert-teams/车公庄置换重跑3-20261003-057fec35/team.json',
    CWD / 'expert-teams/车公庄置换重跑4-20261003-a5c0e34f/team.json',
    CWD / 'expert-teams/车公庄置换重跑5-20261003-d75ad21b/team.json',
)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def team_snapshot(paths, must_be_halted):
    result = []
    for path in paths:
        team = load(path)
        if must_be_halted:
            need(team.get('halted') is True, 'PAUSED_TEAM_NOT_HALTED')
        encoded = json.dumps(team['tasks'], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        result.append({'path': str(path), 'name': team['name'], 'captainSessionId': team['captainSessionId'],
                       'halted': team.get('halted') is True, 'tasksSha256': sha(encoded), 'taskSeq': team.get('taskSeq'),
                       'memberIds': [member['id'] for member in team['members']]})
    return result


def paused_snapshot():
    """Historical name retained for inherited reload guards; seventh may be completed."""
    result = team_snapshot(PAUSED_TEAMS[:-1], True) + team_snapshot(PAUSED_TEAMS[-1:], False)
    need(result[-1]['captainSessionId'] == OLD_CAPTAIN, 'PREVIOUS_RUN_CAPTAIN_MISMATCH')
    return result


def previous_stop_evidence(path):
    path = pathlib.Path(path).resolve()
    need(path.is_relative_to(PREVIOUS_SAMPLE.resolve()) and path.suffix == '.json', 'PREVIOUS_FINAL_EVIDENCE_PATH_INVALID')
    receipt = load(path)
    previous = load(PREVIOUS_SAMPLE / 'run.json')
    need(previous.get('tenantId') == UID and previous.get('sessionId') == OLD_CAPTAIN, 'PREVIOUS_RUN_IDENTITY_MISMATCH')
    need(receipt.get('tenantId') == UID and receipt.get('sessionId') == OLD_CAPTAIN, 'PREVIOUS_FINAL_IDENTITY_MISMATCH')
    need(receipt.get('status') in ('paused', 'completed'), 'PREVIOUS_FINAL_NOT_TERMINAL')
    need(receipt.get('goalPhase') in (None, 'paused', 'blocked', 'complete'), 'PREVIOUS_GOAL_STILL_ACTIVE')
    need(receipt.get('diagnostics') == [], 'PREVIOUS_OWNERSHIP_DIAGNOSTICS_UNRESOLVED')
    finished = dt.datetime.fromisoformat(receipt['finishedAt'])
    need(finished >= dt.datetime.fromisoformat(previous['startedAt']), 'PREVIOUS_FINAL_EVIDENCE_PREDATES_RUN')
    rows = receipt.get('finalSessions')
    need(isinstance(rows, list) and bool(rows), 'PREVIOUS_FINAL_SESSIONS_MISSING')
    ids = [row.get('sessionId') for row in rows]
    need(len(ids) <= 128 and all(isinstance(sid, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', sid) for sid in ids), 'PREVIOUS_FINAL_SESSION_ID_INVALID')
    need(len(ids) == len(set(ids)) and OLD_CAPTAIN in ids and all(row.get('running') is False for row in rows), 'PREVIOUS_SESSIONS_NOT_STOPPED')
    team = load(PAUSED_TEAMS[-1])
    need(team.get('captainSessionId') == OLD_CAPTAIN and team.get('id') == previous['teamName']
         and team.get('name') == previous['teamName'], 'PREVIOUS_FINAL_TEAM_MISMATCH')
    need([row.get('path') for row in receipt.get('teams', [])] == [str(PAUSED_TEAMS[-1])], 'PREVIOUS_FINAL_TEAM_PATH_MISMATCH')
    need(all(member['id'] in ids for member in team.get('members', [])), 'PREVIOUS_MEMBER_STOP_PROOF_MISSING')
    if receipt['status'] == 'paused':
        need(previous.get('status') == 'paused_for_next_optimization' and team.get('halted') is True
             and isinstance(receipt.get('reason'), str) and bool(receipt['reason'].strip()), 'PREVIOUS_PAUSE_NOT_CONFIRMED')
    else:
        need(previous.get('status') == 'completed' and bool(team.get('tasks'))
             and all(task.get('status') == 'completed' for task in team['tasks']), 'PREVIOUS_COMPLETION_NOT_CONFIRMED')
    return {'path': str(path), 'sha256': sha(path.read_bytes()), 'status': receipt['status'],
            'finishedAt': receipt['finishedAt'], 'sessionIds': ids}


def finalized_preparation():
    prep = preparation()
    path = SAMPLE / 'previous-finalization.json'
    need(path.exists(), 'PREVIOUS_FINALIZATION_REQUIRED_BEFORE_PRODUCTION')
    record = load(path)
    need(record.get('status') == 'PASS' and record.get('sessionId') == prep['sessionId'] and record.get('previousSessionId') == OLD_CAPTAIN
         and record.get('tenantId') == UID, 'FINALIZATION_IDENTITY_MISMATCH')
    need(previous_stop_evidence(record['evidence']['path']) == record['evidence'], 'PREVIOUS_FINAL_EVIDENCE_CHANGED')
    need(record['teams'] == paused_snapshot(), 'PRIOR_SEVEN_TEAM_BASELINE_CHANGED')
    need(record['teams'][:-1] == prep['priorPausedTeamsBaseline'], 'PRIOR_SIX_TEAM_BASELINE_CHANGED')
    return {**prep, 'pausedTeamsBaseline': record['teams'], 'previousFinalEvidence': record['evidence']}


def finalize_baseline(evidence_path):
    prep = preparation()
    need(not (SAMPLE / 'run.json').exists(), 'REFUSE_FINALIZE_AFTER_SESSION_CREATION')
    need(isinstance(evidence_path, str) and bool(evidence_path), 'PREVIOUS_FINAL_EVIDENCE_REQUIRED')
    path = SAMPLE / 'previous-finalization.json'
    if path.exists():
        finalized = finalized_preparation()
        need(pathlib.Path(evidence_path).resolve() == pathlib.Path(finalized['previousFinalEvidence']['path']), 'FINALIZATION_EVIDENCE_CANNOT_BE_REPLACED')
        return {'status': 'already_finalized', 'record': str(path)}
    proof = previous_stop_evidence(evidence_path)
    teams = paused_snapshot()
    need(teams[:-1] == prep['priorPausedTeamsBaseline'], 'PRIOR_SIX_TEAM_BASELINE_CHANGED')
    save(path, {'status': 'PASS', 'finalizedAt': now(), 'tenantId': UID, 'sessionId': prep['sessionId'],
                'previousSessionId': OLD_CAPTAIN, 'evidence': proof, 'teams': teams, 'productionActionsExecuted': False})
    return {'status': 'finalized_offline', 'record': str(path), 'previousStatus': proof['status'], 'teamCount': len(teams)}


def verify_previous_stopped(client, prep):
    """Read-only official metadata checks immediately before production actions."""
    need(paused_snapshot() == prep['pausedTeamsBaseline'], 'PRIOR_SEVEN_TEAM_BASELINE_CHANGED')
    rows = client.rpc('session/list', args={'_request': {}})['items']
    captain = [row for row in rows if row.get('sessionId') == OLD_CAPTAIN]
    need(len(captain) == 1 and captain[0].get('running') is False, 'PREVIOUS_CAPTAIN_RUNNING_OR_UNKNOWN')
    goal = client.rpc('goals/get', args={'agentId': OLD_CAPTAIN})
    need(not goal or goal.get('phase') in ('paused', 'blocked', 'complete'), 'PREVIOUS_GOAL_STILL_ACTIVE')
    seen, queue = {OLD_CAPTAIN}, [OLD_CAPTAIN]
    while queue:
        parent = queue.pop(0)
        catalog = client.rpc('subagents/list', args={'parentSessionId': parent})
        for child in catalog['entries']:
            sid = child.get('id')
            need(child.get('kind') == 'child' and child.get('activity') == 'inactive', 'PREVIOUS_CHILD_RUNNING_OR_UNKNOWN')
            need(isinstance(sid, str) and sid not in seen, 'PREVIOUS_CHILD_IDENTITY_INVALID')
            seen.add(sid)
            queue.append(sid)
            need(len(seen) <= 128, 'PREVIOUS_OWNED_TREE_LIMIT_EXCEEDED')
    need(seen == set(prep['previousFinalEvidence']['sessionIds']), 'PREVIOUS_OWNED_TREE_CHANGED')
    return {'sessionCount': len(seen), 'running': False, 'goalPhase': goal.get('phase') if goal else None, 'checkedAt': now()}


def runtime_identity():
    # Byte-for-byte equivalent to runtimeIdentity in team-communication-host-smoke.mjs.
    paths = ['package.json', 'packages/pack-contract/index.mjs', 'packages/pack-artifact/index.mjs']
    paths += [str(p.relative_to(REPO)) for p in (REPO / 'lib').rglob('*')
              if p.is_file() and not p.is_symlink() and p.suffix in ('.js', '.mjs', '.cjs', '.json')]
    manifest = [{'path': p, 'bytes': (REPO / p).stat().st_size, 'sha256': sha((REPO / p).read_bytes())}
                for p in sorted(paths)]
    return {'sha256': sha(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode()),
            'fileCount': len(manifest)}


def payload_gate(expected):
    need(isinstance(expected, str) and re.fullmatch(r'[0-9a-f]{64}', expected), 'EXPECTED_RUNTIME_SHA256_REQUIRED')
    actual = runtime_identity()
    need(actual['sha256'] == expected, 'RUNTIME_PAYLOAD_CHANGED')
    reports = []
    for name in HOST_REPORTS:
        path = EVIDENCE / name
        report = load(path)
        need(report.get('status') == 'PASS' and report.get('isolated') is True
             and report.get('productionTouched') is False and report.get('stopped') is True,
             'HOST_EVIDENCE_NOT_PASSED_OR_ISOLATED')
        need(report.get('businessApiCalls') == 0 and report.get('realLlmCalls') == 0,
             'HOST_EVIDENCE_NOT_DETERMINISTIC')
        need(report.get('candidateRuntimeSha256') == expected
             and report.get('candidateRuntimeFileCount') == actual['fileCount'], 'HOST_EVIDENCE_PAYLOAD_MISMATCH')
        reports.append({'path': str(path), 'sha256': sha(path.read_bytes()), 'kind': report.get('kind'),
                        'generatedAt': report.get('generatedAt'), 'status': 'PASS'})
    return {'runtime': actual, 'hostEvidence': reports, 'checkedAt': now()}


def preparation():
    value = load(SAMPLE / 'preparation.json')
    need(value['tenantId'] == UID and value['cwd'] == str(CWD), 'PREPARATION_TENANT_MISMATCH')
    need(value['outputRelativePath'] == OUTPUT_REL and value['sessionId'] != OLD_CAPTAIN, 'PREPARATION_SCOPE_MISMATCH')
    need(sha((SAMPLE / 'prompt.txt').read_bytes()) == value['promptSha256'], 'PREPARED_PROMPT_CHANGED')
    need(sha((SAMPLE / 'observe.py').read_bytes()) == value['observerSha256'], 'PREPARED_OBSERVER_CHANGED')
    return value


def prepare():
    path = SAMPLE / 'preparation.json'
    if path.exists():
        return {'status': 'already_prepared', **preparation()}
    SAMPLE.mkdir(parents=True, exist_ok=True)
    previous = load(PREVIOUS_SAMPLE / 'preparation.json')
    need(previous['sessionId'] == OLD_CAPTAIN and previous['tenantId'] == UID, 'PREVIOUS_RUN_IDENTITY_MISMATCH')
    prior_baseline = previous['pausedTeamsBaseline']
    need(team_snapshot(PAUSED_TEAMS[:-1], True) == prior_baseline, 'PRIOR_SIX_TEAM_BASELINE_CHANGED')
    sid = 'session-' + str(uuid.uuid4())
    suffix = sid[-8:]
    title = f'车公庄置换｜第六轮可靠性实跑 2026-10-03 {suffix}'
    team = f'车公庄置换重跑6-20261003-{suffix}'
    prompt = f'''请你帮我分析下需要注意的点，卖旧买新：
1、新房是展欣家苑，车公庄桥，西城天恒开发的那个。
2、旧的在车公庄西，建筑大学的家属院，叫建院二汽家属宿舍。
3、分析最近的供给、需求和成交趋势。
4、从三个不同的定价法角度分析未来的成交趋势（可比定价、租售比、其他再找一个）。
5、卖旧买新的金融成本提醒（税务、贷款）。
6、其余你认为有价值的分析。

使用专家库插件，必须使用贝壳 CLI 和政研通 CLI 的数据，挑选合适的领域包，使用智见报告工艺。

本次是独立新会话重跑，产物统一写入 {OUTPUT_REL}/，团队使用唯一名称“{team}”。不要读取或引用旧 work/cgz-swap/、work/cgz-swap-rerun-20261003/、work/cgz-swap-rerun2-20261003/、work/cgz-swap-rerun3-20261003/、work/cgz-swap-rerun4-20261003/、work/cgz-swap-rerun5-20261003/ 或任何此前轮次的旧团队报告、产物或诊断文档作为本次输入；从以上原始业务需求重新取数、分析与交付。

本轮控制条件：队长及所有专家成员（包括审核员）统一显式使用 provider=zai、model=glm-5.3-flash。创建专家成员或计划时明确指定这一路由，不采用旧专家预设的 DeepSeek 路由；只对本次队长和成员明确选用此路由，不调整其他会话。推理强度使用目标模型默认值。

原用户没有补充旧房面积、楼层、户型、产权、持有年限、家庭住房/贷款情况或具体新房房源；这些缺口请列明，用清楚标注的条件分支与敏感性分析完成现阶段可完成的工作，不把假设写成用户事实。按智见报告工艺交付可核查的 MD、HTML、PDF 和必要附件；确实受数据权限或服务不可用阻断时，保留明确错误证据并说明影响。
'''
    (SAMPLE / 'prompt.txt').write_text(prompt, encoding='utf-8')
    # Preserve the sealed v4 observer; only bind its three run-specific constants.
    base = (PREVIOUS_SAMPLE / 'observe.py').read_text(encoding='utf-8')
    need('VERSION = 4' in base, 'OBSERVER_BASE_VERSION_MISMATCH')
    observer = extend_observer(base, sid)
    (SAMPLE / 'observe.py').write_text(observer, encoding='utf-8')
    os.chmod(SAMPLE / 'observe.py', 0o700)
    value = {'preparedAt': now(), 'tenantId': UID, 'username': 'real', 'sessionId': sid, 'cwd': str(CWD),
             'title': title, 'teamName': team, 'agentPreset': 'zhijian', 'outputRelativePath': OUTPUT_REL,
             'promptRequestId': str(uuid.uuid4()), 'promptFile': str(SAMPLE / 'prompt.txt'), 'promptSha256': sha(prompt.encode()),
             'observerFile': str(SAMPLE / 'observe.py'), 'observerSha256': sha(observer.encode()),
             'observerBaseSha256': sha(base.encode()), 'observerBaseFile': str(PREVIOUS_SAMPLE / 'observe.py'), 'observerVersion': 4,
             'permission': 'danger-full-access', 'approval': 'never',
             'modelControl': {'provider': PROVIDER, 'model': MODEL, 'reasoningEffort': 'default', 'appliesTo': 'captain and all members/reviewers',
                              'sessionSelectionPolicy': 'Official session/selectModel also saves agent-default-model. Require an existing user object before creating the session, preserve it with CAS if changed, then verify the session-local GLM projection survives. Stop on concurrent edits; root unset cannot restore namespace absence.',
                              'changeFromRound5': 'None: captain and all members/reviewers retain the same explicit zai/glm-5.3-flash route and model-default reasoning setting as round 5.'},
             'priorPausedTeamsBaseline': prior_baseline, 'previousSessionId': OLD_CAPTAIN,
             'previousTeamPath': str(PAUSED_TEAMS[-1]), 'state': 'awaiting_previous_finalization',
             'baselinePolicy': 'No seventh-team terminal state is assumed. finalize-baseline requires actual stopped/terminal evidence before any production login or action.',
             'hostEvidenceRequired': list(HOST_REPORTS), 'productionActionsExecuted': False}
    save(path, value)
    return value


class Client:
    def __init__(self):
        self.cookie = None
        self.tenant_host = None
        self.logged_in = False
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, path, data=None, tenant=False, timeout=30):
        headers = {'Content-Type': 'application/json', 'Host': 'zj.meizu.life'}
        if tenant:
            need(self.tenant_host == 'real.zj.meizu.life', 'TENANT_HOST_NOT_VERIFIED')
            headers['X-Forwarded-Host'] = self.tenant_host
        if self.cookie:
            headers['Cookie'] = self.cookie
        request = urllib.request.Request(ORIGIN + path, data=None if data is None else json.dumps(data).encode(),
                                         headers=headers, method='GET' if data is None else 'POST')
        try:
            with self.opener.open(request, timeout=timeout) as response:
                cookies = SimpleCookie()
                for value in response.headers.get_all('Set-Cookie', []):
                    cookies.load(value)
                if 'sid' in cookies:
                    self.cookie = ('sid=' + cookies['sid'].value) if cookies['sid'].value else None
                body = response.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'HTTP_{error.code}') from None

    def login(self):
        # Read only the established credential label, never source/execute the script.
        raw = pathlib.Path('/root/tenant-safety.sh').read_text()
        match = re.search(r'(?s)\bTENANTS=\((.*?)\)', raw)
        need(match is not None, 'CREDENTIAL_LABEL_MISSING')
        rows = [item.split(':', 2) for item in shlex.split(match.group(1), comments=True)]
        entries = [row for row in rows if len(row) == 3 and row[0] == 'real']
        need(len(entries) == 1 and entries[0][1], 'CREDENTIAL_LABEL_AMBIGUOUS')
        username, password, _ = entries[0]
        self.request('/api/auth/login', {'username': username, 'password': password})
        self.logged_in = True
        password = raw = match = rows = entries = None
        me = self.request('/api/auth/me')
        need(me['user']['id'] == UID and me['user']['username'] == 'real', 'AUTH_TENANT_MISMATCH')
        return self.status()

    def status(self, timeout=30):
        status = self.request('/api/dsh/status', timeout=timeout)
        if status.get('url'):
            self.tenant_host = urlparse(status['url']).hostname
            need(self.tenant_host == 'real.zj.meizu.life', 'AUTH_TENANT_HOST_MISMATCH')
        return status

    def rpc(self, method, request=None, args=None):
        envelope = {'type': 'client-request', 'rpcId': str(uuid.uuid4()), 'method': method,
                    'payload': {'args': args if args is not None else {'request': request}}}
        response = self.request('/api/' + method, envelope, tenant=True)
        result = response.get('result', {})
        need(result.get('ok') is True, 'RPC_REJECTED_' + method.replace('/', '_'))
        return result.get('value')

    def close(self):
        if self.logged_in:
            try:
                self.request('/api/auth/logout', {})
            finally:
                self.cookie = None


def listener(port):
    result = subprocess.run(['ss', '-ltnp', f'sport = :{int(port)}'], capture_output=True, text=True, check=True)
    return sorted(set(int(value) for value in re.findall(r'pid=(\d+)', result.stdout)))


def live(pid):
    try:
        return pathlib.Path(f'/proc/{int(pid)}/stat').read_text().split(') ', 1)[1][0] != 'Z'
    except FileNotFoundError:
        return False


def bound_instance(client, status=None):
    status = client.status() if status is None else status
    need(status.get('running') and status.get('instance'), 'TENANT_INSTANCE_NOT_RUNNING')
    instance = status['instance']
    pids = listener(instance['port'])
    need(len(pids) == 1, 'INSTANCE_LISTENER_AMBIGUOUS')
    need(pathlib.Path(os.readlink(f'/proc/{pids[0]}/cwd')).resolve() == (TENANT / 'ws').resolve(), 'INSTANCE_WORKSPACE_MISMATCH')
    return {'id': instance['id'], 'port': instance['port'], 'pid': pids[0], 'status': instance.get('status'), 'cwd': str(TENANT / 'ws')}


def transient_read_error(error, health=False):
    if isinstance(error, (OSError, urllib.error.URLError, http.client.HTTPException)):
        return True
    return isinstance(error, RuntimeError) and str(error) in ({'HTTP_500', 'HTTP_502', 'HTTP_503', 'HTTP_504'} | ({'HTTP_404'} if health else set()))


def wait_existing_instance(client, instance_id, old_pid, deadline):
    """Retry only read-only startup probes; never repeat stop or launch."""
    retries = []
    while time.monotonic() < deadline:
        stage = 'status'
        try:
            status = client.status(timeout=max(0.1, min(8, deadline - time.monotonic())))
            instance = status.get('instance') or {}
            need(instance.get('id') == instance_id, 'NEW_INSTANCE_IDENTITY_MISMATCH')
            need(instance.get('status') not in ('crashed', 'stopped'), 'NEW_INSTANCE_TERMINAL')
            if not status.get('running'):
                time.sleep(1)
                continue
            stage = 'health'
            need(time.monotonic() < deadline, 'PLUGIN_READY_TIMEOUT')
            state = client.request('/plugins/dsh-expert-library/state', tenant=True,
                                   timeout=max(0.1, min(8, deadline - time.monotonic())))
            health = {'pluginHttp': 200, 'topLevelFields': list(state) if isinstance(state, dict) else [], 'at': now()}
            stage = 'identity'
            new = bound_instance(client, status)
            need(new['pid'] != old_pid and not live(old_pid), 'OLD_PID_STILL_LIVE_OR_REUSED')
            return new, health, retries
        except Exception as error:
            if not transient_read_error(error, health=stage == 'health'):
                raise
            retries.append({'at': now(), 'stage': stage, 'errorCode': safe_error(error)})
            time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise RuntimeError('PLUGIN_READY_TIMEOUT')


def reload_tenant(client, prep, expected):
    checked = finalized_preparation()
    need(prep['sessionId'] == checked['sessionId'], 'PREPARATION_SCOPE_MISMATCH')
    prep = checked
    verify_previous_stopped(client, prep)
    gate = payload_gate(expected)
    path = EVIDENCE / 'production-reload.json'
    if path.exists():
        previous = load(path)
        need(previous.get('status') == 'PASS', 'RELOAD_ALREADY_ATTEMPTED_REQUIRES_MANUAL_RECONCILIATION')
        need(previous['payloadGate']['runtime']['sha256'] == expected and previous['instanceAfter']['id'] == bound_instance(client)['id'], 'SUCCESSFUL_RELOAD_INSTANCE_CHANGED')
        need(paused_snapshot() == previous['teamsAfter'], 'PAUSED_TEAMS_CHANGED')
        return {'status': 'already_reloaded', 'record': str(path), 'instance': previous['instanceAfter']}
    need(not (SAMPLE / 'run.json').exists(), 'REFUSE_RELOAD_AFTER_SESSION_CREATION')
    before = paused_snapshot()
    need(before == prep['pausedTeamsBaseline'], 'PAUSED_TASK_BASELINE_CHANGED')
    old = bound_instance(client)
    record = {'startedAt': now(), 'tenantId': UID, 'status': 'pending', 'payloadGate': gate,
              'instanceBefore': old, 'teamsBefore': before, 'events': []}

    def event(stage, **fields):
        record['events'].append({'at': now(), 'stage': stage, **fields})
        save(path, record)

    try:
        event('stop_pending')
        client.request('/api/dsh/stop', {})
        deadline = time.monotonic() + 20
        while live(old['pid']) or listener(old['port']):
            need(time.monotonic() < deadline, 'OLD_INSTANCE_DID_NOT_EXIT')
            time.sleep(0.5)
        event('old_instance_exited', oldPidGone=True, oldPortClosed=True)
        need(paused_snapshot() == before, 'PAUSED_TASKS_CHANGED_DURING_STOP')
        payload_gate(expected)
        event('launch_pending')
        launched = client.request('/api/dsh/launch', {'folder': ''})
        record['launchedInstanceId'] = launched['instance']['id']
        event('launch_accepted')
        new, record['health'], record['startupReadRetries'] = wait_existing_instance(
            client, record['launchedInstanceId'], old['pid'], time.monotonic() + 180)
        record['instanceAfter'] = new
        record['teamsAfter'] = paused_snapshot()
        need(record['teamsAfter'] == before, 'PAUSED_TASKS_CHANGED_AFTER_LAUNCH')
        record['payloadGateAfter'] = payload_gate(expected)
        record['status'] = 'PASS'
        event('healthy_and_seven_prior_team_states_preserved')
        return {'status': 'PASS', 'record': str(path), 'instance': new}
    except Exception as error:
        record['status'] = 'FAILED'
        record['errorCode'] = safe_error(error)
        event('failed_no_automatic_retry')
        raise


def reconcile_reload(client, prep, expected):
    """Reconcile only the recorded accepted launch, using read-only checks."""
    checked = finalized_preparation()
    need(prep['sessionId'] == checked['sessionId'], 'PREPARATION_SCOPE_MISMATCH')
    prep = checked
    verify_previous_stopped(client, prep)
    gate = payload_gate(expected)
    path = EVIDENCE / 'production-reload.json'
    original_bytes = path.read_bytes()
    record = json.loads(original_bytes)
    need(record.get('tenantId') == UID, 'RELOAD_RECORD_TENANT_MISMATCH')
    need(record['payloadGate']['runtime']['sha256'] == expected, 'RELOAD_RECORD_PAYLOAD_MISMATCH')
    launched_id = record.get('launchedInstanceId')
    need(isinstance(launched_id, str) and any(event.get('stage') == 'launch_accepted' for event in record.get('events', [])),
         'NO_RECORDED_ACCEPTED_LAUNCH_TO_RECONCILE')
    need(record['teamsBefore'] == prep['pausedTeamsBaseline'] and paused_snapshot() == record['teamsBefore'], 'PAUSED_TASK_BASELINE_CHANGED')
    old = record['instanceBefore']
    need(not live(old['pid']), 'OLD_PID_STILL_LIVE_OR_REUSED')
    new, health, retries = wait_existing_instance(client, launched_id, old['pid'], time.monotonic() + 180)
    teams_after = paused_snapshot()
    need(teams_after == record['teamsBefore'], 'PAUSED_TASKS_CHANGED_AFTER_LAUNCH')
    gate_after = payload_gate(expected)
    need(path.read_bytes() == original_bytes, 'RELOAD_RECORD_CHANGED_DURING_RECONCILIATION')
    if record.get('status') == 'PASS':
        need(all(record['instanceAfter'].get(key) == new[key] for key in ('id', 'pid', 'port', 'cwd')), 'SUCCESSFUL_RELOAD_INSTANCE_CHANGED')
        return {'status': 'already_reconciled', 'record': str(path), 'instance': new}
    record.setdefault('reconciliations', []).append({'at': now(), 'previousStatus': record.get('status'),
        'previousErrorCode': record.get('errorCode'), 'readOnly': True, 'startupReadRetries': retries,
        'payloadGate': gate, 'actions': ['status', 'plugin health', 'PID/cwd verification', 'seven prior team state hashes', 'payload hash']})
    # Preserve the original failure event and errorCode as historical evidence.
    record['instanceAfter'] = new
    record['health'] = health
    record['teamsAfter'] = teams_after
    record['payloadGateAfter'] = gate_after
    record['recoveredAt'] = now()
    record['status'] = 'PASS'
    record['events'].append({'at': now(), 'stage': 'recovered_existing_launch_verified', 'readOnly': True,
                             'stopOrLaunchRepeated': False, 'instanceId': new['id'], 'pid': new['pid']})
    save(path, record)
    return {'status': 'PASS', 'recovered': True, 'record': str(path), 'instance': new, 'stopOrLaunchRepeated': False}


def require_reloaded(client, expected):
    verify_previous_stopped(client, finalized_preparation())
    payload_gate(expected)
    record = load(EVIDENCE / 'production-reload.json')
    need(record.get('status') == 'PASS' and record['payloadGate']['runtime']['sha256'] == expected, 'PASSED_RELOAD_REQUIRED')
    current = bound_instance(client)
    need(current['id'] == record['instanceAfter']['id'] and current['pid'] == record['instanceAfter']['pid'], 'RELOADED_INSTANCE_CHANGED')
    need(paused_snapshot() == record['teamsAfter'], 'PAUSED_TEAM_TASKS_CHANGED')
    return current


def selected_settings(client):
    # This API is redacted by the Host. Retain only two non-secret namespaces.
    description = client.rpc('settings/describe', args={})
    defaults = [item for item in description['namespaces'] if item['ns'] == 'agent-default-model']
    need(len(defaults) == 1, 'DEFAULT_MODEL_NAMESPACE_MISSING')
    item = defaults[0]
    allowed = {'provider', 'model', 'reasoningEffort'}
    need(isinstance(item.get('value'), dict) and set(item['value']) <= allowed, 'DEFAULT_MODEL_SCHEMA_CHANGED')
    user = item.get('user')
    need('user' not in item or isinstance(user, dict) and set(user) <= allowed, 'DEFAULT_MODEL_USER_SCHEMA_CHANGED')
    need(type(item.get('revision')) is int and 0 <= item['revision'] <= 9007199254740991, 'DEFAULT_MODEL_REVISION_INVALID')
    snapshot = {'value': item['value'], 'userPresent': 'user' in item, 'user': user, 'revision': item['revision']}
    namespaces = [item for item in description['namespaces'] if item['ns'] == 'expert-library']
    value = namespaces[0].get('value', {}) if namespaces else {}
    cap = value.get('maxActiveMembers', 2)
    need(type(cap) is int and cap >= 1, 'ACTIVE_MEMBER_CAP_INVALID')
    config = {'maxActiveMembers': cap, 'source': 'expert-library resolved settings' if 'maxActiveMembers' in value else 'schema/default',
              'revision': namespaces[0].get('revision') if namespaces else None, 'readAt': now()}
    return snapshot, config


def same_default(left, right):
    return all(left[key] == right[key] for key in ('value', 'userPresent', 'user'))


def select_session_route(client, run, path):
    before, config = selected_settings(client)
    # Official unset(path=[]) persists {}, it cannot restore namespace absence.
    # Refuse before selecting rather than leave a new global override behind.
    need(before['userPresent'], 'DEFAULT_USER_LAYER_ABSENT_CANNOT_RESTORE_EXACTLY')
    run['schedulerConfig'] = config
    record = {'before': before, 'at': now(), 'status': 'selection_pending'}
    run['defaultModelPreservation'] = record
    save(path, run)
    selected = None
    try:
        receipt = client.rpc('session/selectModel', {'sessionId': run['sessionId'], 'provider': PROVIDER, 'model': MODEL})
        selected = receipt['selected']
        need(selected.get('provider') == PROVIDER and selected.get('model') == MODEL, 'MODEL_SELECTION_MISMATCH')
        run['modelReceipt'] = {'selected': selected}
    finally:
        after, _ = selected_settings(client)
        record['afterSelection'] = after
        save(path, run)
        if same_default(before, after):
            record['restore'] = 'not_required_values_unchanged'
        else:
            # Avoid overwriting a user edit concurrent with maintenance.
            need(after['revision'] == before['revision'] + 1, 'DEFAULT_MODEL_CONCURRENT_REVISION_CHANGE')
            need(after['value'].get('provider') == PROVIDER and after['value'].get('model') == MODEL,
                 'DEFAULT_MODEL_CONCURRENT_SELECTION_CHANGE')
            if selected is not None:
                need(after['user'] == selected, 'DEFAULT_MODEL_CONCURRENT_USER_CHANGE')
            args = {'ns': 'agent-default-model', 'expectedRevision': after['revision']}
            client.rpc('settings/replace', args={**args, 'section': before['user']})
            record['restore'] = 'official_CAS_original_user_layer'
        restored, _ = selected_settings(client)
        record['afterRestore'] = restored
        need(same_default(before, restored), 'DEFAULT_MODEL_RESTORE_MISMATCH')
        record['status'] = 'default_restored_or_unchanged'
        save(path, run)
    # Verify the Session's durable pending route, independently of the default.
    cache = TENANT / 'home/storages/session_projcache/sessions' / (run['sessionId'] + '.json')
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if cache.exists():
            rows = load(cache).get('record', {}).get('rows', {})
            row = rows.get('modelSelection') or {}
            route = (row.get('val') or {}).get('pending')
            if route == selected:
                record['sessionRouteVerified'] = {'source': 'exact session_projcache modelSelection.pending', 'seq': row.get('seq'), 'selection': route}
                record['status'] = 'PASS'
                save(path, run)
                return
        time.sleep(0.2)
    raise RuntimeError('SESSION_ROUTE_NOT_VERIFIED_AFTER_DEFAULT_RESTORE')


def create_session(client, prep, expected):
    instance = require_reloaded(client, expected)
    path = SAMPLE / 'run.json'
    if path.exists():
        run = load(path)
        need(run['sessionId'] == prep['sessionId'], 'RUN_IDENTITY_MISMATCH')
        need(run.get('status') in ('ready', 'running', 'start_pending'), 'CREATE_ALREADY_ATTEMPTED_REQUIRES_MANUAL_RECONCILIATION')
        return {'status': 'already_created', 'sessionId': run['sessionId'], 'runStatus': run['status']}
    need(not any((TENANT / 'home/sessions').glob('*/' + prep['sessionId'])), 'RESERVED_SESSION_ALREADY_EXISTS')
    defaults, _ = selected_settings(client)
    need(defaults['userPresent'], 'DEFAULT_USER_LAYER_ABSENT_CANNOT_RESTORE_EXACTLY')
    run = {**{k: prep[k] for k in ('tenantId', 'username', 'sessionId', 'cwd', 'title', 'teamName', 'agentPreset', 'promptRequestId', 'promptFile', 'promptSha256', 'modelControl', 'outputRelativePath')},
           'createdAt': now(), 'status': 'create_pending', 'instanceId': instance['id'], 'runtimeSha256': expected}
    save(path, run)
    sid = run['sessionId']
    run['createReceipt'] = client.rpc('session/create', {'sessionId': sid, 'cwd': str(CWD), 'agentPreset': 'zhijian'})
    need(run['createReceipt'].get('sessionId') == sid, 'CREATE_RECEIPT_ID_MISMATCH')
    save(path, run)
    run['renameReceipt'] = client.rpc('session/rename', {'sessionId': sid, 'title': prep['title']})
    select_session_route(client, run, path)
    permission = client.rpc('commands/execute', args={'agentId': sid, 'line': '/permission danger-full-access', 'submittedAttachments': []})
    need(permission.get('result', {}).get('kind') == 'success', 'SESSION_PERMISSION_REJECTED')
    run['permissionReceipt'] = {'commandId': permission.get('commandId'), 'kind': 'success', 'preset': 'danger-full-access'}
    run['status'] = 'ready'
    save(path, run)
    return {'status': 'ready', 'sessionId': sid, 'title': run['title'], 'provider': PROVIDER, 'model': MODEL}


def start_session(client, prep, expected):
    require_reloaded(client, expected)
    path = SAMPLE / 'run.json'
    run = load(path)
    need(run['sessionId'] == prep['sessionId'] and run['runtimeSha256'] == expected, 'RUN_IDENTITY_OR_PAYLOAD_MISMATCH')
    if run.get('status') == 'running':
        return {'status': 'already_started', 'sessionId': run['sessionId']}
    need(run.get('status') == 'ready', 'START_ALREADY_ATTEMPTED_OR_NOT_READY_REQUIRES_MANUAL_RECONCILIATION')
    prompt = (SAMPLE / 'prompt.txt').read_text(encoding='utf-8')
    need(sha(prompt.encode()) == run['promptSha256'], 'RUN_PROMPT_CHANGED')
    # Persist before sending. An interrupted/ambiguous request cannot be resent
    # automatically, even though the same Host requestId is retained for audit.
    run['status'] = 'start_pending'
    run['startedAt'] = now()
    save(path, run)
    receipt = client.rpc('session/prompt', {'sessionId': run['sessionId'], 'requestId': run['promptRequestId'], 'mode': 'queue',
                         'content': [{'type': 'text', 'text': prompt}], 'clientTimeZone': 'Asia/Shanghai'})
    need(receipt.get('accepted') is True, 'PROMPT_NOT_ACCEPTED')
    run['promptReceipt'] = {'accepted': True}
    run['status'] = 'running'
    save(path, run)
    return {'status': 'running', 'sessionId': run['sessionId'], 'runFile': str(path)}


def safe_error(error):
    # Never serialize raw HTTP bodies, request objects, cookie jars or credentials.
    message = str(error)
    return message if re.fullmatch(r'[A-Z0-9_]+', message) else type(error).__name__


def extend_observer(base, sid):
    replacements = (
        (f'RUN_FILE = pathlib.Path({str(PREVIOUS_SAMPLE / "run.json")!r})',
         f'RUN_FILE = pathlib.Path({str(SAMPLE / "run.json")!r})'),
        (f'EXPECTED_CAPTAIN = {OLD_CAPTAIN!r}', f'EXPECTED_CAPTAIN = {sid!r}'),
        ("cwd / 'work/cgz-swap-rerun5-20261003'", f'cwd / {OUTPUT_REL!r}'),
    )
    for old, new in replacements:
        need(base.count(old) == 1, 'OBSERVER_BASE_LAYOUT_CHANGED')
        base = base.replace(old, new, 1)
    need(str(PREVIOUS_SAMPLE) not in base and OLD_CAPTAIN not in base, 'OBSERVER_OLD_RUN_BINDING_RETAINED')
    compile(base, str(SAMPLE / 'observe.py'), 'exec')
    return base


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'finalize-baseline', 'gate', 'preflight', 'reload', 'reconcile-reload', 'create', 'start', 'observe'))
    parser.add_argument('--expected-runtime-sha256')
    parser.add_argument('--previous-final-evidence')
    opts = parser.parse_args()
    SAMPLE.mkdir(parents=True, exist_ok=True)
    with (SAMPLE / '.actions.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if opts.action == 'prepare':
            result = prepare()
        elif opts.action == 'finalize-baseline':
            result = finalize_baseline(opts.previous_final_evidence)
        else:
            prep = preparation()
            if opts.action == 'observe':
                return subprocess.call([sys.executable, str(SAMPLE / 'observe.py')])
            gate = payload_gate(opts.expected_runtime_sha256)
            if opts.action == 'gate':
                result = gate
            else:
                prep = finalized_preparation()
                client = Client()
                try:
                    client.login()
                    if opts.action == 'preflight':
                        previous_stopped = verify_previous_stopped(client, prep)
                        defaults, scheduler_config = selected_settings(client)
                        result = {'checkedAt': now(), 'tenantId': UID, 'instance': bound_instance(client),
                                  'payloadGate': gate, 'pausedTeams': paused_snapshot(), 'noModelCalls': True,
                                  'previousRunStopped': previous_stopped,
                                  'defaultModelBefore': defaults, 'schedulerConfig': scheduler_config,
                                  'defaultUserLayerPresent': defaults['userPresent'], 'createAdmissible': defaults['userPresent']}
                        save(SAMPLE / 'preflight.json', result)
                    elif opts.action == 'reload':
                        result = reload_tenant(client, prep, opts.expected_runtime_sha256)
                    elif opts.action == 'reconcile-reload':
                        result = reconcile_reload(client, prep, opts.expected_runtime_sha256)
                    elif opts.action == 'create':
                        result = create_session(client, prep, opts.expected_runtime_sha256)
                    else:
                        result = start_session(client, prep, opts.expected_runtime_sha256)
                finally:
                    client.close()
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'ERROR', 'code': safe_error(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
