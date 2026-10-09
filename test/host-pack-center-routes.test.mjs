import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'

const { createPackCenterRouteHandler } = await import(process.env.PACK_ROUTES_SOURCE === '1'
  ? '../src/host/pack-center-routes.ts' : '../lib/host/pack-center-routes.js')
const prefix = '/plugins/dsh-expert-library/manage/center'
const timestamp = '2026-09-20T00:00:00.000Z'
const hash = 'a'.repeat(64)
const secret = `dpc_token_${'x'.repeat(43)}`
const code = `dpc_bind_${'y'.repeat(43)}`
const privatePath = '/root/.dsh/private/credentials.json'
const pem = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
const operationInput = (kind = 'install') => ({
  operationKey: 'user.operation.1', kind, expectedGeneration: 0,
  ...(kind === 'install' || kind === 'update_enable'
    ? { releaseId: 'release.one', connectionRevision: 1, target: { manifestSha256: hash, artifactSha256: hash, contentTreeSha256: hash } }
    : kind === 'rollback' ? { releaseId: 'release.one', packId: 'demo.pack' }
      : kind === 'disable' ? { packId: 'demo.pack' } : { releaseId: 'release.one' }),
})
const installation = () => ({ releaseId: 'release.one', packId: 'demo.pack', version: '1.0.0', source: 'center',
  centerId: 'center.one', ownerOrgId: 'org.one', installedAt: timestamp, active: true,
  artifactSha256: hash, contentTreeSha256: hash, manifestSha256: hash, integrity: 'verified',
  root: privatePath, token: secret })
const release = () => ({ releaseId: 'release.one', packId: 'demo.pack', version: '1.0.0', ownerOrgId: 'org.one',
  name: 'Demo', publishedAt: timestamp, manifestSha256: hash, artifactSha256: hash, contentTreeSha256: hash,
  compatibility: { compatible: true, reasons: [], token: secret }, downloadAvailability: { available: true, token: secret },
  dependencies: [{ packId: 'dependency.one', releaseId: 'dependency.release', version: '1.0.0', root: privatePath }],
  sourceCommit: 'a'.repeat(40), notes: 'Release notes', license: 'MIT',
  validation: { valid: true, diagnostics: [{ severity: 'warning', code: 'fixture', message: 'Check fixture', token: secret }], root: privatePath },
  diff: { available: true, text: 'A plain text diff', root: privatePath, fullDiff: { token: secret } },
  credentialToken: secret, trustedSigningKeys: { key: pem }, artifactPath: privatePath })
const connection = () => ({ configured: true, configuredOrigin: 'https://center.example', activationAvailable: true,
  revision: 1, connection: { origin: 'https://center.example', centerId: 'center.one', organizationId: 'org.one',
    deploymentId: 'deployment.one', credentialId: 'credential.one', credentialExpiresAt: '2026-10-20T00:00:00.000Z',
    boundAt: timestamp, bound: true, signingKeyFingerprints: { key: hash }, credentialToken: secret,
    trustedSigningKeys: { key: pem }, path: privatePath }, token: secret, privatePath })
const operation = (input = operationInput()) => ({ operationId: 'operation.one', request: { ...input, bindingCode: code, token: secret },
  status: 'queued', phase: 'queued', createdAt: timestamp, updatedAt: timestamp, credentialToken: secret,
  result: { generation: 1, outcome: 'succeeded', activated: false, releaseId: 'release.one', path: privatePath } })
const updates = () => ({ checkedAt: timestamp, hasSnapshot: true, stale: false, generation: 1, token: secret,
  items: [{ packId: 'demo.pack', current: installation(), latestVisible: release(), candidate: release(),
    candidateCached: false, status: 'update_available', blockedReasons: [{ releaseId: 'release.bad', reasons: ['INCOMPATIBLE_RELEASE'], token: secret }],
    privatePath }] })

