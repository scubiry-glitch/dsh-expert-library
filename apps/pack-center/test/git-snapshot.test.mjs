import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, mkdir, readdir, symlink, cp, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { createGitSnapshotFetcher, fetchGitSnapshot, isPublicGitAddress, validateGitSource, snapshotArtifactLimits } from '../dist/git-snapshot.js'
import { extractArtifact, DEFAULT_LIMITS as ARTIFACT_DEFAULT_LIMITS } from '../../../packages/pack-artifact/index.mjs'
import { canonicalBytes, sha256, validateReport } from '../../../packages/pack-contract/index.mjs'
import { gitFixture } from './support/git-fixture.mjs'

test('production source gate rejects SSRF variants, credential-bearing URLs and nonliteral refs', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '100.64.0.1', '192.168.1.2', '172.31.255.1', '198.18.1.1', '192.0.2.1', '203.0.113.1',
    '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2002:0808:0808::', '2001:db8::1', '2001::1', '3fff::1']) assert.equal(isPublicGitAddress(address), false, address)
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicGitAddress(address), true, address)
  const hosts = ['github.com']
  for (const url of ['http://github.com/a/b', 'file:///tmp/repo', 'ssh://github.com/a/b', 'https://user:pass@github.com/a/b', 'https://github.com/a/b#ref', 'https://github.com/a/b?x=y',
    'https://github.com:444/a/b', 'https://github.com./a/b', 'https://github.com.attacker.invalid/a/b', 'https://127.0.0.1/a/b', 'https://github.com/a/../b', 'https://github.com/a%2fb', 'https://github.com\\@attacker.invalid/a']) {
    assert.throws(() => validateGitSource(url, 'main', hosts), { code: 'GIT_SOURCE_REJECTED' })
  }
  for (const ref of ['--upload-pack=bad', 'main:other', 'main^{commit}', 'refs/heads/*', 'x..y', 'a.lock', '@{-1}', 'main\nsecret']) assert.throws(() => validateGitSource('https://github.com/a/b', ref, hosts), { code: 'GIT_REF_REJECTED' })
  assert.equal(validateGitSource('https://github.com/a/b', 'refs/tags/v1.0.0', hosts).hostname, 'github.com')
})

test('snapshot archive producer cannot exceed publisher/client reader limits, including directory entries', () => {
  for (const limits of [{}, { maxFiles: 10000, maxPathDepth: 128, maxArchiveBytes: 800 * 1024 * 1024,
    maxFileBytes: 80 * 1024 * 1024, maxTotalBytes: 640 * 1024 * 1024 }]) {
    const archiveLimits = snapshotArtifactLimits(limits)
    assert.equal(archiveLimits.maxEntries, ARTIFACT_DEFAULT_LIMITS.maxEntries)
    for (const [key, maximum] of Object.entries(archiveLimits)) assert.ok(maximum <= ARTIFACT_DEFAULT_LIMITS[key], key)
  }
  const tightened = snapshotArtifactLimits({ maxFiles: 1, maxFileBytes: 16, maxPathDepth: 2 })
  assert.equal(tightened.maxFiles, 1); assert.equal(tightened.maxFileBytes, 16); assert.equal(tightened.maxPathDepth, 2)
})

test('all resolved addresses must be public; private DNS answers never spawn a process', async t => {
  const fixture = await gitFixture(t)
  let called = false
  const fetch = createGitSnapshotFetcher({ resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], spawn() { called = true; throw new Error('must not run') } })
  await assert.rejects(fetch(fixture.input), { code: 'GIT_NETWORK_REJECTED' })
  assert.equal(called, false)
  assert.deepEqual(await readdir(fixture.outputParent), [])
  await assert.rejects(fetchGitSnapshot({ ...fixture.input, url: 'https://127.0.0.1/repo.git', allowedHosts: ['127.0.0.1'] }), { code: 'GIT_SOURCE_REJECTED' })
})

