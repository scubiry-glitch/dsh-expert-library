#!/usr/bin/env node
/** R3.3: an enabled pack is a captured immutable root across an update. */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const tree = '/root/zhijian/dsh-pack-center-dev.ZGtty5'
const root = '/tmp/p2-20260923'
const statePath = join(root, 'pack-center-a', 'inventory', 'state.json')
const dag = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const prefix = '/plugins/dsh-expert-library/manage/center'
const port = 18281
const v1 = 'c95d8b85-6a2f-4fbc-9310-3d28c903f834'
const v2 = process.env.R33_V2_RELEASE || '3f041d24-df04-4186-bba0-ecd9dfc83d5b'
const events = [], log = []
let stage = 'preflight', passed = false, failure, task, liveProbe

const json = value => JSON.stringify(value, null, 2) + '\n'
const note = (message, data = {}) => log.push({ at: new Date().toISOString(), message, ...data })
const check = (value, message) => { if (!value) throw new Error(message) }
const safe = error => String(error?.message || error).replace(/dpc_(?:token|bind)_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 300)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

async function local(path, method = 'GET', body) {
  let response
  try {
    response = await fetch(`http://127.0.0.1:${port}${prefix}${path}`, { method,
      headers: { 'X-Pack-Center-UI': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) })
  } catch (error) { throw new Error(`DSH A transport failed: ${safe(error)}`) }
  const text = await response.text(); let envelope
  try { envelope = JSON.parse(text) } catch { envelope = undefined }
  const row = { status: response.status, ok: envelope?.ok === true, data: envelope?.data, errorCode: envelope?.error?.code }
  events.push({ method, path, status: row.status, ...(row.errorCode ? { errorCode: row.errorCode } : {}) })
  return row
}
async function state() { return JSON.parse(await readFile(statePath, 'utf8')) }
async function privateWrite(path, bytes) { const { writeFile } = await import('node:fs/promises'); await writeFile(path, bytes, { mode: 0o600 }); await chmod(path, 0o600) }
async function evidence(name, value) { await mkdir(dag, { recursive: true, mode: 0o700 }); await privateWrite(join(dag, name), typeof value === 'string' ? value : json(value)) }

async function treeHash(rootPath) {
  const rows = []
  async function visit(current, relative = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name), rel = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await visit(path, rel)
      else if (entry.isFile()) rows.push(`${rel}\0${(await readFile(path)).toString('base64')}`)
    }
  }
  await visit(rootPath)
  return digest(Buffer.from(rows.join('\n')))
}
async function waitOperation(operationId) {
  let last
  for (let i = 0; i < 240; i++) {
    const row = await local(`/operations/${operationId}`); last = row.data
    if (row.ok && ['succeeded', 'failed', 'interrupted'].includes(row.data?.status)) return row.data
    await delay(250)
  }
  return last
}
async function operation(body) {
  const existing = (await local('/operations')).data?.find(item => item.request?.operationKey === body.operationKey)
  const queued = existing ? { ok: true, data: existing, status: 200 } : await local('/operations', 'POST', body)
  check(queued.ok, `operation enqueue failed: ${queued.errorCode || queued.status}`)
  const done = await waitOperation(queued.data.operationId)
  return { queued: queued.data, done }
}
function targetFor(snapshot, releaseId) {
  const record = snapshot.installed[releaseId], accepted = snapshot.acceptedReleases[releaseId]
  check(record && accepted, `release ${releaseId} is not installed and accepted`)
  return { manifestSha256: accepted.manifestSha256, artifactSha256: record.artifactSha256, contentTreeSha256: record.contentTreeSha256 }
}
async function runtimeEndpointProbe() {
  const paths = ['/runtime', '/runtime/snapshot', '/runtime/pack-center', '/snapshot']
  const probes = []
  for (const path of paths) {
    const result = await local(path)
    probes.push({ path, status: result.status, ok: result.ok, errorCode: result.errorCode || null, hasSnapshot: Boolean(result.data?.packs || result.data?.snapshot) })
  }
  return probes
}
async function startSnapshotProbe(path, expectedHash) {
  // The plugin intentionally keeps activeSnapshot() internal; there is no
  // manage/runtime route. This real child reads the active root and holds its
  // descriptor open, giving a bounded local approximation without inventing a
  // DSH task id.
  const source = `const fs=require('node:fs'); const path=${JSON.stringify(path)}; const expected=${JSON.stringify(expectedHash)};\n` +
    `if(!fs.existsSync(path)) process.exit(21); const fd=fs.openSync(path,'r'); fs.readdirSync(path); try{fs.readFileSync(path+'/pack.json')}catch{} process.stdout.write(JSON.stringify({root:path,expected})); setTimeout(()=>{fs.closeSync(fd);process.exit(0)},30000);`
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] })
  const output = [], errors = []
  child.stdout.on('data', chunk => output.push(chunk.toString()))
  child.stderr.on('data', chunk => errors.push(chunk.toString()))
  await delay(250)
  task = { taskId: null, kind: 'local-snapshot-probe', pid: child.pid, root: path, expectedHash, approximation: 'real child process reads and holds the active pack root; no DSH task id was fabricated' }
  note('probe-started', task)
  return { child, output, errors }
}
async function waitChild(probe) {
  const exitCode = await new Promise(resolve => probe.child.once('close', resolve))
  return { exitCode, stdout: probe.output.join('').slice(0, 500), stderr: probe.errors.join('').slice(0, 300) }
}
async function enableV1(snapshot, keyPrefix) {
  const current = await state()
  if (current.active['macro-capital-analyst'] === v1) return { skipped: true, generation: current.generation }
  const result = await operation({ operationKey: `${keyPrefix}-${current.generation}`, kind: 'enable', expectedGeneration: current.generation, releaseId: v1 })
  check(result.done.status === 'succeeded', `restore v1 failed: ${result.done.errorCode || result.done.status}`)
  return result
}

