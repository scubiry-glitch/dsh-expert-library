#!/usr/bin/env python3
"""Seal lifecycle completion for the explicitly bound round9 run, read-only.

No action on import. `check` is local/offline. `seal` requires the exact session
argument, reads formal Host metadata twice, and writes only local QA evidence.
Neither operation certifies artifact/content acceptance or all report craft gates.
"""
import argparse
import datetime as dt
import fcntl
import importlib.util
import json
import pathlib
import re
import sys

sys.dont_write_bytecode = True
ROOT = pathlib.Path('/root/zhijian/dsh-expert-library')
spec = importlib.util.spec_from_file_location('round9_completion_binding', ROOT / 'scripts/qa/round9-pause-owned-run.py')
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)
m = binding.m


def timestamp(value):
    m.need(isinstance(value, str), 'INVALID_RUN_TIME')
    parsed = dt.datetime.fromisoformat(value)
    m.need(parsed.tzinfo is not None, 'RUN_TIME_TIMEZONE_REQUIRED')
    return parsed.timestamp() * 1000


def completed_team():
    path, team = binding.exact_team()
    m.need(isinstance(team, dict) and isinstance(team.get('tasks'), list) and bool(team['tasks']), 'COMPLETION_TEAM_MISSING')
    ids = [task.get('id') for task in team['tasks']]
    m.need(all(isinstance(item, str) and item for item in ids) and len(ids) == len(set(ids)), 'TASK_IDENTITY_INVALID')
    m.need(all(task.get('status') == 'completed' for task in team['tasks']), 'TASKS_NOT_COMPLETE')
    runs = team.get('qualityRuns') or {}
    m.need(all(runs.get(task_id, {}).get('status') == 'integrated'
               and runs[task_id].get('contract', {}).get('taskId') == task_id for task_id in ids), 'QUALITY_NOT_INTEGRATED')
    members = team.get('members')
    m.need(isinstance(members, list), 'TEAM_MEMBERS_MISSING')
    member_ids = [member.get('id') for member in members]
    m.need(all(isinstance(sid, str) and re.fullmatch(r'[A-Za-z0-9_.-]+', sid) for sid in member_ids)
           and len(member_ids) == len(set(member_ids)) and binding.EXPECTED_SID not in member_ids, 'MEMBER_IDENTITY_INVALID')
    return path, team


def offline_snapshot():
    """Validate local identity evidence before constructing any network client."""
    run, created_ms, identity = binding.validate_binding()
    m.need(run.get('createReceipt', {}).get('sessionId') == binding.EXPECTED_SID
           and run.get('promptReceipt', {}).get('accepted') is True, 'RUN_NOT_FORMALLY_ACCEPTED')
    started_ms = timestamp(run['startedAt'])
    header = identity['captainHeader']
    current_ms = timestamp(m.now())
    m.need(created_ms <= header['createdAt'] <= started_ms <= current_ms, 'CAPTAIN_HEADER_RUN_TIME_MISMATCH')
    m.need(isinstance(run.get('runtimeSha256'), str) and re.fullmatch(r'[a-f0-9]{64}', run['runtimeSha256']), 'RUN_RUNTIME_MISSING')
    path, team = completed_team()
    observed = m.load(m.SAMPLE / 'owned-team-binding.json')
    m.need(observed.get('captainHeader') == header, 'OBSERVED_CAPTAIN_HEADER_CHANGED')
    m.need(observed.get('productionMutations') == 0
           and team['createdAt'] <= timestamp(observed['boundAt']) <= current_ms, 'OBSERVED_TEAM_BINDING_INVALID')
    baseline = m.finalized_preparation()['pausedTeamsBaseline']
    m.need(len(baseline) == 10 and len({row['path'] for row in baseline}) == 10, 'PRIOR_TEN_BASELINE_REQUIRED')
    reload = m.load(m.EVIDENCE / 'production-reload.json')
    m.need(reload.get('status') == 'PASS' and reload.get('tenantId') == m.UID, 'PASSED_RELOAD_REQUIRED')
    runtime = m.runtime_identity()
    m.need(reload.get('payloadGate', {}).get('runtime') == runtime
           and runtime['sha256'] == run['runtimeSha256'], 'COMPLETION_RUNTIME_CHANGED')
    instance = reload.get('instanceAfter') or {}
    m.need(instance.get('id') == run.get('instanceId') and isinstance(instance.get('id'), str)
           and type(instance.get('pid')) is int and type(instance.get('port')) is int
           and instance.get('cwd') == str(m.TENANT / 'ws'), 'RUN_RELOAD_INSTANCE_MISMATCH')
    m.need(reload.get('teamsAfter') == baseline and m.paused_snapshot() == baseline, 'PRIOR_TEN_TEAM_BASELINE_CHANGED')
    return {'run': run, 'createdMs': created_ms, 'binding': identity, 'observedTeamBinding': observed,
            'teamPath': str(path), 'team': team, 'baseline': baseline, 'runtime': runtime,
            'instance': {key: instance[key] for key in ('id', 'pid', 'port', 'cwd')}}


