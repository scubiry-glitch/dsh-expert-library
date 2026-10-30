import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModelGateway, readGatewayConfig, UsageLedger } from '../server.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const tokens = { a: 'test-account-a-012345678901234567890123456789', b: 'test-account-b-012345678901234567890123456789' }
const session = 'session-11111111-1111-4111-8111-111111111111'

test('web search proxy requires a captain session and records successful results without exposing the upstream key', async t => {
  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  const calls = []
  const gateway = createModelGateway({ upstreamKey: 'server-only-key', accounts: [
    { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 1000, webSearchEnabled: true },
    { id: 'b', tokenHash: digest(tokens.b), dailyQuota: 1000 },
  ] }, { ledger, upstreamFetch: async (url, request) => {
    calls.push({ url, headers: request.headers, body: JSON.parse(request.body) })
    if (url.endsWith('/fetch')) return Response.json({ title: '文章', content: '原文正文' })
    return Response.json({ results: [{ title: '来源', url: 'https://example.com/one', summary: '摘要', content: 'private page body' }] })
  } })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const base = `http://127.0.0.1:${gateway.address().port}`
  const request = (headers, body) => fetch(`${base}/v1/tools/search`, { method: 'POST', headers, body: JSON.stringify(body) })
  const body = { query: '公开政策', count: 5, need_content: false }
  assert.equal((await request({}, body)).status, 401)
  assert.equal((await request({ authorization: `Bearer ${tokens.a}` }, body)).status, 400)
  const headers = { authorization: `Bearer ${tokens.a}`, 'x-deepseek-harness-session-id': session }
  assert.equal((await request({ ...headers, authorization: `Bearer ${tokens.b}` }, body)).status, 403)
  assert.equal((await request(headers, { ...body, need_content: true })).status, 400)
  const response = await request(headers, body)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { results: [{ title: '来源', url: 'https://example.com/one', summary: '摘要', site_name: null, date: null }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/tools/search')
  assert.equal(calls[0].headers.authorization, 'Bearer server-only-key')
  assert.equal(ledger.db.prepare('SELECT result_count FROM web_search_calls WHERE account_id=? AND session_id=?').get('a', session).result_count, 1)
  assert.equal((await request(headers, body)).status, 200)
  const fetchPage = (url) => fetch(`${base}/v1/tools/fetch`, { method: 'POST', headers,
    body: JSON.stringify({ url }) })
  assert.equal((await fetchPage('http://127.0.0.1/private')).status, 400)
  assert.equal((await fetchPage('https://example.com/?token=secret')).status, 400)
  const fetched = await fetchPage('https://example.com/article')
  assert.deepEqual(await fetched.json(), { title: '文章', content: '原文正文', truncated: false })
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM web_fetch_calls WHERE account_id=?').get('a').count, 1)
  for (let i = 0; i < 18; i++) ledger.recordSearch('a', session, 1)
  assert.equal((await request(headers, body)).status, 429)
  for (let i = 0; i < 9; i++) ledger.recordFetch('a', session)
  assert.equal((await fetchPage('https://example.com/article')).status, 429)
})

test('backend point ratio must be a positive whole number per account', t => {
  const dir = mkdtempSync(join(tmpdir(), 'model-gateway-points-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const configPath = join(dir, 'accounts.json'), keyPath = join(dir, 'provider.key')
  writeFileSync(keyPath, 'test-provider-key')
  const env = { MODEL_GATEWAY_CONFIG: configPath, MODEL_GATEWAY_KEY_FILE: keyPath,
    MODEL_GATEWAY_DB: join(dir, 'usage.sqlite'), MODEL_GATEWAY_PORT: '3190' }
  const base = { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 1000 }
  for (const ratio of [0, -1, 1.5, '1000', null]) {
    writeFileSync(configPath, JSON.stringify({ accounts: [{ ...base, tokensPerPoint: ratio }] }))
    assert.throws(() => readGatewayConfig(env), /invalid model gateway account/)
  }
  writeFileSync(configPath, JSON.stringify({ accounts: [{ ...base, tokensPerPoint: 1000 }] }))
  assert.equal(readGatewayConfig(env).accounts[0].tokensPerPoint, 1000)
})

test('output allowance is account scoped and bounded in configuration', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'model-gateway-output-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const configPath = join(dir, 'accounts.json'), keyPath = join(dir, 'provider.key')
  writeFileSync(keyPath, 'test-provider-key')
  const env = { MODEL_GATEWAY_CONFIG: configPath, MODEL_GATEWAY_KEY_FILE: keyPath,
    MODEL_GATEWAY_DB: join(dir, 'usage.sqlite'), MODEL_GATEWAY_PORT: '3190' }
  const base = { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 100_000 }
  for (const maxOutputTokens of [0, -1, 1.5, '16384', 32_769, null]) {
    writeFileSync(configPath, JSON.stringify({ accounts: [{ ...base, maxOutputTokens }] }))
    assert.throws(() => readGatewayConfig(env), /invalid model gateway account/)
  }
  writeFileSync(configPath, JSON.stringify({ accounts: [{ ...base, maxOutputTokens: 16_384 }] }))
  assert.equal(readGatewayConfig(env).accounts[0].maxOutputTokens, 16_384)
  for (const maxOutputTokensByProvider of [null, [], { unknown: 12_288 },
    { glm: 0 }, { zai: 32_769 }, { deepseek: '24576' }]) {
    writeFileSync(configPath, JSON.stringify({ accounts: [{ ...base, maxOutputTokensByProvider }] }))
    assert.throws(() => readGatewayConfig(env), /invalid model gateway account/)
  }
  writeFileSync(configPath, JSON.stringify({ accounts: [{ ...base,
    maxOutputTokensByProvider: { deepseek: 24_576, glm: 12_288, zai: 12_288 } }] }))
  assert.deepEqual(readGatewayConfig(env).accounts[0].maxOutputTokensByProvider,
    { deepseek: 24_576, glm: 12_288, zai: 12_288 })

  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  const requests = []
  const gateway = createModelGateway({ upstreamKey: 'test', glmKey: 'test-glm', zaiKey: 'test-zai', accounts: [
    { ...base, maxOutputTokens: 16_384, maxOutputTokensByProvider: {
      deepseek: 24_576, glm: 12_288, zai: 12_288,
    }, glmEnabled: true },
    { id: 'b', tokenHash: digest(tokens.b), dailyQuota: 100_000 },
  ] }, { ledger, upstreamFetch: async (_url, request) => {
    requests.push(JSON.parse(request.body))
    return new Response('data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { status: 200 })
  } })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const send = (token, max_tokens) => fetch(`http://127.0.0.1:${gateway.address().port}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [], stream: true, ...(max_tokens ? { max_tokens } : {}) }),
  })
  for (const [token, requested] of [[tokens.a, undefined], [tokens.a, 99_999], [tokens.b, 99_999]]) {
    const response = await send(token, requested)
    assert.equal(response.status, 200)
    await response.text()
  }
  const glm = await fetch(`http://127.0.0.1:${gateway.address().port}/glm/v1/messages`, {
    method: 'POST', headers: { 'x-api-key': tokens.a },
    body: JSON.stringify({ model: 'glm-5.3', messages: [], stream: true }),
  })
  assert.equal(glm.status, 200)
  await glm.text()
  const zai = await fetch(`http://127.0.0.1:${gateway.address().port}/zai/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.a}` },
    body: JSON.stringify({ model: 'glm-5.3', messages: [], stream: true, max_tokens: 99_999 }),
  })
  assert.equal(zai.status, 200)
  await zai.text()
  assert.deepEqual(requests.map(request => request.max_tokens), [24_576, 24_576, 8_192, 12_288, 12_288])
})

test('model gateway authenticates per account, accepts continuable members, meters provider usage and enforces quota', async t => {
  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  const upstreamCalls = []
  const gateway = createModelGateway({ upstreamKey: 'server-only-provider-key', accounts: [
    { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 1_000 },
    { id: 'b', tokenHash: digest(tokens.b), dailyQuota: 1 },
  ] }, { ledger, upstreamFetch: async (url, request) => {
    upstreamCalls.push({ url, authorization: request.headers.authorization, body: JSON.parse(request.body) })
    return new Response('data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":2}}}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } })
  } })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const base = `http://127.0.0.1:${gateway.address().port}`
  const body = JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'test' }], stream: true, max_tokens: 20 })
  const send = (token, sessionId = session) => fetch(`${base}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'x-deepseek-harness-session-id': sessionId,
  }, body })
  assert.equal((await send('invalid')).status, 401)
  assert.equal((await send(tokens.a, 'foreign')).status, 400)
  assert.equal((await send(tokens.b)).status, 429)
  const response = await send(tokens.a)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /\[DONE\]/)
  const member = await send(tokens.a, '386a36ea-e38d-4cb5-91cd-94dedeabfea9')
  assert.equal(member.status, 200)
  await member.text()
  const unattributed = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${tokens.a}` }, body })
  assert.equal(unattributed.status, 200)
  await unattributed.text()
  assert.equal(ledger.db.prepare(`SELECT session_id FROM model_calls WHERE account_id='a' AND session_id LIKE 'unattributed:%'`).get().session_id, 'unattributed:a')
  assert.deepEqual({ ...ledger.totals('a') }, { chargedTokens: 30, inputTokens: 15, cacheReadTokens: 6, outputTokens: 9, calls: 3 })
  assert.equal(ledger.totals('b').calls, 0)
  assert.equal(upstreamCalls.length, 3)
  assert.equal(upstreamCalls[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(upstreamCalls[0].authorization, 'Bearer server-only-provider-key')
  assert.deepEqual(upstreamCalls[0].body.stream_options, { include_usage: true })
  assert.equal((await fetch(`${base}/files`, { method: 'POST' })).status, 404)
})

