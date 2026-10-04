#!/usr/bin/env python3
"""Seal read-only lifecycle completion proof for the exact round8 session.

No model messages, resumes, cancellations or task mutations. `check` is offline;
`seal` reads formal live metadata and writes only local QA evidence.
"""
import argparse
import importlib.util
import json
import pathlib
import sys

sys.dont_write_bytecode = True
ROOT = pathlib.Path('/root/zhijian/dsh-expert-library')
spec = importlib.util.spec_from_file_location('round8_completion_binding', ROOT / 'scripts/qa/round8-pause-owned-run.py')
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)
m = binding.m


def completed_team():
    path, team = binding.exact_team()
    m.need(team is not None and bool(team.get('tasks')), 'COMPLETION_TEAM_MISSING')
    m.need(all(task.get('status') == 'completed' for task in team['tasks']), 'TASKS_NOT_COMPLETE')
    runs = team.get('qualityRuns', {})
    m.need(all(runs.get(task['id'], {}).get('status') == 'integrated' for task in team['tasks']), 'QUALITY_NOT_INTEGRATED')
    return path, team


def seal():
    run, created_ms, identity = binding.validate_binding()
    path, team = completed_team()
    previous = m.finalized_preparation()
    client = m.Client()
    try:
        client.login()
        instance = m.bound_instance(client)
        m.need(instance['id'] == run['instanceId'], 'RUN_HOST_INSTANCE_CHANGED')
        m.need(not binding.captain_running(client), 'CAPTAIN_STILL_RUNNING')
        children, diagnostics = binding.owned_children(client, created_ms)
        m.need(diagnostics == [], 'OWNERSHIP_DIAGNOSTICS_UNRESOLVED')
        m.need(all(child['running'] is False for child in children.values()), 'CHILD_STILL_RUNNING')
        goal = client.rpc('goals/get', args={'agentId': binding.EXPECTED_SID})
        m.need(goal is not None and goal.get('phase') == 'complete', 'GOAL_NOT_COMPLETE')
        _, final_team = completed_team()
        m.need(final_team == team, 'TEAM_CHANGED_DURING_COMPLETION_CHECK')
        m.need(m.paused_snapshot() == previous['pausedTeamsBaseline'], 'PRIOR_TEAM_BASELINE_CHANGED')
        receipt = {
            'status': 'completed', 'tenantId': m.UID,
            'sessionId': binding.EXPECTED_SID, 'finishedAt': m.now(),
            'startedAt': run['startedAt'], 'goalPhase': goal['phase'],
            'binding': identity, 'instanceId': instance['id'],
            'teams': [{'path': str(path), 'id': team['id']}],
            'finalSessions': [{'sessionId': binding.EXPECTED_SID, 'running': False}, *children.values()],
            'diagnostics': [], 'taskCount': len(team['tasks']),
            'allTasksCompletedAndIntegrated': True,
            'productionMutations': 0,
            'scope': 'Formal lifecycle completion only. Independent artifact/content acceptance remains separately required.',
        }
        target = m.SAMPLE / 'completion-receipt.json'
        m.need(not target.exists(), 'COMPLETION_RECEIPT_ALREADY_EXISTS')
        m.save(target, receipt)
        run['status'] = 'completed'
        run['completedAt'] = receipt['finishedAt']
        run['actualTeamId'] = team['id']
        m.save(m.SAMPLE / 'run.json', run)
        return {'status': 'completed', 'receipt': str(target), 'sessionId': binding.EXPECTED_SID, 'taskCount': len(team['tasks'])}
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('check', 'seal'))
    args = parser.parse_args()
    if args.action == 'check':
        binding.validate_binding()
        path, team = completed_team()
        result = {'status': 'ready_for_formal_read_only_check', 'team': team['id'], 'path': str(path), 'networkCalls': 0}
    else:
        result = seal()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'ERROR', 'code': m.safe_error(error)}))
        raise SystemExit(1)
