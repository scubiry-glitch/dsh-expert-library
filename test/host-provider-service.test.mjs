/**
 * Host provider transport tests — injectable spawn/fetch/credential seams,
 * the ProviderTransportService (registration, invokers, settings overlays,
 * write-approval gate) and the bounded/timeout/abort guarantees.
 *
 * All tests run offline: no live Wind/zyt/beike credentials or endpoints are
 * touched; the seams are fakes. The only real child processes spawned are
 * harmless `node -e` scripts (bounds test). Secrets used in fixtures are fake
 * values, and the non-leakage test asserts they never appear in envelopes,
 * audit records or snapshots.
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderTransportService,
  applyToolExecutionOverlay,
} from '../lib/host/provider-service.js'
import {
  ProviderTransports,
  TransportError,
  createCredentialResolver,
  createNodeSpawnRunner,
  parseMaybeSSE,
} from '../lib/host/provider-transports.js'
import { CapabilityResolver, buildWindManifest } from '../lib/v2/index.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

const FAKE_SECRET = 'fake-secret-value-123'

/** Resolves every credential ref (used by invoke tests). */
const fakeCredentials = () => FAKE_SECRET

/** Resolves everything except ZYT_API_KEY (for the fail-closed availability gate test). */
const partialCredentials = (descriptor) => descriptor.credentialRef === 'ZYT_API_KEY' ? undefined : FAKE_SECRET

const minimalCtx = { get: () => undefined }

/** Fake spawn returning a canned wind-style success envelope. */
function windSpawnStub(record) {
  const inner = JSON.stringify({ data: { columns: ['windcode', 'close'], rows: [['600519.SH', 1521.5]], unit: '元' } })
  return async (options) => {
    record.push(options)
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        content: [{ type: 'text', text: inner }],
        cli_meta: { schema_version: '1.0', server_type: 'stock_data', tool_name: 'get_stock_price_indicators', completeness: 'not_asserted', tables: [], warnings: [] },
      }),
      stderr: '',
      killed: false,
      truncated: null,
    }
  }
}

function windOptions() {
  return { wind: { cliPath: '/fake/skills/wind-mcp-skill/scripts/cli.mjs' } }
}

function zytOptions(overrides = {}) {
  return { zyt: { baseUrl: 'https://dss.ke.com', ...overrides } }
}

function beikeOptions(overrides = {}) {
  return { beike: { baseUrl: 'https://building.ke.com/mcp', ...overrides } }
}

function resolveBinding(service, capability, constraints = {}) {
  const result = service.resolver.resolve({ capability, constraints })
  assert.equal(result.status, 'bound', `capability ${capability} must bind: ${JSON.stringify(result.rejections)}`)
  return result.binding
}

/* ---------------------------------------------------------------------------
 * Service registration + resolver
 * ------------------------------------------------------------------------- */

test('service registers wind/zyt/beike manifests and attaches invokers', () => {
  const service = new ProviderTransportService(minimalCtx, {
    ...windOptions(), ...zytOptions(), ...beikeOptions(),
    credentials: fakeCredentials,
  })
  assert.deepEqual([...service.providers].sort(), ['beike', 'wind', 'zyt'])
  const audit = service.audit()
  assert.deepEqual(audit.filter(e => e.kind === 'register').map(e => e.providerId).sort(), ['beike', 'wind', 'zyt'])
  assert.deepEqual(audit.filter(e => e.kind === 'attach').map(e => e.providerId).sort(), ['beike', 'wind', 'zyt'])
  assert.ok(service.snapshot().providers.length >= 3)
})

test('service resolver binds capabilities and reports unavailable for unknown ones', () => {
  const service = new ProviderTransportService(minimalCtx, {
    ...windOptions(), ...zytOptions(), ...beikeOptions(),
    credentials: fakeCredentials,
  })
  const wind = resolveBinding(service, 'financial.stock.snapshot')
  assert.equal(wind.providerId, 'wind')
  const zyt = resolveBinding(service, 'realestate.indicators.timeseries')
  assert.equal(zyt.providerId, 'zyt')
  const unavailable = service.resolver.resolve({ capability: 'nobody.serves.this' })
  assert.equal(unavailable.status, 'unavailable')
})

