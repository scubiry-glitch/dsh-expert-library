/**
 * Host health-surface tests — provider probes (success/failure/timeout via
 * injected fake fetch), the 30s single-flight cache, the route handler, the
 * read-only pack drift digest (temp dirs), and the secret non-leakage scan.
 *
 * All tests are hermetic: no real network, no real credentials. Fake keys are
 * sentinel strings; the scan asserts they never appear in the serialized
 * response.
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  HealthProbeCache,
  beikeApiKey,
  createHealthHandler,
  firstSseData,
  probeBeikeHealth,
  probePackHealth,
  probeWindHealth,
  probeZytHealth,
  runHealthProbe,
  windKeyPresent,
  zytApiKey,
} from '../lib/host/health.js'
import { hashPackageTree } from '../lib/v2/pack-loader.js'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

const FAKE_ZYT_KEY = 'FAKE-ZYT-KEY-001-secret'
const FAKE_BEIKE_KEY = 'FAKE-BEIKE-KEY-002-secret'
const FAKE_WIND_KEY = 'FAKE-WIND-KEY-003-secret'
const FAKE_HOME = '/home/health-fake'

/** Seam factory: `files` maps absolute paths to contents (exists+readFile). */
function fakeSeams({ fetch, files = {}, env = {}, now } = {}) {
  let nowValue = now ?? 1000
  const calls = []
  return {
    calls,
    advance: (ms) => { nowValue += ms },
    seams: {
      fetch: fetch ?? (async (options) => {
        calls.push(options)
        throw new Error('unexpected fetch')
      }),
      exists: (path) => files[path] !== undefined,
      readFile: (path) => files[path],
      env: (name) => env[name],
      home: () => FAKE_HOME,
      now: () => nowValue,
    },
  }
}

const REGISTERED = ['wind', 'zyt', 'beike']

function probeInput(overrides = {}) {
  return {
    providers: {
      wind: { cliPath: '/opt/wind/cli.mjs' },
      zyt: { baseUrl: 'https://zyt.fake' },
      beike: { baseUrl: 'https://beike.fake/mcp' },
    },
    registered: REGISTERED,
    packDirs: [],
    ...overrides,
  }
}

/* ---------------------------------------------------------------------------
 * wind probe (filesystem only — fetch must never fire)
 * ------------------------------------------------------------------------- */

test('wind: cli exists + env key → ready, no network', async () => {
  const { seams, calls } = fakeSeams({ env: { WIND_API_KEY: FAKE_WIND_KEY }, files: { '/opt/wind/cli.mjs': 'x' } })
  const report = await runHealthProbe('wind', probeInput({ seams }))
  assert.equal(report.providers.wind.registered, true)
  assert.equal(report.providers.wind.cliExists, true)
  assert.equal(report.providers.wind.keyPresent, true)
  assert.equal(report.providers.wind.cliPath, '/opt/wind/cli.mjs')
  assert.equal(report.providers.wind.detail, undefined)
  assert.equal(calls.length, 0)
})

test('wind: key file present counts as keyPresent', () => {
  const { seams } = fakeSeams({ files: { [`${FAKE_HOME}/.wind-aifinmarket/config`]: 'cfg' } })
  assert.equal(windKeyPresent(seams), true)
  const health = probeWindHealth({ registered: true, cliPath: '/opt/wind/cli.mjs' }, seams)
  assert.equal(health.keyPresent, true)
})

test('wind: missing CLI → cliExists false with detail; unregistered without cliPath', async () => {
  const { seams } = fakeSeams({})
  const missing = probeWindHealth({ registered: false, cliPath: '/opt/wind/cli.mjs' }, seams)
  assert.equal(missing.cliExists, false)
  assert.match(missing.detail, /CLI 文件不存在/)
  const unconfigured = probeWindHealth({ registered: false }, seams)
  assert.equal(unconfigured.cliPath, undefined)
  assert.match(unconfigured.detail, /未配置 CLI 路径/)
})

test('wind: no key anywhere → 未配置凭据 detail', () => {
  const { seams } = fakeSeams({ files: { '/opt/wind/cli.mjs': 'x' } })
  const health = probeWindHealth({ registered: true, cliPath: '/opt/wind/cli.mjs' }, seams)
  assert.equal(health.keyPresent, false)
  assert.match(health.detail, /未配置凭据/)
})

/* ---------------------------------------------------------------------------
 * zyt probe
 * ------------------------------------------------------------------------- */

