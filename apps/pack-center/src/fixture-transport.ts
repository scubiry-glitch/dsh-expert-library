/** Test-only loopback Git fixture transport for isolated acceptance runs.
 * Activated exclusively by PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE="host:port".
 * Mirrors apps/pack-center/test/support/git-fixture.mjs semantics: a public
 * placeholder address passes the worker's public-unicast gate, then the spawn
 * adapter pins the real loopback address and explicit fixture port, trusting
 * the isolated test CA through GIT_SSL_CAINFO. Production never sets the env. */
import { spawn as nodeSpawn } from 'node:child_process'
import type { GitSnapshotInfrastructure } from './git-snapshot.ts'

export function fixtureInfrastructure(hostPort: string): GitSnapshotInfrastructure | null {
  const index = hostPort.lastIndexOf(':')
  if (index <= 0) return null
  const hostname = hostPort.slice(0, index)
  const port = hostPort.slice(index + 1)
  if (!/^[a-z0-9.-]+$/.test(hostname) || !/^\d+$/.test(port)) return null
  return {
    resolveHostname: async resolved => {
      if (resolved !== hostname) throw new Error('unexpected fixture host')
      return [{ address: '93.184.216.34', family: 4 }]
    },
    spawn(command, args, options) {
      const rewritten = args.map(arg => {
        if (typeof arg !== 'string') return arg
        if (arg === `http.curloptResolve=${hostname}:443:93.184.216.34`) return `http.curloptResolve=${hostname}:${port}:127.0.0.1`
        if (arg === `https://${hostname}/`) return `https://${hostname}:${port}/`
        if (arg.startsWith(`https://${hostname}/`)) return arg.replace(`https://${hostname}/`, `https://${hostname}:${port}/`)
        return arg
      })
      const env = { ...options.env }
      if (process.env.GIT_SSL_CAINFO) env.GIT_SSL_CAINFO = process.env.GIT_SSL_CAINFO
      return nodeSpawn(command, rewritten, { ...options, env })
    },
  }
}
