import test from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashContentDirectory } from '../packages/pack-contract/index.mjs'
import { preflightResearchMaterials } from '../lib/host/pack-research-preflight.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const root = realpathSync(process.env.DSH_RESEARCH_PACK_CANDIDATE ?? join(repo, 'domain-packs/.zhijian-realestate-v15-src'))
const snapshot = async () => ({ generation: 1, packs: [{ packId: 'zhijian-realestate', releaseId: 'candidate-v15', root,
  contentTreeSha256: (await hashContentDirectory(root)).contentTreeSha256, source: 'center' }], suppressedLegacyPaths: [] })

test('candidate activation resolves exact craft, checker and task Skill/Prompt from one pending Host snapshot', async () => {
  await preflightResearchMaterials({}, { packsDir: 'domain-packs' }, await snapshot(), ['/tmp'])
  const wrong = await snapshot()
  wrong.packs[0].contentTreeSha256 = '0'.repeat(64)
  await assert.rejects(preflightResearchMaterials({}, { packsDir: 'domain-packs' }, wrong, ['/tmp']), /SKILL_CRAFT_PACK_DRIFT/)
})