test('zyt: 2xx identity → reachable + latency + tenant/dataView parsed', async () => {
  const { seams, calls } = fakeSeams({
    env: { ZYT_API_KEY: FAKE_ZYT_KEY },
    fetch: async (options) => {
      calls.push(options)
      return { status: 200, body: JSON.stringify({ tenantName: 'ke-tenant', dataView: 'external' }), truncated: false }
    },
  })
  const health = await probeZytHealth({ registered: true, baseUrl: 'https://zyt.fake', timeoutMs: 8000 }, seams)
  assert.equal(health.reachable, true)
  assert.equal(typeof health.latencyMs, 'number')
  assert.deepEqual(health.identity, { tenantName: 'ke-tenant', dataView: 'external' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://zyt.fake/openapi/v1/me')
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers['X-Api-Key'], FAKE_ZYT_KEY)
})

test('zyt: key from config file JSON ({apiKey})', () => {
  const { seams } = fakeSeams({ files: { [`${FAKE_HOME}/.config/zyt/config.json`]: JSON.stringify({ apiKey: FAKE_ZYT_KEY }) } })
  assert.equal(zytApiKey(seams), FAKE_ZYT_KEY)
})

test('zyt: 401 → reachable false, body never echoed in detail', async () => {
  const secretBody = `{"error":"bad key ${FAKE_ZYT_KEY}"}`
  const { seams } = fakeSeams({
    env: { ZYT_API_KEY: FAKE_ZYT_KEY },
    fetch: async () => ({ status: 401, body: secretBody, truncated: false }),
  })
  const health = await probeZytHealth({ registered: true, baseUrl: 'https://zyt.fake' }, seams)
  assert.equal(health.reachable, false)
  assert.equal(health.detail, 'HTTP 401')
  assert.equal(JSON.stringify(health).includes(FAKE_ZYT_KEY), false)
})

test('zyt: no key → no socket, keyPresent false', async () => {
  const { seams, calls } = fakeSeams({})
  const health = await probeZytHealth({ registered: true, baseUrl: 'https://zyt.fake' }, seams)
  assert.equal(health.keyPresent, false)
  assert.equal(health.reachable, undefined)
  assert.match(health.detail, /未配置凭据/)
  assert.equal(calls.length, 0)
})

test('zyt: timeout → reachable false with 超时 detail', async () => {
  const { seams } = fakeSeams({
    env: { ZYT_API_KEY: FAKE_ZYT_KEY },
    // The probe's AbortSignal.timeout timer is unref'd, so a fake that only
    // listens for `abort` would leave the event loop empty (node:test would
    // cancel the pending test). A ref'd fallback timer keeps the loop alive;
    // the abort still wins at 30ms.
    fetch: ({ signal }) => new Promise((_, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted', 'AbortError'))
      const fallback = setTimeout(abort, 1000)
      signal.addEventListener('abort', () => { clearTimeout(fallback); abort() }, { once: true })
    }),
  })
  const health = await probeZytHealth({ registered: true, baseUrl: 'https://zyt.fake', timeoutMs: 30 }, seams)
  assert.equal(health.reachable, false)
  assert.match(health.detail, /探测超时/)
})

/* ---------------------------------------------------------------------------
 * beike probe
 * ------------------------------------------------------------------------- */

const BEIKE_INIT_SSE = [
  'event: message',
  `data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"beike-mcp","version":"2.1.0"}}}`,
  '',
].join('\n')

test('beike: SSE initialize → reachable + serverInfo parsed from first data line', async () => {
  const { seams, calls } = fakeSeams({
    env: { BEIKE_MCP_API_KEY: FAKE_BEIKE_KEY },
    fetch: async (options) => {
      calls.push(options)
      return { status: 200, body: BEIKE_INIT_SSE, truncated: false }
    },
  })
  const health = await probeBeikeHealth({ registered: true, baseUrl: 'https://beike.fake/mcp' }, seams)
  assert.equal(health.reachable, true)
  assert.equal(health.serverInfo, 'beike-mcp 2.1.0')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers['authorization'], `Bearer ${FAKE_BEIKE_KEY}`)
  assert.equal(calls[0].headers['accept'], 'application/json, text/event-stream')
  const sent = JSON.parse(calls[0].body)
  assert.equal(sent.method, 'initialize')
  assert.equal(sent.params.protocolVersion, '2025-03-26')
  assert.deepEqual(sent.params.clientInfo, { name: 'dsh-health', version: '1.0' })
})

test('beike: plain JSON handshake also parses; key from CLI key file', async () => {
  const { seams } = fakeSeams({
    files: { '/tmp/beike-cli/.beike/BEIKE_MCP_API_KEY': `${FAKE_BEIKE_KEY}\n` },
    fetch: async () => ({ status: 200, body: JSON.stringify({ result: { serverInfo: { name: 'beike-mcp' } } }), truncated: false }),
  })
  const health = await probeBeikeHealth({ registered: true, baseUrl: 'https://beike.fake/mcp' }, seams)
  assert.equal(health.reachable, true)
  assert.equal(health.serverInfo, 'beike-mcp')
})

