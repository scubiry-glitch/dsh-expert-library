import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm, stat, readdir, unlink, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = new URL(process.env.PACK_CENTER_TRANSPORT_SOURCE === '1'
  ? '../src/host/pack-center-transport.ts' : '../lib/host/pack-center-transport.js', import.meta.url)
const { createPackCenterTransport, normalizePackCenterOrigin } = await import(moduleUrl.href)
const token = `dpc_token_${'s'.repeat(43)}`
const grant = 'g'.repeat(43)
const bindingCode = `dpc_bind_${'b'.repeat(43)}`
const artifact = Buffer.from('immutable approved domain-pack bytes\n')
const sha256 = createHash('sha256').update(artifact).digest('hex')
const artifactPath = '/api/v1/releases/release-1/artifact'
const downloadOptions = { credentialToken: token, downloadGrant: grant, expectedSha256: sha256, expectedBytes: artifact.length }
const run = promisify(execFile)

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pack-center-transport-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function listen(t, handler, tls) {
  const server = tls ? createHttpsServer(tls, handler) : createHttpServer(handler)
  server.on('clientError', (_failure, socket) => socket.destroy())
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`
  return { origin, server, transport: createPackCenterTransport({ origin, allowLoopbackHttp: true, timeoutMs: 5000 }) }
}
function sendJson(response, value, status = 200, headers = {}) {
  const bytes = Buffer.from(JSON.stringify(value))
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, ...headers })
  response.end(bytes)
}
function sendArtifact(response, body = artifact, headers = {}) {
  response.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': body.length, ...headers })
  response.end(body)
}
async function rejectsSafe(promise, code, status) {
  await assert.rejects(promise, failure => {
    assert.equal(failure.code, code)
    assert.equal(failure.message, code)
    if (status !== undefined) assert.equal(failure.status, status)
    assert.equal(failure.cause, undefined)
    for (const secret of [token, grant, bindingCode, 'remote-private-details', '127.0.0.1']) {
      assert.equal(String(failure.stack).includes(secret), false)
      assert.equal(JSON.stringify(failure).includes(secret), false)
    }
    return true
  })
}
async function absent(path) { await assert.rejects(stat(path), { code: 'ENOENT' }) }

test('origin accepts explicit HTTPS centers and only explicit canonical test-loopback HTTP', () => {
  for (const value of ['https://center.example', 'https://center.internal:8443', 'https://127.0.0.1', 'https://[::1]:9443']) {
    assert.equal(normalizePackCenterOrigin(value), value)
    assert.equal(normalizePackCenterOrigin(`${value}/`), value)
  }
  assert.equal(normalizePackCenterOrigin('HTTPS://CENTER.EXAMPLE:443/'), 'https://center.example')
  for (const value of ['http://localhost:8123', 'http://127.0.0.1:8123', 'http://[::1]:8123']) {
    assert.throws(() => normalizePackCenterOrigin(value), { code: 'CENTER_INVALID_ORIGIN' })
    assert.throws(() => normalizePackCenterOrigin(value, 'true'), { code: 'CENTER_INVALID_ORIGIN' })
    assert.equal(normalizePackCenterOrigin(value, true), value)
  }
  for (const value of ['', ' https://center.example', 'https://center.example ', 'https://user:secret@center.example',
    'https://center.example/path', 'https://center.example/?', 'https://center.example/#', 'https://center.example/..',
    'https://center.example\\evil', 'https:///center.example', 'https://center.example//', 'https://center..example',
    'https://center.example.', 'https://center.example:0', 'http://127.1', 'http://2130706433', 'http://0177.0.0.1',
    'http://0x7f000001', 'http://center.internal', 'file:///tmp/private', 'https://center.example%2f.evil']) {
    assert.throws(() => normalizePackCenterOrigin(value, true), { code: 'CENTER_INVALID_ORIGIN' }, value)
  }
})

test('transport bounds configuration and refuses production test CA overrides', () => {
  for (const extra of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 300001 }, { maxJsonBytes: 0 },
    { maxJsonBytes: 16 * 1024 * 1024 + 1 }, { testCa: 'untrusted' }]) {
    assert.throws(() => createPackCenterTransport({ origin: 'https://center.internal', ...extra }), { code: 'CENTER_INVALID_REQUEST' })
  }
})

test('host JSON exchange sends no browser identity headers and never carries the binding code in URL', async t => {
  let observed
  const { transport } = await listen(t, async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    observed = { method: request.method, url: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }
    sendJson(response, { credentialToken: token, credential: { id: 'credential-1' } })
  })
  assert.deepEqual(await transport.json('/api/v1/deployment-bindings/exchange', { method: 'POST', body: { bindingCode } }),
    { credentialToken: token, credential: { id: 'credential-1' } })
  assert.equal(observed.method, 'POST')
  assert.equal(observed.url, '/api/v1/deployment-bindings/exchange')
  assert.deepEqual(observed.body, { bindingCode })
  for (const name of ['cookie', 'origin', 'authorization', 'referer']) assert.equal(observed.headers[name], undefined)
  assert.equal(Object.keys(observed.headers).some(name => name.startsWith('sec-fetch-')), false)
  assert.equal(observed.headers['accept-encoding'], 'identity')
})

test('catalog and grant requests carry only Bearer host authority; Set-Cookie is never replayed', async t => {
  const observations = []
  const { transport } = await listen(t, async (request, response) => {
    observations.push({ headers: request.headers, url: request.url, method: request.method })
    sendJson(response, { items: [] }, request.method === 'POST' ? 201 : 200, { 'Set-Cookie': 'browser-session=must-not-replay; Path=/' })
  })
  await transport.json('/api/v1/releases?limit=100&beforeId=release-2&packId=acme.notes', { credentialToken: token })
  await transport.json('/api/v1/releases/release-1', { credentialToken: token })
  await transport.json('/api/v1/releases/release-1/download-grants', { method: 'POST', credentialToken: token, body: {} })
  assert.equal(observations.length, 3)
  for (const item of observations) {
    assert.equal(item.headers.authorization, `Bearer ${token}`)
    assert.equal(item.headers.cookie, undefined)
    assert.equal(item.headers.origin, undefined)
    assert.equal(Object.keys(item.headers).some(name => name.startsWith('sec-fetch-')), false)
    assert.equal(item.url.includes(token), false)
  }
})

test('invalid paths, unknown operations, query credentials, and header injection fail before any network call', async t => {
  let calls = 0
  const { transport } = await listen(t, (_request, response) => { calls++; sendJson(response, {}) })
  for (const path of ['https://evil.example/api/v1/releases', '//evil.example/api/v1/releases', '/api/v1//releases', '/api/me',
    '/api/v1/../releases', '/api/v1/releases/%2e%2e', '/api/v1/releases/%252e%252e', '/api/v1/releases/release%2f1',
    '/api/v1/releases/release-1/../artifact', '/api/v1/releases/release-1/artifact', '/api/v1/releases?credentialToken=secret',
    '/api/v1/releases?%74oken=secret', '/api/v1/releases?limit=1&limit=2', '/api/v1/releases?limit=0', '/api/v1/releases?limit=101',
    '/api/v1/releases?beforeId=..', '/api/v1/releases?packId=ok%252fsecret', '/api/v1/releases?limit=%zz',
    '/api/v1/releases?limit=1#token', '/api/v1/releases?limit=1?', '/api/v1/releases/release-1?limit=1',
    '/api/v1/releases/constructor', '/api/v1/deployments', '/api/v1/releases\r\nCookie: secret']) {
    await rejectsSafe(transport.json(path, { credentialToken: token }), 'CENTER_INVALID_REQUEST')
  }
  for (const options of [{ credentialToken: `${token}\r\nCookie: leaked` }, { method: 'DELETE' }, { body: {} }]) {
    await rejectsSafe(transport.json('/api/v1/releases', options), 'CENTER_INVALID_REQUEST')
  }
  await rejectsSafe(transport.json('/api/v1/deployment-bindings/exchange', { method: 'POST', credentialToken: token }), 'CENTER_INVALID_REQUEST')
  assert.equal(calls, 0)
})

test('redirects are rejected without leaking credentials or performing a second request', async t => {
  let calls = 0, destinationCalls = 0
  const target = await listen(t, (_request, response) => { destinationCalls++; sendJson(response, {}) })
  const { transport } = await listen(t, (_request, response) => {
    calls++
    response.writeHead(307, { Location: `${target.origin}/api/v1/releases?remote-private-details=${token}` })
    response.end()
  })
  await rejectsSafe(transport.json('/api/v1/releases', { credentialToken: token }), 'CENTER_REDIRECT_DENIED', 307)
  assert.equal(calls, 1)
  assert.equal(destinationCalls, 0)
})

test('JSON requires UTF-8 application/json, non-scalar JSON, and uncompressed complete responses', async t => {
  const variants = [
    { type: 'text/html', body: '{}' }, { type: 'application/json; charset=latin1', body: '{}' },
    { type: 'application/json', body: '{invalid' }, { type: 'application/json', body: 'null' },
    { type: 'application/json', body: '"secret"' }, { type: 'application/json', body: Buffer.from([0x7b, 0x22, 0xc3, 0x22, 0x3a, 0x31, 0x7d]) },
    { type: 'application/json', body: Buffer.from('\ufeff{}') },
    { type: 'application/json', body: '{}', extra: { 'Content-Encoding': 'gzip' } },
    { type: 'application/json', body: '{}', extra: { 'Content-Encoding': 'identity' } },
    { type: 'application/json', body: '{}', extra: { 'Content-Range': 'bytes 0-1/2' } },
    { type: 'application/json', body: '{}', status: 206 }, { type: 'application/json', body: '', status: 204 },
  ]
  let index = 0
  const { transport } = await listen(t, (_request, response) => {
    const item = variants[index++]
    response.writeHead(item.status ?? 200, { 'Content-Type': item.type, ...item.extra })
    response.end(item.body)
  })
  for (const _item of variants) await rejectsSafe(transport.json('/api/v1/releases'), 'CENTER_RESPONSE_INVALID')
  assert.equal(index, variants.length)
})

test('JSON size limits stop declared oversized and chunked oversized bodies', async t => {
  let calls = 0
  const { origin } = await listen(t, (_request, response) => {
    calls++
    const body = JSON.stringify({ value: 'x'.repeat(1000) })
    response.writeHead(200, { 'Content-Type': 'application/json', ...(calls === 1 ? { 'Content-Length': Buffer.byteLength(body) } : {}) })
    response.end(body)
  })
  const transport = createPackCenterTransport({ origin, allowLoopbackHttp: true, maxJsonBytes: 64 })
  for (let index = 0; index < 2; index++) await rejectsSafe(transport.json('/api/v1/releases'), 'CENTER_RESPONSE_TOO_LARGE')
})

test('truncated JSON and disconnected sockets do not retry or expose raw network exceptions', async t => {
  let calls = 0
  const { transport } = await listen(t, (_request, response) => {
    calls++
    if (calls === 1) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 100 })
      response.write('{')
      setImmediate(() => response.destroy(new Error(`remote-private-details ${token}`)))
    } else response.destroy()
  })
  await rejectsSafe(transport.json('/api/v1/releases'), 'CENTER_NETWORK_ERROR')
  assert.equal(calls, 1)
  await rejectsSafe(transport.json('/api/v1/releases'), 'CENTER_NETWORK_ERROR')
  assert.equal(calls, 2)
})

test('HTTP errors preserve only a fixed allowlisted code and safe status, never remote message/code text', async t => {
  let calls = 0
  const variants = [
    { error: { code: 'UNAUTHENTICATED', message: `${token} remote-private-details`, requestId: bindingCode } },
    { error: { code: `UPSTREAM_${token}`, message: grant } },
    { error: { code: 'SOME_NEW_SAFE_LOOKING_CODE', message: grant } },
  ]
  const { transport } = await listen(t, (_request, response) => sendJson(response, variants[calls++], 401))
  await rejectsSafe(transport.json('/api/v1/releases'), 'UNAUTHENTICATED', 401)
  for (let index = 0; index < 2; index++) await rejectsSafe(transport.json('/api/v1/releases'), 'CENTER_HTTP_ERROR', 401)
  assert.equal(calls, 3)
})

test('one total JSON timeout includes delayed headers and an endlessly trickling body', async t => {
  let calls = 0
  const timers = []
  const { origin } = await listen(t, (_request, response) => {
    calls++
    if (calls === 1) return
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{"value":"')
    const interval = setInterval(() => response.write('x'), 5)
    timers.push(interval)
    response.on('close', () => clearInterval(interval))
  })
  t.after(() => timers.forEach(clearInterval))
  const transport = createPackCenterTransport({ origin, allowLoopbackHttp: true, timeoutMs: 250 })
  for (let index = 0; index < 2; index++) {
    const start = Date.now()
    await rejectsSafe(transport.json('/api/v1/releases'), 'CENTER_TIMEOUT')
    assert.ok(Date.now() - start < 3000)
  }
  assert.equal(calls, 2)
})

test('JSON cancellation covers pre-aborted and active requests without retries', async t => {
  let calls = 0, received
  const requested = new Promise(resolve => { received = resolve })
  const { transport } = await listen(t, (_request, _response) => { calls++; received() })
  const cancelled = new AbortController()
  cancelled.abort(new Error(token))
  await rejectsSafe(transport.json('/api/v1/releases', { signal: cancelled.signal }), 'CENTER_CANCELLED')
  assert.equal(calls, 0)
  const active = new AbortController()
  const pending = transport.json('/api/v1/releases', { signal: active.signal })
  await requested
  active.abort(new Error(token))
  await rejectsSafe(pending, 'CENTER_CANCELLED')
  assert.equal(calls, 1)
})

test('HTTP(S) proxy environment variables are ignored; only the explicitly configured center receives authority', async t => {
  let proxyCalls = 0, centerCalls = 0
  const proxy = await listen(t, (_request, response) => { proxyCalls++; sendJson(response, {}) })
  const { transport } = await listen(t, (_request, response) => { centerCalls++; sendJson(response, {}) })
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    for (const key of keys) process.env[key] = proxy.origin
    await transport.json('/api/v1/releases', { credentialToken: token })
    assert.equal(centerCalls, 1)
    assert.equal(proxyCalls, 0)
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
  }
})

test('real HTTPS verifies certificate trust and hostname, including when global TLS verification is disabled', async t => {
  const directory = await scratch(t)
  async function certificate(name, san) {
    const keyPath = join(directory, `${name}.key`), certPath = join(directory, `${name}.crt`)
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=transport-test',
      '-addext', `subjectAltName=IP:${san}`, '-keyout', keyPath, '-out', certPath], { timeout: 15000 })
    return { key: await readFile(keyPath), cert: await readFile(certPath) }
  }
  let calls = 0
  const tls = await certificate('valid', '127.0.0.1')
  const { origin } = await listen(t, (request, response) => { calls++; assert.equal(request.headers.authorization, `Bearer ${token}`); sendJson(response, {}) }, tls)
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    await rejectsSafe(createPackCenterTransport({ origin }).json('/api/v1/releases', { credentialToken: token }), 'CENTER_NETWORK_ERROR')
    assert.equal(calls, 0)
    assert.deepEqual(await createPackCenterTransport({ origin, testCa: tls.cert.toString() }).json('/api/v1/releases', { credentialToken: token }), {})
    assert.equal(calls, 1)
    const mismatch = await certificate('mismatch', '127.0.0.2')
    const second = await listen(t, (_request, response) => { calls++; sendJson(response, {}) }, mismatch)
    await rejectsSafe(createPackCenterTransport({ origin: second.origin, testCa: mismatch.cert.toString() }).json('/api/v1/releases'), 'CENTER_NETWORK_ERROR')
    assert.equal(calls, 1)
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous
  }
})

test('download streams exact approved bytes into a new mode-0600 file with host headers only', async t => {
  const directory = await scratch(t), destination = join(directory, 'artifact.tar')
  let seen
  const { transport } = await listen(t, (request, response) => { seen = request; sendArtifact(response) })
  assert.deepEqual(await transport.download(artifactPath, destination, downloadOptions), { sizeBytes: artifact.length, sha256 })
  assert.deepEqual(await readFile(destination), artifact)
  assert.equal((await stat(destination)).mode & 0o777, 0o600)
  assert.equal(seen.url, artifactPath)
  assert.equal(seen.headers.authorization, `Bearer ${token}`)
  assert.equal(seen.headers['x-pack-download-grant'], grant)
  for (const name of ['cookie', 'origin', 'range', 'if-none-match', 'referer']) assert.equal(seen.headers[name], undefined)
  assert.equal(Object.keys(seen.headers).some(name => name.startsWith('sec-fetch-')), false)
})

test('multi-chunk download verifies the original approved identity despite caller mutation', async t => {
  const directory = await scratch(t), destination = join(directory, 'large-artifact.tar')
  const bytes = Buffer.alloc(2 * 1024 * 1024, 117)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const input = { ...downloadOptions, expectedSha256: digest, expectedBytes: bytes.length }
  const { transport } = await listen(t, (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`)
    assert.equal(request.headers['x-pack-download-grant'], grant)
    response.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': bytes.length })
    let offset = 0
    function next() {
      if (response.destroyed) return
      while (offset < bytes.length) {
        const chunk = bytes.subarray(offset, offset + 32768)
        offset += chunk.length
        if (!response.write(chunk)) { response.once('drain', next); return }
      }
      response.end()
    }
    next()
  })
  const pending = transport.download(artifactPath, destination, input)
  input.expectedSha256 = '0'.repeat(64)
  input.expectedBytes = 0
  input.credentialToken = 'mutated'
  input.downloadGrant = 'mutated'
  assert.deepEqual(await pending, { sizeBytes: bytes.length, sha256: digest })
  assert.deepEqual(await readFile(destination), bytes)
})