test('real pinned TLS Git transfer freezes raw files, commit, deterministic tar and report; moving ref does not rewrite old snapshot', async t => {
  const fixture = await gitFixture(t)
  const fetch = createGitSnapshotFetcher(fixture.infrastructure)
  await mkdir(join(fixture.work, 'generated'))
  await writeFile(join(fixture.work, 'generated', 'keep.txt'), 'generated is part of approval\n')
  await writeFile(join(fixture.work, '.gitattributes'), '*.md filter=hostile\n')
  await writeFile(join(fixture.work, 'package.json'), JSON.stringify({ scripts: { prepare: 'touch /DO-NOT-RUN' } }))
  await fixture.git('add', '.'); await fixture.git('commit', '--quiet', '-m', 'inert declarations')
  const commit1 = await fixture.push()
  const snapshot1 = await fetch(fixture.input), repeated = await fetch(fixture.input)
  assert.equal(snapshot1.sourceCommit, commit1)
  assert.equal(snapshot1.packMeta.version, '1.0.0')
  assert.equal(snapshot1.report.valid, true)
  assert.equal(validateReport(snapshot1.report).ok, true)
  assert.equal(snapshot1.reportSha256, sha256(canonicalBytes(snapshot1.report)))
  assert.deepEqual(snapshot1.artifact, repeated.artifact)
  assert.equal(snapshot1.preview.normalization.scriptsExecuted, false)
  assert.match(snapshot1.gitVersion, /^git version 2\./)
  assert.equal(await readFile(join(snapshot1.contentDir, 'generated', 'keep.txt'), 'utf8'), 'generated is part of approval\n')
  assert.ok(snapshot1.preview.entities.scenarios.includes('demo.review.scenario'))
  const extracted = join(fixture.root, 'extracted')
  await extractArtifact(snapshot1.archiveFile, extracted, snapshot1.artifact)
  assert.equal(await readFile(join(extracted, 'README.md'), 'utf8'), await readFile(join(fixture.work, 'README.md'), 'utf8'))
  const firstArchive = await readFile(snapshot1.archiveFile)
  await cp(fileURLToPath(new URL('../../../examples/pack-center/demo-v2/', import.meta.url)), fixture.work, { recursive: true })
  await fixture.git('add', '.'); await fixture.git('commit', '--quiet', '-m', 'v2')
  const commit2 = await fixture.push()
  const snapshot2 = await fetch(fixture.input)
  assert.equal(snapshot2.sourceCommit, commit2); assert.notEqual(commit2, commit1)
  assert.equal(snapshot2.packMeta.version, '1.1.0')
  assert.notEqual(snapshot2.artifact.contentTreeSha256, snapshot1.artifact.contentTreeSha256)
  assert.deepEqual(await readFile(snapshot1.archiveFile), firstArchive)
  assert.equal(JSON.parse(await readFile(join(snapshot1.contentDir, 'pack.json'), 'utf8')).pack.version, '1.0.0')
  assert.ok(fixture.requests.some(r => r.url.startsWith('/repo.git/git-upload-pack')))
  assert.ok(fixture.invocations.every(call => !call.args.includes('checkout') && !call.args.includes('--filters') && !call.args.includes('submodule')))
})

test('Git subprocesses cannot inherit production secrets, proxies, config, hooks or credential helpers', async t => {
  const fixture = await gitFixture(t), saved = {}
  const forbidden = { HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Bearer TEST-SECRET',
    AWS_SECRET_ACCESS_KEY: 'TEST-SECRET', OPENAI_API_KEY: 'TEST-SECRET', GIT_ASKPASS: '/should-not-run',
    GIT_EXEC_PATH: '/should-not-run', NODE_OPTIONS: '--require /should-not-run', LD_PRELOAD: '/should-not-run' }
  for (const [key, value] of Object.entries(forbidden)) { saved[key] = process.env[key]; process.env[key] = value }
  try { await createGitSnapshotFetcher(fixture.infrastructure)(fixture.input) }
  finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value }
  for (const call of fixture.invocations) {
    for (const key of Object.keys(forbidden)) if (key !== 'GIT_ASKPASS') assert.equal(call.env[key], undefined, key)
    assert.equal(call.env.GIT_ASKPASS, '/bin/false')
    assert.ok(call.env.HOME.startsWith(fixture.outputParent))
    assert.ok(call.args.includes('http.curloptResolve=git.fixture.invalid:443:93.184.216.34'))
    assert.ok(call.args.includes('http.followRedirects=false'))
  }
  assert.ok(fixture.requests.every(request => !request.headers.authorization && !request.headers.cookie))
})

