/**
 * Runtime boundary for the structured quality contract.
 *
 * `quality-run.ts` contains the deterministic state machine.  This module is
 * deliberately the only place where evidence crosses the filesystem/process
 * boundary: artifacts are read from disk and verification commands are
 * executed here, so a caller cannot manufacture a passing hash or command
 * receipt by submitting arbitrary JSON.
 */

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  AcceptanceResult,
  ArtifactCheckReceipt,
  ArtifactCheckResult,
  ArtifactEvidence,
  CommandResult,
  IndependentReview,
  QualityContract,
  QualityRun,
  TaskEvidence,
} from './quality-run.ts'
import { QualityRunError, REPORT_CRAFT_V2_RESULT_IDS, isQualityRun, qualityContractDigest, validateAcceptanceResults, validateArtifactCheckReceipts, validateEvidencePaths, validateTaskEvidenceIntegrity } from './quality-run.ts'
import { evaluateReportCraft } from './report-craft-checker.ts'
import { evaluateReportCraftV2, REPORT_CRAFT_V2_CHECKER_VERSION } from './report-craft-checker-v2.ts'
import { verifyCraftMaterials } from './report-craft-materials.ts'
import { evaluateSkillCraft } from './skill-craft-runtime.ts'
import type { SkillCraftRuntimeOptions } from './skill-craft-runtime.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_BYTES = 128 * 1024

export interface FilesystemArtifactSpec {
  readonly id: string
  /** Path relative to workspaceRoot; absolute and traversal paths are rejected. */
  readonly path: string
}

export interface CollectTaskEvidenceInput {
  readonly workspaceRoot: string
  readonly contract: QualityContract
  /** Current task/quality generation. Repairs advance this beyond the frozen contract attempt. */
  readonly attempt?: number
  readonly artifacts: readonly FilesystemArtifactSpec[]
  readonly acceptanceResults: readonly AcceptanceResult[]
  /** Reviewer-authored located observations. The tool boundary validates the
   * Host-owned preparation receipt and actual caller session before collection. */
  readonly independentReview?: IndependentReview
  /** Defaults to the artifact paths. Every changed path is checked by contract scope. */
  readonly changedPaths?: readonly string[]
  /** Defaults to contract.verify. Supplied commands must exactly match contract.verify. */
  readonly commands?: readonly string[]
  /** Relative or absolute working directory. It must remain under workspaceRoot. */
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Host configuration only: never populated from tool arguments or report JSON.
   * Material delivery/admission belongs to the team/session boundary, not this
   * filesystem integrity check. Neither field is a caller-supplied receipt. */
  readonly artifactCheckOptions?: SkillCraftRuntimeOptions
}

export interface VerifiedCommandResult extends CommandResult {
  readonly startedAt: number
  readonly finishedAt: number
  readonly timedOut?: boolean
}

