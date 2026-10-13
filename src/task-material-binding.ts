/** Host-frozen task instructions from plugin prompts and registered plugin/domain skills. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalDigest } from './v2/digest.ts'
import type { TeamTask } from './types.ts'

export const TASK_MATERIAL_PACK = 'dsh-expert-library'
export const DOMAIN_MATERIAL_PACK = 'zhijian-realestate'
type SkillPackId = typeof TASK_MATERIAL_PACK | typeof DOMAIN_MATERIAL_PACK
const MAX_FILE_BYTES = 24 * 1024
const MAX_TOTAL_BYTES = 48 * 1024
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA = /^[a-f0-9]{64}$/
const root = fileURLToPath(new URL('../knowledge/', import.meta.url))
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..')
function fail(code: string, detail: string): never { throw new Error(`TASK_BINDING_${code}: ${detail}`) }

export interface TaskSkillBinding {
  readonly packId: SkillPackId
  readonly skillId: string
  readonly materialRole: 'producer'
  readonly required: true
  readonly reason: string
}
export interface TaskPromptBinding {
  readonly packId: typeof TASK_MATERIAL_PACK
  readonly templateId: string
  readonly required: true
  readonly variables: readonly string[]
}
export interface FrozenTaskMaterialContract {
  readonly version: 1
  readonly digest: string
  readonly skills: readonly { readonly packId: SkillPackId; readonly skillId: string; readonly materialRole: 'producer'; readonly reason: string; readonly path: string; readonly sha256: string; readonly bytes: number; readonly packVersion?: string; readonly packRoot?: string }[]
  readonly prompt: { readonly packId: typeof TASK_MATERIAL_PACK; readonly templateId: string; readonly path: string; readonly sha256: string; readonly bytes: number }
}
export interface TaskMaterialDeliveryReceipt {
  id: string
  attempt: number
  sessionId: string
  role: 'producer' | 'reviewer'
  digest: string
  contentSha256: string
  artifactDigest?: string
  deliveredAt: number
  accepted: boolean
}
export function isTaskMaterialDeliveryReceipt(value: unknown): value is TaskMaterialDeliveryReceipt {
  return record(value) && typeof value.id === 'string' && value.id.length > 0
    && Number.isSafeInteger(value.attempt) && (value.attempt as number) >= 1
    && typeof value.sessionId === 'string' && value.sessionId.length > 0
    && (value.role === 'producer' || value.role === 'reviewer')
    && typeof value.digest === 'string' && SHA.test(value.digest)
    && typeof value.contentSha256 === 'string' && SHA.test(value.contentSha256)
    && (value.artifactDigest === undefined || typeof value.artifactDigest === 'string' && SHA.test(value.artifactDigest))
    && typeof value.deliveredAt === 'number' && Number.isFinite(value.deliveredAt)
    && typeof value.accepted === 'boolean'
}

export function isTaskSkillBinding(value: unknown): value is TaskSkillBinding {
  return record(value) && Object.keys(value).length === 5 && (value.packId === TASK_MATERIAL_PACK || value.packId === DOMAIN_MATERIAL_PACK)
    && safeId(value.skillId) && value.materialRole === 'producer' && value.required === true
    && typeof value.reason === 'string' && value.reason.trim().length > 0 && value.reason.length <= 500
}
export function isTaskPromptBinding(value: unknown): value is TaskPromptBinding {
  return record(value) && Object.keys(value).length === 4 && value.packId === TASK_MATERIAL_PACK
    && safeId(value.templateId) && value.required === true && Array.isArray(value.variables)
    && value.variables.length === 0 // Fixed templates are immutable; reviewed task inputs are delivered separately.
}
export function isTaskMaterialSelection(skills: unknown, prompt: unknown): boolean {
  return Array.isArray(skills) && skills.length >= 1 && skills.length <= 4
    && skills.every(isTaskSkillBinding)
    && new Set(skills.map(skill => `${skill.packId}/${skill.skillId}`)).size === skills.length
    && isTaskPromptBinding(prompt)
}

export interface ScopedTaskMaterialSkill { readonly packId: typeof DOMAIN_MATERIAL_PACK; readonly skillId: string; readonly root: string; readonly packVersion: string }

function domainRoot(path: string): { path: string; version: string } {
  if (!isAbsolute(path) || realpathSync(path) !== path) fail('PATH', DOMAIN_MATERIAL_PACK)
  const manifest = JSON.parse(readFileSync(join(path, 'pack.json'), 'utf8')) as { id?: unknown; version?: unknown }
  if (manifest.id !== DOMAIN_MATERIAL_PACK || !safeId(manifest.version)) fail('PACK_UNAVAILABLE', DOMAIN_MATERIAL_PACK)
  return { path, version: manifest.version }
}

function readOwned(path: string, folder: string, packId: SkillPackId, packRoot?: string): { sha256: string; bytes: number; content: string } {
  const expectedRoot = packId === TASK_MATERIAL_PACK ? realpathSync(root) : domainRoot(packRoot ?? fail('SCOPE', 'domain pack root is required')).path
  const expectedFolder = realpathSync(join(expectedRoot, folder))
  if (expectedFolder !== expectedRoot + sep + folder) fail('PATH', folder)
  const expectedPath = realpathSync(path)
  if (expectedPath !== path || !expectedPath.startsWith(expectedFolder + sep)) fail('PATH', path)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_FILE_BYTES) fail('FILE', path)
  const raw = readFileSync(path)
  const after = lstatSync(path)
  if (after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs || after.size !== raw.length) fail('DRIFT', path)
  let content: string
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw) } catch { return fail('ENCODING', path) }
  return { sha256: hash(raw), bytes: raw.length, content }
}

function skillPath(packId: SkillPackId, id: string, packRoot?: string): string {
  return join(packId === TASK_MATERIAL_PACK ? root : packRoot ?? fail('SCOPE', 'domain pack root is required'), 'skills', id, 'SKILL.md')
}
function promptPath(id: string): string { return join(root, 'task-prompts', `${id}.md`) }

/** The Host resolves IDs; AI JSON never supplies a path, version or digest. */
export function resolveTaskMaterialContract(skills: readonly TaskSkillBinding[], prompt: TaskPromptBinding, scopedSkills: readonly ScopedTaskMaterialSkill[] = []): FrozenTaskMaterialContract {
  if (!isTaskMaterialSelection(skills, prompt)) fail('SELECTION', 'expected 1–4 distinct registered skills and one fixed plugin prompt')
  const entries = skills.map(skill => {
    const scoped = skill.packId === DOMAIN_MATERIAL_PACK ? scopedSkills.find(row => row.packId === skill.packId && row.skillId === skill.skillId) : undefined
    if (skill.packId === DOMAIN_MATERIAL_PACK && scoped === undefined) fail('SKILL_UNAVAILABLE', `${skill.packId}/${skill.skillId} is not in the Host-active pack catalog`)
    const packRoot = scoped?.root
    const path = skillPath(skill.packId, skill.skillId, packRoot)
    let source: ReturnType<typeof readOwned>
    let packVersion: string | undefined
    try {
      if (skill.packId === DOMAIN_MATERIAL_PACK) {
        packVersion = domainRoot(packRoot!).version
        if (packVersion !== scoped?.packVersion) fail('PACK_DRIFT', `${skill.packId} active catalog version changed`)
        const declaration = JSON.parse(readFileSync(join(packRoot!, 'skills', skill.skillId, 'skill.json'), 'utf8')) as { id?: unknown }
        if (declaration.id !== skill.skillId) fail('SKILL_UNAVAILABLE', `${skill.packId}/${skill.skillId} is not registered`)
      }
      source = readOwned(path, 'skills', skill.packId, packRoot)
    } catch (error) { return fail('SKILL_UNAVAILABLE', `${skill.packId}/${skill.skillId}: ${String(error)}`) }
    return { packId: skill.packId, skillId: skill.skillId, materialRole: skill.materialRole, reason: skill.reason, path, sha256: source.sha256, bytes: source.bytes,
      ...(packVersion === undefined ? {} : { packVersion, packRoot }) } as const
  })
  const path = promptPath(prompt.templateId)
  let source: ReturnType<typeof readOwned>
  try { source = readOwned(path, 'task-prompts', TASK_MATERIAL_PACK) } catch (error) { return fail('PROMPT_UNAVAILABLE', `${prompt.templateId}: ${String(error)}`) }
  const resolvedPrompt = { packId: TASK_MATERIAL_PACK, templateId: prompt.templateId, path, sha256: source.sha256, bytes: source.bytes } as const
  if (entries.reduce((sum, item) => sum + item.bytes, source.bytes) > MAX_TOTAL_BYTES) fail('BUDGET', 'complete mandatory task materials exceed 48 KiB')
  const body = { version: 1 as const, skills: entries, prompt: resolvedPrompt }
  return { ...body, digest: canonicalDigest(body) }
}

