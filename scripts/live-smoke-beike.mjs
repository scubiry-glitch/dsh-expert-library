/**
 * Live smoke: one real beike MCP call (house_search) through OUR transport
 * stack — ProviderRegistry + CapabilityResolver + ProviderTransports
 * (mcp-http: initialize + tools/call, Bearer auth) + beike adapter.
 *
 * Usage: node scripts/live-smoke-beike.mjs
 * Reads the key from /tmp/beike-cli/.beike/BEIKE_MCP_API_KEY (or
 * BEIKE_MCP_API_KEY env); never prints it.
 */
import { readFileSync } from 'node:fs'
import {
  buildBeikeManifest,
  beikeMCPCallParams,
  normalizeBeikeMCPHttpOutput,
} from '../lib/v2/providers/beike.js'
import { ProviderRegistry, CapabilityResolver } from '../lib/v2/provider-runtime.js'
import { ProviderTransports } from '../lib/host/provider-transports.js'

const key = process.env.BEIKE_MCP_API_KEY
  ?? (() => { try { return readFileSync('/tmp/beike-cli/.beike/BEIKE_MCP_API_KEY', 'utf8').trim() } catch { return undefined } })()
if (key === undefined || key === '') {
  console.error('no beike key (set BEIKE_MCP_API_KEY or provide /tmp/beike-cli/.beike/BEIKE_MCP_API_KEY)')
  process.exit(1)
}

const manifest = buildBeikeManifest({})
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
    const call = beikeMCPCallParams(request.operation, request.input)
    const raw = await transports.run(transport, {
      operation: request.operation,
      input: {
        method: call.method,
        params: call.params,
        headers: { Authorization: `Bearer ${key}` },
      },
      signal: request.signal,
      context: request.context,
    })
    return normalizeBeikeMCPHttpOutput(
      { status: raw.status ?? 0, body: raw.body ?? '' },
      { provider: 'beike', operation: request.operation, transportId: transport.id, source: 'https://building.ke.com/mcp' },
    )
  },
})
if (!attached.ok) {
  console.error('attach failed:', attached.reason)
  process.exit(1)
}

const resolver = new CapabilityResolver(registry)
const resolved = resolver.resolve({ capability: 'realestate.listing.search' })
if (resolved.binding === undefined) {
  console.error('resolve failed:', JSON.stringify(resolved.rejections, null, 2))
  process.exit(1)
}

const envelope = await registry.invoke({
  binding: resolved.binding,
  input: { query: '陆家嘴 两室', city_name: '上海' },
  context: 'live-smoke',
})

const summarize = (value, depth = 0) => {
  if (depth > 3) return '…'
  if (Array.isArray(value)) return value.length > 3 ? [...value.slice(0, 3).map(v => summarize(v, depth + 1)), `(${value.length} items)`] : value.map(v => summarize(v, depth + 1))
  if (typeof value === 'object' && value !== null) {
    const out = {}
    for (const [k, v] of Object.entries(value).slice(0, 12)) out[k] = summarize(v, depth + 1)
    return out
  }
  return value
}
console.log(JSON.stringify({
  ok: envelope.ok,
  provenance: envelope.provenance,
  warnings: envelope.warnings,
  error: envelope.error,
  data: envelope.ok ? summarize(envelope.data) : undefined,
}, null, 2))
