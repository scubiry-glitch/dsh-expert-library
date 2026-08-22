/**
 * Phase 2 provider contract tests — pure `v2/providers/{wind,zyt,beike}`.
 *
 * - Manifests validate through the strict pack validator (via ProviderRegistry)
 *   with the expected capability → transport bindings, readOnly write gates and
 *   auth descriptors.
 * - zyt request plans are pinned against the upstream golden cases (fixtures
 *   generated from the upstream Python `build_request_plan`), plus the
 *   operation planner, CLI argv builder and error paths.
 * - Wind CLI-output normalization covers the CURRENT `{ok:false,code,message}`
 *   failure drift (§5.1 vs the installed skill), retry-code mapping, the
 *   `cli_meta.completeness` drift, and `list-tools`-style payloads.
 * - beike normalization covers the compensated error model over CLI and MCP
 *   HTTP results.
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

import {
  ProviderRegistry,
  CapabilityResolver,
  buildWindManifest,
  windCallPlan,
  normalizeWindCliOutput,
  buildZytManifest,
  buildZytRequestPlan,
  zytPlanFromOperation,
  zytCliArgvFromPlan,
  zytHttpRequestFromPlan,
  normalizeZytCliOutput,
  normalizeZytHttpOutput,
  extractZytApiKey,
  buildBeikeManifest,
  beikeMCPCallParams,
  beikeCliArgv,
  normalizeBeikeCliOutput,
  normalizeBeikeMCPHttpOutput,
} from '../lib/v2/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const goldenCases = JSON.parse(readFileSync(join(repoRoot, 'test/fixtures/zyt-request-plans.json'), 'utf8'))

/* ---------------------------------------------------------------------------
 * Manifests — registration + bindings
 * ------------------------------------------------------------------------- */

test('wind manifest registers and binds stock snapshot to the local-cli transport', () => {
  const registry = new ProviderRegistry([buildWindManifest({ cliPath: '/skills/wind-mcp-skill/scripts/cli.mjs' })])
  const wind = registry.get('wind')
  assert.ok(wind !== undefined)
  assert.equal(wind.manifest.transports[0].kind, 'local-cli')
  assert.equal(wind.manifest.transports[0].command, 'node')
  assert.deepEqual(wind.manifest.transports[0].args, ['/skills/wind-mcp-skill/scripts/cli.mjs'])
  assert.equal(wind.manifest.transports[0].auth.credentialRef, 'WIND_API_KEY')
  assert.equal(wind.manifest.discovery.operation, 'wind.discovery.list-tools')

  const result = new CapabilityResolver(registry).resolve({ capability: 'financial.stock.snapshot' })
  assert.equal(result.status, 'bound')
  assert.equal(result.binding.providerId, 'wind')
  assert.equal(result.binding.transportId, 'cli')
  assert.equal(result.binding.operation, 'financial.stock.snapshot')
})

test('zyt manifest declares http-api plus optional cli and honors preferCli', () => {
  const httpOnly = buildZytManifest()
  assert.equal(httpOnly.transports.length, 1)
  assert.equal(httpOnly.transports[0].kind, 'http-api')
  assert.equal(httpOnly.transports[0].baseUrl, 'https://dss.ke.com')
  assert.equal(httpOnly.capabilities[1].transportId, 'http')

  const withCli = buildZytManifest({ cliCommand: '/usr/local/bin/zyt' })
  assert.equal(withCli.transports.length, 2)
  assert.equal(withCli.transports[1].kind, 'local-cli')
  assert.deepEqual(withCli.transports[1].args, ['--json'])
  assert.equal(withCli.capabilities[1].transportId, 'http', 'default keeps http binding')

  const preferCli = buildZytManifest({ cliCommand: 'zyt', preferCli: true })
  assert.equal(preferCli.capabilities[1].transportId, 'cli')
  const registry = new ProviderRegistry([preferCli])
  const binding = new CapabilityResolver(registry).resolve({ capability: 'realestate.indicators.timeseries' })
  assert.equal(binding.binding.transportId, 'cli')
})

