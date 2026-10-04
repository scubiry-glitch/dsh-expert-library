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
import { hasMarkdownReviewQuote, markdownReviewBlocks, normalizeReviewQuote } from './markdown-review-quotes.ts'
import { canonicalDigest } from './v2/digest.ts'
import type { SkillCraftArtifactCheck } from './skill-craft-types.ts'
import { isFrozenSkillCraftContract } from './skill-craft.ts'
export type { SkillCraftArtifactCheck } from './skill-craft-types.ts'

export const QUALITY_CONTRACT_KINDS = [
  'requirements',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
] as const

export type QualityContractKind = typeof QUALITY_CONTRACT_KINDS[number]
export const FINDING_SEVERITIES = ['info', 'soft', 'hard'] as const
export const REVIEW_VERDICTS = ['pass', 'needs_revision', 'reject'] as const
export type FindingSeverity = typeof FINDING_SEVERITIES[number]
export type ReviewVerdict = typeof REVIEW_VERDICTS[number]
export type QualityRunStatus = 'pending' | 'reviewing' | 'blocked' | 'repairing' | 'passed' | 'escalated' | 'integrated'

export interface AcceptanceCriterion {
  readonly id: string
  readonly statement: string
}

export const REPORT_CRAFT_RESULT_IDS = [
  'report-craft-source-disclosure',
  'report-craft-closing-structure',
  'report-craft-pdf-structure',
] as const

/** Registered, versioned Host checks; values name contract deliverable IDs. */
export interface ReportCraftV1Check {
  readonly id: 'zhijian-report-craft-core-v1'
  readonly md: string
  readonly html: string
  readonly pdf: string
}

export const REPORT_CRAFT_V2_RESULT_IDS = [
  ...REPORT_CRAFT_RESULT_IDS,
  'report-craft-chapter-structure',
  'report-craft-calculations',
  'report-craft-format-consistency',
  'report-craft-browser',
] as const
/** One registered implementation version; checker module re-exports this value. */
export const REPORT_CRAFT_V2_CHECKER_VERSION = 'report-craft-v2.2'
/** Historical receipts remain readable; only current ones authorize new work. */
const REPORT_CRAFT_V2_KNOWN_CHECKER_VERSIONS: readonly string[] = ['report-craft-v2.1', REPORT_CRAFT_V2_CHECKER_VERSION]

export interface ReportCraftV2Check {
  readonly id: 'zhijian-report-craft-core-v2'
  readonly md: string
  readonly html: string
  readonly pdf: string
  readonly craftEvidence: string
  readonly materialPackId: 'zhijian-report-craft-v2'
  readonly materialDigest: string
  readonly style: 'credit-policy' | 'designer-paper'
}

export type ArtifactCheckSpec = ReportCraftV1Check | ReportCraftV2Check | SkillCraftArtifactCheck

export interface ArtifactCheckResult {
  readonly id: string
  readonly status: 'passed' | 'failed' | 'unverified'
  readonly detail: string
}

/** Created by the Host evidence collector, never supplied by a review tool caller. */
interface ArtifactCheckReceiptBase {
  readonly contractDigest: string
  readonly taskId: string
  readonly attempt: number
  /** Fixed role order: md, html, pdf, then craftEvidence for v2. */
  readonly artifacts: readonly { readonly id: string; readonly sha256: string }[]
  readonly results: readonly ArtifactCheckResult[]
}

export type ArtifactCheckReceipt = ArtifactCheckReceiptBase & (
  | { readonly version: 1; readonly checkId: 'zhijian-report-craft-core-v1' }
  | { readonly version: 2; readonly checkId: 'zhijian-report-craft-core-v2'; readonly checkerVersion: string; readonly materialDigest: string }
  | { readonly version: 3; readonly checkId: 'selected-skill-craft-v1'; readonly selectionDigest: string; readonly checkers: readonly SkillCraftCheckerIdentity[] }
)

export interface SkillCraftCheckerIdentity {
  readonly packId: string
  readonly id: string
  readonly version: string
  readonly sha256: string
  readonly resultIds: readonly string[]
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
  readonly artifactChecks?: readonly ArtifactCheckSpec[]
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
  /** Legacy/text artifacts use UTF-8; binary evidence is retained losslessly. */
  readonly encoding?: 'utf8' | 'base64'
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
  readonly artifactCheckReceipts?: readonly ArtifactCheckReceipt[]
  /** Structured independent observations, not a claim of automated semantic proof.
   * The tool boundary authenticates the material preparation and reviewer session. */
  readonly independentReview?: IndependentReview
}

