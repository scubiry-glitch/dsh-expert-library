/** Regression from the round5 real policy response. Offline injected HTTP only. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBeikeMCPHttpOutput, normalizeBeikeCliOutput } from '../lib/v2/providers/beike.js'
import { ProviderTransportService } from '../lib/host/provider-service.js'
import { registerProviderCallTool } from '../lib/host/provider-tool.js'

const outage = 'service temporarily unavailable'
const options = { operation: 'beike.policy_search', source: 'fixture://beike', caliber: 'fixture' }
const mcp = result => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] })
const normalize = result => normalizeBeikeMCPHttpOutput(mcp(result), options)
const initialized = { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture' } } }), truncated: false }

function fixtureTool(finalResponse, initializeResponse = initialized) {
  let tool
  const calls = []
  const service = new ProviderTransportService({ get: () => undefined }, {
    beike: { baseUrl: 'https://provider.invalid/mcp' },
    credentials: () => 'fixture-only-secret',
    fetch: async request => {
      const body = JSON.parse(request.body)
      calls.push(body.method)
      return body.method === 'initialize' ? initializeResponse : finalResponse
    },
  })
  registerProviderCallTool({ tools: { register: value => { tool = value } }, get: name => name === 'providerTransport' ? service : undefined })
  return { tool, calls }
}
const exec = { signal: new AbortController().signal }
const args = { dataset: 'realestate.policy', input: { city: '北京', topic: '限购限贷' } }

function rejected(value, code) {
  assert.equal(value.ok, false)
  assert.equal(value.data, undefined, 'failure must never occupy the success data field')
  assert.equal(value.error.retry, 'never', 'normalization must not invent automatic retry')
  if (code) assert.equal(value.error.code, code)
}

test('MCP isError outranks apparently valid text and keeps bounded failure evidence', () => {
  const value = normalize({ isError: true, content: [{ type: 'text', text: '[]' }, { type: 'text', text: outage + 'x'.repeat(5000) }] })
  rejected(value, 'BEIKE_MCP_TOOL_ERROR')
  assert.equal(value.error.details.isError, true)
  assert.match(value.error.details.response, /service temporarily unavailable/)
  assert.ok(value.error.details.response.length <= 2000)
})

for (const [label, payload] of Object.entries({
  stringError: { error: outage },
  structuredError: { error: { code: 'UPSTREAM_DOWN', message: outage } },
  booleanError: { error: true, message: outage },
  falseOk: { ok: false, message: outage },
  falseSuccess: { success: false, message: outage },
  errorStatus: { status: 'error', message: outage },
  failedStatus: { status: 'failed', message: outage },
})) {
  test(`explicit top-level ${label} fails in both MCP and exit-zero CLI`, () => {
    rejected(normalize(text(payload)))
    rejected(normalizeBeikeCliOutput({ exitCode: 0, stdout: JSON.stringify(payload) }, options))
  })
}

test('exact observed outage sentinel fails', () => {
  rejected(normalize(text(outage)), 'BEIKE_SERVICE_UNAVAILABLE')
  rejected(normalize(text('  Service Temporarily Unavailable\n')), 'BEIKE_SERVICE_UNAVAILABLE')
})

test('genuine prose, empty success and nested business fields are not scanned for failure words', () => {
  const valid = [
    'The policy report notes a service temporarily unavailable incident last month.',
    '税费政策说明：暂无适用优惠。',
    [],
    { code: 0, data: { list: [] } },
    { data: { error: outage, status: 'failed' } },
    { error: null, success: true, data: [] },
    { error: false, success: true, data: [] },
    { error: '', success: true, data: [] },
    { status: 'active', message: 'Policy applies from today.' },
  ]
  for (const payload of valid) assert.equal(normalize(text(payload)).ok, true, JSON.stringify(payload))
})

test('real service plus registered tool never renders MCP failure as successful policy data', async () => {
  const { tool, calls } = fixtureTool({ ...mcp({ isError: true, ...text(outage) }), truncated: false })
  const value = await tool.execute(args, exec)
  rejected(value, 'BEIKE_MCP_TOOL_ERROR')
  assert.deepEqual(calls, ['initialize', 'tools/call'])
  const rendered = tool.output.render(args, value)[0].text
  assert.match(rendered, /失败/)
  assert.doesNotMatch(rendered, /成功/)
  assert.doesNotMatch(JSON.stringify(value), /fixture-only-secret/)
})

test('observed plain outage text without MCP error flag also renders failure through the real service', async () => {
  const { tool, calls } = fixtureTool({ ...mcp(text(outage)), truncated: false })
  const value = await tool.execute(args, exec)
  rejected(value, 'BEIKE_SERVICE_UNAVAILABLE')
  assert.deepEqual(calls, ['initialize', 'tools/call'])
  assert.match(tool.output.render(args, value)[0].text, /失败/)
  assert.doesNotMatch(tool.output.render(args, value)[0].text, /成功/)
})

test('MCP transport preserves tools/call HTTP503 even when body resembles a successful result', async () => {
  const { tool, calls } = fixtureTool({ ...mcp(text({ data: [] })), status: 503, truncated: false })
  const value = await tool.execute(args, exec)
  rejected(value, 'BEIKE_HTTP_ERROR')
  assert.equal(value.error.details.status, 503)
  assert.deepEqual(calls, ['initialize', 'tools/call'])
})

for (const [label, response, code] of [
  ['HTTP503', { ...initialized, status: 503 }, 'BEIKE_HTTP_ERROR'],
  ['JSON-RPC error', { ...initialized, body: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: outage } }) }, 'BEIKE_MCP_ERROR'],
  ['missing result', { ...initialized, body: '{}' }, 'TRANSPORT_INVALID_RESPONSE'],
  ['scalar result', { ...initialized, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'not an initialize result' }) }, 'TRANSPORT_INVALID_RESPONSE'],
  ['malformed JSON', { ...initialized, body: 'not JSON' }, 'TRANSPORT_INVALID_RESPONSE'],
]) {
  test(`failed ${label} initialization never invokes business tools/call`, async () => {
    const { tool, calls } = fixtureTool({ ...mcp(text({ data: [] })), truncated: false }, response)
    rejected(await tool.execute(args, exec), code)
    assert.deepEqual(calls, ['initialize'])
  })
}

test('missing policy topic remains a pre-transport error and corrected topic invokes exactly once', async () => {
  const { tool, calls } = fixtureTool({ ...mcp(text({ data: [] })), truncated: false })
  const value = await tool.execute({ dataset: 'realestate.policy', input: { city: '北京', category: '税费' } }, exec)
  rejected(value, 'CALIBER_MISSING')
  assert.deepEqual(value.error.details.missing, ['topic'])
  assert.deepEqual(calls, [])
  const fixed = await tool.execute(args, exec)
  assert.equal(fixed.ok, true)
  assert.deepEqual(calls, ['initialize', 'tools/call'])
})
