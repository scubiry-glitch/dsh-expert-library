import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'
import { canonicalJson, sha256 } from '../../../packages/pack-contract/index.mjs'
import { databaseSchema, loadConfig, type DatabaseConfig } from './config.js'

export class DatabaseError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'DatabaseError'; this.code = code }
}
export type JobKind = 'validate_submission' | 'publish_release'
export type JsonObject = Record<string, unknown>
export interface EnqueueJobInput {
  kind: JobKind
  idempotencyKey: string
  payload: JsonObject
  maxAttempts?: number
}
export interface Job {
  id: string
  kind: JobKind
  idempotencyKey: string
  payload: JsonObject
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  attempt: number
  maxAttempts: number
  result: unknown
  errorCode: string | null
}
export interface JobLease extends Job {
  status: 'running'
  leaseOwner: string
  leaseToken: string
  leaseExpiresAt: Date
}
export interface LeaseIdentity { id: string; leaseOwner: string; leaseToken: string }
interface JobRow extends QueryResultRow {
  id: string; kind: JobKind; idempotency_key: string; payload: JsonObject
  status: Job['status']; attempt: number; max_attempts: number; result: unknown; error_code: string | null
  request_sha256: string; lease_owner: string; lease_token: string; lease_expires_at: Date
}
const jobKinds: readonly JobKind[] = ['validate_submission', 'publish_release']
const defaultMigrations = fileURLToPath(new URL('../migrations', import.meta.url))

function checkedString(value: string, name: string, max = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DatabaseError('INVALID_INPUT', `${name} is invalid`)
  }
  return value
}
function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DatabaseError('INVALID_INPUT', `${name} is invalid`)
  return value
}
function jsonObject(value: JsonObject): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DatabaseError('INVALID_INPUT', 'Expected a JSON object')
  return canonicalJson(value)
}
function jobOf(row: JobRow): Job {
  return { id: row.id, kind: row.kind, idempotencyKey: row.idempotency_key, payload: row.payload,
    status: row.status, attempt: row.attempt, maxAttempts: row.max_attempts, result: row.result, errorCode: row.error_code }
}
function leaseOf(row: JobRow): JobLease {
  return { ...jobOf(row), status: 'running', leaseOwner: row.lease_owner, leaseToken: row.lease_token, leaseExpiresAt: row.lease_expires_at }
}

/** Enqueue in the caller's business transaction so state changes cannot lose their job. */
export async function enqueueJob(client: PoolClient, input: EnqueueJobInput): Promise<{ job: Job; replayed: boolean }> {
  if (!jobKinds.includes(input.kind)) throw new DatabaseError('INVALID_INPUT', 'Unknown job kind')
  checkedString(input.idempotencyKey, 'idempotencyKey')
  const maxAttempts = integer(input.maxAttempts ?? 3, 1, 20, 'maxAttempts')
  const payload = jsonObject(input.payload)
  const fingerprint = sha256(canonicalJson({ kind: input.kind, payload: input.payload, maxAttempts }))
  const inserted = await client.query<JobRow>(`INSERT INTO jobs
    (id,kind,idempotency_key,request_sha256,payload,max_attempts) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
    ON CONFLICT (kind,idempotency_key) DO NOTHING RETURNING *`, [randomUUID(), input.kind, input.idempotencyKey, fingerprint, payload, maxAttempts])
  if (inserted.rows[0]) return { job: jobOf(inserted.rows[0]), replayed: false }
  const existing = (await client.query<JobRow>('SELECT * FROM jobs WHERE kind=$1 AND idempotency_key=$2', [input.kind, input.idempotencyKey])).rows[0]
  if (!existing || existing.request_sha256 !== fingerprint) throw new DatabaseError('IDEMPOTENCY_CONFLICT', 'The same job key cannot identify different work')
  return { job: jobOf(existing), replayed: true }
}

