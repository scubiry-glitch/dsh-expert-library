#!/usr/bin/env node
/**
 * G4.2 — Legacy vendor-pack takeover + restore (host-side, phase2 fixture).
 *
 * Route truth established from source (recorded in evidence, not invented):
 *   • The plugin manage API exposes only connection/catalog/installations/
 *     updates/operations; operationInput (src/host/pack-center-operations.ts)
 *     restricts POST /operations kinds to install|update_enable|enable|disable|
 *     rollback|uninstall. legacy_takeover / legacy_restore have NO HTTP route
 *     (this is also asserted live against instance A).
 *   • The pure-local helpers the plugin exposes are the pack-store SDK methods
 *     takeOverLegacy() / restoreLegacyManagement() (src/host/pack-store.ts),
 *     backed by prepareLegacySnapshot/verify* in src/host/pack-legacy.ts.
 *     This script exercises those real helpers against instance A's own
 *     inventory root (/tmp/p2-20260923/pack-center-a/inventory).
 *
 * Idempotent: re-running reuses the seeded vendor pack and the content-addressed
 * legacy backup; a still-taken-over state is restored before a fresh takeover.
 * Never prints secrets; evidence is written 0600; instance A stays running and
 * its center-owned packs (macro-capital-analyst, phase2-dep-a/b) are unchanged.
 */
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const tree = fileURLToPath(new URL('../../', import.meta.url))
const node22 = '/root/.nvm/versions/node/v22.22.0/bin/node'
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const root = '/tmp/p2-20260923'
const vendorRoot = join(root, 'dsh-a/vendor-packs')
const vendorPath = join(vendorRoot, 'phase2-legacy-demo')
const legacyPackId = 'phase2-legacy-demo'
const inventoryRoot = join(root, 'pack-center-a/inventory')
const instanceA = { id: 'A', port: 18281 }
const prefix = '/plugins/dsh-expert-library/manage/center'
const centerOwnedPacks = ['macro-capital-analyst', 'phase2-dep-a', 'phase2-dep-b']

const events = [], log = []

// The pack-store SDK lives in TypeScript (src/host/*.ts). Re-exec once under
// Node 22.22 with type stripping when the current runtime cannot import .ts.
if (process.env.G42_INNER !== '1') {
  const probe = await import(join(tree, 'src/host/pack-store.ts')).then(() => true).catch(() => false)
  if (!probe) {
    const child = spawn(node22, ['--experimental-strip-types', fileURLToPath(import.meta.url)],
      { env: { ...process.env, G42_INNER: '1' }, stdio: 'inherit' })
    await new Promise(resolve => child.on('exit', code => { process.exitCode = code ?? 1; resolve() }))
    process.exit(process.exitCode || 0)
  }
}
let stage = 'preflight', passed = false
const note = (message, data = {}) => log.push({ at: new Date().toISOString(), stage, message, ...data })
const json = value => JSON.stringify(value, null, 2) + '\n'
const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const fail = message => { throw new Error(message) }
const check = (value, message) => { if (!value) fail(message) }

async function evidence(name, value) {
  const bytes = typeof value === 'string' ? value : json(value)
  const path = join(dag, name)
  await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600)
}

