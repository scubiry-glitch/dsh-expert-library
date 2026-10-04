/**
 * A6 security and compatibility evidence runner.
 *
 * Uses pure authorization/capability seams and a fake HTTP request/response;
 * no socket is opened, no credential is read, and no provider is contacted.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  MANAGE_TOKEN_HEADER,
  authorizeManageRequest,
} from '../../lib/host/auth.js'
import { createPackCenterRouteHandler } from '../../lib/host/pack-center-routes.js'
import {
  createCapabilityScope,
  resolveCapabilityRoute,
  restoreCapabilityScopeWithReport,
} from '../../lib/capability-scope.js'
import { readTeam } from '../../lib/state.js'

const TOKEN = 'a6-sentinel-manage-token'

function authRequest(overrides = {}) {
  const { headers = {}, remoteAddress = '127.0.0.1' } = overrides
  return { headers: { host: '127.0.0.1:3080', ...headers }, remoteAddress }
}

function headersFor(headers) {
  return Object.entries(headers).flatMap(([name, value]) => [name, Array.isArray(value) ? value[0] : value])
}

function httpRequest(overrides = {}) {
  const headers = {
    host: '127.0.0.1:3080',
    'x-pack-center-ui': '1',
    ...(overrides.headers ?? {}),
  }
  return {
    url: overrides.url ?? '/plugins/dsh-expert-library/manage/center/connection',
    method: overrides.method ?? 'GET',
    headers,
    rawHeaders: overrides.rawHeaders ?? headersFor(headers),
    socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
    on() { return this },
    resume() {},
  }
}

function fakeResponse() {
  const response = {
    statusCode: 0, headers: {}, body: '',
    setHeader(name, value) { this.headers[name] = value },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers) },
    end(value = '') { this.body += value },
  }
  return response
}

function validConnection() {
  return {
    configured: true, configuredOrigin: 'https://center.example', activationAvailable: true, revision: 1, connection: {
      origin: 'https://center.example', centerId: 'center-a6', organizationId: 'org-a6', deploymentId: 'dep-a6',
      credentialId: 'cred-a6', credentialExpiresAt: '2028-01-01T00:00:00.000Z', boundAt: '2027-01-01T00:00:00.000Z',
      bound: true, signingKeyFingerprints: {},
    },
  }
}

async function routeCall(handler, req) {
  const res = fakeResponse()
  const handled = await handler(req, res)
  return { handled, statusCode: res.statusCode, body: JSON.parse(res.body) }
}

/** Execute security/compatibility checks and return a machine-readable receipt. */
export async function runSecurityCompat() {
  const cases = []

  const local = authorizeManageRequest(authRequest(), undefined)
  assert.deepEqual(local, { ok: true, via: 'loopback' })
  cases.push({ id: 'loopback-auth', passed: true })

  const token = authorizeManageRequest(authRequest({ headers: { host: 'public.example', [MANAGE_TOKEN_HEADER]: TOKEN }, remoteAddress: '203.0.113.10' }), TOKEN)
  assert.deepEqual(token, { ok: true, via: 'token' })
  cases.push({ id: 'token-auth', passed: true })

  const forwarded = authorizeManageRequest(authRequest({ headers: { 'x-forwarded-for': '203.0.113.10' } }), undefined)
  assert.equal(forwarded.ok, false)
  assert.match(forwarded.reason, /forwarded/)
  cases.push({ id: 'forwarded-loopback-denied', passed: true })

  const scope = createCapabilityScope({
    expertId: 'engineer', role: 'member', allowedLlmProviders: ['deepseek-official'],
    allowedDataProviders: ['wind'], allowedTools: ['expert_provider_call'], allowedKnowledge: [], allowedTasks: ['t1'], maxDepth: 0,
  })
  const compatible = resolveCapabilityRoute({
    explicit: { provider: 'unknown', model: 'v0' },
    fallback: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' }],
    available: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', supportedEfforts: ['max'] }],
    allowedLlmProviders: scope.allowedLlmProviders,
  })
  assert.equal(compatible.ok, true)
  assert.equal(compatible.fallbackUsed, true)
  const deniedData = resolveCapabilityRoute({ explicit: { provider: 'wind', model: 'data-model' }, allowedLlmProviders: scope.allowedLlmProviders })
  assert.equal(deniedData.ok, false)
  cases.push({ id: 'webless-provider-compatibility-route', passed: true })

  const legacy = restoreCapabilityScopeWithReport({ expertId: 'legacy', role: 'worker', allowedProviders: ['deepseek-official'], allowedTools: [], allowedKnowledge: [], allowedTasks: [] })
  assert.equal(legacy.migrated, true)
  assert.equal(legacy.scope.maxDepth, 0)
  assert.deepEqual(legacy.scope.allowedLlmProviders, undefined)
  cases.push({ id: 'legacy-scope-schema-migration', passed: true })

  // A pre-A5 team.json with a partial member scope is accepted only after the
  // read boundary normalizes it; absent fields remain fail-closed defaults.
  const legacyRoot = await mkdtemp(join(tmpdir(), 'expert-library-a6-state-'))
  try {
    await mkdir(join(legacyRoot, 'legacy-team'), { recursive: true })
    await writeFile(join(legacyRoot, 'legacy-team', 'team.json'), JSON.stringify({
      id: 'legacy-team', name: 'legacy', captainSessionId: 'captain', createdAt: 1,
      members: [{ id: 'member-1', name: 'legacy-member', role: 'worker', joinedAt: 1, status: 'idle', capabilityScope: { expertId: 'legacy-member', role: 'worker', allowedProviders: ['deepseek-official'], allowedTools: [], allowedKnowledge: [], allowedTasks: [] } }],
      tasks: [], taskSeq: 0,
    }))
    const restored = await readTeam(legacyRoot, 'legacy-team')
    assert.deepEqual(restored?.members[0]?.capabilityScope?.allowedTools, [])
    assert.equal(restored?.members[0]?.capabilityScope?.maxDepth, 0)
    cases.push({ id: 'legacy-team-state-read-boundary', passed: true })
  } finally {
    await rm(legacyRoot, { recursive: true, force: true })
  }

  const service = {
    connection: async () => validConnection(),
    catalog: async () => ({ items: [], nextCursor: null, checkedAt: null, hasSnapshot: false, stale: false }),
    installations: async () => ({ generation: 0, mode: 'normal', items: [] }),
    updates: async () => ({ generation: 0, items: [], checkedAt: null, hasSnapshot: false, stale: false }),
    operations: async () => [],
  }
  const handler = createPackCenterRouteHandler({ service, getManageToken: () => TOKEN })

  // Origin/CSRF checks happen before service dispatch.  A forwarded public
  // request needs a token and an Origin matching the external authority.
  const badForward = await routeCall(handler, httpRequest({
    headers: { host: 'public.example', 'x-forwarded-for': '203.0.113.10', [MANAGE_TOKEN_HEADER]: TOKEN, origin: 'https://evil.example' },
    remoteAddress: '127.0.0.1',
  }))
  assert.equal(badForward.handled, true)
  assert.equal(badForward.statusCode, 403)
  assert.equal(badForward.body.ok, false)
  assert.equal(badForward.body.error.code, 'CENTER_CSRF_REJECTED')

  const goodForward = await routeCall(handler, httpRequest({
    headers: { host: 'public.example', 'x-forwarded-for': '203.0.113.10', [MANAGE_TOKEN_HEADER]: TOKEN, origin: 'https://public.example', 'x-pack-center-external-host': 'public.example' },
    remoteAddress: '127.0.0.1',
  }))
  assert.equal(goodForward.statusCode, 200)
  assert.equal(goodForward.body.ok, true)
  assert.equal(goodForward.body.data.connection.credentialId, 'cred-a6')
  cases.push({ id: 'origin-csrf-fence', passed: true })

  // A provider/service failure must be reduced to a safe error code; neither
  // the sentinel token nor path/PEM text from the thrown error may cross the
  // fake HTTP boundary. These are synthetic values, never real credentials.
  const secretPath = '/tmp/a6-sentinel-secret-path'
  const secretPem = '-----BEGIN PRIVATE KEY-----a6-sentinel-----END PRIVATE KEY-----'
  const errorHandler = createPackCenterRouteHandler({
    service: {
      ...service,
      connection: async () => { throw new Error(`token=${TOKEN} path=${secretPath} pem=${secretPem}`) },
    },
    getManageToken: () => TOKEN,
  })
  const failedService = await routeCall(errorHandler, httpRequest())
  assert.equal(failedService.statusCode, 502)
  assert.deepEqual(failedService.body, { ok: false, error: { code: 'CENTER_REQUEST_FAILED' } })
  const serializedResponses = JSON.stringify({ badForward, goodForward, failedService })
  assert.equal(serializedResponses.includes(TOKEN), false)
  assert.equal(serializedResponses.includes(secretPath), false)
  assert.equal(serializedResponses.includes(secretPem), false)
  cases.push({ id: 'error-response-secret-redaction', passed: true })

  return {
    schemaVersion: 1,
    kind: 'a6-security-compat',
    generatedAt: new Date().toISOString(),
    cases,
    passed: cases.length,
    secretsUsed: false,
    sentinelInputsUsed: true,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSecurityCompat().then(summary => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
