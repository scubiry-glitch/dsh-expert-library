import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCustomerArtifacts } from '../lib/host/customer-artifacts.js'

test('customer artifact publication validates the file and isolates session archives', async t => {
  const root = await mkdtemp(join(tmpdir(), 'customer-artifacts-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home'), workspace = join(root, 'workspace')
  await mkdir(home); await mkdir(workspace)
  const name = 'bank-report.docx'
  await copyFile(resolve('domain-packs/bank-finance/assets/bank-property-value-template.docx'), join(workspace, name))
  const artifacts = createCustomerArtifacts(home, workspace)
  const sessionA = 'session-11111111-1111-4111-8111-111111111111'
  const sessionB = 'session-22222222-2222-4222-8222-222222222222'
  const published = await artifacts.publish(sessionA, name, 'report-1', '房产价值报告')
  assert.match(published.downloadPath, /\/api\/sessions\/11111111-1111-4111-8111-111111111111\/workspace\/documents\/conversation\//)
  assert.equal((await artifacts.list(sessionA))[0].name, name)
  assert.deepEqual(await artifacts.list(sessionB), [])
  const document = await artifacts.document(sessionA, 'conversation', published.id)
  assert.equal(Buffer.from(document.document.content, 'base64').subarray(0, 4).toString('hex'), '504b0304')
  assert.equal(await artifacts.document(sessionB, 'conversation', published.id), undefined)
  await writeFile(join(workspace, 'bad.docx'), 'not a Word file')
  await assert.rejects(() => artifacts.publish(sessionA, 'bad.docx', 'report-2', '错误文件'), /ARTIFACT_CONTENT_INVALID/)
  await assert.rejects(() => artifacts.publish(sessionA, '../outside.docx', 'report-2', '越界文件'))
})
