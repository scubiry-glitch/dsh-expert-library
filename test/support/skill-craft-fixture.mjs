/** Disposable, synthetic domain package; no plugin-global or business inputs. */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
const { canonicalSkillDigest } = await import(process.env.SKILL_CRAFT_TEST_SOURCE === '1' ? '../../src/v2/pack-loader.ts' : '../../lib/v2/pack-loader.js')
const put = async (path, value) => writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2))

export async function createInstalledSkillCraftPack(root, options = {}) {
  const packId = options.packId ?? 'synthetic-craft'
  const specs = options.skills ?? [{ id: 'compose' }]
  await mkdir(join(root, 'craft'), { recursive: true }); await mkdir(join(root, 'references'), { recursive: true })
  const pack = { pack: { id: packId, name: 'Synthetic craft', schemaVersion: 2, version: '1.0.0' }, experts: [], scenarios: [], teamTemplates: [], outputTemplates: [], qualityPolicies: [], toolProviders: [], knowledgeProviders: [], domainKnowledge: [], methodPacks: [], skillPackages: [] }
  for (const spec of specs) {
    const base = `skills/${spec.id}`, skillRoot = join(root, base), declarationPath = `craft/${spec.id}.json`
    await mkdir(join(skillRoot, 'scripts'), { recursive: true })
    await put(join(skillRoot, 'SKILL.md'), `---\nname: ${spec.id}\ndescription: Synthetic craft ${spec.id}\n---\nUse only the selected synthetic policy.\n`)
    const resultIds = spec.resultIds ?? [`${spec.id}-structure`]
    await put(join(skillRoot, 'scripts/check.mjs'), spec.runnerCode ?? `let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw);console.log(JSON.stringify(input.resultIds.map(id=>({id,status:'passed',detail:'synthetic inspected'}))));\n`)
    await put(join(root, `references/${spec.id}.md`), spec.body ?? `Complete synthetic material for ${spec.id}. No business answer.\n`)
    const declaration = { schemaVersion: 1, description: `Synthetic ${spec.id} policy`, applicability: ['Synthetic fixture report'], artifactRoles: spec.artifactRoles ?? ['md', 'html', 'pdf', 'evidence'],
      ...(spec.variants ? { variants: spec.variants } : {}), ...(spec.requires ? { requires: spec.requires } : {}), ...(spec.conflicts ? { conflicts: spec.conflicts } : {}),
      materials: spec.materials ?? [{ id: 'instructions', path: `references/${spec.id}.md`, roles: ['writer', 'renderer', 'reviewer'] }],
      checks: spec.checks ?? [{ id: `${spec.id}-check`, entrypoint: `${base}/scripts/check.mjs`, version: '1.0.0', resultIds }],
      reviewAreas: spec.reviewAreas ?? [{ id: `${spec.id}-review`, description: 'Check actual synthetic claims independently.' }] }
    await put(join(root, declarationPath), declaration)
    const skill = { id: spec.id, name: spec.id, schemaVersion: 2, version: '1.0.0', craft: { path: declarationPath }, source: { kind: 'workspace', root: base, digest: '', license: 'UNLICENSED' }, contributions: {}, permissions: { execScripts: spec.execScripts ?? ['scripts/check.mjs'], internalOnly: true } }
    await put(join(skillRoot, 'skill.json'), skill)
    skill.source.digest = await canonicalSkillDigest(skillRoot, skill)
    await put(join(skillRoot, 'skill.json'), skill); pack.skillPackages.push(skill)
  }
  await put(join(root, 'pack.json'), pack)
  return { root, pack, packId, selections: specs.map(spec => ({ packId, skillId: spec.id, reason: 'Synthetic test explicitly selected this skill.', ...(spec.variant ? { variant: spec.variant } : {}) })) }
}

export async function resealInstalledSkillCraftPack(root) {
  const pack = JSON.parse(await readFile(join(root, 'pack.json'), 'utf8'))
  for (let i = 0; i < pack.skillPackages.length; i++) {
    const base = join(root, pack.skillPackages[i].source.root), skill = JSON.parse(await readFile(join(base, 'skill.json'), 'utf8'))
    skill.source.digest = await canonicalSkillDigest(base, skill)
    await put(join(base, 'skill.json'), skill); pack.skillPackages[i] = skill
  }
  await put(join(root, 'pack.json'), pack)
  return pack
}
