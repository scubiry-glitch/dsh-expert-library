#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CenterSession } from './pack-center-session.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2)
if (!args[0] || args.includes('--help')) {
  console.log('Usage: node scripts/ops/release-domain-pack.mjs CONFIG.json [--apply --approve-reviewed]')
  process.exit(0)
}
const config = JSON.parse(await readFile(resolve(args[0]), 'utf8'))
const apply = args.includes('--apply'), approve = args.includes('--approve-reviewed')
const git = (...a) => execFileSync('git', ['-C', config.sourceDir, ...a], {encoding:'utf8'}).trim()
const pack = JSON.parse(await readFile(resolve(config.sourceDir, 'pack.json'), 'utf8'))
const commit = git('rev-parse', 'HEAD')
if (git('status','--porcelain')) throw Error('SOURCE_DIRTY: commit reviewed changes first')
if (pack.id !== config.packId || pack.version !== config.version || commit !== config.sourceCommit) throw Error('SOURCE_IDENTITY_MISMATCH')
const remote = git('ls-remote', config.sourceUrl, `refs/tags/v${config.version}`, `refs/tags/v${config.version}^{}`)
if (!remote.split('\n').some(line => line.startsWith(commit+'\t'))) throw Error('REMOTE_TAG_NOT_PINNED_TO_COMMIT')
execFileSync(process.execPath, [resolve(repo, 'scripts/dsh-pack.mjs'), 'check', config.sourceDir], {stdio:'inherit'})
if(config.verificationTests?.length)execFileSync(process.execPath,['--test','--test-concurrency=1',...config.verificationTests],{cwd:repo,stdio:'inherit'})
console.log(JSON.stringify({stage:'source_verified', packId:pack.id, version:pack.version, commit, apply}))
if (!apply) process.exit(0)

