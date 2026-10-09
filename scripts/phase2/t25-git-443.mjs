#!/usr/bin/env node
/** Smart HTTPS Git server pinned to 127.0.0.1:443 serving the T2.5 fixture repos,
 * with a cert signed by the phase2 isolated CA (/tmp/p2-20260923/t22/ca.pem). */
import https from 'node:https'
import { spawn } from 'node:child_process'

const REPOS = process.env.GIT_PROJECT_ROOT || '/tmp/p2-20260923/t25/repos'
const GIT_HTTP_BACKEND = '/usr/libexec/git-core/git-http-backend'
const env = {
  PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/tmp/p2-20260923/t25',
  GIT_PROJECT_ROOT: REPOS, GIT_HTTP_EXPORT_ALL: '1',
}
const server = https.createServer({
  key: readFileSync('/tmp/p2-20260923/t22/git.key'),
  cert: readFileSync('/tmp/p2-20260923/t22/git.crt'),
}, (req, res) => {
  const url = new URL(req.url, 'https://127.0.0.1')
  const child = spawn(GIT_HTTP_BACKEND, [], { env: { ...env, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_ADDR: '127.0.0.1', HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  const out = []
  child.stdout.on('data', b => out.push(b))
  child.stderr.resume()
  req.pipe(child.stdin)
  child.stdin.on('error', () => {})
  child.on('close', code => {
    const bytes = Buffer.concat(out), marker = bytes.indexOf('\r\n\r\n')
    if (code !== 0 || marker < 0) { res.writeHead(500); res.end(); return }
    for (const header of bytes.subarray(0, marker).toString().split('\r\n')) {
      const i = header.indexOf(':')
      if (i > 0 && header.slice(0, i).toLowerCase() !== 'status') res.setHeader(header.slice(0, i), header.slice(i + 1).trim())
    }
    res.writeHead(200)
    res.end(bytes.subarray(marker + 4))
  })
})
server.listen(8443, '127.0.0.1', () => console.log('git-443 ready'))
import { readFileSync } from 'node:fs'
