import { cp, mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const release = new URL('../release/', import.meta.url)
const files = ['server.mjs', 'config.mjs', 'model-usage.mjs', 'dsh-backend.mjs', 'dsh-gateway.mjs', 'backend-routing.mjs', 'account-store.mjs', 'session-deliverables.mjs',
  'login-attempts.mjs', 'oidc-client.mjs', 'osa-service-cards.mjs', 'package.json', 'package-lock.json']

await rm(release, { recursive: true, force: true })
await mkdir(release, { recursive: true })
for (const file of files) await cp(new URL(file, root), new URL(file, release))
await cp(new URL('dist/', root), new URL('dist/', release), { recursive: true })
await mkdir(new URL('scripts/', release), { recursive: true })
await cp(new URL('scripts/provision.mjs', root), new URL('scripts/provision.mjs', release))
await cp(new URL('node_modules/', root), new URL('node_modules/', release), { recursive: true })
process.stdout.write(`Packaged ${fileURLToPath(release)}\n`)
