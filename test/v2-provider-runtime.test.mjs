/**
 * Phase 2 provider-runtime regression tests: ProviderRegistry, the
 * CapabilityResolver intersection (allowed providers / capability allowlist /
 * credentials / read-only / freshness / explicit fallbacks), immutable
 * auditable bindings, and the Wind / zyt envelope normalizers (retry,
 * circuit breaker, caliber and unit preservation).
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderRegistry,
  CapabilityResolver,
  okEnvelope,
  failEnvelope,
  isOk,
  normalizeWindEnvelope,
  normalizeZytEnvelope,
  normalizeBeikeEnvelope,
} from '../lib/v2/index.js'

/** Wind manifest modeled on §5.1 (MCP-http, 7 域 39 工具白名单). */
function windManifest() {
  return {
    id: 'wind', version: '1.0.0', schemaVersion: 2,
    capabilities: [
      { capability: 'financial.stock.snapshot', operation: 'wind.stock.snapshot', transportId: 'mcp-1', caliber: 'wind 实时行情口径', freshness: 'realtime' },
      { capability: 'financial.macro.query', operation: 'wind.macro.query', transportId: 'mcp-1', freshness: 'daily' },
    ],
    transports: [
      { kind: 'mcp-http', id: 'mcp-1', endpoint: 'https://mcp.wind.com.cn/vserver_stock_data/mcp/', timeoutMs: 30000, readOnly: true, auth: { credentialRef: 'WIND_API_KEY', source: 'file', hint: '~/.wind-aifinmarket/config' } },
    ],
    discovery: { operation: 'wind.discovery.list-tools', refresh: 'daily' },
    caveats: ['null=缺失，禁当 0', '价格指标单次 ≤50 码，并发 ≤10'],
  }
}

/** zyt manifest modeled on §5.2 (JSON CLI, X-Api-Key, dataView caliber). */
function zytManifest() {
  return {
    id: 'zyt', version: '2.3.0', schemaVersion: 2,
    capabilities: [
      { capability: 'realestate.indicators.timeseries', operation: 'zyt.indicators.series', transportId: 'cli-1', caliber: 'zyt dataView 口径', freshness: 'monthly' },
      { capability: 'realestate.auth.identity', operation: 'zyt.auth.me', transportId: 'cli-1', freshness: 'static' },
    ],
    transports: [
      { kind: 'local-cli', id: 'cli-1', command: 'zyt', args: ['--json'], timeoutMs: 30000, readOnly: true, auth: { credentialRef: 'ZYT_API_KEY', source: 'env' } },
    ],
  }
}

/** beike-like write-transport manifest (§5.3: rent appoint needs approval). */
function beikeManifest() {
  return {
    id: 'beike', version: '0.2.24', schemaVersion: 2,
    capabilities: [
      { capability: 'realestate.rent.appoint', operation: 'beike.rent.appoint', transportId: 'mcp-http-1', freshness: 'realtime' },
    ],
    transports: [
      { kind: 'mcp-http', id: 'mcp-http-1', endpoint: 'https://building.ke.com/mcp', readOnly: false, auth: { credentialRef: 'BEIKE_MCP_API_KEY' } },
    ],
  }
}

/** Static-freshness provider for the minFreshness gate. */
function staticProviderManifest() {
  return {
    id: 'geo-static', version: '1.0.0', schemaVersion: 2,
    capabilities: [
      { capability: 'realestate.geo.code', operation: 'geo.code', transportId: 'cli-1', freshness: 'static' },
    ],
    transports: [
      { kind: 'local-cli', id: 'cli-1', command: 'geo', readOnly: true },
    ],
  }
}

function registryWith() {
  return new ProviderRegistry([windManifest(), zytManifest()])
}

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

test('registry registers manifests, serves frozen copies and audits', () => {
  const registry = registryWith()
  const wind = registry.get('wind')
  assert.ok(wind !== undefined)
  assert.equal(wind.manifest.id, 'wind')
  assert.ok(Object.isFrozen(wind.manifest), 'registered manifest must be frozen')
  assert.equal(registry.resolveCapability('financial.stock.snapshot').length, 1)
  assert.equal(registry.resolveCapability('realestate.indicators.timeseries')[0].manifest.id, 'zyt')

  const audit = registry.audit()
  assert.equal(audit.length, 2)
  assert.deepEqual(audit.map(e => [e.kind, e.providerId]), [
    ['register', 'wind'],
    ['register', 'zyt'],
  ])
  assert.ok(Object.isFrozen(audit), 'audit log must be frozen')
  assert.ok(audit.every(entry => Object.isFrozen(entry)))
})