async function fixture(t, overrides = {}, handlerOptions = {}) {
  const calls = []
  const responses = {
    connection, bind: connection, unbind: connection,
    catalog: () => ({ items: [release()], nextCursor: null, checkedAt: timestamp, hasSnapshot: true, stale: false, token: secret }),
    release, installations: () => ({ generation: 1, mode: 'normal', items: [installation()], token: secret }),
    updates, checkUpdates: updates, enqueue: input => operation(input), operations: () => [operation()],
    operation, retry: () => operation(), start: () => undefined, close: () => undefined, ...overrides,
  }
  const service = Object.fromEntries(Object.entries(responses).map(([name, fn]) => [name, async (...args) => {
    calls.push({ name, args }); return fn(...args)
  }]))
  let manageToken = 'local-test-manage-token'
  const handler = createPackCenterRouteHandler({ service, getManageToken: () => manageToken, ...handlerOptions })
  const server = createServer((req, res) => {
    void handler(req, res).then(handled => { if (!handled) { res.writeHead(418); res.end('not handled') } })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const port = server.address().port, authority = `127.0.0.1:${port}`
  async function send(path = '/connection', { method = 'GET', headers = {}, value, raw, rawHeaders } = {}) {
    const payload = raw ?? (value === undefined ? undefined : JSON.stringify(value))
    const requestHeaders = rawHeaders ?? { 'x-pack-center-ui': '1', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path: path.startsWith(prefix) ? path : `${prefix}${path}`, headers: requestHeaders }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          let body
          try { body = JSON.parse(text) } catch { body = text }
          resolve({ status: res.statusCode, headers: res.headers, body, text })
        })
      })
      req.once('error', reject)
      req.end(payload)
    })
  }
  return { server, port, authority, calls, send, setToken(value) { manageToken = value } }
}
const expectError = (response, status, code) => {
  assert.equal(response.status, status)
  assert.deepEqual(response.body, { ok: false, error: { code } })
  assert.equal(response.headers['access-control-allow-origin'], undefined)
  assert.equal(response.headers['access-control-allow-credentials'], undefined)
  assert.equal(response.headers['cache-control'], 'no-store')
}
const expectPrivate = response => {
  assert.equal(response.body.ok, true)
  for (const forbidden of [secret, code, pem, privatePath, 'credentialToken', 'trustedSigningKeys', 'fullDiff', 'artifactPath']) {
    assert.equal(response.text.includes(forbidden), false, `response must exclude private ${forbidden.slice(0, 12)}`)
  }
}

test('center route ownership is fixed; unrelated plugin routes fall through', async t => {
  const f = await fixture(t)
  assert.equal((await f.send(`${prefix}-other`)).status, 418)
  assert.equal((await f.send(`${prefix}evil/connection`)).status, 418)
  expectError(await f.send(''), 400, 'CENTER_INVALID_REQUEST')
  assert.equal(f.calls.length, 0)
})

test('all GET metadata requires the non-simple UI header; loopback itself is not a CSRF fence', async t => {
  const f = await fixture(t)
  for (const path of ['/connection', '/catalog', '/releases/release.one', '/installations', '/updates', '/operations', '/operations/operation.one']) {
    expectError(await f.send(path, { headers: { 'x-pack-center-ui': '' } }), 403, 'CENTER_UI_REQUIRED')
  }
  assert.equal(f.calls.length, 0)
  expectPrivate(await f.send('/connection'))
})

