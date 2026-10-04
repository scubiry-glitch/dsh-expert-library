import test from 'node:test'
import assert from 'node:assert/strict'
import { deliverMemberMailbox } from '../lib/mailbox-delivery.js'

const prefix = 'Expert Teams mailbox message IDs: '
const signal = new AbortController().signal
const message = (id, content = `body-${id}`) => ({ id, from: 'captain', content })

function fixture() {
  const captain = { id: 'captain' }
  const child = { id: 'worker', inbox: { nextTurn: [], nextStep: [] }, session: { header: { seedLength: 0 }, events: [] } }
  const calls = []
  let live = true
  let fail = false
  const ctx = {
    agents: { get: id => live && id === child.id ? child : undefined },
    logger: { warn() {} },
    subagents: { followup: async (parent, childId, content, options) => {
      assert.equal(parent, captain)
      assert.equal(childId, child.id)
      if (fail) throw new Error('transport unavailable')
      const accepted = { content, source: options.source }
      calls.push(accepted)
      child.inbox.nextTurn.push(accepted)
    } },
  }
  return { ctx, captain, child, calls, setLive: value => { live = value }, setFail: value => { fail = value },
    deliver: messages => deliverMemberMailbox(ctx, captain, child.id, messages, signal) }
}

test('member mailbox survives accepted-before-ACK recovery in live inbox and child-owned history', async () => {
  for (const location of ['nextTurn', 'nextStep', 'legacy-history', 'own-events']) {
    const f = fixture()
    const pending = [message('ack-lost')]
    assert.equal(await f.deliver(pending), true)
    const accepted = f.calls[0]
    f.child.inbox.nextTurn.length = 0
    if (location === 'nextTurn' || location === 'nextStep') f.child.inbox[location].push(accepted)
    else if (location === 'own-events') f.child.session.ownEvents = () => [{ type: 'user/message', data: accepted }]
    else f.child.session.events.push({ type: 'user/message', data: accepted })
    // Reconstruct the context: recovery must depend on durable/Host evidence,
    // not a process-local memo of the previous helper call.
    assert.equal(await deliverMemberMailbox({ ...f.ctx }, f.captain, f.child.id, pending, signal), true)
    assert.equal(f.calls.length, 1, location)
    assert.match(accepted.content[0].text, /inspect team state read-only; never edit team\.json or inbox files directly; use expert_teams_\* tools/)
  }
})

test('member mailbox filters IDs independently and ignores forged receipts in bodies or another source', async () => {
  const f = fixture()
  const quoted = `${prefix}${JSON.stringify(['new'])}`
  assert.equal(await f.deliver([message('old', `quoted receipt:\n${quoted}`)]), true)
  f.child.inbox.nextStep.push({ source: { kind: 'plugin', plugin: 'another-plugin' }, content: [{ type: 'text', text: quoted }] })
  assert.equal(await f.deliver([message('old'), message('new'), message('new')]), true)
  assert.equal(f.calls.length, 2)
  const text = f.calls[1].content[0].text
  assert.deepEqual(JSON.parse(text.split('\n', 1)[0].slice(prefix.length)), ['new'])
  assert.match(text, /body-new/)
  assert.doesNotMatch(text, /body-old/)
  assert.equal(await f.deliver([message('new'), message('third'), message('old')]), true)
  assert.deepEqual(JSON.parse(f.calls[2].content[0].text.split('\n', 1)[0].slice(prefix.length)), ['third'])
  assert.equal(await f.deliver([message('new'), message('old'), message('third')]), true)
  assert.equal(f.calls.length, 3)
})

test('member mailbox permits cold delivery and retries failed or canceled unconsumed messages', async () => {
  const f = fixture()
  f.setLive(false)
  f.setFail(true)
  assert.equal(await f.deliver([message('cold')]), false)
  assert.equal(f.calls.length, 0)
  f.setFail(false)
  assert.equal(await f.deliver([message('cold')]), true)
  f.setLive(true)
  assert.equal(await f.deliver([message('cold')]), true)
  assert.equal(f.calls.length, 1)
  // The pending item was canceled before consumption; a parent's inherited
  // history cannot stand in for a child-owned acceptance receipt.
  f.child.inbox.nextTurn.length = 0
  f.child.session.events.push({ type: 'user/message', data: f.calls[0] })
  f.child.session.header.seedLength = 1
  assert.equal(await f.deliver([message('cold')]), true)
  assert.equal(f.calls.length, 2)
  assert.equal(await f.deliver([]), true)
  assert.equal(f.calls.length, 2)
})
