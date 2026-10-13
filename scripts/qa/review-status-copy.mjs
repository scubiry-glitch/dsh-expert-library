// Run with REVIEW_PLAYWRIGHT_MODULE / REVIEW_CHROMIUM when Playwright is outside this workspace.
import {readFile} from 'node:fs/promises'
import assert from 'node:assert/strict'
const {chromium}=await import(process.env.REVIEW_PLAYWRIGHT_MODULE||'/root/zhijian/yy-moma-preview-source-20261004/node_modules/.pnpm/playwright-core@1.61.1/node_modules/playwright-core/index.mjs')
const browser=await chromium.launch({executablePath:process.env.REVIEW_CHROMIUM||'/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',headless:true,args:['--no-sandbox']})
const cases=[
 ['Review passed; waiting for captain acceptance.','评审已通过，等待研究队长验收。','待队长验收'],
 ['Review passed; waiting for 研究队长 acceptance','评审已通过，等待研究队长验收。','待队长验收'],
 ['Submitted; waiting for independent quality review.','稿件已提交，等待独立评审专家审核。','待独立评审'],
 ['Review requires a quality repair decision.','评审提出了修改意见，等待研究队长安排修改。','待安排修改'],
 ['Host transport checks recovered on unchanged publications. Await the bound independent reviewer; no author resubmission or budget charge.','文件读取已恢复，等待独立评审专家继续审核，无需重新提交稿件。','待独立评审'],
 ['A new internal transition is waiting for coordinator arbitration.','稿件已提交，等待评审确认。','待评审'],
 ['INPUT_ARTIFACT_BLOCKED: Error: SKILL_CRAFT_PATH: scripts/__pycache__','所需材料暂时不可用或未通过检查，请在工作区核对材料后继续。','材料待处理','blocked_external'],
 ['DISPATCH_DELIVERY_FAILED: Delivery was not accepted; retry this same attempt after the dispatch cooldown.','任务暂未送达负责专家，正在等待重新派发。','待重新派发','interrupted'],
 ['RUNTIME_TOOL_LOOP_DETECTED: repeated operation in session-private','专家连续重复尝试同一操作，任务已暂停，请研究队长检查后安排继续。','需要处理','blocked_external'],
 ['Completion blocked: missing dependent task','任务尚未满足完成条件，请研究队长检查并补齐相关要求。','待补齐要求','blocked_external'],
]
const tasks=cases.map(([waitReason,,,executionState],i)=>({id:'t'+i,subject:'研究任务 '+i,assignee:'专家',status:'in_progress',executionState:executionState||'awaiting_review',waitReason,dependencies:[]}))
const state={ok:true,expiresAt:Date.now()+86400000,plan:null,team:{id:'copy-test',captainSessionId:'captain',name:'状态文案验收',members:[{id:'m',name:'专家',role:'内容评审'}],tasks},documents:[]}
const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message))
await page.route('https://review.test/**',async r=>{const u=new URL(r.request().url()),name=u.pathname.split('/').pop();if(u.pathname.includes('/api/'))return r.fulfill({contentType:'application/json',body:JSON.stringify(name==='conversation'?{ok:true,conversation:{messages:[],nextAfter:0}}:state)});const file=u.pathname.includes('/portraits/')?'portraits/'+name:name==='review'?'index.html':name;await r.fulfill({contentType:file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.webp')?'image/webp':'text/html',body:await readFile(new URL('../../assets/review/'+file,import.meta.url))})})
try{
 await page.goto('https://review.test/plugins/dsh-expert-library/review?access='+'a'.repeat(24));await page.locator('#content:visible').waitFor()
 await page.locator('#view-workspace').click()
 await page.locator('#tab-activity').click();assert.match(await page.locator('#heroResearchSummary').innerText(),/0 位专家工作中/)
 for(const [i,entry] of cases.entries())assert.match(await page.locator(`.taskListRow[data-task-id="t${i}"]`).innerText(),new RegExp(entry[2]))
 await page.locator('[data-activity-view=graph]').click()
 for(const [i,[raw,message,label]] of cases.entries()){
  await page.locator('.dagTaskPicker').selectOption('t'+i)
  assert.equal(await page.locator('.activityDagDetail>.eyebrow').innerText(),label)
  assert.equal(await page.locator('.activityDagDetail .problemNotice>p').innerText(),message)
  assert(!(await page.locator('.activityDagDetail').innerText()).includes(raw))
  const record=page.locator('.activityDagDetail .problemNotice details');assert.equal(await record.evaluate(n=>n.open),false);assert.equal(await record.locator('pre').textContent(),raw)
  assert.equal(await page.locator(`.activityDagNode[data-task-id="t${i}"]`).getAttribute('data-tone'),entryTone(i))
 }
 // A passed review still awaits acceptance; it must not complete a stage or animate as working.
 state.team.tasks=[tasks[0]];state.team.updatedAt=Date.now();await page.waitForFunction(()=>document.querySelectorAll('.taskListRow').length===1)
 assert.equal(await page.locator('.sceneExpert small').innerText(),'待队长验收');assert.equal(await page.locator('#tab-activity').getAttribute('data-complete'),'false');assert.equal(await page.locator('.sceneExpert').getAttribute('data-activity'),'waiting')
 tasks[0].status='completed';state.team.updatedAt++;await page.waitForFunction(()=>document.querySelector('.sceneExpert small')?.textContent==='已完成');assert.equal(await page.locator('#tab-activity').getAttribute('data-complete'),'true');assert.equal(await page.locator('.activityDagDetail .problemNotice').count(),0)
 for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))}
 assert.deepEqual(errors,[]);console.log('PASS: 10 real execution messages, mixed language, unknown message fallback, graph/list/cover consistency, pending acceptance is not completion, raw records folded, completed-state precedence, responsive widths')
}finally{await browser.close()}
function entryTone(i){return cases[i][3]==='blocked_external'?'blocked':'waiting'}