test('duplicate registration fails without replace, and replace supersedes with audit', () => {
  const registry = registryWith()
  const duplicate = registry.register(windManifest())
  assert.equal(duplicate.ok, false)
  assert.ok(duplicate.ok === false && duplicate.diagnostics.some(d => d.code === 'duplicate-provider'))

  const updated = { ...windManifest(), version: '1.1.0' }
  const replaced = registry.register(updated, { replace: true })
  assert.equal(replaced.ok, true)
  assert.equal(replaced.ok && registry.get('wind').manifest.version, '1.1.0')
  const kinds = registry.audit().map(e => e.kind)
  assert.deepEqual(kinds, ['register', 'register', 'replace'])
  assert.equal(registry.audit()[2].detail, 'supersedes v1.0.0')
})

test('invalid manifests are rejected with the pack validator diagnostics', () => {
  const registry = registryWith()
  const broken = windManifest()
  broken.capabilities[0].transportId = 'no-such-transport'
  const result = registry.register(broken)
  assert.equal(result.ok, false)
  assert.ok(result.ok === false && result.diagnostics.some(d => d.code === 'dangling-transport'))

  const badKind = zytManifest()
  badKind.transports[0].kind = 'ftp'
  const kindResult = registry.register(badKind)
  assert.equal(kindResult.ok, false)
  assert.ok(kindResult.ok === false && kindResult.diagnostics.some(d => d.code === 'invalid-field'))
})

test('unregister stops resolution and records an audit entry', () => {
  const registry = registryWith()
  assert.equal(registry.unregister('wind').ok, true)
  assert.equal(registry.unregister('wind').ok, false, 'double unregister fails')
  assert.equal(registry.resolveCapability('financial.stock.snapshot').length, 0)
  assert.equal(registry.get('wind').removedAt !== undefined, true)
  const kinds = registry.audit().map(e => e.kind)
  assert.deepEqual(kinds, ['register', 'register', 'unregister'])
})

test('snapshot is a frozen point-in-time view', () => {
  const snapshot = registryWith().snapshot()
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.providers))
  assert.match(snapshot.takenAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.equal(snapshot.providers.length, 2)
})

test('registry constructor rejects an invalid manifest eagerly', () => {
  const broken = zytManifest()
  broken.transports = []
  assert.throws(() => new ProviderRegistry([broken]), /invalid manifest/)
})

// ---------------------------------------------------------------------------
// CapabilityResolver — §4.1 intersection
// ---------------------------------------------------------------------------

