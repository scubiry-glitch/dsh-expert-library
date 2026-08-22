/**
 * P2.2/P2.4 测试：反馈评分回写 evaluations.jsonl（追加/容忍坏行/摘要/注入段）
 * 与知识版本化（VERSION 锚点进入 persona 知识指引）。
 * Runs against the built `lib/` output (see `pnpm test`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendEvaluation,
  evaluationsFile,
  readEvaluations,
  feedbackSummary,
  feedbackGuideSection,
} from '../lib/zhijian/evaluations.js'
import { knowledgeGuide } from '../lib/knowledge.js'

let workspace
let knowledgeDir = 'knowledge'

test.before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'p2-feedback-'))
})

test.after(async () => {
  await rm(workspace, { recursive: true, force: true })
})

// ── P2.2 evaluations.jsonl ──────────────────────────────────────────────────

test('appendEvaluation writes and readEvaluations round-trips', async () => {
  const file = evaluationsFile(workspace, knowledgeDir, 'bk-024')
  assert.ok(file !== undefined)
  await appendEvaluation(file, { at: '2026-08-23T00:00:00Z', score: 88, note: '口径到位' })
  await appendEvaluation(file, { at: '2026-08-23T01:00:00Z', score: 72, taskId: 't1', dimensions: { 相关性: 70 } })
  const records = await readEvaluations(file)
  assert.equal(records.length, 2)
  assert.equal(records[0].score, 88)
  assert.equal(records[1].taskId, 't1')
  const summary = feedbackSummary(records)
  assert.ok(summary !== undefined)
  assert.match(summary, /2 条，均分 80\/100/)
  assert.match(summary, /最近一次 72\/100/)
})

test('readEvaluations tolerates corrupt lines and missing files', async () => {
  const file = evaluationsFile(workspace, knowledgeDir, 'bk-007')
  assert.ok(file !== undefined)
  await mkdir(join(workspace, knowledgeDir, 'experts', 'bk-007'), { recursive: true })
  await writeFile(file, '{"score":90}\nnot-json-line\n{"score":60}\n')
  const records = await readEvaluations(file)
  assert.equal(records.length, 2)
  assert.deepEqual(await readEvaluations(evaluationsFile(workspace, knowledgeDir, 'missing-expert')), [])
})

test('unsafe expert id refuses evaluation writes', async () => {
  assert.equal(evaluationsFile(workspace, knowledgeDir, '../escape'), undefined)
  await assert.rejects(() => appendEvaluation(undefined, { at: 'x', score: 1 }), /不安全/)
})

test('feedbackGuideSection injects summary only when records exist', async () => {
  const withRecords = await feedbackGuideSection(workspace, knowledgeDir, 'bk-024')
  assert.match(withRecords, /既往反馈/)
  const without = await feedbackGuideSection(workspace, knowledgeDir, 'bk-005')
  assert.equal(without, '')
})

// ── P2.4 knowledge VERSION anchor ────────────────────────────────────────────

test('knowledgeGuide surfaces the VERSION anchor of an expert pack', async () => {
  const dir = join(workspace, knowledgeDir, 'experts', 'bk-024')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '01-checklist.md'), '# checklist\n')
  await writeFile(join(dir, 'VERSION'), '1.2.0\n')
  const guide = await knowledgeGuide(workspace, knowledgeDir, 'bk-024')
  assert.match(guide, /v1\.2\.0/)
  assert.match(guide, /01-checklist\.md/)
})

test('knowledgeGuide omits version when VERSION is absent', async () => {
  const dir = join(workspace, knowledgeDir, 'experts', 'bk-005')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'note.md'), 'x\n')
  const guide = await knowledgeGuide(workspace, knowledgeDir, 'bk-005')
  assert.match(guide, /note\.md/)
  assert.ok(!guide.includes('v1.'), 'no version line without VERSION file')
})