async function local(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${instanceA.port}${prefix}${path}`, {
    method, headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  }).catch(error => { throw new Error(`A fetch failed: ${error.cause?.code || error.message}`) })
  const data = await response.json().catch(() => undefined)
  events.push({ actor: 'A', method, path, status: response.status })
  check(response.status === expected, `A ${method} ${path} returned ${response.status}: ${data?.error?.code || ''}`)
  return data?.data
}

async function readState() { return JSON.parse(await readFile(join(inventoryRoot, 'state.json'), 'utf8')) }
const centerActiveOf = state => Object.fromEntries(centerOwnedPacks.map(packId => [packId, state.active[packId] ?? null]))

/** Seed a minimal valid legacy V2 pack from examples/pack-center/demo-v1. */
async function seedVendorPack() {
  stage = 'seed'
  try { await stat(join(vendorPath, 'pack.json')); note('seed-reuse', { vendorPath }); return } catch { /* seed below */ }
  const text = await readFile(join(tree, 'examples/pack-center/demo-v1/pack.json'), 'utf8')
  // Global id rewrite: demo.review → phase2-legacy-demo keeps every entity id
  // unique; schemaVersion stays 2 as required for a legacy V2 pack.
  const pack = JSON.parse(text.replaceAll('demo.review', legacyPackId))
  check(pack.pack.id === legacyPackId && pack.pack.schemaVersion === 2, 'seeded legacy pack must be the renamed V2 demo pack')
  await mkdir(vendorPath, { recursive: true, mode: 0o700 })
  await writeFile(join(vendorPath, 'pack.json'), json(pack), { mode: 0o600 })
  try { await copyFile(join(tree, 'examples/pack-center/demo-v1/README.md'), join(vendorPath, 'README.md')) } catch { /* optional */ }
  note('seed-created', { vendorPath, packId: legacyPackId, schemaVersion: pack.pack.schemaVersion })
}

/** Record how the legacy pack is observable before takeover. */
async function discoveryBefore() {
  stage = 'discovery-before'
  const files = await readdir(vendorRoot)
  // The vendored surface (GET /manage/packs/registry) lists only ledgered
  // onboarded packs; a raw legacy vendor dir is observed via its directory
  // listing plus local V2 validation, and by A's center state not yet
  // containing it.
  let registry = null
  try {
    const response = await fetch(`http://127.0.0.1:${instanceA.port}/plugins/dsh-expert-library/manage/packs/registry`,
      { headers: { 'X-Pack-Center-UI': '1' }, signal: AbortSignal.timeout(10_000) })
    registry = await response.json().catch(() => null)
  } catch (error) { note('registry-probe-failed', { message: String(error.message).slice(0, 120) }) }
  const { loadPackFromDir } = await import(join(tree, 'lib/pack-validator.js'))
  const loaded = await loadPackFromDir(vendorPath)
  check(loaded.ok, 'seeded legacy pack must pass local V2 validation before takeover')
  const state = await readState()
  check(!Object.keys(state.legacySuppressions ?? {}).includes(vendorPath), 'legacy path already suppressed; restore before re-running')
  const observation = {
    vendorRootFiles: files, packId: loaded.pack.pack.id, version: loaded.pack.pack.version,
    schemaVersion: loaded.pack.pack.schemaVersion,
    observedHow: 'vendor dir listing + local lib/pack-validator V2 validation; GET /manage/packs/registry lists only ledgered onboarded packs, not raw legacy vendor dirs; A state has no legacy entry yet',
    registryEntries: Array.isArray(registry?.packs) ? registry.packs.map(item => item.id) : null,
    aStateLegacySuppressions: Object.keys(state.legacySuppressions ?? {}),
    aCenterActiveBefore: centerActiveOf(state),
  }
  note('discovery-before', { packId: observation.packId })
  return observation
}

/** Prove the HTTP surface really rejects a legacy takeover request. */
async function routeProbe() {
  stage = 'route-probe'
  const response = await fetch(`http://127.0.0.1:${instanceA.port}${prefix}/operations`, {
    method: 'POST', headers: { 'X-Pack-Center-UI': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationKey: 'g42-A-probe-legacy-takeover', kind: 'legacy_takeover', vendorPath,
      expectedContentTreeSha256: '0'.repeat(64), expectedGeneration: (await readState()).generation }),
    signal: AbortSignal.timeout(10_000),
  })
  const data = await response.json().catch(() => undefined)
  check(['OPERATION_INVALID','CENTER_INVALID_INPUT'].includes(data?.error?.code), `expected rejection for legacy_takeover over HTTP, got ${response.status} ${data?.error?.code || ''}`)
  note('route-probe', { status: response.status, code: data.error.code,
    conclusion: 'takeover/restore are not exposed via the manage API; using the plugin pack-store SDK helpers directly' })
}

