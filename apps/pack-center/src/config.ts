/** Configuration contains database connection material; never log the returned object. */
export interface DatabaseConfig {
  connectionString: string
  schema?: string
  maxConnections?: number
  applicationName?: string
}

export interface CenterConfig {
  centerId: string
  publicOrigin: string
  listenHost: string
  listenPort: number
  database: DatabaseConfig
}

export function databaseSchema(value = 'pack_center'): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value) || value.startsWith('pg_') || value === 'public') {
    throw new Error('PACK_CENTER_DATABASE_SCHEMA must be a dedicated lowercase SQL identifier')
  }
  return value
}

function integer(value: string | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new Error(`${name} must be an integer from 1 through ${max}`)
  }
  return Number(value)
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CenterConfig {
  const connectionString = env.PACK_CENTER_DATABASE_URL
  if (!connectionString) throw new Error('PACK_CENTER_DATABASE_URL is required')
  let databaseUrl: URL
  try { databaseUrl = new URL(connectionString) } catch { throw new Error('PACK_CENTER_DATABASE_URL is invalid') }
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol) || !databaseUrl.hostname || !databaseUrl.pathname.slice(1)) {
    throw new Error('PACK_CENTER_DATABASE_URL must identify a PostgreSQL database')
  }
  const centerId = env.PACK_CENTER_ID
  if (!centerId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(centerId) || centerId.includes('..')) {
    throw new Error('PACK_CENTER_ID is required and must be a safe identifier')
  }
  let publicUrl: URL
  try { publicUrl = new URL(env.PACK_CENTER_PUBLIC_ORIGIN ?? '') } catch { throw new Error('PACK_CENTER_PUBLIC_ORIGIN is required') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/'
    || (publicUrl.protocol !== 'https:' && !(local && publicUrl.protocol === 'http:'))) {
    throw new Error('PACK_CENTER_PUBLIC_ORIGIN must be an HTTPS origin (HTTP is allowed only for loopback tests)')
  }
  return {
    centerId, publicOrigin: publicUrl.origin,
    listenHost: env.PACK_CENTER_LISTEN_HOST ?? '127.0.0.1',
    listenPort: integer(env.PACK_CENTER_LISTEN_PORT, 4310, 65535, 'PACK_CENTER_LISTEN_PORT'),
    database: {
      connectionString,
      schema: databaseSchema(env.PACK_CENTER_DATABASE_SCHEMA),
      maxConnections: integer(env.PACK_CENTER_DATABASE_POOL_SIZE, 10, 100, 'PACK_CENTER_DATABASE_POOL_SIZE'),
      applicationName: 'dsh-pack-center',
    },
  }
}
