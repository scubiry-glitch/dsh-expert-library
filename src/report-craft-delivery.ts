/** Host-owned role delivery. Skill materials are not user messages or reviewed business artifacts. */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TeamState, TeamTask } from './types.ts'
import { resolveCraftMaterials, verifyCraftMaterials } from './report-craft-materials.ts'
import { resolveSelectedSkillMaterials, verifyFrozenSkillCraftContract } from './skill-craft.ts'
import { isReportCraftBinding, reportArtifactCheck } from './report-bundle.ts'
import { canonicalDigest } from './v2/digest.ts'
import { qualityContractDigest, type ArtifactEvidence, type QualityRun } from './quality-run.ts'

export type CraftRole = 'writer' | 'renderer' | 'reviewer'
interface CraftDeliveryBase {
  id: string; taskId: string; attempt: number; sessionId: string; role: CraftRole;
  entries: { id: string; path: string; sha256: string; bytes: number; packId?: string; skillId?: string }[];
  contentSha256: string; bytes: number; deliveredAt: number;
  channel: 'assignment' | 'claim' | 'review-preparation'; accepted: boolean;
}
export type CraftDeliveryReceipt = CraftDeliveryBase & (
  | { version: 1; materialPackId: string; materialDigest: string; style: 'credit-policy' | 'designer-paper' }
  | { version: 2; selectionDigest: string }
)
interface CraftReviewPreparationBase {
  receiptId: string; sessionId: string; taskId: string; attempt: number;
  runId: string; contractDigest: string; artifacts: { id: string; sha256: string }[];
}
export type CraftReviewPreparation = CraftReviewPreparationBase & (
  | { materialDigest: string; selectionDigest?: never }
  | { selectionDigest: string; materialDigest?: never }
)
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function materialsFor(task: TeamTask, role: CraftRole) {
  const craft = task.reportBundle?.craft
  if (craft === undefined) throw new Error('CRAFT_MATERIALS_NOT_SELECTED: this task has no explicit craft selection')
  if (craft.version === 3) {
    if (!isReportCraftBinding(task.reportBundle, task.frozenSkillCraftContract)) throw new Error('SKILL_CRAFT_CONTRACT_MISMATCH: missing or mismatched frozen selection')
    return resolveSelectedSkillMaterials(task.frozenSkillCraftContract!, role)
  }
  return resolveCraftMaterials({ style: craft.style, role })
}

function materialEntries(materials: ReturnType<typeof materialsFor>): CraftDeliveryBase['entries'] {
  return materials.entries.map(entry => ({ id: entry.id, path: entry.path, sha256: entry.sha256, bytes: entry.bytes,
    ...('packId' in entry ? { packId: entry.packId, skillId: entry.skillId } : {}),
  }))
}

export function prepareCraftDelivery(task: TeamTask, sessionId: string, attempt: number, roles: readonly CraftRole[], channel: CraftDeliveryReceipt['channel']): { content: string; receipts: CraftDeliveryReceipt[] } {
  const craft = task.reportBundle?.craft
  if (craft === undefined) return { content: '', receipts: [] }
  const bodies: string[] = []
  const receipts: CraftDeliveryReceipt[] = roles.map(role => {
    const materials = materialsFor(task, role)
    bodies.push(materials.content)
    const identity = craft.version === 3
      ? { version: 2 as const, selectionDigest: task.frozenSkillCraftContract!.digest }
      : { version: 1 as const, materialPackId: 'materialPackId' in materials ? materials.materialPackId : '',
          materialDigest: 'materialDigest' in materials ? materials.materialDigest : '', style: craft.style }
    return { ...identity, id: randomUUID(), taskId: task.id, attempt, sessionId, role,
      entries: materialEntries(materials), contentSha256: hash(materials.content), bytes: materials.bytes,
      deliveredAt: Date.now(), channel, accepted: channel !== 'assignment' }
  })
  const identity = craft.version === 3 ? `selected skills ${craft.selections.map(s => `${s.packId}/${s.skillId}`).join(', ')}, selection digest ${task.frozenSkillCraftContract!.digest}`
    : `legacy material pack ${receipts[0]!.version === 1 ? receipts[0]!.materialPackId : ''}, style ${craft.style}`
  const content = [
    `Host report craft materials — ${identity}, roles ${roles.join(', ')}.`,
    'These are task craft instructions and examples, separate from the original user request. Required bodies follow in full. Reference reports contain historical business data and are not evidence for this task.',
    ...bodies,
  ].join('\n')
  if (Buffer.byteLength(content, 'utf8') > 48 * 1024) throw new Error('CRAFT_DELIVERY_BUDGET: combined mandatory materials exceed 48 KiB; no silent truncation')
  return { content, receipts }
}

