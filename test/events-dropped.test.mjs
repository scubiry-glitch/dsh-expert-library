/**
 * Dropped session-event observability (audit gap #4 residual): the harness's
 * session-event vocabulary (`KNOWN_SESSION_EVENT_TYPES`, dsh-session rc.8) is
 * a closed generated constant with no registration surface and no
 * `ignorable: true` writer on `Session.append`, so `expert-teams/*` events
 * must be omitted — but the omission must be counted and surfaced.
 *
 * - The default (no-seam) path proves the real gap against the installed
 *   harness constant: `expert-teams/provider-called` is dropped (and counted)
 *   while a genuinely known type appends.
 * - The `isKnown` seam simulates both verdicts for deterministic counting.
 * - The `/audit` route payload carries the `eventsDropped` counter.
 *
 * All tests are hermetic: fake session/ctx, no real sessions, no network.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendTeamEvent,
  droppedSessionEvents,
  resetDroppedSessionEvents,
} from '../lib/events.js'
import { EXPERT_TEAMS_EVENT_TYPES } from '../lib/event-types.js'
import { createAuditHandler } from '../lib/host/audit-log.js'

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function fakeCtx(record) {
  const log = record ?? { debug: [], warn: [] }
  return {
    logger: {
      debug: (message) => log.debug.push(String(message)),
      warn: (message) => log.warn.push(String(message)),
    },
    log,
  }
}

function fakeSession(calls) {
  return { append(type, data) { calls.push({ type, data }) } }
}

function fakeReq(url) {
  return { url }
}

function fakeRes() {
  return {
    status: undefined,
    body: undefined,
    writeHead(status) { this.status = status },
    end(body) { this.body = body },
  }
}

/* ---------------------------------------------------------------------------
 * The real gap, against the installed harness constant (no seam)
 * ------------------------------------------------------------------------- */

test('default path: expert-teams/* events are dropped and counted; a known type appends', () => {
  resetDroppedSessionEvents()
  const calls = []
  const log = { debug: [], warn: [] }
  const session = fakeSession(calls)

  // `expert-teams/provider-called` is NOT in the installed KNOWN_SESSION_EVENT_TYPES
  // (closed generated constant) → omitted + counted, session untouched.
  appendTeamEvent(fakeCtx(log), session, 'expert-teams/provider-called', {
    agentId: 'member-1',
    detail: { capability: 'realestate.indicators.timeseries', provider: 'zyt', ok: false, code: 'ZYT_AUTH_ERROR' },
  })
  assert.equal(calls.length, 0, 'dropped events must never reach session.append')
  assert.equal(log.debug.length, 1, 'the drop is logged once (per type)')
  assert.match(log.debug[0], /expert-teams\/provider-called/)
  const dropped = droppedSessionEvents()
  assert.equal(dropped.total, 1)
  assert.equal(dropped.byType['expert-teams/provider-called'], 1)

  // `todo/write` IS in the installed constant → appended normally.
  appendTeamEvent(fakeCtx(log), session, 'todo/write', { items: [] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].type, 'todo/write')
  assert.equal(droppedSessionEvents().total, 1, 'known types are not counted as dropped')
})

/* ---------------------------------------------------------------------------
 * Counting semantics (deterministic via the isKnown seam)
 * ------------------------------------------------------------------------- */

test('drops are counted per type and in total', () => {
  resetDroppedSessionEvents()
  const session = fakeSession([])
  const neverKnown = () => false
  appendTeamEvent(fakeCtx(), session, 'expert-teams/provider-called', { agentId: 'a', detail: { capability: 'c', ok: true } }, { isKnown: neverKnown })
  appendTeamEvent(fakeCtx(), session, 'expert-teams/provider-called', { agentId: 'b', detail: { capability: 'c', ok: false, code: 'X' } }, { isKnown: neverKnown })
  appendTeamEvent(fakeCtx(), session, 'expert-teams/task-updated', { teamId: 't', taskId: 'x', status: 'completed' }, { isKnown: neverKnown })
  const dropped = droppedSessionEvents()
  assert.equal(dropped.total, 3)
  assert.deepEqual(dropped.byType, {
    'expert-teams/provider-called': 2,
    'expert-teams/task-updated': 1,
  })
  // The snapshot is frozen (immutable wire value).
  assert.ok(Object.isFrozen(dropped))
  assert.ok(Object.isFrozen(dropped.byType))
})

