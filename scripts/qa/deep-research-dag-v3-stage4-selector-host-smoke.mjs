/** Authenticated Host plan edit: registered sub-DAG/expert selections are recompiled before approval. */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runTeamCommunicationHostSmoke } from './team-communication-host-smoke.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const url = path => JSON.stringify(pathToFileURL(path).href)
async function browserReview({ baseUrl, cookie, prepared, workspace, probe }) {
  const require = createRequire(import.meta.url)
  const { chromium } = require('/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright')
  const browser = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] })
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const separator = cookie.indexOf('=')
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    const failures = []
    page.on('pageerror', error => failures.push(String(error.message).slice(0, 160)))
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname
      if (response.status() >= 400 && !(pathname === '/plugins/dsh-expert-library/teams' && response.status() === 400))
        failures.push(`${response.status()} ${pathname}`)
    })
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    const continueButton = page.getByRole('button', { name: 'Continue' })
    await continueButton.waitFor({ state: 'visible', timeout: 15000 })
    for (let attempt = 0; attempt < 4 && await continueButton.isVisible().catch(() => false); attempt++) {
      await continueButton.click()
      await page.waitForTimeout(1000)
    }
    const workspacePicker = page.getByRole('button', { name: /Choose workspace/ })
    const overlays = await page.locator('[role="presentation"]').allTextContents()
    const pickerCount = await workspacePicker.count()
    if (pickerCount && !await continueButton.isVisible().catch(() => false)) {
      await workspacePicker.click({ timeout: 5000 })
      await page.getByRole('button', { name: 'Edit path' }).click()
      const pathInput = page.locator('input:visible').last()
      await pathInput.fill(workspace)
      await pathInput.press('Enter')
      await page.waitForTimeout(500)
      await page.getByRole('button', { name: 'Open', exact: true }).click()
      await page.waitForTimeout(1300)
    }
    const sessions = await probe('sessions')
    const uiSession = sessions.find(item => item.cwd === workspace && item.id.startsWith('session-'))
    const currentModel = page.getByRole('button', { name: /Select model|deepseek-official\/deepseek-flash|Stub model/u })
    let modelPicker
    if (await currentModel.count()) {
      await currentModel.first().click()
      modelPicker = {
        text: (await page.locator('body').innerText()).slice(-1800),
        buttons: (await page.locator('button:visible').allTextContents()).slice(-35),
      }
      const modelMenu = page.locator('button:visible').filter({ hasText: /Model/u })
      if (await modelMenu.count()) {
        await modelMenu.last().click()
        modelPicker.models = {
          text: (await page.locator('body').innerText()).slice(-1800),
          buttons: (await page.locator('button:visible').allTextContents()).slice(-35),
        }
        const stub = page.locator('button:visible').filter({ hasText: /Stub model/u })
        await stub.last().waitFor({ state: 'visible', timeout: 12000 })
        await stub.last().click()
      }
      const stub = page.locator('button:visible').filter({ hasText: /Stub model/u })
      if (await stub.count()) await stub.last().click()
      await page.keyboard.press('Escape')
    }
    await page.locator('[contenteditable="true"],textarea').last().waitFor({ state: 'visible', timeout: 12000 })
    let uiStage, uiStageError, gateStage
    if (uiSession !== undefined) {
      try {
        const editor = page.locator('[contenteditable="true"],textarea').last()
        await editor.fill('STAGE4_UI_PLAN：隔离浏览器执行计划选型验收。', { timeout: 5000 })
        await page.getByRole('button', { name: 'Send message' }).click()
        await page.locator('[data-plan-editor]').waitFor({ state: 'visible', timeout: 15000 })
        const graph = page.locator('[data-plan-dag-graph]')
        const selector = page.locator('[data-plan-subdag-selector] select:not([data-plan-recommend-select])').first()
        const before = await page.locator('[data-plan-editor]').innerText()
        if (await selector.count()) {
          await selector.selectOption('research-2')
          await page.locator('[data-plan-action="save-subdag"]').click()
          await page.getByText('r1 · 等待用户确认').waitFor({ state: 'visible', timeout: 10000 })
        }
        const material = page.locator('[data-plan-task-review] li').filter({ has: page.locator('code').filter({ hasText: /^research_main$/u }) }).getByLabel('本节点 Skill 组合')
        let materialSaved = false
        if (await material.count()) {
          await material.selectOption('strategy')
          await page.locator('[data-plan-action="save-materials"]').click()
          await page.getByText('r2 · 等待用户确认').waitFor({ state: 'visible', timeout: 10000 })
          materialSaved = true
        }
        const modelOptions = await page.locator('[data-plan-model-editor] select').first().locator('option').allTextContents()
        const chapterTitle = page.locator('[data-plan-outline] input').first()
        let outlineSaved = false
        if (await chapterTitle.count()) {
          await chapterTitle.fill((await chapterTitle.inputValue()) + ' · UI 验收')
          await page.locator('[data-plan-action="edit"]').click()
          await page.getByText('r3 · 等待用户确认').waitFor({ state: 'visible', timeout: 10000 })
          outlineSaved = true
          await page.reload({ waitUntil: 'domcontentloaded' })
          const collapsedActivity = page.getByRole('button', { name: /Expert Teams 活动/u })
          for (let attempt = 0; attempt < 30; attempt++) {
            if (await page.getByText('r3 · 等待用户确认').isVisible().catch(() => false)) break
            if (await collapsedActivity.isVisible().catch(() => false)) await collapsedActivity.click()
            await page.waitForTimeout(250)
          }
          await page.getByText('r3 · 等待用户确认').waitFor({ state: 'visible', timeout: 10000 })
        }
        await page.locator('[data-plan-recommend-select]').selectOption('ai')
        await page.getByText('r4 · 等待用户确认').waitFor({ state: 'visible', timeout: 30000 })
        await page.locator('[data-plan-recommendation]').waitFor({ state: 'visible', timeout: 10000 })
        const recommendationText = await page.locator('[data-plan-recommendation]').innerText()
        if (!recommendationText.includes('research') && !recommendationText.includes('模型推荐')) throw new Error('RECOMMENDATION_RECEIPT_NOT_VISIBLE')
        uiStage = { sessionId: uiSession.id, visible: true, graphCount: await graph.count(), selectorCount: await selector.count(),
          materialSaved, modelOptions, outlineSaved, aiRecommended: true, recommendationText: recommendationText.slice(0, 360),
          beforeDigest: /当前计划 SHA256：\s*([a-f0-9]{64})/u.exec(before)?.[1],
          after: (await page.locator('[data-plan-editor]').innerText()).slice(0, 380) }
        const fixture = await probe(`choice-prepare&sessionId=${encodeURIComponent(uiSession.id)}`)
        const endpoint = '/plugins/dsh-expert-library/teams'
        const gateToggle = page.locator(`[data-team-controls][data-team-id="${fixture.teamId}"] [data-team-controls-toggle]`)
        const openGates = async () => {
          await gateToggle.waitFor({ state: 'visible', timeout: 10000 })
          if (await gateToggle.getAttribute('aria-expanded') !== 'true') await gateToggle.click()
        }
        const read = async () => page.evaluate(async ({ endpoint, captainSessionId, teamId }) => {
          const response = await fetch(`${endpoint}?captainSessionId=${encodeURIComponent(captainSessionId)}&teamId=${encodeURIComponent(teamId)}`)
          return { status: response.status, body: await response.json() }
        }, { endpoint, captainSessionId: uiSession.id, teamId: fixture.teamId })
        const chooseApi = async (taskId, choice, expectedSha256) => page.evaluate(async ({ endpoint, captainSessionId, teamId, taskId, choice, expectedSha256 }) => {
          const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'choose', captainSessionId, teamId, taskId, choice, expectedSha256 }) })
          return { status: response.status, body: await response.json() }
        }, { endpoint, captainSessionId: uiSession.id, teamId: fixture.teamId, taskId, choice, expectedSha256 })
        const withoutCookie = await fetch(`${baseUrl}${endpoint}?captainSessionId=${encodeURIComponent(uiSession.id)}&teamId=${encodeURIComponent(fixture.teamId)}`)
        if (withoutCookie.status !== 401) throw new Error(`GATE_AUTH_EXPECTED_401: ${withoutCookie.status}`)
        const outlineGate = page.locator('[data-human-choice="outline_choice"]')
        const reportGate = page.locator('[data-human-choice="report_release"]')
        await openGates()
        await outlineGate.waitFor({ state: 'visible', timeout: 10000 })
        await reportGate.waitFor({ state: 'visible', timeout: 10000 })
        if (!await outlineGate.locator('pre').innerText().then(value => value === fixture.outlineContent)
          || !await reportGate.locator('pre').innerText().then(value => value === fixture.reportContent)) throw new Error('GATE_BROWSER_FULL_TEXT_MISMATCH')
        const options = await outlineGate.locator('[data-human-choice-option]').allTextContents()
        if (JSON.stringify(options) !== JSON.stringify(['A','B','C','A+C'])) throw new Error(`GATE_OPTIONS_MISMATCH: ${JSON.stringify(options)}`)
        const beforeChoice = await read()
        if (beforeChoice.status !== 200 || beforeChoice.body.team.tasks.find(task => task.id === 'point_figures')?.status !== 'pending'
          || beforeChoice.body.team.tasks.find(task => task.id === 'renderer')?.status !== 'pending') throw new Error('GATE_DOWNSTREAM_UNLOCKED_EARLY')
        const stale = await chooseApi('outline_choice', 'A', '0'.repeat(64))
        if (stale.status !== 400) throw new Error(`GATE_STALE_EXPECTED_400: ${stale.status}`)
        await outlineGate.getByRole('button', { name: 'A+C' }).click()
        await page.locator('[data-human-choice-receipt="outline_choice"]').waitFor({ state: 'visible', timeout: 10000 })
        const repeat = await chooseApi('outline_choice', 'B', fixture.outlineSha)
        if (repeat.status !== 400) throw new Error(`GATE_REPEAT_EXPECTED_400: ${repeat.status}`)
        const beforeRelease = await read()
        if (beforeRelease.body.team.tasks.find(task => task.id === 'point_figures')?.status !== 'pending'
          || beforeRelease.body.team.tasks.find(task => task.id === 'renderer')?.status !== 'pending') throw new Error('GATE_RELEASE_DOWNSTREAM_UNLOCKED_EARLY')
        await reportGate.getByRole('button', { name: '进入点睛图' }).click()
        await openGates()
        await page.locator('[data-human-choice-receipt="report_release"]').waitFor({ state: 'visible', timeout: 10000 })
        await page.reload({ waitUntil: 'domcontentloaded' })
        for (let attempt = 0; attempt < 30; attempt++) {
          if (await page.locator('[data-human-choice-receipt="report_release"]').isVisible().catch(() => false)) break
          const badge = page.getByRole('button', { name: /Expert Teams 活动/u })
          if (await badge.isVisible().catch(() => false)) await badge.click()
          if (await gateToggle.isVisible().catch(() => false) && await gateToggle.getAttribute('aria-expanded') !== 'true') await gateToggle.click()
          await page.waitForTimeout(250)
        }
        await page.locator('[data-human-choice-receipt="report_release"]').waitFor({ state: 'visible', timeout: 10000 })
        const afterChoice = await read()
        if (afterChoice.body.team.tasks.find(task => task.id === 'outline_choice')?.humanChoice?.receipt?.choice !== 'A+C'
          || afterChoice.body.team.tasks.find(task => task.id === 'report_release')?.humanChoice?.receipt?.sourceSha256 !== fixture.reportSha) throw new Error('GATE_RECEIPT_NOT_DURABLE')
        gateStage = { teamId: fixture.teamId, outlineSha: fixture.outlineSha, reportSha: fixture.reportSha,
          options, unauthorizedStatus: withoutCookie.status, staleStatus: stale.status, repeatStatus: repeat.status,
          outlineChoice: 'A+C', reportChoice: '进入点睛图', refreshedReceipt: true,
          pendingBeforeRelease: true }
      } catch (error) { uiStageError = `${String(error).slice(0, 360)}; alerts=${JSON.stringify(await page.getByRole('alert').allTextContents())}`; await page.screenshot({ path: '/tmp/deep-research-stage4-browser-failure.png' }) }
    }
    await page.screenshot({ path: '/tmp/deep-research-stage4-browser.png' })
    if (uiStageError !== undefined || uiStage?.graphCount !== 1 || uiStage.selectorCount !== 1
      || !uiStage.materialSaved || !uiStage.outlineSaved || !gateStage?.refreshedReceipt || failures.length > 0) {
      throw new Error(`STAGE4_BROWSER_REVIEW_FAILED: ${uiStageError ?? JSON.stringify({ uiStage, gateStage, failures })}`)
    }
    return { url: page.url().replace(baseUrl, ''), title: await page.title(), sessionId: prepared.sessionId, workspace,
      hostSessions: sessions, uiStage, gateStage, uiStageError, modelPicker,
      composerFields: await page.locator('[contenteditable],textarea').evaluateAll(rows => rows.map(row => ({ tag: row.tagName, editable: row.getAttribute('contenteditable'), placeholder: row.getAttribute('placeholder') }))),
      visiblePlanCount: await page.locator('[data-plan-editor]').count(),
      visibleDagCount: await page.locator('[data-plan-dag-graph]').count(),
      headings: await page.locator('h1:visible,h2:visible,h3:visible').allTextContents(), buttons: (await page.locator('button:visible').allTextContents()).slice(0, 35),
      buttonDetails: (await page.locator('button:visible').evaluateAll(rows => rows.map(row => ({ text: row.textContent?.trim().slice(0,50), ariaLabel: row.getAttribute('aria-label'), title: row.getAttribute('title') })))).slice(-30),
      inputs: await page.locator('input:visible').evaluateAll(rows => rows.map(row => ({ placeholder: row.getAttribute('placeholder'), ariaLabel: row.getAttribute('aria-label'), value: row.value }))),
      pickerCount, links: (await page.locator('a[href]:visible').evaluateAll(rows => rows.map(row => ({ text: row.textContent?.trim(), href: row.getAttribute('href') })))).slice(0, 20), alerts: await page.getByRole('alert').allTextContents(), overlays: overlays.map(value=>value.slice(0,500)), failures, body: (await page.locator('body').innerText()).slice(0, 1500) }
  } finally { await browser.close() }
}
function probePlugin(workspace, nonce) { return `
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter, createUserMessage } from ${url('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js')};
import * as preset from ${url(join(repo, 'lib/preset.js'))};
import { createTeamDir, createTaskProject, publishTaskArtifact, writeTeam } from ${url(join(repo, 'lib/state.js'))};
import { createQualityRun, reviewQualityRun, integrateQualityRun } from ${url(join(repo, 'lib/quality-run.js'))};
export const name='deep-research-stage4-selector-probe';
export const inject=['tools','webServer','agents','llm','agentPresets'];
const workspace=${JSON.stringify(workspace)}, nonce=${JSON.stringify(nonce)};
const file=join(workspace,'deep-research-selector.json');
const source='/root/.openclaw/workspace/98wiki/projects/供平过租见底路径/深度研究团队DAG-v3.json';
export function apply(ctx){
 const stagedByModel=new Set();
 class Adapter extends LlmAdapter{
  providerInfo(id){return {id,name:'Local fixture'}}
  async listModels(){return [{provider:'deep-research-smoke',id:'stub',name:'Stub model'}]}
  async *stream(options){
   let prompt;
   try{prompt=JSON.parse(options.messages.at(-1)?.content?.[0]?.text??'')}catch{}
   if(prompt?.instructions?.includes('STAGE4_RECOMMEND')){
    const modelChoice=prompt.models.find(item=>item.provider==='deep-research-smoke'&&item.model==='stub').id;
    const answer=JSON.stringify({subDagId:'research-3',expertIds:['bk-024','bk-031','bk-010'],materialRecipes:{research_main:'strategy',research_counter:'core',evidence_merge:'strategy',writer:'core'},modelChoice,reason:'供给、成交与租赁需要三个互补视角并行核查；战略分析 Skill 用于主线和证据汇合，模型仅从当前已注册目录选择。'});
    yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:answer};yield {type:'block-end',index:0,block:{type:'text',text:answer}};yield {type:'finish',reason:{kind:'stop'}};return;
   }
   if(JSON.stringify(options.messages).includes('STAGE4_UI_PLAN')&&!stagedByModel.has(options.sessionId)){
    stagedByModel.add(options.sessionId);
    const draft=JSON.parse(await readFile(source,'utf8'));
    const profile=structuredClone(draft.profile);
    for(const member of profile.members)member.route={provider:'deep-research-smoke',model:'stub'};
    const args={profile,report_outline:draft.report_outline,plan_models:{captain:{provider:'deep-research-smoke',model:'stub'}},team_name:'stage4-browser-'+randomUUID().slice(0,8)};
    const block={type:'tool-call',id:'stage4-plan-'+randomUUID(),name:'expert_teams_plan_stage',arguments:JSON.stringify(args)};
    yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block};yield {type:'finish',reason:{kind:'tool-calls'}};return;
   }
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Ready.'};yield {type:'block-end',index:0,block:{type:'text',text:'Ready.'}};yield {type:'finish',reason:{kind:'stop'}}
  }
 }
 ctx.effect(()=>ctx.llm.registerAdapter(['deep-research-smoke'],new Adapter()));
 const open=async(id,resume=false)=>(await ctx.agents[resume?'resume':'create']({[resume?'resumeSessionId':'sessionId']:id,agentOptions:{provider:'deep-research-smoke',model:'stub'},...(resume?{}:{meta:{cwd:workspace,agentPreset:'standard'}}),setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'standard');agentCtx.plugin(preset,{stateDir:'expert-teams',memberProvider:'spawn',memberModel:{provider:'deep-research-smoke',model:'stub'}})}})).agent;
 const call=(agent,name,args)=>agent.ctx.tools.get('expert_teams_'+name,agent).execute(args,{agent,signal:new AbortController().signal});
 const reviewedSource=async(stateRoot,team,task,artifactName,content)=>{
   task.project=await createTaskProject(stateRoot,team.id,task);
   const artifact=await publishTaskArtifact(stateRoot,team,task,{name:artifactName,content});
   task.publishedArtifacts=[artifact];
   const path=team.id+'/'+task.project.artifactsPath+'/'+artifact.relativePath;
   const digest=createHash('sha256').update(content).digest('hex');
   const base=createQualityRun({id:'review-'+task.id,taskId:task.id,attempt:1,assignee:'captain',kind:'implementation',objective:'review '+task.id,inScope:[team.id+'/**'],acceptance:[{id:'verified',statement:'verified'}],verify:['node --version'],deliverables:[artifact.reviewId],changedPaths:[path]});
   const reviewed=reviewQualityRun(base,{eventId:'review-'+task.id,reviewer:'independent',verdict:'pass',evidence:{taskId:task.id,attempt:1,artifacts:[{id:artifact.reviewId,path,taskId:task.id,attempt:1,content,sha256:digest}],acceptanceResults:[{id:'verified',passed:true}],commandsRun:[{command:'node --version',exitCode:0,passed:true}],changedPaths:[path]}}).run;
   team.qualityRuns??={};team.qualityRuns[task.id]=integrateQualityRun(reviewed,{eventId:'integrate-'+task.id,actor:'captain'}).run;
   return artifact.sha256;
 };
 const server=ctx.get('webServer');
 ctx.effect(()=>server.register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
  if(req.headers['x-smoke-nonce']!==nonce){res.writeHead(403);res.end();return}
  try{
   const query=new URL(req.url,'http://localhost').searchParams;
   const action=query.get('action');let result;
   if(action==='schema')result={stage4Selector:true,noPaidModel:true};
   else if(action==='sessions')result=ctx.agents.list().map(agent=>({id:agent.id,cwd:agent.session.header.cwd??null,origin:agent.session.header.origin??null}));
   else if(action==='choice-prepare'){
    const id=query.get('sessionId');
    const captain=ctx.agents.list().find(agent=>agent.id===id&&agent.session.header.cwd===workspace);
    assert.ok(captain,'browser workspace session must be live');
    const now=Date.now(),stateRoot=join(workspace,'expert-teams');
    const source=(id,subject)=>({id,subject,status:'completed',assignee:'captain',attempt:1,dependencies:[],createdAt:now,updatedAt:now});
    const pending=(id,subject,dependencies,extras={})=>({id,subject,status:'pending',attempt:0,dependencies,createdAt:now,updatedAt:now,...(extras.humanChoice?{assignee:'captain'}:{}),...extras});
    const outlines=source('outline_candidates','A/B/C 三版大纲');
    const report=source('content_review','已审正文');
    const outlineChoice=pending('outline_choice','用户确认大纲方向',['outline_candidates'],{humanChoice:{sourceTaskId:'outline_candidates',artifact:'outline-candidates.md',options:['A','B','C','A+C']}});
    const outlineFinal=pending('outline_final','按用户选择定稿 OUTLINE.md',['outline_candidates','outline_choice']);
    const release=pending('report_release','已审正文确认与点睛图启动门',['content_review'],{humanChoice:{sourceTaskId:'content_review',artifact:'report.md',options:['进入点睛图']}});
    const figures=pending('point_figures','制作点睛图',['report_release']);
    const renderer=pending('renderer','渲染 PDF',['point_figures']);
    const team={id:'stage4-gates-'+randomUUID().slice(0,8),name:'阶段4确认门浏览器夹具',captainSessionId:captain.id,createdAt:now,members:[],tasks:[outlines,outlineChoice,outlineFinal,report,release,figures,renderer],taskSeq:7,structuredQualityPolicy:{required:true,maxRepairRounds:2}};
    await createTeamDir(stateRoot,team);
    const outlineContent='# A\\n供给\\n# B\\n成交\\n# C\\n租赁';
    const reportContent='# 已审正文\\n真实全文预览验收。';
    const outlineSha=await reviewedSource(stateRoot,team,outlines,'outline-candidates.md',outlineContent);
    const reportSha=await reviewedSource(stateRoot,team,report,'report.md',reportContent);
    await writeTeam(stateRoot,team);
    result={teamId:team.id,captainSessionId:captain.id,outlineSha,reportSha,outlineContent,reportContent};
   }
   else if(action==='ui-prepare'){
    const id=query.get('sessionId');
    const captain=ctx.agents.list().find(agent=>agent.id===id&&agent.session.header.cwd===workspace);
    assert.ok(captain,'browser workspace session must be live');
    captain.followup(createUserMessage({content:[{type:'text',text:'隔离界面验收：查看待确认研究计划。'}],source:{kind:'user'}}));
    await captain.whenIdle();
    const draft=JSON.parse(await readFile(source,'utf8'));
    const profile=structuredClone(draft.profile);
    for(const member of profile.members)member.route={provider:'deep-research-smoke',model:'stub'};
    const staged=await call(captain,'plan_stage',{profile,report_outline:draft.report_outline,
      plan_models:{captain:{provider:'deep-research-smoke',model:'stub'}},team_name:'stage4-browser-'+randomUUID().slice(0,8)});
    assert.equal(staged.waitingFor,'user-confirmation');
    result={sessionId:captain.id,planId:staged.planId,digest:staged.digest,revision:staged.revision};
   }
   else if(action==='prepare'){
    const draft=JSON.parse(await readFile(source,'utf8'));
    const profile=structuredClone(draft.profile);
    for(const member of profile.members)member.route={provider:'deep-research-smoke',model:'stub'};
    const captain=await open('stage4-captain-'+randomUUID());
    captain.followup(createUserMessage({content:[{type:'text',text:'隔离预演：选择深度研究子图。'}],source:{kind:'user'}}));
    await captain.whenIdle();
    const staged=await call(captain,'plan_stage',{profile,report_outline:draft.report_outline,team_name:'stage4-selector-'+randomUUID().slice(0,8)});
    assert.equal(staged.waitingFor,'user-confirmation');
    await writeFile(file,JSON.stringify({captainId:captain.id,planId:staged.planId,digest:staged.digest,revision:staged.revision}));
    result={sessionId:captain.id,planId:staged.planId,digest:staged.digest,revision:staged.revision};
   }else if(action==='finish'){
    const staged=JSON.parse(await readFile(file,'utf8'));
    const captain=await open(staged.captainId,true);
    const endpoint='http://'+req.headers.host+'/plugins/dsh-expert-library/teams';
    const headers={'content-type':'application/json',cookie:req.headers.cookie??''};
    const catalogResponse=await fetch(endpoint+'?captainSessionId='+encodeURIComponent(captain.id)+'&planId='+encodeURIComponent(staged.planId)+'&models=1',{headers:{cookie:req.headers.cookie??''}});
    const catalogBody=await catalogResponse.json();
    assert.equal(catalogResponse.status,200,JSON.stringify(catalogBody));
    assert.ok(catalogBody.models.some(route=>route.provider==='deep-research-smoke'&&route.model==='stub'),JSON.stringify(catalogBody));
    const deniedCatalog=await fetch(endpoint+'?captainSessionId='+encodeURIComponent(captain.id)+'&planId='+encodeURIComponent(staged.planId)+'&models=1');
    assert.ok([401,403].includes(deniedCatalog.status),'model catalog must require signed Host session');
    const edit=async(digest,revision,choice)=>{const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({action:'edit',captainSessionId:captain.id,planId:staged.planId,expectedDigest:digest,expectedRevision:revision,patch:{research_selection:choice}})});return {status:response.status,body:await response.json()}};
    const first=await edit(staged.digest,staged.revision,{subDagId:'research-2',expertIds:['bk-024','bk-031']});
    assert.equal(first.status,200,JSON.stringify(first.body));
    assert.notEqual(first.body.plan.digest,staged.digest);
    assert.equal(first.body.plan.revision,staged.revision+1);
    assert.deepEqual(first.body.plan.preview.subDags.filter(row=>row.selected).map(row=>row.id),['research-2']);
    assert.equal(first.body.plan.preview.tasks.filter(task=>task.id.startsWith('expert_brief_')).length,2);
    const stale=await edit(staged.digest,staged.revision,{subDagId:'research-5',expertIds:['bk-024','bk-031','bk-010','bk-011','bk-025']});
    assert.equal(stale.status,409,'stale digest must fail');
    const invalid=await edit(first.body.plan.digest,first.body.plan.revision,{subDagId:'research-2',expertIds:['bk-024','bk-034']});
    assert.equal(invalid.status,400,'unrouted expert must fail');
    const last=await edit(first.body.plan.digest,first.body.plan.revision,{subDagId:'research-5',expertIds:['bk-024','bk-031','bk-010','bk-011','bk-025']});
    assert.equal(last.status,200,JSON.stringify(last.body));
    assert.equal(last.body.plan.preview.tasks.filter(task=>task.id.startsWith('expert_brief_')).length,5);
    assert.equal(last.body.plan.preview.tasks.filter(task=>task.id.startsWith('research_view_')).length,3);
    assert.ok(last.body.plan.preview.tasks.every(task=>task.id==='outline_choice'||task.id==='report_release'||task.taskMaterials?.digest));
    const material=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({action:'edit',captainSessionId:captain.id,planId:staged.planId,expectedDigest:last.body.plan.digest,expectedRevision:last.body.plan.revision,patch:{research_material_selection:[{taskId:'research_main',recipeId:'strategy'}]}})});
    const materialBody=await material.json();
    assert.equal(material.status,200,JSON.stringify(materialBody));
    assert.notEqual(materialBody.plan.digest,last.body.plan.digest);
    assert.equal(materialBody.plan.preview.tasks.find(task=>task.id==='research_main').materialRecipe.selected,'strategy');
    assert.ok(materialBody.plan.preview.tasks.find(task=>task.id==='research_main').taskMaterials.skills.some(skill=>skill.skillId==='strategy-consulting'));
    const badMaterial=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({action:'edit',captainSessionId:captain.id,planId:staged.planId,expectedDigest:materialBody.plan.digest,expectedRevision:materialBody.plan.revision,patch:{research_material_selection:[{taskId:'renderer',recipeId:'strategy'}]}})});
    assert.equal(badMaterial.status,400);
    const reread=await fetch(endpoint+'?captainSessionId='+encodeURIComponent(captain.id)+'&planId='+encodeURIComponent(staged.planId),{headers:{cookie:req.headers.cookie??''}}).then(response=>response.json());
    assert.equal(reread.plan.digest,materialBody.plan.digest);
    result={status:'PASS',modelCatalog:catalogBody.models.filter(route=>route.provider==='deep-research-smoke'),firstDigest:first.body.plan.digest,lastDigest:materialBody.plan.digest,revisions:[first.body.plan.revision,last.body.plan.revision,materialBody.plan.revision],staleRejected:stale.status===409,invalidExpertRejected:invalid.status===400,invalidMaterialRejected:badMaterial.status===400,expertCount:5,taskCount:last.body.plan.preview.tasks.length};
   }else{res.writeHead(400);res.end();return}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error.stack??error)}))}
 }}));
}
` }

runTeamCommunicationHostSmoke({probePlugin,kind:'deep-research-dag-v3-stage4-selector',preserveFailure:true,disableHostModels:true,probeTimeoutMs:120_000,afterRestartReady:browserReview,
  limitations:['Isolated DSH Host with a deterministic local model; production Web login and business content are outside this protocol test.']})
  .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'))
  .catch(error=>{process.stderr.write(String(error.message??error)+'\n');process.exitCode=1})