export const INDEPENDENT_REVIEW_AREA_IDS = ['chapter-substance', 'facts-and-uncertainty', 'calculations-and-coverage', 'visual-and-format'] as const
export interface IndependentReview {
  readonly materialReceiptId: string
  readonly reviewerSessionId: string
  readonly areas: readonly {
    readonly id: string
    readonly status: 'passed' | 'failed' | 'unverified'
    readonly coverage: string
    readonly evidence: readonly { readonly artifactId: string; readonly quote: string; readonly reason: string }[]
  }[]
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

export interface QualityForkInput {
  readonly eventId: string
  readonly actor: string
  readonly reason: string
  readonly assignee: string
  /** The task generation the new review must authorize. Never moves backward. */
  readonly attempt: number
  readonly at?: number
  /** Captain-only withdrawal of a submitted, not-yet-reviewed generation. */
  readonly withdrawUnreviewed?: boolean
}

/** The previous run remains in the team's immutable quality history. */
export interface QualityRunRevision {
  readonly parentRunId: string
  readonly eventId: string
  readonly actor: string
  readonly reason: string
  readonly at: number
  readonly fingerprint: string
  /** Repairs already used by the parent plus the reviewed revision itself. */
  readonly budgetCharged: number
  readonly withdrawUnreviewed?: true
}

/** A durable audit record for a contract revision made before review starts. */
export interface QualityContractAmendment {
  readonly id: string
  readonly actor: string
  readonly reason: string
  readonly at: number
  readonly fields: readonly string[]
  readonly previousDigest: string
  readonly nextDigest: string
}

export interface ContractAmendmentInput {
  readonly eventId: string
  readonly actor: string
  readonly reason: string
  readonly contract: QualityContractInput
  readonly at?: number
}

export interface QualityEvent {
  readonly id: string
  readonly type: 'amendment' | 'review' | 'repair' | 'integration'
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
  /** Contract revisions are allowed only while the run is pending. */
  readonly amendments?: readonly QualityContractAmendment[]
  /** Set when the first review is accepted; afterward the contract is frozen. */
  readonly contractFrozenAt?: number
  /** A fresh run supersedes, rather than rewrites, an earlier review. */
  readonly revision?: QualityRunRevision
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
    ...(evidence.independentReview === undefined ? {} : { independentReview: structuredClone(evidence.independentReview) }),
    ...(evidence.artifactCheckReceipts === undefined ? {} : {
      artifactCheckReceipts: structuredClone(evidence.artifactCheckReceipts),
    }),
  }
}

