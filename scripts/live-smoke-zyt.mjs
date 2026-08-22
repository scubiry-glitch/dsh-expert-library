/**
 * Live smoke: one real zyt call (身份/me) through OUR transport stack —
 * ProviderRegistry + CapabilityResolver + ProviderTransports(http-api) +
 * zyt adapter — verifying dataView→caliber threading against the live API.
 *
 * Usage: node scripts/live-smoke-zyt.mjs
 * Reads the key from ~/.config/zyt/config.json; never prints it.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  buildZytManifest,
  zytPlanFromOperation,
  normalizeZytHttpOutput,
  extractZytApiKey,
} from '../lib/v2/providers/zyt.js'
import { ProviderRegistry, CapabilityResolver } from '../lib/v2/provider-runtime.js'
import { ProviderTransports } from '../lib/host/provider-transports.js'

const configPath = `${homedir()}/.config/zyt/config.json`
const configRaw = readFileSync(configPath, 'utf8')
const config = JSON.parse(configRaw)
const baseUrl = config.baseUrl ?? 'https://dss.ke.com'
const apiKey = extractZytApiKey(configRaw)
if (apiKey === undefined) {
  console.error('no zyt api key resolvable from', configPath)
  process.exit(1)
}

const manifest = buildZytManifest({ baseUrl })
const registry = new ProviderRegistry()
const registered = registry.register(manifest)
if (!registered.ok) {
  console.error('register failed:', JSON.stringify(registered.diagnostics, null, 2))
  process.exit(1)
}

const transports = new ProviderTransports()
const attached = registry.attach({
  providerId: manifest.id,
  async invoke(request) {
    const transport = manifest.transports.find(t => t.id === request.transportId)
    const plan = zytPlanFromOperation(request.operation, request.input)
    const raw = await transports.run(transport, {
      operation: request.operation,
      input: {
        method: plan.method ?? 'GET',
        path: plan.path ?? '/',
        ...(plan.query === undefined ? {} : { query: plan.query }),
        ...(plan.body === undefined ? {} : { body: plan.body }),
        headers: { 'X-Api-Key': apiKey },
      },
      signal: request.signal,
      context: request.context,
    })
    return normalizeZytHttpOutput(
      { status: raw.status ?? 0, body: raw.body ?? '' },
      { provider: 'zyt', operation: request.operation, transportId: transport.id, source: baseUrl },
    )
  },
})
if (!attached.ok) {
  console.error('attach failed:', attached.reason)
  process.exit(1)
}

const resolver = new CapabilityResolver(registry)
const resolved = resolver.resolve({ capability: 'realestate.auth.identity' })
if (resolved.binding === undefined) {
  console.error('resolve failed:', JSON.stringify(resolved.rejections, null, 2))
  process.exit(1)
}

const envelope = await registry.invoke({
  binding: resolved.binding,
  input: {},
  context: 'live-smoke',
})

const data = envelope.ok ? envelope.data : undefined
console.log(JSON.stringify({
  ok: envelope.ok,
  provenance: envelope.provenance,
  warnings: envelope.warnings,
  error: envelope.error,
  identity: data === undefined ? undefined : {
    name: data.name,
    tenantName: data.tenantName,
    role: data.roleLabel,
    dataView: data.dataView,
    dataViewLabel: data.dataViewLabel,
    cities: Array.isArray(data.cities) ? data.cities.length : undefined,
  },
}, null, 2))
