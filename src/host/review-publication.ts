/** Publish one Host-verified review document as immutable, anonymous /render bytes. */
import { createHash, randomBytes } from 'node:crypto'
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const EXTENSIONS = new Set(['html', 'pdf', 'md', 'txt', 'json', 'csv', 'png', 'jpg', 'jpeg', 'webp', 'docx', 'xlsx', 'pptx'])

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function bytesOf(document: { content: string; encoding?: string }): Buffer {
  return Buffer.from(document.content, document.encoding === 'base64' ? 'base64' : 'utf8')
}

export async function publishReviewDocument(
  publicRoot: string,
  scope: { captainSessionId: string; teamId: string; taskId: string; artifactId: string },
  document: { name: string; content: string; encoding?: string },
): Promise<{ path: string; sha256: string }> {
  const bytes = bytesOf(document)
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw Error('DOCUMENT_PUBLICATION_SIZE_INVALID')
  const extension = document.name.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? 'bin'
  const safeExtension = EXTENSIONS.has(extension) ? extension : 'bin'
  const teamKey = sha256(`${scope.captainSessionId}\0${scope.teamId}`).slice(0, 20)
  const documentKey = sha256(`${scope.taskId}\0${scope.artifactId}`).slice(0, 16)
  const contentHash = sha256(bytes)
  const filename = `${documentKey}-${contentHash}.${safeExtension}`
  const directory = join(publicRoot, 'expert-library', teamKey)
  const destination = join(directory, filename)
  await mkdir(directory, { recursive: true, mode: 0o755 })
  const temporary = join(directory, `.${randomBytes(12).toString('hex')}.tmp`)
  await writeFile(temporary, bytes, { mode: 0o644, flag: 'wx' })
  try {
    try { await link(temporary, destination) }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
      if (sha256(await readFile(destination)) !== contentHash) throw Error('DOCUMENT_PUBLICATION_CONFLICT')
    }
  } finally { await unlink(temporary).catch(() => undefined) }
  return { path: `/render/expert-library/${teamKey}/${filename}`, sha256: contentHash }
}
