/**
 * localdb provider tests — flexible local SQLite registration.
 *
 * Covers:
 * - resolveProviderServiceOptions: config databases + LOCALDB_DATABASES env +
 *   scanDirs discovery; invalid ids / missing files skipped (fail-closed);
 *   empty result ⇒ localdb option absent (provider not registered);
 * - ProviderTransportService with localdb: manifest capabilities bind, the
 *   real python3 runner executes query/schema end-to-end against a temp
 *   SQLite file, write/DDL SQL is rejected, unknown db fails closed;
 * - dynamic datasets: resolveLocalDbDataset / applyDatasetRequest admit only
 *   registered localdb.<id>.{query,schema} and require input.sql on query.
 *
 * The only real child process is `python3 assets/localdb_runner.py` on a
 * throwaway temp database — no network, no live credentials.
 *
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ProviderTransportService, resolveProviderServiceOptions } from '../lib/host/provider-service.js'
import { applyDatasetRequest } from '../lib/host/provider-tool.js'
import { resolveLocalDbDataset } from '../lib/host/dataset-registry.js'
import { buildLocalDbManifest, localDbCallPlan, normalizeLocalDbCliOutput, caliberOf } from '../lib/v2/providers/localdb.js'

const minimalCtx = { get: () => undefined }
let workspace

test.before(() => {
  workspace = mkdtempSync(join(tmpdir(), 'localdb-test-'))
  execFileSync('python3', ['-c', `
import sqlite3
c = sqlite3.connect(${JSON.stringify(join(workspace, 'demo.db'))})
c.execute('CREATE TABLE branches (city TEXT, deposit REAL)')
c.executemany('INSERT INTO branches VALUES (?,?)', [('南京', 120.5), ('苏州', 88.0)])
c.commit()`])
})

test.after(() => {
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true })
})

const DEMO_DB = () => join(workspace, 'demo.db')
const RUNNER = new URL('../assets/localdb_runner.py', import.meta.url).pathname

/* ---------------------------------------------------------------------------
 * Option resolution (config / env / scanDirs / fail-closed)
 * ------------------------------------------------------------------------- */

test('resolveProviderServiceOptions registers a valid configured database', () => {
  const options = resolveProviderServiceOptions({
    providers: { localdb: { databases: [{ id: 'demo', path: DEMO_DB(), caliber: '测试口径' }] } },
  })
  assert.equal(options.localdb.databases.length, 1)
  assert.equal(options.localdb.databases[0].id, 'demo')
  assert.equal(options.localdb.databases[0].path, DEMO_DB())
  assert.equal(options.localdb.runnerPath, RUNNER)
})

test('invalid ids and missing files are skipped (fail-closed), dedupe by id', () => {
  const options = resolveProviderServiceOptions({
    providers: {
      localdb: {
        databases: [
          { id: 'Bad_Id', path: DEMO_DB() },
          { id: 'ghost', path: join(workspace, 'nope.db') },
          { id: 'demo', path: DEMO_DB() },
        ],
      },
    },
  })
  assert.deepEqual(options.localdb.databases.map(db => db.id), ['demo'])
})

test('no databases ⇒ localdb option absent ⇒ provider not registered', () => {
  const options = resolveProviderServiceOptions({ providers: { localdb: { databases: [{ id: 'ghost', path: '/nope/x.db' }] } } })
  assert.equal(options.localdb, undefined)
  const service = new ProviderTransportService(minimalCtx, options)
  assert.ok(!service.providers.includes('localdb'))
})

test('scanDirs discovers sqlite files with sanitized ids', () => {
  const dir = join(workspace, 'scan')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'My Bank.DB'), 'x')
  writeFileSync(join(dir, '.hidden.db'), 'x')
  writeFileSync(join(dir, 'notes.txt'), 'x')
  const options = resolveProviderServiceOptions({ providers: { localdb: { scanDirs: [dir] } } })
  assert.deepEqual(options.localdb.databases.map(db => db.id), ['my-bank'])
})

/* ---------------------------------------------------------------------------
 * Service end-to-end through the real runner
 * ------------------------------------------------------------------------- */

function localDbService() {
  return new ProviderTransportService(minimalCtx, {
    localdb: {
      databases: [{ id: 'demo', path: DEMO_DB(), sensitivity: 'internal' }],
      runnerPath: RUNNER,
    },
  })
}

function resolveBinding(service, capability) {
  const result = service.resolver.resolve({ capability, constraints: {} })
  assert.equal(result.status, 'bound', `capability ${capability} must bind: ${JSON.stringify(result.rejections)}`)
  return result.binding
}

test('localdb registers with schema+query capabilities per database', () => {
  const service = localDbService()
  assert.deepEqual([...service.providers], ['localdb'])
  resolveBinding(service, 'localdb.demo.schema')
  resolveBinding(service, 'localdb.demo.query')
  assert.equal(service.resolver.resolve({ capability: 'localdb.other.query' }).status, 'unavailable')
})

