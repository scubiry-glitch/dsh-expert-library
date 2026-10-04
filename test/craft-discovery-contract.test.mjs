import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSkill } from '../lib/skills.js'
import { collectSkillEntries, localSkillRoots } from '../lib/skills-discovery.js'
import { resolveCraftMaterials } from '../lib/report-craft-materials.js'
import { prepareCraftDelivery } from '../lib/report-craft-delivery.js'
import { isReportBundle, reportArtifactCheck, reportBundleFromChecks, reportCheckDeliverables } from '../lib/report-bundle.js'
const ctx={logger:{warn(){},info(){}}}
test('catalog and resolver identify the same bundled craft skill from a fresh business cwd',async t=>{
  const root=await mkdtemp(join(tmpdir(),'craft-discovery-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const entry=collectSkillEntries(localSkillRoots(root,'knowledge')).find(x=>x.id==='zhijian-report-craft')
  const resolved=await resolveSkill(ctx,root,'knowledge','zhijian-report-craft')
  assert.equal(resolved.path,entry.path);assert.equal(resolved.unavailable,undefined)
  const dir=join(root,'knowledge/skills/zhijian-report-craft');await mkdir(dir,{recursive:true});await writeFile(join(dir,'SKILL.md'),'# Ambiguous local copy')
  const duplicate=await resolveSkill(ctx,root,'knowledge','zhijian-report-craft')
  assert.equal(duplicate.path,undefined);assert.match(duplicate.unavailable,/Ambiguous/)
  assert.match(collectSkillEntries(localSkillRoots(root,'knowledge')).find(x=>x.id==='zhijian-report-craft').unavailable,/Ambiguous/)
})
test('Host delivery includes every required role packet byte and real reference root',()=>{
  const task={id:'t1',reportBundle:{md:'r.md',html:'r.html',pdf:'r.pdf',craft:{version:2,style:'designer-paper',evidence:'ledger.json'}}}
  const packet=prepareCraftDelivery(task,'actual-session',1,['writer','renderer'],'assignment')
  for(const role of ['writer','renderer']) {
    const source=resolveCraftMaterials({style:'designer-paper',role})
    assert.ok(packet.content.includes(source.content),'the complete body and locator metadata must be delivered, not only entries or paths')
    assert.ok(packet.content.includes(source.sourceRoot));assert.ok(source.sourceRoot.startsWith('/'))
  }
  assert.ok(packet.receipts.every(r=>r.accepted===false),'assignment acceptance awaits transport result')
})
test('v2 bundle roundtrips four publications and never silently downgrades or upgrades identity',()=>{
  const bundle={md:'r.md',html:'r.html',pdf:'r.pdf',craft:{version:2,style:'credit-policy',evidence:'ledger.json'}}
  assert.ok(isReportBundle(bundle));const check=reportArtifactCheck(bundle)
  assert.equal(check.id,'zhijian-report-craft-core-v2');assert.equal(reportCheckDeliverables(check).length,4)
  assert.deepEqual(reportBundleFromChecks([check]),bundle)
  assert.throws(()=>reportBundleFromChecks([{...check,materialDigest:'0'.repeat(64)}]),/VERSION_CHANGED/)
  assert.equal(isReportBundle({...bundle,craft:{...bundle.craft,evidence:'../ledger.json'}}),false)
  assert.equal(reportArtifactCheck({md:'r.md',html:'r.html',pdf:'r.pdf'}).id,'zhijian-report-craft-core-v1')
})