test('public and forwarded requests use a dynamically resolved manage token independently of cookies', async t => {
  const f = await fixture(t)
  const headers = { Host: 'dsh.example', Origin: 'https://dsh.example', 'Sec-Fetch-Site': 'same-origin',
    'X-Forwarded-For': '192.0.2.1', Cookie: 'harness-session=not-a-manage-token' }
  expectError(await f.send('/connection', { headers }), 403, 'MANAGE_UNAUTHORIZED')
  expectPrivate(await f.send('/connection', { headers: { ...headers, 'x-expert-library-manage-token': 'local-test-manage-token' } }))
  expectPrivate(await f.send('/connection', { headers: { ...headers, Authorization: 'Bearer local-test-manage-token' } }))
  f.setToken('rotated-local-token')
  expectError(await f.send('/connection', { headers: { ...headers, Authorization: 'Bearer local-test-manage-token' } }), 403, 'MANAGE_UNAUTHORIZED')
  expectPrivate(await f.send('/connection', { headers: { ...headers, Authorization: 'Bearer rotated-local-token' } }))
  f.setToken(undefined)
  expectError(await f.send('/connection', { headers: { ...headers, Authorization: 'Bearer rotated-local-token' } }), 403, 'MANAGE_UNAUTHORIZED')
  expectError(await f.send('/connection', { headers: { 'X-Forwarded-Host': 'dsh.example' } }), 403, 'MANAGE_UNAUTHORIZED')
})

test('any forwarding header presence disables loopback trust, including proto, Via, extensions and empty values', async t => {
  const f = await fixture(t)
  const forwarded = [
    ['X-Forwarded-Proto', 'https'], ['Via', '1.1 reverse-proxy'], ['X-Forwarded-Port', '443'],
    ['X-Forwarded-Arbitrary-Extension', 'proxy'], ['Forwarded', ''], ['X-Forwarded-For', ''],
    ['X-Forwarded-Host', ''], ['X-Forwarded-Proto', ''], ['Via', ''], ['X-Real-Ip', ''], ['Cf-Connecting-Ip', ''],
  ]
  for (const [name, value] of forwarded) {
    // req.socket and rewritten Host are both loopback, as with an unsafe proxy
    // configuration. Presence alone must require the private management token.
    expectError(await f.send('/connection', { headers: { [name]: value } }), 403, 'MANAGE_UNAUTHORIZED')
    const allowed = await f.send('/connection', { headers: { [name]: value, 'x-expert-library-manage-token': 'local-test-manage-token' } })
    assert.equal(allowed.status, 200); expectPrivate(allowed)
  }
  assert.equal(f.calls.length, forwarded.length)
  expectPrivate(await f.send('/connection', { headers: { Via: '', Authorization: 'Bearer local-test-manage-token' } }))
  f.setToken(undefined)
  expectError(await f.send('/connection', { headers: { 'X-Forwarded-Port': '443', Authorization: 'Bearer local-test-manage-token' } }), 403, 'MANAGE_UNAUTHORIZED')
  // Strict direct loopback access remains available when no intermediary header exists.
  expectPrivate(await f.send('/connection'))
})

test('Origin and Fetch Metadata reject localhost attacks, aliases, null and sibling-site requests', async t => {
  const f = await fixture(t)
  for (const Origin of ['null', 'https://evil.example', `http://user@${f.authority}`, `http://${f.authority}/`,
    `http://${f.authority}?x=1`, `http://${f.authority}#x`, `http://127.1:${f.port}`, `http://localhost:${f.port}`, 'file:///root']) {
    expectError(await f.send('/connection', { headers: { Origin } }), 403, 'CENTER_CSRF_REJECTED')
  }
  for (const site of ['cross-site', 'same-site', 'invalid', 'same-origin, cross-site']) {
    expectError(await f.send('/connection', { headers: { 'Sec-Fetch-Site': site } }), 403, 'CENTER_CSRF_REJECTED')
  }
  for (const Host of [`127.1:${f.port}`, `localhost.:${f.port}`, `localhost:${f.port}@evil.example`, 'LOCALHOST', '0177.0.0.1']) {
    expectError(await f.send('/connection', { headers: { Host } }), 403, 'CENTER_CSRF_REJECTED')
  }
  assert.equal(f.calls.length, 0)
  expectPrivate(await f.send('/connection', { headers: { Origin: `http://${f.authority}`, 'Sec-Fetch-Site': 'same-origin' } }))
  expectPrivate(await f.send('/connection', { headers: { 'Sec-Fetch-Site': 'none' } }))
})

