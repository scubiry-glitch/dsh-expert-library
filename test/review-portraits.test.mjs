import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
import vm from 'node:vm'
import {EXPERT_PORTRAITS,expertPortraitId,isExpertPortrait,PORTRAIT_POSES,SHARED_PORTRAIT_ROLES,sharedPortraitId,hasPortraitAvatar} from '../src/review-portraits.ts'
import {safePortrait} from '../src/review-ui.ts'
import {reviewPresentation} from '../src/host/review-presentation.ts'
import {memberArtUrl} from '../src/client/artwork.ts'

test('expert identities survive role changes, aliases and pack reuse without broad nickname matching',()=>{
  assert.equal(EXPERT_PORTRAITS.length,16)
  assert.equal(new Set(EXPERT_PORTRAITS.map(x=>x.expertId)).size,16)
  assert.equal(expertPortraitId({expertId:'bk-025',name:'匿名专家',role:'临时审核'}),'expert-bk-025')
  assert.equal(expertPortraitId({sourceExpertId:'bk-025',expertId:'profile-alias'}),'expert-bk-025')
  assert.equal(expertPortraitId({name:'百城台长·指数口径'}),'expert-bk-025')
  assert.equal(expertPortraitId({name:'协助百城台长'}),undefined)
  assert.equal(expertPortraitId({name:'观澜观察员'}),undefined)
  assert.equal(expertPortraitId({name:'住宅租金·R'}),'expert-bk-hva-003')
  assert.equal(expertPortraitId({expertId:'unknown',role:'住宅估值'}),undefined)
  assert.equal(memberArtUrl('匿名','评审','bk-025',true),'/plugins/dsh-expert-library/review/portraits/expert-bk-025-avatar.webp?v=domain-portraits-20261007')
  for(const expert of EXPERT_PORTRAITS)assert(safePortrait(`asset:expert-${expert.expertId}`))
  for(const invalid of ['../expert-bk-025','expert-bk-025-avatar','__proto__','expert-unknown'])assert(!isExpertPortrait(invalid))
  assert(!safePortrait('asset:expert-unknown'))
})

test('legacy teams inherit portraits but frozen explicit artwork stays authoritative',()=>{
  const roster=[{sourceExpertId:'bk-025',expertId:'profile-alias',slotId:'researcher',role:'研究'}]
  const context={team:{tasks:[],reviewSnapshot:{roster}},research:true,issues:[],deliverables:[]}
  const wire={team:{members:[{id:'runtime-member',expertId:'profile-alias',name:'匿名专家',role:'审核'}]}}
  let result=reviewPresentation(context,wire,[])
  for(const key of ['bk-025','profile-alias','researcher','runtime-member','匿名专家'])assert.equal(result.experts[key].portrait,'asset:expert-bk-025')
  assert.equal(result.experts['runtime-member'].label,'匿名专家','portrait selection does not de-anonymize labels')
  context.ui={version:1,experts:{'bk-025':{portrait:'asset:policy'}}}
  result=reviewPresentation(context,wire,[])
  assert.equal(result.experts['runtime-member'].portrait,'asset:policy')
})

test('standalone browser and typed consumers use the same generated identity registry',async()=>{
  const source=await readFile(new URL('../src/review-portraits.ts',import.meta.url),'utf8')
  const code=stripTypeScriptTypes(source,{mode:'strip'}).replace(/^export /gm,'').trim()
  const page=await readFile(new URL('../assets/review/review.js',import.meta.url),'utf8')
  assert(page.includes(`// BEGIN GENERATED EXPERT PORTRAITS\n${code}\n// END GENERATED EXPERT PORTRAITS`))
  const browser=vm.runInNewContext(code+';({expertPortraitId,sharedPortraitId})')
  for(const expert of EXPERT_PORTRAITS)for(const name of expert.aliases){
    const member={name:name+'·当前任务'}
    assert.equal(browser.expertPortraitId(member),expertPortraitId(member))
  }
  for(const role of SHARED_PORTRAIT_ROLES)for(let i=0;i<30;i++)assert.equal(browser.sharedPortraitId('new-'+i,role),sharedPortraitId('new-'+i,role))
})

test('new packs get a stable varied cast while original and explicit portraits remain usable',()=>{
  assert.equal(PORTRAIT_POSES.length,12)
  for(const role of SHARED_PORTRAIT_ROLES){
    const allowed=[role,...PORTRAIT_POSES.filter(p=>p.role===role).map(p=>p.id)],seen=new Set()
    for(let i=0;i<90;i++){
      const key='new-expert-'+i,id=sharedPortraitId(key,role,role)
      assert(allowed.includes(id));seen.add(id);assert(safePortrait('asset:'+id))
      // Same identity and role must agree in standalone host presentation and activity UI.
      const wire={team:{members:[{id:key,expertId:key,name:key,role}]}}
      const context={team:{tasks:[]},research:false,issues:[],deliverables:[]}
      const entry=reviewPresentation(context,wire,[]).experts[key]
      const expected=entry.portrait.slice(6)
      assert(memberArtUrl(key,role,key,true).includes('/'+expected+(hasPortraitAvatar(expected)?'-avatar':'')+'.webp'))
    }
    assert.equal(seen.size,3,'both younger people and original must remain selectable')
  }
  assert(safePortrait('asset:pose-engineer-type'))
  assert(!safePortrait('asset:pose-unknown'))
  assert(!safePortrait('asset:pose-engineer-type-avatar'))
  assert(sharedPortraitId('unrecognized-id','全新领域'))
})
