import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,symlink,lstat,rm,readdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {materializePackAliases} from '../scripts/ops/production-pack-selection.mjs'

test('release repair preserves source bytes and original alias; rerun is a no-op',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pack-release-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const source=join(root,'.source'),alias=join(root,'pack');await mkdir(source)
  await writeFile(join(source,'example.md'),'original material\n');await symlink('.source',alias)
  await materializePackAliases({materializeAliases:[alias]})
  assert.equal((await lstat(alias)).isSymbolicLink(),false)
  assert.equal(await readFile(join(alias,'example.md'),'utf8'),'original material\n')
  assert.equal(await readFile(join(source,'example.md'),'utf8'),'original material\n')
  const backups=(await readdir(root)).filter(x=>x.startsWith('.pack-alias-'));assert.equal(backups.length,1)
  assert.equal((await lstat(join(root,backups[0]))).isSymbolicLink(),true)
  await materializePackAliases({materializeAliases:[alias]})
  assert.equal((await readdir(root)).filter(x=>x.startsWith('.pack-alias-')).length,1)
})

test('release repair refuses aliases escaping their configured pack directory',async t=>{
  const root=await mkdtemp(join(tmpdir(),'pack-release-'));t.after(()=>rm(root,{recursive:true,force:true}))
  await mkdir(join(root,'packs'));await mkdir(join(root,'outside'))
  const alias=join(root,'packs','pack');await symlink('../outside',alias)
  await assert.rejects(materializePackAliases({materializeAliases:[alias]}),/ALIAS_TARGET_OUTSIDE/)
  assert.equal((await lstat(alias)).isSymbolicLink(),true)
})