export function qualityContractDigest(contract: QualityContract): string {
  return canonicalDigest(contract)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

const boundedText = (value: unknown, max: number): value is string => nonEmpty(value) && value.length <= max

function isIndependentReview(value: unknown): value is IndependentReview {
  if (!record(value) || !hasExactKeys(value, ['materialReceiptId', 'reviewerSessionId', 'areas'])
    || !boundedText(value.materialReceiptId, 256) || !boundedText(value.reviewerSessionId, 256)
    || !Array.isArray(value.areas) || value.areas.length > 64
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > 65_536) return false
  const ids = new Set<string>()
  return value.areas.every(area => {
    if (!record(area) || !hasExactKeys(area, ['id', 'status', 'coverage', 'evidence'])
      || !boundedText(area.id, 256)
      || ids.has(area.id as string) || !['passed', 'failed', 'unverified'].includes(area.status as string)
      || !boundedText(area.coverage, 8000) || !Array.isArray(area.evidence) || area.evidence.length < 1 || area.evidence.length > 8) return false
    ids.add(area.id as string)
    return area.evidence.every(item => record(item) && hasExactKeys(item, ['artifactId', 'quote', 'reason'])
      && boundedText(item.artifactId, 256) && boundedText(item.quote, 2000) && boundedText(item.reason, 4000))
  })
}

export function validateIndependentReview(contract: QualityContract, evidence: TaskEvidence, required = false, passing = false): void {
  const checks = (contract.artifactChecks ?? []).filter((check): check is ReportCraftV2Check | SkillCraftArtifactCheck => check.id !== 'zhijian-report-craft-core-v1')
  const expectedAreas = new Set(checks.flatMap(check => check.id === 'selected-skill-craft-v1' ? check.selection.reviewAreas.map(area => area.id) : [...INDEPENDENT_REVIEW_AREA_IDS]))
  if (checks.length === 0) return
  const review = evidence.independentReview
  if (review === undefined) {
    if (required && expectedAreas.size > 0) fail('independent_review_missing', 'Review requires every declared independent review area with located evidence; prepare-only machine checks are not a review')
    return
  }
  if (!isIndependentReview(review) || review.areas.length !== expectedAreas.size || review.areas.some(area => !expectedAreas.has(area.id))) fail('independent_review_invalid', 'independentReview must exactly cover the frozen declared review areas (legacy v2: four), with unique IDs, bounded coverage and 1–8 located quotes (64KiB total limit)')
  const texts = new Map(checks.map(check => {
    const artifact = evidence.artifacts.find(item => item.id === check.md)
    return [check.md, artifact === undefined || artifact.encoding === 'base64' ? [] : markdownReviewBlocks(artifact.content)] as const
  }))
  const allowedMarkdownArtifactIds = [...texts.keys()]
  const issues: { areaId: string; evidenceIndex: number; artifactId: string; reason: string; allowedMarkdownArtifactIds: string[] }[] = []
  for (const area of review.areas) {
    for (const [evidenceIndex, quote] of area.evidence.entries()) {
      const text = texts.get(quote.artifactId)
      const reason = text === undefined ? 'unsupported_artifact'
        : normalizeReviewQuote(quote.quote) === '' ? 'empty_quote'
        : !hasMarkdownReviewQuote(text, quote.quote) ? 'quote_not_found' : undefined
      if (reason !== undefined) issues.push({ areaId: area.id, evidenceIndex, artifactId: quote.artifactId, reason, allowedMarkdownArtifactIds })
    }
  }
  if (issues.length > 0) fail('independent_review_quote_missing',
    `Independent review quote locations invalid: ${issues.map(issue => `${issue.areaId}[${issue.evidenceIndex}] artifact=${issue.artifactId}: ${issue.reason}`).join('; ')}. Allowed Markdown artifacts: ${allowedMarkdownArtifactIds.join(', ')}. Quote exact report prose or its Markdown source (inline code is allowed); HTML/PDF/ledger summaries are not Markdown anchors.`,
    { issues })
  for (const area of review.areas) {
    if (passing && area.status !== 'passed') fail('independent_review_failed', `independent review ${area.id} is ${area.status}; all declared areas must pass before integration`)
  }
}

function isArtifactCheckSpec(value: unknown, deliverables: readonly string[]): value is ArtifactCheckSpec {
  if (!record(value)) return false
  const selected = value.id === 'selected-skill-craft-v1'
  const selection = value.selection
  const v2 = value.id === 'zhijian-report-craft-core-v2'
  const roles = v2 || selected ? [value.md, value.html, value.pdf, value.craftEvidence] : [value.md, value.html, value.pdf]
  return (selected
    ? hasExactKeys(value, ['id', 'md', 'html', 'pdf', 'craftEvidence', 'selection']) && isFrozenSkillCraftContract(selection)
      && (['md', 'html', 'pdf', 'evidence'] as const).every(role => selection.artifactRoles.includes(role))
    : v2
      ? hasExactKeys(value, ['id', 'md', 'html', 'pdf', 'craftEvidence', 'materialPackId', 'materialDigest', 'style'])
        && value.materialPackId === 'zhijian-report-craft-v2' && digestString(value.materialDigest)
        && (value.style === 'credit-policy' || value.style === 'designer-paper')
      : value.id === 'zhijian-report-craft-core-v1' && hasExactKeys(value, ['id', 'md', 'html', 'pdf']))
    && roles.every(id => nonEmpty(id) && deliverables.includes(id))
    && new Set(roles).size === roles.length
}

function validArtifactChecks(value: unknown, deliverables: readonly string[]): value is readonly ArtifactCheckSpec[] {
  return Array.isArray(value) && value.every(spec => isArtifactCheckSpec(spec, deliverables))
    && new Set(value.map(spec => spec.id)).size === value.length
}

function digestString(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isArtifactCheckReceipt(value: unknown): value is ArtifactCheckReceipt {
  if (!record(value)) return false
  const selected = value.checkId === 'selected-skill-craft-v1'
  const v2 = value.checkId === 'zhijian-report-craft-core-v2'
  let ids: readonly string[] = v2 ? REPORT_CRAFT_V2_RESULT_IDS : REPORT_CRAFT_RESULT_IDS
  if (selected) {
    if (value.version !== 3 || !digestString(value.selectionDigest) || !Array.isArray(value.checkers)
      || value.checkers.length === 0 || value.checkers.length > 64
      || !value.checkers.every(check => record(check) && hasExactKeys(check, ['packId', 'id', 'version', 'sha256', 'resultIds'])
        && boundedText(check.packId, 256) && boundedText(check.id, 256) && boundedText(check.version, 256) && digestString(check.sha256)
        && Array.isArray(check.resultIds) && check.resultIds.length > 0 && check.resultIds.length <= 64
        && check.resultIds.every(id => boundedText(id, 256)))) return false
    ids = value.checkers.flatMap(check => check.resultIds)
    if (ids.length > 256 || new Set(ids).size !== ids.length
      || new Set(value.checkers.map(check => `${check.packId}:${check.id}`)).size !== value.checkers.length) return false
  }
  const count = v2 || selected ? 4 : 3
  return hasExactKeys(value, ['version', 'checkId', 'contractDigest', 'taskId', 'attempt', 'artifacts', 'results', ...(selected ? ['selectionDigest', 'checkers'] : v2 ? ['checkerVersion', 'materialDigest'] : [])])
    && (selected || (v2 ? value.version === 2 && typeof value.checkerVersion === 'string' && REPORT_CRAFT_V2_KNOWN_CHECKER_VERSIONS.includes(value.checkerVersion) && digestString(value.materialDigest)
      : value.version === 1 && value.checkId === 'zhijian-report-craft-core-v1'))
    && digestString(value.contractDigest) && nonEmpty(value.taskId) && positiveInteger(value.attempt)
    && Array.isArray(value.artifacts) && value.artifacts.length === count
    && value.artifacts.every(artifact => record(artifact) && hasExactKeys(artifact, ['id', 'sha256'])
      && nonEmpty(artifact.id) && digestString(artifact.sha256))
    && new Set(value.artifacts.map(artifact => artifact.id)).size === count
    && Array.isArray(value.results) && value.results.length === ids.length
    && value.results.every(result => record(result) && hasExactKeys(result, ['id', 'status', 'detail'])
      && ids.includes(result.id as string)
      && ['passed', 'failed', 'unverified'].includes(result.status as string) && (selected ? boundedText(result.detail, 16000) : nonEmpty(result.detail)))
    && new Set(value.results.map(result => result.id)).size === ids.length
}

/** Integrity checks retain failed/unverified observations for a negative review. */
export function validateArtifactCheckReceipts(contract: QualityContract, evidence: TaskEvidence, expectedAttempt: number): void {
  const specs = contract.artifactChecks ?? []
  const receipts = evidence.artifactCheckReceipts ?? []
  if (!Array.isArray(receipts) || receipts.length !== specs.length) fail('artifact_check_receipt_missing', 'Host artifact check receipts must exactly cover the contract checks')
  if (specs.length === 0) return
  const digest = qualityContractDigest(contract)
  for (const [index, spec] of specs.entries()) {
    const receipt = receipts[index]
    if (!isArtifactCheckReceipt(receipt)) fail('artifact_check_receipt_invalid', `invalid Host artifact check receipt for ${spec.id}`)
    if (receipt.checkId !== spec.id || receipt.contractDigest !== digest
      || receipt.taskId !== contract.taskId || receipt.attempt !== expectedAttempt) {
      fail('artifact_check_binding_mismatch', `Host artifact check ${spec.id} belongs to a different contract, task or attempt`)
    }
    if (spec.id === 'zhijian-report-craft-core-v2'
      && (receipt.version !== 2 || receipt.materialDigest !== spec.materialDigest)) {
      fail('artifact_check_binding_mismatch', `Host artifact check ${spec.id} belongs to different reference materials`)
    }
    if (spec.id === 'selected-skill-craft-v1') {
      const expected = spec.selection.checks.map(({ packId, id, version, sha256, resultIds }) => ({ packId, id, version, sha256, resultIds }))
      if (receipt.version !== 3 || receipt.selectionDigest !== spec.selection.digest || canonicalDigest(receipt.checkers) !== canonicalDigest(expected)) {
        fail('artifact_check_binding_mismatch', 'Selected-skill check receipt does not match the frozen selection/checker identities and result IDs')
      }
    }
    const roles = spec.id !== 'zhijian-report-craft-core-v1' ? [spec.md, spec.html, spec.pdf, spec.craftEvidence] : [spec.md, spec.html, spec.pdf]
    for (const [roleIndex, id] of roles.entries()) {
      const artifact = evidence.artifacts.find(item => item.id === id)
      const bound = receipt.artifacts[roleIndex]!
      if (artifact === undefined || bound.id !== id || bound.sha256 !== artifact.sha256) {
        fail('artifact_check_binding_mismatch', `Host artifact check ${spec.id} does not bind the exact ${id} evidence hash`)
      }
    }
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
  if (input.artifactChecks !== undefined && !validArtifactChecks(input.artifactChecks, input.deliverables)) {
    fail('invalid_contract', 'artifactChecks must contain unique known check IDs, distinct declared artifact roles and exact versioned fields; selected-skill checks require a valid frozen selection, and legacy v2 requires its trusted material identity')
  }
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
    ...(input.artifactChecks === undefined ? {} : { artifactChecks: structuredClone(input.artifactChecks) }),
  }
}

/** Completeness and types are independent of whether an acceptance check passed. */
export function validateAcceptanceResults(contract: QualityContract, results: readonly AcceptanceResult[]): void {
  if (!Array.isArray(results) || results.length === 0) fail('evidence_missing', 'acceptance_results are required')
  const ids = new Set<string>()
  for (const [index, result] of results.entries()) {
    if (result === null || typeof result !== 'object' || !nonEmpty(result.id) || typeof result.passed !== 'boolean') fail('acceptance_invalid', `acceptance_results[${index}] requires an id and a boolean passed result`)
    if (result.detail !== undefined && typeof result.detail !== 'string') fail('acceptance_invalid', `acceptance_results[${index}].detail must be a string`)
    if (contract.artifactChecks?.some(check => check.id !== 'zhijian-report-craft-core-v1') && !boundedText(result.detail, 8000)) {
      fail('acceptance_invalid', `craft acceptance_results[${index}].detail requires a nonempty evidence explanation (maximum 8000 characters); a boolean alone is not a review`)
    }
    if (ids.has(result.id)) fail('duplicate_acceptance', 'acceptance result ids must be unique')
    ids.add(result.id)
    if (!contract.acceptance.some(item => item.id === result.id)) fail('acceptance_unknown', `unknown acceptance criterion ${result.id}`)
  }
  for (const criterion of contract.acceptance) {
    if (!ids.has(criterion.id)) fail('acceptance_missing', `acceptance result ${criterion.id} is missing`)
  }
}

export function validateEvidencePaths(contract: QualityContract, paths: readonly string[]): void {
  if (!Array.isArray(paths) || paths.length === 0) fail('evidence_missing', 'changedPaths are required')
  for (const path of paths) {
    if (!nonEmpty(path) || !pathClean(path)) fail('path_out_of_scope', `unsafe changed path ${path}`)
    if ((contract.outOfScope ?? []).some(scope => pathMatches(path, scope))) fail('path_out_of_scope', `changed path is out of scope: ${path}`)
    const allowed = contract.inScope.some(scope => pathMatches(path, scope))
      && contract.changedPaths.some(scope => pathMatches(path, scope))
    if (!allowed) fail('path_out_of_scope', `changed path is outside contract scope: ${path}`)
  }
}

/** Validate complete, authentic evidence, retaining genuine negative observations. */
export function validateTaskEvidenceIntegrity(
  contract: QualityContract,
  evidence: TaskEvidence,
  expectedAttempt = contract.attempt,
): void {
  if (evidence.taskId !== contract.taskId) fail('task_mismatch', `evidence belongs to ${evidence.taskId}, expected ${contract.taskId}`)
  if (evidence.attempt !== expectedAttempt) fail('stale_attempt', `evidence attempt ${evidence.attempt} is stale; expected ${expectedAttempt}`)
  validateAcceptanceResults(contract, evidence.acceptanceResults)
  if (evidence.commandsRun.length === 0) fail('evidence_missing', 'commandsRun are required')
  validateEvidencePaths(contract, evidence.changedPaths)
  const artifactIds = new Set(evidence.artifacts.map(artifact => artifact.id))
  if (artifactIds.size !== evidence.artifacts.length) fail('duplicate_artifact', 'artifact ids must be unique')
  for (const id of contract.deliverables) {
    if (!artifactIds.has(id)) fail('artifact_missing', `deliverable artifact ${id} is missing`)
  }
  for (const command of evidence.commandsRun) {
    if (!nonEmpty(command.command) || !Number.isInteger(command.exitCode) || typeof command.passed !== 'boolean') fail('verification_invalid', 'verification receipt requires command, integer exitCode and boolean passed')
    if (command.passed && command.exitCode !== 0) fail('verification_invalid', `nonzero verification exit code cannot be marked passed: ${command.command}`)
  }
  for (const artifact of evidence.artifacts) {
    if (artifact.taskId !== contract.taskId || artifact.attempt !== expectedAttempt) fail('stale_artifact', `artifact ${artifact.id} belongs to a different task attempt`)
    if (!evidence.changedPaths.some(path => pathMatches(artifact.path, path))) fail('artifact_path_unlisted', `artifact path was not listed as changed: ${artifact.path}`)
    if (!pathClean(artifact.path) || contract.outOfScope.some(scope => pathMatches(artifact.path, scope))) fail('path_out_of_scope', `artifact path is out of scope: ${artifact.path}`)
    if (artifact.encoding !== undefined && artifact.encoding !== 'utf8' && artifact.encoding !== 'base64') {
      fail('artifact_encoding_invalid', `artifact ${artifact.id} has an unsupported content encoding`)
    }
    const bytes = Buffer.from(artifact.content, artifact.encoding ?? 'utf8')
    if (artifact.encoding === 'base64' && bytes.toString('base64') !== artifact.content) {
      fail('artifact_encoding_invalid', `artifact ${artifact.id} does not contain canonical base64 evidence`)
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== artifact.sha256) fail('artifact_hash_mismatch', `artifact ${artifact.id} hash does not match its content`)
  }
  validateArtifactCheckReceipts(contract, evidence, expectedAttempt)
  validateIndependentReview(contract, evidence)
}

/** Fresh mutations must not promote a readable historical check into current approval.
 * Call after integrity validation; exact recorded event replays bypass this guard
 * because they do not create a new approval or integration.
 */
export function validateArtifactCheckFreshness(evidence: TaskEvidence): void {
  for (const receipt of evidence.artifactCheckReceipts ?? []) {
    if (receipt.checkId === 'zhijian-report-craft-core-v2' && receipt.checkerVersion !== REPORT_CRAFT_V2_CHECKER_VERSION) {
      fail('artifact_check_stale', `Host artifact checks used ${receipt.checkerVersion}; a new review/integration requires ${REPORT_CRAFT_V2_CHECKER_VERSION}. Preserve the historical receipt and obtain a new Host preparation/review of the current immutable bytes.`)
    }
  }
}

/** Passing review and integration must satisfy every check, in addition to integrity. */
export function validateTaskEvidence(contract: QualityContract, evidence: TaskEvidence, expectedAttempt = contract.attempt): void {
  validateTaskEvidenceIntegrity(contract, evidence, expectedAttempt)
  for (const result of evidence.acceptanceResults) {
    if (!result.passed) fail('acceptance_failed', `acceptance criterion ${result.id} failed; record truthful negative evidence with needs_revision or reject`)
  }
  for (const command of evidence.commandsRun) {
    if (command.exitCode !== 0 || !command.passed) fail('verification_failed', `verification command failed: ${command.command}; a pass verdict requires successful verification`)
  }
  const failed = (evidence.artifactCheckReceipts ?? []).flatMap(receipt => receipt.results.filter(result => result.status !== 'passed'))
  if (failed.length > 0) fail('artifact_check_failed', `Host artifact checks did not pass: ${failed.map(result => `${result.id}=${result.status}: ${result.detail}`).join('; ')}. Record truthful findings with needs_revision/reject; acceptance booleans cannot override artifact checks.`, { results: failed })
  validateIndependentReview(contract, evidence, true, true)
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
    amendments: [],
  }
}

/**
 * Open a fresh review without granting old evidence authority over new work.
 * The caller archives the parent and installs this run atomically with its task
 * generation. Keeping a shrinking repair budget on each contract prevents a
 * sequence of revisions from resetting the original policy's limit.
 */
export function forkQualityRun(run: QualityRun, input: QualityForkInput): QualityMutation {
  if (!nonEmpty(input.eventId) || !nonEmpty(input.actor) || !nonEmpty(input.reason) || !nonEmpty(input.assignee)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1
    || (input.at !== undefined && !Number.isFinite(input.at))
    || (input.withdrawUnreviewed !== undefined && typeof input.withdrawUnreviewed !== 'boolean')) {
    fail('invalid_revision', 'eventId, actor, reason, assignee and a positive task attempt are required')
  }
  const digest = fingerprint({ type: 'revision', actor: input.actor, payload: {
    reason: input.reason, assignee: input.assignee, attempt: input.attempt,
    ...(input.withdrawUnreviewed === true ? { withdrawUnreviewed: true } : {}),
  } })
  if (run.revision?.eventId === input.eventId) {
    if (run.revision.fingerprint !== digest) fail('idempotency_conflict', `event ${input.eventId} was already applied with different content`)
    return { run, applied: false }
  }
  if (run.events.some(event => event.id === input.eventId)) {
    fail('idempotency_conflict', `event ${input.eventId} already belongs to the previous quality run`)
  }
  if (input.attempt < run.attempt) fail('stale_attempt', `revision attempt ${input.attempt} is stale; expected at least ${run.attempt}`)
  if (run.status === 'escalated') fail('repair_budget_exhausted', 'escalated quality runs require an explicit policy decision; reopening cannot bypass the repair budget')
  const identityChanged = input.attempt !== run.attempt || input.assignee !== run.contract.assignee
  const withdrawal = input.withdrawUnreviewed === true
  if (withdrawal && (input.actor !== 'captain' || identityChanged
    || (run.status !== 'pending' && run.status !== 'repairing')
    || run.evidenceHistory.some(evidence => evidence.attempt === run.attempt)
    || run.latestEvidence?.attempt === run.attempt)) {
    fail('invalid_withdrawal', 'only the captain may withdraw the same unreviewed pending/repairing generation; reviewed work must use the normal revision/repair policy')
  }
  if (run.status !== 'passed' && run.status !== 'integrated' && run.status !== 'blocked' && !identityChanged && !withdrawal) {
    fail('invalid_transition', `a ${run.status} run is already reviewable; reopening requires a changed task attempt or owner`)
  }
  // Initial assignment is not a repair. A migrated pending run retains any
  // budget reduction already imposed when its reviewed ancestor was forked.
  const unreviewed = run.status === 'pending' && run.reviewRounds === 0
    && run.evidenceHistory.length === 0 && run.latestEvidence === undefined
  // A withdrawal publishes no verdict and opens no new task generation. Carry
  // consumed repairs into the child budget without charging another repair.
  const budgetCharged = run.repairRounds + (unreviewed || withdrawal ? 0 : 1)
  const remaining = run.contract.maxRepairRounds - budgetCharged
  if (remaining < 0) fail('repair_budget_exhausted', 'the cumulative repair/revision budget is exhausted; an explicit policy decision is required')
  const identity = fingerprint({ parentRunId: run.runId, eventId: input.eventId })
  const next = createQualityRun({
    ...run.contract,
    id: `quality-contract-revision-${identity}`,
    attempt: input.attempt,
    assignee: input.assignee,
    maxRepairRounds: remaining,
  }, `quality-revision-${identity}`)
  return {
    applied: true,
    run: {
      ...next,
      ...(withdrawal && run.contractFrozenAt !== undefined ? { contractFrozenAt: run.contractFrozenAt } : {}),
      revision: {
        parentRunId: run.runId,
        eventId: input.eventId,
        actor: input.actor,
        reason: input.reason,
        at: input.at ?? Date.now(),
        fingerprint: digest,
        budgetCharged,
        ...(withdrawal ? { withdrawUnreviewed: true as const } : {}),
      },
    },
  }
}

/**
 * Amend a contract before its first review.  The replacement is validated as
 * a complete contract and every revision is retained as an append-only audit
 * entry.  Once review has started, the contract is frozen for the lifetime of
 * the run; callers must open a new run instead of silently moving the goal
 * posts.
 */
export function amendQualityRun(run: QualityRun, input: ContractAmendmentInput): QualityMutation {
  if (!nonEmpty(input.eventId) || !nonEmpty(input.actor) || !nonEmpty(input.reason)) fail('invalid_amendment', 'eventId, actor and reason are required')
  const digest = fingerprint({ type: 'amendment', actor: input.actor, payload: { contract: input.contract, reason: input.reason } })
  const existing = run.events.find(event => event.id === input.eventId)
  if (existing !== undefined) {
    if (existing.fingerprint !== digest) fail('idempotency_conflict', `event ${input.eventId} was already applied with different content`)
    return { run, applied: false }
  }
  if (run.status !== 'pending' || run.reviewRounds !== 0 || run.events.some(event => event.type !== 'amendment') || run.contractFrozenAt !== undefined) fail('contract_frozen', 'quality contract is frozen after review begins')
  const contract = createQualityContract(input.contract)
  if (contract.id !== run.contract.id || contract.taskId !== run.contract.taskId || contract.assignee !== run.contract.assignee || contract.attempt !== run.contract.attempt) fail('invalid_amendment', 'contract identity and initial attempt cannot change')
  if (run.revision !== undefined && contract.maxRepairRounds > run.contract.maxRepairRounds) fail('repair_budget_exhausted', 'contract amendments cannot restore a consumed revision budget')
  const previousDigest = fingerprint(run.contract)
  const nextDigest = fingerprint(contract)
  const previousRecord = run.contract as unknown as Record<string, unknown>
  const nextRecord = contract as unknown as Record<string, unknown>
  const fields = Object.keys(contract).filter(key => JSON.stringify(previousRecord[key]) !== JSON.stringify(nextRecord[key]))
  const at = input.at ?? Date.now()
  const amendment: QualityContractAmendment = { id: input.eventId, actor: input.actor, reason: input.reason, at, fields, previousDigest, nextDigest }
  const event: QualityEvent = { id: input.eventId, type: 'amendment', actor: input.actor, at, fingerprint: digest }
  return { applied: true, run: { ...run, contract, amendments: [...(run.amendments ?? []), amendment], events: [...run.events, event] } }
}

/** Validate review metadata before any filesystem reads or verification commands. */
export function validateReviewRequest(run: QualityRun, input: Omit<ReviewInput, 'evidence' | 'at'>): void {
  if (!nonEmpty(input.eventId) || !nonEmpty(input.reviewer)) fail('invalid_review', 'eventId and reviewer are required')
  if (!(REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) fail('invalid_review', `verdict=${String(input.verdict)} is invalid; allowed values: ${REVIEW_VERDICTS.join(', ')}`)
  if (input.reviewer === run.contract.assignee) fail('reviewer_is_assignee', 'reviewer must differ from assignee')
  const findings = input.findings ?? []
  if (!Array.isArray(findings)) fail('invalid_finding', 'findings must be an array')
  const ids = new Set<string>()
  for (const [index, finding] of findings.entries()) {
    if (finding === null || typeof finding !== 'object' || !nonEmpty(finding.id) || !nonEmpty(finding.code) || !nonEmpty(finding.message)) fail('invalid_finding', `findings[${index}] requires id, code and message`)
    if (!(FINDING_SEVERITIES as readonly string[]).includes(finding.severity)) fail('invalid_finding', `findings[${index}].severity=${String(finding.severity)} is invalid; allowed values: ${FINDING_SEVERITIES.join(', ')}`)
    if (ids.has(finding.id)) fail('invalid_finding', `duplicate finding id: ${finding.id}`)
    ids.add(finding.id)
    if (finding.taskId !== run.contract.taskId || finding.attempt !== run.attempt) fail('stale_finding', `findings[${index}] belongs to a different task/attempt; expected ${run.contract.taskId}/${run.attempt}`)
  }
  if (input.verdict === 'pass' && findings.some(finding => finding.severity === 'hard')) fail('hard_block', 'a hard finding cannot receive a pass verdict')
  if (input.verdict !== 'pass' && findings.length === 0) fail('finding_required', 'a non-pass review must include at least one finding')
  const duplicate = run.events.find(event => event.id === input.eventId)
  if (duplicate !== undefined) {
    if (duplicate.type !== 'review') fail('idempotency_conflict', `event ${input.eventId} belongs to ${duplicate.type}; use a new review event_id, such as review-${run.contract.taskId}-${run.attempt}-<unique>. Reuse an ID only for an exact retry of the same operation and payload`)
    return
  }
  if (run.status === 'integrated' || run.status === 'escalated') fail('terminal_run', `cannot review a ${run.status} run`)
  if (run.status !== 'pending' && run.status !== 'reviewing' && run.status !== 'repairing') fail('invalid_transition', `cannot review a ${run.status} run; the captain must use quality_repair or quality_reopen before a new review`)
}

/** Submit one review; duplicate event ids are idempotent. */
export function reviewQualityRun(run: QualityRun, input: ReviewInput): QualityMutation {
  validateReviewRequest(run, input)
  const duplicate = run.events.find(event => event.id === input.eventId)
  const digest = fingerprint({ type: 'review', actor: input.reviewer, payload: { verdict: input.verdict, findings: input.findings ?? [], evidence: input.evidence } })
  if (duplicate !== undefined) {
    if (duplicate.fingerprint !== digest) fail('idempotency_conflict', `event ${input.eventId} was already applied with different content; reuse only for an exact retry of the same operation and payload, otherwise use a new review event_id`)
    return { run, applied: false }
  }
  validateIndependentReview(run.contract, input.evidence, true)
  if (input.verdict === 'pass') validateTaskEvidence(run.contract, input.evidence, run.attempt)
  else validateTaskEvidenceIntegrity(run.contract, input.evidence, run.attempt)
  validateArtifactCheckFreshness(input.evidence)
  const findings = (input.findings ?? []).map(finding => ({ ...finding }))
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
      contractFrozenAt: run.contractFrozenAt ?? at,
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
    if (duplicate.fingerprint !== digest) fail('idempotency_conflict', `event ${input.eventId} was already applied with different content (${duplicate.type}); use a new integration event_id, such as integrate-${run.contract.taskId}-${run.attempt}-<unique>. Reuse only for an exact retry of the same operation and payload`)
    return { run, applied: false }
  }
  if (run.status !== 'passed') fail('integration_blocked', `integration requires a passed review (got ${run.status})`)
  if (run.latestEvidence === undefined) fail('evidence_missing', 'integration requires reviewed evidence')
  validateTaskEvidence(run.contract, run.latestEvidence, run.attempt)
  validateArtifactCheckFreshness(run.latestEvidence)
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
    || !Array.isArray(value.commandsRun) || !stringList(value.changedPaths)
    || (value.independentReview !== undefined && !isIndependentReview(value.independentReview))
    || (value.artifactCheckReceipts !== undefined && (!Array.isArray(value.artifactCheckReceipts)
      || !value.artifactCheckReceipts.every(isArtifactCheckReceipt)))) return false
  if (value.artifacts.some(artifact => !record(artifact)
    || !nonEmptyString(artifact.id)
    || !nonEmptyString(artifact.taskId)
    || !positiveInteger(artifact.attempt)
    || !nonEmptyString(artifact.path)
    || !nonEmptyString(artifact.sha256)
    || (artifact.encoding !== undefined && artifact.encoding !== 'utf8' && artifact.encoding !== 'base64')
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
    || (value.acceptance as unknown[]).length === 0
    || !stringList(value.verify, true)
    || !stringList(value.deliverables, true)
    || (value.artifactChecks !== undefined && !validArtifactChecks(value.artifactChecks, value.deliverables as string[]))
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

function isQualityAmendment(value: unknown): value is QualityContractAmendment {
  return record(value)
    && nonEmptyString(value.id)
    && nonEmptyString(value.actor)
    && nonEmptyString(value.reason)
    && finite(value.at)
    && stringList(value.fields)
    && nonEmptyString(value.previousDigest)
    && nonEmptyString(value.nextDigest)
}

function isQualityRevision(value: unknown): value is QualityRunRevision {
  return record(value)
    && nonEmptyString(value.parentRunId)
    && nonEmptyString(value.eventId)
    && nonEmptyString(value.actor)
    && nonEmptyString(value.reason)
    && finite(value.at)
    && nonEmptyString(value.fingerprint)
    && Number.isSafeInteger(value.budgetCharged)
    && (value.budgetCharged as number) >= 0
    && (value.budgetCharged as number) <= 2
    && (value.withdrawUnreviewed === undefined || value.withdrawUnreviewed === true)
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
    || (value.amendments !== undefined && !Array.isArray(value.amendments))
    || (value.revision !== undefined && !isQualityRevision(value.revision))
    || (value.contractFrozenAt !== undefined && !finite(value.contractFrozenAt))
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
  if (value.amendments !== undefined && value.amendments.some(amendment => !isQualityAmendment(amendment))) return false
  const eventIds = new Set<string>()
  if (value.events.some(event => !record(event)
    || !nonEmptyString(event.id)
    || !nonEmptyString(event.actor)
    || !finite(event.at)
    || !(event.type === 'amendment' || event.type === 'review' || event.type === 'repair' || event.type === 'integration')
    || !nonEmptyString(event.fingerprint)
    || eventIds.has(event.id as string)
    || (eventIds.add(event.id as string), false))) return false
  if (value.attempt !== (value.contract.attempt as number) + (value.repairRounds as number)) return false
  if (value.reviewRounds !== value.evidenceHistory.length) return false
  if (value.reviewRounds === 0 && value.latestEvidence !== undefined) return false
  if (value.reviewRounds > 0 && value.latestEvidence === undefined) return false
  if (value.status === 'integrated' && !value.events.some(event => event.type === 'integration')) return false
  if (value.status === 'passed' && value.lastVerdict !== 'pass') return false
  // These checks cross-reference the persisted contract, artifacts and receipt
  // identities. Known historical checker versions stay readable; freshness is
  // enforced at new review/integration mutations, not while loading history.
  try {
    for (const evidence of value.evidenceHistory as TaskEvidence[]) {
      validateArtifactCheckReceipts(value.contract as QualityContract, evidence, evidence.attempt)
      validateIndependentReview(value.contract as QualityContract, evidence, true)
      if ((value.contract as QualityContract).artifactChecks?.length) {
        if (evidence.attempt < (value.contract as QualityContract).attempt || evidence.attempt > (value.attempt as number)) return false
        validateTaskEvidenceIntegrity(value.contract as QualityContract, evidence, evidence.attempt)
      }
    }
    if (value.latestEvidence !== undefined) {
      validateArtifactCheckReceipts(value.contract as QualityContract, value.latestEvidence as TaskEvidence, (value.latestEvidence as TaskEvidence).attempt)
      validateIndependentReview(value.contract as QualityContract, value.latestEvidence as TaskEvidence, true)
      if ((value.contract as QualityContract).artifactChecks?.length) {
        validateTaskEvidenceIntegrity(value.contract as QualityContract, value.latestEvidence as TaskEvidence, (value.latestEvidence as TaskEvidence).attempt)
        if (canonicalDigest(value.latestEvidence) !== canonicalDigest(value.evidenceHistory.at(-1))) return false
      }
    }
    if ((value.contract as QualityContract).artifactChecks?.length && (value.status === 'passed' || value.status === 'integrated')) {
      validateTaskEvidence(value.contract as QualityContract, value.latestEvidence as TaskEvidence, value.attempt as number)
    }
  } catch { return false }
  return true
}

const QUALITY_RUN_STATUSES: readonly QualityRunStatus[] = [
  'pending', 'reviewing', 'blocked', 'repairing', 'passed', 'escalated', 'integrated',
]
