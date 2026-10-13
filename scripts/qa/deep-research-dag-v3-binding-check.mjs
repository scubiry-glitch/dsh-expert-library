/** Targeted structural and frozen-material checks for the v3 outline stage. */
import assert from 'node:assert/strict'
import { readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseProfile, profileToExecutionPlan } from '../../lib/profiles.js'
import { validateDeepResearchPlan } from '../../lib/deep-research-plan.js'
import { resolveTaskMaterialContract, requireCurrentTaskMaterialSelection, taskMaterialContent, prepareTaskMaterialDelivery, saveTaskMaterialDelivery, requireTaskMaterialDelivery } from '../../lib/task-material-binding.js'

const project = '/root/.openclaw/workspace/98wiki/projects/供平过租见底路径'
const v3 = JSON.parse(await readFile(join(project, '深度研究团队DAG-v3.json'), 'utf8')).profile
const v2 = JSON.parse(await readFile(join(project, '深度研究团队DAG-v2.json'), 'utf8')).profile
const clone = value => structuredClone(value)
const check = value => validateDeepResearchPlan(parseProfile(value))
const byId = (profile, id) => profile.tasks.find(task => task.id === id)

check(v3)
check(v2)
const two = clone(v3)
two.members = two.members.filter(member => member.id !== 'city')
two.tasks = two.tasks.filter(task => !['expert_brief_city', 'research_view_city'].includes(task.id))
for (const id of ['outline_candidates', 'evidence_merge']) {
  byId(two, id).dependsOn = byId(two, id).dependsOn.filter(dep => !['expert_brief_city', 'research_view_city'].includes(dep))
  byId(two, id).artifactInputs = byId(two, id).artifactInputs.filter(item => !['expert_brief_city', 'research_view_city'].includes(item.fromTask))
}
two.expertSelection.selectedIds = two.members.filter(member => member.expert?.startsWith('bk-')).map(member => member.expert)
check(two)
assert.equal(two.tasks.filter(task => task.id.startsWith('expert_brief_')).length, 2)

const five = clone(v3)
for (const [slot, expert] of [['extra025', 'bk-025'], ['extra011', 'bk-011']]) {
  five.members.splice(five.members.length - 2, 0, { id: slot, name: `追加专家${slot}`, role: '独立研判与证据', expert, maxDepth: 0 })
  const brief = clone(byId(five, 'expert_brief_city'))
  brief.id = `expert_brief_${slot}`; brief.owner = slot; brief.produces = [`${brief.id}.md`]
  five.tasks.push(brief)
  byId(five, 'outline_candidates').dependsOn.push(brief.id)
  byId(five, 'outline_candidates').artifactInputs.push({ fromTask: brief.id, artifact: brief.produces[0], purpose: '新增专家独立简报', phase: 'work' })
  const view = clone(byId(five, 'research_view_city'))
  view.id = `research_view_${slot}`; view.owner = slot; view.produces = [`${view.id}.md`]
  five.tasks.push(view)
  byId(five, 'evidence_merge').dependsOn.push(view.id)
  byId(five, 'evidence_merge').artifactInputs.push({ fromTask: view.id, artifact: view.produces[0], purpose: '新增专家独立证据', phase: 'work' })
}
five.expertSelection.selectedIds = five.members.filter(member => member.expert?.startsWith('bk-')).map(member => member.expert)
check(five)
assert.equal(five.tasks.filter(task => task.id.startsWith('expert_brief_')).length, 5)

const missing = clone(v3)
delete byId(missing, 'expert_brief_market').skillBindings
assert.throws(() => check(missing), /skillBindings|requires registered Skill/)
const duplicated = clone(v3)
byId(duplicated, 'outline_candidates').skillBindings.push(clone(byId(duplicated, 'outline_candidates').skillBindings[0]))
assert.throws(() => check(duplicated), /skillBindings|distinct/)
const wrongRole = clone(v3)
byId(wrongRole, 'expert_brief_market').skillBindings[0].materialRole = 'reviewer'
assert.throws(() => check(wrongRole), /skillBindings|producer/)
const changedBinding = clone(v3)
byId(changedBinding, 'expert_brief_market').skillBindings[0].reason = 'Different approved use'
assert.notEqual(profileToExecutionPlan(parseProfile(v3)).digest, profileToExecutionPlan(parseProfile(changedBinding)).digest)
const missingStage2 = clone(v3)
delete byId(missingStage2, 'writer').promptBinding
assert.throws(() => check(missingStage2), /promptBinding|requires fixed Prompt/)
const missingRelease = clone(v3)
missingRelease.tasks = missingRelease.tasks.filter(task => task.id !== 'report_release')
assert.throws(() => check(missingRelease), /report_release/)
const domainTask = byId(v3, 'research_main')
assert.throws(() => resolveTaskMaterialContract(domainTask.skillBindings, domainTask.promptBinding), /SKILL_UNAVAILABLE/)
const packRoot = await realpath(join(fileURLToPath(new URL('../../domain-packs/', import.meta.url)), 'zhijian-realestate'))
const packVersion = JSON.parse(await readFile(join(packRoot, 'pack.json'), 'utf8')).version
const scopedSkills = domainTask.skillBindings.filter(binding => binding.packId === 'zhijian-realestate')
  .map(binding => ({ packId: binding.packId, skillId: binding.skillId, root: packRoot, packVersion }))