async function main() {
  stage = 'preflight'
  const before = await state(), old = before.installed[v1], newer = before.installed[v2]
  check(before.active['macro-capital-analyst'] === v1, 'R3.3 requires active macro-capital-analyst 2.2.0')
  check(old && newer, 'v1 and cached v2 must both be installed')
  const oldHash = await treeHash(old.packPath), oldExists = true
  const beforeProbe = await runtimeEndpointProbe()
  note('baseline', { generation: before.generation, oldRelease: v1, oldSnapshotPath: old.packPath, oldSnapshotHash: oldHash, runtimeEndpointProbe: beforeProbe })

  stage = 'long-task'
  const probe = await startSnapshotProbe(old.packPath, oldHash)
  liveProbe = probe
  const connection = await local('/connection'); check(connection.ok, 'connection view unavailable')
  const update = await operation({ operationKey: `r33-A-update-enable-${v2}-${before.generation}`, kind: 'update_enable', expectedGeneration: before.generation,
    connectionRevision: connection.data.revision, target: targetFor(before, v2), releaseId: v2 })
  check(update.done.status === 'succeeded', `update_enable failed: ${update.done.errorCode || update.done.status}`)
  const afterUpdate = await state(), active = afterUpdate.active['macro-capital-analyst'], activeRecord = afterUpdate.installed[active]
  check(active === v2 && activeRecord, 'new runtime view did not select cached v2')
  check(probe.child.exitCode === null, 'snapshot probe ended before the mid-run observation')
  const whileAliveHash = await treeHash(old.packPath)
  const oldWhileAlive = { exists: true, path: old.packPath, hash: whileAliveHash, byteIdentical: whileAliveHash === oldHash, taskPid: task?.pid || null }
  check(oldWhileAlive.byteIdentical, 'old snapshot changed while probe task was alive')
  note('mid-run-update', { operation: update, newRuntimeView: { source: 'center installations / activeSnapshot contract', generation: afterUpdate.generation, releaseId: active, version: activeRecord.version, snapshotPath: activeRecord.packPath, snapshotHash: await treeHash(activeRecord.packPath) }, oldWhileAlive })

  stage = 'task-end'
  const taskResult = await waitChild(probe)
  liveProbe = undefined
  const oldAfterHash = await treeHash(old.packPath), retained = oldAfterHash === oldHash
  check(retained, 'old snapshot was not retained after task ended')
  note('task-ended', { task, taskResult, oldRetained: { exists: true, hash: oldAfterHash, byteIdentical: retained } })
  await enableV1(afterUpdate, 'r33-A-restore-v1')
  const final = await state(); check(final.active['macro-capital-analyst'] === v1, 'R3.3 did not restore v1')
  passed = true
}

try { await main() } catch (error) { failure = safe(error); note('failed', { stage, error: failure }) }
finally {
  if (liveProbe?.child && liveProbe.child.exitCode === null) {
    try { liveProbe.child.kill('SIGTERM') } catch {}
  }
  try { await enableV1(await state(), 'r33-A-final-v1') } catch (error) { failure ||= safe(error); note('restore-failed', { error: safe(error) }) }
  const verdict = { node: 'R3.3', passed: passed && !failure, approximation: 'No manage/runtime endpoint exposes internal activeSnapshot paths. A real child process read/held the active root; taskId is null by design.', reasons: log.filter(row => ['baseline', 'mid-run-update', 'task-ended', 'failed'].includes(row.message)), failure: failure || null }
  await evidence('R3.3.snapshot.json', { node: 'R3.3', task, observations: log.filter(row => ['baseline', 'probe-started', 'mid-run-update', 'task-ended'].includes(row.message)), events }).catch(() => {})
  await evidence('R3.3.verdict.json', verdict).catch(() => {})
  await evidence('R3.3.log', { node: 'R3.3', stage, events, log }).catch(() => {})
  console.log(JSON.stringify({ node: 'R3.3', scriptReady: true, passed: verdict.passed }))
  if (!verdict.passed) process.exitCode = 1
}