test('duplicate security-sensitive raw headers are refused before service dispatch', async t => {
  const f = await fixture(t)
  for (const [name, value] of [['Host', f.authority], ['Origin', `http://${f.authority}`], ['X-Pack-Center-Ui', '1'],
    ['Authorization', 'Bearer local-test-manage-token'], ['X-Expert-Library-Manage-Token', 'local-test-manage-token'],
    ['Sec-Fetch-Site', 'same-origin'], ['X-Forwarded-For', '127.0.0.1'], ['X-Forwarded-Proto', 'https'],
    ['Via', ''], ['X-Forwarded-Port', '443'], ['X-Forwarded-Arbitrary-Extension', ''], ['Forwarded', ''],
    ['X-Real-Ip', ''], ['Cf-Connecting-Ip', ''], ['Cookie', 'fixture=1'], ['Content-Type', 'application/json']]) {
    const rawHeaders = [...(name.toLowerCase() === 'host' ? [] : ['Host', f.authority]),
      ...(name.toLowerCase() === 'x-pack-center-ui' ? [] : ['X-Pack-Center-Ui', '1']), name, value, name.toLowerCase(), value]
    expectError(await f.send('/connection', { rawHeaders }), 400, 'CENTER_INVALID_REQUEST')
  }
  assert.equal(f.calls.length, 0)
})

