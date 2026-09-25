import test from 'node:test'
import assert from 'node:assert/strict'
import { guardSubagentDelivery, queueMemberPrompt } from '../lib/harness-compat.js'

const deliverPrompt = Symbol.for('dsh.subagent.deliverPrompt')
const legacyQueuePrompt = Symbol.for('dsh.subagent.queuePrompt')

function deliveryArgs(mode = 'queue') {
  return [
    { id: 'synthetic-parent' },
    'synthetic-child',
    [{ type: 'text', text: 'synthetic prompt' }],
    { kind: 'plugin', plugin: 'test' },
    new AbortController().signal,
    mode,
  ]
}

// Bound the regression even when the pre-fix guard recursively calls itself.
function allowAtMost(limit, checks = []) {
  return async (...args) => {
    checks.push(args)
    assert.ok(checks.length <= limit, 'guard recursively re-entered delivery')
    return false
  }
}

for (const [label, key] of [['current delivery', deliverPrompt], ['legacy queue fallback', legacyQueuePrompt]]) {
  test(`${label} calls the original once and preserves arguments and receiver`, async () => {
    const calls = []
    const original = async function (...args) {
      calls.push({ receiver: this, args })
      return 'queued'
    }
    const runtime = { [key]: original }
    const checks = []
    const dispose = guardSubagentDelivery(runtime, allowAtMost(2, checks))
    try {
      for (const mode of ['queue', 'steer']) {
        const args = deliveryArgs(mode)
        assert.equal(await runtime[key](...args), 'queued')
        const call = calls.at(-1)
        assert.equal(call.receiver, runtime)
        args.forEach((value, index) => assert.equal(call.args[index], value))
      }
      assert.equal(calls.length, 2)
      assert.equal(checks.length, 2)
    } finally {
      dispose()
    }
    assert.equal(runtime[key], original)
  })

  test(`${label} rejects a retired child before calling the original`, async () => {
    let deliveries = 0
    const args = deliveryArgs()
    const runtime = { [key]: async () => { deliveries += 1 } }
    const dispose = guardSubagentDelivery(runtime, async (sender, target) => {
      assert.equal(sender, args[0])
      assert.equal(target, args[1])
      return true
    })
    try {
      await assert.rejects(runtime[key](...args), { code: 'NOT_RESUMABLE' })
      assert.equal(deliveries, 0)
    } finally {
      dispose()
    }
  })
}

test('the member prompt helper reaches current guarded delivery once', async () => {
  const args = deliveryArgs()
  const calls = []
  const runtime = { [deliverPrompt]: async (...received) => { calls.push(received); return 'queued' } }
  const dispose = guardSubagentDelivery(runtime, allowAtMost(1))
  try {
    assert.equal(await queueMemberPrompt(runtime, args[0], args[1], args[2], args[4]), 'queued')
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], args[0])
    assert.equal(calls[0][1], args[1])
    assert.equal(calls[0][2], args[2])
    assert.deepEqual(calls[0][3], { kind: 'plugin', plugin: 'dsh-expert-library' })
    assert.equal(calls[0][4], args[4])
    assert.equal(calls[0][5], 'queue')
  } finally {
    dispose()
  }
})

test('stacked guards each check once and disposal restores the previous layer', async () => {
  let deliveries = 0
  const original = async () => ++deliveries
  const runtime = { [deliverPrompt]: original }
  const firstChecks = []
  const secondChecks = []
  const disposeFirst = guardSubagentDelivery(runtime, allowAtMost(2, firstChecks))
  const firstGuard = runtime[deliverPrompt]
  const disposeSecond = guardSubagentDelivery(runtime, allowAtMost(1, secondChecks))
  try {
    assert.equal(await runtime[deliverPrompt](...deliveryArgs()), 1)
    assert.equal(firstChecks.length, 1)
    assert.equal(secondChecks.length, 1)
    disposeSecond()
    assert.equal(runtime[deliverPrompt], firstGuard)
    assert.equal(await runtime[deliverPrompt](...deliveryArgs()), 2)
    assert.equal(firstChecks.length, 2)
    assert.equal(secondChecks.length, 1)
  } finally {
    disposeSecond()
    disposeFirst()
  }
  assert.equal(runtime[deliverPrompt], original)
  assert.equal(await runtime[deliverPrompt](...deliveryArgs()), 3)
})

test('disposing an inner layer leaves the later guard active', async () => {
  let deliveries = 0
  const original = async () => ++deliveries
  const runtime = { [deliverPrompt]: original }
  const firstChecks = []
  const secondChecks = []
  const disposeFirst = guardSubagentDelivery(runtime, allowAtMost(0, firstChecks))
  const disposeSecond = guardSubagentDelivery(runtime, allowAtMost(1, secondChecks))
  const secondGuard = runtime[deliverPrompt]
  try {
    disposeFirst()
    assert.equal(runtime[deliverPrompt], secondGuard)
    assert.equal(await runtime[deliverPrompt](...deliveryArgs()), 1)
    assert.equal(firstChecks.length, 0)
    assert.equal(secondChecks.length, 1)
  } finally {
    disposeSecond()
    disposeFirst()
  }
  assert.equal(runtime[deliverPrompt], original)
})

test('disposal preserves later replacements and restores inherited delivery', async () => {
  const original = async () => 'original'
  const runtime = Object.create({ [deliverPrompt]: original })
  const dispose = guardSubagentDelivery(runtime, allowAtMost(0))
  dispose()
  assert.equal(Object.hasOwn(runtime, deliverPrompt), false)
  assert.equal(runtime[deliverPrompt], original)

  const disposeAgain = guardSubagentDelivery(runtime, allowAtMost(0))
  const replacement = async () => 'replacement'
  runtime[deliverPrompt] = replacement
  disposeAgain()
  assert.equal(runtime[deliverPrompt], replacement)
})
