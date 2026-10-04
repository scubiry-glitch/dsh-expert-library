/** One compliant actual-package smoke: no business data, Host tools or model calls. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {cp,mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {hashContentDirectory} from '../packages/pack-contract/index.mjs'
import {createCraftV3Fixture} from './support/report-craft-v3-fixture.mjs'
const source=process.env.DSH_SKILL_CRAFT_SOURCE==='1'
const {resolveSelectedSkillContract}=await import(source?'../src/skill-craft.ts':'../lib/skill-craft.js')
const {evaluateSkillCraft}=await import(source?'../src/skill-craft-runtime.ts':'../lib/skill-craft-runtime.js')
test('actual installed zhijian-realestate writer and renderer entrypoints pass a compliant synthetic four-artifact bundle',async t=>{
 const packSource=fileURLToPath(new URL('../domain-packs/zhijian-realestate',import.meta.url)),before=await hashContentDirectory(packSource)
 const workspace=await mkdtemp(join(tmpdir(),'actual-skill-craft-'));t.after(()=>rm(workspace,{recursive:true,force:true}))
 const installed=join(workspace,'domain-packs','zhijian-realestate');await cp(packSource,installed,{recursive:true})
 assert.equal((await hashContentDirectory(installed)).contentTreeSha256,before.contentTreeSha256)
 const selections=[{packId:'zhijian-realestate',skillId:'zhijian-report-craft',reason:'Synthetic compliant writing policy test'},{packId:'zhijian-realestate',skillId:'zhijian-designer-render',variant:'credit-policy',reason:'Synthetic compliant rendering policy test'}]
 const selection=await resolveSelectedSkillContract({}, {packsDir:'domain-packs',enabledPacks:['zhijian-realestate']},workspace,selections)
 assert.equal(selection.packs[0].root,installed);assert.equal(selection.packs[0].treeDigest,before.contentTreeSha256);assert.equal(selection.checks.length,2);assert.deepEqual(selection.artifactRoles,['md','html','pdf','evidence'])
 const f=createCraftV3Fixture('credit-policy'),check={id:'selected-skill-craft-v1',md:'report.md',html:'report.html',pdf:'report.pdf',craftEvidence:'craft-evidence.json',selection}
 const results=await evaluateSkillCraft(f.artifacts,check,{timeoutMs:60000})
 assert.deepEqual(results.map(r=>r.id),selection.checks.flatMap(c=>c.resultIds));assert.equal(results.length,8);assert.ok(results.every(r=>r.status==='passed'),JSON.stringify(results))
 assert.equal((await hashContentDirectory(packSource)).contentTreeSha256,before.contentTreeSha256);assert.equal((await hashContentDirectory(installed)).contentTreeSha256,before.contentTreeSha256)
 t.diagnostic(JSON.stringify({scope:'Actual installed pack child processes using synthetic artifacts, not a Host admission or business report review',domainPackIdentity:{packId:'zhijian-realestate',version:selection.packs[0].version,contentTreeSha256:before.contentTreeSha256,fileCount:before.fileCount,sizeBytes:before.sizeBytes},selectionDigest:selection.digest,checkers:selection.checks.map(({id,version,sha256,resultIds})=>({id,version,sha256,resultIds})),results:results.map(({id,status})=>({id,status}))}))
})
