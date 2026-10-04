/** Generic executor for frozen, trusted installed-pack checkers.
 * This is not an OS/network sandbox. Pack code executes with the Host user's
 * permissions; installation is a trust boundary. Reports supply bytes only,
 * never executable paths, commands, environment, or a self-signed receipt.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ArtifactEvidence } from './quality-run.ts'
import type { SkillCraftArtifactCheck, SkillCraftCheckResult, SkillCraftRunnerInput } from './skill-craft-types.ts'
import { isFrozenSkillCraftContract, verifyFrozenSkillCraftContract } from './skill-craft.ts'

export interface SkillCraftRuntimeOptions {
  /** Trusted Host configuration only; never exposed in model-facing schemas. */
  readonly browserExecutablePath?: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}
const INPUT_LIMITS = { md: 2 * 1024 * 1024, html: 2 * 1024 * 1024, pdf: 20 * 1024 * 1024, evidence: 256 * 1024 } as const
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function uniform(ids: readonly string[], status: SkillCraftCheckResult['status'], detail: string): SkillCraftCheckResult[] {
  return ids.map(id => ({ id, status, detail }))
}
function limit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('invalid Host resource limit')
  return value
}
function artifactInput(artifacts: readonly ArtifactEvidence[], id: string, max: number): SkillCraftRunnerInput['artifacts']['md'] {
  const matches = artifacts.filter(item => item.id === id)
  if (matches.length !== 1) throw new Error('artifact binding must resolve exactly once')
  const a = matches[0]!
  if (typeof a.content !== 'string' || a.content.length > max * 2 || (a.encoding !== undefined && a.encoding !== 'utf8' && a.encoding !== 'base64')) throw new Error('artifact encoding/size invalid')
  const bytes = Buffer.from(a.content, a.encoding ?? 'utf8')
  if (bytes.length > max || (a.encoding === 'base64' && bytes.toString('base64') !== a.content) || hash(bytes) !== a.sha256) throw new Error('artifact byte identity mismatch')
  return { id, sha256: a.sha256, content: a.content, encoding: a.encoding ?? 'utf8' }
}
function validResults(value: unknown, ids: readonly string[]): value is SkillCraftCheckResult[] {
  if (!Array.isArray(value) || value.length !== ids.length) return false
  const seen = new Set<string>()
  return value.every(item => {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 3
      || !Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'status') || !Object.hasOwn(item, 'detail')
      || typeof item.id !== 'string' || !ids.includes(item.id) || seen.has(item.id)
      || !['passed', 'failed', 'unverified'].includes(item.status)
      || typeof item.detail !== 'string' || item.detail.trim() === '' || item.detail.length > 16000) return false
    seen.add(item.id); return true
  })
}
async function execute(entry: string, cwd: string, input: SkillCraftRunnerInput, options: SkillCraftRuntimeOptions, timeout: number, maxOutput: number): Promise<SkillCraftCheckResult[]> {
  const ids = input.resultIds
  if (options.signal?.aborted) return uniform(ids, 'unverified', 'Selected-skill check cancelled before execution')
  return new Promise(resolveResult => {
    // Minimal environment intentionally excludes NODE_OPTIONS and credentials.
    const child = spawn(process.execPath, [entry], { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC' } })
    let output = '', outputBytes = 0, stderrBytes = 0, finished = false, failure: string | undefined
    const stop = () => { try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* already exited */ } }
    const abort = () => { failure = 'Selected-skill check cancelled'; stop() }
    const timer = setTimeout(() => { failure = 'Selected-skill check exceeded Host time limit'; stop() }, timeout)
    const finish = (results: SkillCraftCheckResult[]) => {
      if (finished) return
      finished = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); stop(); resolveResult(results)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    child.on('error', () => finish(uniform(ids, 'unverified', 'Selected-skill checker process could not start')))
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { outputBytes += Buffer.byteLength(chunk); if (outputBytes > maxOutput) { failure = 'Selected-skill checker output limit exceeded'; stop() } else output += chunk })
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > maxOutput) { failure = 'Selected-skill checker diagnostic limit exceeded'; stop() } })
    child.on('close', code => {
      if (failure !== undefined) return finish(uniform(ids, 'unverified', failure))
      if (code !== 0) return finish(uniform(ids, 'unverified', 'Selected-skill checker did not exit successfully; diagnostic text withheld'))
      try {
        const value: unknown = JSON.parse(output)
        if (!validResults(value, ids)) return finish(uniform(ids, 'unverified', 'Selected-skill checker results must exactly cover declared IDs, statuses and bounded details'))
        finish(ids.map(id => value.find(item => item.id === id)!))
      } catch { finish(uniform(ids, 'unverified', 'Selected-skill checker returned malformed JSON results')) }
    })
    child.stdin.end(JSON.stringify(input))
  })
}

