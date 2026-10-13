import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createResidentialDemoWorkspace } from '../residential-demo-workspace.mjs'

const sessionId = '3971aa6d-feba-4262-a9b1-7f651e32c789'
const jobId = 'rv2-1079256c46498082a38e404f'
const roles = ['price_full', 'price_external', 'rent_full', 'rent_external']
const hashes = roles.map((_, i) => String(i + 1).repeat(64))
const files = roles.map((role, i) => ({ role, file_id: `${role}-${hashes[i].slice(0, 12)}`,
  filename: `${role}.docx`, size_bytes: 100 + i, sha256: hashes[i] }))
const message = roles.map((role, i) =>
  `[${role}](/api/residential-v2/files/${jobId}/${files[i].file_id})`).join('\n')

test('completed C demo is projected from this session and its verified job, including after a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'residential-demo-'))
  try {
    let calls = 0
    const gateway = { conversation: async (_runtime, sid, after) => {
      assert.equal(sid, `session-${sessionId}`)
      calls++
      return after === -1 ? { messages: [{ role: 'assistant', text: message }], nextCursor: 42, hasMore: false }
        : { messages: [], nextCursor: after, hasMore: false }
    } }
    const fetcher = async url => {
      assert.equal(url, `http://127.0.0.1:8793/internal-jobs/${jobId}`)
      return { ok: true, json: async () => ({ job_id: jobId, status: 'succeeded', quality_status: 'passed',
        release_id: 'fz_single_property_toolkit_20261008_v2', files }) }
    }
    const scope = { backendRef: 'zhijian-demo-c', sessionId, runtime: {}, gateway }
    const first = await createResidentialDemoWorkspace({ root, fetcher }).forSession(scope)
    assert.equal(first.files.length, 4)
    assert.equal(first.chapters.length, 6)
    assert.equal(first.files[0].href, `/api/residential-v2/files/${jobId}/${files[0].file_id}`)
    const second = await createResidentialDemoWorkspace({ root, fetcher }).forSession(scope)
    assert.equal(second.jobId, jobId)
    assert.equal(calls, 2)
    assert.equal(await createResidentialDemoWorkspace({ root, fetcher }).forSession({ ...scope, backendRef: 'other' }), undefined)
    assert.equal(await createResidentialDemoWorkspace({ root, fetcher }).forSession({ ...scope, shareId: 'share' }), undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a transcript link cannot publish a mismatched job file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'residential-demo-'))
  try {
    const gateway = { conversation: async () => ({ messages: [{ role: 'assistant', text: message }],
      nextCursor: 42, hasMore: false }) }
    const fetcher = async () => ({ ok: true, json: async () => ({ job_id: jobId, status: 'succeeded',
      quality_status: 'passed', release_id: 'fz_single_property_toolkit_20261008_v2',
      files: files.map((file, i) => i === 0 ? { ...file, sha256: 'f'.repeat(64) } : file) }) })
    const result = await createResidentialDemoWorkspace({ root, fetcher }).forSession({
      backendRef: 'zhijian-demo-c', sessionId, runtime: {}, gateway })
    assert.equal(result, undefined)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a demo request shows the packaged plan and outline before files are ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'residential-demo-'))
  try {
    const gateway = { conversation: async () => ({ messages: [{ role: 'user',
      text: '演示福州住宅价格与租金四份 Word 报告，使用脱敏黄金样例' }], nextCursor: 7, hasMore: false }) }
    const view = await createResidentialDemoWorkspace({ root, fetcher: () => { throw Error('unexpected fetch') } })
      .forSession({ backendRef: 'zhijian-demo-c', sessionId, runtime: {}, gateway })
    assert.equal(view.status, 'pending')
    assert.equal(view.steps.length, 6)
    assert.equal(view.chapters.length, 6)
    assert.deepEqual(view.files, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