test('beike manifest: reads bind mcp-http, writes bind mcp-http-write and are gated', () => {
  const manifest = buildBeikeManifest()
  const registry = new ProviderRegistry([manifest])
  const resolver = new CapabilityResolver(registry)

  const read = resolver.resolve({ capability: 'realestate.listing.search' })
  assert.equal(read.status, 'bound')
  assert.equal(read.binding.transportId, 'mcp-http')
  assert.equal(read.binding.operation, 'beike.house_search')

  // Write ops are blocked by default (readOnly policy)…
  const blocked = resolver.resolve({ capability: 'realestate.rent.appoint' })
  assert.equal(blocked.status, 'unavailable')
  assert.ok(blocked.rejections.some(r => r.reason === 'write-transport-requires-approval'))
  // …and resolve only with an explicit readOnly:false constraint, onto the write transport.
  const allowed = resolver.resolve({ capability: 'realestate.rent.appoint', constraints: { readOnly: false } })
  assert.equal(allowed.status, 'bound')
  assert.equal(allowed.binding.transportId, 'mcp-http-write')
  const writeTransport = manifest.transports.find(t => t.id === 'mcp-http-write')
  assert.equal(writeTransport.readOnly, false)
  assert.match(writeTransport.auth.credentialRef, /BEIKE_MCP_API_KEY/)
})

test('zyt caveats mark live gaps; beike caveats carry the 2026-08-22 live verification', () => {
  const zyt = buildZytManifest()
  assert.ok(zyt.caveats.some(c => c.includes('待实测')), 'zyt live schema marked unverified')
  const beike = buildBeikeManifest()
  assert.ok(beike.caveats.some(c => c.includes('【实测 2026-08-22】')), 'beike live verification recorded')
  assert.ok(beike.caveats.some(c => c.includes('17 个工具')), 'live tool count recorded')
})

/* ---------------------------------------------------------------------------
 * Wind CLI output normalization — §5.1 drift compensation
 * ------------------------------------------------------------------------- */

const windOptions = { operation: 'financial.stock.snapshot', exitCode: 0, transportId: 'cli' }

test('wind current failure envelope {ok:false,code,message} maps to a never-retry with correction', () => {
  const envelope = normalizeWindCliOutput({
    exitCode: 1,
    stdout: JSON.stringify({ ok: false, code: 'AUTH_ERROR', message: '认证失败，请检查 API Key' }),
  }, windOptions)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'AUTH_ERROR')
  assert.equal(envelope.error.retry, 'never')
  assert.equal(envelope.error.correction, '认证失败，请检查 API Key')
  assert.equal(envelope.error.details.message, '认证失败，请检查 API Key')
  assert.equal(envelope.error.details.exitCode, 1)
  assert.ok(envelope.warnings.some(w => w.code === 'wind.auth'))
})

test('wind RATE_LIMIT_ERROR and NETWORK_ERROR map to backoff; others stay never', () => {
  const rate = normalizeWindCliOutput({ exitCode: 1, stdout: JSON.stringify({ ok: false, code: 'RATE_LIMIT_ERROR', message: '请求过于频繁' }) }, windOptions)
  assert.equal(rate.error.retry, 'backoff')
  const network = normalizeWindCliOutput({ exitCode: 1, stdout: JSON.stringify({ ok: false, code: 'NETWORK_ERROR', message: '服务暂时不可用' }) }, windOptions)
  assert.equal(network.error.retry, 'backoff')
  const usage = normalizeWindCliOutput({ exitCode: 0, stdout: JSON.stringify({ ok: false, code: 'USAGE_ERROR', message: 'USAGE:\ncli.mjs call …' }) }, windOptions)
  assert.equal(usage.ok, false, 'USAGE_ERROR exits 0 but is still a failure')
  assert.equal(usage.error.code, 'USAGE_ERROR')
  assert.equal(usage.error.retry, 'never')
  const backend = normalizeWindCliOutput({ exitCode: 1, stdout: JSON.stringify({ ok: false, code: 'backend_error', message: '接口原文' }) }, windOptions)
  assert.equal(backend.error.retry, 'never', 'backend business errors are never blanket-retried')
})