test('resolver binds wind for financial.stock.snapshot with an auditable reason', () => {
  const resolver = new CapabilityResolver(registryWith())
  const result = resolver.resolve({ capability: 'financial.stock.snapshot' })
  assert.equal(result.status, 'bound')
  const binding = result.binding
  assert.equal(binding.providerId, 'wind')
  assert.equal(binding.operation, 'wind.stock.snapshot')
  assert.equal(binding.transportId, 'mcp-1')
  assert.equal(binding.caliber, 'wind 实时行情口径')
  assert.match(binding.reason, /capability.*read-only/)
  assert.match(binding.boundAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok(Object.isFrozen(result), 'result must be frozen')
  assert.ok(Object.isFrozen(binding), 'binding must be frozen')
  assert.ok(Object.isFrozen(result.rejections))
})

test('resolver binds zyt for realestate.indicators.timeseries (no implicit wind fallback)', () => {
  const resolver = new CapabilityResolver(registryWith())
  const result = resolver.resolve({ capability: 'realestate.indicators.timeseries' })
  assert.equal(result.status, 'bound')
  assert.equal(result.binding.providerId, 'zyt')
})

test('allowedProviders filters candidates and reports provider-not-allowed', () => {
  const resolver = new CapabilityResolver(registryWith())
  // wind-only capability, but the task allows only zyt → unavailable, rejected.
  const result = resolver.resolve({
    capability: 'financial.stock.snapshot',
    constraints: { allowedProviders: ['zyt'] },
  })
  assert.equal(result.status, 'unavailable')
  assert.ok(result.rejections.some(r => r.providerId === 'wind' && r.reason === 'provider-not-allowed'))
  // zyt serves the capability; wind is not even a candidate.
  const zytResult = resolver.resolve({
    capability: 'realestate.indicators.timeseries',
    constraints: { allowedProviders: ['zyt'] },
  })
  assert.equal(zytResult.status, 'bound')
  assert.equal(zytResult.binding.providerId, 'zyt')
})

test('capability allowlist denies capabilities outside the task allowlist', () => {
  const resolver = new CapabilityResolver(registryWith())
  const result = resolver.resolve({
    capability: 'financial.stock.snapshot',
    constraints: { capabilityAllowlist: ['realestate.indicators.timeseries'] },
  })
  assert.equal(result.status, 'denied')
  assert.equal(result.rejections[0].reason, 'capability-not-allowlisted')
  assert.equal(result.binding, undefined)
})

test('capability nobody serves is unavailable', () => {
  const resolver = new CapabilityResolver(registryWith())
  const result = resolver.resolve({ capability: 'financial.fund.screen' })
  assert.equal(result.status, 'unavailable')
  assert.equal(result.binding, undefined)
})

test('write transports are blocked by default and allowed with readOnly: false', () => {
  const registry = new ProviderRegistry([beikeManifest()])
  const resolver = new CapabilityResolver(registry)
  const blocked = resolver.resolve({ capability: 'realestate.rent.appoint' })
  assert.equal(blocked.status, 'unavailable')
  assert.ok(blocked.rejections.some(r => r.reason === 'write-transport-requires-approval'))

  const allowed = resolver.resolve({ capability: 'realestate.rent.appoint', constraints: { readOnly: false } })
  assert.equal(allowed.status, 'bound')
  assert.equal(allowed.binding.providerId, 'beike')
})

test('missing credentials block binding; present credentials allow it', () => {
  const resolver = new CapabilityResolver(registryWith())
  const blocked = resolver.resolve({
    capability: 'financial.stock.snapshot',
    constraints: { availableCredentials: [] },
  })
  assert.equal(blocked.status, 'unavailable')
  assert.ok(blocked.rejections.some(r => r.reason === 'missing-credential:WIND_API_KEY'))

  const bound = resolver.resolve({
    capability: 'financial.stock.snapshot',
    constraints: { availableCredentials: ['WIND_API_KEY'] },
  })
  assert.equal(bound.status, 'bound')
})

test('minFreshness rejects static data when daily is required', () => {
  const registry = new ProviderRegistry([staticProviderManifest()])
  const resolver = new CapabilityResolver(registry)
  const blocked = resolver.resolve({
    capability: 'realestate.geo.code',
    constraints: { minFreshness: 'daily' },
  })
  assert.equal(blocked.status, 'unavailable')
  assert.ok(blocked.rejections.some(r => r.reason.startsWith('freshness-insufficient:static<daily')))

  const bound = resolver.resolve({ capability: 'realestate.geo.code' })
  assert.equal(bound.status, 'bound')
})

test('explicit fallback binds the substitute and records the hop in the reason', () => {
  const registry = new ProviderRegistry([zytManifest()])
  const resolver = new CapabilityResolver(registry)
  const result = resolver.resolve({
    capability: 'financial.stock.history',
    constraints: {
      fallbacks: [{ from: 'financial.stock.history', to: 'realestate.indicators.timeseries' }],
    },
  })
  assert.equal(result.status, 'bound')
  // The binding carries the capability the substitute actually serves…
  assert.equal(result.binding.capability, 'realestate.indicators.timeseries')
  // …and the reason records the declared hop for provenance.
  assert.match(result.binding.reason, /^fallback:financial\.stock\.history→realestate\.indicators\.timeseries;/)
})

test('fallback without any provider stays unavailable and never loops', () => {
  const resolver = new CapabilityResolver(registryWith())
  const result = resolver.resolve({
    capability: 'a.capability',
    constraints: {
      fallbacks: [
        { from: 'a.capability', to: 'b.capability' },
        { from: 'b.capability', to: 'a.capability' },
      ],
    },
  })
  assert.equal(result.status, 'unavailable')
})

test('resolveAll produces an immutable, JSON-safe plan', () => {
  const resolver = new CapabilityResolver(registryWith())
  const plan = resolver.resolveAll([
    { capability: 'financial.stock.snapshot', context: 't2c 宏观采集' },
    { capability: 'realestate.indicators.timeseries' },
    { capability: 'financial.fund.screen' },
  ])
  assert.equal(plan.results.length, 3)
  assert.deepEqual(plan.results.map(r => r.status), ['bound', 'bound', 'unavailable'])
  assert.equal(plan.bindings.length, 2)
  assert.equal(plan.requests[0].context, 't2c 宏观采集')
  assert.ok(Object.isFrozen(plan))
  assert.ok(Object.isFrozen(plan.results))
  assert.ok(Object.isFrozen(plan.bindings))
})

// ---------------------------------------------------------------------------
// Envelope factories
// ---------------------------------------------------------------------------

test('okEnvelope/failEnvelope build the §3.2 contract and are frozen', () => {
  const ok = okEnvelope({ columns: ['a'], rows: [[1]] }, { provider: 'wind', operation: 'wind.stock.snapshot' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.data, { columns: ['a'], rows: [[1]] })
  assert.equal(ok.provenance.provider, 'wind')
  assert.match(ok.provenance.fetchedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(ok.warnings, [])
  assert.equal(ok.error, undefined)
  assert.ok(isOk(ok))
  assert.ok(Object.isFrozen(ok))

  const fail = failEnvelope({ code: 'E', retry: 'backoff', correction: 'try later' }, { provider: 'zyt', operation: 'zyt.indicators.series' })
  assert.equal(fail.ok, false)
  assert.equal(fail.error.code, 'E')
  assert.equal(fail.error.retry, 'backoff')
  assert.equal(isOk(fail), false)
  assert.ok(Object.isFrozen(fail.error))
})

// ---------------------------------------------------------------------------
// Wind normalization (§5.1)
// ---------------------------------------------------------------------------

function windRaw(overrides = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ data: { columns: ['windcode', 'close'], rows: [['600519.SH', 1521.5]], unit: '元' } }) }],
    cli_meta: { schema_version: 13, completeness: 'complete', tables: ['stock_price'], warnings: [] },
    ...overrides,
  }
}