function fail(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new QualityRunError(code, message, details)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function cleanRelativePath(path: string): boolean {
  if (!nonEmpty(path) || isAbsolute(path)) return false
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/')
  return !parts.includes('') && !parts.includes('.') && !parts.includes('..')
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function checkedWorkspace(rootInput: string): Promise<string> {
  const root = resolve(rootInput)
  try {
    const info = await stat(root)
    if (!info.isDirectory()) fail('workspace_invalid', `workspaceRoot is not a directory: ${root}`)
    return await realpath(root)
  } catch (error) {
    if (error instanceof QualityRunError) throw error
    fail('workspace_invalid', `workspaceRoot cannot be read: ${root}`)
  }
}

/** Resolve a path while preventing traversal and symlink escapes. */
async function checkedPath(root: string, path: string, mustExist: boolean): Promise<string> {
  if (!cleanRelativePath(path)) fail('path_out_of_scope', `unsafe filesystem path: ${path}`)
  const candidate = resolve(root, path)
  if (!inside(root, candidate)) fail('path_out_of_scope', `filesystem path escapes workspace: ${path}`)
  try {
    const resolved = await realpath(candidate)
    if (!inside(root, resolved)) fail('path_out_of_scope', `filesystem symlink escapes workspace: ${path}`)
    return resolved
  } catch (error) {
    if (error instanceof QualityRunError) throw error
    if (mustExist) fail('artifact_missing', `artifact does not exist: ${path}`)
    return candidate
  }
}

async function collectArtifact(root: string, contract: QualityContract, spec: FilesystemArtifactSpec, attempt: number): Promise<ArtifactEvidence> {
  if (!nonEmpty(spec.id)) fail('artifact_invalid', `invalid artifact ${spec.id || '<unknown>'}`)
  if (!cleanRelativePath(spec.path)) fail('path_out_of_scope', `unsafe artifact path: ${spec.path}`)
  if (!contract.deliverables.includes(spec.id)) fail('artifact_unknown', `artifact ${spec.id} is not a contract deliverable`)
  const path = await checkedPath(root, spec.path, true)
  const info = await stat(path)
  if (!info.isFile()) fail('artifact_invalid', `artifact is not a regular file: ${spec.path}`)
  const bytes = await readFile(path)
  const content = bytes.toString('utf8')
  const binary = !Buffer.from(content, 'utf8').equals(bytes)
  return {
    id: spec.id,
    taskId: contract.taskId,
    attempt,
    path: spec.path.replaceAll('\\', '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content: binary ? bytes.toString('base64') : content,
    ...(binary ? { encoding: 'base64' as const } : {}),
  }
}

function truncateOutput(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  return bytes.length <= maxBytes ? value : `${bytes.subarray(0, maxBytes).toString('utf8')}\n[output truncated]`
}

async function runCommand(command: string, cwd: string, timeoutMs: number, maxOutputBytes: number, env?: Readonly<Record<string, string | undefined>>): Promise<VerifiedCommandResult> {
  const startedAt = Date.now()
  return await new Promise<VerifiedCommandResult>((resolveResult) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    const append = (chunk: Buffer | string): void => {
      output += chunk.toString()
      if (Buffer.byteLength(output, 'utf8') > maxOutputBytes * 2) output = truncateOutput(output, maxOutputBytes)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', (chunk: Buffer | string) => append(`\n[stderr] ${chunk.toString()}`))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      const finishedAt = Date.now()
      resolveResult({ command, exitCode: -1, passed: false, output: `${output}\n[spawn error] ${error.message}`.trim(), startedAt, finishedAt, timedOut })
    })
    child.once('close', (exitCode) => {
      clearTimeout(timer)
      const finishedAt = Date.now()
      resolveResult({ command, exitCode: exitCode ?? -1, passed: !timedOut && exitCode === 0, output: truncateOutput(output, maxOutputBytes), startedAt, finishedAt, ...(timedOut ? { timedOut: true } : {}) })
    })
  })
}

/**
 * Collect evidence from the real workspace. The returned command receipts are
 * always produced by this function; callers cannot provide exitCode/passed.
 */
export async function collectTaskEvidence(input: CollectTaskEvidenceInput): Promise<TaskEvidence> {
  validateAcceptanceResults(input.contract, input.acceptanceResults)
  const changedPaths = [...(input.changedPaths ?? input.artifacts.map(item => item.path))]
  validateEvidencePaths(input.contract, changedPaths)
  for (const id of input.contract.deliverables) {
    if (!input.artifacts.some(spec => spec.id === id)) fail('artifact_missing', `deliverable artifact ${id} is missing`)
  }
  const root = await checkedWorkspace(input.workspaceRoot)
  const attempt = input.attempt ?? input.contract.attempt
  const artifactIds = new Set<string>()
  const artifacts: ArtifactEvidence[] = []
  for (const spec of input.artifacts) {
    if (artifactIds.has(spec.id)) fail('duplicate_artifact', `duplicate artifact id: ${spec.id}`)
    artifactIds.add(spec.id)
    artifacts.push(await collectArtifact(root, input.contract, spec, attempt))
  }
  for (const artifact of artifacts) {
    if (!changedPaths.some(path => {
      const normalized = path.replaceAll('\\', '/')
      return normalized.endsWith('/**') ? artifact.path === normalized.slice(0, -3) || artifact.path.startsWith(normalized.slice(0, -2)) : artifact.path === normalized
    })) fail('artifact_path_unlisted', `artifact path was not listed as changed: ${artifact.path}`)
  }
  const cwdCandidate = input.cwd === undefined
    ? root
    : isAbsolute(input.cwd) ? resolve(input.cwd) : resolve(root, input.cwd)
  if (!inside(root, cwdCandidate)) fail('path_out_of_scope', 'command cwd escapes workspace')
  let cwd: string
  try {
    cwd = await realpath(cwdCandidate)
  } catch {
    fail('workspace_invalid', `command cwd cannot be read: ${cwdCandidate}`)
  }
  if (!inside(root, cwd)) fail('path_out_of_scope', 'command cwd symlink escapes workspace')
  const commands = input.commands ?? input.contract.verify
  if (commands.length !== input.contract.verify.length || commands.some((command, index) => command !== input.contract.verify[index])) {
    fail('verification_contract_mismatch', 'commands must exactly match contract.verify')
  }
  const commandResults: VerifiedCommandResult[] = []
  for (const command of commands) {
    if (!nonEmpty(command)) fail('verification_invalid', 'verification command cannot be empty')
    commandResults.push(await runCommand(command, cwd, input.timeoutMs ?? DEFAULT_TIMEOUT_MS, input.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES, input.env))
  }
  const artifactCheckReceipts: ArtifactCheckReceipt[] = []
  for (const check of input.contract.artifactChecks ?? []) {
    const roles = check.id !== 'zhijian-report-craft-core-v1'
      ? [check.md, check.html, check.pdf, check.craftEvidence] : [check.md, check.html, check.pdf]
    const binding = {
      contractDigest: qualityContractDigest(input.contract),
      taskId: input.contract.taskId,
      attempt,
      artifacts: roles.map(id => {
        const artifact = artifacts.find(item => item.id === id)
        if (artifact === undefined) fail('artifact_missing', `artifact check requires ${id}`)
        return { id: artifact.id, sha256: artifact.sha256 }
      }),
    }
    if (check.id === 'zhijian-report-craft-core-v1') {
      artifactCheckReceipts.push({ ...binding, version: 1, checkId: check.id, results: await evaluateReportCraft(artifacts, check) })
      continue
    }
    if (check.id === 'selected-skill-craft-v1') {
      const results = await evaluateSkillCraft(artifacts, check, input.artifactCheckOptions)
      artifactCheckReceipts.push({ ...binding, version: 3, checkId: check.id, selectionDigest: check.selection.digest,
        checkers: check.selection.checks.map(({ packId, id, version, sha256, resultIds }) => ({ packId, id, version, sha256, resultIds: [...resultIds] })), results })
      continue
    }
    let materialError: string | undefined
    try {
      // Always use the packaged trusted resolver. No root or content override
      // crosses the review tool boundary, and disk drift never silently updates
      // the frozen material identity.
      const identity = verifyCraftMaterials({ style: check.style, materialDigest: check.materialDigest })
      if (identity.materialPackId !== check.materialPackId || identity.materialDigest !== check.materialDigest) {
        materialError = 'the frozen report material identity does not match the trusted package'
      }
    } catch (error: unknown) {
      materialError = error instanceof Error ? error.message.slice(0, 2000) : 'trusted report materials could not be verified'
    }
    const results: readonly ArtifactCheckResult[] = materialError === undefined
      ? await evaluateReportCraftV2(artifacts, check, input.artifactCheckOptions)
      : REPORT_CRAFT_V2_RESULT_IDS.map(id => ({ id, status: 'unverified' as const, detail: `Report material integrity is unverified: ${materialError}` }))
    artifactCheckReceipts.push({ ...binding, version: 2, checkId: check.id,
      checkerVersion: REPORT_CRAFT_V2_CHECKER_VERSION, materialDigest: check.materialDigest, results })
  }
  const evidence: TaskEvidence = {
    taskId: input.contract.taskId,
    attempt,
    artifacts,
    acceptanceResults: input.acceptanceResults.map(result => ({ ...result })),
    commandsRun: commandResults,
    changedPaths,
    ...(input.independentReview === undefined ? {} : { independentReview: structuredClone(input.independentReview) }),
    ...(input.contract.artifactChecks === undefined ? {} : { artifactCheckReceipts }),
  }
  validateTaskEvidenceIntegrity(input.contract, evidence, attempt)
  return evidence
}

/** Exact retries reuse the original Host receipts rather than re-running commands. */
export function reviewEvidenceForReplay(run: QualityRun, eventId: string, input: Pick<CollectTaskEvidenceInput, 'artifacts' | 'acceptanceResults' | 'changedPaths' | 'independentReview'>): TaskEvidence | undefined {
  const event = run.events.find(item => item.id === eventId)
  if (event === undefined) return undefined
  if (event.type !== 'review') fail('idempotency_conflict', `event ${eventId} belongs to ${event.type}; use a new review event_id`)
  const reviewIndex = run.events.filter(item => item.type === 'review').findIndex(item => item.id === eventId)
  const evidence = run.evidenceHistory[reviewIndex]
  if (evidence === undefined) fail('quality_state_invalid', `review event ${eventId} has no durable evidence`)
  validateArtifactCheckReceipts(run.contract, evidence, evidence.attempt)
  const expected = { artifacts: evidence.artifacts.map(({ id, path }) => ({ id, path })), acceptanceResults: evidence.acceptanceResults, changedPaths: evidence.changedPaths, independentReview: evidence.independentReview }
  const actual = { artifacts: input.artifacts.map(({ id, path }) => ({ id, path })), acceptanceResults: input.acceptanceResults, changedPaths: input.changedPaths ?? input.artifacts.map(item => item.path), independentReview: input.independentReview }
  if (!sameJson(expected, actual)) fail('idempotency_conflict', `event ${eventId} was already applied with different evidence inputs; reuse only for an exact retry, or use a new review event_id after quality_repair/quality_reopen`)
  return evidence
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Strict persisted-state validation used at runtime boundaries. */
export function assertDurableQualityRun(value: unknown): asserts value is QualityRun {
  if (!isQualityRun(value)) fail('quality_state_invalid', 'qualityRun schema is invalid')
  const run = value
  if (!Array.isArray(run.amendments)) fail('quality_state_invalid', 'quality contract amendment ledger is missing')
  if (run.attempt !== run.contract.attempt + run.repairRounds) fail('quality_state_invalid', 'attempt and repairRounds disagree')
  if (run.reviewRounds !== run.evidenceHistory.length) fail('quality_state_invalid', 'reviewRounds and evidenceHistory disagree')
  if (run.reviewRounds === 0 && run.latestEvidence !== undefined) fail('quality_state_invalid', 'latestEvidence exists before review')
  if (run.reviewRounds > 0) {
    if (run.latestEvidence === undefined || !sameJson(run.latestEvidence, run.evidenceHistory[run.evidenceHistory.length - 1])) fail('quality_state_invalid', 'latestEvidence is not the last reviewed evidence')
  }
  const ids = new Set<string>()
  for (const event of run.events) {
    if (ids.has(event.id)) fail('quality_state_invalid', `duplicate quality event: ${event.id}`)
    ids.add(event.id)
  }
  const reviews = run.events.filter(event => event.type === 'review').length
  const repairs = run.events.filter(event => event.type === 'repair').length
  const integrations = run.events.filter(event => event.type === 'integration').length
  const amendments = run.events.filter(event => event.type === 'amendment').length
  if (reviews !== run.reviewRounds || repairs !== run.repairRounds || amendments !== run.amendments.length || integrations > 1) fail('quality_state_invalid', 'quality event counters disagree')
  if (run.reviewRounds > 0 && run.contractFrozenAt === undefined) fail('quality_state_invalid', 'reviewed run has no contract freeze timestamp')
  if (run.reviewRounds === 0 && run.contractFrozenAt !== undefined && run.revision?.withdrawUnreviewed !== true) fail('quality_state_invalid', 'pending run is already contract frozen')
  if (run.status === 'pending' && (run.reviewRounds !== 0 || run.repairRounds !== 0)) fail('quality_state_invalid', 'pending run has events')
  if (run.status === 'repairing' && (run.lastVerdict !== undefined || run.repairRounds < 1)) fail('quality_state_invalid', 'repairing run has no open repair generation')
  if (run.status === 'passed' && run.lastVerdict !== 'pass') fail('quality_state_invalid', 'passed run lacks pass verdict')
  if (run.status === 'blocked' && (run.lastVerdict === undefined || run.lastVerdict === 'pass')) fail('quality_state_invalid', 'blocked run lacks a failing verdict')
  if (run.status === 'escalated' && (run.lastVerdict === undefined || run.lastVerdict === 'pass' || run.repairRounds < run.contract.maxRepairRounds)) fail('quality_state_invalid', 'escalated run is below repair budget')
  if (run.status === 'integrated' && (run.lastVerdict !== 'pass' || integrations !== 1)) fail('quality_state_invalid', 'integrated run is not backed by one passing integration')
  for (const evidence of run.evidenceHistory) {
    if (evidence.attempt < run.contract.attempt || evidence.attempt > run.attempt) fail('quality_state_invalid', 'evidence attempt is outside run generation')
  }
  for (const finding of run.findings) {
    if (finding.taskId !== run.contract.taskId || finding.attempt < run.contract.attempt || finding.attempt > run.attempt) fail('quality_state_invalid', 'finding belongs to an unknown generation')
  }
}

/** Persist a run with a same-directory atomic replacement. */
export async function writeQualityRunAtomic(file: string, run: QualityRun): Promise<void> {
  assertDurableQualityRun(run)
  const target = resolve(file)
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(run, null, 2), { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, target)
  } catch (error) {
    try { await rename(temporary, `${temporary}.failed`) } catch { /* best effort cleanup */ }
    throw new QualityRunError('quality_persist_failed', `failed to persist quality run: ${String(error)}`)
  }
}

/** Read and strictly validate a persisted run after a process restart. */
export async function readQualityRunJSON(file: string): Promise<QualityRun> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(resolve(file), 'utf8')) as unknown
  } catch (error) {
    throw new QualityRunError('quality_read_failed', `failed to read quality run: ${String(error)}`)
  }
  assertDurableQualityRun(parsed)
  return parsed
}
