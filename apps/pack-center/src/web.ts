/** Fixed, process-start-loaded application assets. Never serve arbitrary paths. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'node:http'

const assetFiles: Readonly<Record<string, readonly [string, string]>> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/assets/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/assets/shared.js': ['shared.js', 'text/javascript; charset=utf-8'],
  '/assets/submissions.js': ['submissions.js', 'text/javascript; charset=utf-8'],
  '/assets/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/assets/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/guides/partner-devdoc': ['partner-devdoc.html', 'text/html; charset=utf-8'],
  '/guides/tenant-setup': ['tenant-setup.html', 'text/html; charset=utf-8'],
  '/guides/partner-sample-pack': ['partner-sample-pack.html', 'text/html; charset=utf-8'],
}
const pagePolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
// Guide pages are fully self-contained static HTML: inline <style> blocks and
// data: URIs for embedded images. The server-wide fallback CSP
// (default-src 'none') would strip both, so these routes carry their own policy.
const guidePolicy = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
export function createWebHandler() {
  // A missing or linked UI bundle must fail before starting the server. The
  // deployment package must retain web/ beside dist/, not expose the repository.
  const assets = new Map<string, { bytes: Buffer; type: string }>()
  for (const [route, [name, type]] of Object.entries(assetFiles)) {
    const path = fileURLToPath(new URL(`../web/${name}`, import.meta.url))
    const stat = lstatSync(path)
    if (!stat.isFile() || realpathSync(path) !== path || stat.size > 2097152) throw new Error('Invalid or missing center web bundle')
    assets.set(route, { bytes: readFileSync(path), type })
  }
  return (url: URL, method: string, response: ServerResponse): boolean => {
    if (!['GET', 'HEAD'].includes(method) || url.search) return false
    const asset = assets.get(url.pathname)
    if (!asset) return false
    response.statusCode = 200
    response.setHeader('Content-Type', asset.type)
    response.setHeader('Content-Length', asset.bytes.byteLength)
    response.setHeader('Cache-Control', 'no-store')
    if (url.pathname === '/') response.setHeader('Content-Security-Policy', pagePolicy)
    else if (url.pathname.startsWith('/guides/')) response.setHeader('Content-Security-Policy', guidePolicy)
    response.end(method === 'HEAD' ? undefined : asset.bytes)
    return true
  }
}