test('beike: transport error → reachable false with message detail', async () => {
  const { seams } = fakeSeams({
    env: { BEIKE_MCP_API_KEY: FAKE_BEIKE_KEY },
    fetch: async () => { throw new Error('connect ECONNREFUSED') },
  })
  const health = await probeBeikeHealth({ registered: true, baseUrl: 'https://beike.fake/mcp' }, seams)
  assert.equal(health.reachable, false)
  assert.match(health.detail, /ECONNREFUSED/)
})

test('beike: home key file resolves when env absent', () => {
  const { seams } = fakeSeams({ files: { [`${FAKE_HOME}/.beike/BEIKE_MCP_API_KEY`]: FAKE_BEIKE_KEY } })
  assert.equal(beikeApiKey(seams), FAKE_BEIKE_KEY)
})

test('firstSseData returns the first data line, or the body itself', () => {
  assert.equal(firstSseData(BEIKE_INIT_SSE), '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","serverInfo":{"name":"beike-mcp","version":"2.1.0"}}}')
  assert.equal(firstSseData('{"a":1}'), '{"a":1}')
})

/* ---------------------------------------------------------------------------
 * aggregate probe: target scoping
 * ------------------------------------------------------------------------- */

test('single-target probe: only that provider goes to the network, packs empty', async () => {
  const { seams, calls } = fakeSeams({
    env: { ZYT_API_KEY: FAKE_ZYT_KEY, BEIKE_MCP_API_KEY: FAKE_BEIKE_KEY },
    files: { '/opt/wind/cli.mjs': 'x' },
    fetch: async (options) => {
      calls.push(options)
      return { status: 200, body: JSON.stringify({ tenantName: 't' }), truncated: false }
    },
  })
  const report = await runHealthProbe('zyt', probeInput({ seams }))
  assert.equal(calls.length, 1)
  assert.equal(report.providers.zyt.reachable, true)
  // Shallow rows: config + keyPresent only, no reachable/latency.
  assert.equal(report.providers.beike.reachable, undefined)
  assert.equal(report.providers.beike.keyPresent, true)
  assert.equal(report.providers.wind.cliExists, true)
  assert.deepEqual(report.packs, [])
  assert.equal(typeof report.checkedAt, 'string')
})

/* ---------------------------------------------------------------------------
 * cache: 30s TTL, single-flight, rejection eviction
 * ------------------------------------------------------------------------- */

test('cache: concurrent runs share one task; fresh within TTL; re-run after TTL', async () => {
  let clock = 0
  const cache = new HealthProbeCache(30_000, () => clock)
  let runs = 0
  const task = async () => {
    runs += 1
    return runHealthProbe('wind', probeInput({ seams: fakeSeams({}).seams }))
  }
  const [a, b] = await Promise.all([cache.run('wind', task), cache.run('wind', task)])
  assert.equal(runs, 1)
  assert.equal(a, b)
  await cache.run('wind', task)
  assert.equal(runs, 1)
  clock += 31_000
  await cache.run('wind', task)
  assert.equal(runs, 2)
})

test('cache: rejected runs are evicted, not served again', async () => {
  const cache = new HealthProbeCache(30_000, () => 0)
  let runs = 0
  await assert.rejects(cache.run('zyt', async () => { runs += 1; throw new Error('boom') }))
  await assert.rejects(cache.run('zyt', async () => { runs += 1; throw new Error('boom') }))
  assert.equal(runs, 2)
})

/* ---------------------------------------------------------------------------
 * route handler
 * ------------------------------------------------------------------------- */

function fakeReq(url) {
  return { url }
}

function fakeRes() {
  return {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  }
}

test('handler: 200 JSON for a valid probe; 400 for unknown probe', async () => {
  const handler = createHealthHandler({
    resolve: () => probeInput({ seams: fakeSeams({ files: { '/opt/wind/cli.mjs': 'x' } }).seams }),
  })
  const ok = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/health?probe=wind'), ok)
  assert.equal(ok.status, 200)
  const body = JSON.parse(ok.body)
  assert.equal(body.providers.wind.cliExists, true)
  const bad = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/health?probe=nope'), bad)
  assert.equal(bad.status, 400)
})

test('handler: default probe is all; cache makes the second call skip resolve', async () => {
  let resolves = 0
  const handler = createHealthHandler({
    resolve: () => { resolves += 1; return probeInput({ seams: fakeSeams({}).seams }) },
  })
  await handler(fakeReq('/plugins/dsh-expert-library/health'), fakeRes())
  await handler(fakeReq('/plugins/dsh-expert-library/health'), fakeRes())
  assert.equal(resolves, 1)
})

