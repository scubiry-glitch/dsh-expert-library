import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createStagedPlan,
  editStagedPlan,
  isStagedPlan,
  readStagedPlan,
  recoverStagedPlans,
  stagedPlanDigest,
  stagedPlanTransitionError,
  transitionStagedPlan,
  withStagedPlanLock,
  writeStagedPlan,
} from '../lib/staged-plan.js'

function plan(digest = 'digest-1') {
  return { planId: 'compiled-plan', digest, template: { id: 'demo', version: '1.0.0' }, tasks: [], roster: [] }
}

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'expert-staged-plan-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('staged plan lifecycle is single-direction and edit records a new revision', () => {
  const original = createStagedPlan({
    plan: plan(),
    request: { scenario: 'demo' },
    runtime: { teamName: 'Demo', description: 'goal' },
    createdBy: 'captain',
    expiresAt: 1000,
    now: 1,
  })
  assert.equal(original.status, 'staged')
  assert.equal(original.schemaVersion, 1)
  assert.equal(original.revision, 0)
  assert.equal(original.plan.planId, original.planId)
  assert.equal(original.digest, stagedPlanDigest(original.plan.digest, original.request, original.runtime))
  assert.notEqual(original.digest, original.plan.digest)
  assert.equal(stagedPlanTransitionError('running', 'approved')?.includes('cannot'), true)
  const approved = transitionStagedPlan(original, 'approved', { actor: 'captain', now: 2 })
  const running = transitionStagedPlan(approved, 'running', { actor: 'captain', now: 3 })
  assert.equal(running.status, 'running')
  const edited = editStagedPlan(original, {
    plan: plan('digest-2'),
    request: { scenario: 'demo', goal: 'updated' },
    runtime: { teamName: 'Demo', description: 'updated' },
    fields: ['goal'],
    actor: 'captain',
    now: 4,
  })
  assert.equal(edited.revision, 1)
  assert.equal(edited.digest, stagedPlanDigest(edited.plan.digest, edited.request, edited.runtime))
  assert.notEqual(edited.digest, original.digest)
  assert.equal(edited.plan.planId, original.planId)
  assert.equal(edited.editLog[0].parentDigest, original.digest)
  assert.equal(edited.editLog[0].digest, edited.digest)
})

test('staged plan writes atomically and survives a fresh read', async () => {
  await withRoot(async root => {
    const staged = createStagedPlan({
      plan: plan(),
      request: { scenario: 'demo' },
      runtime: { teamName: 'Demo', description: 'goal' },
      createdBy: 'captain',
      expiresAt: Date.now() + 1000,
    })
    await writeStagedPlan(root, staged)
    const read = await readStagedPlan(root, staged.planId)
    assert.deepEqual(read, staged)
    assert.equal(isStagedPlan(read), true)
    await writeFile(join(root, 'plans', 'tampered.json'), JSON.stringify({ ...staged, planId: 'tampered', digest: staged.plan.digest }), 'utf8')
    await assert.rejects(() => readStagedPlan(root, 'tampered'), /invalid staged plan/)
    await writeFile(join(root, 'plans', 'broken.json'), '{broken', 'utf8')
    await assert.rejects(() => readStagedPlan(root, 'broken'), /Unexpected token|invalid staged plan/)
  })
})

test('plan lock serializes concurrent mutations', async () => {
  await withRoot(async root => {
    const order = []
    await Promise.all([
      withStagedPlanLock(root, 'p', async () => {
        order.push('first-start')
        await new Promise(resolve => setTimeout(resolve, 10))
        order.push('first-end')
      }),
      withStagedPlanLock(root, 'p', async () => {
        order.push('second-start')
        order.push('second-end')
      }),
    ])
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
  })
})

test('restart recovery makes interrupted running plans explicitly failed', async () => {
  await withRoot(async root => {
    const staged = createStagedPlan({
      plan: plan(), request: { scenario: 'demo' }, runtime: { teamName: 'Demo', description: 'goal' },
      createdBy: 'captain', expiresAt: Date.now() + 1000,
    })
    const running = transitionStagedPlan(transitionStagedPlan(staged, 'approved'), 'running')
    await writeStagedPlan(root, running)
    const recovered = await recoverStagedPlans(root)
    assert.equal(recovered[0]?.status, 'failed')
    assert.match(recovered[0]?.failureReason ?? '', /no durable team/)
    assert.equal((await readStagedPlan(root, staged.planId))?.status, 'failed')
  })
})