test('internal usage is read-only, authenticated and scoped to requested configured account', async t => {
  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  const gateway = createModelGateway({ upstreamKey: 'test', usageToken: 'usage-reader-secret-01234567890123456789', accounts: [
    { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 1000, tokensPerPoint: 333 },
    { id: 'b', tokenHash: digest(tokens.b), dailyQuota: 2000, tokensPerPoint: 1_000_000 },
  ] }, { ledger })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const base = `http://127.0.0.1:${gateway.address().port}`
  const id = ledger.reserve({ accountId: 'a', sessionId: session, tokens: 100, dailyQuota: 1000 })
  ledger.finalize(id, { prompt_tokens: 7, completion_tokens: 3 }, 'complete')
  const path = '/internal/usage?account_id=a'
  assert.equal((await fetch(`${base}${path}`)).status, 401)
  assert.equal((await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${tokens.a}` } })).status, 401)
  const headers = { authorization: 'Bearer usage-reader-secret-01234567890123456789' }
  assert.equal((await fetch(`${base}/internal/usage?account_id=unknown`, { headers })).status, 404)
  assert.equal((await fetch(`${base}/internal/usage?account_id=a&account_id=b`, { headers })).status, 404)
  const a = await (await fetch(`${base}${path}`, { headers })).json()
  assert.deepEqual([a.dailyQuota, a.chargedTokens, a.remainingTokens, a.calls], [1000, 10, 990, 1])
  assert.deepEqual(a.points, { tokensPerPoint: 333, dailyQuotaCents: 301,
    chargedCents: 4, remainingCents: 297, days: [{ day: a.day, chargedCents: 4, calls: 1 }] })
  const b = await (await fetch(`${base}/internal/usage?account_id=b`, { headers })).json()
  assert.deepEqual([b.dailyQuota, b.chargedTokens, b.remainingTokens, b.calls], [2000, 0, 2000, 0])
  assert.deepEqual(b.points, { tokensPerPoint: 1_000_000, dailyQuotaCents: 1,
    chargedCents: 0, remainingCents: 1, days: [] })
})

test('missing provider usage retains a conservative charge', async t => {
  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  const gateway = createModelGateway({ upstreamKey: 'test', accounts: [{ id: 'a', tokenHash: digest(tokens.a), dailyQuota: 1_000 }] }, {
    ledger, upstreamFetch: async () => new Response('data: [DONE]\n\n', { status: 200 }),
  })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/chat/completions`, { method: 'POST', headers: {
    authorization: `Bearer ${tokens.a}`, 'x-deepseek-harness-session-id': session,
  }, body: JSON.stringify({ model: 'deepseek-chat', messages: [], stream: true, max_tokens: 20 }) })
  assert.equal(response.status, 200)
  await response.text()
  assert.ok(ledger.totals('a').chargedTokens > 20)
})

test('large DSH context can reserve quota for its tool-result follow-up', async t => {
  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  const gateway = createModelGateway({ upstreamKey: 'test', accounts: [
    { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 70_000 },
  ] }, { ledger, upstreamFetch: async () => new Response(
    'data: {"choices":[],"usage":{"prompt_tokens":20000,"completion_tokens":100}}\n\ndata: [DONE]\n\n', { status: 200 }) })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const body = JSON.stringify({ model: 'deepseek-chat', messages: [
    { role: 'user', content: 'context '.repeat(11_250) },
  ], stream: true, max_tokens: 100 })
  assert.ok(Buffer.byteLength(body) > 70_000)
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.a}`,
      'x-deepseek-harness-session-id': session }, body,
  })
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(ledger.totals('a').chargedTokens, 20_100)
})

test('a customer below the daily limit is not rejected by oversized JSON reservation', async t => {
  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  const prior = ledger.reserve({ accountId: 'a', sessionId: session, tokens: 366_567, dailyQuota: 500_000 })
  assert.ok(prior)
  const gateway = createModelGateway({ upstreamKey: 'test', accounts: [
    { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 500_000 },
  ] }, { ledger, upstreamFetch: async () => new Response(
    'data: {"choices":[],"usage":{"prompt_tokens":47000,"completion_tokens":500}}\n\ndata: [DONE]\n\n', { status: 200 }) })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const body = JSON.stringify({ model: 'deepseek-chat', messages: [
    { role: 'user', content: 'context '.repeat(25_000) },
  ], stream: true, max_tokens: 8_192 })
  assert.ok(Buffer.byteLength(body) > 200_000)
  const response = await fetch(`http://127.0.0.1:${gateway.address().port}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.a}`,
      'x-deepseek-harness-session-id': session }, body,
  })
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(ledger.totals('a').chargedTokens, 414_067)
})

