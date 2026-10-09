import test from 'node:test'
import assert from 'node:assert/strict'

const { createPackCenterApi, CenterUiError, centerUiErrorCode, isOlderCenterVersion, PACK_CENTER_MANAGE_URL } = await import(
  process.env.PACK_CENTER_UI_SOURCE === '1' ? '../src/client/pack-center-api.ts' : '../lib/client/pack-center-api.js'
)
const blankConnection = { configured: true, configuredOrigin: 'https://center.example.test', activationAvailable: true, revision: 0, connection: null }
const catalog = { items: [], nextCursor: null, checkedAt: null, stale: false, hasSnapshot: false }
const operationInput = {
  kind: 'install', operationKey: 'same-key', expectedGeneration: 2, connectionRevision: 3, releaseId: 'release-fixed',
  target: { manifestSha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64), contentTreeSha256: 'c'.repeat(64) },
}
const operation = { operationId: 'op-one', request: operationInput, phase: 'queued', status: 'queued', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' }
const ok = value => new Response(JSON.stringify({ ok: true, data: value }), { headers: { 'content-type': 'application/json' } })

test('all UI requests are same-origin, no-store and marked; tokens are headers only', async () => {
  const requests = []
  const token = 'fixture-memory-only-token'
  const api = createPackCenterApi(token, async (url, init) => { requests.push({ url, init }); return ok(blankConnection) })
  assert.deepEqual(await api.connection(), blankConnection)
  const { url, init } = requests[0]
  assert.equal(url, `${PACK_CENTER_MANAGE_URL}/connection`)
  assert.equal(init.method, 'GET')
  assert.equal(init.cache, 'no-store')
  assert.equal(init.credentials, 'same-origin')
  assert.equal(init.mode, 'same-origin')
  assert.equal(init.redirect, 'error')
  assert.equal(init.headers['x-pack-center-ui'], '1')
  assert.equal(init.headers['x-expert-library-manage-token'], token)
  assert.equal(init.body, undefined)
  assert.equal(url.includes(token), false)
  assert.equal(init.headers.authorization, undefined)
  api.close()
})

test('bind/unbind use protected fixed routes and binding secrets never enter a URL', async () => {
  const requests = []
  const api = createPackCenterApi('', async (url, init) => { requests.push({ url, init }); return ok(blankConnection) })
  const binding = { bindingCode: 'one-time-code', expectedRevision: 0, expectedCenterId: 'center-a', trustedSigningKeys: { 'key-a': 'PUBLIC KEY fixture' } }
  await api.bind(binding)
  await api.unbind(0)
  assert.equal(requests[0].url, `${PACK_CENTER_MANAGE_URL}/bind`)
  assert.equal(requests[1].url, `${PACK_CENTER_MANAGE_URL}/unbind`)
  assert.deepEqual(JSON.parse(requests[0].init.body), binding)
  assert.deepEqual(JSON.parse(requests[1].init.body), { expectedRevision: 0 })
  for (const item of requests) {
    assert.equal(item.init.method, 'POST')
    assert.equal(item.init.headers['content-type'], 'application/json')
    assert.equal(item.url.includes(binding.bindingCode), false)
    assert.equal(item.init.headers['x-expert-library-manage-token'], undefined)
  }
  api.close()
})

test('catalog filters are URL encoded and cannot change the fixed origin or route', async () => {
  let requested
  const api = createPackCenterApi('', async (url) => { requested = url; return ok(catalog) })
  await api.catalog({ packId: 'a&beforeId=https://bad.test', limit: 20, beforeId: 'id?/../secret' })
  const url = new URL(requested, 'https://local.test')
  assert.equal(url.origin, 'https://local.test')
  assert.equal(url.pathname, `${PACK_CENTER_MANAGE_URL}/catalog`)
  assert.equal(url.searchParams.get('packId'), 'a&beforeId=https://bad.test')
  assert.equal(url.searchParams.get('beforeId'), 'id?/../secret')
  assert.equal(url.searchParams.get('limit'), '20')
  api.close()
})

test('ambiguous writes do not automatically retry; explicit retry retains exact immutable request', async () => {
  const requests = []
  const api = createPackCenterApi('', async (url, init) => {
    requests.push({ url, init })
    if (requests.length === 1) throw new Error('fixture-secret-in-network-error')
    return ok(operation)
  })
  await assert.rejects(api.enqueue(operationInput), error => error.code === 'REQUEST_FAILED' && !error.message.includes('fixture-secret'))
  assert.equal(requests.length, 1)
  assert.deepEqual(await api.enqueue(operationInput), operation)
  assert.equal(requests[0].init.body, requests[1].init.body)
  assert.deepEqual(JSON.parse(requests[1].init.body).target, operationInput.target)
  assert.equal(JSON.parse(requests[1].init.body).operationKey, 'same-key')
  api.close()
})

test('operation recovery reads never submit writes; retry is a separate explicit fixed route', async () => {
  const requests = []
  const api = createPackCenterApi('', async (url, init) => {
    requests.push({ url, init })
    return ok(url.endsWith('/operations') ? [operation] : operation)
  })
  await api.operations()
  await api.operation('op-one')
  await api.retry('op-one')
  assert.deepEqual(requests.map(item => item.init.method), ['GET', 'GET', 'POST'])
  assert.equal(requests[2].url, `${PACK_CENTER_MANAGE_URL}/operations/op-one/retry`)
  assert.deepEqual(JSON.parse(requests[2].init.body), {})
  api.close()
})

test('connection close aborts outstanding requests and rejects late responses or future calls', async () => {
  let resolveResponse, signal, calls = 0
  const api = createPackCenterApi('old-token', async (_url, init) => {
    calls++; signal = init.signal
    return await new Promise(resolve => { resolveResponse = resolve })
  })
  const pending = api.connection()
  const rejected = assert.rejects(pending, error => error.code === 'REQUEST_ABORTED')
  api.close()
  assert.equal(signal.aborted, true)
  resolveResponse(ok(blankConnection))
  await rejected
  await assert.rejects(api.connection(), error => error.code === 'REQUEST_ABORTED')
  assert.equal(calls, 1)
})

test('errors expose only bounded safe codes, never response reasons, tokens, HTML or raw exceptions', async () => {
  for (const [response, expected] of [
    [new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', reason: 'fixture-secret-password' } }), { status: 403 }), 'FORBIDDEN'],
    [new Response(JSON.stringify({ ok: false, error: { code: 'fixture secret /private/token' } }), { status: 500 }), 'REQUEST_FAILED'],
    [new Response('<script>fixture-secret</script>', { status: 502 }), 'INVALID_RESPONSE'],
  ]) {
    const api = createPackCenterApi('', async () => response)
    await assert.rejects(api.connection(), error => error.code === expected && !error.message.includes('fixture-secret'))
    api.close()
  }
  assert.equal(centerUiErrorCode(new Error('fixture-private-path')), 'REQUEST_FAILED')
  assert.equal(centerUiErrorCode(new CenterUiError('FORBIDDEN')), 'FORBIDDEN')
})

test('malformed DTOs never enter component state', async () => {
  const cases = [
    ['connection', { ...blankConnection, revision: -1 }],
    ['catalog', { ...catalog, items: [{}] }],
    ['installations', { generation: 0, mode: 'normal', items: [{ source: 'center' }] }],
    ['updates', { ...catalog, generation: 1, items: [{ status: 'up_to_date' }] }],
    ['operations', [{ ...operation, request: { ...operationInput, kind: 'run_shell' } }]],
    ['operation', { ...operation, errorCode: { private: 'fixture-secret' } }],
  ]
  for (const [method, value] of cases) {
    const api = createPackCenterApi('', async () => ok(value))
    await assert.rejects(api[method]('op-one'), error => error.code === 'INVALID_RESPONSE')
    api.close()
  }
})

test('oversized local responses are cancelled and reported without body text', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) },
    cancel() { cancelled = true },
  })
  const api = createPackCenterApi('', async () => new Response(stream))
  await assert.rejects(api.connection(), error => error.code === 'RESPONSE_TOO_LARGE')
  assert.equal(cancelled, true)
  api.close()
})

test('rollback display comparator follows SemVer rather than lexical or unsafe numeric ordering', () => {
  for (const [candidate, current, expected] of [
    ['1.9.0', '1.10.0', true], ['2.0.0', '1.10.0', false], ['1.0.0', '1.0.0', false],
    ['1.0.0-rc.1', '1.0.0', true], ['1.0.0', '1.0.0-rc.1', false],
    ['1.0.0-alpha.2', '1.0.0-alpha.10', true], ['1.0.0-alpha', '1.0.0-beta', true],
    ['1.0.0-1', '1.0.0-alpha', true], ['1.0.0-rc', '1.0.0-rc.1', true],
    ['1.0.0+old', '1.0.0+new', false], ['01.0.0', '2.0.0', false], ['1.0.0-01', '2.0.0', false],
    ['no-version', '1.0.0', false], ['9007199254740992.0.0', '9007199254740993.0.0', true],
  ]) assert.equal(isOlderCenterVersion(candidate, current), expected, `${candidate} < ${current}`)
})