const domainFrozen = resolveTaskMaterialContract(domainTask.skillBindings, domainTask.promptBinding, scopedSkills)
assert.match(taskMaterialContent(domainFrozen, 'producer'), new RegExp(`zhijian-realestate/zhijian-report-craft pack version ${packVersion.replaceAll('.', '\\.')}`))
assert.throws(() => resolveTaskMaterialContract(domainTask.skillBindings, domainTask.promptBinding,
  scopedSkills.map(row => ({ ...row, packVersion: '0.0.0' }))), /SKILL_UNAVAILABLE|PACK_DRIFT/)

const task = byId(v3, 'expert_brief_market')
const frozen = resolveTaskMaterialContract(task.skillBindings, task.promptBinding)
assert.match(taskMaterialContent(frozen, 'producer'), /固定任务 Prompt v1/)
const reviewTask = { skillBindings: task.skillBindings, promptBinding: task.promptBinding, frozenTaskMaterialContract: frozen }
const reviewerPacket = prepareTaskMaterialDelivery(reviewTask, 'reviewer-session', 1, 'reviewer', true, 'a'.repeat(64))
saveTaskMaterialDelivery(reviewTask, reviewerPacket.receipt)
requireTaskMaterialDelivery(reviewTask, 'reviewer-session', 1, 'reviewer', reviewerPacket.receipt.id, 'a'.repeat(64))
assert.throws(() => requireTaskMaterialDelivery(reviewTask, 'reviewer-session', 1, 'reviewer', reviewerPacket.receipt.id, 'b'.repeat(64)), /TASK_BINDING_DELIVERY_REQUIRED/)
assert.throws(() => resolveTaskMaterialContract([{ ...task.skillBindings[0], skillId: 'unknown-binding-qa' }], task.promptBinding), /TASK_BINDING_SKILL_UNAVAILABLE/)
assert.throws(() => resolveTaskMaterialContract(task.skillBindings, { ...task.promptBinding, templateId: 'unknown-prompt-qa' }), /TASK_BINDING_PROMPT_UNAVAILABLE/)
const temporaryId = `qa-drift-${randomUUID().slice(0, 8)}`
const path = fileURLToPath(new URL(`../../knowledge/task-prompts/${temporaryId}.md`, import.meta.url))
const temporaryPrompt = { ...task.promptBinding, templateId: temporaryId }
try {
  await writeFile(path, '# QA frozen prompt\nFirst bytes.\n', { flag: 'wx' })
  const selected = resolveTaskMaterialContract(task.skillBindings, temporaryPrompt)
  requireCurrentTaskMaterialSelection(task.skillBindings, temporaryPrompt, selected)
  await writeFile(path, '# QA frozen prompt\nChanged bytes.\n')
  assert.throws(() => requireCurrentTaskMaterialSelection(task.skillBindings, temporaryPrompt, selected), /TASK_BINDING_DRIFT/)
  assert.throws(() => prepareTaskMaterialDelivery({ skillBindings: task.skillBindings, promptBinding: temporaryPrompt, frozenTaskMaterialContract: selected }, 'producer-session', 1, 'producer', true), /TASK_BINDING_DRIFT/)
} finally { await rm(path, { force: true }) }
console.log(JSON.stringify({ status: 'PASS', routedExpertCounts: [2, 3, 5], oldV2Readable: true, missingBindingRejected: true, duplicateBindingRejected: true, wrongRoleRejected: true, unknownSkillAndPromptRejected: true, stage2BindingAndReleaseRequired: true, domainPackVersionFrozen: packVersion, inactiveDomainSkillRejected: true, bindingChangeInvalidatesDigest: true, promptDriftRejectedAtDispatch: true, reviewedArtifactDigestMismatchRejected: true }))
