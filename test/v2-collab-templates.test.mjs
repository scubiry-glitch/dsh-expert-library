/**
 * Collab template tests: the four collaboration-mode TeamTemplates compile
 * through `compileExecutionPlan` with the caller's params + explicit roster
 * assignments, and their physical expansion (via `expandExecutionPlan`)
 * reproduces the DAGs the previous imperative assemblers built — task ids,
 * subjects (after interpolation), dependencies and assignees. Runs against
 * the built `lib/` output.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { compileExecutionPlan, validateDomainPack } from '../lib/v2/index.js'
import { buildCollabDomainPack, COLLAB_TEAM_TEMPLATES, COLLAB_SCENARIOS } from '../lib/collab/templates.js'
import { expandExecutionPlan } from '../lib/apply.js'

/** Minimal V1 Expert fixture (same shape as the bridge tests). */
function expert(id) {
  return { id, name: `Expert ${id}`, role: 'research', background: '背景', principles: ['结论先行'], deliverables: ['研判稿'] }
}

/** The expert set the collab modes may reference (8 通用 + a few bk-*). */
const EXPERTS = ['researcher', 'data-analyst', 'designer', 'engineer', 'qa-engineer', 'docs-coordinator', 'team-lead', 'bk-024', 'bk-008', 'bk-004', 'bk-005'].map(expert)

function collabPack() {
  return buildCollabDomainPack(EXPERTS)
}

function compileCollab(mode, params, assignments) {
  return compileExecutionPlan({
    pack: collabPack(),
    templateId: mode,
    scenarioId: mode === 'collab.research-report-single' ? 'research-report' : mode.replace('collab.', ''),
    params,
    binding: { assignments },
  })
}

function expand(result, opts = {}) {
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.errors))
  if (!result.ok) return undefined
  return expandExecutionPlan(result.plan, { teamName: 'T', description: '', ...opts })
}

// ── 0. Pack validity ────────────────────────────────────────────────────────

test('the collab pack is validator-clean and declares 5 templates + 4 scenarios', () => {
  const pack = collabPack()
  const validation = validateDomainPack(pack)
  assert.equal(validation.ok, true, validation.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('; '))
  assert.deepEqual(pack.teamTemplates.map(template => template.id), [
    'collab.cross-debate', 'collab.roundtable', 'collab.ppt-gen',
    'collab.research-report', 'collab.research-report-single',
  ])
  assert.deepEqual(pack.scenarios.map(scenario => scenario.id), ['cross-debate', 'roundtable', 'ppt-gen', 'research-report'])
  for (const scenario of COLLAB_SCENARIOS) {
    assert.ok(pack.teamTemplates.some(template => template.id === scenario.teamTemplate))
  }
  assert.equal(COLLAB_TEAM_TEMPLATES.length, 5)
})

// ── 1. Debate golden ────────────────────────────────────────────────────────

test('debate: t1..t5 chain, roster [moderator, pro, con], subjects embed the expert ids', () => {
  const result = compileCollab('collab.cross-debate',
    { topic: '一线城市是否已见底', pro: 'bk-024', con: 'bk-008', moderator: 'team-lead' },
    { 'role.moderator': ['team-lead'], 'role.pro': ['bk-024'], 'role.con': ['bk-008'] },
  )
  const expanded = expand(result)
  if (!expanded) return
  // Physical DAG identical to the imperative assembler's.
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2', 't3', 't4', 't5'])
  assert.deepEqual(expanded.tasks.map(task => task.dependsOn), [[], ['t1'], ['t2'], ['t3'], ['t4']])
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['team-lead', 'bk-024', 'bk-008', 'bk-024', 'team-lead'])
  assert.deepEqual(expanded.tasks.map(task => task.subject), [
    '辩题与规则确认',
    '正方立论（bk-024）',
    '反方反驳（bk-008）',
    '正方回应（bk-024）',
    '裁判总结',
  ])
  assert.deepEqual(expanded.members.map(member => member.expertId), ['team-lead', 'bk-024', 'bk-008'])
  assert.equal(result.ok ? result.plan.scenario?.id : undefined, 'cross-debate')
})