test('wind success unwraps the double-layer envelope and preserves unit', () => {
  const envelope = normalizeWindEnvelope(windRaw(), { operation: 'wind.stock.snapshot', exitCode: 0, transportId: 'mcp-1' })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.provenance.provider, 'wind')
  assert.equal(envelope.provenance.transportId, 'mcp-1')
  assert.equal(envelope.provenance.unit, '元')
  // The inner payload is kept verbatim: columns/rows/unit survive untouched.
  assert.deepEqual(envelope.data, { data: { columns: ['windcode', 'close'], rows: [['600519.SH', 1521.5]], unit: '元' } })
})

test('wind cli_meta warnings and partial completeness surface as warnings', () => {
  const envelope = normalizeWindEnvelope(windRaw({
    cli_meta: { schema_version: 13, completeness: 'partial', tables: [], warnings: ['分页截断'] },
  }), { operation: 'wind.macro.query', exitCode: 0 })
  assert.equal(envelope.ok, true)
  const codes = envelope.warnings.map(w => w.code)
  assert.ok(codes.includes('wind.cli-meta.warning'))
  assert.ok(codes.includes('wind.cli-meta.completeness'))
})

test('wind USAGE_ERROR maps to retry never and keeps the correction', () => {
  const envelope = normalizeWindEnvelope({
    code: 'USAGE_ERROR',
    details: { usage: 'call <server_type> <tool_name> <params>' },
    retry: { allowed: false, mode: 'none', max_attempts: 0 },
    correction: '检查调用参数格式',
  }, { operation: 'wind.stock.snapshot', exitCode: 1 })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'USAGE_ERROR')
  assert.equal(envelope.error.retry, 'never')
  assert.equal(envelope.error.correction, '检查调用参数格式')
  assert.deepEqual(envelope.error.details, { usage: 'call <server_type> <tool_name> <params>' })
})

test('wind ROUTE_ERROR maps to correct-input and preserves retry budget and details', () => {
  const envelope = normalizeWindEnvelope({
    code: 'ROUTE_ERROR',
    details: { allowed_values: ['stock_data', 'fund_data'] },
    retry: { allowed: true, mode: 'correct-input', max_attempts: 3 },
  }, { operation: 'wind.stock.snapshot', exitCode: 1 })
  assert.equal(envelope.error.retry, 'correct-input')
  assert.equal(envelope.error.maxAttempts, 3)
  assert.equal(envelope.error.retryMode, 'correct-input')
  assert.deepEqual(envelope.error.details, { allowed_values: ['stock_data', 'fund_data'] })
})

