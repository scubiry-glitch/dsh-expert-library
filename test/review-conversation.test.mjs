import test from 'node:test'
import assert from 'node:assert/strict'
import { projectConversation, readReviewConversation, readReviewSharedTaskContext } from '../src/host/review-conversation.ts'
const text = text => ({ type: 'text', text })
const user = (seq, value, kind = 'user') => ({ seq, time: 1000 + seq, type: 'user/message', surfaceOp: 'append', data: { id: `u${seq}`, source: { kind }, content: [text(value)] } })
const assistant = (seq, content) => ({ seq, time: 1000 + seq, type: 'assistant/message', surfaceOp: 'append', data: { message: { id: `a${seq}`, content } } })
test('human transcript excludes tools, reasoning, synthetic prompts and compaction replacements', () => {
  const events = [user(0, '问题'), user(1, 'injected secret', 'plugin'),
    assistant(2, [{ type: 'reasoning', text: 'private reasoning' }, text('答复'), { type: 'tool-call', arguments: 'secret' }]),
    { ...user(3, 'replacement'), surfaceOp: { op: 'replace', start: 0, end: 2 } },
    { seq: 4, type: 'tool/result', data: { content: [text('tool secret')] } },
    assistant(5, [{ type: 'reasoning', text: 'private' }]),
    { ...assistant(6, [text('中断前回复')]), data: { ...assistant(6, [text('中断前回复')]).data, interrupted: true } }]
  const page = projectConversation(events)
  assert.deepEqual(page.messages.map(m => m.text), ['问题', '答复', '中断前回复'])
  assert.equal(page.messages[2].interrupted, true)
  assert.equal(page.nextCursor, 6)
  assert.equal(page.hasMore, false)
})
test('pagination and incremental reads never duplicate or skip visible messages', () => {
  const events = Array.from({ length: 65 }, (_, seq) => user(seq, `question ${seq}`))
  const first = projectConversation(events)
  const second = projectConversation(events, first.nextCursor)
  const third = projectConversation(events, second.nextCursor)
  assert.equal(first.messages.length, 30)
  assert.equal(second.hasMore, true)
  assert.equal(third.hasMore, false)
  assert.equal(new Set([...first.messages, ...second.messages, ...third.messages].map(m => m.id)).size, 65)
  assert.equal(projectConversation(events, third.nextCursor).messages.length, 0)
  assert.equal(projectConversation([...events, assistant(65, [text('new')])], third.nextCursor).messages[0].text, 'new')
})
test('failed model turns expose a safe status without leaking provider details', () => {
  const events = [user(0, '问题'), { seq: 1, type: 'turn/end', data: { reason: {
    kind: 'error', error: { code: 'QUOTA', message: 'private provider detail' } } } }]
  const first = projectConversation(events)
  assert.deepEqual(first.turnFailures, [{ seq: 1, kind: 'quota_exceeded' }])
  assert.equal(first.nextCursor, 1)
  assert.equal(JSON.stringify(first).includes('private provider detail'), false)
  assert.equal(projectConversation(events, first.nextCursor).turnFailures, undefined)
})
test('output limit after an interim assistant message remains visible as an unfinished turn', () => {
  const events = [user(0, '请完成任务'), assistant(1, [text('正在处理')]),
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }]
  const page = projectConversation(events)
  assert.deepEqual(page.messages.map(message => message.text), ['请完成任务', '正在处理'])
  assert.deepEqual(page.turnFailures, [{ seq: 2, kind: 'output_limit' }])
  assert.equal(page.nextCursor, 2)
})
test('cold session observation is released and inherited messages are excluded', async () => {
  let disposed = 0
  const ctx = { get: key => key === 'sessionQuery' ? { observeSession: async (id, options) => {
    assert.equal(id, 'captain'); assert.equal(options.projectionMode, 'none')
    return { header: { id }, inheritedEventCount: 1, events: [user(0, 'parent secret'), user(1, 'own')], [Symbol.dispose]() { disposed++ } }
  } } : undefined }
  assert.deepEqual((await readReviewConversation(ctx, 'captain', -1)).messages.map(m => m.text), ['own'])
  assert.equal(disposed, 1)
})
test('foreign and child observations fail closed and release their leases', async () => {
  for (const header of [{ id: 'other' }, { id: 'captain', origin: 'subagent' }]) {
    let disposed = false
    const ctx = { get: () => ({ observeSession: async () => ({ header, events: [user(0, 'secret')], inheritedEventCount: 0, [Symbol.dispose]() { disposed = true } }) }) }
    await assert.rejects(readReviewConversation(ctx, 'captain', -1), /UNAVAILABLE/)
    assert.equal(disposed, true)
  }
})