test('availableCredentials returns only refs that resolve (fail-closed gate)', () => {
  const service = new ProviderTransportService(minimalCtx, {
    ...windOptions(), ...zytOptions(), ...beikeOptions(),
    credentials: partialCredentials,
  })
  const available = service.availableCredentials()
  assert.ok(available.includes('WIND_API_KEY'))
  assert.ok(available.includes('BEIKE_MCP_API_KEY'))
  assert.ok(!available.includes('ZYT_API_KEY'), 'zyt key is not resolvable → excluded')
})

/* ---------------------------------------------------------------------------
 * Wind invoke end-to-end via the fake spawn seam
 * ------------------------------------------------------------------------- */

test('wind invoke plans the CLI call, injects the key into env, and normalizes the envelope', async () => {
  const spawnCalls = []
  const service = new ProviderTransportService(minimalCtx, {
    ...windOptions(),
    credentials: fakeCredentials,
    spawn: windSpawnStub(spawnCalls),
  })
  const binding = resolveBinding(service, 'financial.stock.snapshot')
  const envelope = await service.invoke({ binding, input: { windcode: '600519.SH' }, context: 't2c 采集' })

  assert.equal(envelope.ok, true)
  assert.equal(envelope.provenance.provider, 'wind')
  assert.equal(envelope.provenance.operation, 'financial.stock.snapshot')
  assert.equal(envelope.provenance.unit, '元')
  assert.equal(envelope.data.data.rows[0][0], '600519.SH')

  assert.equal(spawnCalls.length, 1)
  const call = spawnCalls[0]
  assert.equal(call.command, 'node')
  assert.deepEqual(call.args, [
    '/fake/skills/wind-mcp-skill/scripts/cli.mjs',
    'call', 'stock_data', 'get_stock_price_indicators', '{"windcode":"600519.SH"}',
  ])
  assert.equal(call.env.WIND_API_KEY, FAKE_SECRET)
  assert.equal(call.signal instanceof AbortSignal, true)

  const invokeAudits = service.audit().filter(e => e.kind === 'invoke')
  assert.equal(invokeAudits.length, 1)
  assert.equal(invokeAudits[0].outcome, 'ok')
})

test('missing credential fails closed before the spawn seam is reached', async () => {
  let spawnCalled = false
  const service = new ProviderTransportService(minimalCtx, {
    ...windOptions(),
    credentials: () => undefined,
    spawn: async () => { spawnCalled = true; throw new Error('must not run') },
  })
  const binding = resolveBinding(service, 'financial.stock.snapshot')
  const envelope = await service.invoke({ binding, input: {} })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'missing-credential')
  assert.equal(envelope.error.retry, 'never')
  assert.equal(spawnCalled, false)
})

test('missing binary surfaces as TRANSPORT_MISSING_BINARY (never)', async () => {
  const service = new ProviderTransportService(minimalCtx, {
    ...windOptions(),
    credentials: fakeCredentials,
    spawn: async () => { throw new TransportError('TRANSPORT_MISSING_BINARY', { command: 'node' }) },
  })
  const binding = resolveBinding(service, 'financial.stock.snapshot')
  const envelope = await service.invoke({ binding, input: {} })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'TRANSPORT_MISSING_BINARY')
  assert.equal(envelope.error.retry, 'never')
})

test('plan errors map to a correct-input envelope (never retried blindly)', async () => {
  let fetchCalled = false
  const service = new ProviderTransportService(minimalCtx, {
    ...zytOptions(),
    credentials: fakeCredentials,
    fetch: async () => { fetchCalled = true; throw new Error('must not run') },
  })
  const binding = resolveBinding(service, 'realestate.indicators.timeseries')
  // series requires city + code; missing code is a plan (input) error.
  const envelope = await service.invoke({ binding, input: { city: '北京' } })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'PLAN_ERROR')
  assert.equal(envelope.error.retry, 'correct-input')
  assert.match(envelope.error.correction, /code/)
  assert.equal(fetchCalled, false, 'the transport must not run on a plan error')
})