test('wind failure without an explicit retry directive defaults to never (no invented backoff)', () => {
  // No retry object at all — the provider gave no retry instruction, so the
  // normalizer must not invent a backoff (§5.1: provider directive authoritative).
  const noDirective = normalizeWindEnvelope({
    code: 'ROUTE_ERROR',
    details: { allowed_values: ['stock_data', 'fund_data'] },
  }, { operation: 'wind.stock.snapshot', exitCode: 1 })
  assert.equal(noDirective.error.retry, 'never')

  // retry.allowed: true without a mode is an incomplete directive → never.
  const noMode = normalizeWindEnvelope({
    code: 'ROUTE_ERROR',
    retry: { allowed: true },
  }, { operation: 'wind.stock.snapshot', exitCode: 1 })
  assert.equal(noMode.error.retry, 'never')

  // An unrecognized mode is not a retryable instruction either.
  const unknownMode = normalizeWindEnvelope({
    code: 'ROUTE_ERROR',
    retry: { allowed: true, mode: 'immediate' },
  }, { operation: 'wind.stock.snapshot', exitCode: 1 })
  assert.equal(unknownMode.error.retry, 'never')
})

test('wind circuit breaker tripped forces never and keeps the breaker directive', () => {
  const envelope = normalizeWindEnvelope({
    code: 'INVALID_PARAMS_JSON',
    retry: { allowed: false, mode: 'none', max_attempts: 0 },
    circuit_breaker: { tripped: true, scope: 'batch', action: 'abort_remaining_calls' },
    agent_action: '停止后续批量调用',
  }, { operation: 'wind.stock.snapshot', exitCode: 1 })
  assert.equal(envelope.error.retry, 'never')
  assert.deepEqual(envelope.error.circuitBreaker, { tripped: true, scope: 'batch', action: 'abort_remaining_calls' })
  assert.equal(envelope.error.agentAction, '停止后续批量调用')
  assert.ok(envelope.warnings.some(w => w.code === 'wind.agent-action'))
})

test('wind inner payload that is not JSON fails with a never retry', () => {
  const envelope = normalizeWindEnvelope({
    content: [{ type: 'text', text: 'not json {' }],
  }, { operation: 'wind.stock.snapshot', exitCode: 0 })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'WIND_INVALID_INNER_PAYLOAD')
  assert.equal(envelope.error.retry, 'never')
})

test('wind null markers survive normalization (missing ≠ 0)', () => {
  const raw = windRaw({ content: [{ type: 'text', text: JSON.stringify({ data: { columns: ['code', 'pe'], rows: [['000001.SZ', null]], unit: '倍' } }) }] })
  const envelope = normalizeWindEnvelope(raw, { operation: 'wind.stock.snapshot', exitCode: 0 })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.data.data.rows[0][1], null)
  assert.equal(envelope.provenance.unit, '倍')
})

// ---------------------------------------------------------------------------
// zyt normalization (§5.2)
// ---------------------------------------------------------------------------

test('zyt success keeps entries and the payload verbatim', () => {
  const envelope = normalizeZytEnvelope(
    { entries: [{ id: 'city', name: '上海' }] },
    { operation: 'zyt.indicators.catalog', exitCode: 0 },
  )
  assert.equal(envelope.ok, true)
  assert.equal(envelope.provenance.provider, 'zyt')
  assert.deepEqual(envelope.data, { entries: [{ id: 'city', name: '上海' }] })
})

test('zyt dataView external sets the caliber and warns; internal does not', () => {
  const external = normalizeZytEnvelope({ entries: [] }, { operation: 'zyt.auth.me', exitCode: 0, dataView: 'external' })
  assert.equal(external.ok, true)
  assert.match(external.provenance.caliber, /zyt\.external/)
  assert.ok(external.warnings.some(w => w.code === 'zyt.external-indexed'))

  const internal = normalizeZytEnvelope({ entries: [] }, { operation: 'zyt.auth.me', exitCode: 0, dataView: 'internal' })
  assert.match(internal.provenance.caliber, /zyt\.internal/)
  assert.equal(internal.warnings.length, 0)
})

test('zyt unit is preserved from payload and nested data', () => {
  const fromTop = normalizeZytEnvelope({ entries: [], unit: '套' }, { operation: 'zyt.indicators.series', exitCode: 0 })
  assert.equal(fromTop.provenance.unit, '套')
  const fromData = normalizeZytEnvelope({ data: { columns: ['月份'], rows: [], unit: '元/㎡' } }, { operation: 'zyt.indicators.series', exitCode: 0 })
  assert.equal(fromData.provenance.unit, '元/㎡')
})

