import test from 'node:test'
import assert from 'node:assert/strict'
import { createCustomerApprovalHub } from '../src/host/customer-approval.ts'

const request = (sessionId, signal) => ({ agent: { session: { id: sessionId } }, toolName: 'expert_provider_call',
  reason: '写操作 rongcheng/api/v2/capabilities/report.generate（transport v2-write-api）', signal })

test('one report approval is scoped to its session and can only be answered once', async () => {
  let listener
  const hub = createCustomerApprovalHub({ on: (_name, callback) => { listener = callback } })
  const waiting = listener(request('session-12345678-1234-1234-1234-123456789abc'), () => Promise.resolve('unavailable'))
  const card = hub.read('session-12345678-1234-1234-1234-123456789abc')
  assert.match(card.reason, /四份 Word/)
  assert.equal(hub.read('session-87654321-1234-1234-1234-123456789abc'), null)
  assert.equal(hub.answer('session-87654321-1234-1234-1234-123456789abc', card.id, 'allowed-once'), false)
  assert.equal(hub.answer('session-12345678-1234-1234-1234-123456789abc', card.id, 'allowed-once'), true)
  assert.equal(await waiting, 'allowed-once')
  assert.equal(hub.answer('session-12345678-1234-1234-1234-123456789abc', card.id, 'allowed-once'), false)
})

test('aborted approval is cancelled and removed', async () => {
  let listener
  const hub = createCustomerApprovalHub({ on: (_name, callback) => { listener = callback } })
  const controller = new AbortController()
  const session = 'session-12345678-1234-1234-1234-123456789abd'
  const waiting = listener(request(session, controller.signal), () => Promise.resolve('unavailable'))
  const card = hub.read(session)
  controller.abort()
  assert.equal(await waiting, 'cancelled')
  assert.equal(hub.read(session), null)
  assert.equal(hub.answer(session, card.id, 'allowed-once'), false)
})