export function saveCraftDelivery(task: TeamTask, receipts: readonly CraftDeliveryReceipt[]): void {
  if (receipts.length === 0) return
  const keys = new Set(receipts.filter(r => r.role !== 'reviewer').map(r => `${r.attempt}:${r.sessionId}:${r.role}`))
  task.craftDeliveries = [...(task.craftDeliveries ?? []).filter(r => !keys.has(`${r.attempt}:${r.sessionId}:${r.role}`)), ...receipts]
}

function reportCheck(task: TeamTask, run: QualityRun) {
  const check = run.contract.artifactChecks?.find(c => c.id === 'zhijian-report-craft-core-v2' || c.id === 'selected-skill-craft-v1')
  if (check?.id === 'selected-skill-craft-v1') {
    if (task.reportBundle === undefined || canonicalDigest(reportArtifactCheck(task.reportBundle, task.frozenSkillCraftContract)) !== canonicalDigest(check)) throw new Error('SKILL_CRAFT_CONTRACT_MISMATCH: task materials and quality checks must bind the same selected contract')
    verifyFrozenSkillCraftContract(check.selection)
  }
  return check
}

function matchesIdentity(receipt: CraftDeliveryReceipt, check: NonNullable<ReturnType<typeof reportCheck>>): boolean {
  return check.id === 'selected-skill-craft-v1'
    ? receipt.version === 2 && receipt.selectionDigest === check.selection.digest
    : check.id === 'zhijian-report-craft-core-v2' && receipt.version === 1
      && receipt.materialDigest === check.materialDigest && receipt.style === check.style && receipt.materialPackId === check.materialPackId
}

function requireMaterialBytes(task: TeamTask, receipt: CraftDeliveryReceipt): void {
  const current = materialsFor(task, receipt.role)
  if (receipt.contentSha256 !== hash(current.content) || receipt.bytes !== current.bytes
    || canonicalDigest(receipt.entries) !== canonicalDigest(materialEntries(current))) throw new Error(`CRAFT_DELIVERY_STALE: ${receipt.role}; receipt does not cover the current complete mandatory materials`)
}

export function requireCraftProducerDelivery(team: TeamState, task: TeamTask, run: QualityRun): void {
  const check = reportCheck(task, run)
  if (check === undefined) return
  const sessionId = task.assignee === 'captain' ? team.captainSessionId : team.members.find(m => m.name === task.assignee)?.id
  for (const role of ['writer', 'renderer'] as const) {
    const receipt = task.craftDeliveries?.find(r => r.attempt === run.attempt && r.sessionId === sessionId && r.role === role && r.accepted)
    if (receipt === undefined || !matchesIdentity(receipt, check)) throw new Error(`CRAFT_MATERIALS_NOT_DELIVERED: ${task.id}/${run.attempt}/${role}; claim this task to obtain complete current materials before generating or submitting its report`)
    requireMaterialBytes(task, receipt)
  }
}

export function bindCraftReviewPreparation(task: TeamTask, run: QualityRun, receipt: CraftDeliveryReceipt, artifacts: readonly ArtifactEvidence[]): CraftReviewPreparation {
  const preparation: CraftReviewPreparation = { runId: run.runId, contractDigest: qualityContractDigest(run.contract), receiptId: receipt.id,
    sessionId: receipt.sessionId, taskId: task.id, attempt: receipt.attempt,
    ...(receipt.version === 1 ? { materialDigest: receipt.materialDigest } : { selectionDigest: receipt.selectionDigest }),
    artifacts: artifacts.map(({ id, sha256 }) => ({ id, sha256 })) }
  if ((task.craftReviewPreparations?.length ?? 0) >= 24) throw new Error('CRAFT_PREPARATION_BUDGET: 24 preparation receipts already retained; no automatic preflight loop. Resolve the task blocker explicitly.')
  task.craftReviewPreparations = [...(task.craftReviewPreparations ?? []), preparation]
  return preparation
}