test('an HTTPS redirect is rejected without contacting its target', async t => {
  let targetRequests = 0
  const target = createServer((_req, res) => { targetRequests++; res.end('private') })
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve))
  t.after(async () => { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)) })
  const fixture = await gitFixture(t, { respond(req, res) { res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/private` }); res.end() } })
  await assert.rejects(createGitSnapshotFetcher(fixture.infrastructure)(fixture.input), { code: 'GIT_FETCH_FAILED' })
  assert.equal(fixture.requests.length, 1)
  assert.equal(targetRequests, 0)
  assert.deepEqual(await readdir(fixture.outputParent), [])
})

test('dumb HTTP fallback is rejected before it can follow object alternates', async t => {
  const fixture = await gitFixture(t, { respond(req, res) {
    res.setHeader('content-type', 'text/plain')
    if (req.url.includes('/info/refs')) res.end(`${'a'.repeat(40)}\trefs/heads/main\n`)
    else if (req.url === '/repo.git/HEAD') res.end('ref: refs/heads/main\n')
    else if (req.url.includes('alternates')) res.end('http://127.0.0.1:1/private\n')
    else { res.writeHead(404); res.end() }
  } })
  await assert.rejects(createGitSnapshotFetcher(fixture.infrastructure)(fixture.input), { code: 'GIT_FETCH_FAILED' })
  assert.ok(fixture.requests.every(request => !request.url.includes('/objects/')))
  assert.deepEqual(await readdir(fixture.outputParent), [])
})

test('invalid V2 content is frozen for diagnostics but cannot be treated as a valid release', async t => {
  const fixture = await gitFixture(t)
  await writeFile(join(fixture.work, 'pack.json'), '{"pack":{"id":"../bad","version":"1.0.0","schemaVersion":999}}')
  await fixture.git('add', '.'); await fixture.git('commit', '--quiet', '-m', 'invalid'); await fixture.push()
  const snapshot = await createGitSnapshotFetcher(fixture.infrastructure)(fixture.input)
  assert.equal(snapshot.report.valid, false)
  assert.equal(snapshot.packMeta, undefined)
  assert.ok(snapshot.report.diagnostics.some(d => d.severity === 'error'))
  assert.ok((await readFile(snapshot.archiveFile)).length > 0)
  assert.equal(validateReport(snapshot.report).ok, true)
})

test('script declarations and internal-only license restrictions are surfaced without execution', async t => {
  const fixture = await gitFixture(t)
  const pack = JSON.parse(await readFile(join(fixture.work, 'pack.json'), 'utf8'))
  pack.skillPackages.push({ id: 'demo.script', version: '1.0.0', schemaVersion: 2,
    source: { kind: 'workspace', root: 'skills/demo-script', digest: 'x' }, contributions: {},
    permissions: { execScripts: ['run.sh'], internalOnly: true } })
  await mkdir(join(fixture.work, 'skills/demo-script'), { recursive: true })
  const marker = join(fixture.root, 'NEVER-EXECUTE')
  await writeFile(join(fixture.work, 'skills/demo-script/run.sh'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  await writeFile(join(fixture.work, 'pack.json'), JSON.stringify(pack))
  await fixture.git('add', '.'); await fixture.git('commit', '--quiet', '-m', 'declarations'); await fixture.push()
  const snapshot = await createGitSnapshotFetcher(fixture.infrastructure)(fixture.input)
  assert.equal(snapshot.report.valid, true, JSON.stringify(snapshot.report.diagnostics))
  assert.deepEqual(snapshot.report.permissions, { execScripts: ['skills/demo-script/run.sh'], internalOnly: true })
  assert.deepEqual(snapshot.preview.scriptDeclarations, [{ skillId: 'demo.script', path: 'run.sh' }])
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})

test('tracked symlinks and submodule entries are rejected without publication leftovers', async t => {
  for (const type of ['symlink', 'submodule']) await t.test(type, async t => {
    const fixture = await gitFixture(t)
    if (type === 'symlink') { await symlink('/etc/passwd', join(fixture.work, 'evil')); await fixture.git('add', 'evil') }
    else { const commit = await fixture.git('rev-parse', 'HEAD'); await fixture.git('update-index', '--add', '--cacheinfo', `160000,${commit},evil`) }
    await fixture.git('commit', '--quiet', '-m', type); await fixture.push()
    await assert.rejects(createGitSnapshotFetcher(fixture.infrastructure)(fixture.input), { code: 'GIT_ENTRY_REJECTED' })
    assert.deepEqual(await readdir(fixture.outputParent), [])
  })
})

test('Git filenames must meet the same safe NFC path contract as release archives', async t => {
  for (const path of ['unsafe:name.txt', 'e\u0301.txt']) await t.test(path, async t => {
    const fixture = await gitFixture(t)
    await writeFile(join(fixture.work, path), 'not admitted')
    await fixture.git('add', '.'); await fixture.git('commit', '--quiet', '-m', 'unsafe filename'); await fixture.push()
    await assert.rejects(createGitSnapshotFetcher(fixture.infrastructure)(fixture.input), { code: 'GIT_PATH_REJECTED' })
    assert.deepEqual(await readdir(fixture.outputParent), [])
  })
})

test('preview byte bounds preserve complete UTF-8 code points', async t => {
  const fixture = await gitFixture(t)
  await writeFile(join(fixture.work, 'AAA.md'), '😀'.repeat(100))
  await fixture.git('add', '.'); await fixture.git('commit', '--quiet', '-m', 'unicode'); await fixture.push()
  const snapshot = await createGitSnapshotFetcher(fixture.infrastructure)({ ...fixture.input, limits: { maxPreviewBytes: 5 } })
  assert.equal(snapshot.preview.files.find(item => item.path === 'AAA.md').text, '😀')
  assert.ok(snapshot.preview.files.reduce((size, item) => size + Buffer.byteLength(item.text ?? ''), 0) <= 5)
})

test('file count/bytes, object expansion, diagnostic output and wall time limits fail closed', async t => {
  const fixture = await gitFixture(t), fetch = createGitSnapshotFetcher(fixture.infrastructure)
  for (const limits of [{ maxFiles: 1 }, { maxFileBytes: 20 }, { maxTotalBytes: 50 }, { maxObjects: 1 }, { maxGitBytes: 100 }, { maxTreeBytes: 10 }]) {
    await assert.rejects(fetch({ ...fixture.input, limits }), error => /^GIT_(CONTENT|OBJECT|DISK|OUTPUT|FETCH)_LIMIT$|^GIT_FETCH_FAILED$/.test(error.code), JSON.stringify(limits))
    assert.deepEqual(await readdir(fixture.outputParent), [])
  }
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(fetch({ ...fixture.input, signal: aborted.signal }), { code: 'GIT_ABORTED' })
  const slow = await gitFixture(t, { respond() {} })
  await assert.rejects(createGitSnapshotFetcher(slow.infrastructure)({ ...slow.input, limits: { timeoutMs: 500 } }), { code: 'GIT_TIMEOUT' })
  assert.deepEqual(await readdir(slow.outputParent), [])
  await assert.rejects(fetch({ ...fixture.input, ref: 'does-not-exist', limits: { maxLogBytes: 1 } }), { code: 'GIT_LOG_LIMIT' })
  assert.deepEqual(await readdir(fixture.outputParent), [])
  const activeAbort = new AbortController()
  const interrupt = await gitFixture(t, { respond() { activeAbort.abort() } })
  await assert.rejects(createGitSnapshotFetcher(interrupt.infrastructure)({ ...interrupt.input, signal: activeAbort.signal }), { code: 'GIT_ABORTED' })
  assert.deepEqual(await readdir(interrupt.outputParent), [])
})
