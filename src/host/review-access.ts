/** Short-lived, session-scoped bearer access for the standalone review page.
 * Only hashes are persisted. The link secret can be exchanged up to ten times for independent
 * HttpOnly cookies; neither secret is placed in an HTTP URL or audit record.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTeamLock } from '../state.ts'

const TTL_MS = 24 * 60 * 60 * 1000
const ID_PATTERN = /^[a-f0-9]{24}$/u
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export interface ReviewAccessRecord {
  readonly version: 1
  readonly id: string
  readonly captainSessionId: string
  readonly planId?: string
  readonly teamId?: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly linkDigest?: string
  readonly cookieDigest?: string
  readonly maxExchanges?: number
  readonly cookieDigests?: readonly string[]
  readonly revokedAt?: number
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function secret(): string { return randomBytes(32).toString('base64url') }
function equalDigest(first: string | undefined, second: string): boolean {
  if (first === undefined || !/^[a-f0-9]{64}$/u.test(first)) return false
  return timingSafeEqual(Buffer.from(first, 'hex'), Buffer.from(digest(second), 'hex'))
}
function directory(stateRoot: string): string { return join(stateRoot, 'review-access') }
function file(stateRoot: string, id: string): string { return join(directory(stateRoot), `${id}.json`) }
function lockKey(stateRoot: string, id: string): string { return `team:${stateRoot}:review-access-${id}` }
function parseBearer(value: string, prefix: 'rvl' | 'rvs'): { id: string; value: string } | undefined {
  const match = new RegExp(`^${prefix}_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$`, 'u').exec(value)
  return match !== null && ID_PATTERN.test(match[1]!) && SECRET_PATTERN.test(match[2]!) ? { id: match[1]!, value: match[2]! } : undefined
}
function validRecord(value: unknown, id: string): value is ReviewAccessRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.version === 1 && row.id === id && typeof row.captainSessionId === 'string'
    && row.captainSessionId.length > 0 && row.captainSessionId.length <= 256
    && (row.planId === undefined || typeof row.planId === 'string')
    && (row.teamId === undefined || typeof row.teamId === 'string')
    && Number.isSafeInteger(row.createdAt) && Number.isSafeInteger(row.expiresAt)
    && (row.linkDigest === undefined || typeof row.linkDigest === 'string')
    && (row.cookieDigest === undefined || typeof row.cookieDigest === 'string')
    && (row.maxExchanges === undefined || Number.isSafeInteger(row.maxExchanges) && (row.maxExchanges as number) >= 1 && (row.maxExchanges as number) <= 10)
    && (row.cookieDigests === undefined || Array.isArray(row.cookieDigests) && row.cookieDigests.length <= 10 && row.cookieDigests.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)))
    && (row.revokedAt === undefined || Number.isSafeInteger(row.revokedAt))
}
async function read(stateRoot: string, id: string): Promise<ReviewAccessRecord | undefined> {
  if (!ID_PATTERN.test(id)) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(file(stateRoot, id), 'utf8'))
    return validRecord(parsed, id) ? parsed : undefined
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}
async function save(stateRoot: string, record: ReviewAccessRecord): Promise<void> {
  await mkdir(directory(stateRoot), { recursive: true, mode: 0o700 })
  const temporary = join(directory(stateRoot), `.${record.id}.${randomBytes(8).toString('hex')}.tmp`)
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file(stateRoot, record.id))
}
function active(record: ReviewAccessRecord, now: number): boolean {
  return record.revokedAt === undefined && record.expiresAt > now
}
async function find(roots: readonly string[], id: string): Promise<{ stateRoot: string; record: ReviewAccessRecord } | undefined> {
  const found = (await Promise.all(roots.map(async stateRoot => {
    const record = await read(stateRoot, id)
    return record === undefined ? undefined : { stateRoot, record }
  }))).filter((row): row is { stateRoot: string; record: ReviewAccessRecord } => row !== undefined)
  return found.length === 1 ? found[0] : undefined
}

export async function issueReviewAccess(stateRoot: string, target: Pick<ReviewAccessRecord, 'captainSessionId' | 'planId' | 'teamId'>, now = Date.now()): Promise<{ token: string; id: string; expiresAt: number }> {
  if (target.planId === undefined && target.teamId === undefined) throw new Error('REVIEW_TARGET_REQUIRED')
  const id = randomBytes(12).toString('hex')
  const value = secret()
  const record: ReviewAccessRecord = { version: 1, id, ...target, createdAt: now, expiresAt: now + TTL_MS, linkDigest: digest(value), maxExchanges: 10, cookieDigests: [] }
  await save(stateRoot, record)
  return { token: `rvl_${id}_${value}`, id, expiresAt: record.expiresAt }
}

/** Exchange limits are checked under a cross-worker lock; old records retain their original one-use limit. */
export async function exchangeReviewAccess(roots: readonly string[], token: string, now = Date.now()): Promise<{ cookie: string; record: ReviewAccessRecord } | undefined> {
  const presented = parseBearer(token, 'rvl')
  if (presented === undefined) return undefined
  const match = await find(roots, presented.id)
  if (match === undefined) return undefined
  return withTeamLock(lockKey(match.stateRoot, presented.id), async () => {
    const current = await read(match.stateRoot, presented.id)
    if (current === undefined || !active(current, now) || !equalDigest(current.linkDigest, presented.value)) return undefined
    const cookies = [...(current.cookieDigests ?? []), ...(current.cookieDigest === undefined ? [] : [current.cookieDigest])]
    const limit = current.maxExchanges ?? 1
    if (cookies.length >= limit) return undefined
    const value = secret()
    cookies.push(digest(value))
    const updated: ReviewAccessRecord = { ...current, linkDigest: cookies.length >= limit ? undefined : current.linkDigest,
      cookieDigest: undefined, cookieDigests: cookies }
    await save(match.stateRoot, updated)
    return { cookie: `rvs_${presented.id}_${value}`, record: updated }
  })
}

export async function verifyReviewAccess(roots: readonly string[], cookie: string | undefined, now = Date.now()): Promise<{ stateRoot: string; record: ReviewAccessRecord } | undefined> {
  const presented = cookie === undefined ? undefined : parseBearer(cookie, 'rvs')
  if (presented === undefined) return undefined
  const match = await find(roots, presented.id)
  if (match === undefined || !active(match.record, now) || ![...(match.record.cookieDigests ?? []), ...(match.record.cookieDigest === undefined ? [] : [match.record.cookieDigest])].some(value => equalDigest(value, presented.value))) return undefined
  return match
}

export async function revokeReviewAccess(stateRoot: string, id: string, now = Date.now()): Promise<void> {
  if (!ID_PATTERN.test(id)) return
  await withTeamLock(lockKey(stateRoot, id), async () => {
    const current = await read(stateRoot, id)
    if (current !== undefined && current.revokedAt === undefined) await save(stateRoot, { ...current, revokedAt: now })
  })
}

export async function revokeSessionReviewAccess(stateRoot: string, captainSessionId: string, now = Date.now()): Promise<number> {
  let names: string[]
  try { names = await readdir(directory(stateRoot)) } catch { return 0 }
  let count = 0
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : ''
    if (!ID_PATTERN.test(id)) continue
    const record = await read(stateRoot, id)
    if (record?.captainSessionId === captainSessionId && active(record, now)) { await revokeReviewAccess(stateRoot, id, now); count += 1 }
  }
  return count
}