export async function evaluateSkillCraft(artifacts: readonly ArtifactEvidence[], check: SkillCraftArtifactCheck, options: SkillCraftRuntimeOptions = {}): Promise<SkillCraftCheckResult[]> {
  // Invalid selection has no trustworthy declared result namespace; fail at the
  // contract boundary instead of manufacturing an apparently complete receipt.
  if (check.id !== 'selected-skill-craft-v1' || !isFrozenSkillCraftContract(check.selection)) throw new Error('SKILL_CRAFT_CONTRACT_INVALID')
  const selection = check.selection, ids = selection.checks.flatMap(item => [...item.resultIds])
  let input: SkillCraftRunnerInput, timeout: number, maxOutput: number
  try {
    if (!(['md', 'html', 'pdf', 'evidence'] as const).every(role => selection.artifactRoles.includes(role))) throw new Error('selected skills do not declare all report artifact roles')
    if (new Set([check.md, check.html, check.pdf, check.craftEvidence]).size !== 4) throw new Error('distinct artifact roles required')
    timeout = limit(options.timeoutMs, 45_000, 120_000); maxOutput = limit(options.maxOutputBytes, 512 * 1024, 2 * 1024 * 1024)
    if (options.browserExecutablePath !== undefined && (!isAbsolute(options.browserExecutablePath) || options.browserExecutablePath.includes('\0'))) throw new Error('invalid Host browser path')
    input = { protocolVersion: 1, selections: selection.selections.map(({ packId, skillId, reason, variant }) => ({ packId, skillId, reason, ...(variant === undefined ? {} : { variant }) })), resultIds: [], artifacts: {
      md: artifactInput(artifacts, check.md, INPUT_LIMITS.md), html: artifactInput(artifacts, check.html, INPUT_LIMITS.html), pdf: artifactInput(artifacts, check.pdf, INPUT_LIMITS.pdf), evidence: artifactInput(artifacts, check.craftEvidence, INPUT_LIMITS.evidence),
    }, host: options.browserExecutablePath === undefined ? {} : { browserExecutablePath: options.browserExecutablePath } }
  } catch { return uniform(ids, 'failed', 'Selected-skill input invalid: complete declared md/html/pdf/evidence coverage, distinct artifact roles, exact hashes, bounded bytes and trusted Host options are required') }
  if (options.signal?.aborted) return uniform(ids, 'unverified', 'Selected-skill check cancelled before verification')
  try { verifyFrozenSkillCraftContract(selection) } catch { return uniform(ids, 'unverified', 'Frozen selected-skill package/material/checker integrity could not be verified') }
  const results: SkillCraftCheckResult[] = []
  const deadline = Date.now() + timeout
  for (const declared of selection.checks) {
    try {
      const pack = selection.packs.find(pack => pack.packId === declared.packId)
      if (pack === undefined || isAbsolute(declared.entrypoint) || declared.entrypoint.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || !['.mjs', '.js'].includes(extname(declared.entrypoint))) throw new Error('invalid declared entrypoint')
      const root = await realpath(pack.root), entry = await realpath(resolve(root, declared.entrypoint))
      const info = await stat(entry)
      if (!inside(root, entry) || !info.isFile() || info.size > 4 * 1024 * 1024 || hash(await readFile(entry)) !== declared.sha256) throw new Error('entrypoint identity mismatch')
      const remaining = deadline - Date.now()
      if (remaining <= 0) return uniform(ids, 'unverified', 'Selected-skill checks exceeded the total Host time budget')
      const current = await execute(entry, root, { ...input, resultIds: declared.resultIds }, options, remaining, maxOutput)
      // Entry and whole-pack verification after every execution prevents a drifted
      // installed tree from receiving a successful frozen-identity receipt.
      if (hash(await readFile(entry)) !== declared.sha256) throw new Error('entrypoint changed during execution')
      verifyFrozenSkillCraftContract(selection)
      results.push(...current)
    } catch { return uniform(ids, 'unverified', 'Frozen selected-skill entrypoint/package identity changed or could not be verified; no result from this execution is admitted') }
  }
  return results
}
