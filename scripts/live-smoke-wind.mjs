/**
 * Live smoke: drive one real Wind call through OUR full transport stack
 * (ProviderRegistry + CapabilityResolver + ProviderTransports + wind adapter),
 * printing the normalized envelope — provenance/unit/first row — proving the
 * drift compensation and provenance threading work against the live backend.
 *
 * Usage: node scripts/live-smoke-wind.mjs
 * The CLI resolves its own key (~/.wind-aifinmarket/config); no secrets here.
 */
import {
  buildWindManifest,
  windCallPlan,
  normalizeWindCliOutput,
} from '../lib/v2/providers/wind.js'
import { ProviderRegistry, CapabilityResolver } from '../lib/v2/provider-runtime.js'
import { ProviderTransports } from '../lib/host/provider-transports.js'

const cliPath = '/root/.agents/skills/wind-mcp-skill/scripts/cli.mjs'
const manifest = buildWindManifest({ cliPath })

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
    const plan = windCallPlan(request.operation, request.input)
    const raw = await transports.run(transport, {
      operation: request.operation,
      input: { args: plan.args, ...(plan.env === undefined ? {} : { env: plan.env }) },
      signal: request.signal,
      context: request.context,
    })
    return normalizeWindCliOutput(raw, {
      operation: request.operation,
      transportId: request.transportId,
      provider: manifest.id,
      exitCode: raw.exitCode ?? 1,
    })
  },
})
if (!attached.ok) {
  console.error('attach failed:', attached.reason)
  process.exit(1)
}

const resolver = new CapabilityResolver(registry)
const resolved = resolver.resolve({ capability: 'financial.stock.snapshot' })
if (resolved.binding === undefined) {
  console.error('resolve failed:', JSON.stringify(resolved.rejections, null, 2))
  process.exit(1)
}

const envelope = await registry.invoke({
  binding: resolved.binding,
  input: { windcode: '600519.SH' },
  context: 'live-smoke',
})

const data = envelope.ok ? envelope.data : undefined
console.log(JSON.stringify({
  ok: envelope.ok,
  provenance: envelope.provenance,
  warnings: envelope.warnings,
  error: envelope.error,
  columns: data?.data?.columns?.map(c => c.name),
  firstRow: data?.data?.rows?.[0],
  unit: data?.data?.unit,
}, null, 2))
