/**
 * `expert_provider_call` tool tests — the policy-converged provider seam.
 *
 * Covers: registration shape + eligibility guard; read-op passthrough with a
 * fake service (provenance/warnings/data preserved, constraints forwarded);
 * unknown-capability and unavailable-service errors; envelope failure
 * passthrough; data truncation with a marker; and the write-approval gate
 * exercised through the REAL ProviderTransportService (no approval service →
 * blocked at registry.invoke; allowed-once → passes; rejected → blocked).
 *
 * All offline — fake credentials, fake fetch, no live endpoints.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  registerProviderCallTool,
  providerCallToolEligible,
  PROVIDER_CALL_MAX_DATA_CHARS,
} from '../lib/host/provider-tool.js'
import { ProviderTransportService } from '../lib/host/provider-service.js'
import { okEnvelope, failEnvelope } from '../lib/v2/index.js'

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

function fakeCtx(service) {
  let registered = null
  const ctx = {
    tools: { register: (tool) => { registered = tool } },
    get: (name) => name === 'providerTransport' ? service : undefined,
  }
  return { ctx, getRegistered: () => registered }
}

function fakeService({ resolve, invoke, providers = ['wind'] }) {
  return {
    providers,
    availableCredentials: () => ['WIND_API_KEY', 'ZYT_API_KEY', 'BEIKE_MCP_API_KEY'],
    resolver: { resolve },
    invoke,
  }
}

const exec = { agent: { id: 'member-1' }, signal: new AbortController().signal }

function registerAndGetTool(service) {
  const { ctx, getRegistered } = fakeCtx(service)
  registerProviderCallTool(ctx)
  const tool = getRegistered()
  assert.ok(tool, 'tool must be registered')
  return tool
}

const readBinding = {
  capability: 'financial.stock.snapshot',
  providerId: 'wind',
  providerVersion: '1.0.0',
  operation: 'financial.stock.snapshot',
  transportId: 'cli',
  caliber: 'wind 实时行情口径',
  reason: 'capability ∩ provider-installed ∩ read-only → financial.stock.snapshot@cli',
  boundAt: '2026-08-22T00:00:00.000Z',
}

/* ---------------------------------------------------------------------------
 * Registration + guard
 * ------------------------------------------------------------------------- */

test('registerProviderCallTool registers expert_provider_call with the required params and Chinese description', () => {
  const tool = registerAndGetTool(fakeService({ resolve: () => ({}), invoke: async () => okEnvelope({}, { provider: 'wind', operation: 'x' }) }))
  assert.equal(tool.name, 'expert_provider_call')
  // `parameters` is the compiled JSON schema (implicit open object root).
  const props = tool.parameters.properties
  assert.equal(props.capability.type, 'string')
  assert.equal(props.input.type, 'object')
  assert.equal(props.input.additionalProperties, true)
  assert.equal(props.context.type, 'string')
  assert.deepEqual(tool.parameters.required, ['capability', 'input'])
  assert.match(tool.description, /financial\.stock\.snapshot/)
  assert.match(tool.description, /realestate\.indicators\.timeseries/)
  assert.match(tool.description, /realestate\.listing\.search/)
  assert.match(tool.description, /realestate\.rent\.appoint/)
  // render must produce a text block for both ok and error results
  const text = tool.output.render({ capability: 'x' }, { ok: true, capability: 'x', provider: 'wind', operation: 'o' })
  assert.equal(text[0].type, 'text')
  assert.match(text[0].text, /成功/)
})

test('providerCallToolEligible gates registration on a live service with providers', () => {
  assert.equal(providerCallToolEligible(undefined), false)
  assert.equal(providerCallToolEligible({ providers: [] }), false)
  assert.equal(providerCallToolEligible({ providers: ['wind'] }), true)
})

/* ---------------------------------------------------------------------------
 * Read-op passthrough (fake service)
 * ------------------------------------------------------------------------- */