test('wind success unwraps the double-layer envelope and unit, with completeness drift normalized', () => {
  const inner = JSON.stringify({ data: { columns: ['windcode', 'close'], rows: [['600519.SH', 1521.5]], unit: '元' } })
  const envelope = normalizeWindCliOutput({
    exitCode: 0,
    stdout: JSON.stringify({
      content: [{ type: 'text', text: inner }],
      cli_meta: { schema_version: '1.0', server_type: 'stock_data', tool_name: 'get_stock_price_indicators', completeness: 'not_asserted', tables: [], warnings: [] },
    }),
  }, windOptions)
  assert.equal(envelope.ok, true)
  assert.equal(envelope.provenance.unit, '元')
  assert.deepEqual(envelope.data, JSON.parse(inner))
  // completeness 'not_asserted' with no warnings must not surface a warning.
  assert.equal(envelope.warnings.some(w => w.code === 'wind.cli-meta.completeness'), false)
})

test('wind list-tools payload (no text content) is returned verbatim', () => {
  const envelope = normalizeWindCliOutput({
    exitCode: 0,
    stdout: JSON.stringify({ server_type: 'stock_data', tools: [{ name: 'get_stock_quote' }] }),
  }, { operation: 'wind.discovery.list-tools', exitCode: 0, transportId: 'cli' })
  assert.equal(envelope.ok, true)
  assert.deepEqual(envelope.data.tools, [{ name: 'get_stock_quote' }])
})

test('wind non-JSON stdout fails closed with WIND_INVALID_CLI_OUTPUT', () => {
  const envelope = normalizeWindCliOutput({ exitCode: 1, stdout: 'panic: not json', stderr: 'boom' }, windOptions)
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'WIND_INVALID_CLI_OUTPUT')
  assert.equal(envelope.error.retry, 'never')
})

test('windCallPlan routes operations to server_type/tool and keeps params verbatim', () => {
  const plan = windCallPlan('financial.stock.snapshot', { windcode: '600519.SH' })
  assert.deepEqual(plan.args, ['call', 'stock_data', 'get_stock_price_indicators', '{"windcode":"600519.SH"}'])
  const discovery = windCallPlan('wind.discovery.list-tools', { serverType: 'fund_data' })
  assert.deepEqual(discovery.args, ['list-tools', 'fund_data'])
  const discoveryDefault = windCallPlan('wind.discovery.list-tools', {})
  assert.deepEqual(discoveryDefault.args, ['list-tools', 'stock_data'])
  assert.throws(() => windCallPlan('unknown.op', {}), /unknown wind operation/)
})

/* ---------------------------------------------------------------------------
 * zyt request plans — upstream golden parity + operation planner
 * ------------------------------------------------------------------------- */

test('buildZytRequestPlan matches every upstream golden case (Chinese + English)', () => {
  for (const { argv, plan } of goldenCases) {
    assert.deepEqual(buildZytRequestPlan(argv), plan, `argv ${JSON.stringify(argv)}`)
  }
})

test('buildZytRequestPlan local config commands and validation errors', () => {
  assert.deepEqual(buildZytRequestPlan(['配置', 'show']), { command: '配置', local: true, action: 'show' })
  assert.deepEqual(buildZytRequestPlan(['config', 'set']), { command: '配置', local: true, action: 'set' })
  assert.throws(() => buildZytRequestPlan([]), /缺少命令/)
  assert.throws(() => buildZytRequestPlan(['指标时序']), /缺少必填参数/)
  assert.throws(() => buildZytRequestPlan(['多城对比']), /缺少必填参数 cities/)
  assert.throws(() => buildZytRequestPlan(['nonsense']), /未知命令/)
})

test('zytPlanFromOperation maps capability inputs to plans and validates required params', () => {
  const series = zytPlanFromOperation('zyt.indicators.series', { city: '北京', code: 'SH_PRICE', periodEnd: '2026-06', limit: '6' })
  assert.equal(series.command, '指标时序')
  assert.deepEqual(series.query, { city: '北京', code: 'SH_PRICE', periodEnd: '2026-06', limit: '6' })

  const batch = zytPlanFromOperation('zyt.indicators.batch-series', { city: '北京', queries: [{ code: 'SH_PRICE' }], limit: 3 })
  assert.equal(batch.method, 'POST')
  assert.deepEqual(batch.body, { city: '北京', queries: [{ code: 'SH_PRICE' }], limit: 3 })

  const me = zytPlanFromOperation('zyt.auth.identity', {})
  assert.deepEqual(me, { command: '身份', method: 'GET', path: '/openapi/v1/me', query: {}, body: null })

  assert.throws(() => zytPlanFromOperation('zyt.indicators.series', { city: '北京' }), /code/)
  assert.throws(() => zytPlanFromOperation('unknown.zyt.op', {}), /unknown zyt operation/)
})