/* ---------------------------------------------------------------------------
 * zyt HTTP invoke via the fake fetch seam
 * ------------------------------------------------------------------------- */

test('zyt http invoke builds the request URL + X-Api-Key header and normalizes 2xx', async () => {
  const fetchCalls = []
  const service = new ProviderTransportService(minimalCtx, {
    ...zytOptions(),
    credentials: fakeCredentials, // ZYT_API_KEY resolves to FAKE_SECRET
    fetch: async (options) => {
      fetchCalls.push(options)
      return { status: 200, body: JSON.stringify({ entries: [{ id: 'city', name: '上海' }] }), truncated: false }
    },
  })
  const binding = resolveBinding(service, 'realestate.indicators.timeseries')
  const envelope = await service.invoke({ binding, input: { city: '北京', code: 'SH_PRICE', limit: '6' } })

  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.data, { entries: [{ id: 'city', name: '上海' }] })
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].method, 'GET')
  assert.equal(fetchCalls[0].url, 'https://dss.ke.com/openapi/v1/indicators/series?city=%E5%8C%97%E4%BA%AC&code=SH_PRICE&limit=6')
  assert.equal(fetchCalls[0].headers['X-Api-Key'], FAKE_SECRET)
})

test('zyt http auth failure maps to ZYT_AUTH_ERROR (never)', async () => {
  const service = new ProviderTransportService(minimalCtx, {
    ...zytOptions(),
    credentials: fakeCredentials,
    fetch: async () => ({ status: 401, body: JSON.stringify({ error: { code: 'INVALID_API_KEY', httpStatus: 401 } }), truncated: false }),
  })
  const binding = resolveBinding(service, 'realestate.indicators.timeseries')
  const envelope = await service.invoke({ binding, input: { city: '北京', code: 'SH_PRICE' } })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'ZYT_AUTH_ERROR')
  assert.equal(envelope.error.retry, 'never')
})

test('zyt cli transport (preferCli) spawns the binary with --json', async () => {
  const spawnCalls = []
  const service = new ProviderTransportService(minimalCtx, {
    ...zytOptions({ cliCommand: '/usr/local/bin/zyt', preferCli: true }),
    credentials: fakeCredentials,
    spawn: async (options) => {
      spawnCalls.push(options)
      return { exitCode: 0, stdout: JSON.stringify({ entries: [], dataView: 'internal' }), stderr: '', killed: false, truncated: null }
    },
  })
  const binding = resolveBinding(service, 'realestate.indicators.timeseries')
  assert.equal(binding.transportId, 'cli')
  const envelope = await service.invoke({ binding, input: { city: '北京', code: 'SH_PRICE' } })
  assert.equal(envelope.ok, true)
  assert.match(envelope.provenance.caliber, /zyt\.internal/)
  assert.equal(spawnCalls[0].command, '/usr/local/bin/zyt')
  assert.deepEqual(spawnCalls[0].args, ['--json', '指标时序', '--city', '北京', '--code', 'SH_PRICE'])
  assert.equal(spawnCalls[0].env.ZYT_API_KEY, FAKE_SECRET)
})

/* ---------------------------------------------------------------------------
 * beike MCP HTTP invoke (initialize + tools/call) + write approval gate
 * ------------------------------------------------------------------------- */

function beikeFetchStub(calls) {
  return async (options) => {
    calls.push(options)
    const body = JSON.parse(options.body)
    if (body.method === 'initialize') {
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'beike-mcp-proxy' } } }), truncated: false }
    }
    assert.equal(body.method, 'tools/call')
    return {
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ code: 0, data: { list: [] }, unit: '套' }) }] } }),
      truncated: false,
    }
  }
}

