/** Real PostgreSQL fixture. Never use a production connection URL. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout } from 'node:timers/promises'
import { createDatabase } from '../../dist/database.js'

const exec = promisify(execFile)
const image = 'postgres@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995'

export async function createDatabaseFixture(label = 'integration') {
  let connectionString = process.env.PACK_CENTER_TEST_DATABASE_URL
  let container
  const marker = `pack-center-${label}-${randomUUID()}`
  const databases = new Set()
  async function close() {
    for (const db of databases) {
      try { await db.query(`DROP SCHEMA "${db.schema}" CASCADE`) } finally { await db.close(); databases.delete(db) }
    }
    if (container) {
      const actual = await exec('docker', ['inspect', '--format', '{{ index .Config.Labels "dsh.pack-center.test" }}', container])
      assert.equal(actual.stdout.trim(), marker)
      await exec('docker', ['rm', '--force', '--volumes', container])
      process.stdout.write(`# Removed owned test container and anonymous volume: ${container}\n`)
      container = undefined
    }
  }
  try {
    if (!connectionString) {
      const password = randomBytes(32).toString('hex')
      const result = await exec('docker', ['run', '--detach', '--name', marker, '--label', `dsh.pack-center.test=${marker}`,
        '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB=pack_center_test', image],
      { env: { ...process.env, POSTGRES_PASSWORD: password }, timeout: 60000 })
      container = result.stdout.trim()
      assert.match(container, /^[a-f0-9]{64}$/)
      const inspect = await exec('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container])
      const port = inspect.stdout.trim()
      assert.match(port, /^[0-9]+$/)
      connectionString = `postgresql://postgres:${password}@127.0.0.1:${port}/pack_center_test`
      process.stdout.write(`# Isolated ${label} PostgreSQL container: ${container}\n`)
    }
    const ready = createDatabase({ connectionString, schema: `pc_ready_${randomBytes(8).toString('hex')}` })
    try {
      let connected = false
      for (let attempt = 0; attempt < 60; attempt++) {
        try { await ready.query('SELECT 1'); connected = true; break } catch { await setTimeout(250) }
      }
      assert.equal(connected, true, 'Real PostgreSQL must be available; no mock fallback')
    } finally { await ready.close() }
    return {
      close,
      async database(t, options = {}) {
        const db = createDatabase({ connectionString, schema: `pc_test_${randomBytes(10).toString('hex')}`, maxConnections: 10 })
        databases.add(db)
        t?.after(async () => {
          if (!databases.has(db)) return
          try { await db.query(`DROP SCHEMA "${db.schema}" CASCADE`) } finally { await db.close(); databases.delete(db) }
        })
        if (options.migrate !== false) await db.migrate()
        return db
      },
    }
  } catch (error) { await close(); throw error }
}