test('zytCliArgvFromPlan and zytHttpRequestFromPlan derive from one plan', () => {
  const plan = buildZytRequestPlan(['指标时序', '--城市', '北京', '--指标', 'SH_PRICE', '--期数', '6'])
  // canonical plan → canonical (English) flags — both alias sets are valid per contract
  assert.deepEqual(zytCliArgvFromPlan(plan), ['指标时序', '--city', '北京', '--code', 'SH_PRICE', '--limit', '6'])
  const http = zytHttpRequestFromPlan(plan, 'https://dss.ke.com')
  assert.equal(http.method, 'GET')
  assert.equal(http.url, 'https://dss.ke.com/openapi/v1/indicators/series?city=%E5%8C%97%E4%BA%AC&code=SH_PRICE&limit=6')

  const batch = buildZytRequestPlan(['批量时序', '--city', '北京', '--queries', '[{"code":"SH_PRICE"}]', '--limit', '3'])
  assert.deepEqual(zytCliArgvFromPlan(batch), ['批量时序', '--city', '北京', '--queries', '[{"code":"SH_PRICE"}]', '--limit', '3'])
  const report = buildZytRequestPlan(['报告详情', 'rep-1'])
  assert.deepEqual(zytCliArgvFromPlan(report), ['报告详情', 'rep-1'])
  assert.deepEqual(zytCliArgvFromPlan({ command: '配置', local: true }), [])
})

test('zyt CLI output normalizer preserves exit codes and dataView caliber', () => {
  const authFail = normalizeZytCliOutput({ exitCode: 2, stdout: JSON.stringify({ error: { code: 'INVALID_API_KEY', message: 'bad key', httpStatus: 401 } }) }, { operation: 'zyt.auth.me', exitCode: 2 })
  assert.equal(authFail.ok, false)
  assert.equal(authFail.error.code, 'ZYT_AUTH_ERROR')
  assert.equal(authFail.error.retry, 'never')

  const business = normalizeZytCliOutput({ exitCode: 1, stdout: JSON.stringify({ error: { code: 'CITY_NOT_ALLOWED', message: '城市不在允许列表' } }) }, { operation: 'zyt.indicators.series', exitCode: 1 })
  assert.equal(business.error.code, 'CITY_NOT_ALLOWED')
  assert.equal(business.error.retry, 'correct-input')

  const external = normalizeZytCliOutput({ exitCode: 0, stdout: JSON.stringify({ entries: [], dataView: 'external' }) }, { operation: 'zyt.auth.me', exitCode: 0 })
  assert.equal(external.ok, true)
  assert.match(external.provenance.caliber, /zyt\.external/)
  assert.ok(external.warnings.some(w => w.code === 'zyt.external-indexed'))

  const invalid = normalizeZytCliOutput({ exitCode: 1, stdout: 'not json' }, { operation: 'zyt.indicators.series', exitCode: 1 })
  assert.equal(invalid.error.code, 'ZYT_INVALID_CLI_OUTPUT')
})

