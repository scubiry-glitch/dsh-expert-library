import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../scripts/ops/customer-question-boundary.mjs'

test('customer question boundary hides and rejects the unanswerable tool', async () => {
  const old = process.env.DSH_CUSTOMER_WORKSPACE_DIR
  process.env.DSH_CUSTOMER_WORKSPACE_DIR = '/customer/workspace'
  try {
    let guard, assemble, dispose
    let current
    const ctx = {
      tools: { guard(fn) { guard = fn; return () => { guard = undefined } } },
      on(name, fn) { assert.equal(name, 'system-prompt/assemble'); assemble = fn; return () => { assemble = undefined } },
      agents: { currentInitiator: () => current },
      effect(fn) { dispose = fn() },
    }
    apply(ctx)
    const inside = { session: { header: { cwd: '/customer/workspace/expert-teams/task' } } }
    const outside = { session: { header: { cwd: '/other/workspace' } } }
    assert.match(guard({ name: 'ask_user_question', agent: inside }), /CUSTOMER_QUESTION_CHANNEL_REQUIRED/)
    assert.equal(guard({ name: 'customer_ask_question', agent: inside }), undefined)
    assert.equal(guard({ name: 'ask_user_question', agent: outside }), undefined)
    current = inside
    const input = { tools: [{ name: 'ask_user_question' }, { name: 'customer_ask_question' }] }
    assert.deepEqual((await assemble(null, null, async () => input)).tools, [{ name: 'customer_ask_question' }])
    current = outside
    assert.equal((await assemble(null, null, async () => input)).tools.length, 2)
    dispose()
    assert.equal(guard, undefined)
    assert.equal(assemble, undefined)
  } finally {
    if (old === undefined) delete process.env.DSH_CUSTOMER_WORKSPACE_DIR
    else process.env.DSH_CUSTOMER_WORKSPACE_DIR = old
  }
})
