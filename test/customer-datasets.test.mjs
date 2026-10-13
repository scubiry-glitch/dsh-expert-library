import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listCustomerDatasets, readCustomerDataset, saveCustomerDataset } from '../src/host/customer-datasets.ts'

test('validated customer results survive reload, page tables, and stay out of the agent workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'customer-data-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const workspace = join(home, 'workspace')
  const foreign = join(root, 'foreign')
  await mkdir(workspace, { recursive: true }); await mkdir(foreign)
  const sessionId = 'session-11111111-1111-4111-8111-111111111111'
  const capture = { sessionId, workspace, configuredWorkspace: workspace,
    dataset: 'realestate.city.market', version: '1.1', signature: 'city=南京', provider: 'zyt',
    provenance: { source: '/private/provider/key-path', caliber: '月度', unit: '套' },
    data: { columns: ['期数', '值'], rows: Array.from({ length: 125 }, (_, index) => [index, index * 2]) } }
  await assert.rejects(saveCustomerDataset(home, { ...capture, workspace: foreign }), /CUSTOMER_DATA_SCOPE_INVALID/)
  const id = await saveCustomerDataset(home, capture)
  const listed = await listCustomerDatasets(home, sessionId)
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0].source, 'zyt')
  assert.equal(JSON.stringify(listed).includes('key-path'), false)
  const first = await readCustomerDataset(home, sessionId, id)
  assert.equal(first.rows.length, 100)
  assert.equal(first.nextOffset, 100)
  const second = await readCustomerDataset(home, sessionId, id, first.nextOffset)
  assert.equal(second.rows.length, 25)
  assert.equal(second.nextOffset, undefined)
  assert.equal(await readCustomerDataset(home, 'session-22222222-2222-4222-8222-222222222222', id), undefined)
  assert.equal(await readCustomerDataset(home, sessionId, '../outside'), undefined)
  assert.equal((await readFile(join(home, 'customer-data', sessionId, `${id}.json`), 'utf8')).includes('key-path'), true)
})
