/**
 * Dataset gate tests — stable business datasets over provider capabilities.
 *
 * Covers:
 * - pure registry: unknown dataset, version pinning, missing caliber (incl.
 *   empty-array caliber), signature stability across key order;
 * - provenance hard gate: missing unit/source ⇒ DATA_QUALITY_INVALID;
 * - `applyDatasetRequest`: dataset→capability substitution, contradiction
 *   fail-closed, capability-only compat passthrough, "neither" error;
 * - execute-path integration through `expert_provider_call` with a fake
 *   service: substituted capability reaches the resolver, dataset metadata is
 *   stamped on success, incomplete provenance fails the fetch, contract
 *   errors fire before the service-availability check.
 *
 * All offline — no live endpoints. Runs against the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ZHIJIAN_DATASETS,
  datasetDefinition,
  resolveDatasetRequest,
  datasetRequestSignature,
  validateDatasetProvenance,
} from '../lib/host/dataset-registry.js'
import { applyDatasetRequest, registerProviderCallTool } from '../lib/host/provider-tool.js'
import { okEnvelope } from '../lib/v2/index.js'

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

function fakeService({ resolve, invoke, providers = ['zyt', 'beike', 'wind'] }) {
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

const marketBinding = {
  capability: 'realestate.indicators.timeseries',
  providerId: 'zyt',
  providerVersion: '1.0.0',
  operation: 'realestate.indicators.timeseries',
  transportId: 'api',
  caliber: '城市商品住宅成交口径',
  reason: 'dataset gate bound',
  boundAt: '2026-08-22T00:00:00.000Z',
}

/* ---------------------------------------------------------------------------
 * Pure registry
 * ------------------------------------------------------------------------- */

test('registry ships only read-only never-install datasets', () => {
  assert.ok(ZHIJIAN_DATASETS.length >= 7)
  for (const definition of ZHIJIAN_DATASETS) {
    assert.equal(definition.readOnly, true, `${definition.dataset} must be read-only`)
    assert.equal(definition.installPolicy, 'never', `${definition.dataset} must never auto-install`)
    assert.ok(definition.capabilities.length > 0)
    assert.ok(definition.requiredProvenance.includes('source'), `${definition.dataset} must require source provenance`)
  }
})

test('datasetDefinition resolves known ids and rejects unknown ones', () => {
  assert.equal(datasetDefinition('realestate.city.market')?.dataset, 'realestate.city.market')
  assert.equal(datasetDefinition('nobody.serves.this'), undefined)
})

test('resolveDatasetRequest binds the first pinned capability and validates caliber', () => {
  const resolved = resolveDatasetRequest({
    dataset: 'realestate.city.market',
    input: { city: '杭州', code: 'new_home_transaction_area', period: '2025-01' },
  })
  assert.ok('binding' in resolved)
  assert.equal(resolved.binding.id, 'realestate.indicators.timeseries')
  assert.equal(resolved.definition.version, '1.1')
  assert.match(resolved.signature, /^realestate\.city\.market\|/)

  const missing = resolveDatasetRequest({ dataset: 'realestate.city.market', input: { city: '杭州' } })
  assert.ok('error' in missing)
  assert.equal(missing.error.code, 'CALIBER_MISSING')
  assert.deepEqual(missing.error.details.missing, ['code'])

  const emptyArray = resolveDatasetRequest({ dataset: 'realestate.city.compare', input: { cities: [], period: '2025-01', metric: '成交量' } })
  assert.ok('error' in emptyArray)
  assert.equal(emptyArray.error.code, 'CALIBER_MISSING')
  assert.deepEqual(emptyArray.error.details.missing, ['cities'])
})

test('resolveDatasetRequest pins versions and rejects unknown datasets without install hints', () => {
  const version = resolveDatasetRequest({ dataset: 'realestate.city.market', version: '9.9', input: { city: '杭州', code: 'new_home_transaction_area' } })
  assert.ok('error' in version)
  assert.equal(version.error.code, 'DATASET_VERSION_UNSUPPORTED')

  const unknown = resolveDatasetRequest({ dataset: 'nope.dataset', input: {} })
  assert.ok('error' in unknown)
  assert.equal(unknown.error.code, 'DATASET_UNKNOWN')
  assert.match(unknown.error.correction, /禁止猜测/)
  assert.equal(unknown.error.retry, 'never')
})