test('beike read invoke performs the MCP initialize + tools/call handshake', async () => {
  const fetchCalls = []
  const service = new ProviderTransportService(minimalCtx, {
    ...beikeOptions(),
    credentials: fakeCredentials,
    fetch: beikeFetchStub(fetchCalls),
  })
  const binding = resolveBinding(service, 'realestate.listing.search')
  assert.equal(binding.transportId, 'mcp-http')
  const envelope = await service.invoke({ binding, input: { city: '上海' } })
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.data, { code: 0, data: { list: [] }, unit: '套' })
  assert.equal(fetchCalls.length, 2)
  assert.equal(fetchCalls[0].url, 'https://building.ke.com/mcp')
  assert.equal(fetchCalls[1].headers.Authorization, `Bearer ${FAKE_SECRET}`)
  assert.deepEqual(JSON.parse(fetchCalls[1].body).params, { name: 'house_search', arguments: { city: '上海' } })
})

test('write invoke without an approval service stays blocked at registry.invoke', async () => {
  let fetchCalled = false
  const service = new ProviderTransportService(minimalCtx, {
    ...beikeOptions(),
    credentials: fakeCredentials,
    fetch: async () => { fetchCalled = true; throw new Error('must not run') },
    // no approval option, ctx.get('approval') → undefined
  })
  const binding = resolveBinding(service, 'realestate.rent.appoint', { readOnly: false })
  assert.equal(binding.transportId, 'mcp-http-write')
  const envelope = await service.invoke({ binding, input: { houseCode: 'x' } })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'write-requires-approval')
  assert.equal(envelope.error.retry, 'never')
  assert.equal(fetchCalled, false, 'the write transport must never be reached without approval')
})

test('write invoke with an approval service: allowed-once passes, rejected blocks', async () => {
  const fetchCalls = []
  const approval = { request: async () => 'allowed-once' }
  const service = new ProviderTransportService(minimalCtx, {
    ...beikeOptions(),
    credentials: fakeCredentials,
    fetch: beikeFetchStub(fetchCalls),
    approval,
  })
  const binding = resolveBinding(service, 'realestate.rent.appoint', { readOnly: false })
  const granted = await service.invoke({ binding, input: { houseCode: 'x' } }, { agent: { id: 'captain-1' } })
  assert.equal(granted.ok, true, 'allowed-once must authorize the write')
  assert.equal(fetchCalls.length, 2)

  const rejecting = new ProviderTransportService(minimalCtx, {
    ...beikeOptions(),
    credentials: fakeCredentials,
    fetch: async () => { throw new Error('must not run') },
    approval: { request: async () => 'rejected' },
  })
  const envelope = await rejecting.invoke({ binding, input: { houseCode: 'x' } }, { agent: { id: 'captain-1' } })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'APPROVAL_REJECTED')
  assert.equal(envelope.error.retry, 'never')
})

test('approval unavailable (fail-closed answerer) blocks the write', async () => {
  const service = new ProviderTransportService(minimalCtx, {
    ...beikeOptions(),
    credentials: fakeCredentials,
    fetch: async () => { throw new Error('must not run') },
    approval: { request: async () => 'unavailable' },
  })
  const binding = resolveBinding(service, 'realestate.rent.appoint', { readOnly: false })
  const envelope = await service.invoke({ binding, input: {} }, { agent: { id: 'captain-1' } })
  assert.equal(envelope.error.code, 'APPROVAL_UNAVAILABLE')
})

/* ---------------------------------------------------------------------------
 * Credential non-leakage
 * ------------------------------------------------------------------------- */

test('secrets never appear in envelopes, audit records or snapshots', async () => {
  const spawnCalls = []
  const service = new ProviderTransportService(minimalCtx, {
    ...windOptions(), ...beikeOptions(),
    credentials: fakeCredentials,
    spawn: windSpawnStub(spawnCalls),
    fetch: beikeFetchStub([]),
  })
  const binding = resolveBinding(service, 'financial.stock.snapshot')
  const envelope = await service.invoke({ binding, input: { windcode: '600519.SH' } })
  // the secret reached the transport env (that is its only allowed destination)…
  assert.equal(spawnCalls[0].env.WIND_API_KEY, FAKE_SECRET)
  // …but never the observable outputs.
  assert.equal(JSON.stringify(envelope).includes(FAKE_SECRET), false, 'envelope leaks the secret')
  assert.equal(JSON.stringify(service.audit()).includes(FAKE_SECRET), false, 'audit leaks the secret')
  assert.equal(JSON.stringify(service.snapshot()).includes(FAKE_SECRET), false, 'snapshot leaks the secret')
  assert.equal(JSON.stringify(service.availableCredentials()).includes(FAKE_SECRET), false)
})