test('download never overwrites or removes an existing file, symlink, or symlink-parent target', async t => {
  const directory = await scratch(t), destination = join(directory, 'artifact.tar')
  let calls = 0
  const { transport } = await listen(t, (_request, response) => { calls++; sendArtifact(response) })
  await writeFile(destination, 'existing-data')
  await rejectsSafe(transport.download(artifactPath, destination, downloadOptions), 'CENTER_DOWNLOAD_TARGET_EXISTS')
  assert.equal(await readFile(destination, 'utf8'), 'existing-data')
  const linked = join(directory, 'linked.tar')
  await symlink(destination, linked)
  await rejectsSafe(transport.download(artifactPath, linked, downloadOptions), 'CENTER_DOWNLOAD_TARGET_EXISTS')
  assert.equal(await readFile(linked, 'utf8'), 'existing-data')
  const parentLink = join(directory, 'parent-link')
  await symlink(directory, parentLink)
  await rejectsSafe(transport.download(artifactPath, join(parentLink, 'other.tar'), downloadOptions), 'CENTER_DOWNLOAD_IO')
  assert.equal(calls, 0)
})

test('download refuses invalid metadata, limits, routing, and grants before writing or networking', async t => {
  const directory = await scratch(t), destination = join(directory, 'artifact.tar')
  let calls = 0
  const { transport } = await listen(t, (_request, response) => { calls++; sendArtifact(response) })
  for (const extra of [{ expectedBytes: -1 }, { expectedBytes: 1.5 }, { expectedBytes: 64 * 1024 * 1024 + 1 },
    { expectedBytes: artifact.length, maxBytes: artifact.length - 1 }, { expectedSha256: 'f'.repeat(63) },
    { credentialToken: undefined }, { downloadGrant: `bad\r\n${grant}` }, { maxBytes: 0 }]) {
    await rejectsSafe(transport.download(artifactPath, destination, { ...downloadOptions, ...extra }), 'CENTER_INVALID_REQUEST')
  }
  for (const path of [`${artifactPath}?grant=${grant}`, '/api/v1/releases/%2e%2e/artifact', '/api/v1/releases/release-1',
    '/api/v1/releases/release-1/artifact/', '//evil.example/artifact', '/api/v1/releases/release-1/../artifact']) {
    await rejectsSafe(transport.download(path, destination, downloadOptions), 'CENTER_INVALID_REQUEST')
  }
  await rejectsSafe(transport.download(artifactPath, 'relative.tar', downloadOptions), 'CENTER_INVALID_REQUEST')
  assert.equal(calls, 0)
  assert.deepEqual(await readdir(directory), [])
})

