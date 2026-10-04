"""Pure read-only observation summary; fatal stopped turns must not look like generation."""
def summarize(observation, live, audit, run, sample):
    sessions = []
    for row in observation['sessions']:
        end = row.get('lastTurnEnd') or {}
        sessions.append({'id': row['sessionId'], 'name': row['name'],
                         'steps': row['assistantUsage']['uniqueTurnSteps'],
                         'lastTool': (row.get('lastToolCall') or {}).get('name'),
                         'errors': row['toolErrors']['count'],
                         'lastEventAge': row['secondsSinceLastEvent'],
                         'lastTurnEnd': {k: end.get(k) for k in ('time', 'turn', 'kind', 'code', 'status', 'error')},
                         'openTurn': row.get('openTurn')})
    running = [r['sessionId'] for r in live['sessions'] if r['running']]
    teams = observation['teams']
    blocks = [{'id': t.get('id'), 'runtimeSummary': t.get('runtimeSummary'),
               'captainRuntimeBlock': t.get('captainRuntimeBlock')} for t in teams
              if (t.get('runtimeSummary') or {}).get('blockedMembers', 0)
              or (t.get('runtimeSummary') or {}).get('captainBlocked')]
    phase = (live.get('goal') or {}).get('phase')
    # A prior error alone is not proof of a current block: use durable runtime blocks
    # and native running state together. A running peer may still complete/recover.
    stop = None
    if not running:
        if run.get('status') == 'paused_for_next_optimization':
            stop = 'frozen_failed_sample'
        elif phase in ('complete', 'blocked', 'paused'):
            stop = 'non_running_goal_' + phase
        elif blocks:
            stop = 'non_running_runtime_block'
    return {'sample': sample, 'at': live['checkedAt'], 'goalPhase': phase, 'running': running,
            'modelAudit': audit['status'], 'sessions': sessions, 'teams': teams,
            'runtimeBlocks': blocks, 'artifactCount': observation['artifacts']['fileCount'],
            'usageTotals': observation['usageTotals'], 'stopObservationReason': stop,
            'acceptance': 'NOT_EVALUATED_BY_OBSERVER'}