/* ---------------------------------------------------------------------------
 * secret non-leakage scan over the full serialized response
 * ------------------------------------------------------------------------- */

test('secret scan: fake keys never appear in the serialized health response', async () => {
  const { seams } = fakeSeams({
    env: { WIND_API_KEY: FAKE_WIND_KEY, ZYT_API_KEY: FAKE_ZYT_KEY, BEIKE_MCP_API_KEY: FAKE_BEIKE_KEY },
    files: { '/opt/wind/cli.mjs': 'x' },
    fetch: async (options) => {
      // Failure path that embeds the key in the server response body AND a
      // success path — neither may surface the key.
      if (options.url.includes('zyt')) return { status: 500, body: `upstream saw ${FAKE_ZYT_KEY}`, truncated: false }
      return { status: 200, body: BEIKE_INIT_SSE, truncated: false }
    },
  })
  const tmp = mkdtempSync(join(tmpdir(), 'health-leak-'))
  try {
    const report = await runHealthProbe('all', probeInput({ seams, packDirs: [{ dir: tmp }] }))
    const serialized = JSON.stringify(report)
    for (const secret of [FAKE_WIND_KEY, FAKE_ZYT_KEY, FAKE_BEIKE_KEY]) {
      assert.equal(serialized.includes(secret), false, `leaked: ${secret}`)
    }
    assert.equal(report.providers.zyt.reachable, false)
    assert.equal(report.providers.beike.reachable, true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * packs drift probe (temp dirs, real fs, real digest)
 * ------------------------------------------------------------------------- */

/** Emit a minimal generated pack; returns its root. */
async function emitTempPack({ withReference = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'health-pack-'))
  mkdirSync(join(root, 'experts'))
  mkdirSync(join(root, 'scenarios'))
  mkdirSync(join(root, 'generated'))
  writeFileSync(join(root, 'pack.json'), `${JSON.stringify({ id: 'temp-pack', version: '1.2.3' })}\n`)
  writeFileSync(join(root, 'experts', 'e1.json'), '{"id":"e1"}\n')
  writeFileSync(join(root, 'experts', 'e2.json'), '{"id":"e2"}\n')
  writeFileSync(join(root, 'scenarios', 's1.json'), '{"id":"s1"}\n')
  writeFileSync(join(root, 'generated', 'verify.json'), '{"ok":true}\n')
  if (withReference) {
    // Same convention as the generator scripts: digest over the tree with
    // every generated/ file excluded, computed BEFORE pack.sha256 exists.
    const hash = await hashPackageTree(root, { exclude: ['generated/verify.json'] })
    writeFileSync(join(root, 'generated', 'pack.sha256'), `${hash}\n`)
  }
  return root
}

test('packs: clean drift when the tree matches the recorded digest', async () => {
  const root = await emitTempPack()
  try {
    const health = await probePackHealth(root)
    assert.equal(health.id, 'temp-pack')
    assert.equal(health.version, '1.2.3')
    assert.equal(health.experts, 2)
    assert.equal(health.scenarios, 1)
    assert.equal(health.drift, 'clean')
    assert.match(health.sha256, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packs: dirty drift when content changed after generation', async () => {
  const root = await emitTempPack()
  try {
    writeFileSync(join(root, 'experts', 'e1.json'), '{"id":"e1","tampered":true}\n')
    const health = await probePackHealth(root)
    assert.equal(health.drift, 'dirty')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packs: unknown drift without a reference hash; tampering inside generated/ is not content drift', async () => {
  const root = await emitTempPack({ withReference: false })
  try {
    const missing = await probePackHealth(root)
    assert.equal(missing.drift, 'unknown')
    // Write the reference, then mutate a generated/ artifact: the digest
    // excludes the whole generated/ subtree (generator semantics), so the
    // drift verdict stays clean.
    const hash = await hashPackageTree(root, { exclude: ['generated/verify.json'] })
    writeFileSync(join(root, 'generated', 'pack.sha256'), `${hash}\n`)
    writeFileSync(join(root, 'generated', 'verify.json'), '{"ok":false,"edited":true}\n')
    const health = await probePackHealth(root)
    assert.equal(health.drift, 'clean')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('packs: runHealthProbe lists every pack dir for probe=packs', async () => {
  const root = await emitTempPack()
  try {
    const { seams } = fakeSeams({})
    const report = await runHealthProbe('packs', probeInput({ seams, packDirs: [{ dir: root }], registered: [] }))
    assert.equal(report.packs.length, 1)
    assert.equal(report.packs[0].id, 'temp-pack')
    assert.equal(report.providers.wind.registered, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