test('read-op passthrough: resolves with credentials + readOnly:false, forwards meta, preserves provenance/warnings/data', async () => {
  const envelope = okEnvelope(
    { data: { columns: ['windcode', 'close'], rows: [['600519.SH', 1521.5]], unit: '元' } },
    { provider: 'wind', operation: 'financial.stock.snapshot', transportId: 'cli', caliber: 'wind 实时行情口径', unit: '元' },
    [{ code: 'wind.cli-meta.warning', message: '分页截断', severity: 'warning' }],
  )
  const seen = []
  const service = fakeService({
    resolve: (request) => {
      seen.push(['resolve', request])
      assert.equal(request.capability, 'financial.stock.snapshot')
      assert.equal(request.constraints.readOnly, false)
      assert.deepEqual(request.constraints.availableCredentials, ['WIND_API_KEY', 'ZYT_API_KEY', 'BEIKE_MCP_API_KEY'])
      assert.equal(request.context, 't2c 采集')
      return { capability: request.capability, status: 'bound', binding: readBinding, rejections: [] }
    },
    invoke: async (request, meta) => {
      seen.push(['invoke', request, meta])
      assert.equal(request.binding.providerId, 'wind')
      assert.deepEqual(request.input, { windcode: '600519.SH' })
      assert.equal(request.context, 't2c 采集')
      assert.equal(meta.agent.id, 'member-1')
      assert.ok(meta.signal instanceof AbortSignal)
      return envelope
    },
  })
  const tool = registerAndGetTool(service)
  const result = await tool.execute(
    { capability: 'financial.stock.snapshot', input: { windcode: '600519.SH' }, context: 't2c 采集' },
    exec,
  )
  assert.equal(result.ok, true)
  assert.equal(result.capability, 'financial.stock.snapshot')
  assert.equal(result.provider, 'wind')
  assert.equal(result.operation, 'financial.stock.snapshot')
  assert.equal(result.transportId, 'cli')
  assert.deepEqual(result.provenance, envelope.provenance)
  assert.deepEqual(result.warnings, envelope.warnings)
  assert.deepEqual(result.data, envelope.data)
  assert.equal(result.error, undefined)
  assert.equal(result.truncated, undefined)
  assert.deepEqual(seen.map(s => s[0]), ['resolve', 'invoke'])
})

test('unknown capability returns CAPABILITY_UNBOUND with rejections and never invokes', async () => {
  let invoked = false
  const service = fakeService({
    resolve: (request) => ({
      capability: request.capability,
      status: 'unavailable',
      rejections: [
        { providerId: 'wind', operation: request.capability, reason: 'missing-credential:WIND_API_KEY' },
        { providerId: 'zyt', operation: request.capability, reason: 'capability-not-served' },
      ],
    }),
    invoke: async () => { invoked = true; throw new Error('must not invoke') },
  })
  const tool = registerAndGetTool(service)
  const result = await tool.execute({ capability: 'nobody.serves.this', input: {} }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CAPABILITY_UNBOUND')
  assert.equal(result.error.retry, 'never')
  assert.match(result.error.correction, /nobody\.serves\.this/)
  assert.ok(Array.isArray(result.error.details.rejections))
  assert.equal(result.error.details.rejections.length, 2)
  assert.equal(invoked, false)
})

test('service unavailable at execute time fails closed with PROVIDER_SERVICE_UNAVAILABLE', async () => {
  const tool = registerAndGetTool(undefined)
  const result = await tool.execute({ capability: 'financial.stock.snapshot', input: {} }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PROVIDER_SERVICE_UNAVAILABLE')
  assert.equal(result.error.retry, 'never')
})

test('failure envelopes pass through with error/provenance/warnings intact', async () => {
  const envelope = failEnvelope(
    { code: 'USAGE_ERROR', retry: 'never', correction: '检查调用参数格式', details: { usage: 'call …' } },
    { provider: 'wind', operation: 'financial.stock.snapshot', transportId: 'cli' },
    [{ code: 'wind.agent-action', message: '停止后续批量调用', severity: 'info' }],
  )
  const service = fakeService({
    resolve: () => ({ capability: 'financial.stock.snapshot', status: 'bound', binding: readBinding, rejections: [] }),
    invoke: async () => envelope,
  })
  const tool = registerAndGetTool(service)
  const result = await tool.execute({ capability: 'financial.stock.snapshot', input: {} }, exec)
  assert.equal(result.ok, false)
  assert.deepEqual(result.error, envelope.error)
  assert.deepEqual(result.provenance, envelope.provenance)
  assert.deepEqual(result.warnings, envelope.warnings)
})

test('oversized data is truncated with a marker while provenance stays intact', async () => {
  const bigRows = Array.from({ length: 3000 }, (_, i) => [i, `x${'y'.repeat(30)}`])
  const envelope = okEnvelope(
    { data: { columns: ['idx', 'pad'], rows: bigRows, unit: '条' } },
    { provider: 'wind', operation: 'financial.stock.snapshot', transportId: 'cli', unit: '条' },
  )
  const service = fakeService({
    resolve: () => ({ capability: 'financial.stock.snapshot', status: 'bound', binding: readBinding, rejections: [] }),
    invoke: async () => envelope,
  })
  const tool = registerAndGetTool(service)
  const result = await tool.execute({ capability: 'financial.stock.snapshot', input: {} }, exec)
  assert.equal(result.ok, true)
  assert.ok(result.truncated !== undefined, 'truncated marker must be present')
  assert.ok(result.truncated.chars > PROVIDER_CALL_MAX_DATA_CHARS)
  assert.equal(result.truncated.kept, PROVIDER_CALL_MAX_DATA_CHARS)
  assert.equal(result.data._truncated, true)
  assert.ok(result.data._chars > PROVIDER_CALL_MAX_DATA_CHARS)
  assert.equal(typeof result.data._preview, 'string')
  assert.equal(result.data._preview.length, PROVIDER_CALL_MAX_DATA_CHARS)
  assert.deepEqual(result.provenance, envelope.provenance, 'provenance survives truncation')
  assert.equal(result.provenance.unit, '条')
})

/* ---------------------------------------------------------------------------
 * Write approval gate through the REAL service
 * ------------------------------------------------------------------------- */

function realBeikeService({ approval, fetch }) {
  return new ProviderTransportService({ get: () => undefined }, {
    beike: { baseUrl: 'https://building.ke.com/mcp' },
    credentials: () => 'fake-beike-key',
    ...(fetch !== undefined ? { fetch } : {}),
    ...(approval !== undefined ? { approval } : {}),
  })
}

function beikeFetchStub(calls) {
  return async (options) => {
    calls.push(options)
    const body = JSON.parse(options.body)
    if (body.method === 'initialize') {
      return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'beike-mcp-proxy' } } }), truncated: false }
    }
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ code: 0, data: { ok: true } }) }] } }), truncated: false }
  }
}

