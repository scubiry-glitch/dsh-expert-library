import test from 'node:test'
import assert from 'node:assert/strict'
import { ProviderRequestQueue } from '../lib/provider-request-queue.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
test('one provider shares FIFO capacity across captain/member requests; other providers continue', async () => {
  const q = new ProviderRequestQueue(p => p === 'limited' ? 1 : undefined)
  const first = await q.acquire('limited'), entered = []
  const second = q.acquire('limited').then(release => { entered.push('member'); return release })
  const third = q.acquire('limited').then(release => { entered.push('captain-next'); return release })
  const other = await q.acquire('other'); other()
  await tick(); assert.deepEqual(entered, [])
  first(); first(); const releaseSecond = await second
  assert.deepEqual(entered, ['member']); releaseSecond()
  const releaseThird = await third; assert.deepEqual(entered, ['member', 'captain-next']); releaseThird()
})
test('aborted queued work never dispatches or consumes the next permit', async () => {
  const q = new ProviderRequestQueue(() => 1), first = await q.acquire('p'), abort = new AbortController()
  const waiting = q.acquire('p', abort.signal); const rejected = assert.rejects(waiting, /caller canceled/)
  abort.abort(new Error('caller canceled')); await rejected
  const next = q.acquire('p'); first(); (await next)()
  await assert.rejects(q.acquire('p', abort.signal), /caller canceled/)
})
test('stream permit spans all chunks and is released on early return and thrown adapter errors', async () => {
  const q = new ProviderRequestQueue(() => 1), options = { provider: 'p', model: 'm', messages: [] }
  let cleaned = false
  const source = async function* () { try { yield {type:'first'}; yield {type:'second'} } finally { cleaned = true } }
  const stream = q.stream(options, source)[Symbol.asyncIterator](); await stream.next()
  let admitted = false; const next = q.acquire('p').then(release => { admitted = true; return release })
  await tick(); assert.equal(admitted, false)
  await stream.return(); assert.equal(cleaned, true); (await next)()
  await assert.rejects(async () => { for await (const _ of q.stream(options, async function* () { throw Error('provider failed') })) {} }, /provider failed/)
  ;(await q.acquire('p'))()
})
test('cancel after admission prevents adapter invocation and frees its permit', async () => {
  const q = new ProviderRequestQueue(() => 1), abort = new AbortController(); let called = false
  const stream = q.stream({ provider:'p', model:'m', messages:[], signal:abort.signal }, async function* () { called = true })
  const read = stream[Symbol.asyncIterator]().next(); abort.abort(new Error('cancel before dispatch'))
  await assert.rejects(read, /cancel before dispatch/); assert.equal(called, false); (await q.acquire('p'))()
})
test('hot lowering accounts for existing streams; absent limits remain unrestricted', async () => {
  let limit; const q = new ProviderRequestQueue(() => limit)
  const a = await q.acquire('p'), b = await q.acquire('p'); limit = 1
  let entered = false; const queued = q.acquire('p').then(release => { entered = true; return release })
  a(); await tick(); assert.equal(entered, false); b(); (await queued)(); assert.equal(entered, true)
})
test('dispose rejects queued work, preserves active stream cleanup, prevents new work', async () => {
  const q = new ProviderRequestQueue(() => 1), active = await q.acquire('p')
  const blocked = assert.rejects(q.acquire('p'), /DISPOSED/)
  q.dispose(); await blocked; active(); active(); await assert.rejects(q.acquire('p'), /DISPOSED/)
})
test('queue overflow is bounded and cancellation clears backlog without dispatch', async () => {
  const q = new ProviderRequestQueue(() => 1), release = await q.acquire('p'), controllers = []
  const rejected = []
  for (let i=0;i<128;i++) { const c = new AbortController(); controllers.push(c); rejected.push(assert.rejects(q.acquire('p',c.signal), /aborted/)) }
  await assert.rejects(q.acquire('p'), /FULL/)
  for(const c of controllers)c.abort(new Error('aborted'))
  await Promise.all(rejected); release(); (await q.acquire('p'))()
})