test('query end-to-end: rows + provenance source/caliber + sensitivity caveat', async () => {
  const service = localDbService()
  const binding = resolveBinding(service, 'localdb.demo.query')
  const envelope = await service.invoke({ binding, input: { sql: 'SELECT city, deposit FROM branches ORDER BY deposit DESC' } })
  assert.equal(envelope.ok, true)
  assert.equal(envelope.provenance.provider, 'localdb')
  assert.equal(envelope.provenance.source, DEMO_DB())
  assert.ok(envelope.provenance.caliber.includes('勿外发'), 'internal databases must carry the 勿外发 caliber')
  assert.deepEqual(envelope.data.rows[0], ['南京', 120.5])
})

test('schema end-to-end lists tables with row counts', async () => {
  const service = localDbService()
  const binding = resolveBinding(service, 'localdb.demo.schema')
  const envelope = await service.invoke({ binding, input: {} })
  assert.equal(envelope.ok, true)
  const table = envelope.data.tables.find(t => t.name === 'branches')
  assert.equal(table.row_count, 2)
})

test('write/DDL SQL is rejected; unknown database fails closed', async () => {
  const service = localDbService()
  const query = resolveBinding(service, 'localdb.demo.query')
  const write = await service.invoke({ binding: query, input: { sql: 'DELETE FROM branches' } })
  assert.equal(write.ok, false)
  assert.equal(write.error.code, 'SQL_READ_ONLY')
})

test('query without sql fails with a plan error (correct-input)', async () => {
  const service = localDbService()
  const binding = resolveBinding(service, 'localdb.demo.query')
  const envelope = await service.invoke({ binding, input: {} })
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error.code, 'PLAN_ERROR')
})

/* ---------------------------------------------------------------------------
 * Pure unit: call plan + normalizer
 * ------------------------------------------------------------------------- */

test('localDbCallPlan embeds db path, mode and caliber in one argv JSON', () => {
  const plan = localDbCallPlan({ id: 'demo', path: '/data/demo.db', caliber: '口径X' }, 'localdb.demo.query', { sql: 'SELECT 1', limit: 5 })
  const request = JSON.parse(plan.args[0])
  assert.equal(request.db, '/data/demo.db')
  assert.equal(request.mode, 'query')
  assert.equal(request.sql, 'SELECT 1')
  assert.equal(request.limit, 5)
  assert.equal(request.caliber, '口径X')
})

test('normalizeLocalDbCliOutput: truncated success warns, non-JSON fails closed', () => {
  const ok = normalizeLocalDbCliOutput(
    { exitCode: 0, stdout: JSON.stringify({ ok: true, provider: { id: 'localdb', version: '1' }, provenance: { source: '/d.db', caliber: 'c', truncated: true, row_count: 100 }, warnings: [], data: { rows: [] }, truncated: true }) },
    { operation: 'localdb.demo.query', transportId: 'sqlite-ro', source: '/d.db', caliber: 'c' },
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.warnings.some(w => w.code === 'localdb.truncated'), true)
  const bad = normalizeLocalDbCliOutput({ exitCode: 0, stdout: 'not json' }, { operation: 'op', transportId: 't', source: '/d.db', caliber: 'c' })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'LOCALDB_INVALID_RUNNER_OUTPUT')
})

test('caliberOf appends 勿外发 for internal databases', () => {
  assert.ok(caliberOf({ id: 'a', path: '/a.db', sensitivity: 'internal' }).includes('勿外发'))
  assert.ok(!caliberOf({ id: 'a', path: '/a.db' }).includes('勿外发'))
  assert.equal(buildLocalDbManifest([{ id: 'a', path: '/a.db' }], { runnerPath: RUNNER }).capabilities.length, 2)
})

/* ---------------------------------------------------------------------------
 * Dynamic datasets
 * ------------------------------------------------------------------------- */

test('resolveLocalDbDataset admits registered ids only and requires sql on query', () => {
  const dbs = [{ id: 'demo', caliber: '测试口径' }]
  const definition = resolveLocalDbDataset('localdb.demo.query', dbs)
  assert.equal(definition.capabilities[0].id, 'localdb.demo.query')
  assert.deepEqual(definition.requiredFields, ['sql'])
  assert.equal(resolveLocalDbDataset('localdb.ghost.query', dbs), undefined)
  assert.equal(resolveLocalDbDataset('localdb.demo.drop', dbs), undefined)
  assert.equal(resolveLocalDbDataset('localdb.demo.query', undefined), undefined)
})

test('applyDatasetRequest substitutes dynamic localdb datasets', () => {
  const gated = applyDatasetRequest(
    { dataset: 'localdb.demo.query', input: { sql: 'SELECT 1' } },
    [{ id: 'demo' }],
  )
  assert.equal(gated.ok, true)
  assert.equal(gated.capability, 'localdb.demo.query')
  assert.equal(gated.dataset.definition.dataset, 'localdb.demo.query')
  const missing = applyDatasetRequest({ dataset: 'localdb.demo.query', input: {} }, [{ id: 'demo' }])
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'CALIBER_MISSING')
  const unknown = applyDatasetRequest({ dataset: 'localdb.ghost.query', input: { sql: 'SELECT 1' } }, [{ id: 'demo' }])
  assert.equal(unknown.ok, false)
  assert.equal(unknown.error.code, 'DATASET_UNKNOWN')
})
