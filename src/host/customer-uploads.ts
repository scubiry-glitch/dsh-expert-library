import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const CUSTOMER_UPLOAD_MAX_BYTES = 8 * 1024 * 1024
export const CUSTOMER_UPLOAD_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.txt', '.md', '.csv', '.png', '.jpg', '.jpeg', '.webp'])

export function validCustomerUpload(name: unknown, data: unknown): data is string {
  if (typeof name !== 'string' || !name || name.length > 180 || /[\\/\x00-\x1f\x7f]/u.test(name)) return false
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  return CUSTOMER_UPLOAD_EXTENSIONS.has(extension)
    && typeof data === 'string' && data.length > 0 && data.length <= Math.ceil(CUSTOMER_UPLOAD_MAX_BYTES / 3) * 4
    && data.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
}

export async function saveCustomerUpload(root: string, sessionId: string, name: string, data: string): Promise<{ name: string; path: string; sizeBytes: number }> {
  if (!validCustomerUpload(name, data)) throw new Error('INVALID_ATTACHMENT')
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > CUSTOMER_UPLOAD_MAX_BYTES || bytes.toString('base64') !== data) throw new Error('INVALID_ATTACHMENT')
  const safeName = name.replace(/[^\p{L}\p{N}._-]/gu, '_').replace(/^\.+/u, '_').slice(0, 120)
  const base = await realpath(root)
  const uploadRoot = join(base, 'customer-uploads')
  const directory = join(uploadRoot, sessionId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await realpath(uploadRoot) !== uploadRoot || await realpath(directory) !== directory) throw new Error('INVALID_ATTACHMENT_PATH')
  const filename = `${randomUUID()}-${safeName}`
  const handle = await open(join(directory, filename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(bytes) } finally { await handle.close() }
  return { name, path: `customer-uploads/${sessionId}/${filename}`, sizeBytes: bytes.length }
}

export async function removeCustomerUpload(root: string, sessionId: string, relativePath: string): Promise<void> {
  const parts = typeof relativePath === 'string' ? relativePath.split('/') : []
  if (parts.length !== 3 || parts[0] !== 'customer-uploads' || parts[1] !== sessionId
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[\p{L}\p{N}._-]+$/iu.test(parts[2] ?? ''))
    throw new Error('INVALID_ATTACHMENT')
  const base = await realpath(root)
  const directory = join(base, 'customer-uploads', sessionId)
  if (await realpath(directory) !== directory) throw new Error('INVALID_ATTACHMENT_PATH')
  const file = join(base, relativePath)
  if (!(await lstat(file)).isFile()) throw new Error('INVALID_ATTACHMENT_PATH')
  await unlink(file)
}
