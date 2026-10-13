import { readFile, writeFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { EXPERT_PORTRAITS, PORTRAIT_POSES, SHARED_PORTRAIT_ROLES, sharedPortraitId, hasPortraitAvatar } from '../../src/review-portraits.ts'
const {chromium}=await import(process.env.REVIEW_PLAYWRIGHT_MODULE||'/root/zhijian/pack-center/apps/pack-center/node_modules/playwright-core/index.mjs')
const browser=await chromium.launch({executablePath:process.env.REVIEW_CHROMIUM||'/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell',headless:true,args:['--no-sandbox']})
const root=new URL('../../',import.meta.url), preview=new URL('docs/previews/',root)
await mkdir(preview,{recursive:true})
const manifest=JSON.parse(await readFile(new URL('assets/review/portraits/youth-poses-manifest.json',root)))
assert.equal(manifest.assets.length,12)
assert.equal(new Set(manifest.assets.map(a=>a.sha256)).size,12)
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>专家人物画册</title><style>body{margin:0;background:#f5efdf;color:#42392e;font:16px sans-serif;padding:42px}h1{margin:0 0 12px;font-size:34px}p{color:#786951;margin-bottom:28px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:18px}article{position:relative;background:#fffaf0;border:1px solid #ddd1b9;border-radius:22px;padding:12px;text-align:center}img.body{width:100%;height:230px;object-fit:contain}img.avatar{position:absolute;width:56px;height:56px;right:14px;top:14px;border-radius:50%;background:#efe3cb;border:3px solid #fff9ee}h2{font-size:19px;margin:8px}small{color:#8c7454}</style><h1>专家协作室 · 人物画册</h1><p>12 位年轻人物｜多种工作姿势 · 原有素材全部保留</p><div class="grid">${manifest.assets.map(a=>`<article><img class="body" src="../../assets/review/portraits/${a.file}"><img class="avatar" src="../../assets/review/portraits/${a.avatar}"><h2>${a.label}</h2><small>${({coordinator:'统筹协作',finance:'金融经营',policy:'政策研究',market:'市场调研',engineer:'工程设计',reviewer:'评审质控'})[a.role]}</small></article>`).join('')}</div></html>`
await writeFile(new URL('youth-poses-20261008.html',preview),html)
try {
 const gallery=await browser.newPage({viewport:{width:1200,height:100},deviceScaleFactor:1})
 await gallery.goto(new URL('youth-poses-20261008.html',preview).href)
 await gallery.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0))
 await gallery.screenshot({path:new URL('youth-poses-20261008.png',preview).pathname,fullPage:true})
 await gallery.close()
 const targets=[...PORTRAIT_POSES,...SHARED_PORTRAIT_ROLES.map(role=>({id:role,role,label:'原有'+role}))]
 const members=targets.map((p,i)=>{
  let key
  for(let n=0;n<1000;n++){const candidate='new-pack-expert-'+n;if(sharedPortraitId(candidate,p.role)===p.id){key=candidate;break}}
  assert(key,'must be reachable: '+p.id)
  return {id:'m'+i,expertId:key,name:p.label,role:p.role}
 })
 members.push({id:'original-named',expertId:'bk-025',name:'百城台长',role:'数据研究'})
 const state={ok:true,expiresAt:Date.now()+86400000,plan:null,team:{id:'portraits',captainSessionId:'captain',name:'青年专家协作与研究',members,tasks:members.map((m,i)=>({id:'t'+i,subject:m.name+'的研究任务',assignee:m.name,status:'in_progress',executionState:'running',dependencies:[]}))},documents:[]}
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[]
 page.on('pageerror',e=>errors.push(e.message))
 let failNamed=false
 await page.route('https://review.test/**',async r=>{
  const u=new URL(r.request().url()),name=u.pathname.split('/').pop()
  if(u.pathname.includes('/api/'))return r.fulfill({contentType:'application/json',body:JSON.stringify(name==='conversation'?{ok:true,conversation:{messages:[],nextAfter:0}}:state)})
  if(failNamed&&u.pathname.includes('/portraits/'))return r.fulfill({status:404,body:''})
  const file=u.pathname.includes('/portraits/')?'portraits/'+name:name==='review'?'index.html':name
  await r.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webp')?'image/webp':'text/html',body:await readFile(new URL('assets/review/'+file,root))})
 })
 await page.goto('https://review.test/plugins/dsh-expert-library/review?access='+'a'.repeat(24))
 await page.locator('#content:visible').waitFor()
 await page.locator('#view-workspace').click()
 await page.locator('#tab-activity').click()
 await page.locator('[data-activity-view=graph]').click()
 await page.waitForFunction(()=>[...document.querySelectorAll('img[data-portrait]')].every(i=>i.complete&&i.naturalWidth>0))
 const bodies=await page.locator('img.dagPerson[data-portrait]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.portrait,src:n.src})))
 assert.equal(new Set(bodies.map(n=>n.id)).size,19)
 assert(bodies.every(n=>!n.src.includes('-avatar.webp')))
 const faces=await page.locator('.portrait img[data-portrait]').evaluateAll(nodes=>nodes.map(n=>({src:n.src,id:n.dataset.portrait})))
 assert(faces.length>0);assert(faces.every(n=>n.src.includes('-avatar.webp')===hasPortraitAvatar(n.id)))
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))}
 await page.setViewportSize({width:390,height:844})
 await page.screenshot({path:new URL('youth-poses-mobile-20261008.png',preview).pathname,fullPage:true})
 failNamed=true;await page.reload();await page.locator('#content:visible').waitFor()
 await page.waitForFunction(()=>[...document.querySelectorAll('img[data-portrait]')].every(i=>i.complete&&i.naturalWidth>0&&i.src.startsWith('data:image/')))
 assert.deepEqual(errors,[])
 console.log('PASS: 12 new poses + 6 original shared + original named identity, all gallery images decoded, half-body DAG, avatar crops, 320/390/768/1440 widths, all external portraits fail -> embedded fallback, no browser exceptions')
}finally{await browser.close()}
