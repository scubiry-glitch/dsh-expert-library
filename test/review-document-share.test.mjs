import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeamDir, createTaskProject, publishTaskArtifact, writeTeam } from '../lib/state.js'
import { handleReviewRoutes, REVIEW_PREFIX } from '../src/host/review-routes.ts'
import { issueReviewAccess } from '../src/host/review-access.ts'

function request(path, { method = 'GET', headers = {}, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.headers = { host: 'example.test', origin: 'https://example.test', ...headers }
  return req
}
async function invoke(runtime, path, options) {
  const res = { status: 0, headers: {}, body: '', writeHead(status, headers = {}) { this.status = status; this.headers = headers }, end(value = '') { this.body += value } }
  await handleReviewRoutes(request(path, options), res, new URL(`https://example.test${path}`), runtime)
  return { ...res, data: res.headers['content-type']?.includes('json') ? JSON.parse(res.body) : undefined }
}

test('an authorized click publishes immutable bytes at a direct anonymous /render URL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'review-document-share-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const now = Date.now()
  const task = { id: 't1', subject: '报告', status: 'completed', assignee: 'captain', attempt: 1, dependencies: [], createdAt: now, updatedAt: now, output: '交付说明' }
  const team = { id: 'team', name: 'team', captainSessionId: 'captain', createdAt: now, members: [], tasks: [task], taskSeq: 1 }
  await createTeamDir(root, team)
  task.project = await createTaskProject(root, team.id, task)
  const artifact = await publishTaskArtifact(root, team, task, { name: 'report.md', content: '# Verified report', mediaType: 'text/markdown' })
  task.publishedArtifacts = [artifact]
  await writeTeam(root, team)
  const runtime = {
    hostAuth: () => 401,
    stateRoots: () => [root],
    publicRenderRoot: join(root, 'public'),
    resolve: async (captain, teamId) => captain === 'captain' && teamId === 'team' ? { stateRoot: root, captainSessionId: captain, teamId, archived: false } : undefined,
    read: async () => { throw Error('unexpected read') }, action: async () => { throw Error('unexpected action') },
  }
  const grant = await issueReviewAccess(root, { captainSessionId: 'captain', teamId: 'team' })
  const exchange = await invoke(runtime, `${REVIEW_PREFIX}/api/exchange`, { method: 'POST', body: { token: grant.token } })
  const headers = { cookie: exchange.headers['set-cookie'].split(';')[0] }
  const issuePath = `${REVIEW_PREFIX}/api/document-share?access=${exchange.data.accessId}`
  const input = { taskId: 't1', artifactId: artifact.id }
  assert.equal((await invoke(runtime, issuePath, { method: 'POST', body: input })).status, 401)
  assert.equal((await invoke(runtime, issuePath, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: input })).status, 403)
  assert.equal((await invoke(runtime, issuePath, { method: 'POST', headers, body: { taskId: 't1', artifactId: 'missing' } })).status, 409)
  const issued = await invoke(runtime, issuePath, { method: 'POST', headers, body: input })
  assert.equal(issued.status, 200)
  assert.match(issued.data.path, /^\/render\/expert-library\/[a-f0-9]{20}\/[a-f0-9]{16}-[a-f0-9]{64}\.md$/)
  assert.equal(await readFile(join(root, 'public', issued.data.path.slice('/render/'.length)), 'utf8'), '# Verified report')
  assert.equal((await invoke(runtime, issuePath, { method: 'POST', headers, body: input })).data.path, issued.data.path)
  assert.equal((await invoke(runtime, `${REVIEW_PREFIX}/api/state?task=t1&document=${artifact.id}`)).status, 401)
  await writeFile(join(root, team.id, task.project.artifactsPath, artifact.relativePath), 'changed')
  assert.equal((await invoke(runtime, issuePath, { method: 'POST', headers, body: input })).status, 409)
  assert.equal(await readFile(join(root, 'public', issued.data.path.slice('/render/'.length)), 'utf8'), '# Verified report')
})

test('shared document viewer is isolated from the full review page', async () => {
  const runtime = { stateRoots: () => [], resolve: async () => undefined, read: async () => { throw Error() }, action: async () => { throw Error() } }
  const page = await invoke(runtime, `${REVIEW_PREFIX}/document`)
  assert.equal(page.status, 200)
  assert.match(page.body, /shared-document\.js/)
  assert.match(page.headers['content-security-policy'], /default-src 'none'/)
  assert.equal(page.headers['referrer-policy'], 'no-referrer')
  assert.equal((await invoke(runtime, `${REVIEW_PREFIX}/shared-document.js`)).status, 200)
})
