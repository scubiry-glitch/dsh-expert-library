import test from 'node:test'
import assert from 'node:assert/strict'

const source = process.env.SKILL_CRAFT_TEST_SOURCE === '1'
const { captainGoalRules, memberGoalRules } = await import(source ? '../src/goal-prompts.ts' : '../lib/goal-prompts.js')
const { assignmentPrompt } = await import(source ? '../src/scheduler.ts' : '../lib/scheduler.js')

test('captain goal rules preserve one goal and require evidence before success', () => {
  const prompt = captainGoalRules({ scenarioIds: 'scenario-a', expertIds: 'expert-a' })
  assert.match(prompt, /GOAL MODE/)
  assert.match(prompt, /same staged plan/)
  assert.match(prompt, /exact expected_digest and expected_revision/)
  assert.match(prompt, /only .*integrate after a pass unlocks completion/)
  assert.match(prompt, /Failed\/cancelled tasks.*do not establish success/)
  assert.match(prompt, /Preserve the team and audit evidence/)
  assert.match(prompt, /reportBundle on the final report producer/)
  assert.match(prompt, /revises_task_id to inherit the frozen checks/)
  assert.match(prompt, /plugin mailbox notification does not grant that authority/)
  assert.match(prompt, /end the turn; do not repeat that call/)
})

test('member goal rules distinguish implementation output from quality completion', () => {
  const prompt = memberGoalRules()
  assert.match(prompt, /current attempt_id/)
  assert.match(prompt, /QualityRun that is not integrated/i)
  assert.match(prompt, /save output.*in_progress/i)
  assert.match(prompt, /do not repeatedly submit completed/i)
  assert.match(prompt, /waiting is not completion/i)
  const zh = memberGoalRules('zh')
  assert.match(zh, /尚未 integrated 的 QualityRun/)
  assert.match(zh, /不要反复提交 completed/)
})

test('captain selects scoped domain skills with reasons instead of a fixed legacy craft or style', () => {
  const prompt = captainGoalRules({ scenarioIds: 'scenario-a', expertIds: 'expert-a' })
  assert.match(prompt, /current session's scoped craft catalog/)
  assert.match(prompt, /Choose one skill or a compatible combination yourself/)
  assert.match(prompt, /record a reason for every selection/)
  assert.match(prompt, /Host never selects or adds dependencies/)
  assert.match(prompt, /craft:\{version:3,selections:\[\{packId,skillId,variant\?,reason\}\]/)
  assert.match(prompt, /cover md, html, pdf and evidence/)
  assert.match(prompt, /do not fall back to v1\/v2 or a global same-name copy/)
  assert.match(prompt, /Historical contracts keep their original interpretation/)
  assert.match(prompt, /located evidence for every declared review area/)
  assert.doesNotMatch(prompt, /zhijian-report-craft|credit-policy|designer-paper|version:2|Before judging a v2 report/)
})

test('scheduler assignment prompt carries the live goal-state and quality contract', () => {
  const prompt = assignmentPrompt({
    taskId: 't1', memberName: 'researcher', memberId: 'm1', attempt: 2,
    attemptId: 'attempt-2', subject: '核验数据', description: '输出带口径证据',
  }, 'expert-teams', 'team-1')
  assert.match(prompt, /Mark the task in_progress/i)
  assert.match(prompt, /concrete external blocker/i)
  assert.match(prompt, /QualityRun.*not integrated/i)
  assert.match(prompt, /do not submit completed or self-approve/i)
  assert.match(prompt, /attempt_id=attempt-2/)
})
