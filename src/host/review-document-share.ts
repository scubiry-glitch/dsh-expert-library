/** A document-only capability. The bearer secret is never stored in plaintext. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const TTL_MS = 7 * 24 * 60 * 60 * 1000
const TOKEN = /^rvd_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/u
const SHA256 = /^[a-f0-9]{64}$/u

export interface ReviewDocumentShareRecord {
  readonly version: 1
  readonly id: string
  readonly captainSessionId: string
  readonly teamId: string
  readonly taskId: string
  readonly artifactId: string
  readonly documentSha256: string
  readonly secretDigest: string
  readonly expiresAt: number
}

function directory(root: string): string { return join(root, 'review-document-shares') }
function file(root: string, id: string): string { return join(directory(root), `${id}.json`) }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function valid(value: unknown, id: string): value is ReviewDocumentShareRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.version === 1 && row.id === id && ['captainSessionId', 'teamId', 'taskId', 'artifactId'].every(key =>
    typeof row[key] === 'string' && (row[key] as string).length > 0 && (row[key] as string).length <= 256)
    && typeof row.documentSha256 === 'string' && SHA256.test(row.documentSha256)
    && typeof row.secretDigest === 'string' && SHA256.test(row.secretDigest)
    && Number.isSafeInteger(row.expiresAt)
}

export function reviewDocumentDigest(document: { content: string; encoding?: string }): string {
  return digest(Buffer.from(document.content, document.encoding === 'base64' ? 'base64' : 'utf8'))
}

export async function issueReviewDocumentShare(root: string, scope: Pick<ReviewDocumentShareRecord, 'captainSessionId' | 'teamId' | 'taskId' | 'artifactId' | 'documentSha256'>, now = Date.now()): Promise<{ token: string; expiresAt: number }> {
  if (!SHA256.test(scope.documentSha256)) throw Error('DOCUMENT_INVALID_DIGEST')
  const id = randomBytes(12).toString('hex')
  const secret = randomBytes(32).toString('base64url')
  const record: ReviewDocumentShareRecord = { version: 1, id, ...scope, secretDigest: digest(secret), expiresAt: now + TTL_MS }
  await mkdir(directory(root), { recursive: true, mode: 0o700 })
  const temporary = join(directory(root), `.${id}.${randomBytes(8).toString('hex')}.tmp`)
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file(root, id))
  return { token: `rvd_${id}_${secret}`, expiresAt: record.expiresAt }
}

export async function verifyReviewDocumentShare(roots: readonly string[], token: string, now = Date.now()): Promise<{ stateRoot: string; record: ReviewDocumentShareRecord } | undefined> {
  const match = TOKEN.exec(token)
  if (!match) return undefined
  const found = (await Promise.all(roots.map(async stateRoot => {
    try {
      const value: unknown = JSON.parse(await readFile(file(stateRoot, match[1]!), 'utf8'))
      return valid(value, match[1]!) ? { stateRoot, record: value } : undefined
    } catch { return undefined }
  }))).filter((row): row is { stateRoot: string; record: ReviewDocumentShareRecord } => row !== undefined)
  if (found.length !== 1 || found[0]!.record.expiresAt <= now) return undefined
  const expected = Buffer.from(found[0]!.record.secretDigest, 'hex')
  const actual = Buffer.from(digest(match[2]!), 'hex')
  return timingSafeEqual(expected, actual) ? found[0] : undefined
}
