import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordCustomerUsage, readCustomerUsage } from '../src/host/customer-usage.ts'

test('customer usage records only its configured workspace, aggregates calls and deduplicates task receipts', async t => {
  const home = await mkdtemp(join(tmpdir(), 'customer-usage-'))
  const own = join(home, 'own')
  const foreign = join(home, 'foreign')
  await Promise.all([mkdir(own), mkdir(foreign)])
  const previousHome = process.env.DSH_HOME
  const previousWorkspace = process.env.DSH_CUSTOMER_WORKSPACE_DIR
  process.env.DSH_HOME = home
  process.env.DSH_CUSTOMER_WORKSPACE_DIR = own
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousWorkspace === undefined) delete process.env.DSH_CUSTOMER_WORKSPACE_DIR
    else process.env.DSH_CUSTOMER_WORKSPACE_DIR = previousWorkspace
    await rm(home, { recursive: true, force: true })
  })
  const one = 'session-11111111-1111-4111-8111-111111111111'
  const two = 'session-22222222-2222-4222-8222-222222222222'
  await recordCustomerUsage({ kind: 'expert', id: 'expert-a', version: '1.0.0', sessionId: one, workspace: own })
  await recordCustomerUsage({ kind: 'expert', id: 'expert-a', version: '1.0.0', sessionId: one, workspace: own })
  await recordCustomerUsage({ kind: 'expert', id: 'expert-a', version: '1.0.0', sessionId: two, workspace: own })
  await recordCustomerUsage({ kind: 'expert', id: 'foreign', sessionId: two, workspace: foreign })
  await recordCustomerUsage({ kind: 'skill', id: 'skill-a', sessionId: one, workspace: own, occurrence: 'claim-1' })
  await recordCustomerUsage({ kind: 'skill', id: 'skill-a', sessionId: one, workspace: own, occurrence: 'claim-1' })
  const view = await readCustomerUsage(home, 7)
  assert.deepEqual(view.rankings.expert, [{ id: 'expert-a', version: '1.0.0', calls: 3, sessions: 2 }])
  assert.deepEqual(view.rankings.skill, [{ id: 'skill-a', calls: 1, sessions: 1 }])
  assert.deepEqual(view.rankings.pack, [])
  const files = await readdir(join(home, 'customer-usage'))
  const raw = await readFile(join(home, 'customer-usage', files[0]), 'utf8')
  assert.ok(!raw.includes(own))
  assert.ok(!raw.includes(foreign))
})
