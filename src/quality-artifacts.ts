/** Recheck reviewed artifacts against the bytes that are present at admission. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { QualityRunError, type QualityRun } from './quality-run.ts'

export interface ReviewedArtifactsInput {
  readonly stateRoot: string
  /** A candidate review may supply its newly collected latestEvidence here. */
  readonly run: Pick<QualityRun, 'latestEvidence'>
  /** Trusted Host output path relative to stateRoot, not a caller-supplied alias. */
  readonly taskOutputPath?: string
}

function fail(code: string, message: string, path?: string): never {
  throw new QualityRunError(code, message, path === undefined ? undefined : { path })
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function normalizedPath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/')
  if (normalized === '' || isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)
    || normalized.includes('\0') || parts.some(part => part === '' || part === '.' || part === '..')) {
    fail('path_out_of_scope', `unsafe reviewed artifact path: ${path}`, path)
  }
  return normalized
}

/**
 * The Host task-output JSON is a mutable status/summary envelope. Its legacy
 * output binding is checked by the tools adapter; it is excluded here only
 * when BOTH its reserved id and its trusted conventional path match.
 *
 * This is an admission-time observation, not an OS-level file freeze. The
 * caller must perform it at review, integration and completion, under its
 * state lock, and must not claim it prevents later external writes.
 */
export async function assertReviewedArtifactsCurrent(input: ReviewedArtifactsInput): Promise<void> {
  const evidence = input.run.latestEvidence
  if (evidence === undefined) fail('evidence_missing', 'reviewed artifact evidence is required')
  let root: string
  try {
    root = await realpath(resolve(input.stateRoot))
    if (!(await stat(root)).isDirectory()) fail('workspace_invalid', 'quality stateRoot must be a directory')
  } catch (error) {
    if (error instanceof QualityRunError) throw error
    fail('workspace_invalid', 'quality stateRoot cannot be read')
  }
  const taskOutputPath = input.taskOutputPath === undefined ? undefined : normalizedPath(input.taskOutputPath)
  for (const artifact of evidence.artifacts) {
    const path = normalizedPath(artifact.path)
    const candidate = resolve(root, path)
    if (!inside(root, candidate)) fail('path_out_of_scope', `reviewed artifact escapes stateRoot: ${path}`, path)
    let resolved: string
    try {
      resolved = await realpath(candidate)
    } catch {
      fail('artifact_missing', `reviewed artifact is missing or unreadable: ${path}`, path)
    }
    if (!inside(root, resolved)) fail('path_out_of_scope', `reviewed artifact symlink escapes stateRoot: ${path}`, path)
    let handle
    try {
      // Resolve parent links within the root, then refuse a last-component
      // symlink swap between realpath and open.
      handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
      const before = await handle.stat()
      if (!before.isFile()) fail('artifact_invalid', `reviewed artifact is not a regular file: ${path}`, path)
      const bytes = await handle.readFile()
      const after = await handle.stat()
      const currentPath = await realpath(candidate)
      if (!inside(root, currentPath)) fail('path_out_of_scope', `reviewed artifact symlink escapes stateRoot: ${path}`, path)
      const current = await stat(currentPath)
      if (currentPath !== resolved || before.dev !== current.dev || before.ino !== current.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) {
        fail('artifact_changed', `reviewed artifact changed while being checked: ${path}; collect fresh evidence`, path)
      }
      if (artifact.id === 'task-output' && path === taskOutputPath) continue
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual !== artifact.sha256) {
        fail('artifact_changed', `reviewed artifact changed since review: ${path}; reopen and review the current deliverable`, path)
      }
    } catch (error) {
      if (error instanceof QualityRunError) throw error
      fail('artifact_missing', `reviewed artifact is missing or unreadable: ${path}`, path)
    } finally {
      await handle?.close()
    }
  }
}
