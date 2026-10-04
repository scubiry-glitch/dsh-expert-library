/** Host-authenticated, one-task delegated approval. Not a model-facing tool. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SharedTaskContext, StagedPlan } from './types.ts'
import { canonicalDigest } from './v2/digest.ts'
import { withTeamLock } from './state.ts'
import { readStagedPlan } from './staged-plan.ts'
import type { ExecutionPlan } from './v2/compiler.ts'

export const PLAN_AUTHORIZATION_SCOPE = 'single-plan-for-direct-user-input' as const
export interface PlanExecutionAuthorization {
  readonly schemaVersion: 1
  readonly requestId: string
  readonly captainSessionId: string
  readonly expectedInputSha256: string
  readonly scope: typeof PLAN_AUTHORIZATION_SCOPE
  readonly reason: string
  /** Authenticated task requirement; models cannot opt out through ad-hoc creation. */
  readonly requireReviewedReport?: true
  readonly authorizedBy: 'authenticated-host-user'
  readonly createdAt: number
  readonly expiresAt: number
  readonly revokedAt?: number
  readonly consumed?: { readonly planId: string; readonly digest: string; readonly revision: number; readonly contextSha256: string; readonly at: number }
}

/** Public recipe: SHA256(UTF8(JSON.stringify([direct-user texts in order]))).
 * Source ids/sequences are additionally pinned by the plan context digest. */