test('zyt exit codes map to the right retry directives', () => {
  // 1 = business parameter error → correct-input, code from error payload.
  const business = normalizeZytEnvelope(
    { error: { code: 'CITY_NOT_ALLOWED', message: '城市不在允许列表', httpStatus: 400 } },
    { operation: 'zyt.indicators.series', exitCode: 1 },
  )
  assert.equal(business.error.code, 'CITY_NOT_ALLOWED')
  assert.equal(business.error.retry, 'correct-input')
  assert.equal(business.error.details.httpStatus, 400)

  // 2 = auth → never.
  const auth = normalizeZytEnvelope({}, { operation: 'zyt.indicators.series', exitCode: 2 })
  assert.equal(auth.error.code, 'ZYT_AUTH_ERROR')
  assert.equal(auth.error.retry, 'never')

  // 3 = network/5xx → backoff.
  const network = normalizeZytEnvelope(
    { error: { message: 'upstream 503', httpStatus: 503 } },
    { operation: 'zyt.indicators.series', exitCode: 3 },
  )
  assert.equal(network.error.code, 'ZYT_NETWORK_ERROR')
  assert.equal(network.error.retry, 'backoff')
  assert.equal(network.error.details.httpStatus, 503)
})

test('zyt exit 0 with an error payload maps httpStatus to retry', () => {
  const envelope = normalizeZytEnvelope(
    { error: { code: 'ZYT_API_ERROR', message: 'upstream 500', httpStatus: 500 } },
    { operation: 'zyt.indicators.series', exitCode: 0 },
  )
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.retry, 'backoff')
  assert.equal(envelope.error.code, 'ZYT_API_ERROR')
})

// ---------------------------------------------------------------------------
// Executable invoke seam — registry attach/detach/invoke (§3.2)
// ---------------------------------------------------------------------------

/** A Host-injected fake adapter; `handler` receives the adapter request. */
function fakeInvoker(providerId, handler) {
  return { providerId, invoke: async request => handler(request) }
}

/** Resolve a bound capability, asserting it binds. */
function resolvedBinding(registry, capability, constraints = {}) {
  const result = new CapabilityResolver(registry).resolve({ capability, constraints })
  assert.equal(result.status, 'bound', `capability ${capability} must bind`)
  return result.binding
}

test('attach requires a registered provider and records an audit entry', () => {
  const registry = registryWith()
  const bad = registry.attach(fakeInvoker('ghost', () => okEnvelope({}, { provider: 'ghost', operation: 'x' })))
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /not registered/)
  const ok = registry.attach(fakeInvoker('wind', () => okEnvelope({}, { provider: 'wind', operation: 'wind.stock.snapshot' })))
  assert.equal(ok.ok, true)
  assert.equal(ok.providerId, 'wind')
  assert.equal(registry.hasInvoker('wind'), true)
  const kinds = registry.audit().map(e => e.kind)
  assert.deepEqual(kinds, ['register', 'register', 'attach'])
})

test('duplicate attach fails without replace; detach records an audit entry', () => {
  const registry = registryWith()
  const invoker = fakeInvoker('wind', () => okEnvelope({}, { provider: 'wind', operation: 'wind.stock.snapshot' }))
  assert.equal(registry.attach(invoker).ok, true)
  const dup = registry.attach(invoker)
  assert.equal(dup.ok, false)
  assert.match(dup.reason, /already attached/)
  assert.equal(registry.attach(invoker, { replace: true }).ok, true)
  assert.equal(registry.detach('wind').ok, true)
  assert.equal(registry.hasInvoker('wind'), false)
  assert.equal(registry.detach('wind').ok, false, 'double detach fails')
  assert.deepEqual(registry.audit().map(e => e.kind), ['register', 'register', 'attach', 'attach', 'detach'])
})

