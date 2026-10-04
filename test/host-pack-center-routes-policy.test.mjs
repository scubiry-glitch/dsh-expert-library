/**
 * HTTP boundary for the update-policy surface: strict projection of
 * GET /update-policy, 404 when the host did not wire the supplier, and the
 * reserved `auto-` operation-key rejection that keeps browser requests from
 * minting host-generated operations.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'

const { createPackCenterRouteHandler } = await import(process.env.PACK_ROUTES_SOURCE === '1'
  ? '../src/host/pack-center-routes.ts' : '../lib/host/pack-center-routes.js')
const prefix = '/plugins/dsh-expert-library/manage/center'
const timestamp = '2026-09-20T00:00:00.000Z'
const hash = 'a'.repeat(64)
const secret = `dpc_token_${'x'.repeat(43)}`
const connection = () => ({ configured: true, configuredOrigin: 'https://center.example', activationAvailable: true,
  revision: 1, connection: null })
const operation = input => ({ operationId: 'operation.one', request: input, status: 'succeeded', phase: 'completed',
  createdAt: timestamp, updatedAt: timestamp, credentialToken: secret,
  result: { generation: 1, outcome: 'succeeded', activated: false, releaseId: input?.releaseId } })
const policyView = () => ({
  mode: 'download', perPack: { 'demo.pack': 'manual' }, timerRunning: true, tickInFlight: false,
  intervalMs: 6 * 60 * 60 * 1000, nextCheckAt: timestamp, lastCheckAt: timestamp,
  lastCheckErrorCode: 'AUTO_WAIT_TIMEOUT', lastApplyAt: timestamp,
  recent: [{ packId: 'demo.pack', releaseId: 'release.one', version: '1.0.1', kind: 'install',
    operationKey: 'auto-install:release.one', at: timestamp, outcome: 'succeeded',
    detail: 'auto', token: secret, privatePath: '/root/.dsh/private/x' }],
  token: secret, privatePath: '/root/.dsh/private/y',
})

async function fixture(t, { handlerOptions = {}, overrides = {} } = {}) {
  const responses = { connection, bind: connection, unbind: connection, enqueue: input => operation(input),
    operations: () => [], operation: () => operation({ operationKey: 'auto-install:release.one', kind: 'install',
      expectedGeneration: 0, releaseId: 'release.one', connectionRevision: 1,
      target: { manifestSha256: hash, artifactSha256: hash, contentTreeSha256: hash } }),
    retry: input => operation(input), start: () => undefined, close: () => undefined, ...overrides }
  const service = Object.fromEntries(Object.entries(responses).map(([name, fn]) => [name, async (...args) => fn(...args)]))
  const handler = createPackCenterRouteHandler({ service, getManageToken: () => 'local-test-manage-token', ...handlerOptions })
  const server = createServer((req, res) => {
    void handler(req, res).then(handled => { if (!handled) { res.writeHead(418); res.end('not handled') } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const port = server.address().port
  return (path, { method = 'GET', value } = {}) => new Promise((resolve, reject) => {
    const payload = value === undefined ? undefined : JSON.stringify(value)
    const req = request({ host: '127.0.0.1', port, method, path: `${prefix}${path}`,
      headers: { 'x-pack-center-ui': '1', ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) } },
    res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

test('GET /update-policy projects a strict whitelist; unwired hosts 404', async t => {
  const send = await fixture(t, { handlerOptions: { updatePolicy: policyView } })
  const result = await send('/update-policy')
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true)
  const view = result.body.data
  assert.deepEqual(Object.keys(view).sort(), ['intervalMs', 'lastApplyAt', 'lastCheckAt', 'lastCheckErrorCode',
    'mode', 'nextCheckAt', 'perPack', 'recent', 'tickInFlight', 'timerRunning'])
  assert.equal(view.mode, 'download')
  assert.deepEqual(view.perPack, { 'demo.pack': 'manual' })
  assert.equal(view.lastCheckErrorCode, 'AUTO_WAIT_TIMEOUT', 'scheduler codes are whitelisted and survive')
  assert.deepEqual(view.recent, [{ packId: 'demo.pack', releaseId: 'release.one', version: '1.0.1', kind: 'install',
    operationKey: 'auto-install:release.one', at: timestamp, outcome: 'succeeded', detail: 'auto' }],
    'secrets and paths are stripped from auto action history')
  const text = JSON.stringify(result.body)
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes('/root/.dsh'), false)

  const unwired = await fixture(t)
  const missing = await unwired('/update-policy')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'CENTER_ROUTE_NOT_FOUND')
})

test('GET /update-policy fails closed on malformed scheduler data', async t => {
  for (const broken of [
    { ...policyView(), mode: 'aggressive' },
    { ...policyView(), perPack: { 'dpc_token_x': 'manual' } },
    { ...policyView(), recent: [{ packId: 'demo.pack', releaseId: 'release.one', version: '1.0.1', kind: 'install', operationKey: 'auto-install:release.one', at: 'not-a-date', outcome: 'succeeded' }] },
    { ...policyView(), recent: Array.from({ length: 21 }, (_, index) => ({ packId: 'demo.pack', releaseId: `release.${index}`, version: '1.0.1', kind: 'install', operationKey: `auto-install:release.${index}`, at: timestamp, outcome: 'skipped' })) },
  ]) {
    const send = await fixture(t, { handlerOptions: { updatePolicy: () => broken } })
    const result = await send('/update-policy')
    assert.equal(result.status, 502)
    assert.equal(result.body.error.code, 'CENTER_RESPONSE_INVALID')
  }
})

test('browser operations may not mint reserved auto- keys, but stored auto operations still project', async t => {
  const send = await fixture(t)
  const rejected = await send('/operations', { method: 'POST', value: {
    operationKey: 'auto-install:release.one', kind: 'install', expectedGeneration: 0,
    releaseId: 'release.one', connectionRevision: 1, target: { manifestSha256: hash, artifactSha256: hash, contentTreeSha256: hash } } })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.body.error.code, 'CENTER_OPERATION_KEY_RESERVED')
  // auto-install:<releaseId> is 1:1 with a release: the same release can never
  // be silently re-acquired under a lookalike manual key on a later version.
  const allowed = await send('/operations', { method: 'POST', value: {
    operationKey: 'manual.cache', kind: 'install', expectedGeneration: 0,
    releaseId: 'release.one', connectionRevision: 1, target: { manifestSha256: hash, artifactSha256: hash, contentTreeSha256: hash } } })
  assert.equal(allowed.status, 202)
  assert.equal(allowed.body.data.request.operationKey, 'manual.cache')
  // Projection of a stored auto operation keeps its key (strict=false path).
  const projected = await send('/operations/operation.one')
  assert.equal(projected.status, 200)
  assert.equal(projected.body.data.request.operationKey, 'auto-install:release.one')
})
