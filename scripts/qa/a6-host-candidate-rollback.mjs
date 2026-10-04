/** Real Host startup around candidate installation and rollback, without credentials. */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const digest = value => createHash('sha256').update(value).digest('hex')

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function listening(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = result => { socket.destroy(); resolve(result) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(500, () => done(false))
  })
}

export async function runHostCandidateRollback() {
  const root = await mkdtemp(join(tmpdir(), 'a6-host-candidate-ready-'))
  const dshHome = join(root, 'dsh-home')
  const profile = 'a6-candidate-rollback'
  const profileRoot = join(dshHome, 'profiles', profile)
  const port = await freePort()
  const env = { ...process.env, DSH_HOME: dshHome, CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
  const commands = []
  let child
  const command = async (file, args, cwd = root) => {
    const started = Date.now()
    const result = await exec(file, args, { cwd, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })
    commands.push({ command: file, argv: args, exitCode: 0, durationMs: Date.now() - started })
    return result
  }
  const pack = async (cwd, name) => {
    const destination = join(root, name)
    await mkdir(destination)
    await command('pnpm', ['pack', '--pack-destination', destination], cwd)
    const entries = (await readdir(destination)).filter(name => name.endsWith('.tgz'))
    assert.equal(entries.length, 1)
    const path = join(destination, entries[0])
    const bytes = await readFile(path)
    return { path, sha256: digest(bytes), bytes }
  }
  const installed = async () => {
    const packageRoot = join(profileRoot, 'node_modules', '@zhijian', 'dsh-expert-library')
    const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
    return { name: metadata.name, version: metadata.version, bundleSha256: digest(await readFile(join(packageRoot, 'lib', 'index.js'))) }
  }
  let installCalls = 0
  async function installCompatiblePeer() {
    // The system `dsh --from-default-profile web` template currently carries
    // an older dsh-settings package. The production web profile and this
    // checkout use the compatible rc.8 API; mount that one package into the
    // throw-away profile only. No production file is changed or read beyond
    // this package path.
    const peerDir = join(profileRoot, 'node_modules', '@deepseek-ai')
    const target = join(peerDir, 'dsh-settings')
    await mkdir(peerDir, { recursive: true })
    await symlink(join(REPO, 'node_modules', '@deepseek-ai', 'dsh-settings'), target, 'dir').catch(error => {
      if (error?.code !== 'EEXIST') throw error
    })
  }
  const installVerified = async (artifact, expectedSha256) => {
    if (digest(await readFile(artifact)) !== expectedSha256) throw new Error('ARTIFACT_DIGEST_MISMATCH')
    installCalls++
    await command('dsh', ['plugin', '--profile', profile, 'add', artifact])
    await installCompatiblePeer()
    return installed()
  }
  const stop = async () => {
    if (child) {
      const processGroup = child.pid
      try { process.kill(-processGroup, 'SIGTERM') } catch {}
      for (let i = 0; i < 50 && await listening(port); i++) await sleep(100)
      try { process.kill(-processGroup, 'SIGKILL') } catch {}
      await Promise.race([new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', resolve) }), sleep(1000)])
      child = undefined
    }
    assert.equal(await listening(port), false, 'isolated listener must stop between installations')
  }
  const probe = async label => {
    assert.equal(await listening(port), false)
    const started = Date.now()
    // Capture the ephemeral login URL in memory only. It is never written to
    // logs or the receipt; readiness is authenticated root 200 + state 200.
    child = spawn('dsh', ['--profile', profile, '--host', '127.0.0.1', '--port', String(port)], {
      cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let hostOutput = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { hostOutput = `${hostOutput}${chunk}`.slice(-16_384) })
    let spawnError
    child.once('error', error => { spawnError = error })
    const observations = []
    let ready = false
    // Loading an isolated pnpm profile can take well over a minute on a cold
    // machine (bundle composition is CPU-bound); do not mistake that for an
    // HTTP readiness failure.
    while (Date.now() - started < 180_000) {
      if (spawnError) throw new Error(`HOST_SPAWN_${spawnError.code ?? 'ERROR'}`)
      if (child.exitCode !== null) throw new Error(`HOST_EXIT_${child.exitCode} ${hostOutput.replace(/token=\S+/g, 'token=[REDACTED]').slice(-500)}`)
      let rootStatus = null
      let stateStatus = null
      let authStatus = null
      let authStateStatus = null
      let authRootCookieStatus = null
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })
        rootStatus = response.status
        await response.body?.cancel()
      } catch {}
      try {
        const response = await fetch(`http://127.0.0.1:${port}/plugins/dsh-expert-library/state`, { signal: AbortSignal.timeout(1000) })
        stateStatus = response.status
        await response.body?.cancel()
      } catch {}
      // The CLI may print the canonical authority as localhost/loopback or
      // an IPv6 literal depending on host normalization; only retain the
      // token value in memory and use our known endpoint for the exchange.
      const tokenMatch = hostOutput.match(/https?:\/\/[^\s?]+\/\?token=([^\s]+)/)
      if (tokenMatch) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(tokenMatch[1])}`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
          authStatus = response.status
          const cookie = response.headers.get('set-cookie')?.split(';')[0]
          await response.body?.cancel()
          if (cookie) {
            const rootResponse = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(1000) })
            authRootCookieStatus = rootResponse.status
            await rootResponse.body?.cancel()
            const stateResponse = await fetch(`http://127.0.0.1:${port}/plugins/dsh-expert-library/state`, { headers: { cookie }, signal: AbortSignal.timeout(1000) })
            authStateStatus = stateResponse.status
            await stateResponse.body?.cancel()
          }
        } catch {}
      }
      const last = observations.at(-1)
      if (!last || last.rootStatus !== rootStatus || last.stateStatus !== stateStatus || last.authStatus !== authStatus || last.authStateStatus !== authStateStatus || last.authRootCookieStatus !== authRootCookieStatus) {
        observations.push({ elapsedMs: Date.now() - started, rootStatus, stateStatus, authStatus, authRootCookieStatus, authStateStatus, tokenSeen: Boolean(tokenMatch) })
      }
      if (authStatus === 303 && [200, 303].includes(authRootCookieStatus) && authStateStatus === 200) { ready = true; break }
      await sleep(500)
    }
    const result = { label, ready, startupMs: Date.now() - started, observations, final: observations.at(-1), installed: await installed(), unauthenticated: { root: observations.at(-1)?.rootStatus, state: observations.at(-1)?.stateStatus }, authenticated: { tokenExchange: observations.at(-1)?.authStatus, rootWithCookie: observations.at(-1)?.authRootCookieStatus, state: observations.at(-1)?.authStateStatus } }
    await stop()
    result.listenerStopped = true
    assert.equal(ready, true, `${label}: Host routes did not reach token redirect + authenticated root/state: ${JSON.stringify(observations)}`)
    return result
  }
  try {
    await command('dsh', ['--from-default-profile', 'web', '--profile', profile, '--help'])
    let candidate, old, metadata, candidateVersion
    const reuseRoot = process.env.A6_REUSE_ARTIFACT_ROOT
    if (reuseRoot) {
      const candidatePath = join(reuseRoot, 'candidate', 'zhijian-dsh-expert-library-0.1.0.tgz')
      const oldPath = join(reuseRoot, 'old', 'zhijian-dsh-expert-library-0.0.1-a6-old.tgz')
      candidate = { path: candidatePath, bytes: await readFile(candidatePath) }
      candidate.sha256 = digest(candidate.bytes)
      old = { path: oldPath, bytes: await readFile(oldPath) }
      old.sha256 = digest(old.bytes)
      const candidateMeta = JSON.parse((await command('tar', ['-xOf', candidatePath, 'package/package.json'])).stdout)
      metadata = JSON.parse((await command('tar', ['-xOf', oldPath, 'package/package.json'])).stdout)
      candidateVersion = candidateMeta.version
    } else {
      candidate = await pack(REPO, 'candidate')
      await command('tar', ['-xzf', candidate.path, '-C', root])
      const metadataPath = join(root, 'package', 'package.json')
      metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      assert.equal(metadata.name, '@zhijian/dsh-expert-library')
      candidateVersion = metadata.version
      metadata.version = '0.0.1-a6-old'
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
      old = await pack(dirname(metadataPath), 'old')
    }
    assert.equal(metadata.name, '@zhijian/dsh-expert-library')
    assert.notEqual(old.sha256, candidate.sha256)
    assert.notEqual(metadata.version, candidateVersion)

    const oldInstalled = await installVerified(old.path, old.sha256)
    assert.equal(oldInstalled.version, metadata.version)
    const oldProbe = await probe('old')
    const candidateInstalled = await installVerified(candidate.path, candidate.sha256)
    assert.equal(candidateInstalled.version, candidateVersion)
    const candidateProbe = await probe('candidate')

    const tampered = join(root, 'candidate-tampered.tgz')
    await writeFile(tampered, Buffer.concat([candidate.bytes, Buffer.from('a6-tamper')]))
    const beforeTamper = installCalls
    await assert.rejects(() => installVerified(tampered, candidate.sha256), /ARTIFACT_DIGEST_MISMATCH/)
    assert.equal(installCalls, beforeTamper)
    assert.deepEqual(await installed(), candidateInstalled)

    const rollbackInstalled = await installVerified(old.path, old.sha256)
    assert.deepEqual(rollbackInstalled, oldInstalled)
    const rollbackProbe = await probe('rollback')
    return {
      schemaVersion: 1, kind: 'a6-host-candidate-startup-rollback', status: 'PASS', generatedAt: new Date().toISOString(),
      runCommand: 'node scripts/qa/a6-host-candidate-rollback.mjs',
      workspaceRoot: root, profile: { name: profile, dshHome, isolated: true }, endpoint: `http://127.0.0.1:${port}`,
      productionProfileTouched: false, credentialsRead: false, credentialsRecorded: false,
      artifacts: {
        candidate: { sha256: candidate.sha256, version: candidateVersion },
        old: { sha256: old.sha256, version: metadata.version, provenance: 'Candidate tarball repacked with a distinct rollback-fixture version; identical runtime payload.' },
      },
      probes: [oldProbe, candidateProbe, rollbackProbe],
      tamperPreflight: { expectedSha256: candidate.sha256, actualSha256: digest(await readFile(tampered)), rejected: true, installInvoked: false, installedCandidateUnchanged: true },
      packageManagerInstallCount: installCalls, commands,
      listenerStopped: true, stagingRemovedAfterRun: !reuseRoot,
      limitations: [
        'The old package is a distinct-version rollback fixture, not a previously published runtime: this proves package switching and Host startup, not historical schema migration.',
        'Unauthenticated root/state readiness (200/401) is verified; authenticated GUI, provider execution, and active task continuation belong to separate evidence.',
        'Digest preflight is the explicit release runner guard; this does not claim DSH itself rejects an altered tarball.',
        'The isolated profile mounts the repository’s compatible dsh-settings peer (rc.8) because the shipped system template exposes an older API; this avoids touching the production profile.',
      ],
    }
  } finally {
    await stop()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHostCandidateRollback().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    // execFile errors can include command output containing ephemeral Host
    // login URLs. Publish only the safe error label/exit code.
    process.stderr.write(`${error?.code === 'ERR_ASSERTION' ? `HOST_ROLLBACK_ASSERTION ${error.message}` : error?.code ? `HOST_ROLLBACK_${error.code}` : error?.message ?? 'HOST_ROLLBACK_FAILED'}\n`)
    process.exitCode = 1
  })
}
