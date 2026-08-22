/**
 * Provider audit persistence wired into the ProviderTransportService (audit
 * gap #2): every invoke audit record is appended fire-and-forget to the
 * configured JSONL log; failures are persisted with outcome `fail`; a failing
 * audit write is swallowed (logger.warn) and never breaks the provider call;
 * reconfiguring keeps persisting to the same file; the log survives a "restart"
 * (readable from a fresh writer); and the serialized file never contains
 * credential material.
 *
 * All tests are hermetic: fake spawn seams, fake credentials, temp log files.
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProviderTransportService } from '../lib/host/provider-service.js'
import { AuditLogFile } from '../lib/host/audit-log.js'

const FAKE_SECRET = 'fake-secret-value-123'
const fakeCredentials = () => FAKE_SECRET

function ctxWithLogger(warnings) {
  return { get: () => undefined, logger: { warn: (message) => warnings.push(String(message)) } }
}

/** Fake spawn returning a canned wind-style success envelope. */
function windSpawnStub(record) {
  const inner = JSON.stringify({ data: { columns: ['windcode', 'close'], rows: [['600519.SH', 1521.5]], unit: '元' } })
  return async (options) => {
    record.push(options)
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        content: [{ type: 'text', text: inner }],
        cli_meta: { schema_version: '1.0', server_type: 'stock_data', tool_name: 'get_stock_price_indicators', completeness: 'not_asserted', tables: [], warnings: [] },
      }),
      stderr: '',
      killed: false,
      truncated: null,
    }
  }
}

function windOptions() {
  return { wind: { cliPath: '/fake/skills/wind-mcp-skill/scripts/cli.mjs' } }
}

function resolveBinding(service, capability, constraints = {}) {
  const result = service.resolver.resolve({ capability, constraints })
  assert.equal(result.status, 'bound', `capability ${capability} must bind: ${JSON.stringify(result.rejections)}`)
  return result.binding
}

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix))
}

