#!/usr/bin/env node
// Read-only preview of the exact V5 writer publication gate.
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { collectV5WriterPreflight } from '../../lib/deep-research-gates.js'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}
const teamRoot = option('--team-root')
const artifacts = option('--artifacts')
if (!teamRoot || !artifacts || args.length !== 4) {
  process.stderr.write('Usage: node scripts/qa/v5-writer-preflight.mjs --team-root TEAM_DIR --artifacts WRITER_ARTIFACTS_DIR\n')
  process.exitCode = 2
} else {
  const names = ['report.md', 'OUTLINE.md', 'report-source-ledger.json', 'figure-plan.json']
  const files = new Map()
  for (const name of names) {
    try { files.set(name, await readFile(join(resolve(artifacts), name), 'utf8')) }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      files.set(name, '')
    }
  }
  const errors = await collectV5WriterPreflight(resolve(teamRoot), files)
  process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors }, null, 2) + '\n')
  if (errors.length) process.exitCode = 1
}
