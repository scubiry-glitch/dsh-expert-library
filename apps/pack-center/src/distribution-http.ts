/** Same-origin human administration and host-only deployment distribution.
 * This module never accepts credentials or download grants in URL parameters.
 * The outer server supplies the actual cookie/CSRF and Bearer authentication.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { HumanPrincipal } from './auth.js'
import type { MachinePrincipal, createDeploymentService } from './deployments.js'
import type { createCatalogService } from './catalog.js'
import type { createReleaseGovernance } from './release-governance.js'
import type { DistributionScope } from '../../../packages/pack-contract/index.mjs'

export interface DistributionHttpContext {
  request: IncomingMessage
  response: ServerResponse
  url: URL
  method: string
  human(mutation?: boolean): Promise<HumanPrincipal>
  machine(token: string): Promise<MachinePrincipal>
  jsonBody(): Promise<Record<string, unknown>>
  send(status: number, body: unknown): void
  requestKey(): string
  setRoute?(label: string): void
}
export interface DistributionHttpOptions {
  centerInfo?: { centerId: string; origin: string; signingKeys: Array<{ keyId: string; publicKeyPem: string; fingerprint: string }> }
  deployments: ReturnType<typeof createDeploymentService>
  catalog: ReturnType<typeof createCatalogService>
  governance: ReturnType<typeof createReleaseGovernance>
}
export class DistributionHttpError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code) }
}
type Body = Record<string, unknown>
const denied = () => { throw new DistributionHttpError('MACHINE_TRANSPORT_DENIED', 403) }
function fields(body: Body, allowed: readonly string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new DistributionHttpError('INVALID_INPUT')
}
function string(body: Body, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || !value.length) throw new DistributionHttpError('INVALID_INPUT')
  return value
}
function version(body: Body): number {
  const value = body.expectedVersion
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new DistributionHttpError('INVALID_INPUT')
  return value
}
function query(url: URL, allowed: readonly string[]) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new DistributionHttpError('INVALID_INPUT')
  }
}
function pagination(url: URL) {
  const raw = url.searchParams.get('limit')
  if (raw !== null && (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 100)) throw new DistributionHttpError('INVALID_INPUT')
  const beforeId = url.searchParams.get('beforeId')
  return { ...(raw === null ? {} : { limit: Number(raw) }), ...(beforeId === null ? {} : { beforeId }) }
}
function hasBrowserHeaders(request: IncomingMessage): boolean {
  return Object.keys(request.headers).some(name => name === 'cookie' || name === 'origin' || name.startsWith('sec-fetch-'))
}
function duplicateHeader(request: IncomingMessage, name: string): boolean {
  let found = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index]?.toLowerCase() === name) found += 1
  return found > 1
}
function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization
  if (value === undefined) return undefined
  if (duplicateHeader(request, 'authorization') || typeof value !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,512}$/.test(value)) {
    throw new DistributionHttpError('UNAUTHENTICATED', 401)
  }
  return value.slice(7)
}
function hostOnly(request: IncomingMessage) {
  if (hasBrowserHeaders(request)) denied()
}

/** Transport classification ONLY: this is not authentication. The enclosing
 * Origin check may exempt exactly these host routes. All authority is rechecked
 * inside the handler and its services. A malformed header never creates an exemption. */
export function isDistributionHostRequest(request: IncomingMessage, url: URL): boolean {
  if (hasBrowserHeaders(request)) return false
  const method = request.method ?? ''
  if (url.pathname === '/api/v1/deployment-bindings/exchange' && method === 'POST') return request.headers.authorization === undefined
  let token: string | undefined
  try { token = bearer(request) } catch { return false }
  if (!token) return false
  if (method === 'GET' && (url.pathname === '/api/v1/releases' || /^\/api\/v1\/releases\/[^/]+(?:\/artifact)?$/.test(url.pathname))) return true
  return method === 'POST' && /^\/api\/v1\/releases\/[^/]+\/download-grants$/.test(url.pathname)
}

