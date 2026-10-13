import {readFile, writeFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'

const source = await readFile(new URL('../src/review-portraits.ts', import.meta.url), 'utf8')
const code = stripTypeScriptTypes(source, {mode:'strip'}).replace(/^export /gm, '').trim()
const begin = '// BEGIN GENERATED EXPERT PORTRAITS'
const end = '// END GENERATED EXPERT PORTRAITS'
const block = `${begin}\n${code}\n${end}\n`
const path = new URL('../assets/review/review.js', import.meta.url)
const current = await readFile(path, 'utf8')
const start = current.indexOf(begin), finish = current.indexOf(end)
const next = start < 0 ? block + current : current.slice(0, start) + block + current.slice(finish + end.length + 1)
if (process.argv.includes('--check')) {
  if (next !== current) throw Error('Portrait catalog is stale; run node scripts/build-review-portrait-catalog.mjs')
} else if (next !== current) await writeFile(path, next)
