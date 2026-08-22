/**
 * Input-boundary regression tests for the Expert Library.
 *
 * Runs against the built `lib/` output (plain JS, NodeNext), so `pnpm test`
 * requires `pnpm build` first — the test script chains both.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { isSafeKnowledgeId } from '../lib/knowledge.js'
import { isValidRepo, MAX_SKILL_BYTES } from '../lib/skills.js'
import { topicRouteFor, scenarioForTopic } from '../lib/zhijian/routing.js'
import { routeRequest } from '../lib/zhijian/tools.js'

test('isSafeKnowledgeId rejects traversal and accepts domain ids', () => {
  assert.equal(isSafeKnowledgeId('bk-004'), true)
  assert.equal(isSafeKnowledgeId('docs-coordinator'), true)
  assert.equal(isSafeKnowledgeId('宏观派1'), true)
  assert.equal(isSafeKnowledgeId('..'), false)
  assert.equal(isSafeKnowledgeId('../escape'), false)
  assert.equal(isSafeKnowledgeId('a/b'), false)
  assert.equal(isSafeKnowledgeId(''), false)
  assert.equal(isSafeKnowledgeId(' leadingspace'), false)
  assert.equal(isSafeKnowledgeId('x'.repeat(65)), false)
})

test('isValidRepo accepts strict owner/repo and rejects everything else', () => {
  assert.equal(isValidRepo('Vincentwei1021/video-shotcraft'), true)
  assert.equal(isValidRepo('a/b'), true)
  assert.equal(isValidRepo('owner/repo/extra'), false)
  assert.equal(isValidRepo('../escape'), false)
  assert.equal(isValidRepo('owner/'), false)
  assert.equal(isValidRepo('owner /repo'), false)
  assert.equal(isValidRepo('https://github.com/owner/repo'), false)
  assert.equal(isValidRepo('owner/repo?x=1'), false)
  assert.ok(MAX_SKILL_BYTES > 0 && MAX_SKILL_BYTES <= 4 * 1024 * 1024)
})

test('topicRouteFor falls back to the question text', () => {
  const byTopic = topicRouteFor('城市月度市场分析')
  assert.ok(byTopic !== undefined)
  const byQuestion = topicRouteFor('随便的话题前缀', '想请教城市月度市场分析方面的口径')
  assert.ok(byQuestion !== undefined)
  assert.ok(byQuestion.topic.startsWith('城市月度市场分析'))
  assert.equal(topicRouteFor('完全不相关'), undefined)
})

test('scenarioForTopic uses the question when the topic does not name one', () => {
  const scenario = scenarioForTopic('模糊主题', 'A', '涉及政策解读（新政策出台、政治局会议、定调变化）的问题')
  assert.ok(scenario !== undefined)
})

test('routeRequest output is anonymized: no real names in candidates', () => {
  const result = routeRequest('城市月度市场分析', '6月新房成交数据怎么看')
  assert.ok(result.candidates.length > 0 && result.candidates.length <= 5)
  for (const candidate of result.candidates) {
    assert.equal('name' in candidate, false, 'candidate must not expose the real name')
    assert.ok(candidate.id.startsWith('bk-'))
    assert.ok(candidate.bk.startsWith('BK-'))
    assert.ok(candidate.initials.length > 0)
  }
})