test('every invoke appends exactly one JSONL audit record (ok outcome)', async () => {
  const dir = await tempDir('audit-persist-ok-')
  try {
    const log = new AuditLogFile(join(dir, 'provider-audit.jsonl'))
    const service = new ProviderTransportService(ctxWithLogger([]), {
      ...windOptions(),
      credentials: fakeCredentials,
      spawn: windSpawnStub([]),
      auditLog: log,
    })
    const binding = resolveBinding(service, 'financial.stock.snapshot')
    const envelope = await service.invoke({ binding, input: { windcode: '600519.SH' }, context: 't2c 采集' })
    assert.equal(envelope.ok, true)
    await log.flush()
    const tail = await log.readTail(10)
    // register/attach lifecycle records stay in-memory only — the file holds
    // exactly the invoke record.
    assert.equal(tail.length, 1)
    assert.equal(tail[0].kind, 'invoke')
    assert.equal(tail[0].providerId, 'wind')
    assert.equal(tail[0].operation, 'financial.stock.snapshot')
    assert.equal(tail[0].outcome, 'ok')
    assert.ok(tail[0].version.length > 0)
    assert.match(tail[0].at, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed invoke is persisted with outcome fail', async () => {
  const dir = await tempDir('audit-persist-fail-')
  try {
    const log = new AuditLogFile(join(dir, 'provider-audit.jsonl'))
    const service = new ProviderTransportService(ctxWithLogger([]), {
      ...windOptions(),
      credentials: () => undefined, // missing credential → fail-closed envelope
      spawn: async () => { throw new Error('must not run') },
      auditLog: log,
    })
    const binding = resolveBinding(service, 'financial.stock.snapshot')
    const envelope = await service.invoke({ binding, input: {} })
    assert.equal(envelope.ok, false)
    assert.equal(envelope.error.code, 'missing-credential')
    await log.flush()
    const tail = await log.readTail(10)
    assert.equal(tail.length, 1)
    assert.equal(tail[0].kind, 'invoke')
    assert.equal(tail[0].outcome, 'fail')
    assert.equal(tail[0].providerId, 'wind')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing audit write is swallowed (logger.warn) and never breaks the provider call', async () => {
  const dir = await tempDir('audit-persist-swallow-')
  try {
    // The log path's parent is a regular FILE → mkdir fails → append fails.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'i am a file, not a directory', 'utf8')
    const log = new AuditLogFile(join(blocker, 'provider-audit.jsonl'))
    const warnings = []
    const service = new ProviderTransportService(ctxWithLogger(warnings), {
      ...windOptions(),
      credentials: fakeCredentials,
      spawn: windSpawnStub([]),
      auditLog: log,
    })
    const binding = resolveBinding(service, 'financial.stock.snapshot')
    const envelope = await service.invoke({ binding, input: { windcode: '600519.SH' } })
    assert.equal(envelope.ok, true, 'the provider call must succeed despite the audit write failure')
    // Let the fire-and-forget append settle (its rejection is consumed).
    await log.flush().catch(() => {})
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /provider audit append failed/)
    // No partial file was created.
    await assert.rejects(readFile(join(blocker, 'provider-audit.jsonl')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconfigure keeps persisting invoke records to the same file', async () => {
  const dir = await tempDir('audit-persist-reconfigure-')
  try {
    const log = new AuditLogFile(join(dir, 'provider-audit.jsonl'))
    const service = new ProviderTransportService(ctxWithLogger([]), {
      ...windOptions(),
      credentials: fakeCredentials,
      spawn: windSpawnStub([]),
      auditLog: log,
    })
    const binding = resolveBinding(service, 'financial.stock.snapshot')
    await service.invoke({ binding, input: { windcode: '600519.SH' } })
    service.reconfigure({ ...windOptions(), credentials: fakeCredentials, spawn: windSpawnStub([]), auditLog: log })
    const binding2 = resolveBinding(service, 'financial.stock.snapshot')
    await service.invoke({ binding: binding2, input: { windcode: '000001.SZ' } })
    await log.flush()
    const tail = await log.readTail(10)
    assert.equal(tail.length, 2, 'both invocations (across a registry rebuild) are persisted')
    assert.deepEqual(tail.map(e => e.outcome), ['ok', 'ok'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the persisted log survives a "restart": a fresh writer on the same file re-reads it', async () => {
  const dir = await tempDir('audit-persist-reload-')
  try {
    const path = join(dir, 'provider-audit.jsonl')
    const log = new AuditLogFile(path)
    const service = new ProviderTransportService(ctxWithLogger([]), {
      ...windOptions(),
      credentials: fakeCredentials,
      spawn: windSpawnStub([]),
      auditLog: log,
    })
    const binding = resolveBinding(service, 'financial.stock.snapshot')
    await service.invoke({ binding, input: { windcode: '600519.SH' } })
    await log.flush()
    // A new process would start with an empty in-memory audit; the file is
    // the cross-restart memory.
    const fresh = new AuditLogFile(path)
    const tail = await fresh.readTail(10)
    assert.equal(tail.length, 1)
    assert.equal(tail[0].providerId, 'wind')
    assert.equal(tail[0].outcome, 'ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('secret scan: the serialized JSONL never contains credential material', async () => {
  const dir = await tempDir('audit-persist-leak-')
  try {
    const log = new AuditLogFile(join(dir, 'provider-audit.jsonl'))
    const service = new ProviderTransportService(ctxWithLogger([]), {
      ...windOptions(),
      credentials: fakeCredentials,
      spawn: windSpawnStub([]),
      auditLog: log,
    })
    const binding = resolveBinding(service, 'financial.stock.snapshot')
    await service.invoke({ binding, input: { windcode: '600519.SH' } })
    await log.flush()
    const serialized = await readFile(join(dir, 'provider-audit.jsonl'), 'utf8')
    assert.equal(serialized.includes(FAKE_SECRET), false, 'the credential value must never be persisted')
    for (const key of ['WIND_API_KEY', 'Authorization', 'Bearer', 'X-Api-Key', 'password', 'secret', 'apiKey', 'token']) {
      assert.equal(serialized.includes(key), false, `leaked sentinel key: ${key}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