test('zyt HTTP output normalizer maps status codes to auth/business/network semantics', () => {
  const ok = normalizeZytHttpOutput({ status: 200, body: JSON.stringify({ entries: [{ id: 'city' }] }) }, { operation: 'zyt.indicators.catalog', exitCode: 0 })
  assert.equal(ok.ok, true)

  const auth = normalizeZytHttpOutput({ status: 401, body: JSON.stringify({ error: { code: 'INVALID_API_KEY', httpStatus: 401 } }) }, { operation: 'zyt.indicators.catalog', exitCode: 0 })
  assert.equal(auth.error.code, 'ZYT_AUTH_ERROR')
  assert.equal(auth.error.retry, 'never')

  const upstream = normalizeZytHttpOutput({ status: 503, body: JSON.stringify({ error: { message: 'upstream down', httpStatus: 503 } }) }, { operation: 'zyt.indicators.catalog', exitCode: 0 })
  assert.equal(upstream.error.retry, 'backoff')

  const bad = normalizeZytHttpOutput({ status: 400, body: JSON.stringify({ error: { code: 'BAD_PARAM', message: 'nope', httpStatus: 400 } }) }, { operation: 'zyt.indicators.catalog', exitCode: 0 })
  assert.equal(bad.error.code, 'BAD_PARAM')
  assert.equal(bad.error.retry, 'correct-input')
})

test('extractZytApiKey handles env keys and the {baseUrl,apiKey} config file JSON', () => {
  assert.equal(extractZytApiKey('btg_live-key-123'), 'btg_live-key-123')
  assert.equal(extractZytApiKey(JSON.stringify({ baseUrl: 'https://dss.ke.com', apiKey: 'btg_from-file-9' })), 'btg_from-file-9')
  assert.equal(extractZytApiKey('  '), undefined)
  assert.equal(extractZytApiKey(undefined), undefined)
  assert.equal(extractZytApiKey('{broken json'), undefined)
})

/* ---------------------------------------------------------------------------
 * beike normalization — compensated error model
 * ------------------------------------------------------------------------- */

const beikeOptions = { operation: 'beike.deal.search', transportId: 'mcp-http', caliber: '贝壳成出口径' }

test('beike CLI success keeps the --json payload; failure uses the stable code, never a retry', () => {
  const ok = normalizeBeikeCliOutput({ exitCode: 0, stdout: JSON.stringify({ code: 0, data: { dealCount: 12, unit: '套' } }) }, beikeOptions)
  assert.equal(ok.ok, true)
  assert.equal(ok.provenance.caliber, '贝壳成出口径')
  assert.deepEqual(ok.data, { code: 0, data: { dealCount: 12, unit: '套' } })

  const clap = normalizeBeikeCliOutput({ exitCode: 2, stdout: 'not json', stderr: "error: unrecognized subcommand 'buyy'" }, { operation: 'beike.buy.search' })
  assert.equal(clap.ok, false)
  assert.equal(clap.error.code, 'BEIKE_ERROR')
  assert.equal(clap.error.retry, 'never')
  assert.match(clap.error.details.stderr, /unrecognized subcommand/)
})

test('beike MCP HTTP result unwraps content[0].text; JSON-RPC errors map with the payload code', () => {
  const inner = JSON.stringify({ code: 0, data: { list: [] }, unit: '套' })
  const ok = normalizeBeikeMCPHttpOutput({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: inner }] } }) }, beikeOptions)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.data, JSON.parse(inner))

  const jsonrpcError = normalizeBeikeMCPHttpOutput({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }) }, beikeOptions)
  assert.equal(jsonrpcError.ok, false)
  assert.equal(jsonrpcError.error.code, 'BEIKE_MCP_ERROR')
  assert.equal(jsonrpcError.error.retry, 'never')
  assert.equal(jsonrpcError.error.correction, 'method not found')

  const httpError = normalizeBeikeMCPHttpOutput({ status: 500, body: 'gateway error' }, beikeOptions)
  assert.equal(httpError.ok, false)
  assert.equal(httpError.error.code, 'BEIKE_HTTP_ERROR')
  assert.equal(httpError.error.retry, 'never', 'caller decides; never invented')
})

test('beike planners produce MCP call params and CLI argv (live-verified surface)', () => {
  const call = beikeMCPCallParams('realestate.listing.search', { city: '上海' })
  assert.equal(call.method, 'tools/call')
  assert.equal(call.params.name, 'house_search')
  assert.deepEqual(call.params.arguments, { city: '上海' })

  assert.deepEqual(beikeCliArgv('realestate.listing.search', { city: '上海' }), ['house_search', '--city', '上海'])
  assert.throws(() => beikeMCPCallParams('unknown.beike.op', {}), /unknown beike operation/)
})
