/** Read-only input fingerprint for the host-client + standalone-center batch.
 * Unlike pack-center-fingerprint.mjs this also covers plugin sources/tests,
 * shared protocol/artifact packages and the reviewed example packs.
 */
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const paths = []
async function walk(relative) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`
    if (entry.isDirectory()) await walk(path)
    else if (entry.isFile()) paths.push(path)
    else throw new Error('Fingerprint inputs must be regular files/directories')
  }
}
for (const directory of ['src', 'test', 'packages', 'domain-packs', 'examples/pack-center',
  'apps/pack-center/src', 'apps/pack-center/test', 'apps/pack-center/migrations', 'apps/pack-center/web']) await walk(directory)
for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.client.json', 'tsdown.config.ts',
  'apps/pack-center/package.json', 'apps/pack-center/package-lock.json', 'apps/pack-center/tsconfig.json',
  'scripts/pack-center-host-fingerprint.mjs']) paths.push(file)
const entries = []
for (const path of paths.sort()) entries.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })
const sourceSetSha256 = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
process.stdout.write(JSON.stringify({ files: entries.length, sourceSetSha256, entries }, null, 2) + '\n')
