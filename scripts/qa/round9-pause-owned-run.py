#!/usr/bin/env python3
"""Check offline, or explicitly pause only the bound round9 real-tenant run.

No action on import. `check` performs no network calls. `pause` requires an
explicit expected session id and reason. Uses formal APIs; never edits teams,
inboxes, goals or session logs directly. Credentials remain in controller memory.
"""
import argparse
import datetime as dt
import fcntl
import importlib.util
import json
import pathlib
import re
import sys
import time

sys.dont_write_bytecode = True
REPO = pathlib.Path('/root/zhijian/dsh-expert-library')
EXPECTED_SID = 'session-cbf2a33a-2a34-400c-b6a9-fc0b809d4d8b'
EXPECTED_UID = '54485b72-c5b9-4fbd-be13-bc0c2c82e0a5'
REQUESTED_TEAM = '车公庄置换重跑9-20261003-809d4d8b'
# Requested label is not proof of the model's actual team identity.
EXPECTED_TEAM = REQUESTED_TEAM


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


m = module('round9_pause_controller', REPO / 'scripts/qa/round9-real-rerun.py')
observer = module('round9_pause_metadata', m.SAMPLE / 'observe.py')


def session_header(sid, created_ms, parent=None):
    m.need(isinstance(sid, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', sid), 'INVALID_SESSION_ID')
    paths = observer.log_paths(m.TENANT / 'home', sid)
    m.need(len(paths) == 1, 'SESSION_LOG_MISSING_OR_AMBIGUOUS')
    value = observer.read_log_header(paths[0])
    m.need(value.get('type') == 'session' and value.get('id') == sid, 'SESSION_HEADER_ID_MISMATCH')
    m.need(isinstance(value.get('createdAt'), (int, float)) and value['createdAt'] >= created_ms, 'SESSION_PREDATES_RUN')
    m.need(value.get('parentSession') == parent, 'SESSION_PARENT_MISMATCH')
    if parent is None:
        m.need(value.get('cwd') == str(m.CWD), 'CAPTAIN_HEADER_CWD_MISMATCH')
    return {key: value.get(key) for key in ('id', 'createdAt', 'parentSession', 'cwd')}


def owned_team_paths():
    """Inspect only captain ownership on other teams; retain bodies only for this run."""
    paths = sorted((m.CWD / 'expert-teams').glob('*/team.json'))
    m.need(len(paths) <= 256, 'TEAM_METADATA_SCAN_LIMIT_EXCEEDED')
    return [path for path in paths if m.load(path).get('captainSessionId') == EXPECTED_SID]


def checked_team(path, run):
    path = pathlib.Path(path).resolve()
    root = (m.CWD / 'expert-teams').resolve()
    m.need(path.name == 'team.json' and path.parent.parent == root, 'TEAM_PATH_ESCAPES_WORKSPACE')
    team = m.load(path)
    m.need(team.get('captainSessionId') == EXPECTED_SID
           and team.get('id') == team.get('name') == path.parent.name, 'EXACT_TEAM_IDENTITY_MISMATCH')
    started_ms = dt.datetime.fromisoformat(run['startedAt']).timestamp() * 1000
    created = team.get('createdAt')
    m.need(type(created) is int and started_ms <= created <= time.time() * 1000, 'TEAM_PREDATES_RUN_OR_INVALID_TIME')
    return path, team


def bind_team(path):
    """Offline, explicit binding after a real team exists; never rewrites requested labels."""
    prep = validate_prepared_binding()
    run = m.load(m.SAMPLE / 'run.json')
    m.need(run.get('sessionId') == EXPECTED_SID and run.get('tenantId') == EXPECTED_UID
           and run.get('cwd') == str(m.CWD) and run.get('teamName') == REQUESTED_TEAM,
           'RUN_IDENTITY_MISMATCH')
    m.need(run.get('status') in ('running', 'paused_for_next_optimization'), 'RUN_NOT_STARTED')
    created_ms = dt.datetime.fromisoformat(run['createdAt']).timestamp() * 1000
    header = session_header(EXPECTED_SID, created_ms)
    path, team = checked_team(path, run)
    m.need([str(p.resolve()) for p in owned_team_paths()] == [str(path)], 'OWNED_TEAM_MISSING_OR_AMBIGUOUS')
    proof = {'tenantId': EXPECTED_UID, 'sessionId': EXPECTED_SID,
             'requestedTeamName': prep['teamName'], 'teamPath': str(path),
             'teamId': team['id'], 'teamName': team['name'], 'teamCreatedAt': team['createdAt'],
             'runStartedAt': run['startedAt'], 'captainHeader': header}
    target = m.SAMPLE / 'owned-team-binding.json'
    if target.exists():
        existing = m.load(target)
        m.need(all(existing.get(k) == v for k, v in proof.items()), 'OWNED_TEAM_BINDING_CANNOT_BE_REPLACED')
        return {'status': 'already_bound', 'teamId': team['id'], 'path': str(target), 'productionMutations': 0}
    m.save(target, {**proof, 'boundAt': m.now(), 'productionMutations': 0})
    return {'status': 'bound_offline', 'teamId': team['id'], 'path': str(target), 'productionMutations': 0}


def exact_team():
    target = m.SAMPLE / 'owned-team-binding.json'
    owned = owned_team_paths()
    if not target.exists():
        m.need(not owned, 'ACTUAL_TEAM_BINDING_REQUIRED_BEFORE_PAUSE')
        return m.CWD / 'expert-teams' / REQUESTED_TEAM / 'team.json', None
    binding = m.load(target)
    m.need(binding.get('tenantId') == EXPECTED_UID and binding.get('sessionId') == EXPECTED_SID
           and binding.get('requestedTeamName') == REQUESTED_TEAM, 'OWNED_TEAM_BINDING_IDENTITY_MISMATCH')
    run = m.load(m.SAMPLE / 'run.json')
    m.need(binding.get('runStartedAt') == run.get('startedAt'), 'OWNED_TEAM_BINDING_START_TIME_CHANGED')
    path, team = checked_team(binding['teamPath'], run)
    m.need([str(p.resolve()) for p in owned] == [str(path)], 'OWNED_TEAM_MISSING_OR_AMBIGUOUS')
    m.need(team.get('id') == binding.get('teamId') and team.get('name') == binding.get('teamName')
           and team.get('createdAt') == binding.get('teamCreatedAt'), 'BOUND_TEAM_IDENTITY_CHANGED')
    return path, team


def validate_prepared_binding():
    prep = m.preparation()
    m.need(m.UID == EXPECTED_UID and prep['tenantId'] == EXPECTED_UID, 'PREPARATION_UID_MISMATCH')
    m.need(prep['sessionId'] == EXPECTED_SID and prep['teamName'] == REQUESTED_TEAM, 'PREPARATION_IDENTITY_MISMATCH')
    m.need(prep['cwd'] == str(m.CWD), 'PREPARATION_WORKSPACE_MISMATCH')
    return prep


def validate_binding():
    prep = validate_prepared_binding()
    m.need((m.SAMPLE / 'run.json').exists(), 'RUN_NOT_CREATED')
    run = m.load(m.SAMPLE / 'run.json')
    m.need(m.UID == EXPECTED_UID and prep['tenantId'] == run.get('tenantId') == EXPECTED_UID, 'RUN_UID_MISMATCH')
    m.need(prep['sessionId'] == run.get('sessionId') == EXPECTED_SID, 'RUN_SESSION_MISMATCH')
    m.need(prep['teamName'] == run.get('teamName') == REQUESTED_TEAM, 'RUN_TEAM_MISMATCH')
    m.need(run.get('username') == 'real' and prep['cwd'] == run.get('cwd') == str(m.CWD), 'RUN_WORKSPACE_MISMATCH')
    m.need(run.get('status') in ('running', 'paused_for_next_optimization'), 'RUN_NOT_STARTED')
    created_ms = dt.datetime.fromisoformat(run['createdAt']).timestamp() * 1000
    header = session_header(EXPECTED_SID, created_ms)
    path, team = exact_team()
    return run, created_ms, {'tenantId': EXPECTED_UID, 'sessionId': EXPECTED_SID, 'captainHeader': header,
        'teamPath': str(path), 'teamId': team['id'] if team else None, 'teamPresent': team is not None}


def owned_children(client, created_ms):
    """Only formal parent catalogs, cross-checked against each child's header."""
    children, diagnostics, queue, seen = {}, [], [EXPECTED_SID], {EXPECTED_SID}
    while queue:
        parent = queue.pop(0)
        catalog = client.rpc('subagents/list', args={'parentSessionId': parent})
        for entry in catalog['entries']:
            sid = entry.get('id')
            if entry.get('kind') != 'child':
                diagnostics.append({'parentSessionId': parent, 'sessionId': sid, 'reason': entry.get('reason')})
                continue
            m.need(sid not in seen, 'DUPLICATE_OR_CYCLIC_CHILD_IDENTITY')
            session_header(sid, created_ms, parent)
            m.need(entry.get('mode') in ('continuable', 'one-shot'), 'UNSUPPORTED_CHILD_MODE')
            children[sid] = {'sessionId': sid, 'parentSessionId': parent, 'mode': entry['mode'], 'running': entry.get('activity') == 'running'}
            seen.add(sid)
            queue.append(sid)
            m.need(len(seen) <= 128, 'OWNED_TREE_LIMIT_EXCEEDED')
    path, team = exact_team()
    if team:
        for member in team.get('members', []):
            sid = member['id']
            session_header(sid, created_ms, EXPECTED_SID)
            if sid not in children:
                diagnostics.append({'sessionId': sid, 'reason': 'team member absent from formal child catalog'})
            else:
                m.need(children[sid]['parentSessionId'] == EXPECTED_SID, 'MEMBER_NOT_DIRECT_CHILD')
    return children, diagnostics


def captain_running(client):
    rows = client.rpc('session/list', args={'_request': {}})['items']
    rows = [row for row in rows if row.get('sessionId') == EXPECTED_SID]
    m.need(len(rows) == 1 and isinstance(rows[0].get('running'), bool), 'CAPTAIN_LIVE_STATE_UNAVAILABLE')
    return rows[0]['running']


def pause(client, reason):
    run, created_ms, binding = validate_binding()
    instance = m.bound_instance(client)
    m.need(instance['id'] == run['instanceId'], 'RUN_HOST_INSTANCE_CHANGED')
    # Validate all initially discoverable child identities before any mutation.
    owned_children(client, created_ms)
    path = m.SAMPLE / 'pause-for-next-iteration.json'
    record = m.load(path) if path.exists() else {'sessionId': EXPECTED_SID, 'tenantId': EXPECTED_UID, 'events': []}
    m.need(record['sessionId'] == EXPECTED_SID and record['tenantId'] == EXPECTED_UID, 'PAUSE_RECORD_IDENTITY_MISMATCH')
    record.update({'startedAt': m.now(), 'reason': reason, 'status': 'pausing', 'binding': binding})
    failures = []

    def event(stage, **fields):
        record['events'].append({'at': m.now(), 'stage': stage, **fields})
        m.save(path, record)

    def attempt(stage, action, **fields):
        try:
            result = action()
            event(stage, **fields)
            return result
        except Exception as error:
            failures.append({'stage': stage, 'code': m.safe_error(error)})
            event(stage + '_failed', **fields, code=m.safe_error(error))
            return None

    def pause_goal():
        goal = client.rpc('goals/get', args={'agentId': EXPECTED_SID})
        if goal and goal.get('phase') == 'active':
            result = client.rpc('goals/pause', args={'agentId': EXPECTED_SID, 'ref': {'id': goal['id'], 'revision': goal['revision']}})
            m.need(result.get('phase') == 'paused', 'GOAL_PAUSE_NOT_CONFIRMED')

    def halt_team():
        team_path, team = exact_team()
        if team and not team.get('halted'):
            client.request('/plugins/dsh-expert-library/teams', {'action': 'halt', 'captainSessionId': EXPECTED_SID,
                'teamId': team['id'], 'reason': reason}, tenant=True)
            m.need(exact_team()[1].get('halted') is True, 'TEAM_HALT_NOT_CONFIRMED')

    event('pause_requested', instanceId=instance['id'], pid=instance['pid'])
    attempt('goal_paused_or_inactive', pause_goal)
    attempt('team_halted_or_absent', halt_team)
    attempt('captain_cancel_requested', lambda: client.rpc('session/cancel', {'sessionId': EXPECTED_SID}))
    deadline = time.monotonic() + 25
    interrupted, stable = set(), 0
    final_children, diagnostics, running = {}, [], True
    while time.monotonic() < deadline:
        # Capture a team/child admitted by an in-flight tool before cancellation.
        attempt('team_halt_rechecked', halt_team)
        final_children, diagnostics = owned_children(client, created_ms)
        for sid, child in reversed(list(final_children.items())):
            if child['mode'] == 'continuable' and sid not in interrupted:
                receipt = attempt('child_interrupt_requested', lambda child=child: client.rpc('subagents/interruptByParent',
                    args={'childSessionId': child['sessionId'], 'parentSessionId': child['parentSessionId'], 'mode': 'continuable'}), childSessionId=sid)
                if receipt and receipt.get('accepted') is True:
                    interrupted.add(sid)
        attempt('captain_final_cancel', lambda: client.rpc('session/cancel', {'sessionId': EXPECTED_SID}))
        running = captain_running(client)
        final_children, diagnostics = owned_children(client, created_ms)
        quiet = not running and not any(row['running'] for row in final_children.values()) and not diagnostics
        stable = stable + 1 if quiet else 0
        if stable >= 2:
            break
        time.sleep(0.5)
    goal = client.rpc('goals/get', args={'agentId': EXPECTED_SID})
    team_path, team = exact_team()
    success = stable >= 2 and (not goal or goal.get('phase') != 'active') and (team is None or team.get('halted') is True)
    record.update({'finishedAt': m.now(), 'status': 'paused' if success else 'requires_followup', 'errors': failures,
        'goalPhase': goal.get('phase') if goal else None, 'teams': [{'path': str(team_path), 'id': team['id']}] if team else [],
        'finalSessions': [{'sessionId': EXPECTED_SID, 'running': running}, *final_children.values()], 'diagnostics': diagnostics,
        'oneShotPolicy': 'No direct one-shot interrupt API: parent cancellation followed by live-state verification; active remnants require follow-up.'})
    m.save(path, record)
    if success:
        current = m.load(m.SAMPLE / 'run.json')
        m.need(current['sessionId'] == EXPECTED_SID, 'RUN_CHANGED_DURING_PAUSE')
        current['status'] = 'paused_for_next_optimization'
        current['pauseEvidence'] = str(path)
        m.save(m.SAMPLE / 'run.json', current)
    return {'status': record['status'], 'sessionId': EXPECTED_SID, 'teamCount': len(record['teams']), 'sessions': record['finalSessions'], 'record': str(path)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('check', 'bind-team', 'pause'))
    parser.add_argument('--expected-session-id')
    parser.add_argument('--reason')
    parser.add_argument('--team-path')
    args = parser.parse_args()
    if args.action == 'check':
        prep = validate_prepared_binding()
        if not (m.SAMPLE / 'run.json').exists():
            print(json.dumps({'status': 'prepared_not_created', 'sessionId': EXPECTED_SID,
                'tenantId': EXPECTED_UID, 'teamId': EXPECTED_TEAM, 'productionMutations': 0,
                'runtimeBindingValidated': False, 'note': 'Reserved identity only; pause requires an actual started run and matching session header.'}, ensure_ascii=False))
            return 0
        print(json.dumps({'status': 'checked_offline', **validate_binding()[2], 'productionMutations': 0}, ensure_ascii=False))
        return 0
    m.need(args.expected_session_id == EXPECTED_SID, 'EXPLICIT_EXPECTED_SESSION_REQUIRED')
    if args.action == 'bind-team':
        m.need(isinstance(args.team_path, str) and bool(args.team_path), 'EXPLICIT_TEAM_PATH_REQUIRED')
        with (m.SAMPLE / '.actions.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(bind_team(args.team_path), ensure_ascii=False))
        return 0
    m.need(isinstance(args.reason, str) and 1 <= len(args.reason.strip()) <= 500, 'EXPLICIT_REASON_REQUIRED')
    with (m.SAMPLE / '.actions.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        validate_binding()
        client = m.Client()
        try:
            client.login()
            result = pause(client, args.reason.strip())
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result['status'] == 'paused' else 2
        finally:
            client.close()


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'ERROR', 'code': m.safe_error(error)}), file=sys.stderr)
        sys.exit(1)
