import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as wait } from 'node:timers/promises'
import { createReviewStateWatch } from '../src/host/review-state-watch.ts'

test('state watches observe atomic replacement, share updates and stop after unsubscribe', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-watch-'))
  const watch = createReviewStateWatch(20)
  try {
    await mkdir(join(root, 'team')); await writeFile(join(root, 'team/team.json'), '{}')
    const target = { stateRoot: root, teamId: 'team', captainSessionId: 'captain', archived: false }
    let a = 0, b = 0
    const leaveA = watch.subscribe(target, () => a++)
    const leaveB = watch.subscribe(target, () => b++)
    await wait(50)
    const beforeA = a, beforeB = b
    await writeFile(join(root, 'team/next.json'), '{"changed":true}')
    await rename(join(root, 'team/next.json'), join(root, 'team/team.json'))
    for (let i = 0; i < 30 && b === beforeB; i++) await wait(20)
    assert(a > beforeA); assert(b > beforeB)
    leaveA(); const afterA = a, afterB = b
    await writeFile(join(root, 'team/team.json'), '{}')
    for (let i = 0; i < 30 && b === afterB; i++) await wait(20)
    assert.equal(a, afterA); assert(b > afterB)
    leaveB(); const final = b
    await writeFile(join(root, 'team/team.json'), '{"after":true}'); await wait(60)
    assert.equal(b, final)
  } finally { watch.close(); await rm(root, { recursive: true, force: true }) }
})