const receiptPath = resolve(config.receiptDir, `${pack.id}-${pack.version}.json`)
let receipt = {packId:pack.id, version:pack.version, sourceCommit:commit, origin:config.origin}
try { const old=JSON.parse(await readFile(receiptPath,'utf8')); if(old.sourceCommit!==commit || old.origin!==config.origin) throw Error('RECEIPT_IDENTITY_MISMATCH'); receipt=old } catch(e) {if(e.code!=='ENOENT')throw e}
async function save(fields) {
  Object.assign(receipt,fields,{updatedAt:new Date().toISOString()})
  await mkdir(dirname(receiptPath),{recursive:true,mode:0o700})
  const temp=`${receiptPath}.${process.pid}.tmp`
  await writeFile(temp,JSON.stringify(receipt,null,2)+'\n',{mode:0o600}); await rename(temp,receiptPath)
}
const sessions=[]
const login=async subject=>{const s=await new CenterSession(config.origin,subject,config.credentialDir).login();sessions.push(s);return s}
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function poll(label,read,done,failed) {
  const end=Date.now()+(config.timeoutMs??600000);let last,logged=''
  while(Date.now()<end){last=await read();const status=last.submission?.status??last.status??'waiting';if(status!==logged){console.log(label,status);logged=status}if(failed(last))throw Error(`${label}_FAILED:${last.errorCode??last.result?.errorCode??status}`);if(done(last))return last;await wait(2000)}
  throw Error(`${label}_TIMEOUT: rerun the same command to resume`)
}
let host
try {
  const author=await login(config.author)
  if(!receipt.submissionId){
    let cursor, matches=[]
    do {const d=await author.call(`/api/submissions?organizationId=${encodeURIComponent(config.organizationId)}&limit=100${cursor?'&cursor='+encodeURIComponent(cursor):''}`);matches.push(...d.items.filter(s=>s.packId===pack.id&&s.version===pack.version&&s.status!=='withdrawn'));cursor=d.nextCursor}while(cursor)
    if(matches.length>1)throw Error('AMBIGUOUS_EXISTING_SUBMISSION')
    let submission=matches[0]
    if(submission){const d=await author.call(`/api/submissions/${submission.id}`);if(d.submission.source.ref!==commit||d.submission.source.url!==config.sourceUrl)throw Error('IMMUTABLE_VERSION_SOURCE_CONFLICT')}
    else submission=await author.call('/api/submissions','POST',{
      organizationId:config.organizationId,packId:pack.id,name:config.name,version:pack.version,
      source:{url:config.sourceUrl,ref:commit},notes:config.notes,license:config.license,
      distribution:config.distribution,requiresPlugin:{minVersion:config.minPluginVersion??'0.1.0'},
      dependencyReleaseIds:config.dependencyReleaseIds??[],builtinDependencies:config.builtinDependencies??[]
    },`pack-${pack.id}-${pack.version}-${commit.slice(0,12)}`)
    await save({submissionId:submission.id})
  }
  const path=`/api/submissions/${receipt.submissionId}`
  let detail=await author.call(path)
  if(detail.submission.source.ref!==commit||detail.submission.packId!==pack.id||detail.submission.version!==pack.version)throw Error('SUBMISSION_IDENTITY_MISMATCH')
  if(detail.submission.status==='draft')await author.call(path+'/validate','POST',{expectedVersion:detail.submission.stateVersion},`${receipt.submissionId}-validate-${detail.submission.stateVersion}`)
  detail=await poll('validation',()=>author.call(path),d=>['validated','pending_review','approved'].includes(d.submission.status),d=>['validation_failed','rejected','withdrawn'].includes(d.submission.status))
  if(detail.snapshot?.sourceCommit!==commit)throw Error('VALIDATED_COMMIT_MISMATCH')
  await save({contentTreeSha256:detail.snapshot.contentTreeSha256,artifactSha256:detail.snapshot.artifactSha256,validationSnapshotId:detail.snapshot.id})
  if(detail.submission.status==='validated'){
    await author.call(path+'/submit','POST',{expectedVersion:detail.submission.stateVersion},`${receipt.submissionId}-submit-${detail.submission.stateVersion}`)
    detail=await author.call(path)
  }
  if(detail.submission.status==='pending_review'){
    if(!approve)throw Error('REVIEW_REQUIRED: inspect snapshot and rerun with --approve-reviewed after authorization')
    const reviewer=await login(config.reviewer)
    if(reviewer.principal.userId===author.principal.userId)throw Error('REVIEWER_MUST_DIFFER_FROM_AUTHOR')
    await reviewer.call(path+'/review','POST',{expectedVersion:detail.submission.stateVersion,contentTreeSha256:detail.snapshot.contentTreeSha256,decision:'approved',comment:config.reviewComment},`${receipt.submissionId}-review-${detail.submission.stateVersion}`)
  }
  detail=await poll('publication',()=>author.call(path),d=>d.release?.status==='published',d=>['failed','publish_failed'].includes(d.release?.status)||['rejected','withdrawn'].includes(d.submission.status))
  const releaseId=detail.release.id
  await save({releaseId,published:true,publishedAt:detail.release.publishedAt})
  console.log(JSON.stringify({stage:'published',releaseId}))

  const {syncProductionSelection,materializePackAliases}=await import('./production-pack-selection.mjs')
  await materializePackAliases(config)
  await syncProductionSelection(config)

  // Use the production host's real manager and activation preflight. No manual
  // inventory writes, forged login sessions, or permissive validator callbacks.
  const {openProductionPackHost}=await import('./production-pack-host.mjs')
  host=await openProductionPackHost(config)
  const svc=host.service
  let installed=await svc.installations()
  const release=await svc.release(releaseId)
  if(release.sourceCommit!==commit||release.version!==pack.version||release.packId!==pack.id||release.contentTreeSha256!==receipt.contentTreeSha256)throw Error('RELEASE_IDENTITY_MISMATCH')
  if(!installed.items.some(x=>x.releaseId===releaseId&&x.active&&x.integrity==='verified')){
    const operationKey=`publish-${pack.id}-${pack.version}-${commit.slice(0,12)}`
    let job=(await svc.operations()).find(x=>x.request.operationKey===operationKey)
    if(!job){const connection=await svc.connection();job=await svc.enqueue({operationKey,kind:'update_enable',expectedGeneration:installed.generation,releaseId,connectionRevision:connection.revision,target:{manifestSha256:release.manifestSha256,artifactSha256:release.artifactSha256,contentTreeSha256:release.contentTreeSha256}})}
    else if(['failed','interrupted'].includes(job.status)){
      // An update may already have installed the signed artifact but rejected
      // activation. Resume via the supported enable transaction at current generation.
      if(!installed.items.some(x=>x.releaseId===releaseId&&x.integrity==='verified'))throw Error(`PREVIOUS_OPERATION_FAILED:${job.errorCode??job.status}`)
      const enableKey=`${operationKey}-enable-g${installed.generation}`
      job=(await svc.operations()).find(x=>x.request.operationKey===enableKey)??await svc.enqueue({operationKey:enableKey,kind:'enable',expectedGeneration:installed.generation,releaseId})
      if(['failed','interrupted'].includes(job.status))job=await svc.retry(job.operationId)
      await svc.start()
    }else await svc.start()
    await save({operationId:job.operationId})
    job=await poll('activation',()=>svc.operation(job.operationId),x=>x.status==='succeeded',x=>['failed','interrupted','cancelled'].includes(x.status))
    if(job.result?.outcome==='installed_not_enabled')throw Error('INSTALLED_NOT_ACTIVATED')
  }
  installed=await svc.installations()
  const active=installed.items.find(x=>x.packId===pack.id&&x.active)
  if(active?.releaseId!==releaseId||active?.version!==pack.version||active?.integrity!=='verified')throw Error('ACTIVE_VERSION_VERIFICATION_FAILED')
  const snapshot=await host.activeSnapshot()
  const activePack=snapshot.packs.find(x=>x.packId===pack.id)
  if(!activePack)throw Error('RUNTIME_SNAPSHOT_MISSING_PACK')
  for(const skill of config.requiredSkills??[])await readFile(resolve(activePack.root,'skills',skill,'SKILL.md'),'utf8')
  await save({activated:true,generation:installed.generation,activeRoot:activePack.root,verifiedAt:new Date().toISOString()})
  console.log(JSON.stringify({stage:'verified_active',packId:pack.id,version:pack.version,releaseId,generation:installed.generation,receiptPath}))
} finally {
  if(host){host.autoUpdate.close();await host.service.close()}
  for(const s of sessions)await s.logout()
}