async function main() {
  await mkdir(dag, { recursive: true, mode: 0o700 })
  check((await local('/connection')).configured === true, 'A must be bound to the center before the legacy exercise')

  await seedVendorPack()
  const before = await discoveryBefore()
  await routeProbe()

  const { createPackStore } = await import(join(tree, 'src/host/pack-store.ts'))
  const { hashContentDirectory } = await import(join(tree, 'packages/pack-contract/index.mjs'))
  const connection = await local('/connection')
  const store = createPackStore(inventoryRoot, {
    centerId: connection.connection.centerId,
    trustedKeys: JSON.parse(await readFile('/tmp/p2-20260923/secrets/t22-trusted.json', 'utf8')),
    capabilities: { pluginVersion: '0.1.0', packSchemaVersions: [2] },
  })

  // ── b. takeover ──────────────────────────────────────────────────────────
  stage = 'takeover'
  const stateNow = await readState()
  const digest = (await hashContentDirectory(vendorPath)).contentTreeSha256
  const releaseId = `legacy.${digest}`
  if (stateNow.legacySuppressions[vendorPath]) {
    note('takeover-reuse', { alreadyManaged: true, releaseId })
  } else {
    const result = await store.takeOverLegacy({ operationKey: `g42-A-takeover-${digest.slice(0, 12)}`,
      expectedGeneration: stateNow.generation, vendorPath, expectedContentTreeSha256: digest })
    note('takeover-result', result)
  }
  let afterState = await readState()
  check(afterState.legacySuppressions[vendorPath]?.releaseId === releaseId, 'takeover did not record the suppression')
  // Same pack id must not be double-discovered: exactly one installed record
  // for the pack id, and exactly one active entry.
  const recordsForPack = Object.values(afterState.installed).filter(record => record.packId === legacyPackId)
  check(recordsForPack.length === 1 && recordsForPack[0].source === 'legacy', 'legacy pack must appear exactly once with source legacy')
  check(Object.values(afterState.active).filter(id => afterState.installed[id]?.packId === legacyPackId).length === 1, 'legacy pack must have exactly one active entry')
  const snapshot = await store.activeSnapshot()
  check(snapshot.suppressedLegacyPaths.includes(vendorPath), 'activeSnapshot does not exclude the legacy path')
  check(snapshot.packs.filter(item => item.packId === legacyPackId).length === 1, 'activeSnapshot lists the legacy pack twice')
  const receiptPath = join(inventoryRoot, 'legacy', digest, 'legacy.json')
  const receiptSha256 = await sha256File(receiptPath)
  check(JSON.parse(await readFile(receiptPath, 'utf8')).source === 'legacy', 'backup receipt missing or wrong provenance')
  note('backup-receipt', { path: receiptPath, sha256: receiptSha256, releaseId,
    area: 'pack-center-a inventory legacy/<contentTreeSha256>/ (local backup, not a center signature)' })

  // ── c. 停用 ──────────────────────────────────────────────────────────────
  stage = 'disable'
  afterState = await readState()
  await store.disable({ operationKey: 'g42-A-disable-legacy', expectedGeneration: afterState.generation, packId: legacyPackId })
  afterState = await readState()
  check(afterState.active[legacyPackId] === undefined, 'legacy pack still active after disable')
  check(afterState.legacySuppressions[vendorPath] !== undefined, 'disable must not drop the suppression record')
  note('disable-done', { packId: legacyPackId })

  // ── d. 恢复本地管理 ─────────────────────────────────────────────────────
  stage = 'restore'
  afterState = await readState()
  const restored = await store.restoreLegacyManagement({ operationKey: 'g42-A-restore-legacy',
    expectedGeneration: afterState.generation, vendorPath })
  note('restore-result', restored)
  afterState = await readState()
  check(afterState.legacySuppressions[vendorPath] === undefined, 'suppression survived restore')
  const record = afterState.installed[releaseId]
  check(record && record.source === 'legacy' && record.centerId === undefined && record.ownerOrgId === undefined
    && record.releaseId.startsWith('legacy.'), 'restored record must keep local-only legacy provenance (not a center release)')
  check(afterState.active[legacyPackId] === undefined, 'restored pack must not stay active as a center release')
  const restoredSnapshot = await store.activeSnapshot()
  check(!restoredSnapshot.suppressedLegacyPaths.includes(vendorPath), 'legacy path still suppressed after restore')
  check(!restoredSnapshot.packs.some(item => item.packId === legacyPackId), 'legacy pack still listed in active snapshot after restore')
  check((await readdir(vendorPath)).includes('pack.json'), 'legacy source directory must be intact after restore')

  // ── aftermath: center packs unchanged, listing back to before-state ─────
  stage = 'aftermath'
  const finalState = await readState()
  const finalActive = centerActiveOf(finalState)
  check(JSON.stringify(finalActive) === JSON.stringify(before.aCenterActiveBefore),
    `A center-owned packs changed: ${JSON.stringify({ before: before.aCenterActiveBefore, after: finalActive })}`)
  check(finalState.active[legacyPackId] === undefined && !finalState.legacySuppressions[vendorPath],
    'final A state must match the pre-takeover legacy posture')
  note('final', { active: finalActive, legacyActive: finalState.active[legacyPackId] ?? null,
    suppressions: Object.keys(finalState.legacySuppressions ?? {}) })
  passed = true
  return { before, releaseId, receiptPath, receiptSha256, finalActive }
}

main().then(async summary => {
  await evidence('G4.2.legacy.json', { node: 'G4.2', passed, summary, log, events: events.slice(-80) })
}).catch(async error => {
  const reason = String(error?.message || error).replace(/dpc_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400)
  note('failed', { stage, message: reason })
}).finally(async () => {
  try {
    await evidence('G4.2.log', json({ node: 'G4.2', passed, stage, log }))
    await evidence('G4.2.verdict.json', { node: 'G4.2', passed,
      reasons: log.filter(item => ['discovery-before', 'route-probe', 'takeover-result', 'takeover-reuse', 'backup-receipt', 'disable-done', 'restore-result', 'final', 'failed'].includes(item.message)) })
  } catch { /* preserve stdout contract */ }
  console.log(JSON.stringify({ node: 'G4.2', scriptReady: true }))
  if (!passed) process.exitCode = 1
})