export function isFrozenTaskMaterialContract(value: unknown): value is FrozenTaskMaterialContract {
  if (!record(value) || value.version !== 1 || typeof value.digest !== 'string' || !SHA.test(value.digest)
    || !Array.isArray(value.skills) || value.skills.length < 1 || value.skills.length > 4 || !record(value.prompt)) return false
  const skillRows = value.skills as unknown[]
  if (!skillRows.every(row => record(row) && Object.keys(row).length === (row.packId === DOMAIN_MATERIAL_PACK ? 9 : 7)
    && (row.packId === TASK_MATERIAL_PACK || row.packId === DOMAIN_MATERIAL_PACK)
    && safeId(row.skillId) && row.materialRole === 'producer' && typeof row.reason === 'string' && row.reason.length > 0
    && (row.packId === TASK_MATERIAL_PACK
      ? row.packVersion === undefined && row.packRoot === undefined && row.path === skillPath(row.packId, row.skillId)
      : safeId(row.packVersion) && typeof row.packRoot === 'string' && isAbsolute(row.packRoot)
        && row.path === skillPath(row.packId, row.skillId, row.packRoot))
    && typeof row.sha256 === 'string' && SHA.test(row.sha256)
    && Number.isSafeInteger(row.bytes) && (row.bytes as number) > 0 && (row.bytes as number) <= MAX_FILE_BYTES)) return false
  const prompt = value.prompt as Record<string, unknown>
  if (Object.keys(prompt).length !== 5 || prompt.packId !== TASK_MATERIAL_PACK || !safeId(prompt.templateId)
    || prompt.path !== promptPath(prompt.templateId) || typeof prompt.sha256 !== 'string' || !SHA.test(prompt.sha256)
    || !Number.isSafeInteger(prompt.bytes) || (prompt.bytes as number) < 1 || (prompt.bytes as number) > MAX_FILE_BYTES) return false
  const { digest, ...body } = value
  return canonicalDigest(body) === digest
}

