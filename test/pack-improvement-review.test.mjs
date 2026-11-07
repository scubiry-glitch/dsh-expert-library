import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reviewPackFromDir } from '../src/host/pack-improvement-review.ts'

test('pack review refuses a section symlink outside the selected pack', async t => {
  const home = mkdtempSync(join(tmpdir(), 'pack-review-containment-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const pack = join(home, 'pack')
  const outside = join(home, 'outside')
  mkdirSync(pack)
  mkdirSync(outside)
  writeFileSync(join(pack, 'pack.json'), JSON.stringify({ id: 'sample.pack', version: '1.0.0' }))
  writeFileSync(join(outside, 'secret.json'), JSON.stringify({ secret: 'must-not-read' }))
  symlinkSync(outside, join(pack, 'scenarios'))
  await assert.rejects(reviewPackFromDir(pack), { message: 'PACK_FILE_ESCAPE' })
})
