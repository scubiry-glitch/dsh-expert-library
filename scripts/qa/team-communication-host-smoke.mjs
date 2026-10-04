/**
 * Boot the real DSH Host in an isolated profile, call its loaded Expert Teams
 * definitions through a scratch-only HTTP probe, restart, and finish a durable
 * review/repair/integration cycle. This is NOT an LLM or subagent transport test.
 * No production profile, conversation, business API or credential is used.
 * Run after the candidate build: node scripts/qa/team-communication-host-smoke.mjs
 * Success prints a JSON receipt; startup progress and safe errors use stderr.
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { hashContentDirectory } from '../../packages/pack-contract/index.mjs'

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../..', import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

async function runtimeIdentity() {
  const paths = ['package.json', 'packages/pack-contract/index.mjs', 'packages/pack-artifact/index.mjs']
  const visit = async relative => {
    for (const entry of await readdir(join(REPO, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /\.(?:js|mjs|cjs|json)$/.test(entry.name)) paths.push(path)
    }
  }
  await visit('lib')
  const manifest = []
  for (const path of paths.sort()) {
    const bytes = await readFile(join(REPO, path))
    manifest.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) })
  }
  const criticalPaths = new Set(['lib/index.js', 'lib/tools.js', 'lib/scheduler.js', 'lib/members.js', 'lib/mailbox-delivery.js', 'lib/state.js', 'lib/quality-run.js', 'lib/quality-runtime.js', 'lib/team-core.js', 'lib/types.js'])
  return {
    sha256: sha256(JSON.stringify(manifest)), fileCount: manifest.length,
    criticalModules: Object.fromEntries(manifest.filter(item => criticalPaths.has(item.path)).map(item => [item.path, item.sha256])),
  }
}

/** Shared QA identity; the package metadata file is top-level, not {pack:...}. */
export async function domainPackIdentityAt(packRoot) {
  const tree = await hashContentDirectory(packRoot)
  const metadata = JSON.parse(await readFile(join(packRoot, 'pack.json'), 'utf8'))
  assert.equal(metadata.id, 'zhijian-realestate')
  assert.equal(metadata.schemaVersion, 2)
  assert.equal(typeof metadata.version, 'string')
  assert.ok(metadata.version.length > 0)
  return { packId: metadata.id, version: metadata.version, contentTreeSha256: tree.contentTreeSha256, fileCount: tree.fileCount, sizeBytes: tree.sizeBytes }
}

