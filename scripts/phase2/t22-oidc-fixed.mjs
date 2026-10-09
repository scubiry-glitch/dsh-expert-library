#!/usr/bin/env node
/** Loopback OIDC issuer pinned to port 35531 so center identities stay stable. */
import http from 'node:http'
import { writeFile, mkdir } from 'node:fs/promises'

const FIXED_PORT = 35531
const origListen = http.Server.prototype.listen
http.Server.prototype.listen = function (...args) {
  if (args[0] === 0) args[0] = FIXED_PORT
  return origListen.apply(this, args)
}

const { createTestIssuer } = await import('../../apps/pack-center/test/support/identity-fixture.mjs')
const issuer = await createTestIssuer()
await mkdir('/tmp/p2-20260923/t22', { recursive: true })
await writeFile('/tmp/p2-20260923/t22/issuer.json', JSON.stringify({ issuer: issuer.issuer, pid: process.pid }) + '\n')
console.log(JSON.stringify({ event: 'oidc_listening', issuer: issuer.issuer, pid: process.pid }))