test('resetDroppedSessionEvents clears the counters (test seam)', () => {
  resetDroppedSessionEvents()
  appendTeamEvent(fakeCtx(), fakeSession([]), 'expert-teams/team-created', { teamId: 't', captainSessionId: 's', name: 'n' }, { isKnown: () => false })
  assert.equal(droppedSessionEvents().total, 1)
  resetDroppedSessionEvents()
  assert.deepEqual(droppedSessionEvents(), { total: 0, byType: {} })
})

test('a recognized type is appended with its data and never counted as dropped', () => {
  resetDroppedSessionEvents()
  const calls = []
  const data = { teamId: 't', taskId: 'x', status: 'in_progress' }
  appendTeamEvent(fakeCtx(), fakeSession(calls), 'expert-teams/task-updated', data, { isKnown: () => true })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { type: 'expert-teams/task-updated', data })
  assert.equal(droppedSessionEvents().total, 0)
})

test('an append failure is warned, not counted as a drop, and never throws', () => {
  resetDroppedSessionEvents()
  const log = { debug: [], warn: [] }
  const broken = { append() { throw new Error('session gone') } }
  appendTeamEvent(fakeCtx(log), broken, 'expert-teams/message-sent', { teamId: 't', messageId: 'm', from: 'a', to: 'b', content: 'hi', ts: 1 }, { isKnown: () => true })
  assert.equal(log.warn.length, 1)
  assert.match(log.warn[0], /session record failed after expert-teams\/message-sent/)
  assert.equal(droppedSessionEvents().total, 0, 'append failures are not vocabulary drops')
})

/* ---------------------------------------------------------------------------
 * Surfaced via the /audit route payload
 * ------------------------------------------------------------------------- */

test('/audit carries eventsDropped when the resolver is wired', async () => {
  resetDroppedSessionEvents()
  appendTeamEvent(fakeCtx(), fakeSession([]), 'expert-teams/provider-called', { agentId: 'a', detail: { capability: 'c', ok: true } }, { isKnown: () => false })
  const handler = createAuditHandler({
    resolveMemory: () => [],
    resolveDroppedEvents: droppedSessionEvents,
  })
  const res = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/audit'), res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.entries, [])
  assert.deepEqual(body.eventsDropped, {
    total: 1,
    byType: { 'expert-teams/provider-called': 1 },
  })
})

test('/audit omits eventsDropped when the resolver is absent (backward compatible)', async () => {
  const handler = createAuditHandler({ resolveMemory: () => [] })
  const res = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/audit'), res)
  const body = JSON.parse(res.body)
  assert.deepEqual(body.entries, [])
  assert.equal('eventsDropped' in body, false)
})

/* ---------------------------------------------------------------------------
 * Single source of truth for the event vocabulary
 * ------------------------------------------------------------------------- */

test('EXPERT_TEAMS_EVENT_TYPES enumerates all eight expert-teams/* event names', () => {
  assert.deepEqual(EXPERT_TEAMS_EVENT_TYPES, [
    'expert-teams/team-created',
    'expert-teams/member-added',
    'expert-teams/member-removed',
    'expert-teams/task-created',
    'expert-teams/task-updated',
    'expert-teams/message-sent',
    'expert-teams/team-deleted',
    'expert-teams/provider-called',
  ])
  assert.equal(new Set(EXPERT_TEAMS_EVENT_TYPES).size, EXPERT_TEAMS_EVENT_TYPES.length)
})