function probePlugin(workspace, nonce, domainPackIdentity) {
  return `
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createQualityContract, createQualityRun, REPORT_CRAFT_V2_CHECKER_VERSION } from ${JSON.stringify(pathToFileURL(join(REPO, 'lib/quality-run.js')).href)};
import { createCraftFixture } from ${JSON.stringify(pathToFileURL(join(REPO, 'test/support/report-craft-fixture.mjs')).href)};
import { createCraftV2Fixture } from ${JSON.stringify(pathToFileURL(join(REPO, 'test/support/report-craft-v2-fixture.mjs')).href)};
import { createCraftV3Fixture } from ${JSON.stringify(pathToFileURL(join(REPO, 'test/support/report-craft-v3-fixture.mjs')).href)};
import { reportArtifactCheck, reportCheckDeliverables } from ${JSON.stringify(pathToFileURL(join(REPO, 'lib/report-bundle.js')).href)};
import { craftSessionContext } from ${JSON.stringify(pathToFileURL(join(REPO, 'lib/report-craft-delivery.js')).href)};
import { resolveSelectedSkillContract } from ${JSON.stringify(pathToFileURL(join(REPO, 'lib/skill-craft.js')).href)};
import { createHash } from 'node:crypto';
export const name = 'team-communication-host-probe';
export const inject = ['tools', 'webServer'];
const workspace = ${JSON.stringify(workspace)};
const expectedDomainPack = ${JSON.stringify(domainPackIdentity)};
const root = join(workspace, 'expert-teams', 'host-smoke');
const relative = 'host-smoke/expert-tasks/t1';
const project = { path:'expert-tasks/t1', inputPath:'expert-tasks/t1/input/task.json', outputPath:'expert-tasks/t1/output/result.json', artifactsPath:'expert-tasks/t1/artifacts', version:1 };
const participant = name => ({ id: name + '-smoke-id', status:'idle', session:{header:{cwd:workspace}, events:[], append(){}, steer(){} } });
const state = async () => JSON.parse(await readFile(join(root,'team.json'),'utf8'));
export function apply(ctx) {
  const server = ctx.get('webServer') ?? ctx.get('httpServer');
  if (!server) throw new Error('SMOKE_WEB_SERVER_MISSING');
  const tool = name => { const value = ctx.tools.get('expert_teams_' + name); assert.ok(value, 'missing tool: ' + name); return value; };
  const call = async (name,args,who='captain') => {
    const agent = participant(who);
    return tool(name).execute(args,{agent,session:agent.session,signal:new AbortController().signal});
  };
  const review = async (event,verdict) => {
    const current = await state();
    return call('quality_review',{
      task_id:'t1',event_id:event,reviewer:'reviewer',verdict,
      acceptance_results:[{id:'present',passed:true}],changed_paths:current.qualityRuns.t1.contract.changedPaths,
      findings:verdict==='pass'?[]:[{id:'correction',code:'correct-data',severity:'hard',message:'Correct the fixture data',taskId:'t1',attempt:current.tasks[0].attempt}],
    },'reviewer');
  };
  const publishCraft = async (good) => {
    const fixture=createCraftFixture(good?{}:{md:'# Incomplete report\\nNo closing or source disclosure.',html:'<html><body><h1>Incomplete report</h1></body></html>',pdfOptions:{missingFooter:true}});
    const current=await state();
    for(const [name,content,media] of [['report.md',fixture.md,'text/markdown'],['report.html',fixture.html,'text/html'],['report.pdf',fixture.pdf,'application/pdf']]) {
      await writeFile(join(root,project.artifactsPath,name),content);
      await call('publish_artifact',{task_id:'t1',attempt_id:current.tasks[0].attemptId,source_path:'artifacts/'+name,name,media_type:media});
    }
  };
  const v2Root=join(workspace,'expert-teams','host-smoke-v2');
  const v2State=async()=>JSON.parse(await readFile(join(v2Root,'team.json'),'utf8'));
  const v2Call=(name,args,who='captain')=>call(name,args,'v2-'+who);
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const v2ReviewArgs=(receipt,event='host-v2-review')=>({task_id:'t1',event_id:event,reviewer:'reviewer',verdict:'pass',material_receipt:receipt,
    acceptance_results:[{id:'present',passed:true,detail:'Synthetic fixed report inspected by deterministic isolated QA; no business correctness claim.'}],
    independent_review:['chapter-substance','facts-and-uncertainty','calculations-and-coverage','visual-and-format'].map(id=>({id,status:'passed',coverage:'Synthetic current report text and declared bounded Host checks.',
      evidence:[{artifactId:'published:report.md',quote:'此例为合成测试，不是用户事实。',reason:'Deterministic protocol-test citation for '+id+'; this is not a model or business expert judgment.'}]}))});
  const prepareV2=async()=>{
    for(const dir of ['input','output','artifacts'])await mkdir(join(v2Root,project.path,dir),{recursive:true});
    const bundle={md:'report.md',html:'report.html',pdf:'report.pdf',craft:{version:2,style:'credit-policy',evidence:'craft-evidence.json'}};
    const check=reportArtifactCheck(bundle),relative='host-smoke-v2/expert-tasks/t1';
    const contract=createQualityContract({id:'host-v2-contract',taskId:'t1',attempt:1,assignee:'captain',kind:'implementation',objective:'Verify v2 report admission through loaded Host tools',inScope:[relative+'/**'],acceptance:[{id:'present',statement:'Synthetic current report independently inspected'}],verify:['node --version'],deliverables:['task-output',...reportCheckDeliverables(check)],changedPaths:[relative+'/output/result.json',relative+'/artifacts/**'],maxRepairRounds:2,artifactChecks:[check]});
    const run=createQualityRun(contract,'host-v2-run');
    const task={id:'t1',subject:'Synthetic report v2',status:'in_progress',assignee:'captain',dependencies:[],attempt:1,attemptId:'host-v2-attempt-1',output:'Ready',createdAt:1,updatedAt:1,project,reportBundle:bundle};
    await writeFile(join(v2Root,'team.json'),JSON.stringify({id:'host-smoke-v2',name:'host-smoke-v2',captainSessionId:'v2-captain-smoke-id',createdAt:1,members:[{id:'v2-reviewer-smoke-id',name:'reviewer',status:'idle',joinedAt:1}],tasks:[task],taskSeq:1,structuredQualityPolicy:{required:true,maxRepairRounds:2},qualityRun:run,qualityRuns:{t1:run}}));
    await writeFile(join(v2Root,project.inputPath),JSON.stringify({taskId:'t1'}));
    await writeFile(join(v2Root,project.outputPath),JSON.stringify({taskId:'t1',status:'in_progress',attempt:1,output:'Ready'}));
    const fixture=createCraftV2Fixture();
    await writeFile(join(v2Root,project.artifactsPath,'report.md'),fixture.md);
    await assert.rejects(v2Call('publish_artifact',{task_id:'t1',attempt_id:task.attemptId,source_path:'artifacts/report.md',name:'report.md'}),/CRAFT_MATERIALS_NOT_DELIVERED/);
    const claimed=await v2Call('claim_task',{task_id:'t1'});
    assert.ok(claimed.craft_materials.includes('Host report craft materials'));
    assert.deepEqual((await v2State()).tasks[0].craftDeliveries.map(r=>r.role),['writer','renderer']);
    for(const [name,bytes,media]of[['report.md',fixture.md,'text/markdown'],['report.html',fixture.html,'text/html'],['report.pdf',fixture.pdf,'application/pdf'],['craft-evidence.json',fixture.craftEvidence,'application/json']]){
      await writeFile(join(v2Root,project.artifactsPath,name),bytes);
      await v2Call('publish_artifact',{task_id:'t1',attempt_id:task.attemptId,source_path:'artifacts/'+name,name,media_type:media});
    }
    await v2Call('update_task',{task_id:'t1',execution_state:'awaiting_review',wait_reason:'Synthetic v2 independent review'});
    await assert.rejects(v2Call('quality_review',v2ReviewArgs('not-issued'),'reviewer'),/CRAFT_REVIEW_PREPARATION_REQUIRED/);
    const prep=await v2Call('quality_review',{task_id:'t1',reviewer:'reviewer',prepare_only:true},'reviewer');
    assert.equal(prep.status,'prepared_for_independent_review');assert.ok(prep.craft_materials.includes('Host report craft materials'));
    assert.equal(prep.machine_checks.length,1);const machine=prep.machine_checks[0];
    assert.equal(machine.version,2);assert.equal(machine.checkerVersion,REPORT_CRAFT_V2_CHECKER_VERSION);assert.equal(machine.materialDigest,check.materialDigest);
    assert.equal(machine.results.length,7);assert.ok(machine.results.every(r=>r.status==='passed'),JSON.stringify(machine.results));
    assert.equal(machine.artifacts.length,4);
    const browserEvidence=JSON.parse(machine.results.find(r=>r.id==='report-craft-browser').detail);
    assert.equal(browserEvidence.screenshots.length,2);
    for(const screenshot of browserEvidence.screenshots){
      assert.ok(screenshot.path.startsWith('/root/.cache/dsh-report-craft/evidence/'));
      assert.match(screenshot.coverage,/initial viewport only/);
      assert.equal(digest(await readFile(screenshot.path)),screenshot.viewportScreenshotSha256);
      assert.equal(screenshot.htmlSha256,machine.artifacts.find(a=>a.id==='published:report.html').sha256);
    }
    await assert.rejects(v2Call('quality_review',v2ReviewArgs('forged-after-preparation'),'reviewer'),/CRAFT_REVIEW_PREPARATION_REQUIRED/);
    await assert.rejects(v2Call('quality_review',{...v2ReviewArgs(prep.material_receipt),independent_review:[]},'reviewer'),/independent|review/i);
    assert.ok(!('artifact_check_receipts' in tool('quality_review').parameters.properties));
    assert.ok(!('artifactCheckReceipts' in tool('quality_review').parameters.properties));
    await v2Call('quality_review',v2ReviewArgs(prep.material_receipt),'reviewer');
    const passed=await v2State();assert.equal(passed.qualityRuns.t1.status,'passed');
    assert.equal(passed.qualityRuns.t1.latestEvidence.independentReview.areas.length,4);
    const writerContext=craftSessionContext(join(workspace,'expert-teams'),'v2-captain-smoke-id');
    const reviewerContext=craftSessionContext(join(workspace,'expert-teams'),'v2-reviewer-smoke-id');
    assert.equal(writerContext,claimed.craft_materials);assert.equal(reviewerContext,prep.craft_materials);
    const proof={materialPackId:check.materialPackId,materialDigest:check.materialDigest,style:check.style,checkerVersion:machine.checkerVersion,writerContextSha256:digest(writerContext),reviewerContextSha256:digest(reviewerContext),machineReceipt:passed.qualityRuns.t1.latestEvidence.artifactCheckReceipts[0],materialReceipt:prep.material_receipt,producerRoles:passed.tasks[0].craftDeliveries.filter(r=>r.role!=='reviewer').map(r=>({role:r.role,sessionId:r.sessionId,accepted:r.accepted,materialDigest:r.materialDigest,contentSha256:r.contentSha256})),independentReviewAreas:passed.qualityRuns.t1.latestEvidence.independentReview.areas.map(a=>a.id)};
    await writeFile(join(v2Root,'qa-v2-proof.json'),JSON.stringify(proof));
    return {prepared:true,currentShaPassed:true,publishBeforeMaterialDeliveryRejected:true,missingPreparationRejected:true,forgedMaterialReceiptRejected:true,missingIndependentReviewRejected:true,callerCannotSupplyMachineReceipt:true,...proof};
  };
  const finishV2=async()=>{
    const before=await v2State(),proof=JSON.parse(await readFile(join(v2Root,'qa-v2-proof.json'),'utf8'));
    assert.equal(before.qualityRuns.t1.status,'passed');
    assert.equal(digest(craftSessionContext(join(workspace,'expert-teams'),'v2-captain-smoke-id')),proof.writerContextSha256);
    assert.equal(digest(craftSessionContext(join(workspace,'expert-teams'),'v2-reviewer-smoke-id')),proof.reviewerContextSha256);
    assert.equal(craftSessionContext(join(workspace,'expert-teams'),'unrelated-v2-session'),'');
    assert.deepEqual(before.qualityRuns.t1.latestEvidence.artifactCheckReceipts[0],proof.machineReceipt);
    const browserEvidence=JSON.parse(proof.machineReceipt.results.find(r=>r.id==='report-craft-browser').detail);
    for(const screenshot of browserEvidence.screenshots)assert.equal(digest(await readFile(screenshot.path)),screenshot.viewportScreenshotSha256);
    await v2Call('quality_review',v2ReviewArgs(proof.materialReceipt),'reviewer');
    assert.equal((await v2State()).qualityRuns.t1.reviewRounds,1,'cold exact replay must not add a review');
    await v2Call('quality_integrate',{task_id:'t1',event_id:'host-v2-integrate',actor:'captain',complete_task:true});
    const done=await v2State();assert.equal(done.tasks[0].status,'completed');assert.equal(done.qualityRuns.t1.status,'integrated');
    const publication=done.tasks[0].publishedArtifacts.find(a=>a.reviewId==='published:report.md');
    const versionPath=join(v2Root,project.artifactsPath,publication.relativePath),original=await readFile(versionPath);
    await writeFile(versionPath,Buffer.concat([original,Buffer.from('\\nUnreviewed synthetic modification')]));
    await assert.rejects(v2Call('quality_integrate',{task_id:'t1',event_id:'host-v2-integrate',actor:'captain',complete_task:true}),/hash|changed|mismatch|current/i);
    assert.deepEqual(await v2State(),done,'rejected post-review tamper must not mutate durable quality state');
    await writeFile(versionPath,original);
    return {coldRecovered:true,retainedScreenshotsVerifiedAfterRestart:true,completeMaterialsReassembledFromDurableReceipts:true,coldExactReviewReplay:true,task:'completed',quality:'integrated',postReviewByteTamperRejected:true,syntheticTamperBytesRestored:true,...proof};
  };
  const v3Root=join(workspace,'expert-teams','host-smoke-v3');
  const v3State=async()=>JSON.parse(await readFile(join(v3Root,'team.json'),'utf8'));
  const v3Call=(name,args,who='captain')=>call(name,args,'v3-'+who);
  let v3ReviewAreaIds=[];
  const v3ReviewArgs=(receipt,event='host-v3-review')=>({task_id:'t1',event_id:event,reviewer:'reviewer',verdict:'pass',material_receipt:receipt,
    acceptance_results:[{id:'present',passed:true,detail:'Synthetic fixed report inspected by deterministic isolated QA; no business correctness claim.'}],
    independent_review:v3ReviewAreaIds.map(id=>({id,status:'passed',coverage:'Synthetic current report text and declared bounded Host checks.',
      evidence:[{artifactId:'published:report.md',quote:'此例为合成测试，不是用户事实。',reason:'Deterministic protocol-test citation for '+id+'; this is not a model or business expert judgment.'}]}))});
  const prepareV3=async()=>{
    for(const dir of ['input','output','artifacts'])await mkdir(join(v3Root,project.path,dir),{recursive:true});
    const selections=[{packId:'zhijian-realestate',skillId:'zhijian-report-craft',reason:'Explicit synthetic report content policy'}, {packId:'zhijian-realestate',skillId:'zhijian-designer-render',variant:'credit-policy',reason:'Explicit synthetic report rendering policy'}];
    const selection=await resolveSelectedSkillContract(ctx,{packsDir:'domain-packs',enabledPacks:['zhijian-realestate']},workspace,selections);
    assert.equal(selection.packs.length,1);assert.equal(selection.packs[0].root,join(workspace,'domain-packs','zhijian-realestate'));
    assert.equal(selection.packs[0].treeDigest,expectedDomainPack.contentTreeSha256);assert.equal(selection.packs[0].version,expectedDomainPack.version);
    assert.deepEqual(selection.artifactRoles,['md','html','pdf','evidence']);assert.equal(selection.checks.length,2);
    v3ReviewAreaIds=selection.reviewAreas.map(area=>area.id);
    const bundle={md:'report.md',html:'report.html',pdf:'report.pdf',craft:{version:3,selections,evidence:'craft-evidence.json'}};
    const check=reportArtifactCheck(bundle,selection),relative='host-smoke-v3/expert-tasks/t1';
    const contract=createQualityContract({id:'host-v3-contract',taskId:'t1',attempt:1,assignee:'captain',kind:'implementation',objective:'Verify v3 report admission through loaded Host tools',inScope:[relative+'/**'],acceptance:[{id:'present',statement:'Synthetic current report independently inspected'}],verify:['node --version'],deliverables:['task-output',...reportCheckDeliverables(check)],changedPaths:[relative+'/output/result.json',relative+'/artifacts/**'],maxRepairRounds:2,artifactChecks:[check]});
    const run=createQualityRun(contract,'host-v3-run');
    const task={id:'t1',subject:'Synthetic report v3',status:'in_progress',assignee:'captain',dependencies:[],attempt:1,attemptId:'host-v3-attempt-1',output:'Ready',createdAt:1,updatedAt:1,project,reportBundle:bundle,frozenSkillCraftContract:selection};
    await writeFile(join(v3Root,'team.json'),JSON.stringify({id:'host-smoke-v3',name:'host-smoke-v3',captainSessionId:'v3-captain-smoke-id',createdAt:1,members:[{id:'v3-reviewer-smoke-id',name:'reviewer',status:'idle',joinedAt:1}],tasks:[task],taskSeq:1,structuredQualityPolicy:{required:true,maxRepairRounds:2},qualityRun:run,qualityRuns:{t1:run}}));
    await writeFile(join(v3Root,project.inputPath),JSON.stringify({taskId:'t1'}));
    await writeFile(join(v3Root,project.outputPath),JSON.stringify({taskId:'t1',status:'in_progress',attempt:1,output:'Ready'}));
    const fixture=createCraftV3Fixture();
    await writeFile(join(v3Root,project.artifactsPath,'report.md'),fixture.md);
    await assert.rejects(v3Call('publish_artifact',{task_id:'t1',attempt_id:task.attemptId,source_path:'artifacts/report.md',name:'report.md'}),/CRAFT_MATERIALS_NOT_DELIVERED/);
    const claimed=await v3Call('claim_task',{task_id:'t1'});
    assert.ok(claimed.craft_materials.includes('Host report craft materials'));
    assert.deepEqual((await v3State()).tasks[0].craftDeliveries.map(r=>r.role),['writer','renderer']);
    for(const [name,bytes,media]of[['report.md',fixture.md,'text/markdown'],['report.html',fixture.html,'text/html'],['report.pdf',fixture.pdf,'application/pdf'],['craft-evidence.json',fixture.craftEvidence,'application/json']]){
      await writeFile(join(v3Root,project.artifactsPath,name),bytes);
      await v3Call('publish_artifact',{task_id:'t1',attempt_id:task.attemptId,source_path:'artifacts/'+name,name,media_type:media});
    }
    await v3Call('update_task',{task_id:'t1',execution_state:'awaiting_review',wait_reason:'Synthetic v3 independent review'});
    await assert.rejects(v3Call('quality_review',v3ReviewArgs('not-issued'),'reviewer'),/CRAFT_REVIEW_PREPARATION_REQUIRED/);
    const prep=await v3Call('quality_review',{task_id:'t1',reviewer:'reviewer',prepare_only:true},'reviewer');
    assert.equal(prep.status,'prepared_for_independent_review');assert.ok(prep.craft_materials.includes('Host report craft materials'));
    assert.equal(prep.machine_checks.length,1);const machine=prep.machine_checks[0];
    assert.equal(machine.version,3);assert.equal(machine.selectionDigest,selection.digest);assert.equal(machine.materialDigest,undefined);
    assert.deepEqual(machine.checkers,selection.checks.map(({packId,id,version,sha256,resultIds})=>({packId,id,version,sha256,resultIds})));
    assert.deepEqual(machine.results.map(r=>r.id),selection.checks.flatMap(c=>c.resultIds));assert.ok(machine.results.every(r=>r.status==='passed'),JSON.stringify(machine.results));
    assert.equal(machine.artifacts.length,4);
    const browserEvidence=JSON.parse(machine.results.find(r=>r.id==='report-craft-browser').detail);
    assert.equal(browserEvidence.screenshots.length,2);
    for(const screenshot of browserEvidence.screenshots){
      assert.ok(screenshot.path.startsWith('/root/.cache/dsh-report-craft/evidence/'));
      assert.match(screenshot.coverage,/initial viewport only/);
      assert.equal(digest(await readFile(screenshot.path)),screenshot.viewportScreenshotSha256);
      assert.equal(screenshot.htmlSha256,machine.artifacts.find(a=>a.id==='published:report.html').sha256);
    }
    await assert.rejects(v3Call('quality_review',v3ReviewArgs('forged-after-preparation'),'reviewer'),/CRAFT_REVIEW_PREPARATION_REQUIRED/);
    await assert.rejects(v3Call('quality_review',{...v3ReviewArgs(prep.material_receipt),independent_review:[]},'reviewer'),/independent|review/i);
    assert.ok(!('artifact_check_receipts' in tool('quality_review').parameters.properties));
    assert.ok(!('artifactCheckReceipts' in tool('quality_review').parameters.properties));
    await v3Call('quality_review',v3ReviewArgs(prep.material_receipt),'reviewer');
    const passed=await v3State();assert.equal(passed.qualityRuns.t1.status,'passed');
    assert.deepEqual(passed.qualityRuns.t1.latestEvidence.independentReview.areas.map(a=>a.id),v3ReviewAreaIds);
    const writerContext=craftSessionContext(join(workspace,'expert-teams'),'v3-captain-smoke-id');
    const reviewerContext=craftSessionContext(join(workspace,'expert-teams'),'v3-reviewer-smoke-id');
    assert.equal(writerContext,claimed.craft_materials);assert.equal(reviewerContext,prep.craft_materials);
    const proof={selectionDigest:selection.digest,selectedSkills:selection.selections,installedPacks:selection.packs,artifactRoles:selection.artifactRoles,declaredReviewAreas:selection.reviewAreas,declaredCheckers:machine.checkers,writerContextSha256:digest(writerContext),reviewerContextSha256:digest(reviewerContext),machineReceipt:passed.qualityRuns.t1.latestEvidence.artifactCheckReceipts[0],materialReceipt:prep.material_receipt,producerRoles:passed.tasks[0].craftDeliveries.filter(r=>r.role!=='reviewer').map(r=>({role:r.role,sessionId:r.sessionId,accepted:r.accepted,selectionDigest:r.selectionDigest,contentSha256:r.contentSha256})),independentReviewAreas:passed.qualityRuns.t1.latestEvidence.independentReview.areas.map(a=>a.id)};
    await writeFile(join(v3Root,'qa-v3-proof.json'),JSON.stringify(proof));
    return {prepared:true,currentShaPassed:true,publishBeforeMaterialDeliveryRejected:true,missingPreparationRejected:true,forgedMaterialReceiptRejected:true,missingIndependentReviewRejected:true,callerCannotSupplyMachineReceipt:true,...proof};
  };
  const finishV3=async()=>{
    const before=await v3State(),proof=JSON.parse(await readFile(join(v3Root,'qa-v3-proof.json'),'utf8'));
    assert.equal(before.qualityRuns.t1.status,'passed');
    v3ReviewAreaIds=before.qualityRuns.t1.contract.artifactChecks[0].selection.reviewAreas.map(area=>area.id);
    assert.equal(digest(craftSessionContext(join(workspace,'expert-teams'),'v3-captain-smoke-id')),proof.writerContextSha256);
    assert.equal(digest(craftSessionContext(join(workspace,'expert-teams'),'v3-reviewer-smoke-id')),proof.reviewerContextSha256);
    assert.equal(craftSessionContext(join(workspace,'expert-teams'),'unrelated-v3-session'),'');
    assert.deepEqual(before.qualityRuns.t1.latestEvidence.artifactCheckReceipts[0],proof.machineReceipt);
    const browserEvidence=JSON.parse(proof.machineReceipt.results.find(r=>r.id==='report-craft-browser').detail);
    for(const screenshot of browserEvidence.screenshots)assert.equal(digest(await readFile(screenshot.path)),screenshot.viewportScreenshotSha256);
    await v3Call('quality_review',v3ReviewArgs(proof.materialReceipt),'reviewer');
    assert.equal((await v3State()).qualityRuns.t1.reviewRounds,1,'cold exact replay must not add a review');
    // Mutate only the disposable installed pack; frozen identity must fail closed.
    const beforeVersionDrift=await v3State();
    const packPath=join(workspace,'domain-packs','zhijian-realestate','pack.json'),packBytes=await readFile(packPath);
    const changedPack=JSON.parse(packBytes);changedPack.version='99.0.0';
    await writeFile(packPath,JSON.stringify(changedPack));
    try { await assert.rejects(v3Call('quality_integrate',{task_id:'t1',event_id:'host-v3-integrate',actor:'captain',complete_task:true}),/SKILL_CRAFT|DRIFT|identity|changed/i); }
    finally { await writeFile(packPath,packBytes); }
    assert.deepEqual(await v3State(),beforeVersionDrift,'rejected installed version drift must not mutate durable quality');
    await v3Call('quality_integrate',{task_id:'t1',event_id:'host-v3-integrate',actor:'captain',complete_task:true});
    const done=await v3State();assert.equal(done.tasks[0].status,'completed');assert.equal(done.qualityRuns.t1.status,'integrated');
    const publication=done.tasks[0].publishedArtifacts.find(a=>a.reviewId==='published:report.md');
    const versionPath=join(v3Root,project.artifactsPath,publication.relativePath),original=await readFile(versionPath);
    await writeFile(versionPath,Buffer.concat([original,Buffer.from('\\nUnreviewed synthetic modification')]));
    await assert.rejects(v3Call('quality_integrate',{task_id:'t1',event_id:'host-v3-integrate',actor:'captain',complete_task:true}),/hash|changed|mismatch|current/i);
    assert.deepEqual(await v3State(),done,'rejected post-review tamper must not mutate durable quality state');
    await writeFile(versionPath,original);
    return {coldRecovered:true,frozenInstalledVersionDriftRejected:true,installedVersionBytesRestored:true,retainedScreenshotsVerifiedAfterRestart:true,completeMaterialsReassembledFromDurableReceipts:true,coldExactReviewReplay:true,task:'completed',quality:'integrated',postReviewByteTamperRejected:true,syntheticTamperBytesRestored:true,...proof};
  };
  ctx.effect(() => server.register({kind:'exact',path:'/plugins/team-communication-host-smoke',handler:async(req,res)=>{
    if(req.headers['x-smoke-nonce']!==${JSON.stringify(nonce)}){res.writeHead(403);res.end();return;}
    try {
      const action = new URL(req.url,'http://localhost').searchParams.get('action');
      let result;
      if(action==='schema') {
        const update=tool('update_task').parameters;
        const integrate=tool('quality_integrate').parameters;
        const reopen=tool('quality_reopen').parameters;
        assert.ok(update.properties.execution_state);
        assert.ok(update.properties.wait_reason);
        assert.ok(integrate.properties.complete_task);
        assert.ok(reopen.properties.reason);
        assert.ok(!(tool('quality_review').parameters.required??[]).includes('artifacts'));
        assert.ok(!('artifactCheckReceipts' in tool('quality_review').parameters.properties));
        assert.ok(!('artifact_check_receipts' in tool('quality_review').parameters.properties));
        tool('publish_artifact');tool('read_artifact');
        result={schema:true,execution_states:update.properties.execution_state.enum,complete_task:true,quality_reopen:true,automatic_published_evidence:true};
      } else if(action==='craft-v3-prepare' && req.method==='POST') {
        result=await prepareV3();
      } else if(action==='craft-v3-finish' && req.method==='POST') {
        result=await finishV3();
      } else if(action==='craft-v2-prepare' && req.method==='POST') {
        result=await prepareV2();
      } else if(action==='craft-v2-finish' && req.method==='POST') {
        result=await finishV2();
      } else if(action==='prepare' && req.method==='POST') {
        for(const dir of ['input','output','artifacts']) await mkdir(join(root,project.path,dir),{recursive:true});
        const contract=createQualityContract({id:'host-smoke-contract',taskId:'t1',attempt:1,assignee:'captain',kind:'implementation',objective:'Verify host continuation',inScope:[relative+'/**'],acceptance:[{id:'present',statement:'Local fixture is independently reviewed'}],verify:['node --version'],deliverables:['task-output','published:report.md','published:report.html','published:report.pdf'],changedPaths:[relative+'/output/result.json',relative+'/artifacts/**'],maxRepairRounds:2,artifactChecks:[{id:'zhijian-report-craft-core-v1',md:'published:report.md',html:'published:report.html',pdf:'published:report.pdf'}]});
        const run=createQualityRun(contract,'host-smoke-run');
        const task={id:'t1',subject:'Host continuation',status:'in_progress',assignee:'captain',dependencies:[],attempt:1,attemptId:'host-attempt-1',output:'Ready',createdAt:1,updatedAt:1,project,reportBundle:{md:'report.md',html:'report.html',pdf:'report.pdf'}};
        await writeFile(join(root,'team.json'),JSON.stringify({id:'host-smoke',name:'host-smoke',captainSessionId:'captain-smoke-id',createdAt:1,members:[{id:'reviewer-smoke-id',name:'reviewer',status:'idle',joinedAt:1}],tasks:[task],taskSeq:1,qualityRun:run,qualityRuns:{t1:run}}));
        await writeFile(join(root,project.inputPath),JSON.stringify({taskId:'t1'}));
        await writeFile(join(root,project.outputPath),JSON.stringify({taskId:'t1',status:'in_progress',attempt:1,output:'Ready'}));
        await writeFile(join(root,project.artifactsPath,'report.txt'),'fixture-v1');
        await call('publish_artifact',{task_id:'t1',attempt_id:'host-attempt-1',source_path:'artifacts/report.txt',name:'report.txt',media_type:'text/plain'});
        await publishCraft(false);
        await call('update_task',{task_id:'t1',execution_state:'awaiting_review',wait_reason:'Await independent review'});
        const current=await state();assert.equal(current.tasks[0].executionState,'awaiting_review');
        result={prepared:true,task:current.tasks[0].status,executionState:current.tasks[0].executionState,attempt:current.tasks[0].attempt};
      } else if(action==='finish' && req.method==='POST') {
        const recovered=await state();assert.equal(recovered.tasks[0].executionState,'awaiting_review');assert.equal(recovered.tasks[0].attempt,1);
        await assert.rejects(review('host-craft-false-pass','pass'),/Host artifact checks did not pass/);
        assert.deepEqual(await state(),recovered,'a false pass changed state');
        await assert.rejects(call('quality_integrate',{task_id:'t1',event_id:'host-craft-premature-integrate',actor:'captain',complete_task:false}),/passed review/);
        assert.deepEqual(await state(),recovered,'complete_task=false bypassed report checks');
        await review('host-review-reject','needs_revision');
        const negative=await state();
        const negativeReceipt=negative.qualityRuns.t1.latestEvidence.artifactCheckReceipts[0];
        assert.equal(negativeReceipt.attempt,1);
        assert.equal(negativeReceipt.results.length,3);
        assert.ok(negativeReceipt.results.every(check=>check.status==='failed'));
        await call('quality_repair',{task_id:'t1',event_id:'host-repair',actor:'captain'});
        await call('claim_task',{task_id:'t1'});
        const beforePremature=await state();
        await assert.rejects(call('update_task',{task_id:'t1',status:'in_progress',output:'premature',execution_state:'awaiting_review',wait_reason:'missing publication'}),/REVIEW_SUBMISSION_INCOMPLETE/);
        assert.deepEqual(await state(),beforePremature,'premature submission mutated durable state');
        await writeFile(join(root,project.artifactsPath,'report.txt'),'fixture-v2-corrected');
        const repaired=await state();
        await call('publish_artifact',{task_id:'t1',attempt_id:repaired.tasks[0].attemptId,source_path:'artifacts/report.txt',name:'report.txt',media_type:'text/plain'});
        await publishCraft(true);
        await call('update_task',{task_id:'t1',status:'in_progress',output:'Corrected fixture',execution_state:'awaiting_review',wait_reason:'Review corrected fixture'});
        const beforeWithdrawal=await state();
        await call('quality_reopen',{task_id:'t1',event_id:'host-withdraw-unreviewed',reason:'Finish checking the unreviewed publication'});
        const withdrawn=await state();
        assert.notEqual(withdrawn.qualityRuns.t1.runId,beforeWithdrawal.qualityRuns.t1.runId);
        assert.equal(withdrawn.tasks[0].attemptId,beforeWithdrawal.tasks[0].attemptId);
        assert.equal(withdrawn.tasks[0].executionState,'active');
        assert.equal(withdrawn.qualityRuns.t1.contract.maxRepairRounds,1);
        assert.equal(withdrawn.qualityRuns.t1.revision.budgetCharged,1);
        assert.equal(withdrawn.qualityRuns.t1.contractFrozenAt,beforeWithdrawal.qualityRuns.t1.contractFrozenAt);
        const archivedRepair=withdrawn.qualityRunHistory.t1[0];
        assert.equal(archivedRepair.reviewRounds,1);
        assert.equal(archivedRepair.repairRounds,1);
        assert.equal(archivedRepair.latestEvidence.attempt,1);
        assert.ok(archivedRepair.findings.some(f=>f.code==='correct-data'&&f.severity==='hard'&&f.attempt===1));
        await call('quality_reopen',{task_id:'t1',event_id:'host-withdraw-unreviewed',reason:'Finish checking the unreviewed publication'});
        assert.deepEqual((await state()).qualityRuns.t1,withdrawn.qualityRuns.t1,'replay consumed budget');
        await call('publish_artifact',{task_id:'t1',attempt_id:withdrawn.tasks[0].attemptId,source_path:'artifacts/report.txt',name:'report.txt',media_type:'text/plain'});
        await call('update_task',{task_id:'t1',status:'in_progress',output:'Corrected fixture',execution_state:'awaiting_review',wait_reason:'Review resubmitted fixture'});
        await review('host-review-pass','pass');
        const passedCraft=(await state()).qualityRuns.t1.latestEvidence.artifactCheckReceipts[0];
        assert.equal(passedCraft.attempt,2);
        assert.ok(passedCraft.results.every(check=>check.status==='passed'));
        assert.notEqual(passedCraft.contractDigest,negativeReceipt.contractDigest);
        await call('update_task',{task_id:'t1',output:'Corrected fixture; independent review passed'});
        await call('quality_integrate',{task_id:'t1',event_id:'host-integrate',actor:'captain',complete_task:true});
        const current=await state();
        const output=JSON.parse(await readFile(join(root,project.outputPath),'utf8'));
        assert.equal(current.tasks[0].status,'completed');assert.equal(output.status,'completed');assert.equal(current.qualityRuns.t1.status,'integrated');
        const publication=current.qualityRuns.t1.latestEvidence.artifacts.find(item=>item.id==='published:report.txt');
        assert.ok(publication);assert.equal(publication.attempt,2);assert.equal(publication.content,'fixture-v2-corrected');
        result={recovered:true,prematureSubmissionRejected:true,unreviewedWithdrawal:true,withdrawalSameAttempt:true,withdrawalPreservedNegativeHistory:true,withdrawalBudgetCharged:current.qualityRuns.t1.revision.budgetCharged,repairBudgetRemaining:current.qualityRuns.t1.contract.maxRepairRounds,task:current.tasks[0].status,quality:current.qualityRuns.t1.status,attempt:current.tasks[0].attempt,repairRounds:current.qualityRuns.t1.repairRounds,outputStatus:output.status,publishedEvidence:{id:publication.id,attempt:publication.attempt,sha256:publication.sha256},reportCraft:{falsePassRejected:true,integrateWithoutCompletionRejected:true,apiAcceptsCallerReceipts:false,negativeReceipt,passedReceipt:passedCraft}};
      } else {res.writeHead(400);res.end();return;}
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
    } catch(error) {res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error?.message??error)}));}
  }}));
}
`
}

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