test('unregister detaches the invoker so re-registration cannot reuse a stale adapter', async () => {
  const registry = registryWith()
  let calls = 0
  registry.attach(fakeInvoker('wind', async () => {
    calls++
    return okEnvelope({}, { provider: 'wind', operation: 'wind.stock.snapshot' })
  }))
  assert.equal(registry.hasInvoker('wind'), true)

  // unregister must drop the adapter…
  assert.equal(registry.unregister('wind').ok, true)
  assert.equal(registry.hasInvoker('wind'), false, 'unregister must detach the invoker')

  // …and the audit records the detach deterministically before the unregister.
  assert.deepEqual(registry.audit().map(e => [e.kind, e.providerId]), [
    ['register', 'wind'],
    ['register', 'zyt'],
    ['attach', 'wind'],
    ['detach', 'wind'],
    ['unregister', 'wind'],
  ])

  // Re-registering the same id must NOT bring the stale adapter back.
  registry.register(windManifest())
  assert.equal(registry.hasInvoker('wind'), false, 're-registration must not resurrect the stale invoker')
  const binding = resolvedBinding(registry, 'financial.stock.snapshot')
  const envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'no-invoker-attached')
  assert.equal(calls, 0, 'the stale adapter must never be invoked')
})

test('invoke executes a resolved binding, freezes the result and audits ok', async () => {
  const registry = registryWith()
  const seen = []
  registry.attach(fakeInvoker('wind', async request => {
    seen.push(request)
    return okEnvelope(
      { close: 1521.5 },
      { provider: 'wind', operation: 'wind.stock.snapshot', transportId: 'mcp-1', fetchedAt: '2026-08-01T00:00:00.000Z' },
    )
  }))
  const binding = resolvedBinding(registry, 'financial.stock.snapshot')
  const envelope = await registry.invoke({ binding, input: { windcode: '600519.SH' }, context: 't2c 采集' })
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.data, { close: 1521.5 })
  assert.equal(envelope.provenance.provider, 'wind')
  assert.equal(seen[0].operation, 'wind.stock.snapshot')
  assert.equal(seen[0].transportId, 'mcp-1')
  assert.deepEqual(seen[0].input, { windcode: '600519.SH' })
  assert.equal(seen[0].context, 't2c 采集')
  assert.ok(Object.isFrozen(envelope), 'invoke result must be frozen')
  const invokeAudits = registry.audit().filter(e => e.kind === 'invoke')
  assert.equal(invokeAudits.length, 1)
  assert.equal(invokeAudits[0].operation, 'wind.stock.snapshot')
  assert.equal(invokeAudits[0].outcome, 'ok')
  assert.equal(invokeAudits[0].version, binding.providerVersion)
})

test('stale bindings are rejected: removed provider, version replace, operation gone', async () => {
  const registry = registryWith()
  registry.attach(fakeInvoker('wind', () => okEnvelope({}, { provider: 'wind', operation: 'wind.stock.snapshot' })))
  const binding = resolvedBinding(registry, 'financial.stock.snapshot')

  // removed provider
  registry.unregister('wind')
  let envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'binding-stale')
  assert.equal(envelope.error.retry, 'never')
  assert.match(envelope.error.details.reason, /provider-removed/)

  // re-register at a newer version → old binding version no longer matches
  registry.register({ ...windManifest(), version: '1.1.0' }, { replace: true })
  envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.error.code, 'binding-stale')
  assert.match(envelope.error.details.reason, /provider-version-changed/)

  // same-version replace that drops the operation → operation gone
  const withoutOp = windManifest()
  withoutOp.capabilities = withoutOp.capabilities.filter(c => c.capability !== 'financial.stock.snapshot')
  registry.register({ ...withoutOp, version: '1.0.0' }, { replace: true })
  envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.error.code, 'binding-stale')
  assert.match(envelope.error.details.reason, /operation-missing/)
  // failures are audited with outcome fail
  assert.equal(registry.audit().filter(e => e.kind === 'invoke').every(e => e.outcome === 'fail'), true)
})

test('write transports require an explicit approved flag', async () => {
  const registry = new ProviderRegistry([beikeManifest()])
  registry.attach(fakeInvoker('beike', () => okEnvelope({}, { provider: 'beike', operation: 'beike.rent.appoint' })))
  const binding = resolvedBinding(registry, 'realestate.rent.appoint', { readOnly: false })
  let envelope = await registry.invoke({ binding, input: { houseCode: 'x' } })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'write-requires-approval')
  assert.equal(envelope.error.retry, 'never')
  assert.match(envelope.error.correction, /approval/)
  // the invoker is never reached without approval
  assert.equal(registry.audit().filter(e => e.kind === 'invoke').length, 1)
  envelope = await registry.invoke({ binding, input: { houseCode: 'x' }, approved: true })
  assert.equal(envelope.ok, true)
})