def live_snapshot(client, local):
    instance = m.bound_instance(client)
    m.need(all(instance.get(key) == value for key, value in local['instance'].items()), 'RUN_HOST_INSTANCE_CHANGED')
    m.need(binding.captain_running(client) is False, 'CAPTAIN_STILL_RUNNING')
    children, queue, seen = {}, [binding.EXPECTED_SID], {binding.EXPECTED_SID}
    while queue:
        parent = queue.pop(0)
        catalog = client.rpc('subagents/list', args={'parentSessionId': parent})
        m.need(isinstance(catalog, dict) and isinstance(catalog.get('entries'), list), 'CHILD_CATALOG_UNAVAILABLE')
        for entry in catalog['entries']:
            m.need(isinstance(entry, dict) and entry.get('kind') == 'child', 'OWNERSHIP_DIAGNOSTICS_UNRESOLVED')
            sid = entry.get('id')
            m.need(isinstance(sid, str) and sid not in seen, 'DUPLICATE_OR_CYCLIC_CHILD_IDENTITY')
            header = binding.session_header(sid, local['createdMs'], parent)
            m.need(header['createdAt'] <= timestamp(m.now()), 'CHILD_HEADER_IN_FUTURE')
            m.need(entry.get('mode') in ('continuable', 'one-shot'), 'UNSUPPORTED_CHILD_MODE')
            m.need(entry.get('activity') == 'inactive', 'CHILD_RUNNING_OR_UNKNOWN')
            children[sid] = {'sessionId': sid, 'parentSessionId': parent, 'mode': entry['mode'],
                             'running': False, 'header': header}
            seen.add(sid)
            queue.append(sid)
            m.need(len(seen) <= 128, 'OWNED_TREE_LIMIT_EXCEEDED')
    for member in local['team']['members']:
        child = children.get(member['id'])
        m.need(child is not None and child['parentSessionId'] == binding.EXPECTED_SID, 'MEMBER_STOP_PROOF_MISSING')
    goal = client.rpc('goals/get', args={'agentId': binding.EXPECTED_SID})
    m.need(isinstance(goal, dict) and goal.get('phase') == 'complete', 'GOAL_NOT_COMPLETE')
    m.need(isinstance(goal.get('id'), str) and goal['id'] and type(goal.get('revision')) is int
           and goal['revision'] >= 1, 'GOAL_IDENTITY_MISSING')
    return {'instance': local['instance'], 'sessions': [
        {'sessionId': binding.EXPECTED_SID, 'running': False, 'header': local['binding']['captainHeader']},
        *[children[sid] for sid in sorted(children)],
    ], 'goal': {key: goal[key] for key in ('id', 'revision', 'phase')}}


def seal(client_factory=None):
    """Call only on explicit operator action; tests inject a network-free fake."""
    with (m.SAMPLE / '.actions.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        target = m.SAMPLE / 'completion-receipt.json'
        m.need(not target.exists(), 'COMPLETION_RECEIPT_ALREADY_EXISTS')
        local = offline_snapshot()
        client = (m.Client if client_factory is None else client_factory)()
        try:
            client.login()
            first = live_snapshot(client, local)
            m.need(offline_snapshot() == local, 'LOCAL_BINDING_CHANGED_DURING_COMPLETION_CHECK')
            second = live_snapshot(client, local)
            m.need(second == first, 'LIVE_STATE_CHANGED_DURING_COMPLETION_CHECK')
            m.need(offline_snapshot() == local, 'LOCAL_BINDING_CHANGED_DURING_COMPLETION_CHECK')
            finished = m.now()
            receipt = {
                'status': 'completed', 'tenantId': m.UID, 'sessionId': binding.EXPECTED_SID,
                'finishedAt': finished, 'startedAt': local['run']['startedAt'], 'goalPhase': 'complete',
                'goal': first['goal'], 'binding': local['binding'],
                'observedTeamBinding': local['observedTeamBinding'],
                'instanceId': first['instance']['id'], 'instance': first['instance'], 'runtime': local['runtime'],
                'teams': [{'path': local['teamPath'], 'id': local['team']['id']}],
                'finalSessions': first['sessions'], 'diagnostics': [], 'taskCount': len(local['team']['tasks']),
                'allTasksCompletedAndIntegrated': True, 'priorTenTeamsBaselineUnchanged': True,
                'productionMutations': 0, 'stableReadPasses': 2, 'artifactAcceptanceVerified': False,
                'scope': 'Point-in-time formal lifecycle completion only. Artifact/content acceptance and full report craft compliance require separate evidence; registered report checks cover a subset only.',
            }
            m.need(not target.exists(), 'COMPLETION_RECEIPT_ALREADY_EXISTS')
            m.save(target, receipt)
            run = {**local['run'], 'status': 'completed', 'completedAt': finished,
                   'actualTeamId': local['team']['id'], 'completionEvidence': str(target)}
            m.save(m.SAMPLE / 'run.json', run)
            return {'status': 'completed', 'receipt': str(target), 'sessionId': binding.EXPECTED_SID,
                    'taskCount': receipt['taskCount'], 'artifactAcceptanceVerified': False}
        finally:
            client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('check', 'seal'))
    parser.add_argument('--expected-session-id')
    args = parser.parse_args()
    if args.action == 'check':
        local = offline_snapshot()
        result = {'status': 'ready_for_formal_read_only_check', 'team': local['team']['id'],
                  'path': local['teamPath'], 'networkCalls': 0, 'artifactAcceptanceVerified': False}
    else:
        m.need(args.expected_session_id == binding.EXPECTED_SID, 'EXPLICIT_EXPECTED_SESSION_REQUIRED')
        result = seal()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'ERROR', 'code': m.safe_error(error)}), file=sys.stderr)
        raise SystemExit(1)
