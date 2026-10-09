#!/usr/bin/env node
// Real loopback OIDC support process; never logs requests, codes, or tokens.
import { writeFile } from 'node:fs/promises'
import { createTestIssuer } from '../../apps/pack-center/test/support/identity-fixture.mjs'
process.on('uncaughtException', () => { process.stderr.write('T2.2 OIDC startup/runtime failed\n'); process.exit(1) })
const issuer = await createTestIssuer()
await writeFile('/tmp/p2-20260923/t22/issuer.json', JSON.stringify({ issuer: issuer.issuer, pid: process.pid }) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ event: 'oidc_listening', issuer: issuer.issuer, pid: process.pid }))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await issuer.close(); process.exit(0) })
