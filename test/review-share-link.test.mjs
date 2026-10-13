import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { issueReviewShareLink } from '../src/host/review-share-link.ts'
import { exchangeReviewAccess, verifyReviewAccess } from '../src/host/review-access.ts'

test('chat links open each human gate in a fresh browser with scoped, expiring access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-chat-link-'))
  try {
    for (const gate of ['plan', 'outline', 'body']) {
      const target = { captainSessionId: 'captain', planId: 'plan-1', gate,
        ...(gate === 'plan' ? {} : { teamId: 'team-1', taskId: 't5' }) }
      const url = new URL(await issueReviewShareLink(root, 'https://studio.example', target))
      assert.equal(url.searchParams.get('gate'), gate)
      assert.equal(url.searchParams.get('plan'), 'plan-1')
      assert.equal(url.searchParams.get('task'), gate === 'plan' ? null : 't5')
      const token = new URLSearchParams(url.hash.slice(1)).get('share')
      assert.ok(token)
      assert.equal(url.search.includes(token), false)
      const access = await exchangeReviewAccess([root], token)
      assert.equal(access.record.captainSessionId, 'captain')
      assert.equal(access.record.planId, 'plan-1')
      assert.equal(access.record.teamId, target.teamId)
      assert.ok(await verifyReviewAccess([root], access.cookie))
      assert.equal(await verifyReviewAccess([root], access.cookie, access.record.expiresAt), undefined)
      const record = await readFile(join(root, 'review-access', access.record.id + '.json'), 'utf8')
      assert.equal(record.includes(token), false)
      assert.equal(record.includes(access.cookie), false)
    }
    const before = await readdir(join(root, 'review-access'))
    assert.equal(await issueReviewShareLink(root, undefined, { captainSessionId: 'captain', planId: 'plan-1', gate: 'plan' }), undefined)
    assert.deepEqual(await readdir(join(root, 'review-access')), before)
  } finally { await rm(root, { recursive: true, force: true }) }
})