test('write-op blocked without an approval service (real registry.invoke gate)', async () => {
  let fetchCalled = false
  const service = realBeikeService({
    fetch: async () => { fetchCalled = true; throw new Error('must not run') },
    // no approval option and the service ctx has none → blocked at registry.invoke
  })
  const tool = registerAndGetTool(service)
  const result = await tool.execute(
    { capability: 'realestate.rent.appoint', input: { houseCode: 'x' } },
    exec,
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'write-requires-approval')
  assert.equal(result.error.retry, 'never')
  assert.equal(fetchCalled, false, 'the write transport must never be reached without approval')
})

test('write-op executes after allowed-once approval and is rejected otherwise', async () => {
  const fetchCalls = []
  const allowed = realBeikeService({ approval: { request: async () => 'allowed-once' }, fetch: beikeFetchStub(fetchCalls) })
  const tool = registerAndGetTool(allowed)
  const granted = await tool.execute({ capability: 'realestate.rent.appoint', input: { houseCode: 'x' } }, exec)
  assert.equal(granted.ok, true, 'allowed-once must authorize the write')
  assert.equal(granted.data.data.ok, true)
  assert.equal(fetchCalls.length, 2, 'initialize + tools/call handshake')

  let fetchCalled = false
  const rejected = realBeikeService({
    approval: { request: async () => 'rejected' },
    fetch: async () => { fetchCalled = true; throw new Error('must not run') },
  })
  const rejectedTool = registerAndGetTool(rejected)
  const denied = await rejectedTool.execute({ capability: 'realestate.rent.appoint', input: { houseCode: 'x' } }, exec)
  assert.equal(denied.ok, false)
  assert.equal(denied.error.code, 'APPROVAL_REJECTED')
  assert.equal(denied.error.retry, 'never')
  assert.equal(fetchCalled, false)
})

test('write-op without a calling agent stays blocked even with an approval service', async () => {
  const service = realBeikeService({
    approval: { request: async () => { throw new Error('must not be asked') } },
    fetch: async () => { throw new Error('must not run') },
  })
  const tool = registerAndGetTool(service)
  const result = await tool.execute(
    { capability: 'realestate.rent.appoint', input: { houseCode: 'x' } },
    { agent: undefined, signal: new AbortController().signal },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'write-requires-approval')
})