test('authenticated reviewer requests above one megabyte remain bounded and metered', async t => {
  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  let upstreamCalls = 0
  const gateway = createModelGateway({ upstreamKey: 'test', accounts: [
    { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 2_000_000 },
  ] }, { ledger, upstreamFetch: async () => {
    upstreamCalls++
    return new Response('data: {"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\ndata: [DONE]\n\n', { status: 200 })
  } })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const request = content => fetch(`http://127.0.0.1:${gateway.address().port}/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${tokens.a}`,
      'x-deepseek-harness-session-id': session },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content }], stream: true }),
  })
  const allowed = await request('x'.repeat(1_200_000))
  assert.equal(allowed.status, 200)
  await allowed.text()
  assert.equal(ledger.totals('a').chargedTokens, 110)
  const recoveryHeadroom = await request('x'.repeat(4_100_000))
  assert.equal(recoveryHeadroom.status, 200)
  await recoveryHeadroom.text()
  const rejected = await request('x'.repeat(8_100_000))
  assert.equal(rejected.status, 400)
  assert.equal(upstreamCalls, 2)
})

test('GLM and ZAI routes are account gated, model allowlisted, and included in the same quota', async t => {
  const ledger = new UsageLedger()
  t.after(() => ledger.close())
  const calls = []
  const gateway = createModelGateway({ upstreamKey: 'deepseek-key', glmKey: 'glm-key', zaiKey: 'zai-key', accounts: [
    { id: 'a', tokenHash: digest(tokens.a), dailyQuota: 1000, glmEnabled: true },
    { id: 'b', tokenHash: digest(tokens.b), dailyQuota: 1000 },
  ] }, { ledger, upstreamFetch: async (url, request) => {
    calls.push({ url, headers: request.headers, body: JSON.parse(request.body) })
    return new Response(url.includes('anthropic')
      ? 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7,"cache_read_input_tokens":2,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n'
      : 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { status: 200 })
  } })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => gateway.close(resolve)))
  const base = `http://127.0.0.1:${gateway.address().port}`
  const request = (path, token, model, anthropic = false) => fetch(`${base}${path}`, {
    method: 'POST', headers: anthropic ? { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'test' }], stream: true, max_tokens: 20 }),
  })
  assert.equal((await request('/glm/v1/messages', tokens.b, 'glm-5.3', true)).status, 403)
  assert.equal((await request('/zai/chat/completions', tokens.b, 'glm-5.3')).status, 403)
  assert.equal((await request('/glm/v1/messages', tokens.a, 'arbitrary', true)).status, 400)
  assert.equal((await request('/zai/chat/completions', tokens.a, 'arbitrary')).status, 400)
  const glm = await request('/glm/v1/messages', tokens.a, 'glm-5.3', true)
  assert.equal(glm.status, 200); await glm.text()
  const beta = await request('/glm/v1/messages?beta=true', tokens.a, 'glm-5.3', true)
  assert.equal(beta.status, 200); await beta.text()
  const zai = await request('/zai/chat/completions', tokens.a, 'glm-5.3-flash')
  assert.equal(zai.status, 200); await zai.text()
  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, 'https://open.bigmodel.cn/api/anthropic/v1/messages')
  assert.equal(calls[0].headers['x-api-key'], 'glm-key')
  assert.equal(calls[0].body.stream_options, undefined)
  assert.equal(calls[1].url, 'https://open.bigmodel.cn/api/anthropic/v1/messages?beta=true')
  assert.equal(calls[2].url, 'https://api.z.ai/api/coding/paas/v4/chat/completions')
  assert.equal(calls[2].headers.authorization, 'Bearer zai-key')
  assert.deepEqual(calls[2].body.stream_options, { include_usage: true })
  assert.deepEqual({ ...ledger.totals('a') }, { chargedTokens: 31, inputTokens: 19, cacheReadTokens: 4, outputTokens: 8, calls: 3 })
  assert.equal(ledger.totals('b').calls, 0)
})