test('debate: pro == moderator dedupes the roster to two members', () => {
  const result = compileCollab('collab.cross-debate',
    { topic: 'T', pro: 'team-lead', con: 'bk-008', moderator: 'team-lead' },
    { 'role.moderator': ['team-lead'], 'role.pro': ['team-lead'], 'role.con': ['bk-008'] },
  )
  const expanded = expand(result)
  if (!expanded) return
  assert.deepEqual(expanded.members.map(member => member.expertId), ['team-lead', 'bk-008'])
  // The DAG keeps 5 physical tasks; team-lead owns t1/t2/t4/t5.
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['team-lead', 'team-lead', 'bk-008', 'team-lead', 'team-lead'])
})

// ── 2. Roundtable ───────────────────────────────────────────────────────────

test('roundtable: speakers fan out; the note-taker task depends on ALL speakers', () => {
  const result = compileCollab('collab.roundtable',
    { topic: '市场是否见底', noteTaker: 'docs-coordinator' },
    { 'role.speaker': ['bk-004', 'bk-005', 'bk-008'], 'role.note-taker': ['docs-coordinator'] },
  )
  const expanded = expand(result)
  if (!expanded) return
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2', 't3', 't4'])
  assert.deepEqual(expanded.tasks.map(task => task.subject), [
    '专家发言（bk-004）', '专家发言（bk-005）', '专家发言（bk-008）', '圆桌纪要整理',
  ])
  assert.deepEqual(expanded.tasks[3]?.dependsOn, ['t1', 't2', 't3'])
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['bk-004', 'bk-005', 'bk-008', 'docs-coordinator'])
  assert.deepEqual(expanded.members.map(member => member.expertId), ['bk-004', 'bk-005', 'bk-008', 'docs-coordinator'])
})

test('roundtable without note_taker: the 纪要 task stays unassigned (shared pool)', () => {
  const result = compileCollab('collab.roundtable',
    { topic: 'T' },
    { 'role.speaker': ['bk-004', 'bk-005'], 'role.note-taker': [] },
  )
  const expanded = expand(result)
  if (!expanded) return
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2', 't3'])
  assert.equal(expanded.tasks[2]?.assigneeExpertId, undefined)
  assert.deepEqual(expanded.members.map(member => member.expertId), ['bk-004', 'bk-005'])
})

test('roundtable with fewer than 2 speakers fails at compile time (assignment-count)', () => {
  const result = compileCollab('collab.roundtable', { topic: 'T' }, { 'role.speaker': ['bk-004'], 'role.note-taker': [] })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.errorKind, 'roster')
  assert.ok(result.errors.some(error => error.code === 'assignment-count'))
})

// ── 3. PPT ──────────────────────────────────────────────────────────────────

test('ppt: 架构 → 内容供给(fan-out) → 逐页文案 → 渲染和出图; docs-coordinator deduped', () => {
  const result = compileCollab('collab.ppt-gen',
    { topic: '2026 房地产展望', audience: '投资客户', pageCountText: '12' },
    { 'role.architect': ['docs-coordinator'], 'role.content': ['bk-024', 'bk-008'], 'role.writer': ['docs-coordinator'] },
  )
  const expanded = expand(result)
  if (!expanded) return
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2', 't3', 't4', 't5'])
  assert.deepEqual(expanded.tasks.map(task => task.subject), [
    '内容架构', '内容供给（bk-024）', '内容供给（bk-008）', '逐页文案生成', '渲染和出图',
  ])
  assert.deepEqual(expanded.tasks.map(task => task.dependsOn), [[], ['t1'], ['t1'], ['t1', 't2', 't3'], ['t4']])
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['docs-coordinator', 'bk-024', 'bk-008', 'docs-coordinator', 'docs-coordinator'])
  assert.deepEqual(expanded.members.map(member => member.expertId), ['docs-coordinator', 'bk-024', 'bk-008'])
  // The audience + page count are interpolated into the architecture task.
  assert.equal(expanded.tasks[0]?.description, '确定听众（投资客户）、目标与篇幅（12 页），输出 PPT 大纲：章节结构 + 每页标题与要点。主题：2026 房地产展望')
  // The render task is the final DAG node: depends on the copy task only and
  // stays on the docs-coordinator render role.
  assert.equal(expanded.tasks[4]?.dependsOn.length, 1)
  assert.equal(expanded.tasks[4]?.dependsOn[0], 't4')
  assert.equal(expanded.tasks[4]?.assigneeExpertId, 'docs-coordinator')
  assert.ok(expanded.tasks[4]?.description.includes('finesse-ui/SKILL.md'), 'render task instructs the finesse craft floor')
  assert.ok(expanded.tasks[4]?.description.includes('pptfast'), 'render task instructs the pptfast conversion')
  assert.ok(expanded.tasks[4]?.description.includes('video-shotcraft/SKILL.md'), 'render task instructs the video-shotcraft path')
  // No template given → no template line, no placeholder leak.
  assert.ok(!expanded.tasks[4]?.description.includes('指定模板：'))
  assert.ok(!expanded.tasks[4]?.description.includes('{templateLine}'))
})

