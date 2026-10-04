#!/usr/bin/env python3
"""Bounded controller tests with local fixtures; production Client is never constructed."""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
from unittest.mock import patch

sys.dont_write_bytecode = True
REPO = pathlib.Path('/root/zhijian/dsh-expert-library')
OUT = REPO / 'docs/evidence/team-reliability-round9-20261003/controller-offline-guards.json'


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def main():
    m = module('round9_controller_guard_target', REPO / 'scripts/qa/round9-real-rerun.py')
    pause = module('round9_pause_guard_target', REPO / 'scripts/qa/round9-pause-owned-run.py')
    checks = []

    def reject(name, call, expected=None):
        try:
            call()
        except (RuntimeError, FileNotFoundError, KeyError, ValueError) as error:
            if expected is not None:
                assert str(error) == expected, (name, str(error), expected)
            checks.append({'name': name, 'status': 'PASS', 'rejected': m.safe_error(error)})
        else:
            raise AssertionError(name + ' unexpectedly admitted')

    def accept(name, call):
        result = call()
        checks.append({'name': name, 'status': 'PASS'})
        return result

    def no_client(*args, **kwargs):
        raise AssertionError('PRODUCTION_CLIENT_CONSTRUCTION_FORBIDDEN')

    with patch.object(m, 'Client', no_client), patch.object(pause.m, 'Client', no_client):
        actual = accept('real previous completion proof is valid offline',
                        lambda: m.previous_stop_evidence(m.PREVIOUS_SAMPLE / 'completion-receipt.json'))
        assert actual['actualTeamId'] == 'cgz-swap-rerun8'
        accept('ten prior states preserved; tenth completion does not require halt', m.finalized_preparation)
        prep = m.preparation()
        previous_prep = m.load(m.PREVIOUS_SAMPLE / 'preparation.json')
        original_prompt = (m.PREVIOUS_SAMPLE / 'prompt.txt').read_text()
        expected_prompt = original_prompt.replace(previous_prep['outputRelativePath'], m.OUTPUT_REL, 1)
        expected_prompt = expected_prompt.replace(previous_prep['teamName'], prep['teamName'], 1)
        expected_prompt = expected_prompt.replace('work/cgz-swap-rerun7-20261003/ 或任何此前',
            'work/cgz-swap-rerun7-20261003/、work/cgz-swap-rerun8-20261003/ 或任何此前', 1)
        assert (m.SAMPLE / 'prompt.txt').read_text() == expected_prompt
        checks.append({'name': 'prompt differs only by isolation labels and prior8 exclusion', 'status': 'PASS'})
        base = (m.PREVIOUS_SAMPLE / 'observe.py').read_text()
        rebound = accept('observer round8 prefix rebinding succeeds', lambda: m.extend_observer(base, 'session-offline-probe'))
        assert m.OLD_CAPTAIN not in rebound and str(m.PREVIOUS_SAMPLE) not in rebound
        assert "cwd / 'work/cgz-swap-rerun9-20261003'" in rebound
        reject('stale round7 observer prefix rejected', lambda: m.extend_observer(
            base.replace("cwd / 'work/cgz-swap-rerun8-20261003'", "cwd / 'work/cgz-swap-rerun7-20261003'"), 'session-offline-probe'))

        with tempfile.TemporaryDirectory(prefix='round9-controller-offline-') as temporary:
            root = pathlib.Path(temporary)
            previous_dir, sample, cwd, evidence = root / 'previous', root / 'sample', root / 'cwd', root / 'evidence'
            previous_dir.mkdir(); sample.mkdir(); evidence.mkdir(); cwd.mkdir()
            previous_run = m.load(m.PREVIOUS_SAMPLE / 'run.json')
            previous_receipt = m.load(m.PREVIOUS_SAMPLE / 'completion-receipt.json')
            previous_team = m.load(m.PAUSED_TEAMS[-1])
            old_path = cwd / 'expert-teams' / m.OLD_TEAM_ID / 'team.json'
            old_path.parent.mkdir(parents=True)
            previous_receipt['binding']['teamPath'] = str(old_path)
            previous_receipt['binding']['captainHeader']['cwd'] = str(cwd)
            previous_receipt['teams'] = [{'path': str(old_path), 'id': m.OLD_TEAM_ID}]
            originals = (previous_run, previous_receipt, previous_team)

            def proof_fixture(change=None):
                run, receipt, team = copy.deepcopy(originals)
                if change:
                    change(run, receipt, team)
                m.save(previous_dir / 'run.json', run)
                m.save(previous_dir / 'completion-receipt.json', receipt)
                m.save(old_path, team)
                return m.previous_stop_evidence(previous_dir / 'completion-receipt.json')

            def set_field(which, key, value):
                return lambda run, receipt, team: (run, receipt, team)[which].__setitem__(key, value)

            with patch.multiple(m, PREVIOUS_SAMPLE=previous_dir, SAMPLE=sample, CWD=cwd,
                                PAUSED_TEAMS=tuple([old_path] * 10), EVIDENCE=evidence):
                accept('fixture completion admits nonhalted completed team', lambda: proof_fixture(set_field(2, 'halted', False)))
                bad = [
                    ('prior run tenant', set_field(0, 'tenantId', 'other')),
                    ('prior run captain', set_field(0, 'sessionId', 'other')),
                    ('receipt captain', set_field(1, 'sessionId', 'other')),
                    ('receipt tenant', set_field(1, 'tenantId', 'other')),
                    ('receipt not completed', set_field(1, 'status', 'paused')),
                    ('prior run not completed', set_field(0, 'status', 'running')),
                    ('goal not complete', set_field(1, 'goalPhase', 'paused')),
                    ('unresolved diagnostic', set_field(1, 'diagnostics', [{}])),
                    ('mutating completion receipt', set_field(1, 'productionMutations', 1)),
                    ('requested team is not actual identity', set_field(0, 'actualTeamId', previous_run['teamName'])),
                    ('prior runtime changed', set_field(0, 'runtimeSha256', 'a' * 64)),
                    ('prior instance changed', set_field(0, 'instanceId', 'other')),
                    ('receipt instance changed', set_field(1, 'instanceId', 'other')),
                    ('receipt start mismatch', set_field(1, 'startedAt', '2026-10-03T00:00:00+00:00')),
                    ('receipt completion mismatch', set_field(1, 'finishedAt', '2026-10-03T00:00:00+00:00')),
                    ('empty final sessions', set_field(1, 'finalSessions', [])),
                    ('missing actual team path', set_field(1, 'teams', [])),
                    ('team owner changed', set_field(2, 'captainSessionId', 'other')),
                    ('team id changed', set_field(2, 'id', 'other')),
                    ('team name changed', set_field(2, 'name', previous_run['teamName'])),
                    ('team creation changed', set_field(2, 'createdAt', m.OLD_TEAM_CREATED_AT + 1)),
                    ('completion task count changed', set_field(1, 'taskCount', 0)),
                    ('completion boolean missing', set_field(1, 'allTasksCompletedAndIntegrated', False)),
                    ('receipt binding wrong path', lambda r, e, t: e['binding'].__setitem__('teamPath', '/other/team.json')),
                    ('receipt binding wrong team', lambda r, e, t: e['binding'].__setitem__('teamId', r['teamName'])),
                    ('captain header wrong parent', lambda r, e, t: e['binding']['captainHeader'].__setitem__('parentSession', 'other')),
                    ('captain header wrong cwd', lambda r, e, t: e['binding']['captainHeader'].__setitem__('cwd', '/other')),
                    ('captain header too old', lambda r, e, t: e['binding']['captainHeader'].__setitem__('createdAt', 0)),
                    ('running child receipt', lambda r, e, t: e['finalSessions'][1].__setitem__('running', True)),
                    ('wrong child parent', lambda r, e, t: e['finalSessions'][1].__setitem__('parentSessionId', 'other')),
                    ('duplicate stopped session', lambda r, e, t: e['finalSessions'].append(copy.deepcopy(e['finalSessions'][0]))),
                    ('omitted stopped member', lambda r, e, t: e['finalSessions'].pop()),
                    ('task incomplete', lambda r, e, t: t['tasks'][0].__setitem__('status', 'pending')),
                    ('quality incomplete', lambda r, e, t: t['qualityRuns'][t['tasks'][0]['id']].__setitem__('status', 'pending')),
                ]
                for name, mutation in bad:
                    reject(name, lambda mutation=mutation: proof_fixture(mutation))
                reject('proof path outside evidence root', lambda: m.previous_stop_evidence(root / 'outside.json'))

                expected = 'a' * 64
                runtime = {'sha256': expected, 'fileCount': 128}
                good_report = {'status': 'PASS', 'isolated': True, 'productionTouched': False, 'stopped': True,
                               'businessApiCalls': 0, 'realLlmCalls': 0,
                               'candidateRuntimeSha256': expected, 'candidateRuntimeFileCount': 128}

                def reports_fixture(change=None, omit=False):
                    for name in m.HOST_REPORTS:
                        m.save(evidence / name, good_report)
                    if change:
                        report = copy.deepcopy(good_report); report.update(change)
                        m.save(evidence / m.HOST_REPORTS[-1], report)
                    if omit:
                        (evidence / m.HOST_REPORTS[-1]).unlink()
                    return m.payload_gate(expected)

                with patch.object(m, 'runtime_identity', return_value=runtime):
                    accept('all four exact-runtime isolated Host reports required', reports_fixture)
                    reject('missing fourth Host report', lambda: reports_fixture(omit=True))
                    for key, value in [('status', 'FAILED'), ('isolated', False), ('productionTouched', True),
                                       ('stopped', False), ('businessApiCalls', 1), ('realLlmCalls', 1),
                                       ('candidateRuntimeSha256', 'b' * 64), ('candidateRuntimeFileCount', 127)]:
                        reject('Host evidence ' + key, lambda key=key, value=value: reports_fixture({key: value}))
                    reject('old round8 payload is not a new candidate', lambda: m.payload_gate(m.OLD_RUNTIME_SHA256))
                    reject('payload hash differs from exact expected', lambda: m.payload_gate('b' * 64))
                    reject('malformed payload hash', lambda: m.payload_gate('not-a-sha'))

                for action in ('preflight', 'reload', 'reconcile-reload', 'create', 'start'):
                    with patch.object(m, 'preparation', return_value={'sessionId': prep['sessionId']}), \
                         patch.object(m, 'payload_gate', side_effect=RuntimeError('BLOCK_BEFORE_CLIENT')), \
                         patch.object(sys, 'argv', ['controller', action, '--expected-runtime-sha256', expected]):
                        reject(action + ' validates gate before any Client construction', m.main, 'BLOCK_BEFORE_CLIENT')

            class SettingsClient:
                def __init__(self, cap):
                    self.cap = cap
                def rpc(self, name, args):
                    assert name == 'settings/describe' and args == {}
                    return {'namespaces': [{'ns': 'agent-default-model', 'value': {'provider': 'zai', 'model': 'glm-5.3-flash'},
                                             'user': {'provider': 'zai', 'model': 'glm-5.3-flash'}, 'revision': 1},
                                            {'ns': 'expert-library', 'value': {'maxActiveMembers': self.cap}}]}
            accept('member active cap two retained', lambda: m.selected_settings(SettingsClient(2)))
            for cap in (1, 3, '2', True, None):
                reject('reject member cap ' + repr(cap), lambda cap=cap: m.selected_settings(SettingsClient(cap)))

            new_team = cwd / 'expert-teams' / 'actual-round9-fixture' / 'team.json'
            new_team.parent.mkdir(parents=True)
            started = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=2)
            run = {'sessionId': pause.EXPECTED_SID, 'tenantId': m.UID, 'cwd': str(cwd),
                   'teamName': pause.REQUESTED_TEAM, 'status': 'running',
                   'createdAt': (started - dt.timedelta(seconds=10)).isoformat(), 'startedAt': started.isoformat()}
            team = {'id': new_team.parent.name, 'name': new_team.parent.name,
                    'captainSessionId': pause.EXPECTED_SID, 'createdAt': int(started.timestamp() * 1000) + 1000,
                    'members': [], 'tasks': []}
            fake_prep = {**prep, 'cwd': str(cwd)}
            with patch.object(pause, 'm', m), patch.multiple(m, SAMPLE=sample, CWD=cwd), \
                 patch.object(m, 'preparation', return_value=fake_prep), \
                 patch.object(pause, 'session_header', return_value={'id': pause.EXPECTED_SID, 'cwd': str(cwd)}):
                m.save(sample / 'run.json', run); m.save(new_team, team)
                reject('unbound actual team prevents silent wrong-name pause', pause.exact_team)
                accept('explicit offline actual-team binding', lambda: pause.bind_team(str(new_team)))
                bound = accept('bound actual team differs from requested safely', pause.exact_team)
                assert bound[1]['id'] != pause.REQUESTED_TEAM
                assert m.load(sample / 'run.json')['teamName'] == pause.REQUESTED_TEAM
                accept('repeat same team binding is idempotent', lambda: pause.bind_team(str(new_team)))
                original = m.load(sample / 'owned-team-binding.json')
                for key, value in [('sessionId', 'other'), ('tenantId', 'other'), ('runStartedAt', 'other'),
                                   ('teamCreatedAt', team['createdAt'] + 1), ('teamId', pause.REQUESTED_TEAM)]:
                    modified = {**original, key: value}; m.save(sample / 'owned-team-binding.json', modified)
                    reject('pause binding ' + key, pause.exact_team)
                m.save(sample / 'owned-team-binding.json', original)
                changed = {**team, 'captainSessionId': 'other'}; m.save(new_team, changed)
                reject('actual team owner changes', pause.exact_team)
                m.save(new_team, team)
                other = cwd / 'expert-teams' / 'other-owned' / 'team.json'
                m.save(other, {**team, 'id': 'other-owned', 'name': 'other-owned'})
                reject('two owned teams are not silently chosen', pause.exact_team)
                other.unlink()
                reject('bind path outside workspace', lambda: pause.bind_team(str(root / 'team.json')))
                m.save(new_team, {**team, 'createdAt': 0})
                reject('team predates run', lambda: pause.checked_team(new_team, run))
                m.save(new_team, {**team, 'createdAt': int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000) + 60000})
                reject('team creation in future', lambda: pause.checked_team(new_team, run))
                m.save(new_team, team)

    report = {'kind': 'round9-controller-and-pause-offline-guards', 'status': 'PASS', 'testCount': len(checks),
              'productionClientConstructed': False, 'networkCalls': 0, 'productionMutations': 0,
              'scope': 'Local temporary fixtures, pure guards, and read-only sealed previous-run identity proof only.',
              'checks': checks}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': 'PASS', 'testCount': len(checks), 'report': str(OUT), 'networkCalls': 0}))


if __name__ == '__main__':
    main()