export function planInputSha256(context: SharedTaskContext): string | undefined {
  return context.status !== 'captured' ? undefined : canonicalDigest(context.messages.map(message => message.text))
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
function file(root: string, captain: string): string { return join(root, 'plans', 'authorizations', `${sha(captain)}.json`) }
function lock(root: string, captain: string): string { return `plan-authorization:${root}:${sha(captain)}` }
async function save(root: string, value: PlanExecutionAuthorization): Promise<void> {
  const path = file(root, value.captainSessionId)
  await mkdir(join(root, 'plans', 'authorizations'), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temporary, path)
  // Every grant/revocation/consumption keeps its own immutable event receipt.
  const event = `${sha(JSON.stringify(value))}.json`
  await writeFile(join(root, 'plans', 'authorizations', event), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
}
export async function readPlanExecutionAuthorization(root: string, captain: string): Promise<PlanExecutionAuthorization | undefined> {
  try {
    const value = JSON.parse(await readFile(file(root, captain), 'utf8')) as PlanExecutionAuthorization
    if (value.schemaVersion !== 1 || value.captainSessionId !== captain || value.scope !== PLAN_AUTHORIZATION_SCOPE
      || !/^[a-f0-9]{64}$/u.test(value.expectedInputSha256) || typeof value.reason !== 'string' || !value.reason.trim()
      || typeof value.requestId !== 'string' || !value.requestId.trim() || value.authorizedBy !== 'authenticated-host-user'
      || (value.requireReviewedReport !== undefined && value.requireReviewedReport !== true)
      || !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt)) throw new Error('PLAN_AUTHORIZATION_INVALID')
    return value
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}

/** Called only by the authenticated Host management route. Empty-session
 * preauthorization pins the exact future input; no wildcard or /goal inference. */
export async function authorizePlanExecution(root: string, captain: string, context: SharedTaskContext, input: {
  requestId: string; expectedInputSha256: string; reason: string; scope: typeof PLAN_AUTHORIZATION_SCOPE; requireReviewedReport?: true
}): Promise<PlanExecutionAuthorization> {
  if ((input.requireReviewedReport !== undefined && input.requireReviewedReport !== true) || input.scope !== PLAN_AUTHORIZATION_SCOPE || !/^[a-f0-9]{64}$/u.test(input.expectedInputSha256)
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.requestId) || !input.reason.trim() || input.reason.length > 4096
    || context.captainSessionId !== captain) throw new Error('PLAN_AUTHORIZATION_INVALID_INPUT')
  const actual = planInputSha256(context)
  if (actual !== undefined && actual !== input.expectedInputSha256) throw new Error('PLAN_AUTHORIZATION_INPUT_DIGEST_MISMATCH')
  if (context.status === 'unavailable' && context.unavailableReason !== 'no_own_direct_user_input') throw new Error('PLAN_AUTHORIZATION_USER_HISTORY_UNAVAILABLE')
  return withTeamLock(lock(root, captain), async () => {
    const old = await readPlanExecutionAuthorization(root, captain)
    if (old?.requestId === input.requestId) {
      if (old.expectedInputSha256 !== input.expectedInputSha256 || old.reason !== input.reason || old.scope !== input.scope || old.requireReviewedReport !== input.requireReviewedReport) throw new Error('PLAN_AUTHORIZATION_REQUEST_ID_CONFLICT')
      return old
    }
    if (old !== undefined && old.revokedAt === undefined) throw new Error('PLAN_AUTHORIZATION_EXISTS: revoke the existing grant before replacing it')
    const now = Date.now()
    const value: PlanExecutionAuthorization = { schemaVersion: 1, ...input, captainSessionId: captain,
      authorizedBy: 'authenticated-host-user', createdAt: now, expiresAt: now + 24 * 60 * 60 * 1000 }
    await save(root, value)
    return value
  })
}
export async function revokePlanExecution(root: string, captain: string, requestId: string): Promise<PlanExecutionAuthorization> {
  return withTeamLock(lock(root, captain), async () => {
    const old = await readPlanExecutionAuthorization(root, captain)
    if (old === undefined || old.requestId !== requestId) throw new Error('PLAN_AUTHORIZATION_NOT_FOUND')
    if (old.revokedAt !== undefined) return old
    const value = { ...old, revokedAt: Date.now() }
    await save(root, value)
    return value
  })
}
export async function delegatedPlanApproval(root: string, plan: StagedPlan, consume = false): Promise<PlanExecutionAuthorization | undefined> {
  return withTeamLock(lock(root, plan.createdBy), async () => {
    const grant = await readPlanExecutionAuthorization(root, plan.createdBy)
    const context = plan.runtime.sharedTaskContext
    if (grant === undefined || grant.revokedAt !== undefined || grant.expiresAt <= Date.now()
      || context === undefined || planInputSha256(context) !== grant.expectedInputSha256) return undefined
    if (grant.requireReviewedReport === true) assertReviewedReportPlan(plan.plan)
    if (grant.consumed !== undefined) return grant.consumed.planId === plan.planId && grant.consumed.digest === plan.digest
      && grant.consumed.revision === plan.revision && grant.consumed.contextSha256 === context.sha256 ? grant : undefined
    if (!consume) return grant
    const consumed = { planId: plan.planId, digest: plan.digest, revision: plan.revision, contextSha256: context.sha256, at: Date.now() }
    const value = { ...grant, consumed }
    await save(root, value)
    return value
  })
}

/** Validate structure only. Skill selection and business judgments remain the AI's job. */
export function assertReviewedReportPlan(plan: ExecutionPlan): void {
  // Omission and an empty policy both mean enabled, exactly as applyExecutionPlan.
  if (plan.reviewPolicy?.required === false || !plan.tasks.some(task => task.reportBundle?.craft?.version === 3 && task.frozenSkillCraftContract !== undefined)) {
    throw new Error('REVIEWED_REPORT_PLAN_REQUIRED: this exact user task requires structured independent review and a final MD/HTML/PDF producer with an explicit v3 reportBundle. Inspect the scoped craft catalog, select compatible skills, and stage or edit the plan before approval. Do not create an ad-hoc substitute.')
  }
}

/** Expiry removes delegated approval authority, not the user's delivery requirement. */
async function matchingReportRequirement(root: string, captain: string, context: SharedTaskContext): Promise<boolean> {
  const grant = await readPlanExecutionAuthorization(root, captain)
  return grant?.requireReviewedReport === true && grant.revokedAt === undefined && planInputSha256(context) === grant.expectedInputSha256
}
export async function requireAuthorizedReportPlan(root: string, captain: string, context: SharedTaskContext, plan: ExecutionPlan): Promise<void> {
  if (await matchingReportRequirement(root, captain, context)) assertReviewedReportPlan(plan)
}

/** Only the internal apply path supplies a compiled plan. Re-read durable approval;
 * a claimed plan id or an arbitrary object is insufficient to materialize a team. */
export async function requireAuthorizedTeamCreation(root: string, captain: string, context: SharedTaskContext, plan?: ExecutionPlan): Promise<void> {
  if (!await matchingReportRequirement(root, captain, context)) return
  if (plan === undefined) throw new Error('REVIEWED_REPORT_PLAN_REQUIRED: this exact user task requires a staged plan with a v3 reportBundle and independent review. Use expert_teams_plan_stage and approve its exact revision; ad-hoc team creation cannot satisfy this requirement.')
  assertReviewedReportPlan(plan)
  const stored = await readStagedPlan(root, plan.planId)
  if (stored?.createdBy !== captain || stored.status !== 'running' || stored.plan.digest !== plan.digest
    || stored.approval?.digest !== stored.digest || stored.approval.revision !== stored.revision
    || stored.approval.contextSha256 !== context.sha256 || stored.runtime.sharedTaskContext?.sha256 !== context.sha256
    || canonicalDigest(stored.plan) !== canonicalDigest(plan)) throw new Error('REVIEWED_REPORT_APPROVAL_REQUIRED: only the current durable approved plan may create this team')
}