export async function runTeamCommunicationHostSmoke(options = {}) {
  const candidateTools = await readFile(join(REPO, 'lib/tools.js'), 'utf8')
  assert.ok(candidateTools.includes('expert_teams_quality_reopen') && candidateTools.includes('complete_task'), 'Build the current candidate before running the Host smoke test')
  const candidateIdentity = await runtimeIdentity()
  const sourceDomainPack = join(REPO, 'domain-packs', 'zhijian-realestate')
  const domainPackIdentity = await domainPackIdentityAt(sourceDomainPack)
  const root = await mkdtemp(join(tmpdir(), 'team-communication-real-host-'))
  const workspace = join(root, 'workspace')
  const dshHome = join(root, 'dsh-home')
  const profile = 'team-communication-smoke'
  const profileRoot = join(dshHome, 'profiles', profile)
  const probeRoot = join(root, 'probe-plugin')
  const port = await freePort()
  const nonce = randomBytes(24).toString('hex')
  // Forward only runtime paths/locale, never the parent process's API keys.
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: dshHome, CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
  const observations = []
  let child
  let succeeded = false
  let hostOutput = ''
  let browserCookie
  const progress = text => process.stderr.write(`HOST_SMOKE ${text}\n`)
  const command = async (file, args, cwd = root) => {
    progress(`${file} ${args.slice(0, 3).join(' ')}`)
    const result = await exec(file, args, { cwd, env, timeout: 240_000, maxBuffer: 8 * 1024 * 1024 })
    return result
  }
  const stop = async () => {
    if (!child) return
    const previous = child
    child = undefined
    try { process.kill(-previous.pid, 'SIGTERM') } catch {}
    await Promise.race([
      new Promise(resolve => previous.exitCode !== null || previous.signalCode !== null ? resolve() : previous.once('close', resolve)),
      pause(5000),
    ])
    if (previous.exitCode === null && previous.signalCode === null) {
      try { process.kill(-previous.pid, 'SIGKILL') } catch {}
      await new Promise(resolve => previous.once('close', resolve))
    }
  }
  const probe = async (action, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}/plugins/team-communication-host-smoke?action=${action}`, {
      method, headers: { 'x-smoke-nonce': nonce, ...(browserCookie === undefined ? {} : { cookie: browserCookie }) }, signal: AbortSignal.timeout(options.probeTimeoutMs ?? (options.probePlugin ? 30_000 : 180_000)),
    })
    const body = await response.text()
    assert.equal(response.status, 200, `${action}: ${body.slice(0, 1000)}`)
    return JSON.parse(body)
  }
  const start = async label => {
    progress(`start ${label}`)
    hostOutput = ''
    browserCookie = undefined
    child = spawn('dsh', ['--profile', profile, '--host', '127.0.0.1', '--port', String(port)], {
      cwd: workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    progress(`isolated ${label} pid=${child.pid} port=${port}`)
    let spawnError
    child.once('error', error => { spawnError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { hostOutput = `${hostOutput}${chunk}`.slice(-8192) })
    const started = Date.now()
    let lastError
    while (Date.now() - started < 180_000) {
      if (spawnError) throw new Error(`HOST_SMOKE_SPAWN_${spawnError.code ?? 'ERROR'}`)
      if (child.exitCode !== null) throw new Error(`HOST_SMOKE_EXIT_${child.exitCode}: ${hostOutput.replace(/token=[^\s]+/g, 'token=[REDACTED]').slice(-1200)}`)
      try {
        if (browserCookie === undefined) {
          const tokenMatch = hostOutput.match(/https?:\/\/[^\s?]+\/\?token=([^\s]+)/)
          if (tokenMatch === null) throw new Error('isolated Host browser authentication is not ready')
          const login = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(tokenMatch[1])}`, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
          browserCookie = login.headers.get('set-cookie')?.split(';')[0]
          await login.body?.cancel()
          if (browserCookie === undefined) throw new Error('isolated Host did not issue a browser cookie')
        }
        const schema = await probe('schema')
        observations.push({ label, startupMs: Date.now() - started, pid: child.pid, schema })
        return
      } catch (error) { lastError = error }
      await pause(500)
    }
    throw new Error(`HOST_SMOKE_NOT_READY: ${String(lastError?.message).slice(0, 1000)}; ${hostOutput.replace(/token=[^\s]+/g, 'token=[REDACTED]').slice(-1200)}`)
  }
  try {
    progress(`isolation root=${root} port=${port}`)
    await mkdir(workspace, { recursive: true })
    // Shared by all actual-Host probes: a complete, independent installed pack
    // in the exact test workspace. Never symlink global skill/material roots.
    const installedDomainPack = join(workspace, 'domain-packs', 'zhijian-realestate')
    await cp(sourceDomainPack, installedDomainPack, { recursive: true, errorOnExist: true, force: false })
    assert.equal((await hashContentDirectory(installedDomainPack)).contentTreeSha256, domainPackIdentity.contentTreeSha256)
    await mkdir(probeRoot, { recursive: true })
    await writeFile(join(probeRoot, 'package.json'), JSON.stringify({
      name: 'team-communication-host-probe', version: '0.0.0', type: 'module', main: 'index.mjs',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    await writeFile(join(probeRoot, 'index.mjs'), (options.probePlugin ?? probePlugin)(workspace, nonce, domainPackIdentity))
    await writeFile(join(probeRoot, 'cordis.patch.yml'), '- insert:\n    - id: team-communication-probe\n      name: team-communication-host-probe\n')
    await command('dsh', ['--from-default-profile', 'web', '--profile', profile, '--help'])
    await command('dsh', ['plugin', '--profile', profile, 'add', REPO])
    await command('dsh', ['plugin', '--profile', profile, 'add', probeRoot])
    // Same rc.8 compatibility seam as the existing A6 real-Host harness.
    const peerDir = join(profileRoot, 'node_modules', '@deepseek-ai')
    await mkdir(peerDir, { recursive: true })
    await symlink(join(REPO, 'node_modules/@deepseek-ai/dsh-settings'), join(peerDir, 'dsh-settings'), 'dir').catch(error => { if (error?.code !== 'EEXIST') throw error })
    await start('initial')
    const prepared = await probe('prepare', 'POST')
    const reportCraftV2Prepared = options.probePlugin ? undefined : await probe('craft-v2-prepare', 'POST')
    const selectedSkillCraftPrepared = options.probePlugin ? undefined : await probe('craft-v3-prepare', 'POST')
    await stop()
    const restartFault = await options.afterInitialStop?.({ workspace, stoppedPid: observations[0].pid })
    await start('restart')
    const finished = await probe('finish', 'POST')
    const reportCraftV2Finished = options.probePlugin ? undefined : await probe('craft-v2-finish', 'POST')
    const selectedSkillCraftFinished = options.probePlugin ? undefined : await probe('craft-v3-finish', 'POST')
    assert.notEqual(observations[0].pid, observations[1].pid)
    await stop()
    assert.equal((await runtimeIdentity()).sha256, candidateIdentity.sha256, 'Candidate runtime files changed during the Host smoke test')
    assert.equal((await hashContentDirectory(sourceDomainPack)).contentTreeSha256, domainPackIdentity.contentTreeSha256, 'Candidate domain pack changed during Host smoke test')
    assert.equal((await hashContentDirectory(installedDomainPack)).contentTreeSha256, domainPackIdentity.contentTreeSha256, 'Installed fixture pack was not restored after negative checks')
    succeeded = true
    return {
      kind: options.kind ?? 'team-communication-real-host-smoke', status: 'PASS', generatedAt: new Date().toISOString(),
      isolated: true, productionTouched: false, businessApiCalls: 0, realLlmCalls: 0,
      domainPackIdentity,
      candidateRuntimeSha256: candidateIdentity.sha256,
      candidateRuntimeFileCount: candidateIdentity.fileCount,
      candidateCriticalModules: candidateIdentity.criticalModules,
      observations, prepared, finished, ...(reportCraftV2Prepared === undefined ? {} : { reportCraftV2: { prepared: reportCraftV2Prepared, finished: reportCraftV2Finished } }), ...(selectedSkillCraftPrepared === undefined ? {} : { selectedSkillCraft: { prepared: selectedSkillCraftPrepared, finished: selectedSkillCraftFinished } }), ...(restartFault === undefined ? {} : { restartFault }), stopped: true,
      limitations: options.limitations ?? [
        'The real Host loads the plugin and HTTP probe invokes its registered tool definitions with synthetic participant identities.',
        'This does not exercise model reasoning, the full tool execution policy pipeline or real continuable-subagent transport.',
        'Restart coverage is durable task/quality continuation; separate hermetic flow tests cover scheduling and mailbox recovery.',
      ],
    }
  } finally {
    await stop()
    if (succeeded || options.preserveFailure !== true) await rm(root, { recursive: true, force: true })
    else progress(`retained failed isolated fixture=${root}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTeamCommunicationHostSmoke().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    // execFile errors retain stdout/stderr; never dump them or temporary login URLs.
    process.stderr.write(`${error?.code === 'ERR_ASSERTION' ? error.message : error?.code ? `HOST_SMOKE_${error.code}` : error?.message ?? 'HOST_SMOKE_FAILED'}\n`)
    process.exitCode = 1
  })
}
