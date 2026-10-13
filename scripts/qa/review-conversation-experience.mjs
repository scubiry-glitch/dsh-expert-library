// Isolated browser fixture: all requests intercepted; no production messages or tasks.
// Internal helpers are exposed only in the intercepted test response.
import {chromium} from '/usr/local/lib/python3.11/site-packages/playwright/driver/package/index.mjs'
import {readFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
const dir=process.argv[2]||new URL('../../assets/review', import.meta.url).pathname
const b=await chromium.launch({executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell',args:['--no-sandbox']})
const state={ok:true,expiresAt:Date.now()+86400000,canSendMessage:true,plan:null,team:{id:'fixture',captainSessionId:'captain',name:'对话空间验证',members:[],tasks:[]},documents:[]}
const messages=Array.from({length:12},(_,seq)=>({seq,id:'m'+seq,role:seq%2?'assistant':'user',text:seq%2?'已核对本轮研究材料。\n\n我们会保留原始证据，并继续检查关键数据之间的关系。\n\n当前结论还有两处需要补充来源，完成后会在这里更新进展。':'请继续核对资料，并说明需要补充的部分。',time:Date.now()}))
const errors=[]
try{
const p=await b.newPage({viewport:{width:390,height:740},reducedMotion:'reduce'})
p.on('pageerror',e=>errors.push(e.message))
await p.addInitScript(()=>{window.EventSource=undefined})
await p.route('https://review.test/**',async route=>{
const u=new URL(route.request().url());
if(u.pathname.endsWith('/api/state'))return route.fulfill({contentType:'application/json',body:JSON.stringify(u.searchParams.get('view')==='conversation'?{ok:true,conversation:{messages,nextCursor:11,hasMore:false}}:state)})
if(u.pathname.includes('/api/'))throw Error('Unexpected mutation')
let file=u.pathname.split('/').pop();if(file==='review')file='index.fast.html';if(u.pathname.includes('/portraits/'))return route.fulfill({status:404,body:''})
return route.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html',body:file==='review.js'?(await readFile(dir+'/'+file,'utf8')).replace('function updateConversationLatest()', 'Object.assign(window, {updateConversationLatest, appendConversationMessage, fitConversationViewport});\nfunction updateConversationLatest()'):await readFile(dir+'/'+file)})
})
await p.goto('https://review.test/plugins/dsh-expert-library/review?access='+'a'.repeat(24));await p.locator('[data-seq="11"]').waitFor()

const check = async (label, fn) => { await fn(); console.log('PASS: '+label) }
await check('latest hidden at bottom; incoming messages preserve history and count once',async()=>{
 await p.waitForFunction(()=>document.getElementById('conversationLatest').hidden)
 await p.evaluate(()=>{const el=document.getElementById('conversationMessages');el.scrollTop=0;updateConversationLatest()})
 const top=await p.locator('#conversationMessages').evaluate(el=>el.scrollTop)
 await p.evaluate(()=>{for(const seq of [12,13,13])appendConversationMessage({seq,role:'assistant',time:Date.now(),text:'实时追加消息 '+seq},true)})
 assert.equal(await p.locator('#conversationLatest').textContent(),'↓ 2 条新消息')
 assert.equal(await p.locator('#conversationMessages').evaluate(el=>el.scrollTop),top)
 await p.locator('#conversationLatest').click()
 assert(await p.locator('#conversationLatest').isHidden())
})
await check('question search, empty results, and restored list position',async()=>{
 await p.evaluate(()=>{for(let seq=14;seq<54;seq++)appendConversationMessage({seq,role:'user',time:Date.now(),text:seq===30?'唯一关键词：租赁证据':'历史提问 '+seq},false)})
 await p.locator('#conversationQuestionsToggle').click()
 await p.locator('#conversationQuestionSearch').fill('租赁证据')
 assert.equal(await p.locator('.conversationQuestionItem').count(),1)
 await p.locator('.conversationQuestionItem').click()
 assert(await p.locator('[data-seq="30"]').evaluate(el=>el.classList.contains('conversationQuestionHighlight')))
 await p.locator('#conversationQuestionsToggle').click()
 assert.equal(await p.locator('#conversationQuestionSearch').inputValue(),'租赁证据')
 await p.locator('#conversationQuestionSearch').fill('不存在的词')
 assert.equal(await p.locator('.conversationQuestionItem').count(),0)
 await p.locator('#conversationQuestionSearch').fill('')
 await p.locator('#conversationQuestionsList').evaluate(el=>el.scrollTop=250)
 await p.waitForTimeout(50)
 await p.locator('#conversationQuestionsClose').click()
 await p.locator('#conversationQuestionsToggle').click()
 assert.equal(await p.locator('#conversationQuestionsList').evaluate(el=>el.scrollTop),250)
 await p.locator('#conversationQuestionsClose').click()
})
await check('consecutive same-author grouping and separated timestamps',async()=>{
 assert(await p.locator('[data-seq="16"]').evaluate(el=>el.classList.contains('conversationContinuation')))
 assert.equal(await p.locator('[data-seq="16"] .conversationAvatar').evaluate(el=>getComputedStyle(el).visibility),'hidden')
 await p.evaluate(()=>appendConversationMessage({seq:54,role:'user',text:'十分钟后的新问题',time:Date.now()+600000},false))
 assert(await p.locator('[data-seq="54"]').evaluate(el=>Boolean(el.dataset.timeGroup)&&!el.classList.contains('conversationContinuation')))
})
await check('long reply excerpt and stable expand/collapse anchors',async()=>{
 await p.evaluate(()=>appendConversationMessage({seq:55,role:'assistant',time:Date.now()+610000,text:'研究结论与下一步。\n\n'+('核对证据并补充可靠来源。\n\n'.repeat(150))},true))
 const summary=p.locator('[data-seq="55"] summary')
 await summary.scrollIntoViewIfNeeded()
 const before=await summary.evaluate(el=>el.getBoundingClientRect().top)
 await summary.click()
 await p.waitForTimeout(50)
 assert(Math.abs((await summary.evaluate(el=>el.getBoundingClientRect().top))-before)<3)
 assert(await p.locator('[data-seq="55"] details').evaluate(el=>el.open))
 await p.locator('[data-seq="55"] .conversationCollapse').click()
 assert(await p.locator('[data-seq="55"] details').evaluate(el=>!el.open))
 assert(await summary.evaluate(el=>{const a=el.getBoundingClientRect(),b=document.getElementById('conversationMessages').getBoundingClientRect();return a.top>=b.top&&a.top<b.bottom}))
})
await check('keyboard viewport shrink, pan, restore; multiline input stays bounded',async()=>{
 await p.evaluate(()=>{window.originalViewport=window.visualViewport;const v=new EventTarget();v.height=400;v.offsetTop=40;Object.defineProperty(window,'visualViewport',{configurable:true,value:v});fitConversationViewport()})
 assert((await p.locator('#conversationCompose').boundingBox()).y+(await p.locator('#conversationCompose').boundingBox()).height<=440)
 await p.locator('#conversationInput').fill(Array(20).fill('较长输入').join('\n'))
 assert((await p.locator('#conversationInput').boundingBox()).height<=140)
 await p.evaluate(()=>{Object.defineProperty(window,'visualViewport',{configurable:true,value:window.originalViewport});fitConversationViewport()})
 await p.locator('#conversationInput').fill('')
 assert.equal((await p.locator('#conversationInput').boundingBox()).height,42)
 for(const width of [320,390,768,1440]){await p.setViewportSize({width,height:740});await p.waitForTimeout(30);assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))}
 await p.setViewportSize({width:390,height:740})
})
await p.locator('#conversationQuestionsToggle').click()
await p.screenshot({path:'/tmp/review-experience-questions.png'})
await p.locator('#conversationQuestionsClose').click()
await p.screenshot({path:'/tmp/review-experience-reading.png'})
assert.deepEqual(errors,[])
}finally{await b.close()}
