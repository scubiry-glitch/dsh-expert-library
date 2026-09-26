/**
 * Structured quality-run state machine.
 *
 * This module is deliberately independent from the legacy completion gates in
 * `task-gates.ts`.  A quality run records the contract, evidence, review
 * findings and repair generations as durable JSON-shaped data.  Callers can
 * persist the returned value and pass it back after a process restart; event
 * ids make repeated deliveries no-ops.
 */

import { createHash } from 'node:crypto'

export const QUALITY_CONTRACT_KINDS = [
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
] as const

export type QualityContractKind = typeof QUALITY_CONTRACT_KINDS[number]
export type FindingSeverity = 'info' | 'soft' | 'hard'
export type ReviewVerdict = 'pass' | 'needs_revision' | 'reject'
export type QualityRunStatus = 'pending' | 'reviewing' | 'blocked' | 'repairing' | 'passed' | 'escalated' | 'integrated'
const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['pass', 'needs_revision', 'reject']
const FINDING_SEVERITIES: readonly FindingSeverity[] = ['info', 'soft', 'hard']

export interface AcceptanceCriterion {
  readonly id: string
  readonly statement: string
}

export interface QualityContractInput {
  readonly id: string
  readonly taskId: string
  readonly attempt: number
  readonly assignee: string
  readonly kind: QualityContractKind
  readonly objective: string
  readonly inScope: readonly string[]
  readonly outOfScope?: readonly string[]
  readonly acceptance: readonly AcceptanceCriterion[]
  readonly verify: readonly string[]
  readonly deliverables: readonly string[]
  /** Paths the task may report as changed. Supports `dir/**` suffix. */
  readonly changedPaths: readonly string[]
  readonly coverageOf?: readonly string[]
  readonly maxRepairRounds?: number
}

export interface QualityContract extends QualityContractInput {
  readonly outOfScope: readonly string[]
  readonly maxRepairRounds: number
}

export interface ArtifactEvidence {
  readonly id: string
  readonly taskId: string
  readonly attempt: number
  readonly path: string
  readonly sha256: string
  /** Content is retained at this boundary so a reviewer can verify the hash. */
  readonly content: string
}

export interface AcceptanceResult {
  readonly id: string
  readonly passed: boolean
  readonly detail?: string
}

export interface CommandResult {
  readonly command: string
  readonly exitCode: number
  readonly passed: boolean
  readonly output?: string
}

export interface TaskEvidence {
  readonly taskId: string
  readonly attempt: number
  readonly artifacts: readonly ArtifactEvidence[]
  readonly acceptanceResults: readonly AcceptanceResult[]
  readonly commandsRun: readonly CommandResult[]
  readonly changedPaths: readonly string[]
}

export interface Finding {
  readonly id: string
  readonly code: string
  readonly severity: FindingSeverity
  readonly message: string
  readonly taskId: string
  readonly attempt: number
  readonly path?: string
}

export interface ReviewInput {
  readonly eventId: string
  readonly reviewer: string
  readonly verdict: ReviewVerdict
  readonly findings?: readonly Finding[]
  readonly evidence: TaskEvidence
  readonly at?: number
}

export interface RepairInput {
  readonly eventId: string
  readonly actor: string
  readonly at?: number
}

export interface IntegrationInput {
  readonly eventId: string
  readonly actor: string
  readonly at?: number
}

export interface QualityEvent {
  readonly id: string
  readonly type: 'review' | 'repair' | 'integration'
  readonly at: number
  readonly actor: string
  readonly fingerprint: string
}

export interface QualityRun {
  readonly version: 1
  readonly runId: string
  readonly contract: QualityContract
  readonly status: QualityRunStatus
  /** Current task execution generation. Repair opens the next generation. */
  readonly attempt: number
  readonly reviewRounds: number
  readonly repairRounds: number
  readonly findings: readonly Finding[]
  readonly evidenceHistory: readonly TaskEvidence[]
  readonly latestEvidence?: TaskEvidence
  readonly lastVerdict?: ReviewVerdict
  readonly events: readonly QualityEvent[]
}