test('latest view returns the newest bounded page and remains ready for incremental replies', () => {
  const events = Array.from({ length: 65 }, (_, seq) => user(seq, `question ${seq}`))
  const page = projectConversation(events, -1, true)
  assert.equal(page.messages.length, 30)
  assert.equal(page.messages[0].seq, 35)
  assert.equal(page.messages.at(-1).seq, 64)
  assert.equal(page.hasEarlier, true)
  assert.equal(page.hasMore, false)
  assert.equal(projectConversation([...events, assistant(65, [text('new reply')])], page.nextCursor).messages[0].text, 'new reply')
})

test('cold context inspection preserves the frozen direct-user prefix and releases observation', async () => {
  const events = [user(1, '原要求'), assistant(2, [text('答复')]), user(3, '新增要求')]
  let released = 0
  const ctx = { get: key => key === 'sessionQuery' ? { observeSession: async () => ({
    header: { id: 'captain' }, inheritedEventCount: 1, events: [user(0, '父会话私有内容'), ...events],
    [Symbol.dispose]() { released++ },
  }) } : undefined }
  const baseline = await readReviewSharedTaskContext(ctx, 'captain')
  assert.deepEqual(baseline.messages.map(item => item.text), ['原要求', '新增要求'])
  const again = await readReviewSharedTaskContext(ctx, 'captain', baseline)
  assert.equal(again.sha256, baseline.sha256)
  assert.equal(released, 2)
})

test('main-session messages use normal Host admission with a stable request id and queue mode', async () => {
  const { sendReviewMessage } = await import('../src/host/review-conversation.ts')
  const calls = []
  let admitting = 0
  const ctx = { get: key => key === 'sessionController' ? {
    inspect: async id => ({ meta: { id } }),
    prompt: async (request, signal) => {
      assert.equal(admitting++, 0)
      assert.equal(signal.aborted, false)
      await new Promise(resolve => setTimeout(resolve, 5))
      calls.push(request); admitting--
      return { accepted: true }
    },
  } : undefined }
  await Promise.all([sendReviewMessage(ctx, 'captain', '补充要求', 'stable-request'), sendReviewMessage(ctx, 'captain', '补充要求', 'stable-request')])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { sessionId: 'captain', requestId: 'stable-request', mode: 'queue', content: [{ type: 'text', text: '补充要求' }] })
  assert.deepEqual(calls[1], calls[0])
})

test('sending refuses child or foreign sessions and unavailable Host admission', async () => {
  const { sendReviewMessage } = await import('../src/host/review-conversation.ts')
  for (const meta of [{ id: 'other' }, { id: 'captain', origin: 'subagent' }]) {
    const ctx = { get: () => ({ inspect: async () => ({ meta }), prompt: async () => { assert.fail('must not send') } }) }
    await assert.rejects(sendReviewMessage(ctx, 'captain', 'text', 'request'), /UNAVAILABLE/)
  }
  await assert.rejects(sendReviewMessage({ get: () => undefined }, 'captain', 'text', 'request'), /UNAVAILABLE/)
})

test('concise reply guidance applies to review-origin main-session messages and respects later ordinary prompts', async () => {
  const { reviewReplyGuidance } = await import('../src/host/review-conversation.ts')
  const prompt = user(1, '问题')
  prompt.data.source.rpcId = 'review-' + 'a'.repeat(24) + '-' + 'b'.repeat(32)
  const events = [prompt]
  const ctx = { agents: { currentInitiator: () => ({ session: { header: { origin: 'user' }, ownEvents: () => events } }) } }
  assert.match(reviewReplyGuidance(ctx), /100–200/)
  assert.match(reviewReplyGuidance(ctx), /完整报告/)
  events.push(user(2, 'system injection', 'plugin'))
  assert.match(reviewReplyGuidance(ctx), /先用一句话/)
  events.push(user(3, '普通聊天的新问题'))
  assert.equal(reviewReplyGuidance(ctx), '')
  assert.equal(reviewReplyGuidance({ agents: { currentInitiator: () => ({ session: { header: { origin: 'subagent' } } }) } }), '')
  assert.equal(reviewReplyGuidance({ agents: { currentInitiator: () => undefined } }), '')
})

test('newest-first history windows load the immediately preceding page without overlaps', () => {
  const events = Array.from({ length: 75 }, (_, seq) => user(seq, `question ${seq}`))
  const newest = projectConversation(events, -1, true)
  const older = projectConversation(events, -1, true, newest.messages[0].seq)
  const oldest = projectConversation(events, -1, true, older.messages[0].seq)
  assert.deepEqual(newest.messages.map(m => m.seq), Array.from({ length: 30 }, (_, i) => i + 45))
  assert.deepEqual(older.messages.map(m => m.seq), Array.from({ length: 30 }, (_, i) => i + 15))
  assert.deepEqual(oldest.messages.map(m => m.seq), Array.from({ length: 15 }, (_, i) => i))
  assert.equal(newest.hasEarlier, true)
  assert.equal(older.hasEarlier, true)
  assert.equal(oldest.hasEarlier, undefined)
  const fresh = projectConversation([...events, assistant(75, [text('new reply')])], newest.nextCursor)
  assert.deepEqual(fresh.messages.map(m => m.seq), [75])
})
