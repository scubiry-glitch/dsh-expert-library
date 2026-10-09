#!/usr/bin/env node
/** Isolated TLS front for the phase2 pack center: terminates HTTPS on 127.0.0.1:18431
 * with the test CA-signed cert and forwards plain HTTP to the center API on 18430.
 * Test-owned resource; no production impact. */
import https from 'node:https'
import http from 'node:http'
import { readFileSync } from 'node:fs'

const opts = {
  key: readFileSync('/tmp/p2-20260923/t22/server.key'),
  cert: readFileSync('/tmp/p2-20260923/t22/server.crt'),
}
const server = https.createServer(opts, (req, res) => {
  const proxyReq = http.request({
    host: '127.0.0.1', port: 18430, path: req.url, method: req.method,
    headers: { ...req.headers, host: req.headers.host },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers)
    proxyRes.pipe(res)
  })
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'TLS_FRONT_UPSTREAM_UNREACHABLE', message: String(err) } }))
  })
  req.pipe(proxyReq)
})
server.listen(18431, '127.0.0.1', () => console.log('tls-front listening on 127.0.0.1:18431'))