test('no CORS preflight, unsupported methods, encoded paths or arbitrary routes', async t => {
  const f = await fixture(t)
  for (const method of ['OPTIONS', 'PUT', 'PATCH', 'DELETE']) {
    expectError(await f.send('/connection', { method }), 405, 'CENTER_METHOD_NOT_ALLOWED')
  }
  expectError(await f.send('/connection', { method: 'OPTIONS', headers: { Origin: 'https://evil.example',
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-pack-center-ui' } }), 403, 'CENTER_CSRF_REJECTED')
  for (const path of ['/releases/%72elease.one', '/releases/..', '//connection', '/operations/a%2Fretry', '%2Fconnection', '/connection#secret']) {
    expectError(await f.send(path), 400, 'CENTER_INVALID_REQUEST')
  }
  expectError(await f.send('/unknown'), 404, 'CENTER_ROUTE_NOT_FOUND')
  expectError(await f.send('/unknown', { method: 'POST', value: {} }), 404, 'CENTER_ROUTE_NOT_FOUND')
  assert.equal(f.calls.length, 0)
})

test('catalog query parameters are whitelisted, singular and bounded', async t => {
  const f = await fixture(t)
  expectPrivate(await f.send('/catalog?packId=demo.pack&limit=100&beforeId=release.two'))
  assert.deepEqual(f.calls[0], { name: 'catalog', args: [{ packId: 'demo.pack', limit: 100, beforeId: 'release.two' }] })
  for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=1.0', 'limit=-1', 'limit=1&limit=2', 'token=secret',
    'packId=../../etc', 'packId=%00', 'packId=__proto__', 'packId=demo%2Fpack', 'beforeId=%zz', '']) {
    expectError(await f.send(`/catalog?${query}`), 400, 'CENTER_INVALID_INPUT')
  }
  expectError(await f.send('/connection?token=secret'), 400, 'CENTER_INVALID_INPUT')
  expectError(await f.send('/catalog?packId=a?x=1'), 400, 'CENTER_INVALID_REQUEST')
  expectError(await f.send('/unbind?x=1', { method: 'POST', value: { expectedRevision: 1 } }), 400, 'CENTER_INVALID_INPUT')
  assert.equal(f.calls.length, 1)
})

test('POST bodies require JSON, bounded UTF-8 and exact object keys before invoking the service', async t => {
  const f = await fixture(t)
  for (const raw of ['', '{', 'null', '[]', 'true', '{}', '{"expectedRevision":-1}', '{"expectedRevision":1.5}',
    '{"expectedRevision":"1"}', '{"expectedRevision":1,"token":"secret"}', '{"expectedRevision":1,"__proto__":{}}']) {
    expectError(await f.send('/unbind', { method: 'POST', raw }), 400, 'CENTER_INVALID_INPUT')
  }
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/json;charset=latin1']) {
    expectError(await f.send('/unbind', { method: 'POST', value: { expectedRevision: 1 }, headers: { 'Content-Type': type } }), 400, 'CENTER_INVALID_INPUT')
  }
  expectError(await f.send('/unbind', { method: 'POST', raw: Buffer.from([123, 34, 97, 34, 58, 34, 255, 34, 125]) }), 400, 'CENTER_INVALID_INPUT')
  expectError(await f.send('/unbind', { method: 'POST', value: { expectedRevision: 1 }, headers: { 'Content-Encoding': 'gzip' } }), 400, 'CENTER_INVALID_INPUT')
  expectError(await f.send('/unbind', { method: 'POST', raw: ' '.repeat(64 * 1024 + 1) }), 413, 'CENTER_BODY_TOO_LARGE')
  expectError(await f.send('/unbind', { method: 'POST', value: { expectedRevision: 1 }, headers: { 'Content-Length': '70000' } }), 413, 'CENTER_BODY_TOO_LARGE')
  assert.equal(f.calls.length, 0)
  expectPrivate(await f.send('/unbind', { method: 'POST', value: { expectedRevision: 1 }, headers: { 'Content-Type': 'application/json; charset=UTF-8' } }))
  assert.deepEqual(f.calls[0], { name: 'unbind', args: [{ expectedRevision: 1 }] })
})

test('streamed oversized JSON is rejected without dispatching or echoing its body', async t => {
  const f = await fixture(t)
  const response = await f.send('/unbind', { method: 'POST', raw: `{"secret":"${'a'.repeat(70_000)}"}`,
    headers: { 'Transfer-Encoding': 'chunked' } })
  expectError(response, 413, 'CENTER_BODY_TOO_LARGE')
  assert.equal(f.calls.length, 0)
})

test('body deadline includes slow streaming and returns no request content', async t => {
  const f = await fixture(t, {}, { bodyTimeoutMs: 40 })
  const raw = await new Promise((resolve, reject) => {
    const socket = connect(f.port, '127.0.0.1')
    const chunks = []
    socket.on('data', chunk => chunks.push(chunk))
    socket.once('error', reject)
    socket.once('end', () => resolve(Buffer.concat(chunks).toString()))
    socket.once('connect', () => socket.write(`POST ${prefix}/unbind HTTP/1.1\r\nHost: ${f.authority}\r\nX-Pack-Center-Ui: 1\r\nContent-Type: application/json\r\nContent-Length: 99\r\n\r\n{`))
    t.after(() => socket.destroy())
  })
  assert.match(raw, /^HTTP\/1\.1 408 /)
  assert.match(raw, /CENTER_BODY_TIMEOUT/)
  assert.equal(f.calls.length, 0)
})

test('binding is direct and its code/public key are not retained in operation DTOs or responses', async t => {
  const f = await fixture(t)
  const input = { bindingCode: code, expectedRevision: 0, expectedCenterId: 'center.one', trustedSigningKeys: { key: pem } }
  expectPrivate(await f.send('/bind', { method: 'POST', value: input }))
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].name, 'bind')
  assert.equal(f.calls[0].args[0].bindingCode, code)
  assert.equal(f.calls[0].args[0].trustedSigningKeys.key, pem)
  for (const changes of [{ bindingCode: secret }, { origin: 'https://evil.example' }, { expectedRevision: -1 }, { expectedCenterId: '../../root' },
    { trustedSigningKeys: {} }, { trustedSigningKeys: { key: '-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----\n' } }]) {
    expectError(await f.send('/bind', { method: 'POST', value: { ...input, ...changes } }), 400, 'CENTER_INVALID_INPUT')
  }
  assert.equal(f.calls.length, 1)
})