/* ---------------------------------------------------------------------------
 * Settings overlays
 * ------------------------------------------------------------------------- */

test('toolExecution overlay rewrites endpoints/timeouts and rebinds mode without breaking write gates', () => {
  const base = buildWindManifest({ cliPath: '/s/cli.mjs' })
  const overlaid = applyToolExecutionOverlay(base, {
    mode: 'cli',
    api: { baseUrl: 'https://ignored.example', timeoutMs: 9999, maxRetries: 2 },
    cli: { command: '/custom/node', workingDirectory: '/custom', timeoutMs: 7777 },
    readOnly: true,
  })
  const transport = overlaid.transports[0]
  assert.equal(transport.command, '/custom/node')
  assert.equal(transport.timeoutMs, 7777)
  assert.equal(transport.readOnly, true)

  const service = new ProviderTransportService(minimalCtx, {
    ...zytOptions({ cliCommand: 'zyt' }),
    ...beikeOptions({ cliCommand: 'beike' }),
    credentials: fakeCredentials,
    overlays: {
      zyt: { mode: 'cli', api: { baseUrl: 'https://override.example', timeoutMs: 42, maxRetries: 1 } },
      beike: { mode: 'cli' },
    },
  })
  const zytManifest = service.registry.get('zyt').manifest
  assert.equal(zytManifest.transports.find(t => t.id === 'http').baseUrl, 'https://override.example')
  assert.equal(zytManifest.transports.find(t => t.id === 'http').timeoutMs, 42)
  assert.equal(zytManifest.capabilities.find(c => c.capability === 'realestate.indicators.timeseries').transportId, 'cli')

  const beikeManifest = service.registry.get('beike').manifest
  assert.equal(beikeManifest.capabilities.find(c => c.capability === 'realestate.listing.search').transportId, 'cli')
  assert.equal(beikeManifest.capabilities.find(c => c.capability === 'realestate.rent.appoint').transportId, 'mcp-http-write', 'write ops never move off the write transport')
})

test('reconfigure rebuilds the registry from fresh options', () => {
  const service = new ProviderTransportService(minimalCtx, { ...windOptions(), credentials: fakeCredentials })
  assert.deepEqual(service.providers, ['wind'])
  service.reconfigure({ ...zytOptions(), credentials: fakeCredentials })
  assert.deepEqual(service.providers, ['zyt'])
  assert.equal(service.resolver.resolve({ capability: 'financial.stock.snapshot' }).status, 'unavailable')
})

/* ---------------------------------------------------------------------------
 * ProviderTransports: timeout / abort / unsupported / SSE
 * ------------------------------------------------------------------------- */

test('transport timeout classifies as TRANSPORT_TIMEOUT (backoff at the envelope layer)', async () => {
  const transports = new ProviderTransports({
    spawn: (options) => new Promise((resolve) => {
      if (options.signal.aborted) {
        resolve({ exitCode: -1, stdout: '', stderr: '', killed: true, truncated: null })
        return
      }
      options.signal.addEventListener('abort', () => resolve({ exitCode: -1, stdout: '', stderr: '', killed: true, truncated: null }), { once: true })
    }),
  })
  const transport = { kind: 'local-cli', id: 'cli', command: 'node', args: [], timeoutMs: 50, readOnly: true }
  await assert.rejects(
    transports.run(transport, { operation: 'x', input: { args: ['-e', 'sleep'] } }),
    (error) => error instanceof TransportError && error.code === 'TRANSPORT_TIMEOUT',
  )
})

