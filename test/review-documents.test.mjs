import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTeamDir, createTaskProject, publishTaskArtifact, writeTeam } from '../lib/state.js'
import { listReviewDocuments, readReviewDocument } from '../lib/host/review-documents.js'
import { reviewedRelease } from '../lib/research-release.js'
import { canonicalDigest } from '../lib/v2/digest.js'
import { createQualityRun, reviewQualityRun, integrateQualityRun } from '../lib/quality-run.js'
test('review reads only published completed-task documents in its captain scope and verifies file hash', async t => {
  const root=await mkdtemp(join(tmpdir(),'review-docs-')); t.after(()=>rm(root,{recursive:true,force:true}))
  const now=Date.now(); const task={id:'t1',subject:'report',status:'completed',assignee:'captain',attempt:1,dependencies:[],createdAt:now,updatedAt:now,output:'delivered'}
  const team={id:'team',name:'team',captainSessionId:'captain',createdAt:now,members:[],tasks:[task],taskSeq:1}
  await createTeamDir(root,team); task.project=await createTaskProject(root,team.id,task)
  const artifact=await publishTaskArtifact(root,team,task,{name:'report.md',content:'# Verified report',mediaType:'text/markdown'}); task.publishedArtifacts=[artifact]; await writeTeam(root,team)
  const target={stateRoot:root,teamId:'team',captainSessionId:'captain',archived:false}
  const documents = await listReviewDocuments(target)
  assert.equal(documents.length,2)
  assert.equal(documents.find(doc => doc.id === artifact.id).createdAt,artifact.createdAt)
  assert.equal(documents.find(doc => doc.id === 'output').createdAt,task.updatedAt)
  assert.equal((await readReviewDocument(target,'t1',artifact.id)).content,'# Verified report')
  assert.equal((await readReviewDocument(target,'t1','output')).content,'delivered')
  await assert.rejects(readReviewDocument({...target,captainSessionId:'foreign'},'t1',artifact.id))
  await assert.rejects(readReviewDocument(target,'t2',artifact.id))
  await assert.rejects(readReviewDocument(target,'t1','../../etc/passwd'))
  await writeFile(join(root,team.id,task.project.artifactsPath,artifact.relativePath),'tampered')
  await assert.rejects(readReviewDocument(target,'t1',artifact.id),/hash mismatch/)
  task.status='pending'; await writeTeam(root,team)
  assert.equal((await listReviewDocuments(target)).length,0)
  await assert.rejects(readReviewDocument(target,'t1','output'))
})