test('each operation kind has exact input requirements and returns a sanitized 202 job', async t => {
  const f = await fixture(t)
  for (const kind of ['install', 'update_enable', 'enable', 'disable', 'rollback', 'uninstall']) {
    const input = operationInput(kind)
    const response = await f.send('/operations', { method: 'POST', value: input })
    assert.equal(response.status, 202)
    expectPrivate(response)
    assert.deepEqual(response.body.data.request, input)
    assert.deepEqual(f.calls.at(-1), { name: 'enqueue', args: [input] })
    expectError(await f.send('/operations', { method: 'POST', value: { ...input, arbitrary: true } }), 400, 'CENTER_INVALID_INPUT')
  }
  for (const value of [
    { ...operationInput(), target: { ...operationInput().target, url: 'https://evil.example' } },
    { ...operationInput(), target: { ...operationInput().target, artifactSha256: 'A'.repeat(64) } },
    { ...operationInput(), packId: 'extra.pack' }, { ...operationInput(), connectionRevision: undefined },
    { ...operationInput(), operationKey: '__proto__' }, { ...operationInput(), operationKey: secret },
    { ...operationInput(), expectedGeneration: Number.MAX_SAFE_INTEGER + 1 }, { ...operationInput(), kind: 'bind' },
    { ...operationInput('enable'), connectionRevision: 1 }, { ...operationInput('disable'), releaseId: 'release.one' },
    { ...operationInput('rollback'), releaseId: undefined }, { ...operationInput('uninstall'), packId: 'demo.pack' },
  ]) expectError(await f.send('/operations', { method: 'POST', value }), 400, 'CENTER_INVALID_INPUT')
  assert.equal(f.calls.filter(call => call.name === 'enqueue').length, 6)
})

test('operation polling and explicit retry use stable IDs; retry body cannot change the target', async t => {
  const f = await fixture(t, { operation: () => operation() })
  expectPrivate(await f.send('/operations'))
  expectPrivate(await f.send('/operations/operation.one'))
  const retried = await f.send('/operations/operation.one/retry', { method: 'POST', value: {} })
  assert.equal(retried.status, 202); expectPrivate(retried)
  assert.deepEqual(f.calls.map(call => call.name), ['operations', 'operation', 'retry'])
  assert.deepEqual(f.calls[2].args, ['operation.one'])
  expectError(await f.send('/operations/operation.one/retry', { method: 'POST', value: { releaseId: 'release.changed' } }), 400, 'CENTER_INVALID_INPUT')
  expectError(await f.send('/operations/__proto__/retry', { method: 'POST', value: {} }), 400, 'CENTER_INVALID_INPUT')
})

test('all browser metadata is explicitly projected, including nested validation/diff/update/operation objects', async t => {
  const f = await fixture(t, { operation: () => operation() })
  for (const path of ['/connection', '/catalog', '/releases/release.one', '/installations', '/updates', '/operations', '/operations/operation.one']) {
    const response = await f.send(path)
    assert.equal(response.status, 200)
    expectPrivate(response)
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.match(response.headers['content-security-policy'], /default-src 'none'/)
  }
  expectPrivate(await f.send('/check-updates', { method: 'POST', value: {} }))
  expectError(await f.send('/check-updates', { method: 'POST', value: { autoInstall: true } }), 400, 'CENTER_INVALID_INPUT')
})

test('local legacy snapshot IDs remain visible without loosening remote release identifiers', async t => {
  const legacyId = `legacy.${hash}`
  const f = await fixture(t, { installations: () => ({ generation: 2, mode: 'normal', items: [{ ...installation(),
    source: 'legacy', releaseId: legacyId, previousReleaseId: `legacy.${'b'.repeat(64)}`, errorCode: 'LEGACY_VERIFIER_REQUIRED' }] }) })
  const response = await f.send('/installations')
  expectPrivate(response)
  assert.equal(response.body.data.items[0].releaseId, legacyId)
  assert.equal(response.body.data.items[0].previousReleaseId, `legacy.${'b'.repeat(64)}`)
  expectError(await f.send(`/releases/${legacyId}`), 400, 'CENTER_INVALID_INPUT')
})

