/** Real center + real host manager/routes, with an isolated React shell only.
 * HTTPS uses a fixture certificate; no production certificate bypass is added. */
import assert from 'node:assert/strict'
import { createServer } from 'node:https'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'
import { transform } from 'lightningcss'
import { createBrowserFixture } from './browser-fixture.mjs'

const { createPackCenterManager } = await import(process.env.PACK_CENTER_MANAGER_SOURCE === '1'
  ? '../../../../src/host/pack-center-manager.ts' : '../../../../lib/host/pack-center-manager.js')
const { createPackCenterRouteHandler } = await import(process.env.PACK_CENTER_MANAGER_SOURCE === '1'
  ? '../../../../src/host/pack-center-routes.ts' : '../../../../lib/host/pack-center-routes.js')
const exec = promisify(execFile)
const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url))
// React DOM is an existing runtime transitive dependency, not a root link.
// Resolve through that package rather than installing or mutating dependencies.
const require = createRequire(import.meta.url)
const runtimeRequire = createRequire(require.resolve('@deepseek-ai/dsh-client-runtime/client'))

export async function createHostBrowserFixture(t) {
  const center = await createBrowserFixture(t, { git: true })
  const { git, provider, publicOrigin, validator, publisher } = center
  function person() {
    const cookies = new Map()
    let csrf
    return {
      async request(path, method = 'GET', body, expected = 200) {
        const response = await fetch(`${publicOrigin}${path}`, { method, redirect: 'manual', headers: {
          Origin: publicOrigin, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        }, body: body === undefined ? undefined : JSON.stringify(body) })
        for (const line of response.headers.getSetCookie()) {
          const pair = line.split(';')[0], index = pair.indexOf('=')
          cookies.set(pair.slice(0, index), pair.slice(index + 1))
        }
        const value = await response.json()
        assert.equal(response.status, expected, `${method} ${new URL(path, publicOrigin).pathname}: unexpected status`)
        if (value.csrfToken) csrf = value.csrfToken
        return value
      },
      async login(subject, invitationToken) {
        const begin = await this.request('/api/auth/login', 'POST', invitationToken ? { invitationToken } : {})
        const callback = new URL(await provider.authorize(begin.authorizationUrl, { subject }))
        return this.request(callback.pathname + callback.search)
      },
    }
  }
  const admin = person(), developer = person(), reviewer = person()
  await admin.login('admin')
  for (const [id, slug] of [['host-ui-owner', 'demo'], ['host-ui-review', 'review']]) {
    await admin.request('/api/organizations', 'POST', { id, slug, name: id }, 201)
  }
  const devInvite = await admin.request('/api/organizations/host-ui-owner/invitations', 'POST', { roles: ['member'] }, 201)
  await developer.login('host-ui-developer', devInvite.invitationToken)
  const reviewInvite = await admin.request('/api/organizations/host-ui-review/invitations', 'POST', { roles: ['reviewer'] }, 201)
  const principal = await reviewer.login('host-ui-reviewer', reviewInvite.invitationToken)
  await admin.request('/api/organizations/host-ui-owner/review-scopes', 'POST', { reviewerId: principal.principal.userId, granted: true })
  const notes = '<img src=x onerror="globalThis.__hostUiXss=1"> Literal release notes.'
  const draft = await developer.request('/api/submissions', 'POST', {
    organizationId: 'host-ui-owner', packId: 'demo.review', name: '浏览器真实领域包', version: '1.0.0',
    source: { url: git.input.url, ref: 'main' }, notes, license: 'MIT', distribution: { kind: 'organization' },
  }, 201)
  await developer.request(`/api/submissions/${draft.id}/validate`, 'POST', { expectedVersion: draft.stateVersion }, 202)
  assert.equal((await validator.runOnce()).status, 'validated')
  const validated = await developer.request(`/api/submissions/${draft.id}`)
  const pending = await developer.request(`/api/submissions/${draft.id}/submit`, 'POST', { expectedVersion: validated.submission.stateVersion })
  const approved = await reviewer.request(`/api/submissions/${draft.id}/review`, 'POST', {
    expectedVersion: pending.stateVersion, contentTreeSha256: validated.snapshot.contentTreeSha256,
    decision: 'approved', comment: 'Independent approval of the exact host UI fixture snapshot',
  })
  assert.equal((await publisher.runOnce()).status, 'published')
  const deployment = await admin.request('/api/v1/deployments', 'POST', { organizationId: 'host-ui-owner', name: 'Browser host' }, 201)
  const issued = await admin.request(`/api/v1/deployments/${deployment.id}/binding-codes`, 'POST', {}, 201)
  const hostRoot = join(git.root, 'host-ui')
  await mkdir(hostRoot, { mode: 0o700 })
  const manager = createPackCenterManager({ root: hostRoot, origin: publicOrigin, capabilities: { pluginVersion: '0.1.0' },
    allowLoopbackHttp: true, timeoutMs: 3000,
    async validateActivation(state) {
      for (const [packId, id] of Object.entries(state.active)) {
        const pack = JSON.parse(await readFile(join(state.installed[id].packPath, 'pack.json'), 'utf8'))
        assert.equal(packId, 'demo.review')
        assert.equal(pack.pack.id, packId)
        assert.equal(pack.pack.version, '1.0.0')
        assert.equal(pack.experts[0].display.publicLabel, '样例 V1')
        assert.equal(pack.teamTemplates[0].slots[0].capabilities[0], 'demo.review')
      }
    },
  })
  await manager.start()
  t.after(() => manager.close())
  const manageToken = randomBytes(32).toString('base64url')
  const handler = createPackCenterRouteHandler({ service: manager, getManageToken: () => manageToken })
  const outDir = join(git.root, 'host-ui-bundle')
  await build({ config: false, cwd: projectRoot, tsconfig: join(projectRoot, 'tsconfig.client.json'),
    entry: { 'host-ui': fileURLToPath(new URL('./host-browser-entry.tsx', import.meta.url)) },
    outDir, format: 'esm', platform: 'browser', dts: false, sourcemap: false, clean: false,
    noExternal: () => true, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    alias: { 'react-dom/client': runtimeRequire.resolve('react-dom/client') },
    plugins: [{
      name: 'host-ui-fixture-css-modules',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css')) return null
        const emitted = resolve(dirname(importer), source)
        // The real client build also rebases emitted CSS imports onto src/.
        const file = emitted.startsWith(join(projectRoot, 'lib') + '/')
          ? join(projectRoot, 'src', emitted.slice((join(projectRoot, 'lib') + '/').length)) : emitted
        return `\0host-css:${file}.mjs`
      },
      async load(id) {
        if (!id.startsWith('\0host-css:')) return null
        const file = id.slice('\0host-css:'.length, -'.mjs'.length)
        const result = transform({ filename: file, code: await readFile(file), cssModules: { pattern: '[hash]_[local]' }, minify: true })
        const mapping = Object.fromEntries(Object.entries(result.exports ?? {}).map(([name, value]) => [name, value.name]))
        return `const tag=document.createElement('style');tag.textContent=${JSON.stringify(result.code.toString())};document.head.append(tag);export default ${JSON.stringify(mapping)};`
      },
    }],
    outputOptions: { entryFileNames: 'host-ui.js' },
  })
  const bundle = await readFile(join(outDir, 'host-ui.js'))
  await exec('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(git.root, 'host-ui.key'), '-out', join(git.root, 'host-ui.crt'), '-days', '1',
    '-subj', '/CN=host-browser.test', '-addext', 'subjectAltName=DNS:host-browser.test'])
  const shell = Buffer.from('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Host center UI test shell</title><style>body{margin:0;background:#f2f3f5;font-family:system-ui,sans-serif;padding:16px}#host-ui{max-width:980px;margin:auto}@media(max-width:480px){body{padding:8px}}</style><div id="host-ui"></div><script type="module" src="/host-ui.js"></script></html>')
  const requests = []
  const server = createServer({ key: await readFile(join(git.root, 'host-ui.key')), cert: await readFile(join(git.root, 'host-ui.crt')) }, async (request, response) => {
    const path = (request.url ?? '').split('?')[0]
    requests.push({ path, method: request.method, ui: request.headers['x-pack-center-ui'] === '1' })
    if (await handler(request, response)) return
    const body = path === '/' ? shell : path === '/host-ui.js' ? bundle : undefined
    if (!body) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    }); response.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return { ...center, manager, hostRoot, hostOrigin: `https://host-browser.test:${server.address().port}`,
    manageToken, bindingCode: issued.bindingCode, releaseId: approved.releaseId, notes, requests,
    async disableDeployment() {
      const current = await admin.request(`/api/v1/deployments/${deployment.id}`)
      await admin.request(`/api/v1/deployments/${deployment.id}/status`, 'POST', { status: 'disabled', expectedVersion: current.deployment.stateVersion })
    },
  }
}
