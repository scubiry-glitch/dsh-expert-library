import test from 'node:test'
import assert from 'node:assert/strict'
import { projectRecoveryCheckpoint } from '../src/host/review-recovery.ts'

const event = (seq, type, data) => ({ seq, time: 1000 + seq, type, data })

test('output-limit recovery uses durable todos and returned tool names without replaying arguments', () => {
  const events = [
    event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '做报告' }] }),
    event(2, 'turn/start', { turn: 1 }),
    event(3, 'todo/write', { todos: [{ content: '抓取数据', status: 'completed' }, { content: '生成报告', status: 'in_progress' }] }),
    event(4, 'tool/call', { callId: 'abc', name: 'bash', arguments: '{"token":"secret-value"}' }),
    event(5, 'tool/result', { message: { source: { callId: 'abc' } } }),
    event(6, 'deliverables/presented', { files: [] }),
    event(7, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }),
  ]
  const recovery = projectRecoveryCheckpoint(events)
  assert.equal(recovery.turn, 1)
  assert.match(recovery.prompt, /抓取数据.*completed/)
  assert.match(recovery.prompt, /生成报告.*in_progress/)
  assert.match(recovery.prompt, /已返回的工具：bash/)
  assert.equal(recovery.prompt.includes('secret-value'), false)
  assert.equal(projectRecoveryCheckpoint([...events, event(8, 'user/message', { source: { kind: 'user' } })]), undefined)
  assert.equal(projectRecoveryCheckpoint([...events, event(8, 'turn/start', { turn: 2 })]), undefined)
})

test('recovery falls back to the last visible request and progress when no todo was written', () => {
  const events = [
    event(1, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '完成月报' }] }),
    event(2, 'assistant/message', { message: { content: [{ type: 'text', text: '数据已核对，报告文件尚未写出。' }] } }),
    event(3, 'turn/start', { turn: 2 }),
    event(4, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '请尽快交付' }] }),
    event(5, 'turn/end', { turn: 2, reason: { kind: 'max-tokens' } }),
  ]
  const recovery = projectRecoveryCheckpoint(events)
  assert.match(recovery.prompt, /最近用户要求：请尽快交付/)
  assert.match(recovery.prompt, /报告文件尚未写出/)
  assert.match(recovery.prompt, /没有结构化待办记录/)
})
