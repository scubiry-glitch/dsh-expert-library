import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const source = fileURLToPath(new URL('../public/', import.meta.url))
const output = fileURLToPath(new URL('../dist/', import.meta.url))
const portrait = fileURLToPath(new URL('../../../assets/review/portraits/coordinator.webp', import.meta.url))
const avatar = fileURLToPath(new URL('../../../assets/review/portraits/pose-coordinator-listen-avatar.webp', import.meta.url))
const portraits = fileURLToPath(new URL('../../../assets/review/portraits/', import.meta.url))
const vendor = fileURLToPath(new URL('../../../assets/review/vendor/', import.meta.url))

await rm(output, { recursive: true, force: true })
await cp(source, output, { recursive: true })
await mkdir(fileURLToPath(new URL('../dist/assets/', import.meta.url)), { recursive: true })
await cp(portrait, fileURLToPath(new URL('../dist/assets/coordinator.webp', import.meta.url)))
await cp(avatar, fileURLToPath(new URL('../dist/assets/coordinator-avatar.webp', import.meta.url)))
for (const name of ['marked.umd.js', 'purify.min.js', 'marked-LICENSE', 'dompurify-LICENSE', 'dompurify-LICENSE-MPL']) {
  await cp(fileURLToPath(new URL(`../../../assets/review/vendor/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../dist/assets/${name}`, import.meta.url)))
}
await mkdir(fileURLToPath(new URL('../dist/assets/portraits/', import.meta.url)), { recursive: true })
for (const name of await readdir(portraits)) if (/^[a-z0-9-]+\.webp$/i.test(name)) {
  await cp(fileURLToPath(new URL(`../../../assets/review/portraits/${name}`, import.meta.url)),
    fileURLToPath(new URL(`../dist/assets/portraits/${name}`, import.meta.url)))
}
const versionedAssets = new Map([
  ['/assets/style.css', 'style.css'],
  ['/assets/app.js', 'app.js'],
  ['/assets/marked.umd.js', 'assets/marked.umd.js'],
  ['/assets/purify.min.js', 'assets/purify.min.js'],
])
const versions = new Map()
for (const [path, file] of versionedAssets) {
  const data = await readFile(fileURLToPath(new URL(`../dist/${file}`, import.meta.url)))
  versions.set(path, createHash('sha256').update(data).digest('hex').slice(0, 12))
}
const indexPath = fileURLToPath(new URL('../dist/index.html', import.meta.url))
const index = await readFile(indexPath, 'utf8')
await writeFile(indexPath, index.replace(/((?:src|href)=")(\/assets\/[a-z0-9.-]+)(")/gi,
  (match, prefix, path, suffix) => versions.has(path) ? `${prefix}${path}?v=${versions.get(path)}${suffix}` : match))
process.stdout.write(`Built ${appRoot}dist\n`)
