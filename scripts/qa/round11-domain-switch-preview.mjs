/** Read-only real-tenant inventory and disposable candidate merge; no Host/model/write API. */
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { hashContentDirectory } from '../../packages/pack-contract/index.mjs'
import { builtinLegacyPack } from '../../lib/v2/compat.js'
import { buildZhijianDomainPack } from '../../lib/v2/zhijian-pack.js'
import { buildCollabDomainPack } from '../../lib/collab/templates.js'
import { resolveLibrary } from '../../lib/expert-library/registry.js'
import { resolveRuntimePack } from '../../lib/v2/runtime-pack.js'
import { listScopedSkillCraftCatalog } from '../../lib/skill-craft.js'

const tenant='/var/lib/dsh-server-login/users/54485b72-c5b9-4fbd-be13-bc0c2c82e0a5'
const inventory=join(tenant,'home/expert-library-pack-center/inventory/state.json')
const source=fileURLToPath(new URL('../../domain-packs/zhijian-realestate/',import.meta.url))
const realRoots=[join(tenant,'ws'),join(tenant,'ws/main/bank'),join(tenant,'ws/main/work')]
const raw=await readFile(inventory), state=JSON.parse(raw)
assert.equal(state.active['zhijian-realestate'],'5ad0f59f-e497-421d-882e-7eb0a9c7841f')
const retained=Object.entries(state.active).filter(([id])=>id!=='zhijian-realestate')
for(const [packId,releaseId] of retained) {
  const {manifest}=JSON.parse(await readFile(state.installed[releaseId].manifestPath,'utf8'))
  assert.ok(!manifest.dependencyLock.some(row=>row.packId==='zhijian-realestate'), `${packId}: exact center dependency blocks local replacement`)
}
const scratch=await mkdtemp(join(tmpdir(),'round11-domain-switch-preview-'))
try {
  const destination=join(scratch,'domain-packs/zhijian-realestate')
  await cp(source,destination,{recursive:true,errorOnExist:true,force:false})
  const sourceIdentity=await hashContentDirectory(source)
  assert.equal((await hashContentDirectory(destination)).contentTreeSha256,sourceIdentity.contentTreeSha256)
  const snapshot={generation:state.generation,packs:retained.map(([packId,releaseId])=>({packId,releaseId,
    root:state.installed[releaseId].packPath,contentTreeSha256:state.installed[releaseId].contentTreeSha256})),
    suppressedLegacyPaths:Object.keys(state.legacySuppressions)}
  const roots=[...realRoots,scratch]
  const ctx={get:key=>key==='workspaceRegistry'?{list:()=>roots.map(path=>({path}))}:undefined,logger:{warn(){}}}
  const selection={packsDir:'domain-packs',enabledPacks:['zhijian-realestate'],centerSnapshot:snapshot,rejectCenterConflicts:true}
  const bases=[builtinLegacyPack(),buildZhijianDomainPack()]
  for(const root of realRoots) bases.push(buildCollabDomainPack([...(await resolveLibrary(ctx,root,'knowledge')).experts.values()]))
  const results=[]
  for(const base of bases) {
    const result=await resolveRuntimePack(ctx,selection,base)
    assert.ok(result.layers.some(layer=>layer.dir===destination))
    assert.ok(!result.layers.some(layer=>layer.dir===state.installed[state.active['zhijian-realestate']].packPath))
    assert.deepEqual(result.diagnostics.filter(row=>row.severity==='error'),[])
    const craftSkills=result.pack.skillPackages.filter(row=>row.craft).map(row=>row.id)
    assert.ok(craftSkills.includes('zhijian-report-craft')&&craftSkills.includes('zhijian-designer-render'))
    results.push({baseId:base.pack.id,layers:result.layers.map(row=>row.dir),craftSkills})
  }
  const catalog=await listScopedSkillCraftCatalog(ctx,{packsDir:'domain-packs',enabledPacks:['zhijian-realestate'],getPackCenterSnapshot:async()=>snapshot},scratch)
  assert.equal(catalog.length,2)
  assert.ok(catalog.every(row=>row.root===destination&&row.treeDigest===sourceIdentity.contentTreeSha256))
  assert.deepEqual(await readFile(inventory),raw,'Real inventory changed during read-only preview')
  console.log(JSON.stringify({status:'PASS',productionMutations:0,modelCalls:0,inventoryGeneration:state.generation,
    inventorySha256:createHash('sha256').update(raw).digest('hex'),observedSessionWorkspaces:realRoots,
    scope:'Proposed real-tenant local replacement; not an executed center upgrade or a single-session-only setting',
    retainedCenterReleases:retained,sourceIdentity,results,catalog:catalog.map(({packId,skillId,skillVersion,treeDigest})=>({packId,skillId,skillVersion,treeDigest}))},null,2))
} finally {await rm(scratch,{recursive:true,force:true})}
