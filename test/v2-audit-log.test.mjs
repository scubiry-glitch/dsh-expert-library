/**
 * Provider audit persistence + read surface (audit gap #2): the JSONL
 * AuditLogFile (append/read-tail/rotation), the route handler factory
 * (tail order, ?limit= clamping, empty state, persisted-tail reload merge,
 * in-memory-first dedupe), and the credential non-leakage scan over the
 * serialized route response.
 *
 * All tests are hermetic: temp dirs, no real providers, fake req/res.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AuditLogFile,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  createAuditHandler,
  mergeAuditTails,
  parseAuditLimit,
  resolveAuditLogPath,
} from '../lib/host/audit-log.js'

/* ---------------------------------------------------------------------------
 * Helpers
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

/** One registry-shaped audit entry with a controllable timestamp. */
function entry(at, kind = 'invoke', providerId = 'zyt', operation = 'zyt.indicators.series', outcome = 'ok', version = '2.3.0', detail = undefined) {
  return {
    at,
    kind,
    providerId,
    version,
    ...(operation !== undefined ? { operation } : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    ...(detail !== undefined ? { detail } : {}),
  }
}

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

/* ---------------------------------------------------------------------------
 * AuditLogFile: append / read-tail / rotation
 * ------------------------------------------------------------------------- */

test('AuditLogFile appends one JSON line per record; readTail returns them in order', async () => {
  const dir = await tempDir('audit-append-')
  try {
    const log = new AuditLogFile(join(dir, 'provider-audit.jsonl'))
    await log.appendAll([
      entry('2026-08-22T10:00:00.000Z', 'invoke', 'zyt', 'zyt.indicators.series', 'ok'),
      entry('2026-08-22T10:00:01.000Z', 'invoke', 'wind', 'financial.stock.snapshot', 'fail', '1.0.0', 'stale: provider-version-changed'),
    ])
    await log.flush()
    const tail = await log.readTail(10)
    assert.equal(tail.length, 2)
    assert.equal(tail[0].providerId, 'zyt')
    assert.equal(tail[0].outcome, 'ok')
    assert.equal(tail[1].providerId, 'wind')
    assert.equal(tail[1].outcome, 'fail')
    assert.equal(tail[1].detail, 'stale: provider-version-changed')
    // On-disk format: exactly one JSON object per line.
    const raw = (await readFile(join(dir, 'provider-audit.jsonl'), 'utf8')).trimEnd()
    const lines = raw.split('\n')
    assert.equal(lines.length, 2)
    for (const line of lines) {
      assert.equal(typeof JSON.parse(line).at, 'string')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readTail returns only the last N entries of the file', async () => {
  const dir = await tempDir('audit-tail-')
  try {
    const log = new AuditLogFile(join(dir, 'provider-audit.jsonl'))
    const rows = Array.from({ length: 10 }, (_, i) => entry(`2026-08-22T10:00:0${i}.000Z`))
    await log.appendAll(rows)
    await log.flush()
    const tail = await log.readTail(3)
    assert.equal(tail.length, 3)
    assert.equal(tail[0].at, '2026-08-22T10:00:07.000Z')
    assert.equal(tail[2].at, '2026-08-22T10:00:09.000Z')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('rotation rewrites the file to the last keepLines once it exceeds maxBytes', async () => {
  const dir = await tempDir('audit-rotate-')
  try {
    const log = new AuditLogFile(join(dir, 'provider-audit.jsonl'), { maxBytes: 500, keepLines: 3 })
    const rows = Array.from({ length: 12 }, (_, i) => entry(`2026-08-22T10:00:${String(i).padStart(2, '0')}.000Z`))
    for (const row of rows) await log.appendAll([row])
    await log.flush()
    const tail = await log.readTail(100)
    assert.equal(tail.length, 3, 'only the last keepLines survive rotation')
    assert.equal(tail[0].at, '2026-08-22T10:00:09.000Z')
    assert.equal(tail[2].at, '2026-08-22T10:00:11.000Z')
    const info = await stat(join(dir, 'provider-audit.jsonl'))
    assert.ok(info.size <= 500, `rotated file stays under the cap (${info.size})`)
    assert.equal((await readFile(join(dir, 'provider-audit.jsonl'), 'utf8')).trimEnd().split('\n').length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readTail of a missing file is empty; malformed lines are skipped', async () => {
  const dir = await tempDir('audit-malformed-')
  try {
    const path = join(dir, 'provider-audit.jsonl')
    const missing = new AuditLogFile(join(dir, 'does-not-exist.jsonl'))
    assert.deepEqual(await missing.readTail(10), [])
    await writeFile(path, '{"at":"2026-08-22T10:00:00.000Z","kind":"invoke"}\nnot-json\n{"broken\n', 'utf8')
    const log = new AuditLogFile(path)
    const tail = await log.readTail(10)
    assert.equal(tail.length, 1)
    assert.equal(tail[0].at, '2026-08-22T10:00:00.000Z')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------------------------
 * parseAuditLimit / resolveAuditLogPath / mergeAuditTails (pure)
 * ------------------------------------------------------------------------- */

test('parseAuditLimit: default 100, clamps at 500, invalid → default', () => {
  assert.equal(parseAuditLimit(null), 100)
  assert.equal(parseAuditLimit(''), 100)
  assert.equal(parseAuditLimit('5'), 5)
  assert.equal(parseAuditLimit('500'), 500)
  assert.equal(parseAuditLimit('501'), 500)
  assert.equal(parseAuditLimit('1000'), 500)
  assert.equal(parseAuditLimit('0'), 100)
  assert.equal(parseAuditLimit('-3'), 100)
  assert.equal(parseAuditLimit('abc'), 100)
})

test('resolveAuditLogPath: DSH_HOME when set, else cwd fallback', () => {
  assert.equal(
    resolveAuditLogPath({ DSH_HOME: '/data/dsh' }, '/work'),
    join('/data/dsh', '.expert-teams', 'provider-audit.jsonl'),
  )
  assert.equal(
    resolveAuditLogPath({ DSH_HOME: '  ' }, '/work'),
    join('/work', '.expert-teams', 'provider-audit.jsonl'),
  )
  assert.equal(
    resolveAuditLogPath({}, '/work'),
    join('/work', '.expert-teams', 'provider-audit.jsonl'),
  )
})

test('mergeAuditTails: dedupes file copies of in-memory entries, sorts by at, keeps the tail', () => {
  const e1 = entry('2026-08-22T10:00:01.000Z')
  const e2 = entry('2026-08-22T10:00:02.000Z')
  const e3 = entry('2026-08-22T10:00:03.000Z')
  const e4 = entry('2026-08-22T10:00:04.000Z')
  // The file contains copies of this process's own entries (e2) plus history.
  const merged = mergeAuditTails([e1, e2, e3, e4], [e2, e4], 10)
  assert.deepEqual(merged.map(e => e.at), [e1.at, e2.at, e3.at, e4.at])
  // Tail bound.
  assert.equal(mergeAuditTails([e1, e2, e3, e4], [e2, e4], 2).length, 2)
  assert.equal(mergeAuditTails([e1, e2, e3, e4], [e2, e4], 2)[0].at, e3.at)
  // Wire projection carries only the audit fields.
  assert.deepEqual(Object.keys(merged[0]).sort(), ['at', 'kind', 'operation', 'outcome', 'providerId', 'version'])
})

/* ---------------------------------------------------------------------------
 * Route handler
 * ------------------------------------------------------------------------- */

test('handler: empty state returns an empty entries array (200 JSON)', async () => {
  const handler = createAuditHandler({ resolveMemory: () => [] })
  const res = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/audit'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { entries: [] })
})

test('handler: returns the in-memory audit tail in order, respecting ?limit= clamp', async () => {
  const memory = Array.from({ length: 20 }, (_, i) => entry(`2026-08-22T10:00:${String(i).padStart(2, '0')}.000Z`))
  const handler = createAuditHandler({ resolveMemory: () => memory })
  // Default limit 100 → all 20.
  const all = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/audit'), all)
  assert.equal(JSON.parse(all.body).entries.length, 20)
  assert.equal(JSON.parse(all.body).entries[0].at, memory[0].at)
  // ?limit=5 → last 5.
  const five = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/audit?limit=5'), five)
  assert.deepEqual(JSON.parse(five.body).entries.map(e => e.at), memory.slice(-5).map(e => e.at))
  // ?limit=1000 → clamped to 500 (still all 20).
  const clamped = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/audit?limit=1000'), clamped)
  assert.equal(JSON.parse(clamped.body).entries.length, 20)
  // ?limit=abc → default.
  const invalid = fakeRes()
  await handler(fakeReq('/plugins/dsh-expert-library/audit?limit=abc'), invalid)
  assert.equal(JSON.parse(invalid.body).entries.length, 20)
})

test('handler: reload merge — a persisted file fills the tail when memory is empty (cross-restart memory)', async () => {
  const dir = await tempDir('audit-reload-')
  try {
    const path = join(dir, 'provider-audit.jsonl')
    const log = new AuditLogFile(path)
    const persisted = [
      entry('2026-08-22T09:00:01.000Z', 'invoke', 'wind', 'financial.stock.snapshot', 'fail'),
      entry('2026-08-22T09:00:02.000Z', 'invoke', 'zyt', 'zyt.indicators.series', 'ok'),
    ]
    await log.appendAll(persisted)
    await log.flush()
    // A "new process": fresh writer on the same file, empty in-memory audit.
    const handler = createAuditHandler({
      auditLog: new AuditLogFile(path),
      resolveMemory: () => [],
    })
    const res = fakeRes()
    await handler(fakeReq('/plugins/dsh-expert-library/audit'), res)
    const body = JSON.parse(res.body)
    assert.equal(body.entries.length, 2)
    assert.deepEqual(body.entries.map(e => e.at), ['2026-08-22T09:00:01.000Z', '2026-08-22T09:00:02.000Z'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('handler: reload merge — file copies of live in-memory entries are deduped, memory is first-class', async () => {
  const dir = await tempDir('audit-dedupe-')
  try {
    const path = join(dir, 'provider-audit.jsonl')
    const log = new AuditLogFile(path)
    const older = entry('2026-08-22T09:00:00.000Z', 'invoke', 'beike', 'realestate.listing.search', 'ok')
    const live = entry('2026-08-22T10:00:00.000Z', 'invoke', 'zyt', 'zyt.indicators.series', 'fail')
    await log.appendAll([older, live])
    await log.flush()
    // The live in-memory log contains this process's own copy of `live`.
    const handler = createAuditHandler({
      auditLog: new AuditLogFile(path),
      resolveMemory: () => [live],
    })
    const res = fakeRes()
    await handler(fakeReq('/plugins/dsh-expert-library/audit'), res)
    const entries = JSON.parse(res.body).entries
    assert.deepEqual(entries.map(e => e.at), [older.at, live.at], 'no double-count of the live entry')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('secret scan: sentinel credential keys/values never appear in the serialized audit response', async () => {
  const dir = await tempDir('audit-leak-')
  try {
    const path = join(dir, 'provider-audit.jsonl')
    const log = new AuditLogFile(path)
    const memory = [
      entry('2026-08-22T10:00:00.000Z', 'invoke', 'zyt', 'zyt.indicators.series', 'ok'),
      entry('2026-08-22T10:00:01.000Z', 'invoke', 'wind', 'financial.stock.snapshot', 'fail', '1.0.0', 'stale: provider-version-changed'),
    ]
    await log.appendAll(memory)
    await log.flush()
    const handler = createAuditHandler({
      auditLog: new AuditLogFile(path),
      resolveMemory: () => memory,
    })
    const res = fakeRes()
    await handler(fakeReq('/plugins/dsh-expert-library/audit?limit=500'), res)
    const serialized = res.body
    // Sentinel keys — audit records must never carry credential material.
    for (const key of [
      'WIND_API_KEY', 'ZYT_API_KEY', 'BEIKE_MCP_API_KEY',
      'Authorization', 'authorization', 'Bearer', 'X-Api-Key',
      'password', 'secret', 'apiKey', 'token', 'credential',
    ]) {
      assert.equal(serialized.includes(key), false, `leaked sentinel key: ${key}`)
    }
    // The response is parseable JSON with exactly the documented fields
    // (base set; `detail` only when the record carried one).
    const parsed = JSON.parse(serialized)
    assert.equal(parsed.entries.length, 2)
    const baseKeys = ['at', 'kind', 'operation', 'outcome', 'providerId', 'version']
    for (const wireEntry of parsed.entries) {
      const keys = Object.keys(wireEntry).sort()
      for (const key of baseKeys) assert.ok(keys.includes(key), `missing wire field: ${key}`)
      for (const key of keys) {
        assert.ok(baseKeys.includes(key) || key === 'detail', `unexpected wire field: ${key}`)
      }
    }
    assert.ok(parsed.entries.some(e => e.detail !== undefined), 'detail survives on records that carry it')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