export interface QualityMutation {
  readonly run: QualityRun
  readonly applied: boolean
}

export class QualityRunError extends Error {
  readonly code: string
  readonly details?: Readonly<Record<string, unknown>>

  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message)
    this.name = 'QualityRunError'
    this.code = code
    this.details = details
  }
}

function fail(code: string, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new QualityRunError(code, message, details)
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function pathClean(value: string): boolean {
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  const parts = value.replaceAll('\\', '/').split('/')
  return value !== '' && !parts.includes('') && !parts.includes('.') && !parts.includes('..')
}

function pathMatches(path: string, pattern: string): boolean {
  const normalized = pattern.replaceAll('\\', '/')
  return normalized.endsWith('/**')
    ? path === normalized.slice(0, -3).replace(/\/$/, '') || path.startsWith(normalized.slice(0, -2))
    : path === normalized
}

function copyEvidence(evidence: TaskEvidence): TaskEvidence {
  return {
    taskId: evidence.taskId,
    attempt: evidence.attempt,
    artifacts: evidence.artifacts.map(artifact => ({ ...artifact })),
    acceptanceResults: evidence.acceptanceResults.map(result => ({ ...result })),
    commandsRun: evidence.commandsRun.map(result => ({ ...result })),
    changedPaths: [...evidence.changedPaths],
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function eventResult(run: QualityRun, input: { id: string; type: QualityEvent['type']; actor: string; at: number; payload: unknown }): QualityMutation {
  const digest = fingerprint({ type: input.type, actor: input.actor, payload: input.payload })
  const previous = run.events.find(event => event.id === input.id)
  if (previous !== undefined) {
    if (previous.fingerprint !== digest) fail('idempotency_conflict', `event ${input.id} was already applied with different content`)
    return { run, applied: false }
  }
  const event: QualityEvent = { id: input.id, type: input.type, actor: input.actor, at: input.at, fingerprint: digest }
  return { run: { ...run, events: [...run.events, event] }, applied: true }
}

function validateStringList(values: readonly string[], field: string, allowEmpty = true): void {
  if (!allowEmpty && values.length === 0) fail('invalid_contract', `${field} must not be empty`)
  if (values.some(value => !nonEmpty(value))) fail('invalid_contract', `${field} must contain non-empty strings`)
}

/** Validate and normalize a quality contract before it becomes durable. */
export function createQualityContract(input: QualityContractInput): QualityContract {
  if (!nonEmpty(input.id) || !nonEmpty(input.taskId) || !nonEmpty(input.assignee)) fail('invalid_contract', 'id, taskId and assignee are required')
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) fail('invalid_contract', 'attempt must be a positive integer')
  if (!(QUALITY_CONTRACT_KINDS as readonly string[]).includes(input.kind)) fail('invalid_contract', `unknown contract kind ${String(input.kind)}`)
  if (!nonEmpty(input.objective)) fail('invalid_contract', 'objective is required')
  validateStringList(input.inScope, 'inScope', false)
  validateStringList(input.outOfScope ?? [], 'outOfScope')
  validateStringList(input.verify, 'verify', false)
  validateStringList(input.deliverables, 'deliverables', false)
  validateStringList(input.changedPaths, 'changedPaths', false)
  if (input.acceptance.length === 0 || input.acceptance.some(item => !nonEmpty(item.id) || !nonEmpty(item.statement))) fail('invalid_contract', 'acceptance criteria must have id and statement')
  for (const path of [...input.inScope, ...(input.outOfScope ?? []), ...input.changedPaths]) {
    if (!pathClean(path)) fail('invalid_contract', `unsafe path scope: ${path}`)
  }
  const maxRepairRounds = input.maxRepairRounds ?? 2
  if (!Number.isSafeInteger(maxRepairRounds) || maxRepairRounds < 0 || maxRepairRounds > 2) fail('invalid_contract', 'maxRepairRounds must be between 0 and 2')
  return {
    ...input,
    outOfScope: [...(input.outOfScope ?? [])],
    acceptance: input.acceptance.map(item => ({ ...item })),
    inScope: [...input.inScope],
    verify: [...input.verify],
    deliverables: [...input.deliverables],
    changedPaths: [...input.changedPaths],
    coverageOf: input.coverageOf === undefined ? undefined : [...input.coverageOf],
    maxRepairRounds,
  }
}

/** Validate task evidence against contract, attempt and artifact hashes. */
export function validateTaskEvidence(
  contract: QualityContract,
  evidence: TaskEvidence,
  expectedAttempt = contract.attempt,
): void {
  if (evidence.taskId !== contract.taskId) fail('task_mismatch', `evidence belongs to ${evidence.taskId}, expected ${contract.taskId}`)
  if (evidence.attempt !== expectedAttempt) fail('stale_attempt', `evidence attempt ${evidence.attempt} is stale; expected ${expectedAttempt}`)
  if (evidence.acceptanceResults.length === 0) fail('evidence_missing', 'acceptanceResults are required')
  if (evidence.commandsRun.length === 0) fail('evidence_missing', 'commandsRun are required')
  if (evidence.changedPaths.length === 0) fail('evidence_missing', 'changedPaths are required')
  const artifactIds = new Set(evidence.artifacts.map(artifact => artifact.id))
  if (artifactIds.size !== evidence.artifacts.length) fail('duplicate_artifact', 'artifact ids must be unique')
  for (const id of contract.deliverables) {
    if (!artifactIds.has(id)) fail('artifact_missing', `deliverable artifact ${id} is missing`)
  }
  const acceptanceIds = new Set(evidence.acceptanceResults.map(result => result.id))
  if (acceptanceIds.size !== evidence.acceptanceResults.length) fail('duplicate_acceptance', 'acceptance result ids must be unique')
  for (const criterion of contract.acceptance) {
    if (!acceptanceIds.has(criterion.id)) fail('acceptance_missing', `acceptance result ${criterion.id} is missing`)
  }
  for (const result of evidence.acceptanceResults) {
    if (!contract.acceptance.some(item => item.id === result.id)) fail('acceptance_unknown', `unknown acceptance criterion ${result.id}`)
    if (!result.passed) fail('acceptance_failed', `acceptance criterion ${result.id} failed`)
  }
  const submittedAcceptance = new Set(evidence.acceptanceResults.map(result => result.id))
  for (const criterion of contract.acceptance) {
    if (!submittedAcceptance.has(criterion.id)) fail('acceptance_missing', `acceptance criterion ${criterion.id} is missing`)
  }
  for (const command of evidence.commandsRun) {
    if (!nonEmpty(command.command) || command.exitCode !== 0 || !command.passed) fail('verification_failed', `verification command failed: ${command.command}`)
  }
  for (const path of evidence.changedPaths) {
    if (!pathClean(path)) fail('path_out_of_scope', `unsafe changed path ${path}`)
    if ((contract.outOfScope ?? []).some(scope => pathMatches(path, scope))) fail('path_out_of_scope', `changed path is out of scope: ${path}`)
    const allowed = contract.inScope.some(scope => pathMatches(path, scope))
      && contract.changedPaths.some(scope => pathMatches(path, scope))
    if (!allowed) fail('path_out_of_scope', `changed path is outside contract scope: ${path}`)
  }
  for (const artifact of evidence.artifacts) {
    if (artifact.taskId !== contract.taskId || artifact.attempt !== expectedAttempt) fail('stale_artifact', `artifact ${artifact.id} belongs to a different task attempt`)
    if (!evidence.changedPaths.some(path => pathMatches(artifact.path, path))) fail('artifact_path_unlisted', `artifact path was not listed as changed: ${artifact.path}`)
    if (!pathClean(artifact.path) || contract.outOfScope.some(scope => pathMatches(artifact.path, scope))) fail('path_out_of_scope', `artifact path is out of scope: ${artifact.path}`)
    const actual = createHash('sha256').update(artifact.content, 'utf8').digest('hex')
    if (actual !== artifact.sha256) fail('artifact_hash_mismatch', `artifact ${artifact.id} hash does not match its content`)
  }
}

/** Create a reviewable quality run; no review or integration is implied. */
export function createQualityRun(contractInput: QualityContractInput, runId = `quality-${contractInput.id}`): QualityRun {
  const contract = createQualityContract(contractInput)
  if (!nonEmpty(runId)) fail('invalid_run', 'runId is required')
  return {
    version: 1,
    runId,
    contract,
    status: 'pending',
    attempt: contract.attempt,
    reviewRounds: 0,
    repairRounds: 0,
    findings: [],
    evidenceHistory: [],
    events: [],
  }
}

/** Submit one review; duplicate event ids are idempotent. */
export function reviewQualityRun(run: QualityRun, input: ReviewInput): QualityMutation {
  if (!nonEmpty(input.eventId) || !nonEmpty(input.reviewer)) fail('invalid_review', 'eventId and reviewer are required')
  if (!(REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) fail('invalid_review', `unknown review verdict ${String(input.verdict)}`)
  if (run.status === 'integrated' || run.status === 'escalated') fail('terminal_run', `cannot review a ${run.status} run`)
  const duplicate = run.events.find(event => event.id === input.eventId)
  const digest = fingerprint({ type: 'review', actor: input.reviewer, payload: { verdict: input.verdict, findings: input.findings ?? [], evidence: input.evidence } })
  if (duplicate !== undefined) {
    if (duplicate.fingerprint !== digest) fail('idempotency_conflict', `event ${input.eventId} was already applied with different content`)
    return { run, applied: false }
  }
  if (input.reviewer === run.contract.assignee) fail('reviewer_is_assignee', 'reviewer must differ from assignee')
  if (run.status !== 'pending' && run.status !== 'reviewing' && run.status !== 'repairing') fail('invalid_transition', `cannot review a ${run.status} run`)
  validateTaskEvidence(run.contract, input.evidence, run.attempt)
  const findings = (input.findings ?? []).map(finding => ({ ...finding }))
  for (const finding of findings) {
    if (!nonEmpty(finding.id) || !nonEmpty(finding.code) || !nonEmpty(finding.message)) fail('invalid_finding', 'finding id, code and message are required')
    if (!(FINDING_SEVERITIES as readonly string[]).includes(finding.severity)) fail('invalid_finding', `unknown finding severity ${String(finding.severity)}`)
    if (finding.taskId !== run.contract.taskId || finding.attempt !== run.attempt) fail('stale_finding', `finding ${finding.id} belongs to a different attempt`)
  }
  if (input.verdict === 'pass' && findings.some(finding => finding.severity === 'hard')) fail('hard_block', 'a hard finding cannot receive a pass verdict')
  if (input.verdict !== 'pass' && findings.length === 0) fail('finding_required', 'a non-pass review must include at least one finding')
  const at = input.at ?? Date.now()
  const event: QualityEvent = { id: input.eventId, type: 'review', actor: input.reviewer, at, fingerprint: digest }
  const nextStatus: QualityRunStatus = input.verdict === 'pass'
    ? 'passed'
    : run.repairRounds >= run.contract.maxRepairRounds ? 'escalated' : 'blocked'
  return {
    applied: true,
    run: {
      ...run,
      status: nextStatus,
      reviewRounds: run.reviewRounds + 1,
      findings: [...run.findings, ...findings],
      evidenceHistory: [...run.evidenceHistory, copyEvidence(input.evidence)],
      latestEvidence: copyEvidence(input.evidence),
      lastVerdict: input.verdict,
      events: [...run.events, event],
    },
  }
}

/** Open the next repair attempt after a blocked review. */
export function requestQualityRepair(run: QualityRun, input: RepairInput): QualityMutation {
  if (!nonEmpty(input.eventId) || !nonEmpty(input.actor)) fail('invalid_repair', 'eventId and actor are required')
  const duplicate = run.events.find(event => event.id === input.eventId)
  const digest = fingerprint({ type: 'repair', actor: input.actor, payload: {} })
  if (duplicate !== undefined) {
    if (duplicate.fingerprint !== digest) fail('idempotency_conflict', `event ${input.eventId} was already applied with different content`)
    return { run, applied: false }
  }
  if (run.status !== 'blocked') fail('invalid_transition', `only blocked runs can open repair (got ${run.status})`)
  if (run.repairRounds >= run.contract.maxRepairRounds) fail('repair_budget_exhausted', 'repair budget is exhausted')
  const at = input.at ?? Date.now()
  const event: QualityEvent = { id: input.eventId, type: 'repair', actor: input.actor, at, fingerprint: digest }
  return {
    applied: true,
    run: {
      ...run,
      status: 'repairing',
      attempt: run.attempt + 1,
      repairRounds: run.repairRounds + 1,
      lastVerdict: undefined,
      events: [...run.events, event],
    },
  }
}

/** Complete integration only after a passing review. */
export function integrateQualityRun(run: QualityRun, input: IntegrationInput): QualityMutation {
  if (!nonEmpty(input.eventId) || !nonEmpty(input.actor)) fail('invalid_integration', 'eventId and actor are required')
  const duplicate = run.events.find(event => event.id === input.eventId)
  const digest = fingerprint({ type: 'integration', actor: input.actor, payload: {} })
  if (duplicate !== undefined) {
    if (duplicate.fingerprint !== digest) fail('idempotency_conflict', `event ${input.eventId} was already applied with different content`)
    return { run, applied: false }
  }
  if (run.status !== 'passed') fail('integration_blocked', `integration requires a passed review (got ${run.status})`)
  if (run.latestEvidence === undefined) fail('evidence_missing', 'integration requires reviewed evidence')
  validateTaskEvidence(run.contract, run.latestEvidence, run.attempt)
  const at = input.at ?? Date.now()
  const event: QualityEvent = { id: input.eventId, type: 'integration', actor: input.actor, at, fingerprint: digest }
  return { applied: true, run: { ...run, status: 'integrated', events: [...run.events, event] } }
}

/** Return whether an event has already been applied, useful during recovery. */
export function hasQualityEvent(run: QualityRun, eventId: string): boolean {
  return run.events.some(event => event.id === eventId)
}

/*
 * Durable JSON boundary validator.  QualityRun is intentionally a pure data
 * object, so state.ts cannot rely on TypeScript's readonly types when loading
 * team.json after a restart.  Keep this check here beside the state-machine
 * schema; callers that only need the pure transitions do not need to know
 * about filesystem state.
 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

function stringList(value: unknown, nonEmpty = false): value is readonly string[] {
  return Array.isArray(value)
    && (!nonEmpty || value.length > 0)
    && value.every(item => nonEmptyString(item))
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function safePath(value: string): boolean {
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return false
  const parts = value.replaceAll('\\', '/').split('/')
  return value !== '' && !parts.includes('') && !parts.includes('.') && !parts.includes('..')
}

function isTaskEvidence(value: unknown): value is TaskEvidence {
  if (!record(value) || !nonEmptyString(value.taskId) || !positiveInteger(value.attempt)) return false
  if (!Array.isArray(value.artifacts) || !Array.isArray(value.acceptanceResults)
    || !Array.isArray(value.commandsRun) || !stringList(value.changedPaths)) return false
  if (value.artifacts.some(artifact => !record(artifact)
    || !nonEmptyString(artifact.id)
    || !nonEmptyString(artifact.taskId)
    || !positiveInteger(artifact.attempt)
    || !nonEmptyString(artifact.path)
    || !nonEmptyString(artifact.sha256)
    || typeof artifact.content !== 'string')) return false
  if (value.acceptanceResults.some(result => !record(result)
    || !nonEmptyString(result.id)
    || typeof result.passed !== 'boolean'
    || (result.detail !== undefined && typeof result.detail !== 'string'))) return false
  return !value.commandsRun.some(command => !record(command)
    || !nonEmptyString(command.command)
    || !Number.isSafeInteger(command.exitCode)
    || typeof command.passed !== 'boolean'
    || (command.output !== undefined && typeof command.output !== 'string'))
}

function isQualityContract(value: unknown): value is QualityContract {
  if (!record(value)
    || !nonEmptyString(value.id)
    || !nonEmptyString(value.taskId)
    || !positiveInteger(value.attempt)
    || !(QUALITY_CONTRACT_KINDS as readonly string[]).includes(value.kind as string)
    || !nonEmptyString(value.objective)
    || !stringList(value.inScope, true)
    || !stringList(value.outOfScope)
    || !Array.isArray(value.acceptance)
    || !stringList(value.verify, true)
    || !stringList(value.deliverables, true)
    || !stringList(value.changedPaths, true)
    || (value.coverageOf !== undefined && !stringList(value.coverageOf))
    || !Number.isSafeInteger(value.maxRepairRounds)
    || (value.maxRepairRounds as number) < 0
    || (value.maxRepairRounds as number) > 2
    || [...(value.inScope as readonly string[]), ...(value.outOfScope as readonly string[]), ...(value.changedPaths as readonly string[])].some(path => !safePath(path))) return false
  return !value.acceptance.some(item => !record(item)
    || !nonEmptyString(item.id)
    || !nonEmptyString(item.statement))
}

/** Validate a JSON-restored QualityRun before it enters the state machine. */
export function isQualityRun(value: unknown): value is QualityRun {
  if (!record(value)
    || value.version !== 1
    || !nonEmptyString(value.runId)
    || !isQualityContract(value.contract)
    || !(QUALITY_RUN_STATUSES as readonly string[]).includes(value.status as string)
    || !positiveInteger(value.attempt)
    || !Number.isSafeInteger(value.reviewRounds) || (value.reviewRounds as number) < 0
    || !Number.isSafeInteger(value.repairRounds) || (value.repairRounds as number) < 0
    || !Array.isArray(value.findings)
    || !Array.isArray(value.evidenceHistory)
    || !Array.isArray(value.events)
    || (value.latestEvidence !== undefined && !isTaskEvidence(value.latestEvidence))
    || (value.lastVerdict !== undefined && !(REVIEW_VERDICTS as readonly string[]).includes(value.lastVerdict as string))) return false
  if (value.findings.some(finding => !record(finding)
    || !nonEmptyString(finding.id)
    || !nonEmptyString(finding.code)
    || !(FINDING_SEVERITIES as readonly string[]).includes(finding.severity as string)
    || !nonEmptyString(finding.message)
    || !nonEmptyString(finding.taskId)
    || !positiveInteger(finding.attempt)
    || (finding.path !== undefined && typeof finding.path !== 'string'))) return false
  if (value.evidenceHistory.some(evidence => !isTaskEvidence(evidence))) return false
  return !value.events.some(event => !record(event)
    || !nonEmptyString(event.id)
    || !nonEmptyString(event.actor)
    || !finite(event.at)
    || !(event.type === 'review' || event.type === 'repair' || event.type === 'integration')
    || !nonEmptyString(event.fingerprint))
}

const QUALITY_RUN_STATUSES: readonly QualityRunStatus[] = [
  'pending', 'reviewing', 'blocked', 'repairing', 'passed', 'escalated', 'integrated',
]