test('invoke rejects a missing invoker and provenance mismatches', async () => {
  const registry = registryWith()
  const binding = resolvedBinding(registry, 'financial.stock.snapshot')

  let envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'no-invoker-attached')

  // wrong provider in provenance
  registry.attach(fakeInvoker('wind', () => okEnvelope({}, { provider: 'zyt', operation: 'wind.stock.snapshot' })))
  envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.error.code, 'provenance-provider-mismatch')

  // wrong operation in provenance
  registry.attach(fakeInvoker('wind', () => okEnvelope({}, { provider: 'wind', operation: 'wind.macro.query' })), { replace: true })
  envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.error.code, 'provenance-operation-mismatch')

  // not an envelope at all
  registry.attach(fakeInvoker('wind', async () => ({ nope: true })), { replace: true })
  envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.error.code, 'invalid-provider-envelope')
})

test('invoker exceptions are wrapped as a never-retry failure and audited', async () => {
  const registry = registryWith()
  registry.attach(fakeInvoker('wind', async () => { throw new Error('adapter boom') }))
  const binding = resolvedBinding(registry, 'financial.stock.snapshot')
  const envelope = await registry.invoke({ binding, input: {} })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'invoker-threw')
  assert.equal(envelope.error.retry, 'never')
  assert.match(envelope.error.details.message, /adapter boom/)
  const invokeAudits = registry.audit().filter(e => e.kind === 'invoke')
  assert.equal(invokeAudits[invokeAudits.length - 1].outcome, 'fail')
})

// ---------------------------------------------------------------------------
// beike normalization (§5.3 compensated error model)
// ---------------------------------------------------------------------------

test('beike success keeps the --json payload and caliber', () => {
  const envelope = normalizeBeikeEnvelope(
    { exitCode: 0, json: { code: 0, data: { dealCount: 12, unit: '套' } } },
    { operation: 'beike.deal.search', transportId: 'mcp-http-1', caliber: '贝壳成出口径' },
  )
  assert.equal(envelope.ok, true)
  assert.equal(envelope.provenance.provider, 'beike')
  assert.equal(envelope.provenance.operation, 'beike.deal.search')
  assert.equal(envelope.provenance.caliber, '贝壳成出口径')
  assert.deepEqual(envelope.data, { code: 0, data: { dealCount: 12, unit: '套' } })
})

test('beike failure uses the stable fallback code and never invents retry', () => {
  // clap parameter error (exit 2) with anyhow stderr
  const envelope = normalizeBeikeEnvelope(
    { exitCode: 2, stderr: "error: unrecognized subcommand 'buyy'\n\nUsage: beike buy …" },
    { operation: 'beike.buy.search' },
  )
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'BEIKE_ERROR')
  assert.equal(envelope.error.retry, 'never')
  assert.equal(envelope.error.details.exitCode, 2)
  assert.match(envelope.error.correction, /unrecognized subcommand/)
  assert.match(envelope.error.details.stderr, /Usage: beike buy/)

  // panic (exit 101) also gets the stable code, never a retry
  const panic = normalizeBeikeEnvelope({ exitCode: 101, stderr: "thread 'main' panicked" }, { operation: 'beike.buy.search' })
  assert.equal(panic.error.code, 'BEIKE_ERROR')
  assert.equal(panic.error.retry, 'never')
})

test('beike preserves a payload-carried error code and rejects exit-0-without-json', () => {
  const payloadCode = normalizeBeikeEnvelope(
    { exitCode: 1, json: { error: { code: 'NO_RESULT', message: 'no listing matched' } }, stderr: '' },
    { operation: 'beike.listing.search' },
  )
  assert.equal(payloadCode.ok, false)
  assert.equal(payloadCode.error.code, 'NO_RESULT')
  assert.equal(payloadCode.error.retry, 'never')
  assert.equal(payloadCode.error.details.error.message, 'no listing matched')

  const empty = normalizeBeikeEnvelope({ exitCode: 0 }, { operation: 'beike.deal.search' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'BEIKE_EMPTY_RESPONSE')
  assert.equal(empty.error.retry, 'never')
})

test('beike stderr on success becomes an informational warning', () => {
  const envelope = normalizeBeikeEnvelope(
    { exitCode: 0, json: { data: [] }, stderr: 'warning: using default city' },
    { operation: 'beike.deal.search' },
  )
  assert.equal(envelope.ok, true)
  assert.ok(envelope.warnings.some(w => w.code === 'beike.stderr' && w.severity === 'info'))
})
