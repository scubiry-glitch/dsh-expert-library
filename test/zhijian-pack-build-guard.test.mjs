/** The legacy projection must never silently downgrade or delete craft manifests. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,cp} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {hashContentDirectory} from '../packages/pack-contract/index.mjs'
const cwd=resolve(new URL('..',import.meta.url).pathname),pack=join(cwd,'domain-packs/zhijian-realestate')
for(const args of [[],['--check'],['--out',pack]])test('legacy CLI refuses authored craft pack before writing: '+JSON.stringify(args),async()=>{
 const before=await hashContentDirectory(pack)
 const child=spawnSync(process.execPath,['scripts/build-zhijian-pack.mjs',...args],{cwd,encoding:'utf8',timeout:20000,maxBuffer:1024*1024})
 assert.equal(child.status,1,child.stderr);assert.match(child.stderr,/npm run build:pack/)
 assert.equal((await hashContentDirectory(pack)).contentTreeSha256,before.contentTreeSha256)
})
test('legacy CLI still emits an isolated base pack via --out',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'zhijian-base-cli-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const out=join(temp,'base'),child=spawnSync(process.execPath,['scripts/build-zhijian-pack.mjs','--out',out,'--src',join(pack,'source')],{cwd,encoding:'utf8',timeout:30000,maxBuffer:1024*1024})
 assert.equal(child.status,0,child.stderr)
 assert.equal(JSON.parse(await readFile(join(out,'pack.json'),'utf8')).id,'zhijian-realestate')
 const check=spawnSync(process.execPath,['scripts/build-zhijian-pack.mjs','--check','--out',out],{cwd,encoding:'utf8',timeout:30000,maxBuffer:1024*1024})
 assert.equal(check.status,0,check.stderr)
})

test('exported legacy emitter also refuses a complete craft target',async()=>{
 const {emitPack}=await import('../scripts/build-zhijian-pack.mjs'),before=await hashContentDirectory(pack)
 await assert.rejects(emitPack(pack,{srcDir:join(pack,'source')}),/refuses to overwrite authored craft/)
 assert.equal((await hashContentDirectory(pack)).contentTreeSha256,before.contentTreeSha256)
})
test('multi-pack driver preserves craft on its real-estate build and check routes',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'zhijian-driver-craft-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const installed=join(temp,'domain-packs/zhijian-realestate');await cp(pack,installed,{recursive:true})
 const before=await hashContentDirectory(installed)
 for(const args of [['zhijian-realestate'],['--check','zhijian-realestate']]){
  const child=spawnSync(process.execPath,[join(cwd,'scripts/build-packs.mjs'),...args],{cwd:temp,encoding:'utf8',timeout:30000,maxBuffer:1024*1024})
  assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/complete craft/)
  assert.equal((await hashContentDirectory(installed)).contentTreeSha256,before.contentTreeSha256)
 }
})
