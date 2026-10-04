import test from 'node:test'
import assert from 'node:assert/strict'
import {cp,mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {domainPackIdentityAt} from '../scripts/qa/team-communication-host-smoke.mjs'
const repo=fileURLToPath(new URL('..',import.meta.url)),source=join(repo,'domain-packs/zhijian-realestate')
const python=String.raw`import sys,pathlib,importlib.util,json
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('qa_identity_only',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def no_client(*a,**k): raise AssertionError('PRODUCTION_CLIENT_FORBIDDEN')
m.m.Client=no_client
print(json.dumps(m.domain_identity(pathlib.Path(sys.argv[2]))))`
const pyIdentity=root=>JSON.parse(execFileSync('python3',['-I','-c',python,join(repo,'scripts/qa/round11-real-rerun.py'),root],{encoding:'utf8',stdio:['ignore','pipe','pipe']}))
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'qa-domain-identity-'));t.after(()=>rm(root,{recursive:true,force:true}));const pack=join(root,'domain-packs/zhijian-realestate');await cp(source,pack,{recursive:true});return{root,pack}}
test('shared Host Node identity matches independent controller Python identity on exact pack bytes',async()=>{assert.deepEqual(await domainPackIdentityAt(source),pyIdentity(repo))})
test('both identities bind byte drift and top-level version changes',async t=>{const f=await fixture(t),before=await domainPackIdentityAt(f.pack);const metaPath=join(f.pack,'pack.json'),meta=JSON.parse(await readFile(metaPath));meta.version='99.0.0';await writeFile(metaPath,JSON.stringify(meta));const after=await domainPackIdentityAt(f.pack);assert.deepEqual(after,pyIdentity(f.root));assert.equal(after.version,'99.0.0');assert.notEqual(after.contentTreeSha256,before.contentTreeSha256)})
test('old incorrect nested pack metadata is rejected by both validators',async t=>{const f=await fixture(t),path=join(f.pack,'pack.json'),meta=JSON.parse(await readFile(path));await writeFile(path,JSON.stringify({pack:meta}));await assert.rejects(domainPackIdentityAt(f.pack));assert.throws(()=>pyIdentity(f.root))})
test('both identities reject a symlink added to installed package',async t=>{const f=await fixture(t);await symlink(join(f.pack,'pack.json'),join(f.pack,'alias.json'));await assert.rejects(domainPackIdentityAt(f.pack));assert.throws(()=>pyIdentity(f.root))})
