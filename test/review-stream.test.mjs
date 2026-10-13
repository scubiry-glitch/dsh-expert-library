import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as wait } from 'node:timers/promises'
import { openReviewStream } from '../src/host/review-stream.ts'

const msg = seq => ({ id: `m${seq}`, seq, role: 'assistant', text: `reply ${seq}` })
function setup(extra = {}) {
  let listener, removed = 0
  const res = Object.assign(new EventEmitter(), {
    frames: [], destroyed: false, ended: false,
    write(frame) { this.frames.push(frame); return true },
    end() { this.ended = true; this.emit('close') },
  })
  const options = { after: 1, expiresAt: Date.now() + 60000, authorized: async () => true,
    subscribe(cb) { listener = cb; return () => removed++ },
    read: async after => ({ messages: [], nextCursor: after, hasMore: false }), ...extra }
  return { res, options, emit: e => listener(e), removed: () => removed,
    parsed: () => res.frames.map(f => ({ id: /^id: (\d+)/m.exec(f)?.[1], name: /^event: (.*)/m.exec(f)[1], data: JSON.parse(/^data: (.*)/m.exec(f)[1]) })) }
}

test('replay is gap-free when live messages race with multiple history pages', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const h = setup({ read: async after => {
    if (after === 1) { await gate; return { messages: [msg(2), msg(3)], nextCursor: 3, hasMore: true } }
    assert.equal(after, 3)
    return { messages: [msg(4)], nextCursor: 4, hasMore: false }
  } })
  const open = openReviewStream(h.res, h.options)
  h.emit({ type: 'conversation', message: msg(5) })
  h.emit({ type: 'conversation', message: msg(4) })
  assert.equal(h.res.frames.length, 0, 'live data cannot overtake replay')
  release(); await open
  const frames = h.parsed()
  assert.deepEqual(frames.filter(f => f.name === 'conversation').map(f => f.data.seq), [2, 3, 4, 5])
  assert.deepEqual(frames.map(f => Number(f.id)).filter(Number.isFinite), [2, 3, 3, 4, 4, 5, 5])
  h.res.end(); assert.equal(h.removed(), 1)
})

test('first connection snapshots while subscribed, then flushes only new durable messages', async () => {
  const h = setup({ after: -1, read: async (after, latest) => {
    assert.equal(after, -1); assert.equal(latest, true)
    h.emit({ type: 'conversation', message: msg(10) })
    h.emit({ type: 'conversation', message: msg(11) })
    return { messages: [msg(10)], nextCursor: 10, hasMore: false, hasEarlier: true }
  } })
  await openReviewStream(h.res, h.options)
  assert.deepEqual(h.parsed().map(f => f.name), ['snapshot', 'conversation', 'ready'])
  assert.equal(h.parsed()[1].data.seq, 11)
  h.res.end()
})

test('disconnect during observation cancels subscription and cannot publish afterwards', async () => {
  let release; const read = new Promise(r => { release = r })
  const h = setup({ read: () => read })
  const open = openReviewStream(h.res, h.options)
  h.res.end(); release({ messages: [msg(2)], nextCursor: 2, hasMore: false }); await open
  assert.equal(h.removed(), 1); assert.equal(h.res.frames.length, 0)
})

test('synchronous preview, slow writes, failed reads and buffer overflow all release resources', async () => {
  const h = setup({ subscribe(cb) { cb({ type: 'assistant', value: null }); return () => {} } })
  h.res.write = () => false
  await openReviewStream(h.res, h.options)
  assert.equal(h.res.ended, true)
  const failed = setup({ read: async () => { throw Error('offline') } })
  await openReviewStream(failed.res, failed.options)
  assert.deepEqual(failed.parsed().map(f => f.name), ['resync'])
  assert.equal(failed.removed(), 1)
  let release; const gate = new Promise(r => { release = r })
  const overflow = setup({ read: () => gate })
  const open = openReviewStream(overflow.res, overflow.options)
  for (let i = 0; i < 520; i++) overflow.emit({ type: 'state' })
  release({ messages: [], nextCursor: 1, hasMore: false }); await open
  assert.equal(overflow.removed(), 1); assert.equal(overflow.res.ended, true)
})

test('revocation terminates an idle stream and sends no later messages', async () => {
  const h = setup({ heartbeatMs: 10, authorized: async () => false })
  await openReviewStream(h.res, h.options); await wait(30)
  assert.equal(h.res.ended, true); assert.equal(h.removed(), 1)
  assert.equal(h.parsed().at(-1).name, 'access-expired')
  const count = h.res.frames.length
  h.emit({ type: 'conversation', message: msg(2) })
  assert.equal(h.res.frames.length, count)
})