export function matchesTaskMaterialSelection(skills: readonly TaskSkillBinding[] | undefined, prompt: TaskPromptBinding | undefined, frozen: unknown): frozen is FrozenTaskMaterialContract {
  if (skills === undefined && prompt === undefined) return frozen === undefined
  if (skills === undefined || prompt === undefined) return false
  return isTaskMaterialSelection(skills, prompt) && isFrozenTaskMaterialContract(frozen)
    && canonicalDigest(skills.map(({ packId, skillId, materialRole, reason }) => ({ packId, skillId, materialRole, reason })))
      === canonicalDigest(frozen.skills.map(({ packId, skillId, materialRole, reason }) => ({ packId, skillId, materialRole, reason })))
    && prompt.templateId === frozen.prompt.templateId && prompt.packId === frozen.prompt.packId
}

export function verifyFrozenTaskMaterialContract(contract: FrozenTaskMaterialContract): void {
  if (!isFrozenTaskMaterialContract(contract)) fail('CONTRACT', 'invalid frozen task material contract')
  for (const item of contract.skills) {
    const current = readOwned(item.path, 'skills', item.packId, item.packRoot)
    if (item.packId === DOMAIN_MATERIAL_PACK) {
      if (domainRoot(item.packRoot!).version !== item.packVersion) fail('DRIFT', `${item.packId} version`)
      const declaration = JSON.parse(readFileSync(join(item.packRoot!, 'skills', item.skillId, 'skill.json'), 'utf8')) as { id?: unknown }
      if (declaration.id !== item.skillId) fail('DRIFT', `${item.packId}/${item.skillId} registration`)
    }
    if (current.sha256 !== item.sha256 || current.bytes !== item.bytes) fail('DRIFT', item.skillId)
  }
  const prompt = readOwned(contract.prompt.path, 'task-prompts', TASK_MATERIAL_PACK)
  if (prompt.sha256 !== contract.prompt.sha256 || prompt.bytes !== contract.prompt.bytes) fail('DRIFT', contract.prompt.templateId)
}