test('ppt: the render task threads the template param — provided line present, absent → no line', () => {
  // Template provided: the 「指定模板：{template}」 line lands in the render
  // task description (mirroring how the report tool embeds dataLine). With one
  // content expert the physical DAG is t1..t4, so the render task is t4.
  const withTemplate = compileCollab('collab.ppt-gen',
    { topic: 'T', template: 'ink-press', templateLine: '\n指定模板：ink-press' },
    { 'role.architect': ['docs-coordinator'], 'role.content': ['bk-024'], 'role.writer': ['docs-coordinator'] },
  )
  const expandedWith = expand(withTemplate)
  if (!expandedWith) return
  assert.equal(expandedWith.tasks[3]?.subject, '渲染和出图')
  const renderWith = expandedWith.tasks[3]?.description ?? ''
  assert.ok(renderWith.includes('\n指定模板：ink-press'), `template line must be interpolated, got: ${renderWith}`)
  assert.ok(!renderWith.includes('{templateLine}'), 'no placeholder leak when template is provided')

  // Template absent: templateLine is the empty string (the adapter always
  // passes it), so the placeholder resolves away and no line appears.
  const withoutTemplate = compileCollab('collab.ppt-gen',
    { topic: 'T', templateLine: '' },
    { 'role.architect': ['docs-coordinator'], 'role.content': ['bk-024'], 'role.writer': ['docs-coordinator'] },
  )
  const expandedWithout = expand(withoutTemplate)
  if (!expandedWithout) return
  const renderWithout = expandedWithout.tasks[3]?.description ?? ''
  assert.ok(!renderWithout.includes('指定模板：'), `no template line when absent, got: ${renderWithout}`)
  assert.ok(!renderWithout.includes('{templateLine}'), 'no placeholder leak when template is absent')
  assert.ok(renderWithout.includes('未指定模板时，用 finesse 规范自选并说明理由'))
})

test('ppt: default audience/page-count text when not supplied', () => {
  // The adapter always passes pageCountText (String(page_count ?? '10-15'));
  // audience defaults fold in from the template schema.
  const result = compileCollab('collab.ppt-gen',
    { topic: 'T', pageCountText: '10-15' },
    { 'role.architect': ['docs-coordinator'], 'role.content': ['bk-024'], 'role.writer': ['docs-coordinator'] },
  )
  const expanded = expand(result)
  if (!expanded) return
  assert.equal(expanded.tasks[0]?.description, '确定听众（缺省由你判断）、目标与篇幅（10-15 页），输出 PPT 大纲：章节结构 + 每页标题与要点。主题：T')
})

test('ppt: more than 3 content experts fails at compile time', () => {
  const result = compileCollab('collab.ppt-gen',
    { topic: 'T' },
    { 'role.architect': ['docs-coordinator'], 'role.content': ['bk-024', 'bk-008', 'bk-004', 'bk-005'], 'role.writer': ['docs-coordinator'] },
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.some(error => error.code === 'assignment-count'))
})

// ── 4. Research report ──────────────────────────────────────────────────────