test('node detail reads current-attempt working drafts while rejecting stale publications', async t => {
  const root=await mkdtemp(join(tmpdir(),'review-working-docs-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const now=Date.now();const task={id:'t1',subject:'working report',status:'in_progress',assignee:'captain',attempt:1,dependencies:[],createdAt:now,updatedAt:now,output:'draft summary'}
  const team={id:'team',name:'team',captainSessionId:'captain',createdAt:now,members:[],tasks:[task],taskSeq:1}
  await createTeamDir(root,team);task.project=await createTaskProject(root,team.id,task)
  const old=await publishTaskArtifact(root,team,task,{name:'report.md',content:'# Old draft'})
  task.attempt=2
  const current=await publishTaskArtifact(root,team,task,{name:'report.md',content:'# Current draft'})
  task.publishedArtifacts=[old,current];await writeTeam(root,team)
  const target={stateRoot:root,teamId:'team',captainSessionId:'captain',archived:false}
  const docs=await listReviewDocuments(target)
  assert.deepEqual(docs.map(doc=>doc.id),['output',current.id])
  assert.equal(docs.every(doc=>doc.draft),true)
  assert.equal((await readReviewDocument(target,'t1',current.id)).content,'# Current draft')
  await assert.rejects(readReviewDocument(target,'t1',old.id),/DOCUMENT_UNAVAILABLE/)
  await writeFile(join(root,team.id,task.project.artifactsPath,current.relativePath),'tampered')
  await assert.rejects(readReviewDocument(target,'t1',current.id),/hash mismatch/)
})

test('formal report requires completed final inspection and uses the current rendering attempt', async t => {
  const root=await mkdtemp(join(tmpdir(),'review-formal-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const now=Date.now()
  const renderer={id:'render',subject:'render',status:'completed',assignee:'captain',attempt:1,dependencies:[],createdAt:now,updatedAt:now,planTask:{logicalId:'renderer',fanOutIndex:0}}
  const inspection={id:'inspect',subject:'inspection',status:'pending',assignee:'captain',attempt:1,dependencies:['render'],createdAt:now,updatedAt:now,planTask:{logicalId:'finalqa',fanOutIndex:0}}
  const team={id:'team',name:'team',captainSessionId:'captain',createdAt:now,members:[],tasks:[renderer,inspection],taskSeq:2}
  await createTeamDir(root,team);renderer.project=await createTaskProject(root,team.id,renderer)
  const old=await publishTaskArtifact(root,team,renderer,{name:'report.md',content:'# Old draft',mediaType:'text/markdown'})
  renderer.attempt=2
  const current=await publishTaskArtifact(root,team,renderer,{name:'report.md',content:'# Formal report',mediaType:'text/markdown'})
  const notes=await publishTaskArtifact(root,team,renderer,{name:'notes.md',content:'working notes',mediaType:'text/markdown'})
  renderer.publishedArtifacts=[old,current,notes];await writeTeam(root,team)
  const target={stateRoot:root,teamId:'team',captainSessionId:'captain',archived:false}
  assert.equal((await listReviewDocuments(target)).filter(doc=>doc.formal).length,0)
  inspection.status='completed';await writeTeam(root,team)
  assert.deepEqual((await listReviewDocuments(target)).filter(doc=>doc.formal).map(doc=>doc.id),[current.id])
  renderer.status='in_progress';await writeTeam(root,team)
  assert.equal((await listReviewDocuments(target)).filter(doc=>doc.formal).length,0)
})

test('profile report bundle becomes formal only with current files and integrated review', async t => {
  const root=await mkdtemp(join(tmpdir(),'review-profile-report-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const now=Date.now()
  const task={id:'render',subject:'report',status:'completed',assignee:'captain',attempt:1,dependencies:[],createdAt:now,updatedAt:now,
    reportBundle:{md:'final.md',html:'final.html',pdf:'final.pdf'},planTask:{logicalId:'t3',fanOutIndex:0}}
  const team={id:'team',name:'team',captainSessionId:'captain',createdAt:now,members:[],tasks:[task],taskSeq:1}
  await createTeamDir(root,team);task.project=await createTaskProject(root,team.id,task)
  task.publishedArtifacts=[]
  for(const name of ['final.md','final.html','final.pdf']) task.publishedArtifacts.push(await publishTaskArtifact(root,team,task,{name,content:`content: ${name}`}))
  const target={stateRoot:root,teamId:'team',captainSessionId:'captain',archived:false}
  await writeTeam(root,team)
  assert.equal((await listReviewDocuments(target)).filter(doc=>doc.formal).length,0)
  const run=createQualityRun({id:'contract',taskId:'render',attempt:1,assignee:'captain',kind:'implementation',objective:'report',
    inScope:['team/**'],acceptance:[{id:'ok',statement:'reviewed'}],verify:['true'],
    deliverables:task.publishedArtifacts.map(artifact=>`published:${artifact.relativePath.split('/').at(-1)}`),changedPaths:['team/**'],maxRepairRounds:2})
  const artifacts=task.publishedArtifacts.map(artifact=>({id:`published:${artifact.relativePath.split('/').at(-1)}`,
    path:`team/${task.project.artifactsPath}/${artifact.relativePath}`,taskId:'render',attempt:1,
    content:`content: ${artifact.relativePath.split('/').at(-1)}`,sha256:artifact.sha256}))
  team.qualityRuns={render:integrateQualityRun(reviewQualityRun(run,{eventId:'review',reviewer:'critic',verdict:'pass',
    evidence:{taskId:'render',attempt:1,artifacts,acceptanceResults:[{id:'ok',passed:true}],
      commandsRun:[{command:'true',passed:true,exitCode:0}],changedPaths:artifacts.map(item=>item.path)}}).run,
    {eventId:'integrate',actor:'host'}).run};await writeTeam(root,team)
  assert.deepEqual((await listReviewDocuments(target)).filter(doc=>doc.formal).map(doc=>doc.name),['final.md','final.html','final.pdf'])
  task.attempt=2;await writeTeam(root,team)
  assert.equal((await listReviewDocuments(target)).filter(doc=>doc.formal).length,0)
})

test('key manuscripts keep current completed revisions and only the approved body publication', async t => {
  const root=await mkdtemp(join(tmpdir(),'review-key-docs-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const now=Date.now(), task=(id,logicalId)=>({id,subject:id,status:'completed',assignee:'captain',attempt:1,dependencies:[],createdAt:now,updatedAt:now,planTask:{logicalId,fanOutIndex:0}})
  const outline=task('outline','outline_final'),evidence=task('evidence','evidence_merge'),writer=task('writer','content_review')
  const choice={...task('choice','outline_choice'),dependencies:['outline'],humanChoice:{sourceTaskId:'outline',artifact:'OUTLINE.md',options:['确认']}}
  const release={...task('release','report_release'),dependencies:['writer'],humanChoice:{sourceTaskId:'writer',artifact:'report.md',options:['确认']}}
  const team={id:'team',name:'team',captainSessionId:'captain',createdAt:now,members:[],tasks:[outline,evidence,writer,choice,release],taskSeq:5}
  await createTeamDir(root,team)
  async function publish(task,name,content){task.project??=await createTaskProject(root,team.id,task);const a=await publishTaskArtifact(root,team,task,{name,content,mediaType:'text/markdown'});(task.publishedArtifacts??=[]).push(a);return a}
  const finalOutline=await publish(outline,'OUTLINE.md','# Outline')
  const oldEvidence=await publish(evidence,'research-evidence.md','# Old evidence');evidence.attempt=2
  const finalEvidence=await publish(evidence,'research-evidence.md','# Evidence')
  const body=await publish(writer,'report.md','# Approved body')
  await publish(writer,'review-notes.md','# Internal notes')
  await publish(writer,'report.md','# New unapproved body')
  release.humanChoiceReceipt={choice:'确认',sourceArtifactId:body.id,sourceSha256:body.sha256,sourceAttempt:1,approvedAt:now,actor:'authenticated-host-user'}
  await writeTeam(root,team)
  const target={stateRoot:root,teamId:'team',captainSessionId:'captain',archived:false}
  const docs=await listReviewDocuments(target)
  assert.deepEqual(docs.filter(d=>d.resultKind).map(d=>[d.id,d.resultKind]),[[finalOutline.id,'outline'],[finalEvidence.id,'evidence'],[body.id,'manuscript']])
  assert.equal(docs.find(d=>d.id===oldEvidence.id).resultKind,undefined)
  assert.equal((await readReviewDocument(target,writer.id,body.id)).content,'# Approved body')
  choice.status='pending';release.status='pending';delete release.humanChoiceReceipt;evidence.status='in_progress';await writeTeam(root,team)
  assert.equal((await listReviewDocuments(target)).filter(d=>d.resultKind).length,0)
})

for (const version of ['4.0.0', '5.0.0']) test(`compact ${version} formal reports require the current integrated release and preview PDFs`, async t => {
  const root=await mkdtemp(join(tmpdir(),'review-compact-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const renderer={id:'render',subject:'render',status:'completed',assignee:'author',attempt:1,dependencies:[],createdAt:1,updatedAt:1,planTask:{logicalId:'renderer'}}
  const team={id:'team',name:'team',captainSessionId:'captain',createdAt:1,members:[{id:'author',name:'author',joinedAt:1,status:'idle'}],tasks:[renderer],taskSeq:1,
    planRef:{scenarioId:'98wiki-deep-research',templateVersion:version,templateId:'profile:98wiki-deep-research',planId:'test',digest:'0'.repeat(64)}}
  await createTeamDir(root,team);renderer.project=await createTaskProject(root,team.id,renderer)
  const old=await publishTaskArtifact(root,team,renderer,{name:'report.pdf',content:'old draft'})
  renderer.attempt=2
  const content='%PDF-1.4 test report'
  const current=await publishTaskArtifact(root,team,renderer,{name:'report.pdf',content})
  renderer.publishedArtifacts=[old,current]
  const target={stateRoot:root,teamId:'team',captainSessionId:'captain',archived:false}
  const formal=async()=>{await writeTeam(root,team);return (await listReviewDocuments(target)).filter(d=>d.formal).map(d=>d.id)}
  assert.deepEqual(await formal(),[], 'completion alone is not delivery')
  const path=`team/${renderer.project.artifactsPath}/${current.relativePath}`
  const run=createQualityRun({id:'contract',taskId:'render',attempt:2,assignee:'author',kind:'implementation',objective:'render',inScope:['team/**'],acceptance:[{id:'ok',statement:'reviewed'}],verify:['true'],deliverables:['published:report.pdf'],changedPaths:['team/**'],maxRepairRounds:2})
  team.qualityRuns={render:integrateQualityRun(reviewQualityRun(run,{eventId:'review',reviewer:'critic',verdict:'pass',evidence:{taskId:'render',attempt:2,
    artifacts:[{id:'published:report.pdf',path,taskId:'render',attempt:2,content,sha256:current.sha256}],acceptanceResults:[{id:'ok',passed:true}],commandsRun:[{command:'true',passed:true,exitCode:0}],changedPaths:[path]}}).run,{eventId:'integrate',actor:'host'}).run}
  assert.deepEqual(await formal(),[], 'integration without the release receipt is insufficient')
  renderer.researchRelease=reviewedRelease(renderer,team.qualityRuns.render)
  assert.deepEqual(await formal(),[current.id])
  assert.equal((await listReviewDocuments(target)).find(d=>d.id===current.id).mediaType,'application/pdf')
  assert.equal((await readReviewDocument(target,'render',current.id)).mediaType,'application/pdf')
  const valid=structuredClone(renderer.researchRelease)
  const {digest,...stale}=valid
  stale.auditDigest='0'.repeat(64)
  renderer.researchRelease={...stale,digest:canonicalDigest(stale)};assert.deepEqual(await formal(),[])
  renderer.researchRelease=valid
  team.qualityRuns.render.status='passed';assert.deepEqual(await formal(),[])
  team.qualityRuns.render.status='integrated'
  team.halted=true;assert.deepEqual(await formal(),[]);delete team.halted
  renderer.attempt=3;assert.deepEqual(await formal(),[]);renderer.attempt=2
  team.tasks.push({id:'pending',subject:'pending',status:'pending',dependencies:[],createdAt:1,updatedAt:1})
  assert.deepEqual(await formal(),[])
})