export function createDatabase(config: DatabaseConfig) {
  const schema = databaseSchema(config.schema)
  let connectionUrl: URL
  try { connectionUrl = new URL(config.connectionString) } catch { throw new DatabaseError('INVALID_INPUT', 'A PostgreSQL connection URL is required') }
  if (!['postgres:', 'postgresql:'].includes(connectionUrl.protocol)) throw new DatabaseError('INVALID_INPUT', 'A PostgreSQL connection URL is required')
  // pg parses URL fields after config fields. Set startup options on the URL itself,
  // otherwise a URL's options= query could silently override the dedicated schema.
  connectionUrl.searchParams.set('options', `-c search_path=${schema},pg_catalog -c timezone=UTC`)
  const pool = new Pool({
    connectionString: connectionUrl.href,
    max: integer(config.maxConnections ?? 10, 1, 100, 'maxConnections'),
    application_name: config.applicationName ?? 'dsh-pack-center',
    options: `-c search_path=${schema},pg_catalog -c timezone=UTC`,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  })
  // Idle errors must not become unhandled events or leak the connection string.
  let lastIdleError: string | undefined
  pool.on('error', error => { lastIdleError = 'code' in error ? String(error.code) : 'DATABASE_CONNECTION_ERROR' })

  async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    let discard: Error | undefined
    try {
      await client.query('BEGIN')
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch (rollbackError) { discard = rollbackError instanceof Error ? rollbackError : new Error('Rollback failed') }
      throw error
    } finally { client.release(discard) }
  }

  async function migrate(directory = defaultMigrations): Promise<readonly string[]> {
    const names = (await readdir(directory)).filter(name => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name)).sort()
    if (names.length === 0) throw new DatabaseError('MIGRATIONS_MISSING', 'No migration files were found')
    const migrations = await Promise.all(names.map(async name => {
      const sql = await readFile(join(directory, name), 'utf8')
      return { name, sql, digest: sha256(sql) }
    }))
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext(current_database()),hashtext($1))', [`pack-center-migrate:${schema}`])
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`)
      await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`)
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())')
      const applied = await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations ORDER BY name')
      for (const row of applied.rows) {
        if (!migrations.some(item => item.name === row.name && item.digest === row.sha256)) {
          throw new DatabaseError('MIGRATION_MISMATCH', `Applied migration ${row.name} is missing or has changed`)
        }
      }
      const completed = new Set(applied.rows.map(row => row.name))
      const executed: string[] = []
      for (const migration of migrations) {
        if (completed.has(migration.name)) continue
        if (applied.rows.some(row => row.name > migration.name)) throw new DatabaseError('MIGRATION_ORDER', 'Cannot insert a migration before an applied migration')
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations(name,sha256) VALUES ($1,$2)', [migration.name, migration.digest])
        executed.push(migration.name)
      }
      return executed
    })
  }

  async function claimJob(worker: string, options: { kinds?: readonly JobKind[]; leaseMs?: number } = {}): Promise<JobLease | undefined> {
    checkedString(worker, 'workerId')
    const leaseMs = integer(options.leaseMs ?? 30000, 50, 3600000, 'leaseMs')
    const kinds = options.kinds ?? jobKinds
    if (kinds.length === 0 || kinds.some(kind => !jobKinds.includes(kind))) throw new DatabaseError('INVALID_INPUT', 'Job kinds are invalid')
    return transaction(async client => {
      // Last-attempt worker crashes must not leave jobs permanently "running".
      const exhausted = await client.query<JobRow>(`WITH expired AS (
        SELECT id FROM jobs WHERE kind=ANY($1::text[]) AND status='running' AND lease_expires_at<=clock_timestamp() AND attempt>=max_attempts
        ORDER BY lease_expires_at FOR UPDATE SKIP LOCKED LIMIT 100
      ) UPDATE jobs SET status='failed',error_code='LEASE_EXPIRED',error_message='Worker lease expired after its final attempt',
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE id IN (SELECT id FROM expired) RETURNING *`, [kinds])
      for (const row of exhausted.rows) await client.query(`UPDATE job_attempts SET outcome='lease_expired',error_code='LEASE_EXPIRED',finished_at=clock_timestamp() WHERE job_id=$1 AND attempt=$2 AND outcome='running'`, [row.id, row.attempt])
      const selected = (await client.query<JobRow>(`SELECT * FROM jobs WHERE kind=ANY($1::text[]) AND attempt<max_attempts
        AND ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_expires_at<=clock_timestamp()))
        ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`, [kinds])).rows[0]
      if (!selected) return undefined
      if (selected.status === 'running') await client.query(`UPDATE job_attempts SET outcome='lease_expired',error_code='LEASE_EXPIRED',finished_at=clock_timestamp() WHERE job_id=$1 AND attempt=$2 AND outcome='running'`, [selected.id, selected.attempt])
      const token = randomUUID()
      const leased = (await client.query<JobRow>(`UPDATE jobs SET status='running',attempt=attempt+1,lease_owner=$2,lease_token=$3,
        lease_expires_at=clock_timestamp()+($4::integer * interval '1 millisecond'),updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [selected.id, worker, token, leaseMs])).rows[0]!
      await client.query('INSERT INTO job_attempts(job_id,attempt,lease_token,worker_id) VALUES ($1,$2,$3,$4)', [leased.id, leased.attempt, token, worker])
      return leaseOf(leased)
    })
  }

  async function lockedLease(client: PoolClient, lease: LeaseIdentity): Promise<JobRow> {
    const row = (await client.query<JobRow>(`SELECT * FROM jobs WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3::uuid
      AND lease_expires_at>clock_timestamp() FOR UPDATE`, [lease.id, lease.leaseOwner, lease.leaseToken])).rows[0]
    if (!row) throw new DatabaseError('LEASE_LOST', 'The worker no longer owns a current lease')
    return row
  }

  /** The business writes and successful completion share one fenced DB transaction. */
  async function withJobTransaction<T extends JsonObject>(lease: LeaseIdentity, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return transaction(async client => {
      const row = await lockedLease(client, lease)
      const result = await fn(client)
      const updated = await client.query(`UPDATE jobs SET status='succeeded',result=$4::jsonb,error_code=NULL,error_message=NULL,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3::uuid AND lease_expires_at>clock_timestamp()`,
      [lease.id, lease.leaseOwner, lease.leaseToken, jsonObject(result)])
      if (updated.rowCount !== 1) throw new DatabaseError('LEASE_LOST', 'The lease expired before the transaction committed')
      await client.query(`UPDATE job_attempts SET outcome='succeeded',finished_at=clock_timestamp() WHERE job_id=$1 AND attempt=$2`, [row.id, row.attempt])
      return result
    })
  }

  return {
    pool, schema, transaction, migrate, claimJob, withJobTransaction,
    /** Startup check is read-only; service processes never silently migrate. */
    async verifyMigrations(directory = defaultMigrations): Promise<void> {
      const names = (await readdir(directory)).filter(name => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name)).sort()
      if (!names.length) throw new DatabaseError('MIGRATIONS_MISSING', 'Migration files are unavailable')
      const applied = (await pool.query<{ name: string; sha256: string }>('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows
      if (applied.length !== names.length || applied.some((row, index) => row.name !== names[index])) throw new DatabaseError('MIGRATIONS_PENDING', 'Database migrations must be applied explicitly before startup')
      for (const row of applied) {
        if (sha256(await readFile(join(directory, row.name), 'utf8')) !== row.sha256) throw new DatabaseError('MIGRATION_MISMATCH', 'Migration history does not match deployed files')
      }
    },
    query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<R>> { return pool.query<R>(text, values) },
    async enqueueJob(input: EnqueueJobInput) { return transaction(client => enqueueJob(client, input)) },
    async renewJob(lease: LeaseIdentity, leaseMs = 30000): Promise<JobLease> {
      integer(leaseMs, 50, 3600000, 'leaseMs')
      const row = (await pool.query<JobRow>(`UPDATE jobs SET lease_expires_at=clock_timestamp()+($4::integer * interval '1 millisecond'),updated_at=clock_timestamp()
        WHERE id=$1 AND status='running' AND lease_owner=$2 AND lease_token=$3::uuid AND lease_expires_at>clock_timestamp() RETURNING *`,
      [lease.id, lease.leaseOwner, lease.leaseToken, leaseMs])).rows[0]
      if (!row) throw new DatabaseError('LEASE_LOST', 'An expired lease cannot be renewed')
      return leaseOf(row)
    },
    async completeJob(lease: LeaseIdentity, result: JsonObject = {}) { return withJobTransaction(lease, async () => result) },
    async failJob(lease: LeaseIdentity, error: { code: string; message: string }, options: { retry?: boolean; delayMs?: number } = {}): Promise<Job> {
      checkedString(error.code, 'error.code', 100); checkedString(error.message, 'error.message', 4000)
      const delay = integer(options.delayMs ?? 1000, 0, 86400000, 'delayMs')
      return transaction(async client => {
        const row = await lockedLease(client, lease)
        const retry = options.retry === true && row.attempt < row.max_attempts
        const updated = (await client.query<JobRow>(`UPDATE jobs SET status=$4,error_code=$5,error_message=$6,
          available_at=clock_timestamp()+($7::integer * interval '1 millisecond'),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND lease_owner=$2 AND lease_token=$3::uuid AND lease_expires_at>clock_timestamp() RETURNING *`,
        [lease.id, lease.leaseOwner, lease.leaseToken, retry ? 'queued' : 'failed', error.code, error.message, delay])).rows[0]
        if (!updated) throw new DatabaseError('LEASE_LOST', 'The lease expired before failure was recorded')
        await client.query(`UPDATE job_attempts SET outcome='failed',error_code=$3,finished_at=clock_timestamp() WHERE job_id=$1 AND attempt=$2`, [row.id, row.attempt, error.code])
        return jobOf(updated)
      })
    },
    async health() { await pool.query('SELECT 1'); return { ok: true, ...(lastIdleError ? { lastIdleError } : {}) } },
    async close() { await pool.end() },
  }
}

export type CenterDatabase = ReturnType<typeof createDatabase>

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'migrate') throw new Error('Usage: node dist/database.js migrate')
  const db = createDatabase(loadConfig().database)
  try { process.stdout.write(JSON.stringify({ applied: await db.migrate() }) + '\n') }
  catch (error) { process.stderr.write(`Migration failed (${error instanceof DatabaseError ? error.code : 'DATABASE_ERROR'}).\n`); process.exitCode = 1 }
  finally { await db.close() }
}