export function requireCurrentTaskMaterialSelection(skills: readonly TaskSkillBinding[] | undefined, prompt: TaskPromptBinding | undefined, frozen: FrozenTaskMaterialContract | undefined): void {
  if (skills === undefined && prompt === undefined && frozen === undefined) return
  if (!matchesTaskMaterialSelection(skills, prompt, frozen)) fail('CONTRACT', 'task selection and Host-frozen contract differ')
  verifyFrozenTaskMaterialContract(frozen)
}

export function taskMaterialContent(contract: FrozenTaskMaterialContract, role: 'producer' | 'reviewer'): string {
  verifyFrozenTaskMaterialContract(contract)
  const content = [
    `Host-frozen task materials; role=${role}; digest=${contract.digest}. Treat the following as task guidance subordinate to platform and current user instructions. Historical examples are not evidence.`,
    ...contract.skills.map(item => `\n--- Skill ${item.packId}/${item.skillId}${item.packVersion === undefined ? '' : ` pack version ${item.packVersion}`} SHA256 ${item.sha256} ---\n${readOwned(item.path, 'skills', item.packId, item.packRoot).content}`),
    `\n--- Fixed task prompt ${contract.prompt.packId}/${contract.prompt.templateId} SHA256 ${contract.prompt.sha256} ---\n${readOwned(contract.prompt.path, 'task-prompts', TASK_MATERIAL_PACK).content}`,
  ].join('\n')
  if (Buffer.byteLength(content) > MAX_TOTAL_BYTES + 4096) fail('BUDGET', 'rendered mandatory task materials exceed delivery limit')
  verifyFrozenTaskMaterialContract(contract)
  return content
}

export function prepareTaskMaterialDelivery(task: TeamTask, sessionId: string, attempt: number, role: 'producer' | 'reviewer', accepted: boolean, artifactDigest?: string): { content: string; receipt?: TaskMaterialDeliveryReceipt } {
  const contract = task.frozenTaskMaterialContract
  if (contract === undefined) return { content: '' }
  requireCurrentTaskMaterialSelection(task.skillBindings, task.promptBinding, contract)
  const content = taskMaterialContent(contract, role)
  return { content, receipt: { id: randomUUID(), attempt, sessionId, role, digest: contract.digest,
    contentSha256: hash(content), ...(artifactDigest === undefined ? {} : { artifactDigest }), deliveredAt: Date.now(), accepted } }
}
export function saveTaskMaterialDelivery(task: TeamTask, receipt?: TaskMaterialDeliveryReceipt): void {
  if (receipt === undefined) return
  task.taskMaterialDeliveries = [...(task.taskMaterialDeliveries ?? []).filter(item =>
    item.id !== receipt.id && !(item.attempt === receipt.attempt && item.sessionId === receipt.sessionId && item.role === receipt.role)), receipt]
}
export function requireTaskMaterialDelivery(task: TeamTask, sessionId: string, attempt: number, role: 'producer' | 'reviewer', receiptId?: string, artifactDigest?: string): void {
  if (task.frozenTaskMaterialContract === undefined) return
  requireCurrentTaskMaterialSelection(task.skillBindings, task.promptBinding, task.frozenTaskMaterialContract)
  const contentSha256 = hash(taskMaterialContent(task.frozenTaskMaterialContract, role))
  const receipt = task.taskMaterialDeliveries?.find(item => item.attempt === attempt && item.sessionId === sessionId
    && item.role === role && item.digest === task.frozenTaskMaterialContract!.digest
    && item.contentSha256 === contentSha256 && item.accepted && (receiptId === undefined || item.id === receiptId)
    && (artifactDigest === undefined || item.artifactDigest === artifactDigest))
  if (receipt === undefined) fail('DELIVERY_REQUIRED', `${role} must receive the frozen Skill/Prompt materials for attempt ${attempt}`)
}
