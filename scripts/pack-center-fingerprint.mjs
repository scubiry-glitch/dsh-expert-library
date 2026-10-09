/** Read-only fingerprint of the standalone center's executable/test inputs. */
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const prefix = 'apps/pack-center/'
const paths = []
async function walk(relative) {
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`
    if (entry.isDirectory()) await walk(path)
    else if (/\.(ts|mjs|sql|js|html|css)$/.test(path)) paths.push(path)
  }
}
for (const directory of ['src', 'test', 'migrations', 'web']) await walk(prefix + directory)
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) paths.push(prefix + file)
const entries = []
for (const path of paths.sort()) entries.push({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') })
const sourceSetSha256 = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
process.stdout.write(JSON.stringify({ files: entries.length, sourceSetSha256, entries }, null, 2) + '\n')