test('download digest mismatch and declared length mismatch clean up only the new destination', async t => {
  const directory = await scratch(t), destination = join(directory, 'artifact.tar')
  let calls = 0
  const { transport } = await listen(t, (_request, response) => {
    calls++
    sendArtifact(response, calls === 1 ? Buffer.alloc(artifact.length, 120) : artifact.subarray(1))
  })
  for (let index = 0; index < 2; index++) {
    await rejectsSafe(transport.download(artifactPath, destination, downloadOptions), 'CENTER_DOWNLOAD_INVALID')
    await absent(destination)
  }
  assert.equal(calls, 2)
})

test('download refuses compression, partial responses, non-tar content, redirects and chunked unknown lengths', async t => {
  const directory = await scratch(t), destination = join(directory, 'artifact.tar')
  let index = 0
  const variants = [
    { 'Content-Encoding': 'gzip' }, { 'Content-Range': `bytes 0-${artifact.length - 1}/${artifact.length}` },
    { 'Content-Type': 'text/html' }, { status: 206 }, { status: 302, Location: `http://evil.invalid/${token}` },
    { unknownLength: true },
  ]
  const { transport } = await listen(t, (_request, response) => {
    const { status = 200, unknownLength, ...extra } = variants[index++]
    response.writeHead(status, { 'Content-Type': 'application/x-tar', ...(unknownLength ? {} : { 'Content-Length': artifact.length }), ...extra })
    response.end(artifact)
  })
  for (const expected of ['CENTER_RESPONSE_INVALID', 'CENTER_RESPONSE_INVALID', 'CENTER_DOWNLOAD_INVALID', 'CENTER_RESPONSE_INVALID', 'CENTER_REDIRECT_DENIED', 'CENTER_DOWNLOAD_INVALID']) {
    await rejectsSafe(transport.download(artifactPath, destination, downloadOptions), expected)
    await absent(destination)
  }
  assert.equal(index, variants.length)
})