test('datasetRequestSignature is order-insensitive and value-normalized', () => {
  const a = datasetRequestSignature('d', { city: '杭州', period: '2025-01', metric: ['成交', '挂牌'] })
  const b = datasetRequestSignature('d', { metric: ['成交', '挂牌'], period: '2025-01', city: '杭州' })
  assert.equal(a, b)
  const c = datasetRequestSignature('d', { city: '北京', period: '2025-01', metric: ['成交', '挂牌'] })
  assert.notEqual(a, c)
})

test('validateDatasetProvenance hard-gates source/caliber only (unit is a soft warning)', () => {
  const definition = datasetDefinition('realestate.city.market')
  assert.ok(definition)
  const complete = validateDatasetProvenance(definition, { source: '政研通', caliber: '商品住宅', unit: '万㎡', city: '杭州', period: '2025-01' })
  assert.equal(complete, undefined)
  const missingCaliber = validateDatasetProvenance(definition, { source: '政研通', city: '杭州', period: '2025-01' })
  assert.ok(missingCaliber)
  assert.equal(missingCaliber.code, 'DATA_QUALITY_INVALID')
  assert.deepEqual(missingCaliber.details.missing, ['caliber'])
  // unit is intentionally NOT in the hard list: the zyt series envelope does
  // not carry one — a missing unit must not hard-block the fetch.
  const missingUnit = validateDatasetProvenance(definition, { source: '政研通', caliber: '商品住宅' })
  assert.equal(missingUnit, undefined)
})

/* ---------------------------------------------------------------------------
 * applyDatasetRequest (pure gate over raw tool args)
 * ------------------------------------------------------------------------- */

test('applyDatasetRequest substitutes the pinned capability and stamps dataset metadata', () => {
  const gated = applyDatasetRequest({
    dataset: 'realestate.city.market',
    input: { city: '杭州', code: 'new_home_transaction_area', period: '2025-01' },
  })
  assert.equal(gated.ok, true)
  assert.equal(gated.capability, 'realestate.indicators.timeseries')
  assert.equal(gated.dataset.id, 'realestate.city.market')
  assert.equal(gated.dataset.version, '1.1')
  assert.ok(gated.dataset.signature.length > 0)
})

test('applyDatasetRequest fails closed on contradictions, missing input, and missing ids', () => {
  const contradiction = applyDatasetRequest({
    dataset: 'financial.stock.quote',
    capability: 'financial.macro.query',
    input: { windcode: '600519.SH' },
  })
  assert.equal(contradiction.ok, false)
  assert.equal(contradiction.error.code, 'INPUT_INVALID')
  assert.match(contradiction.error.correction, /financial\.stock\.quote/)

  const noInput = applyDatasetRequest({ dataset: 'financial.stock.quote' })
  assert.equal(noInput.ok, false)
  assert.equal(noInput.error.code, 'INPUT_INVALID')

  const neither = applyDatasetRequest({ input: {} })
  assert.equal(neither.ok, false)
  assert.equal(neither.error.code, 'INPUT_INVALID')
  assert.match(neither.error.correction, /dataset/)
})

test('applyDatasetRequest keeps capability-only calls as a compat passthrough', () => {
  const gated = applyDatasetRequest({ capability: 'financial.stock.snapshot', input: { windcode: '600519.SH' } })
  assert.equal(gated.ok, true)
  assert.equal(gated.capability, 'financial.stock.snapshot')
  assert.equal(gated.dataset, undefined)
})

/* ---------------------------------------------------------------------------
 * Execute-path integration (fake service)
 * ------------------------------------------------------------------------- */

test('dataset call binds the substituted capability at the resolver and stamps result metadata', async () => {
  const envelope = okEnvelope(
    { columns: ['period', 'value'], rows: [['2025-01', 88.6]] },
    { provider: 'zyt', operation: 'realestate.indicators.timeseries', transportId: 'api', source: '政研通', caliber: '城市商品住宅成交口径', unit: '万平方米', city: '杭州', period: '2025-01' },
  )
  const seen = []
  const service = fakeService({
    resolve: (request) => {
      seen.push(['resolve', request.capability])
      return { capability: request.capability, status: 'bound', binding: marketBinding, rejections: [] }
    },
    invoke: async (request) => {
      seen.push(['invoke', request.binding.capability, request.input])
      return envelope
    },
  })
  const tool = registerAndGetTool(service)
  const result = await tool.execute(
    { dataset: 'realestate.city.market', input: { city: '杭州', code: 'new_home_transaction_area', period: '2025-01' }, context: '智见点评·杭州' },
    exec,
  )
  assert.equal(result.ok, true)
  assert.equal(result.capability, 'realestate.indicators.timeseries')
  assert.equal(result.dataset, 'realestate.city.market')
  assert.equal(result.datasetVersion, '1.1')
  assert.match(result.signature, /^realestate\.city\.market\|/)
  assert.deepEqual(seen[0], ['resolve', 'realestate.indicators.timeseries'])
  assert.deepEqual(seen[1][2], { city: '杭州', code: 'new_home_transaction_area', period: '2025-01' })
})