export function requireCraftReviewPreparation(task: TeamTask, run: QualityRun, sessionId: string, receiptId: string | undefined, artifacts: readonly ArtifactEvidence[]): void {
  const check = reportCheck(task, run)
  if (check === undefined) return
  const preparation = task.craftReviewPreparations?.find(p => p.receiptId === receiptId && p.sessionId === sessionId && p.attempt === run.attempt && p.taskId === task.id)
  const receipt = task.craftDeliveries?.find(r => r.id === receiptId && r.role === 'reviewer' && r.accepted && r.sessionId === sessionId && r.attempt === run.attempt)
  if (preparation === undefined || receipt === undefined || preparation.runId !== run.runId || preparation.contractDigest !== qualityContractDigest(run.contract)
    || (check.id === 'selected-skill-craft-v1' ? preparation.selectionDigest !== check.selection.digest : preparation.materialDigest !== check.materialDigest)) throw new Error('CRAFT_REVIEW_PREPARATION_REQUIRED: first call quality_review with prepare_only:true, task_id and reviewer; use its material_receipt for this exact reviewer session and attempt')
  if (check.id === 'zhijian-report-craft-core-v2') verifyCraftMaterials({ style: check.style, materialDigest: check.materialDigest })
  if (!matchesIdentity(receipt, check)) throw new Error('CRAFT_REVIEW_DELIVERY_STALE: reviewer material identity differs from the frozen contract')
  requireMaterialBytes(task, receipt)
  if (canonicalDigest(preparation.artifacts) !== canonicalDigest(artifacts.map(({ id, sha256 }) => ({ id, sha256 })))) throw new Error('CRAFT_REVIEW_PREPARATION_STALE: report bytes changed after preparation; prepare and inspect the current versions again')
}

/** Reassemble mandatory bodies on every model step, including after compaction/restart. */
export function craftSessionContext(stateRoot: string, sessionId: string): string {
  let dirs: string[]
  try { dirs = readdirSync(stateRoot) } catch { return '' }
  const packets: string[] = []
  for (const dir of dirs) {
    let team: TeamState
    try { team = JSON.parse(readFileSync(join(stateRoot, dir, 'team.json'), 'utf8')) as TeamState } catch { continue }
    if (!Array.isArray(team.tasks) || !Array.isArray(team.members) || !team.members.some(m => m.id === sessionId) && team.captainSessionId !== sessionId) continue
    for (const task of team.tasks) {
      if (task.reportBundle?.craft === undefined || ['completed', 'failed', 'cancelled'].includes(task.status)) continue
      const roles = [...new Set((task.craftDeliveries ?? []).filter(r => r.sessionId === sessionId && r.attempt === task.attempt && (r.accepted || r.channel === 'assignment' && task.dispatch?.attemptId === task.attemptId)).map(r => r.role))]
      if (roles.length === 0) continue
      try { packets.push(prepareCraftDelivery(task, sessionId, task.attempt ?? 1, roles, 'claim').content) }
      catch (error) { packets.push(`CRAFT_MATERIALS_BLOCKED: ${String(error)}. Stop dependent report work; restore the frozen materials before continuing. Never replace missing mandatory content with memory.`) }
    }
  }
  if (Buffer.byteLength(packets.join('\n'), 'utf8') > 64 * 1024) throw new Error('CRAFT_CONTEXT_BUDGET: active report materials exceed 64 KiB; task work must pause, not silently truncate')
  return packets.join('\n\n')
}

export function isCraftDeliveryReceipt(value: unknown): value is CraftDeliveryReceipt {
  if (value === null || typeof value !== 'object') return false
  const r = value as CraftDeliveryReceipt
  return (r.version === 1 ? r.materialPackId === 'zhijian-report-craft-v2' && digest(r.materialDigest) && ['credit-policy', 'designer-paper'].includes(r.style)
    : r.version === 2 && digest(r.selectionDigest))
    && typeof r.id === 'string' && typeof r.taskId === 'string' && Number.isSafeInteger(r.attempt) && r.attempt > 0
    && typeof r.sessionId === 'string' && ['writer', 'renderer', 'reviewer'].includes(r.role) && digest(r.contentSha256)
    && Number.isSafeInteger(r.bytes) && r.bytes > 0 && Number.isFinite(r.deliveredAt) && typeof r.accepted === 'boolean'
    && ['assignment', 'claim', 'review-preparation'].includes(r.channel) && Array.isArray(r.entries) && r.entries.length > 0
    && r.entries.every(e => typeof e.id === 'string' && typeof e.path === 'string' && digest(e.sha256) && Number.isSafeInteger(e.bytes) && e.bytes > 0
      && (r.version !== 2 || typeof e.packId === 'string' && typeof e.skillId === 'string'))
}

export function isCraftReviewPreparation(value: unknown): value is CraftReviewPreparation {
  if (value === null || typeof value !== 'object') return false
  const p = value as CraftReviewPreparation
  return typeof p.runId === 'string' && digest(p.contractDigest) && typeof p.receiptId === 'string' && typeof p.sessionId === 'string' && typeof p.taskId === 'string'
    && Number.isSafeInteger(p.attempt) && p.attempt > 0 && (digest(p.materialDigest) && p.selectionDigest === undefined || digest(p.selectionDigest) && p.materialDigest === undefined)
    && Array.isArray(p.artifacts) && p.artifacts.length > 0 && new Set(p.artifacts.map(a => a.id)).size === p.artifacts.length
    && p.artifacts.every(a => typeof a.id === 'string' && digest(a.sha256))
}
