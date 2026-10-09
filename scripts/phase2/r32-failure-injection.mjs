#!/usr/bin/env node
/** R3.2: deliberate local corruption must fail closed and be fully restored. */
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const tree = '/root/zhijian/dsh-pack-center-dev.ZGtty5'
const root = '/tmp/p2-20260923'
const inventory = join(root, 'pack-center-a', 'inventory')
const statePath = join(inventory, 'state.json')
const backupRoot = join(root, 'r32', 'backups')
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const prefix = '/plugins/dsh-expert-library/manage/center'
const instance = { id: 'A', port: 18281 }
const v1 = 'c95d8b85-6a2f-4fbc-9310-3d28c903f834'
const requestedV2 = process.env.R32_V2_RELEASE || '3f041d24-df04-4186-bba0-ecd9dfc83d5b'
const events = [], log = [], touched = new Map()
let stage = 'preflight', passed = false, failure, restoration = []

const json = value => JSON.stringify(value, null, 2) + '\n'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const note = (message, data = {}) => log.push({ at: new Date().toISOString(), message, ...data })
const check = (value, message) => { if (!value) throw new Error(message) }
const shortError = error => String(error?.message || error).replace(/dpc_(?:token|bind)_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)

async function local(path, method = 'GET', body) {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${instance.port}${prefix}${path}`, {
      method, headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    })
  } catch (error) { throw new Error(`DSH A transport failed: ${shortError(error)}`) }
  const text = await response.text(); let envelope
  try { envelope = JSON.parse(text) } catch { envelope = undefined }
  const result = { status: response.status, ok: envelope?.ok === true, data: envelope?.data, errorCode: envelope?.error?.code }
  events.push({ actor: 'A', method, path, status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}) })
  return result
}

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')) }
async function fileDigest(path) { return sha256(await readFile(path)) }
async function privateWrite(path, bytes) { await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600) }
async function writeEvidence(name, value) { await mkdir(dag, { recursive: true, mode: 0o700 }); await privateWrite(join(dag, name), typeof value === 'string' ? value : json(value)) }

async function backup(path, label) {
  const target = join(backupRoot, label)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try { await stat(target) } catch { await copyFile(path, target); await chmod(target, 0o600) }
  touched.set(path, target)
  return { path, backup: target, before: await fileDigest(target) }
}
async function restoreAll() {
  for (const [path, backupPath] of touched) {
    const original = await readFile(backupPath)
    await privateWrite(path, original)
  }
}
async function assertRestored() {
  const rows = []
  for (const [path, backupPath] of touched) {
    const actual = await fileDigest(path), expected = await fileDigest(backupPath)
    rows.push({ path, backup: backupPath, actual, expected, identical: actual === expected })
    check(actual === expected, `restore hash mismatch: ${path}`)
  }
  return rows
}
async function flipByte(path, offset = 0) {
  const bytes = Buffer.from(await readFile(path))
  check(bytes.length > 0, `cannot corrupt empty file: ${path}`)
  bytes[offset % bytes.length] ^= 1
  await privateWrite(path, bytes)
  return sha256(bytes)
}
async function mutateEnvelope(path, mutator) {
  const envelope = await readJson(path)
  mutator(envelope)
  await privateWrite(path, Buffer.from(json(envelope)))
  return sha256(await readFile(path))
}
async function state() { return readJson(statePath) }
function macro(installs) { return installs.items?.find(item => item.packId === 'macro-capital-analyst' && item.releaseId === 'c95d8b85-6a2f-4fbc-9310-3d28c903f834') ?? installs.items?.find(item => item.packId === 'macro-capital-analyst') }
async function installations() {
  const result = await local('/installations')
  check(result.ok, `installations failed: ${result.errorCode || result.status}`)
  return result.data
}
async function assertMacroIntact(expectedGeneration) {
  const view = await installations(), item = macro(view)
  check(item?.active && item.version === '2.2.0' && item.releaseId === v1, 'A macro-capital-analyst 2.2.0 is not active')
  check(view.mode === 'normal', `A inventory mode is ${view.mode}`)
  if (expectedGeneration !== undefined) check(view.generation === expectedGeneration, `failed operation changed generation ${expectedGeneration} -> ${view.generation}`)
  return { generation: view.generation, item: { releaseId: item.releaseId, version: item.version, integrity: item.integrity, errorCode: item.errorCode || null }, mode: view.mode }
}
async function waitOperation(operationId) {
  let last
  for (let i = 0; i < 240; i++) {
    last = await local(`/operations/${operationId}`)
    if (last.ok && ['succeeded', 'failed', 'interrupted'].includes(last.data?.status)) return last.data
    await delay(250)
  }
  return last?.data
}
async function expectFailed(label, body, expectedCodes = []) {
  const enqueued = await local('/operations', 'POST', body)
  const row = { label, request: { kind: body.kind, releaseId: body.releaseId || null, expectedGeneration: body.expectedGeneration }, enqueueStatus: enqueued.status, enqueueErrorCode: enqueued.errorCode || null }
  if (!enqueued.ok) {
    check(expectedCodes.length === 0 || expectedCodes.includes(enqueued.errorCode), `${label} unexpected enqueue error ${enqueued.errorCode}`)
    row.status = 'rejected'; row.errorCode = enqueued.errorCode || null
    note('injection-failed-at-enqueue', row); return row
  }
  const done = await waitOperation(enqueued.data.operationId)
  row.operationId = enqueued.data.operationId; row.status = done?.status; row.errorCode = done?.errorCode || null
  check(['failed', 'interrupted'].includes(row.status), `${label} unexpectedly ${row.status}`)
  if (expectedCodes.length) check(expectedCodes.includes(row.errorCode), `${label} code ${row.errorCode} not in ${expectedCodes.join(',')}`)
  note('injection-failed', row); return row
}
function targetFor(stateValue, releaseId) {
  const record = stateValue.installed[releaseId]
  check(record, `release ${releaseId} is not installed`)
  return { manifestSha256: stateValue.acceptedReleases[releaseId]?.manifestSha256, artifactSha256: record.artifactSha256, contentTreeSha256: record.contentTreeSha256 }
}
function releaseDirectory(record) { return dirname(record.packPath) }
async function inactiveV2(stateValue) {
  const record = stateValue.installed[requestedV2]
    || Object.values(stateValue.installed).find(item => item.packId === 'macro-capital-analyst' && item.releaseId !== v1 && item.version !== '2.2.0')
  check(record, 'cached macro-capital-analyst v2 release is absent')
  return record
}

async function main() {
  stage = 'preflight'
  const beforeState = await state(), beforeBytes = await readFile(statePath), beforeDigest = sha256(beforeBytes)
  check(beforeState.active['macro-capital-analyst'] === v1, 'R3.2 requires A baseline active release 2.2.0')
  const v2Record = await inactiveV2(beforeState), v2Dir = releaseDirectory(v2Record), contentEntries = await readdir(v2Record.packPath, { withFileTypes: true })
  const contentFile = contentEntries.find(entry => entry.isFile())
  check(contentFile, 'cached v2 content has no regular file to corrupt')
  const contentPath = join(v2Record.packPath, contentFile.name), manifestPath = v2Record.manifestPath
  note('baseline', { stateDigest: beforeDigest, generation: beforeState.generation, active: beforeState.active, v2: { releaseId: v2Record.releaseId, version: v2Record.version, releaseDir: v2Dir, contentPath } })

  stage = 'tampered-archive'
  await backup(contentPath, 'v2-content.bin')
  const tamperedContentDigest = await flipByte(contentPath)
  const archiveView = await local('/installations')
  const archiveItem = archiveView.data?.items?.find(item => item.releaseId === v2Record.releaseId)
  const archiveFailure = await expectFailed('tampered-archive-enable', { operationKey: `r32-archive-${v2Record.releaseId}`, kind: 'enable', expectedGeneration: beforeState.generation, releaseId: v2Record.releaseId }, ['CONTENT_DIGEST_MISMATCH', 'PACK_INVALID', 'INVENTORY_MISSING'])
  note('tampered-archive-observed', { tamperedContentDigest, installations: { integrity: archiveItem?.integrity, errorCode: archiveItem?.errorCode || null }, operation: archiveFailure })
  await restoreAll(); await assertMacroIntact(beforeState.generation)

  stage = 'tampered-manifest'
  await backup(manifestPath, 'v2-release.json')
  const tamperedManifestDigest = await mutateEnvelope(manifestPath, envelope => {
    const first = envelope.signature[0] === 'A' ? 'B' : 'A'
    envelope.signature = first + envelope.signature.slice(1)
  })
  const manifestView = await local('/installations')
  const manifestItem = manifestView.data?.items?.find(item => item.releaseId === v2Record.releaseId)
  const manifestFailure = await expectFailed('tampered-manifest-enable', { operationKey: `r32-manifest-${v2Record.releaseId}`, kind: 'enable', expectedGeneration: beforeState.generation, releaseId: v2Record.releaseId }, ['SIGNATURE_INVALID', 'INVALID_CONTRACT', 'UNSUPPORTED_PROTOCOL', 'INVENTORY_UNSAFE', 'OPERATION_FAILED', 'CENTER_REQUEST_FAILED'])
  note('tampered-manifest-observed', { tamperedManifestDigest, installations: { integrity: manifestItem?.integrity, errorCode: manifestItem?.errorCode || null }, operation: manifestFailure })
  await restoreAll(); await assertMacroIntact(beforeState.generation)

  stage = 'tampered-inventory'
  await backup(statePath, 'state.json')
  const corruptedStateDigest = await flipByte(statePath, 0)
  const corrupted = await local('/installations')
  check(corrupted.ok || corrupted.errorCode, 'corrupted state read returned no observable result')
  const mode = corrupted.data?.mode, corruptionCode = corrupted.data?.warningCode || corrupted.errorCode
  check(mode === 'recovered-read-only' || ['STATE_CORRUPT', 'STATE_RECOVERY_INVALID', 'STATE_READ_ONLY'].includes(corruptionCode), `state corruption was not detected: ${mode || corruptionCode}`)
  const restoredStateBytes = await readFile(join(backupRoot, 'state.json')); await privateWrite(statePath, restoredStateBytes)
  const normal = await installations(); check(normal.mode === 'normal', `state did not return to normal mode: ${normal.mode}`)
  note('tampered-inventory-observed', { corruptedStateDigest, mode, code: corruptionCode || null, restoredMode: normal.mode })

  stage = 'unknown-protocol'
  await backup(manifestPath, 'v2-release-unknown-protocol.json')
  const unknownProtocolDigest = await mutateEnvelope(manifestPath, envelope => { envelope.manifest.protocolVersion = 9 })
  const protocolFailure = await expectFailed('unknown-protocol-enable', { operationKey: `r32-protocol-${v2Record.releaseId}`, kind: 'enable', expectedGeneration: beforeState.generation, releaseId: v2Record.releaseId }, ['UNSUPPORTED_PROTOCOL', 'SIGNATURE_INVALID', 'INVALID_CONTRACT', 'OPERATION_FAILED'])
  note('unknown-protocol-observed', { exercised: 'release envelope manifest.protocolVersion=9; transport protocol selection is not exposed by local manage API', tamperedManifestDigest: unknownProtocolDigest, operation: protocolFailure })
  await restoreAll(); await assertMacroIntact(beforeState.generation)

  stage = 'stale-generation'
  const stale = await expectFailed('stale-generation-enable-v1', { operationKey: `r32-stale-${v1}`, kind: 'enable', expectedGeneration: beforeState.generation - 1, releaseId: v1 }, ['GENERATION_CONFLICT'])
  check(stale.status === 'rejected' && stale.errorCode === 'GENERATION_CONFLICT', 'stale generation was not rejected at the route fence')
  note('stale-generation-observed', stale)

  const after = await state(); check(after.active['macro-capital-analyst'] === v1, 'A ended on an unexpected macro release')
  check(after.generation === beforeState.generation, `failed injections advanced generation ${beforeState.generation} -> ${after.generation}`)
  passed = true
}

try { await main() } catch (error) { failure = shortError(error); note('failed', { stage, error: failure }) }
finally {
  try { await restoreAll(); restoration = await assertRestored() } catch (error) { failure ||= shortError(error); note('restore-failed', { error: shortError(error) }) }
  const verdict = { node: 'R3.2', passed: passed && !failure, reasons: log.filter(row => /baseline|observed|failed/.test(row.message)), failure: failure || null }
  await writeEvidence('R3.2.injections.json', { node: 'R3.2', baseline: log.find(row => row.message === 'baseline') || null, events, injections: log.filter(row => row.message.endsWith('observed')), restoration }).catch(() => {})
  await writeEvidence('R3.2.verdict.json', verdict).catch(() => {})
  await writeEvidence('R3.2.log', { node: 'R3.2', stage, events, log }).catch(() => {})
  console.log(JSON.stringify({ node: 'R3.2', scriptReady: true, passed: verdict.passed }))
  if (!verdict.passed) process.exitCode = 1
}
