#!/usr/bin/env python3
"""Only temporary fixtures and FakeClient; never construct a production Client."""
import contextlib
import copy
import datetime as dt
import fcntl
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import urllib.request
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = pathlib.Path('/root/zhijian/dsh-expert-library')
OUT = ROOT / 'docs/evidence/team-reliability-round9-20261003/completion-offline-guards.json'


def main():
    spec = importlib.util.spec_from_file_location('round9_completion_guard_target', ROOT / 'scripts/qa/round9-completion-receipt.py')
    target = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(target)
    binding, m = target.binding, target.m
    checks = []

    def forbidden(*args, **kwargs):
        raise AssertionError('PRODUCTION_CLIENT_OR_NETWORK_FORBIDDEN')

    with tempfile.TemporaryDirectory(prefix='round9-completion-offline-') as temporary:
        root = pathlib.Path(temporary)
        sample, evidence, tenant = root / 'qa/sample', root / 'qa', root / 'tenant'
        cwd = tenant / 'ws/main/bank'
        sample.mkdir(parents=True); cwd.mkdir(parents=True)
        actual = 'actual-team-different-from-requested'
        team_path = cwd / 'expert-teams' / actual / 'team.json'
        now = dt.datetime.now(dt.timezone.utc)
        created = now - dt.timedelta(hours=3)
        started = now - dt.timedelta(hours=2)
        created_ms, started_ms = int(created.timestamp() * 1000), int(started.timestamp() * 1000)
        sid, child, descendant = binding.EXPECTED_SID, 'session-child-fixture', 'session-grandchild-fixture'
        runtime = {'sha256': 'a' * 64, 'fileCount': 129}
        instance = {'id': 'fixture-instance', 'pid': 12345, 'port': 23456, 'cwd': str(tenant / 'ws')}
        prep = {'tenantId': m.UID, 'sessionId': sid, 'teamName': binding.REQUESTED_TEAM, 'cwd': str(cwd)}
        original_run = {**prep, 'username': 'real', 'status': 'running', 'createdAt': created.isoformat(),
                        'startedAt': started.isoformat(), 'instanceId': instance['id'], 'runtimeSha256': runtime['sha256'],
                        'createReceipt': {'sessionId': sid}, 'promptReceipt': {'accepted': True}}
        original_team = {'id': actual, 'name': actual, 'captainSessionId': sid, 'createdAt': started_ms + 1000,
                         'members': [{'id': child, 'name': 'worker'}], 'taskSeq': 1,
                         'tasks': [{'id': 't1', 'status': 'completed'}],
                         'qualityRuns': {'t1': {'status': 'integrated', 'contract': {'taskId': 't1'}}}}
        prior_paths = tuple(cwd / 'expert-teams' / f'prior-{i}' / 'team.json' for i in range(10))

        def header_path(session):
            return tenant / 'home/sessions/fixture' / session / 'session.v1.jsonl'

        def save_header(session, parent, when):
            path = header_path(session); path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({'type': 'session', 'id': session, 'parentSession': parent,
                                        'cwd': str(cwd), 'createdAt': when}) + '\n')

        class FakeClient:
            def __init__(self):
                self.calls, self.logged_in, self.closed = [], False, False
                self.instance = copy.deepcopy(instance)
                self.running = False
                self.goal = {'id': 'fixture-goal', 'revision': 14, 'phase': 'complete'}
                self.catalogs = {
                    sid: [{'kind': 'child', 'id': child, 'mode': 'continuable', 'activity': 'inactive'}],
                    child: [{'kind': 'child', 'id': descendant, 'mode': 'one-shot', 'activity': 'inactive'}],
                    descendant: [],
                }
                self.after_rpc = None

            def login(self):
                self.logged_in = True

            def close(self):
                self.closed = True

            def status(self):
                self.calls.append('status')
                return {'running': True, 'instance': copy.deepcopy(self.instance)}

            def rpc(self, method, args=None):
                self.calls.append(method)
                if method == 'session/list':
                    assert args == {'_request': {}}
                    answer = {'items': [{'sessionId': sid, 'running': self.running}]}
                elif method == 'subagents/list':
                    assert set(args) == {'parentSessionId'} and args['parentSessionId'] in self.catalogs
                    answer = {'entries': copy.deepcopy(self.catalogs[args['parentSessionId']])}
                elif method == 'goals/get':
                    assert args == {'agentId': sid}
                    answer = copy.deepcopy(self.goal)
                else:
                    raise AssertionError('FORBIDDEN_NON_READ_RPC_' + method)
                if self.after_rpc:
                    self.after_rpc(method)
                return answer

        def rewrite(path, mutation):
            value = m.load(path); mutation(value)
            if path.suffix == '.jsonl':
                path.write_text(json.dumps(value) + '\n')
            else:
                m.save(path, value)

        baseline = []
        with patch.multiple(m, SAMPLE=sample, EVIDENCE=evidence, CWD=cwd, TENANT=tenant, PAUSED_TEAMS=prior_paths), \
             patch.object(m, 'Client', forbidden), \
             patch.object(urllib.request.OpenerDirector, 'open', forbidden), \
             patch.object(m, 'preparation', side_effect=lambda: copy.deepcopy(prep)), \
             patch.object(m, 'finalized_preparation', side_effect=lambda: {'pausedTeamsBaseline': copy.deepcopy(baseline)}), \
             patch.object(m, 'runtime_identity', side_effect=lambda: copy.deepcopy(runtime)), \
             patch.object(m, 'bound_instance', side_effect=lambda client: client.status()['instance']):

            def reset():
                nonlocal baseline
                for name in ('completion-receipt.json', 'owned-team-binding.json'):
                    (sample / name).unlink(missing_ok=True)
                for path in (cwd / 'expert-teams').glob('extra-*/team.json'):
                    path.unlink()
                for i, path in enumerate(prior_paths):
                    m.save(path, {'name': f'prior-{i}', 'captainSessionId': m.OLD_CAPTAIN if i == 9 else f'old-{i}',
                                  'halted': i != 9, 'taskSeq': 1, 'members': [], 'tasks': [{'id': 'old', 'status': 'completed'}]})
                baseline = m.paused_snapshot()
                m.save(sample / 'run.json', original_run); m.save(team_path, original_team)
                save_header(sid, None, created_ms + 1000)
                save_header(child, sid, started_ms + 2000)
                save_header(descendant, child, started_ms + 3000)
                m.save(evidence / 'production-reload.json', {'status': 'PASS', 'tenantId': m.UID,
                    'payloadGate': {'runtime': copy.deepcopy(runtime)}, 'instanceAfter': instance, 'teamsAfter': baseline})
                binding.bind_team(str(team_path))
                return FakeClient()

            def reject(name, mutate, expected=None, offline=False):
                client = reset()
                mutate(client)
                try:
                    target.offline_snapshot() if offline else target.seal(lambda: client)
                except (RuntimeError, KeyError, ValueError, FileNotFoundError, BlockingIOError) as error:
                    if expected:
                        assert str(error) == expected, (name, str(error), expected)
                    assert not (sample / 'completion-receipt.json').exists(), name
                    assert m.load(sample / 'run.json').get('status') != 'completed', name
                    if client.logged_in:
                        assert client.closed, name
                    checks.append({'name': name, 'status': 'PASS', 'rejected': m.safe_error(error)})
                else:
                    raise AssertionError(name + ' unexpectedly sealed')

            client = reset()
            with patch.object(sys, 'argv', ['completion', 'check']), contextlib.redirect_stdout(io.StringIO()) as output:
                target.main()
            assert json.loads(output.getvalue())['networkCalls'] == 0 and not client.calls
            checks.append({'name': 'offline check has no client and accepts explicitly bound differing team name', 'status': 'PASS'})

            for name, field, value in [
                ('wrong captain', 'sessionId', 'other'), ('wrong tenant', 'tenantId', 'other'),
                ('wrong requested label', 'teamName', 'other'), ('wrong cwd', 'cwd', '/other'),
                ('not started', 'status', 'ready'), ('wrong username', 'username', 'other'),
                ('wrong runtime', 'runtimeSha256', 'b' * 64), ('wrong instance', 'instanceId', 'other'),
                ('unaccepted prompt', 'promptReceipt', {'accepted': False}),
                ('wrong create receipt', 'createReceipt', {'sessionId': 'other'}),
                ('future start', 'startedAt', (now + dt.timedelta(hours=1)).isoformat()),
                ('changed start', 'startedAt', (started + dt.timedelta(seconds=1)).isoformat()),
            ]:
                reject(name, lambda c, f=field, v=value: rewrite(sample / 'run.json', lambda row: row.__setitem__(f, v)))
            reject('missing observed team binding', lambda c: (sample / 'owned-team-binding.json').unlink())
            for field, value in [('teamId', 'wrong'), ('teamName', 'wrong'), ('teamCreatedAt', 0),
                                 ('tenantId', 'wrong'), ('sessionId', 'wrong'), ('runStartedAt', 'wrong'),
                                 ('captainHeader', {}), ('productionMutations', 1)]:
                reject('observed binding ' + field, lambda c, f=field, v=value:
                       rewrite(sample / 'owned-team-binding.json', lambda row: row.__setitem__(f, v)))
            for field, value in [('id', 'wrong'), ('parentSession', 'wrong'), ('cwd', '/wrong'),
                                 ('createdAt', 0), ('createdAt', started_ms + 500)]:
                reject('captain header ' + field + ':' + str(value), lambda c, f=field, v=value:
                       rewrite(header_path(sid), lambda row: row.__setitem__(f, v)))
            reject('changed team owner', lambda c: rewrite(team_path, lambda row: row.__setitem__('captainSessionId', 'wrong')))
            reject('team predates accepted run', lambda c: rewrite(team_path, lambda row: row.__setitem__('createdAt', created_ms)))
            reject('second owned team cannot be silently selected', lambda c: m.save(cwd / 'expert-teams/extra-owned/team.json',
                   {**original_team, 'id': 'extra-owned', 'name': 'extra-owned'}))
            reject('task still pending', lambda c: rewrite(team_path, lambda row: row['tasks'][0].__setitem__('status', 'pending')))
            reject('duplicate task ID', lambda c: rewrite(team_path, lambda row: row['tasks'].append(copy.deepcopy(row['tasks'][0]))))
            reject('empty task set', lambda c: rewrite(team_path, lambda row: row.__setitem__('tasks', [])))
            reject('quality not integrated', lambda c: rewrite(team_path, lambda row: row['qualityRuns']['t1'].__setitem__('status', 'passed')))
            reject('quality belongs to another task', lambda c: rewrite(team_path, lambda row: row['qualityRuns']['t1']['contract'].__setitem__('taskId', 'other')))
            reject('prior tenth state changed', lambda c: rewrite(prior_paths[-1], lambda row: row['tasks'][0].__setitem__('status', 'pending')))
            reject('prior paused state unhalted', lambda c: rewrite(prior_paths[0], lambda row: row.__setitem__('halted', False)))
            reject('captain still running', lambda c: setattr(c, 'running', True), 'CAPTAIN_STILL_RUNNING')
            reject('captain state unknown', lambda c: setattr(c, 'running', None), 'CAPTAIN_LIVE_STATE_UNAVAILABLE')
            for activity in ('running', None, 'unknown', False):
                reject('child activity ' + repr(activity), lambda c, a=activity: c.catalogs[sid][0].__setitem__('activity', a), 'CHILD_RUNNING_OR_UNKNOWN')
            reject('grandchild running', lambda c: c.catalogs[child][0].__setitem__('activity', 'running'), 'CHILD_RUNNING_OR_UNKNOWN')
            reject('catalog diagnostic', lambda c: c.catalogs[sid][0].__setitem__('kind', 'diagnostic'), 'OWNERSHIP_DIAGNOSTICS_UNRESOLVED')
            reject('member absent from formal catalog', lambda c: c.catalogs.__setitem__(sid, []), 'MEMBER_STOP_PROOF_MISSING')
            reject('duplicate catalog identity', lambda c: c.catalogs[sid].append(copy.deepcopy(c.catalogs[sid][0])), 'DUPLICATE_OR_CYCLIC_CHILD_IDENTITY')
            reject('child header wrong parent', lambda c: rewrite(header_path(child), lambda row: row.__setitem__('parentSession', 'wrong')), 'SESSION_PARENT_MISMATCH')
            reject('child header predates run', lambda c: rewrite(header_path(child), lambda row: row.__setitem__('createdAt', 0)), 'SESSION_PREDATES_RUN')
            reject('goal not complete', lambda c: c.goal.__setitem__('phase', 'paused'), 'GOAL_NOT_COMPLETE')
            reject('goal missing revision', lambda c: c.goal.pop('revision'), 'GOAL_IDENTITY_MISSING')
            for field, value in [('id', 'other'), ('pid', 9876), ('port', 9876), ('cwd', '/other')]:
                reject('live instance ' + field, lambda c, f=field, v=value: c.instance.__setitem__(f, v), 'RUN_HOST_INSTANCE_CHANGED')

            def after_first_goal(client, change):
                def hook(method):
                    if method == 'goals/get':
                        client.after_rpc = None
                        change()
                client.after_rpc = hook
            reject('new goal revision between stable reads', lambda c: after_first_goal(c, lambda: c.goal.__setitem__('revision', 15)), 'LIVE_STATE_CHANGED_DURING_COMPLETION_CHECK')
            reject('team metadata changed during check', lambda c: after_first_goal(c, lambda: rewrite(team_path, lambda row: row.__setitem__('taskSeq', 2))), 'LOCAL_BINDING_CHANGED_DURING_COMPLETION_CHECK')
            reject('run metadata changed during check', lambda c: after_first_goal(c, lambda: rewrite(sample / 'run.json', lambda row: row.__setitem__('operatorNote', 'new'))), 'LOCAL_BINDING_CHANGED_DURING_COMPLETION_CHECK')
            reject('prior baseline changed during check', lambda c: after_first_goal(c, lambda: rewrite(prior_paths[1], lambda row: row.__setitem__('taskSeq', 2))), 'PRIOR_TEN_TEAM_BASELINE_CHANGED')

            reset()
            with patch.object(sys, 'argv', ['completion', 'seal']):
                try:
                    target.main()
                except RuntimeError as error:
                    assert str(error) == 'EXPLICIT_EXPECTED_SESSION_REQUIRED'
                else:
                    raise AssertionError('missing explicit identity accepted')
            checks.append({'name': 'seal requires explicit exact session before client', 'status': 'PASS'})
            client = reset()
            with (sample / '.actions.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                try:
                    target.seal(lambda: client)
                except BlockingIOError:
                    assert not client.logged_in
                else:
                    raise AssertionError('competing local action lock accepted')
            checks.append({'name': 'completion serializes against pause and bind actions', 'status': 'PASS'})

            client = reset()
            before_team, before_prior = team_path.read_bytes(), [path.read_bytes() for path in prior_paths]
            result = target.seal(lambda: client)
            receipt, run = m.load(sample / 'completion-receipt.json'), m.load(sample / 'run.json')
            assert result['status'] == run['status'] == receipt['status'] == 'completed'
            assert run['actualTeamId'] == actual and run['teamName'] == binding.REQUESTED_TEAM
            assert receipt['artifactAcceptanceVerified'] is False and receipt['productionMutations'] == 0
            assert receipt['stableReadPasses'] == 2 and receipt['priorTenTeamsBaselineUnchanged'] is True
            assert {row['sessionId'] for row in receipt['finalSessions']} == {sid, child, descendant}
            assert client.calls.count('goals/get') == 2 and client.calls.count('session/list') == 2
            assert client.closed and team_path.read_bytes() == before_team
            assert [path.read_bytes() for path in prior_paths] == before_prior
            checks.append({'name': 'two stable fake reads seal lifecycle only; team/goal/ten baselines untouched', 'status': 'PASS'})
            frozen_receipt, frozen_run = (sample / 'completion-receipt.json').read_bytes(), (sample / 'run.json').read_bytes()
            try:
                target.seal(forbidden)
            except RuntimeError as error:
                assert str(error) == 'COMPLETION_RECEIPT_ALREADY_EXISTS'
            else:
                raise AssertionError('existing receipt overwritten')
            assert (sample / 'completion-receipt.json').read_bytes() == frozen_receipt
            assert (sample / 'run.json').read_bytes() == frozen_run
            checks.append({'name': 'existing receipt cannot be replaced and prevents Client construction', 'status': 'PASS'})

    report = {'kind': 'round9-completion-offline-guards', 'status': 'PASS', 'testCount': len(checks),
              'productionClientConstructed': False, 'networkCalls': 0, 'productionReads': 0, 'productionMutations': 0,
              'scope': 'Temporary local files and FakeClient only; actual check/seal were not executed.', 'checks': checks}
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': 'PASS', 'testCount': len(checks), 'report': str(OUT), 'networkCalls': 0}))


if __name__ == '__main__':
    main()
