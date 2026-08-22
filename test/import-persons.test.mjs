/**
 * P2.3 人物转专家管线测试：解析器（两种逐字稿格式）、名称归一化、
 * 草稿确定性、反捏造标记（_needs_review）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseTranscript, personDraft } from '../scripts/import-persons.mjs'

test('header-only transcript format (飞书逐字稿) aggregates per normalized speaker', () => {
  const text = [
    '# 会议',
    '**录音主题**: 测试',
    '**说话人 1 00:00:01**',
    '第一段发言',
    '第二段发言',
    '**说话人 2 00:00:05**',
    '别人的发言',
    '**说话人 1 00:01:00**',
    '第三段发言',
  ].join('\n')
  const persons = parseTranscript(text)
  // 元信息标签不计入说话人；时间戳被归一化。
  assert.equal(persons.length, 2)
  const s1 = persons.find(p => p.name === '说话人 1')
  const s2 = persons.find(p => p.name === '说话人 2')
  assert.equal(s1?.count, 3)
  assert.equal(s2?.count, 1)
  assert.deepEqual(s1?.lines, ['第一段发言', '第二段发言', '第三段发言'])
})

test('inline format (`**名字**：发言`) is supported', () => {
  const text = '**张三**：先看样板。\n李四：不同意。\n**张三**：再看考核。'
  const persons = parseTranscript(text)
  assert.equal(persons.length, 2)
  assert.equal(persons[0].name, '张三')
  assert.equal(persons[0].count, 2)
})

test('metadata labels are never treated as speakers', () => {
  const text = '**录音主题**: 零售\n**录音时间**: 2026-07-30\n**说话人 1 00:00:01**\n内容'
  const persons = parseTranscript(text)
  assert.deepEqual(persons.map(p => p.name), ['说话人 1'])
})

test('personDraft is deterministic, fact-only and marks inference fields', () => {
  const person = { name: '说话人 3', count: 2, lines: ['我们做租房平台', '考核绑定分行执行'] }
  const a = personDraft(person, 't.md')
  const b = personDraft(person, 't.md')
  assert.deepEqual(a, b, 'same input ⇒ same draft')
  assert.equal(a._needs_review, true)
  assert.equal(a.expert_id, 'PERSON-说话人_3')
  assert.ok(a.topics.includes('租房'))
  assert.ok(a.topics.includes('考核'))
  assert.equal(a.persona.style.length, 0, '推断字段留空，不捏造')
  assert.ok(a.evidence.representative_quotes.length >= 1)
})