export function createDistributionHandler(options: DistributionHttpOptions) {
  const { deployments, catalog, governance } = options
  return async function handle(context: DistributionHttpContext): Promise<boolean> {
    const { request, response, url, method } = context
    const path = url.pathname
    if (!path.startsWith('/api/v1/')) return false
    if (request.headers.authorization !== undefined && request.headers.cookie !== undefined) {
      throw new DistributionHttpError('AMBIGUOUS_AUTHENTICATION', 400)
    }
    async function human(mutation = false) {
      if (request.headers.authorization !== undefined) throw new DistributionHttpError('HUMAN_AUTHENTICATION_REQUIRED', 403)
      return context.human(mutation)
    }
    async function reader(mutation = false): Promise<HumanPrincipal | MachinePrincipal> {
      const token = bearer(request)
      if (token !== undefined) { hostOnly(request); return context.machine(token) }
      return context.human(mutation)
    }
    const label = (name: string) => context.setRoute?.(`distribution.${name}`)
    const releaseList = /^\/api\/v1\/organizations\/([^/]+)\/releases$/.exec(path)
    if (releaseList && method === 'GET') {
      label('release.organization-list'); query(url, ['limit', 'beforeId'])
      context.send(200, await governance.listOrganization(await human(), decodeURIComponent(releaseList[1]!), pagination(url)))
      return true
    }

    if (path === '/api/v1/deployment-bindings/exchange' && method === 'POST') {
      label('binding.exchange'); query(url, []); hostOnly(request)
      if (request.headers.authorization !== undefined) denied()
      const body = await context.jsonBody(); fields(body, ['bindingCode'])
      const exchanged = await deployments.exchange({ bindingCode: string(body, 'bindingCode') })
      context.send(200, { ...exchanged, trustInfo: await catalog.centerInfo() })
      return true
    }

    if (path === '/api/v1/deployments' && ['GET', 'POST'].includes(method)) {
      label('deployments'); const actor = await human(method === 'POST')
      if (method === 'GET') {
        query(url, ['organizationId', 'limit', 'beforeId'])
        const organizationId = url.searchParams.get('organizationId')
        if (!organizationId) throw new DistributionHttpError('INVALID_INPUT')
        context.send(200, await deployments.list(actor, organizationId, pagination(url)))
      } else {
        query(url, []); const body = await context.jsonBody(); fields(body, ['organizationId', 'name'])
        context.send(201, await deployments.create(actor,
          { organizationId: string(body, 'organizationId'), name: string(body, 'name') }, context.requestKey()))
      }
      return true
    }
    const deployment = /^\/api\/v1\/deployments\/([^/]+)(?:\/(binding-codes|credentials\/revoke|binding-codes\/revoke|status))?$/.exec(path)
    if (deployment) {
      query(url, []); const deploymentId = decodeURIComponent(deployment[1]!)
      if (!deployment[2] && method === 'GET') {
        label('deployment.get'); const detail = await deployments.get(await human(), deploymentId)
          context.send(200, options.centerInfo ? { ...detail, center: options.centerInfo } : detail); return true
      }
      if (deployment[2] && method === 'POST') {
        label(`deployment.${deployment[2].replaceAll('/', '.')}`)
        const actor = await human(true), body = await context.jsonBody()
        if (deployment[2] === 'binding-codes') {
          fields(body, ['expiresInMs'])
          context.send(201, await deployments.issueBindingCode(actor, deploymentId, body.expiresInMs === undefined ? {} : { expiresInMs: body.expiresInMs as number }))
        } else if (deployment[2] === 'credentials/revoke') {
          fields(body, ['credentialId'])
          context.send(200, await deployments.revokeCredential(actor, deploymentId, string(body, 'credentialId'), context.requestKey()))
        } else if (deployment[2] === 'binding-codes/revoke') {
          fields(body, ['bindingCodeId'])
          context.send(200, await deployments.revokeBindingCode(actor, deploymentId, string(body, 'bindingCodeId'), context.requestKey()))
        } else {
          fields(body, ['status', 'expectedVersion'])
          context.send(200, await deployments.setStatus(actor, deploymentId,
            { status: string(body, 'status') as 'active' | 'disabled', expectedVersion: version(body) }, context.requestKey()))
        }
        return true
      }
    }

    if (path === '/api/v1/releases' && method === 'GET') {
      label('catalog.list'); query(url, ['limit', 'beforeId', 'packId'])
      const packId = url.searchParams.get('packId')
      context.send(200, await catalog.list(await reader(), { ...pagination(url), ...(packId === null ? {} : { packId }) }))
      return true
    }
    const release = /^\/api\/v1\/releases\/([^/]+)(?:\/(artifact|download-grants|manage|yank|distribution-requests))?$/.exec(path)
    if (release) {
      const releaseId = decodeURIComponent(release[1]!)
      const action = release[2]
      if (!action && method === 'GET') {
        label('catalog.get'); query(url, []); context.send(200, await catalog.get(await reader(), releaseId)); return true
      }
      if (action === 'download-grants' && method === 'POST') {
        label('download.grant'); query(url, [])
        const actor = await reader(true); fields(await context.jsonBody(), [])
        context.send(201, await catalog.issueDownloadGrant(actor, releaseId)); return true
      }
      if (action === 'artifact' && method === 'GET') {
        label('download.artifact'); query(url, [])
        const actor = await reader()
        // Fixed complete artifacts only. Never emit public object-store redirects,
        // conditional 304s or unauthenticated Range responses.
        if (['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'].some(name => request.headers[name] !== undefined)) {
          throw new DistributionHttpError('DOWNLOAD_CONDITION_UNSUPPORTED', 400)
        }
        const grant = request.headers['x-pack-download-grant']
        if (typeof grant !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant) || duplicateHeader(request, 'x-pack-download-grant')) {
          throw new DistributionHttpError('DOWNLOAD_GRANT_REQUIRED', 401)
        }
        const download = await catalog.openDownload(actor, releaseId, grant)
        if (request.aborted || response.destroyed) { download.stream.destroy(); return true }
        const abort = () => { if (!response.writableFinished) download.stream.destroy() }
        response.once('close', abort)
        request.once('aborted', abort)
        try {
          response.statusCode = 200
          response.setHeader('Cache-Control', 'no-store')
          response.setHeader('Pragma', 'no-cache')
          response.setHeader('Content-Type', 'application/x-tar')
          response.setHeader('Content-Disposition', 'attachment; filename="domain-pack.tar"')
          response.setHeader('Content-Length', download.sizeBytes)
          response.setHeader('Accept-Ranges', 'none')
          response.setHeader('X-Content-Type-Options', 'nosniff')
          response.setHeader('Referrer-Policy', 'no-referrer')
          response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
          await pipeline(download.stream, response)
        } finally {
          response.removeListener('close', abort); request.removeListener('aborted', abort)
          download.stream.destroy()
        }
        return true
      }
      if (action === 'manage' && method === 'GET') {
        label('release.manage'); query(url, []); context.send(200, await governance.get(await human(), releaseId)); return true
      }
      if (action === 'yank' && method === 'POST') {
        label('release.yank'); query(url, [])
        const actor = await human(true), body = await context.jsonBody(); fields(body, ['expectedVersion', 'reason'])
        context.send(200, await governance.yank(actor, releaseId, { expectedVersion: version(body), reason: string(body, 'reason') }, context.requestKey()))
        return true
      }
      if (action === 'distribution-requests' && ['GET', 'POST'].includes(method)) {
        label('scope.requests'); const actor = await human(method === 'POST')
        if (method === 'GET') {
          query(url, ['limit', 'beforeId']); context.send(200, await governance.listReleaseRequests(actor, releaseId, pagination(url)))
        } else {
          query(url, []); const body = await context.jsonBody(); fields(body, ['expectedVersion', 'scope', 'reason'])
          context.send(201, await governance.requestDistribution(actor, releaseId,
            { expectedVersion: version(body), scope: body.scope as DistributionScope, reason: string(body, 'reason') }, context.requestKey()))
        }
        return true
      }
    }
    const reviewRequest = /^\/api\/v1\/distribution-requests\/([^/]+)(?:\/(review))?$/.exec(path)
    if (reviewRequest) {
      query(url, []); const requestId = decodeURIComponent(reviewRequest[1]!)
      if (!reviewRequest[2] && method === 'GET') {
        label('scope.request.get'); context.send(200, await governance.getRequest(await human(), requestId)); return true
      }
      if (reviewRequest[2] === 'review' && method === 'POST') {
        label('scope.request.review'); const actor = await human(true), body = await context.jsonBody()
        fields(body, ['expectedVersion', 'decision', 'comment'])
        context.send(200, await governance.reviewDistribution(actor, requestId,
          { expectedVersion: version(body), decision: string(body, 'decision') as 'approved' | 'rejected', comment: string(body, 'comment') }, context.requestKey()))
        return true
      }
    }
    const queue = /^\/api\/v1\/organizations\/([^/]+)\/distribution-review-queue$/.exec(path)
    if (queue && method === 'GET') {
      label('scope.queue'); query(url, ['limit', 'beforeId', 'status'])
      const status = url.searchParams.get('status')
      context.send(200, await governance.listReviewQueue(await human(), decodeURIComponent(queue[1]!),
        { ...pagination(url), ...(status === null ? {} : { status: status as 'pending_review' | 'approved' | 'rejected' | 'withdrawn' }) }))
      return true
    }
    return false
  }
}
