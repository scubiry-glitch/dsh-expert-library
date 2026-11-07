import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
const start = source.indexOf("continueAfterLimit.addEventListener('click', async () => {")
const end = source.indexOf('\nfunction needsLiveUpdates()', start)
assert.ok(start >= 0 && end > start, 'the recovery button handler must exist')

function recoveryHarness() {
  let click, complete, fail
  const sent = [], notices = []
  const state = {
    currentSessionId: 'session-a', conversationEpoch: 1,
    conversationInput: { value: '', focus() {} },
    continueAfterLimit: { addEventListener: (_event, handler) => { click = handler } },
    apiFetch: () => new Promise((resolve, reject) => { complete = resolve; fail = reject }),
    sendConversationMessage: async () => { sent.push(state.conversationInput.value) },
    setComposeNotice: message => { notices.push(message) },
    updateComposeStatus() {},
  }
  // Execute the production click handler with a deferred network response.
  vm.runInNewContext(source.slice(start, end), state)
  return { state, sent, notices, click: () => click(), fail: () => fail(new Error('network unavailable')),
    complete: () => complete({ ok: true, json: async () => ({ prompt: '从已保存的进度继续。' }) }) }
}

test('recovery sends the checkpoint when the session and empty draft are unchanged', async () => {
  const h = recoveryHarness()
  const pending = h.click()
  h.complete()
  await pending
  assert.deepEqual(h.sent, ['从已保存的进度继续。'])
})

test('recovery preserves a draft entered while the checkpoint request is pending', async () => {
  const h = recoveryHarness()
  const pending = h.click()
  h.state.conversationInput.value = '请先核对我的新问题。'
  h.complete()
  await pending
  assert.equal(h.state.conversationInput.value, '请先核对我的新问题。')
  assert.deepEqual(h.sent, [])
  assert.match(h.notices.at(-1), /已保留新草稿/)
})

test('recovery ignores responses after switching away and back to the same session', async () => {
  for (const failed of [false, true]) {
    const h = recoveryHarness()
    const pending = h.click()
    h.state.currentSessionId = 'session-b'
    h.state.conversationEpoch++
    h.state.currentSessionId = 'session-a'
    h.state.conversationEpoch++
    if (failed) h.fail()
    else h.complete()
    await pending
    assert.equal(h.state.conversationInput.value, '')
    assert.deepEqual(h.sent, [])
    assert.deepEqual(h.notices, [])
  }
})