test('caller cancellation classifies as TRANSPORT_CANCELLED (never)', async () => {
  const transports = new ProviderTransports({
    spawn: (options) => new Promise((resolve) => {
      // Already-aborted signals never fire listeners in Node 20 — check synchronously.
      if (options.signal.aborted) {
        resolve({ exitCode: -1, stdout: '', stderr: '', killed: true, truncated: null })
        return
      }
      options.signal.addEventListener('abort', () => resolve({ exitCode: -1, stdout: '', stderr: '', killed: true, truncated: null }), { once: true })
    }),
  })
  const controller = new AbortController()
  controller.abort()
  const transport = { kind: 'local-cli', id: 'cli', command: 'node', timeoutMs: 60_000, readOnly: true }
  await assert.rejects(
    transports.run(transport, { operation: 'x', input: { args: [] }, signal: controller.signal }),
    (error) => error instanceof TransportError && error.code === 'TRANSPORT_CANCELLED',
  )
})

test('mcp-stdio fails closed as TRANSPORT_UNSUPPORTED in this version', async () => {
  const transports = new ProviderTransports({ spawn: async () => { throw new Error('must not run') } })
  const transport = { kind: 'mcp-stdio', id: 'stdio', command: 'beike', args: ['mcp'], readOnly: true }
  await assert.rejects(
    transports.run(transport, { operation: 'x', input: {} }),
    (error) => error instanceof TransportError && error.code === 'TRANSPORT_UNSUPPORTED',
  )
})

test('real spawn runner bounds stdout and kills the runaway process', async () => {
  const spawnFn = createNodeSpawnRunner({ maxStdoutBytes: 1024, maxStderrBytes: 1024 })
  const result = await spawnFn({
    command: 'node',
    args: ['-e', "process.stdout.write('x'.repeat(5_000_000))"],
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
  })
  assert.equal(result.truncated, 'stdout')
  assert.ok(result.stdout.length <= 1024, `stdout capped, got ${result.stdout.length}`)
  assert.equal(result.killed, true)
})

test('parseMaybeSSE extracts the last data payload', () => {
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"b":2}}\n'
  const parsed = JSON.parse(parseMaybeSSE(sse))
  assert.equal(parsed.result.b, 2)
  assert.equal(parseMaybeSSE('{"plain":true}'), '{"plain":true}')
})

/* ---------------------------------------------------------------------------
 * Credential resolver (env + file sources) — fake values only
 * ------------------------------------------------------------------------- */

test('credential resolver reads env and file sources; missing files fail closed', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'expl-cred-'))
  const keyFile = join(tempDir, 'wind-key')
  writeFileSync(keyFile, '  wind-file-key-abc  ', 'utf8')
  const zytFile = join(tempDir, 'zyt-config.json')
  writeFileSync(zytFile, JSON.stringify({ baseUrl: 'https://dss.ke.com', apiKey: 'btg-file-key-9' }), 'utf8')
  const prev = process.env.TEST_CRED_ENV
  process.env.TEST_CRED_ENV = 'env-secret-xyz'
  try {
    const resolver = createCredentialResolver({
      WIND_API_KEY: keyFile,
      ZYT_API_KEY: zytFile,
    })
    assert.equal(resolver({ credentialRef: 'WIND_API_KEY', source: 'file' }), 'wind-file-key-abc', 'file content trimmed')
    assert.equal(resolver({ credentialRef: 'TEST_CRED_ENV', source: 'env' }), 'env-secret-xyz')
    assert.equal(resolver({ credentialRef: 'MISSING_FILE', source: 'file' }), undefined, 'missing file → undefined (fail closed)')
    assert.equal(resolver({ credentialRef: 'SOMETHING', source: 'credential-service' }), undefined, 'credential-service is a fail-closed extension point')
    assert.equal(resolver({ credentialRef: 'X', source: 'inline-flag' }), undefined)
  } finally {
    if (prev === undefined) delete process.env.TEST_CRED_ENV
    else process.env.TEST_CRED_ENV = prev
    rmSync(tempDir, { recursive: true, force: true })
  }
})
