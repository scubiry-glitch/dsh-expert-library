/** Real HTTP/OIDC/PostgreSQL fixture shared by transport and Chromium checks.
 * It creates no fake sessions and performs no business-table seeding. */
import { createServer, request as httpRequest } from 'node:http'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIdentityService } from '../../dist/auth.js'
import { createSubmissionService } from '../../dist/submissions.js'
import { createCenterServer } from '../../dist/server.js'
import { createLocalArtifactStore } from '../../dist/storage.js'
import { createGitSnapshotFetcher } from '../../dist/git-snapshot.js'
import { createValidationWorker } from '../../dist/validation-worker.js'
import { createPublisher } from '../../dist/publisher.js'
import { createDeploymentService } from '../../dist/deployments.js'
import { createCatalogService } from '../../dist/catalog.js'
import { createReleaseGovernance } from '../../dist/release-governance.js'
import { createDatabaseFixture } from './database-fixture.mjs'
import { createTestIssuer } from './identity-fixture.mjs'
import { gitFixture } from './git-fixture.mjs'

export async function createBrowserFixture(t, { git: withGit = false, publicGit = false } = {}) {
  const fixture = await createDatabaseFixture(withGit ? 'browser' : 'web-http')
  t.after(() => fixture.close())
  const database = await fixture.database(t)
  const provider = await createTestIssuer()
  t.after(() => provider.close())
  // Reserve a random loopback port long enough to configure the fixed OIDC
  // callback/publicOrigin. No request ever derives identity from Host headers.
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  const publicOrigin = `http://127.0.0.1:${port}`
  await new Promise(resolve => reservation.close(resolve))
  const identity = createIdentityService({ database,
    oidc: { ...provider.config, redirectUri: `${publicOrigin}/api/auth/callback` }, loginEncryptionKey: randomBytes(32) })
  await identity.bootstrapAdmin({ issuer: provider.issuer, subject: 'admin', displayName: 'Browser Administrator' })
  const gitHost = publicGit ? 'github.com' : 'git.fixture.invalid'
  const submissions = createSubmissionService(database, identity, { allowedGitHosts: [gitHost] })
  let git, validator, publisher, distribution, administratorTrust
  if (withGit) {
    if (publicGit) {
      const root = await mkdtemp(join(tmpdir(), 'pack-center-browser-public-git-'))
      const outputParent = join(root, 'output'); await mkdir(outputParent)
      t.after(() => rm(root, { recursive: true, force: true }))
      git = {
        root,
        outputParent,
        requests: [],
        input: {
          url: 'https://github.com/weixkcornell/macro-capital-analyst.git',
          ref: 'f42bf4c8068294726ab7c780fe23ad121d72f34e',
          outputParent,
          allowedHosts: ['github.com'],
          validatorVersion: '0.1.0',
        },
        infrastructure: {},
      }
    } else {
      git = await gitFixture(t)
    }
    const store = await createLocalArtifactStore(join(git.root, 'browser-store'))
    const keys = generateKeyPairSync('ed25519')
    // Test-only independent administrator channel. Never derived from exchange.
    administratorTrust = { centerId: 'browser-center', trustedSigningKeys: {
      'browser-key': keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    } }
    const deployments = createDeploymentService({ database, identity, centerId: 'browser-center' })
    const catalog = createCatalogService({ database, identity, deployments, store, centerId: 'browser-center', trustedSigningKeys: { 'browser-key': keys.publicKey } })
    const governance = createReleaseGovernance({ database, identity })
    distribution = { deployments, catalog, governance }
    validator = createValidationWorker({ database, store, fetchSnapshot: createGitSnapshotFetcher(git.infrastructure),
      allowedGitHosts: [gitHost], scratchRoot: git.outputParent, validatorVersion: '0.1.0', workerId: publicGit ? 'browser-public-validator' : 'browser-validator' })
    publisher = createPublisher({ database, store, centerId: 'browser-center', signingKeyId: 'browser-key',
      signingPrivateKey: keys.privateKey, workerId: 'browser-publisher', scratchRoot: git.root })
  }
  const server = createCenterServer({ database, identity, submissions, distribution, publicOrigin, allowLoopbackHttp: true })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })

  function raw(path, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers }, response => {
        const chunks = []
        response.on('data', bytes => chunks.push(bytes)); response.on('error', reject)
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('error', reject)
      request.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  return { database, provider, identity, submissions, server, publicOrigin, raw, git, validator, publisher, administratorTrust }
}