test('text fields scrub credential, PEM and host-path accidents and never pass through object-shaped diffs', async t => {
  const f = await fixture(t, { release: () => ({ ...release(), notes: `${secret} ${code} ${pem} ${privatePath}`,
    diff: { available: true, text: `diff ${privatePath} Bearer abcdef /data/test/file C:\\private\\file` } }) })
  const response = await f.send('/releases/release.one')
  expectPrivate(response)
  assert.match(response.body.data.notes, /redacted/)
  assert.equal(response.body.data.diff.text, 'diff [redacted-path] Bearer [redacted] [redacted-path] [redacted-path]')
  const bad = await fixture(t, { release: () => ({ ...release(), diff: { available: true, text: { credentialToken: secret } } }) })
  expectError(await bad.send('/releases/release.one'), 502, 'CENTER_RESPONSE_INVALID')
})

test('service errors never expose raw messages, details, URLs, arbitrary code values or stacks', async t => {
  const f = await fixture(t, { connection: () => { throw Object.assign(new Error(`${secret} ${privatePath}`),
    { code: `EXFILTRATE_${secret}`, details: { token: secret }, path: privatePath }) } })
  expectError(await f.send('/connection'), 502, 'CENTER_REQUEST_FAILED')
  const g = await fixture(t, { enqueue: () => { throw Object.assign(new Error(secret), { code: 'GENERATION_CONFLICT', details: { path: privatePath } }) } })
  expectError(await g.send('/operations', { method: 'POST', value: operationInput() }), 409, 'GENERATION_CONFLICT')
  const h = await fixture(t, { operation: () => { throw { code: 'OPERATION_NOT_FOUND', reason: secret } } })
  expectError(await h.send('/operations/missing'), 404, 'OPERATION_NOT_FOUND')
})

test('ambiguous binding is one attempt, preserves only a safe reason and is never retried by the route', async t => {
  const f = await fixture(t, { bind: () => { throw Object.assign(new Error(secret),
    { code: 'CENTER_BIND_UNCONFIRMED', reason: 'CONNECTION_WRITE_FAILED', details: { bindingCode: code } }) } })
  const input = { bindingCode: code, expectedRevision: 0, expectedCenterId: 'center.one', trustedSigningKeys: { key: pem } }
  const response = await f.send('/bind', { method: 'POST', value: input })
  assert.equal(response.status, 409)
  assert.deepEqual(response.body, { ok: false, error: { code: 'CENTER_BIND_UNCONFIRMED', reason: 'CONNECTION_WRITE_FAILED' } })
  assert.equal(f.calls.length, 1)
  const unsafe = await fixture(t, { bind: () => { throw { code: 'CENTER_BIND_UNCONFIRMED', reason: secret } } })
  expectError(await unsafe.send('/bind', { method: 'POST', value: input }), 409, 'CENTER_BIND_UNCONFIRMED')
})

test('stale catalog and update snapshots retain safe errors instead of pretending an empty successful refresh', async t => {
  const f = await fixture(t, { catalog: () => ({ items: [release()], nextCursor: null, checkedAt: timestamp,
    hasSnapshot: true, stale: true, errorCode: 'UNAUTHENTICATED', credentialToken: secret }),
  updates: () => ({ ...updates(), stale: true, errorCode: 'CENTER_NETWORK_ERROR' }) })
  for (const path of ['/catalog', '/updates']) {
    const response = await f.send(path)
    expectPrivate(response)
    assert.equal(response.body.data.stale, true)
    assert.equal(response.body.data.hasSnapshot, true)
    assert.equal(response.body.data.items.length, 1)
  }
})
