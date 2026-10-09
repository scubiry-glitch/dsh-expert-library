/** Explicit standalone entry points. Importing this file does not start a service. */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from './config.js'
import { createDatabase } from './database.js'
import { createIdentityService } from './auth.js'
import { createSubmissionService } from './submissions.js'
import { createCenterServer } from './server.js'
import { createLocalArtifactStore } from './storage.js'
import { createValidationWorker } from './validation-worker.js'
import { fixtureInfrastructure } from './fixture-transport.js'
import { createPublisher } from './publisher.js'
import { createGitSnapshotFetcher } from './git-snapshot.js'
import { createPublicKey, createHash } from 'node:crypto'
import { createDeploymentService } from './deployments.js'
import { createReleaseGovernance } from './release-governance.js'
import { createCatalogService } from './catalog.js'
import { allowedGitHosts, builtinPackVersions, developmentHttp, identityConfiguration, privateFile, required, scratchDirectory, trustedSigningKeys } from './runtime-config.js'

export async function runCenter(command: string, env: NodeJS.ProcessEnv = process.env) {
  if (!['migrate', 'bootstrap-admin', 'api', 'validate-worker', 'publish-worker'].includes(command)) throw new Error('Unknown center command')
  const config = loadConfig(env)
  const database = createDatabase(config.database)
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    if (command === 'migrate') {
      const applied = await database.migrate()
      process.stdout.write(JSON.stringify({ event: 'migrated', applied }) + '\n')
      return
    }
    // Services never create or silently upgrade their database during startup.
    await database.verifyMigrations()
    if (command === 'api' || command === 'bootstrap-admin') {
      const identityOptions = await identityConfiguration(env)
      const identity = createIdentityService({ database, ...identityOptions })
      if (command === 'bootstrap-admin') {
        const result = await identity.bootstrapAdmin({ issuer: identityOptions.oidc.issuer,
          subject: required(env, 'PACK_CENTER_BOOTSTRAP_SUBJECT'), displayName: required(env, 'PACK_CENTER_BOOTSTRAP_DISPLAY_NAME') })
        process.stdout.write(JSON.stringify({ event: 'administrator_bootstrapped', ...result }) + '\n')
        return
      }
      const submissions = createSubmissionService(database, identity, { allowedGitHosts: allowedGitHosts(env), scratchRoot: await scratchDirectory(env) })
      const store = await createLocalArtifactStore(required(env, 'PACK_CENTER_ARTIFACT_ROOT'))
      const deployments = createDeploymentService({ database, identity, centerId: config.centerId })
      const governance = createReleaseGovernance({ database, identity })
      const catalog = createCatalogService({ database, identity, deployments, store, centerId: config.centerId, trustedSigningKeys: await trustedSigningKeys(env) })
      const trustedKeys = await trustedSigningKeys(env)
      const centerInfo = { centerId: config.centerId, origin: config.publicOrigin, signingKeys: Object.entries(trustedKeys).map(([keyId, pem]) => {
        const der = createPublicKey(pem).export({ type: 'spki', format: 'der' })
        return { keyId, publicKeyPem: pem, fingerprint: createHash('sha256').update(der).digest('hex') }
      }) }
      const server = createCenterServer({ database, identity, submissions, distribution: { deployments, catalog, governance, centerInfo },
        publicOrigin: config.publicOrigin, allowLoopbackHttp: developmentHttp(env) })
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(config.listenPort, config.listenHost, () => { server.off('error', reject); resolve() })
        })
        process.stdout.write(JSON.stringify({ event: 'api_listening', host: config.listenHost, port: config.listenPort }) + '\n')
        if (!controller.signal.aborted) await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))
      } finally {
        server.closeIdleConnections()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
      return
    }
    const store = await createLocalArtifactStore(required(env, 'PACK_CENTER_ARTIFACT_ROOT'))
    const workerId = `${command}-${process.pid}-${randomUUID()}`
    // Only the signing process reads a signing key. Validation has no signing API.
    const worker = command === 'validate-worker'
      ? createValidationWorker({ database, store, workerId, allowedGitHosts: allowedGitHosts(env),
        scratchRoot: await scratchDirectory(env), validatorVersion: '0.1.0', builtinPackVersions: builtinPackVersions(env),
        ...(env.PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE ? { fetchSnapshot: createGitSnapshotFetcher(fixtureInfrastructure(env.PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE) ?? {}) } : {}) })
      : createPublisher({ database, store, workerId, centerId: config.centerId,
        signingKeyId: required(env, 'PACK_CENTER_SIGNING_KEY_ID'), signingPrivateKey: await privateFile(required(env, 'PACK_CENTER_SIGNING_KEY_FILE')),
        builtinPackVersions: builtinPackVersions(env), scratchRoot: await scratchDirectory(env) })
    while (!controller.signal.aborted) {
      const result = await worker.runOnce()
      // Only stable identifiers/status/codes are returned by these worker APIs.
      if (result.status !== 'idle') process.stdout.write(JSON.stringify({ event: 'worker_result', ...result }) + '\n')
      if (result.status === 'idle') await delay(1000, undefined, { signal: controller.signal }).catch(error => { if (error.name !== 'AbortError') throw error })
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    await database.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCenter(process.argv[2] ?? '').catch(error => {
    if (process.env.PACK_CENTER_STARTUP_DEBUG) process.stderr.write(`STARTUP_DEBUG: ${error instanceof Error ? error.message : String(error)}\n`)
    // Driver and filesystem errors can include secrets/paths. Do not dump them.
    process.stderr.write('Pack center failed to start or continue; verify private configuration, migrations and service dependencies.\n')
    process.exitCode = 1
  })
}