test('report (multi): 梳理 → 研判(fan-out) → 融合成文 → 渲染与生成 with dataLine embedded', () => {
  const result = compileCollab('collab.research-report',
    { topic: 'T', data: 'D', dataLine: '\n可用素材/数据（带口径）：\nD' },
    { 'role.researcher': ['researcher'], 'role.analyst': ['bk-004', 'bk-005'], 'role.writer': ['docs-coordinator'] },
  )
  const expanded = expand(result)
  if (!expanded) return
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2', 't3', 't4', 't5'])
  assert.deepEqual(expanded.tasks.map(task => task.subject), ['资料与数据梳理', '专家研判（bk-004）', '专家研判（bk-005）', '融合成文', '渲染与生成（HTML5 → PDF/PPT → 视频）'])
  assert.deepEqual(expanded.tasks.map(task => task.dependsOn), [[], ['t1'], ['t1'], ['t1', 't2', 't3'], ['t4']])
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['researcher', 'bk-004', 'bk-005', 'docs-coordinator', 'docs-coordinator'])
  assert.equal(expanded.tasks[1]?.description, '以本人立场独立研判：核心判断 → 关键事实与分析（数字带口径）→ 展望与不确定性。主题：T\n可用素材/数据（带口径）：\nD')
  // Render node: three skills + completion checkpoint bound.
  const render = expanded.tasks[4]
  assert.ok(render?.description.includes('finesse-ui'))
  assert.ok(render?.description.includes('pptfast'))
  assert.ok(render?.description.includes('video-shotcraft'))
  assert.ok(render?.description.includes('等待用户确认'))
})

test('report (single expert): variant template drops the analyst task entirely', () => {
  const result = compileCollab('collab.research-report-single',
    { topic: 'T', dataLine: '' },
    { 'role.researcher': ['researcher'], 'role.writer': ['docs-coordinator'] },
  )
  const expanded = expand(result)
  if (!expanded) return
  assert.deepEqual(expanded.tasks.map(task => task.id), ['t1', 't2'])
  assert.deepEqual(expanded.tasks.map(task => task.subject), ['资料与数据梳理', '融合成文'])
  assert.deepEqual(expanded.tasks.map(task => task.dependsOn), [[], ['t1']])
  assert.deepEqual(expanded.tasks.map(task => task.assigneeExpertId), ['researcher', 'docs-coordinator'])
  assert.equal(result.ok ? result.plan.scenario?.id : undefined, 'research-report')
})

test('report: writer among the experts keeps the roster in experts order (dedup)', () => {
  const result = compileCollab('collab.research-report',
    { topic: 'T', dataLine: '' },
    { 'role.researcher': ['bk-004'], 'role.analyst': ['bk-005'], 'role.writer': ['bk-005'] },
  )
  const expanded = expand(result)
  if (!expanded) return
  assert.deepEqual(expanded.members.map(member => member.expertId), ['bk-004', 'bk-005'])
})

// ── 5. Scenario binding ─────────────────────────────────────────────────────

test('every collab mode compiles with its scenario id and no template-mismatch warning', () => {
  for (const mode of ['collab.cross-debate', 'collab.roundtable', 'collab.ppt-gen', 'collab.research-report']) {
    const params = mode === 'collab.cross-debate'
      ? { topic: 'T', pro: 'bk-024', con: 'bk-008' }
      : mode === 'collab.roundtable'
        ? { topic: 'T' }
        : mode === 'collab.ppt-gen'
          ? { topic: 'T' }
          : { topic: 'T' }
    const assignments = mode === 'collab.cross-debate'
      ? { 'role.moderator': ['team-lead'], 'role.pro': ['bk-024'], 'role.con': ['bk-008'] }
      : mode === 'collab.roundtable'
        ? { 'role.speaker': ['bk-004', 'bk-005'], 'role.note-taker': [] }
        : mode === 'collab.ppt-gen'
          ? { 'role.architect': ['docs-coordinator'], 'role.content': ['bk-024'], 'role.writer': ['docs-coordinator'] }
          : { 'role.researcher': ['researcher'], 'role.analyst': ['bk-004'], 'role.writer': ['docs-coordinator'] }
    const result = compileCollab(mode, params, assignments)
    assert.equal(result.ok, true, `${mode}: ${result.ok ? '' : JSON.stringify(result.errors)}`)
    if (!result.ok) continue
    assert.equal(result.plan.scenario?.id, mode.replace('collab.', ''))
    assert.ok(!result.warnings.some(warning => warning.code === 'scenario-template-mismatch'), `${mode} must not warn about template mismatch`)
  }
})
