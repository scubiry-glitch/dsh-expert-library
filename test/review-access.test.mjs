import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  exchangeReviewAccess, issueReviewAccess, revokeReviewAccess,
  revokeSessionReviewAccess, verifyReviewAccess,
} from '../src/host/review-access.ts'

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'expert-review-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('link supports ten independent exchanges under concurrency and stores only hashes', async () => fixture(async root => {
  const now = Date.now()
  const issued = await issueReviewAccess(root, { captainSessionId: 'captain', planId: 'plan' }, now)
  const disk = await readFile(join(root, 'review-access', `${issued.id}.json`), 'utf8')
  assert.equal(disk.includes(issued.token), false)
  assert.equal(disk.includes(issued.token.slice(29)), false)
  const results = await Promise.all(Array.from({ length: 15 }, () => exchangeReviewAccess([root], issued.token, now + 1)))
  assert.equal(results.filter(Boolean).length, 10)
  for (const result of results.filter(Boolean)) assert.ok(await verifyReviewAccess([root], result.cookie, now + 2))
  const cookie = results.find(Boolean).cookie
  assert.equal((await verifyReviewAccess([root], cookie, now + 2))?.record.planId, 'plan')
  assert.equal(await exchangeReviewAccess([root], issued.token, now + 2), undefined)
  assert.equal((await readFile(join(root, 'review-access', `${issued.id}.json`), 'utf8')).includes(cookie.slice(29)), false)
  await revokeReviewAccess(root, issued.id, now + 3)
  assert.equal(await verifyReviewAccess([root], cookie, now + 4), undefined)
}))

test('scope, expiry and captain-wide revocation are enforced', async () => fixture(async root => {
  const other = await mkdtemp(join(tmpdir(), 'expert-review-other-'))
  try {
    const now = Date.now()
    const first = await issueReviewAccess(root, { captainSessionId: 'captain', teamId: 'team' }, now)
    const second = await issueReviewAccess(root, { captainSessionId: 'captain', planId: 'plan' }, now)
    const foreign = await issueReviewAccess(root, { captainSessionId: 'other', teamId: 'foreign' }, now)
    assert.equal(await exchangeReviewAccess([other], first.token, now + 1), undefined)
    assert.equal(await exchangeReviewAccess([root], second.token, now + 24 * 60 * 60 * 1000), undefined)
    const exchanged = await exchangeReviewAccess([root], first.token, now + 1)
    assert.ok(exchanged)
    assert.equal(await revokeSessionReviewAccess(root, 'captain', now + 2), 2)
    assert.equal(await verifyReviewAccess([root], exchanged.cookie, now + 3), undefined)
    assert.ok(await exchangeReviewAccess([root], foreign.token, now + 3))
  } finally { await rm(other, { recursive: true, force: true }) }
}))


test('legacy single-use links and existing cookies remain compatible', async () => fixture(async root => {
  const issued=await issueReviewAccess(root,{captainSessionId:'captain',teamId:'team'})
  const path=join(root,'review-access',issued.id+'.json')
  const record=JSON.parse(await readFile(path,'utf8'))
  delete record.maxExchanges; delete record.cookieDigests
  await writeFile(path,JSON.stringify(record))
  const first=await exchangeReviewAccess([root],issued.token)
  assert.ok(first)
  assert.equal(await exchangeReviewAccess([root],issued.token),undefined)
  const upgraded=JSON.parse(await readFile(path,'utf8'))
  upgraded.cookieDigest=upgraded.cookieDigests[0];delete upgraded.cookieDigests
  await writeFile(path,JSON.stringify(upgraded))
  assert.ok(await verifyReviewAccess([root],first.cookie))
}))
