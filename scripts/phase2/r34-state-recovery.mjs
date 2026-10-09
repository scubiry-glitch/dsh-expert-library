#!/usr/bin/env node
/** R3.4: state corruption and process crashes must recover without duplication. */
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { readFile as readFileAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const execFile = promisify(execFileCallback)
const tree = '/root/zhijian/dsh-pack-center-dev.ZGtty5'
const root = '/tmp/p2-20260923'
const workspaceA = join(root, 'workspace-a')
const statePath = join(root, 'pack-center-a', 'inventory', 'state.json')
const preimagePath = join(root, 'r34', 'state.json.preimage')
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const prefix = '/plugins/dsh-expert-library/manage/center'
const port = 18281
const v1 = 'c95d8b85-6a2f-4fbc-9310-3d28c903f834'
const v2 = process.env.R34_V2_RELEASE || '3f041d24-df04-4186-bba0-ecd9dfc83d5b'
const nodeBin = '/root/.nvm/versions/node/v22.22.0/bin/node'
const dshBin = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
const events = [], log = []
let stage = 'preflight', passed = false, failure, aRestarted = false, stateCorrupted = false

const json = value => JSON.stringify(value, null, 2) + '\n'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const note = (message, data = {}) => log.push({ at: new Date().toISOString(), message, ...data })
const check = (value, message) => { if (!value) throw new Error(message) }
const safe = error => String(error?.message || error).replace(/dpc_(?:token|bind)_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)

async function local(path, method = 'GET', body) {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}${prefix}${path}`, { method,
      headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
  } catch (error) { throw new Error(`DSH A transport failed: ${safe(error)}`) }
  const text = await response.text(); let envelope
  try { envelope = JSON.parse(text) } catch { envelope = undefined }
  const result = { status: response.status, ok: envelope?.ok === true, data: envelope?.data, errorCode: envelope?.error?.code }
  events.push({ method, path, status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}) })
  return result
}
async function state() { return JSON.parse(await readFileAsync(statePath, 'utf8')) }
async function privateWrite(path, bytes) { writeFileSync(path, bytes, { mode: 0o600 }); chmodSync(path, 0o600) }
async function evidence(name, value) { mkdirSync(dag, { recursive: true, mode: 0o700 }); await privateWrite(join(dag, name), typeof value === 'string' ? value : json(value)) }
async function waitOperation(operationId, attempts = 240) {
  let last
  for (let i = 0; i < attempts; i++) {
    const row = await local(`/operations/${operationId}`); last = row.data
    if (row.ok && ['succeeded', 'failed', 'interrupted'].includes(row.data?.status)) return row.data
    await delay(250)
  }
  return last
}
function targetFor(snapshot, releaseId) {
  const record = snapshot.installed[releaseId], accepted = snapshot.acceptedReleases[releaseId]
  check(record && accepted, `release ${releaseId} is not installed and accepted`)
  return { manifestSha256: accepted.manifestSha256, artifactSha256: record.artifactSha256, contentTreeSha256: record.contentTreeSha256 }
}
async function operation(body) {
  const existing = (await local('/operations')).data?.find(item => item.request?.operationKey === body.operationKey)
  const queued = existing ? { ok: true, data: existing, status: 200 } : await local('/operations', 'POST', body)
  check(queued.ok, `operation enqueue failed: ${queued.errorCode || queued.status}`)
  const done = await waitOperation(queued.data.operationId)
  return { queued: queued.data, done }
}
async function allAProcesses() {
  let stdout = ''
  try { stdout = (await execFile('/usr/bin/pgrep', ['-f', 'p2-a'], { maxBuffer: 1024 * 1024 })).stdout } catch { return [] }
  const pids = []
  for (const text of stdout.trim().split('\n').filter(Boolean)) {
    const pid = Number(text); if (!Number.isSafeInteger(pid) || pid === process.pid) continue
    try {
      const cmdline = (await readFileAsync(`/proc/${pid}/cmdline`)).toString().replaceAll('\0', ' ')
      if (cmdline.includes(dshBin) && cmdline.includes('--profile p2-a')) pids.push(pid)
    } catch {}
  }
  return pids
}
async function waitDown() {
  for (let i = 0; i < 30; i++) {
    try { await local('/connection'); await delay(100) } catch { return true }
  }
  return false
}
async function restartA(reason) {
  const logFd = openSync('/tmp/inst-a.log', 'a')
  const child = spawn('setsid', ['nohup', nodeBin, dshBin, '--profile', 'p2-a', '--host', '127.0.0.1', '--port', '18281', '--no-open'], {
    cwd: workspaceA, detached: true, stdio: ['ignore', logFd, logFd], env: { ...process.env, DSH_HOME: join(root, 'dsh-a'), NODE_EXTRA_CA_CERTS: join(root, 't22', 'ca.pem') },
  })
  child.unref(); closeSync(logFd); aRestarted = true
  for (let i = 0; i < 240; i++) {
    try { const row = await local('/connection'); if (row.ok) { note('A-restarted', { reason, pid: child.pid }); return row.data } } catch {}
    await delay(500)
  }
  throw new Error('DSH A did not return after restart')
}
async function killA(reason) {
  const pids = await allAProcesses(); check(pids.length > 0, 'could not find DSH A process')
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
  const down = await waitDown(); note('A-killed', { reason, pids, down }); check(down, 'DSH A remained reachable after SIGKILL')
}
async function ensureV1(keyPrefix) {
  const current = await state()
  if (current.active['macro-capital-analyst'] === v1) return { skipped: true, generation: current.generation }
  const result = await operation({ operationKey: `${keyPrefix}-${current.generation}`, kind: 'enable', expectedGeneration: current.generation, releaseId: v1 })
  check(result.done.status === 'succeeded', `v1 restore failed: ${result.done.errorCode || result.done.status}`)
  return result
}

async function main() {
  stage = 'preflight'
  const before = await state(), beforeBytes = await readFileAsync(statePath), beforeDigest = digest(beforeBytes)
  check(before.active['macro-capital-analyst'] === v1, 'R3.4 requires active macro-capital-analyst 2.2.0')
  mkdirSync(join(root, 'r34'), { recursive: true, mode: 0o700 })
  // Refresh the pre-image on every run so reruns remain idempotent even when
  // another phase has legitimately advanced generation since the last run.
  await privateWrite(preimagePath, beforeBytes)
  note('baseline', { generation: before.generation, stateDigest: beforeDigest, active: before.active })

  stage = 'state-corruption'
  const damaged = Buffer.from(beforeBytes); damaged[0] ^= 1; stateCorrupted = true; await privateWrite(statePath, damaged)
  const corruption = await local('/installations').catch(error => ({ status: 0, ok: false, errorCode: safe(error), data: null }))
  const corruptionMode = corruption.data?.mode, corruptionCode = corruption.data?.warningCode || corruption.errorCode || null
  check(corruptionMode === 'recovered-read-only' || ['STATE_CORRUPT', 'STATE_RECOVERY_INVALID', 'STATE_READ_ONLY'].includes(corruptionCode), `state corruption was not surfaced: ${corruptionMode || corruptionCode}`)
  await privateWrite(statePath, await readFileAsync(preimagePath)); stateCorrupted = false; const normal = await local('/installations')
  check(normal.ok && normal.data.mode === 'normal', `state did not return to normal: ${normal.data?.mode || normal.errorCode}`)
  note('state-corruption-observed', { corruptedDigest: digest(damaged), mode: corruptionMode || null, errorCode: corruptionCode, restoredDigest: digest(await readFileAsync(statePath)), restoredMode: normal.data.mode })

  stage = 'precommit-crash'
  const pre = await state(), preConnection = await local('/connection'); check(preConnection.ok, 'connection unavailable before precommit crash')
  const preKey = `r34-A-precommit-${v2}-${pre.generation}`
  const preBody = { operationKey: preKey, kind: 'update_enable', expectedGeneration: pre.generation, connectionRevision: preConnection.data.revision, target: targetFor(pre, v2), releaseId: v2 }
  const preEnqueue = await local('/operations', 'POST', preBody); check(preEnqueue.ok, `precommit enqueue failed: ${preEnqueue.errorCode}`)
  note('precommit-enqueued', { operationId: preEnqueue.data.operationId, generation: pre.generation, phase: preEnqueue.data.phase })
  await killA('immediately-after-precommit-enqueue'); await restartA('precommit-recovery')
  const preAfterJob = (await local('/operations')).data?.find(row => row.request?.operationKey === preKey)
  const preAfterState = await state(); check(preAfterJob, 'precommit operation disappeared after restart')
  const preDetail = await local(`/operations/${preEnqueue.data.operationId}`)
  const preTerminal = ['succeeded', 'failed', 'interrupted'].includes(preAfterJob.status) ? (preDetail.data || preAfterJob) : await waitOperation(preEnqueue.data.operationId)
  check(preAfterState.active['macro-capital-analyst'] === v1 || preAfterState.active['macro-capital-analyst'] === v2, 'precommit recovery produced an unknown active release')
  check(preAfterState.generation === pre.generation || preAfterState.generation === pre.generation + 1, 'precommit recovery changed generation more than once')
  note('precommit-recovered', { operation: preTerminal, operationRouteVisible: true, recoveryPhaseObserved: preAfterJob.phase === 'recovering', generationBefore: pre.generation, generationAfter: preAfterState.generation, active: preAfterState.active['macro-capital-analyst'] })
  await ensureV1('r34-A-between-crashes')

  stage = 'postcommit-crash'
  const committedBefore = await state(), committedConnection = await local('/connection'); check(committedConnection.ok, 'connection unavailable before postcommit crash')
  const postKey = `r34-A-postcommit-${v2}-${committedBefore.generation}`
  const postBody = { operationKey: postKey, kind: 'update_enable', expectedGeneration: committedBefore.generation, connectionRevision: committedConnection.data.revision, target: targetFor(committedBefore, v2), releaseId: v2 }
  const post = await operation(postBody); check(post.done.status === 'succeeded', `postcommit operation failed: ${post.done.errorCode || post.done.status}`)
  const committedState = await state(), committedGeneration = committedState.generation
  check(committedState.active['macro-capital-analyst'] === v2, 'postcommit operation did not activate v2 before kill')
  note('postcommit-succeeded-before-kill', { operation: post.done, generation: committedGeneration })
  await killA('after-postcommit-success'); await restartA('postcommit-recovery')
  const postAfterJob = (await local('/operations')).data?.find(row => row.request?.operationKey === postKey)
  const postDetail = await local(`/operations/${post.queued.operationId}`)
  const postAfterState = await state()
  check(postAfterJob?.status === 'succeeded' && postDetail.data?.status === 'succeeded', `postcommit receipt was not durable: ${postAfterJob?.status}`)
  check(postAfterState.generation === committedGeneration && postAfterState.active['macro-capital-analyst'] === v2, 'postcommit result changed or duplicated after restart')
  note('postcommit-recovered', { operation: postAfterJob, generation: postAfterState.generation, active: postAfterState.active['macro-capital-analyst'], unchangedGeneration: postAfterState.generation === committedGeneration })
  await ensureV1('r34-A-final-v1')
  const final = await state(); check(final.active['macro-capital-analyst'] === v1, 'R3.4 did not restore v1')
  passed = true
}

try { await main() } catch (error) { failure = safe(error); note('failed', { stage, error: failure }) }
finally {
  try {
    if (aRestarted) await ensureV1('r34-A-finally-v1')
  } catch (error) { failure ||= safe(error); note('restore-failed', { error: safe(error) }) }
  if (stateCorrupted) {
    try { await privateWrite(statePath, await readFileAsync(preimagePath)); stateCorrupted = false }
    catch (error) { failure ||= safe(error); note('final-state-restore-failed', { error: safe(error) }) }
  }
  const verdict = { node: 'R3.4', passed: passed && !failure, reasons: log.filter(row => /baseline|observed|recovered|failed/.test(row.message)), failure: failure || null }
  await evidence('R3.4.recovery.json', { node: 'R3.4', baseline: log.find(row => row.message === 'baseline') || null, recovery: log.filter(row => row.message.includes('recovered') || row.message.includes('succeeded-before-kill')), events }).catch(() => {})
  await evidence('R3.4.verdict.json', verdict).catch(() => {})
  await evidence('R3.4.log', { node: 'R3.4', stage, events, log }).catch(() => {})
  console.log(JSON.stringify({ node: 'R3.4', scriptReady: true, passed: verdict.passed }))
  if (!verdict.passed) process.exitCode = 1
}