test('truncated download cleans up after the body reader stops and never retries', async t => {
  const directory = await scratch(t), destination = join(directory, 'artifact.tar')
  let calls = 0
  const { transport } = await listen(t, (_request, response) => {
    calls++
    response.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': artifact.length })
    response.write(artifact.subarray(0, 5))
    setImmediate(() => response.destroy())
  })
  await rejectsSafe(transport.download(artifactPath, destination, downloadOptions), 'CENTER_NETWORK_ERROR')
  await absent(destination)
  assert.equal(calls, 1)
})

test('download total timeout and cancellation remove partial files without exposing AbortSignal reasons', async t => {
  const directory = await scratch(t), destination = join(directory, 'artifact.tar')
  let calls = 0, arrived
  const { origin } = await listen(t, (_request, response) => {
    calls++
    response.writeHead(200, { 'Content-Type': 'application/x-tar', 'Content-Length': artifact.length })
    response.write(artifact.subarray(0, 5))
    arrived?.()
  })
  const transport = createPackCenterTransport({ origin, allowLoopbackHttp: true, timeoutMs: 250 })
  await rejectsSafe(transport.download(artifactPath, destination, downloadOptions), 'CENTER_TIMEOUT')
  await absent(destination)
  const controller = new AbortController()
  const requested = new Promise(resolve => { arrived = resolve })
  const pending = transport.download(artifactPath, destination, { ...downloadOptions, signal: controller.signal })
  await requested
  controller.abort(new Error(`${token} remote-private-details`))
  await rejectsSafe(pending, 'CENTER_CANCELLED')
  await absent(destination)
  await rejectsSafe(transport.download(artifactPath, destination, { ...downloadOptions, signal: controller.signal }), 'CENTER_CANCELLED')
  await absent(destination)
  assert.equal(calls, 2)
})

test('failed download cleanup does not delete a substituted destination owned by another actor', async t => {
  const directory = await scratch(t), destination = join(directory, 'artifact.tar')
  const { transport } = await listen(t, async (_request, response) => {
    await unlink(destination)
    await writeFile(destination, 'replacement-owned-by-other-actor')
    response.destroy()
  })
  await rejectsSafe(transport.download(artifactPath, destination, downloadOptions), 'CENTER_NETWORK_ERROR')
  assert.equal(await readFile(destination, 'utf8'), 'replacement-owned-by-other-actor')
})
