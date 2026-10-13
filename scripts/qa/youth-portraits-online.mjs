import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
const root=new URL('../../',import.meta.url)
const base=(process.env.REVIEW_ORIGIN||'https://yy.meizu.life')+'/plugins/dsh-expert-library/review'
const manifest=JSON.parse(await readFile(new URL('assets/review/portraits/youth-poses-manifest.json',root)))
const results=[]
for(let i=0;i<manifest.assets.length;i+=4){
 await Promise.all(manifest.assets.slice(i,i+4).map(async a=>{
  for(const file of [a.file,a.avatar]){
   const r=await fetch(base+'/portraits/'+file+'?v=domain-portraits-20261007',{signal:AbortSignal.timeout(20000),redirect:'manual'})
   const buf=Buffer.from(await r.arrayBuffer()),local=await readFile(new URL('assets/review/portraits/'+file,root))
   results.push({file,status:r.status,type:r.headers.get('content-type'),same:buf.equals(local),sha256:createHash('sha256').update(buf).digest('hex')})
  }
 }))
}
const evidence={checkedAt:new Date().toISOString(),origin:base,results}
await writeFile(new URL('docs/previews/youth-poses-online-check-20261008.json',root),JSON.stringify(evidence,null,2)+'\n')
const bad=results.filter(r=>r.status!==200||r.type!=='image/webp'||!r.same)
assert.deepEqual(bad,[])
for(const suffix of ['', '/review.js?v=domain-portraits-20261007','/review.css']){
 const r=await fetch(base+suffix,{signal:AbortSignal.timeout(20000),redirect:'manual'}),body=await r.text()
 assert.equal(r.status,200)
 if(suffix.includes('review.js'))assert(body.includes('function sharedPortraitId'))
}
console.log('PASS: 24 public images, WebP MIME, byte-identical to checked assets, no login redirect; live page, JS catalog and CSS returned 200')
