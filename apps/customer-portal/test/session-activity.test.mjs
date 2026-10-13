import test from 'node:test'
import assert from 'node:assert/strict'
import { readSessionActivity, workspaceHasRunningTask } from '../session-activity.mjs'

test('only a live Agent signal counts as running', () => {
  assert.equal(workspaceHasRunningTask({ running: true }), true)
  assert.equal(workspaceHasRunningTask({ running: false }), false)
  assert.equal(workspaceHasRunningTask({ team: { tasks: [{ status: 'in_progress' }] } }), false)
  assert.equal(workspaceHasRunningTask({ plan: { status: 'running' } }), false)
})

test('activity lookup preserves session order and leaves failed states unknown', async () => {
  const sessions = [{ id: 'one' }, { id: 'two' }, { id: 'three' }]
  const result = await readSessionActivity(sessions, async session => {
    if (session.id === 'two') throw new Error('unavailable')
    if (session.id === 'one') await new Promise(resolve => setTimeout(resolve, 10))
    return { running: session.id === 'one' }
  }, 2)
  assert.deepEqual(result, { items: [{ id: 'one', running: true }, { id: 'three', running: false }], hasUnknown: true })
})

test('activity lookup returns partial results when a backend call never settles', async () => {
  const sessions = [{ id: 'fast' }, { id: 'stuck' }, { id: 'queued' }]
  let queued = false
  const started = Date.now()
  const result = await readSessionActivity(sessions, async session => {
    if (session.id === 'stuck') return new Promise(() => {})
    if (session.id === 'queued') queued = true
    return { running: session.id === 'fast' }
  }, 2, 20)
  assert.deepEqual(result, { items: [{ id: 'fast', running: true }, { id: 'queued', running: false }], hasUnknown: true })
  assert.equal(queued, true)
  assert.ok(Date.now() - started < 1_000)
})