test('dataset call with missing caliber fails hard; missing unit degrades to a warning', async () => {
  // missing caliber (hard) → DATA_QUALITY_INVALID
  const noCaliber = okEnvelope(
    { rows: [['2025-01', 88.6]] },
    { provider: 'zyt', operation: 'realestate.indicators.timeseries', source: '政研通' },
  )
  const failing = fakeService({
    resolve: () => ({ capability: 'realestate.indicators.timeseries', status: 'bound', binding: marketBinding, rejections: [] }),
    invoke: async () => noCaliber,
  })
  const failingTool = registerAndGetTool(failing)
  const blocked = await failingTool.execute(
    { dataset: 'realestate.city.market', input: { city: '杭州', code: 'new_home_transaction_area', period: '2025-01' } },
    exec,
  )
  assert.equal(blocked.ok, false)
  assert.equal(blocked.error.code, 'DATA_QUALITY_INVALID')
  assert.equal(blocked.error.details.missing[0], 'caliber')
  assert.equal(blocked.error.retry, 'never')

  // missing unit (soft) → ok, but a provenance.unit.missing warning rides along
  const noUnit = okEnvelope(
    { series: [{ period: '2025-01', value: 88.6 }] },
    { provider: 'zyt', operation: 'realestate.indicators.timeseries', source: '政研通', caliber: 'zyt.internal(真实绝对量)' },
  )
  const passing = fakeService({
    resolve: () => ({ capability: 'realestate.indicators.timeseries', status: 'bound', binding: marketBinding, rejections: [] }),
    invoke: async () => noUnit,
  })
  const passingTool = registerAndGetTool(passing)
  const warned = await passingTool.execute(
    { dataset: 'realestate.city.market', input: { city: '杭州', code: 'new_home_transaction_area', period: '2025-01' } },
    exec,
  )
  assert.equal(warned.ok, true)
  const codes = (warned.warnings ?? []).map(w => w.code)
  assert.ok(codes.includes('provenance.unit.missing'), 'unit warning must ride along')

  // empty series payload → dataset.empty-series warning
  const empty = okEnvelope(
    { city: '杭州', code: 'SH_VOL', series: [] },
    { provider: 'zyt', operation: 'realestate.indicators.timeseries', source: '政研通', caliber: 'zyt.internal(真实绝对量)' },
  )
  const emptyService = fakeService({
    resolve: () => ({ capability: 'realestate.indicators.timeseries', status: 'bound', binding: marketBinding, rejections: [] }),
    invoke: async () => empty,
  })
  const emptyTool = registerAndGetTool(emptyService)
  const emptyResult = await emptyTool.execute(
    { dataset: 'realestate.city.market', input: { city: '杭州', code: 'SH_VOL' } },
    exec,
  )
  assert.equal(emptyResult.ok, true)
  const emptyCodes = (emptyResult.warnings ?? []).map(w => w.code)
  assert.ok(emptyCodes.includes('dataset.empty-series'), 'empty-series warning must ride along')
})

test('dataset contract errors fire before the service-availability check (fail closed, no install hint)', async () => {
  const tool = registerAndGetTool(undefined)
  const unknown = await tool.execute({ dataset: 'nope.dataset', input: {} }, exec)
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'DATASET_UNKNOWN')
  assert.match(unknown.error.correction, /禁止猜测/)

  const caliber = await tool.execute({ dataset: 'realestate.policy', input: { city: '北京' } }, exec)
  assert.equal(caliber.ok, false)
  assert.equal(caliber.error.code, 'CALIBER_MISSING')
  assert.deepEqual(caliber.error.details.missing, ['topic'])
})

test('calls with neither dataset nor capability fail closed with INPUT_INVALID', async () => {
  const tool = registerAndGetTool(fakeService({ resolve: () => ({}), invoke: async () => okEnvelope({}) }))
  const result = await tool.execute({ input: {} }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INPUT_INVALID')
})
