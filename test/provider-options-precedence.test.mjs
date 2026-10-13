/**
 * Provider options precedence tests — resolveProviderServiceOptions must
 * resolve each knob as: settings/entry config input > environment > probe
 * default. The settings>cordis-entry layering itself is the settings
 * service's base-layer merge (installSettingsSection registers the entry as
 * `base` and the user scope on top); what reaches the resolver is the merged
 * section, so "settings wins over cordis config" is exercised here by
 * feeding the merged field (settings value) alongside the entry-level rest.
 *
 * Hermetic: env is saved/restored around each test; filesystem probes use
 * temp files only.
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ProviderTransportService,
  resolveProviderServiceOptions,
  windCliPathCandidate,
} from '../lib/host/provider-service.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Run `fn` with the given env vars set, restoring the originals after. */
async function withEnv(vars, fn) {
  const saved = {}
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key]
    if (vars[key] === undefined) delete process.env[key]
    else process.env[key] = vars[key]
  }
  try {
    return await fn()
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

const CLEAN_ENV = {
  WIND_SKILL_CLI: undefined,
  ZYT_BASE_URL: undefined,
  ZYT_CLI: undefined,
  BEIKE_MCP_BASE_URL: undefined,
  BEIKE_CLI: undefined,
  BEIKE_PREFER_CLI: undefined,
}

test('zyt baseUrl: input > env > probe default', async () => {
  await withEnv({ ...CLEAN_ENV, ZYT_BASE_URL: 'https://env.example' }, () => {
    assert.equal(resolveProviderServiceOptions({}).zyt.baseUrl, 'https://env.example')
    const input = resolveProviderServiceOptions({ providers: { zyt: { baseUrl: 'https://settings.example' } } })
    assert.equal(input.zyt.baseUrl, 'https://settings.example')
  })
  await withEnv(CLEAN_ENV, () => {
    assert.equal(resolveProviderServiceOptions({}).zyt.baseUrl, 'https://dss.ke.com')
  })
})

test('beike baseUrl: input > env > probe default; preferCli passthrough', async () => {
  await withEnv({ ...CLEAN_ENV, BEIKE_MCP_BASE_URL: 'https://env-beike.example' }, () => {
    assert.equal(resolveProviderServiceOptions({}).beike.baseUrl, 'https://env-beike.example')
    const input = resolveProviderServiceOptions({ providers: { beike: { baseUrl: 'https://settings-beike.example', preferCli: true } } })
    assert.equal(input.beike.baseUrl, 'https://settings-beike.example')
    assert.equal(input.beike.preferCli, true)
  })
  await withEnv(CLEAN_ENV, () => {
    const resolved = resolveProviderServiceOptions({})
    assert.equal(resolved.beike.baseUrl, 'https://building.ke.com/mcp')
    assert.equal(resolved.beike.preferCli, false)
  })
  await withEnv({ ...CLEAN_ENV, BEIKE_PREFER_CLI: '1' }, () => {
    assert.equal(resolveProviderServiceOptions({}).beike.preferCli, true)
    assert.equal(resolveProviderServiceOptions({ providers: { beike: { preferCli: false } } }).beike.preferCli, false)
  })
})

test('wind cliPath: input > env > default probe; registration gated on existence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wind-cli-'))
  try {
    const existing = join(dir, 'cli.mjs')
    writeFileSync(existing, '// fake cli\n')
    await withEnv({ ...CLEAN_ENV, WIND_SKILL_CLI: join(dir, 'missing.mjs') }, () => {
      // Input wins over env, and exists → registered.
      const fromInput = resolveProviderServiceOptions({ providers: { wind: { cliPath: existing } } })
      assert.equal(fromInput.wind.cliPath, existing)
      // Env path missing on disk → wind not registered (fail closed)…
      const fromEnv = resolveProviderServiceOptions({})
      assert.equal(fromEnv.wind, undefined)
      // …but the candidate helper still reports the configured path (health UI).
      assert.equal(windCliPathCandidate({}), join(dir, 'missing.mjs'))
      assert.equal(windCliPathCandidate({ providers: { wind: { cliPath: existing } } }), existing)
    })
    await withEnv(CLEAN_ENV, () => {
      // Default probe path: ends with the skill suffix; registered only when present.
      const candidate = windCliPathCandidate({})
      assert.match(candidate, /\.agents\/skills\/wind-mcp-skill\/scripts\/cli\.mjs$/)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('customer provider grant is deny-all by default and only registers opted-in sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customer-provider-grant-'))
  try {
    const database = join(dir, 'private.sqlite')
    writeFileSync(database, '')
    const input = { providers: { localdb: { databases: [{ id: 'private', path: database, sensitivity: 'internal' }] } } }
    const ctx = { get: () => undefined }
    await withEnv({ DSH_CUSTOMER_WORKSPACE_DIR: dir, DSH_CUSTOMER_ALLOWED_PROVIDERS: undefined }, () => {
      const options = resolveProviderServiceOptions(input)
      assert.deepEqual(options.allowedProviders, [])
      assert.equal(options.localdb, undefined)
      assert.deepEqual(new ProviderTransportService(ctx, options).providers, [])
    })
    await withEnv({ DSH_CUSTOMER_WORKSPACE_DIR: dir, DSH_CUSTOMER_ALLOWED_PROVIDERS: 'beike,zyt,unknown' }, () => {
      const options = resolveProviderServiceOptions(input)
      assert.deepEqual(options.allowedProviders, ['beike', 'zyt'])
      assert.deepEqual(new ProviderTransportService(ctx, options).providers, ['zyt', 'beike'])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('settings layer wins over cordis entry after the base-layer merge', async () => {
  // installSettingsSection registers the cordis entry as `base` and the user
  // scope on top; the merged section is what applySource feeds the resolver.
  // Mirror that merge per field: user value ?? entry value.
  const entry = { providers: { zyt: { baseUrl: 'https://entry.example' }, beike: { baseUrl: 'https://entry-beike.example' } } }
  const userScope = { providers: { zyt: { baseUrl: 'https://user.example' } } }
  const merged = {
    providers: {
      zyt: userScope.providers?.zyt ?? entry.providers?.zyt,
      beike: userScope.providers?.beike ?? entry.providers?.beike,
    },
  }
  await withEnv(CLEAN_ENV, () => {
    const resolved = resolveProviderServiceOptions(merged)
    assert.equal(resolved.zyt.baseUrl, 'https://user.example')
    assert.equal(resolved.beike.baseUrl, 'https://entry-beike.example')
  })
})
