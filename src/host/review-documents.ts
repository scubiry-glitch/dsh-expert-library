import { readReviewContext, tasksComplete, type ReviewContext } from './review-context.ts'
import { assertResearchRelease, isCompactResearch } from '../research-release.ts'
/** Review documents are resolved only through the token's durable team scope. */
import { readTeam, readArchivedTeam, readAllowedTaskArtifact, readCurrentTaskArtifact } from '../state.ts'
import type { TeamRouteTarget } from './team-routes.ts'
function documentMediaType(artifact: { relativePath: string; mediaType?: string }) {
  if (artifact.mediaType && artifact.mediaType !== 'application/octet-stream') return artifact.mediaType
  const extension = artifact.relativePath.split('.').at(-1)?.toLowerCase()
  return ({ pdf: 'application/pdf', html: 'text/html', md: 'text/markdown' } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream'
}
async function scopedTeam(target: TeamRouteTarget) {
  if (!target.teamId) throw Error('DOCUMENT_UNAVAILABLE')
  const team = await (target.archived ? readArchivedTeam : readTeam)(target.stateRoot, target.teamId)
  if (!team || team.captainSessionId !== target.captainSessionId) throw Error('DOCUMENT_UNAVAILABLE')
  return team
}
export async function listReviewDocuments(target: TeamRouteTarget, context?: ReviewContext) {
  if (!target.teamId) return []
  context ??= await readReviewContext(target)
  const team = context.team!
  // A report becomes a formal delivery only after the whole registered workflow
  // and its final inspection are complete. A recently published draft is not enough.
  const finished = !team.halted && team.tasks.length > 0 && team.tasks.every(task => task.status === 'completed')
  const inspected = team.tasks.some(task => task.planTask?.logicalId === 'finalqa' && task.status === 'completed')
  // Compact research integrates the independent review into the renderer.
  // Bind formal delivery to its current Host-verified release, not completion alone.
  const reviewedArtifacts = new Set<string>()
  if (finished && isCompactResearch(team)) {
    for (const task of team.tasks.filter(t => t.planTask?.logicalId === 'renderer')) {
      try {
        const release = assertResearchRelease(team, task)
        if (release.schemaVersion === 1) for (const artifact of release.artifacts) reviewedArtifacts.add(`${task.id}:${artifact.id}`)
      } catch { /* Missing or stale review receipts must not expose drafts as final. */ }
    }
  }
  // Key manuscripts reach their own final revision before the complete report is delivered.
  // Keep the approved source identity: a newer unapproved body is not a final manuscript.
  const approvedBodies = team.tasks.filter(t => t.status === 'completed' && t.humanChoice?.artifact.toLowerCase() === 'report.md')
  const outlineGates = team.tasks.filter(t => t.humanChoice && /outline|大纲/i.test(t.humanChoice.artifact))
  const keyKind = (task: (typeof team.tasks)[number], artifact: NonNullable<(typeof team.tasks)[number]['publishedArtifacts']>[number]) => {
    if (artifact.attempt !== task.attempt) return undefined
    const name = artifact.relativePath.split('/').at(-1)?.toLowerCase()
    if (task.planTask?.logicalId === 'outline_final' && name === 'outline.md' && outlineGates.every(gate => gate.status === 'completed')) return 'outline'
    if (['evidence_merge','writer'].includes(task.planTask?.logicalId ?? '') && name === 'research-evidence.md') return 'evidence'
    if (name === 'report.md' && approvedBodies.some(gate => gate.humanChoice!.sourceTaskId === task.id
      && (!gate.humanChoiceReceipt || (gate.humanChoiceReceipt.sourceArtifactId === artifact.id && gate.humanChoiceReceipt.sourceSha256 === artifact.sha256)))) return 'manuscript'
    return undefined
  }
  const qualityReady = Object.values(team.qualityRuns??{}).every(run=>run.status==='integrated') && (!team.qualityRun || team.qualityRun.status==='integrated')
  const genericFinal=finished&&qualityReady
  const matchPresentation=(task:(typeof team.tasks)[number],name:string,current:boolean)=>{
    if(!current)return {}
    const bundle=task.reportBundle
    const currentNames=new Set((task.publishedArtifacts??[]).filter(item=>item.attempt===task.attempt)
      .map(item=>item.relativePath.split('/').at(-1)))
    if(bundle&&[bundle.md,bundle.html,bundle.pdf].includes(name)&&genericFinal
      &&team.qualityRuns?.[task.id]?.status==='integrated'
      &&[bundle.md,bundle.html,bundle.pdf].every(file=>currentNames.has(file)))
      return {resultKey:`report:${task.id}`,resultLabel:'正式报告',formal:true}
    const logical=task.planTask?.logicalId??task.id
    const declared=context!.ui?.artifacts?.find(item=>item.fromTasks.includes(logical)&&(!item.names||item.names.includes(name)))
    if(declared){
      if(!tasksComplete(context!,declared.fromTasks)||(declared.confirmTasks?.length&&!tasksComplete(context!,declared.confirmTasks)))return {formal:false,fallback:true,resultKey:task.id+':'+name,resultLabel:task.subject}
      return {resultKey:declared.key,resultLabel:declared.label,resultKind:declared.kind==='key'?'key':undefined,formal:declared.kind==='final'&&genericFinal}
    }
    if(context!.research)return {}
    const delivery=context!.deliverables.find(item=>item.fromTasks.includes(logical))
    const explicitlyMapped=context!.ui?.artifacts?.some(item=>item.fromTasks.includes(logical))
    const families=new Set((task.publishedArtifacts??[]).filter(a=>a.attempt===task.attempt&&/\.(?:md|pdf|html|txt|docx|pptx|xlsx|csv)$/i.test(a.relativePath)).map(a=>(a.relativePath.split('/').at(-1)||'').replace(/\.[^.]+$/,'')))
    if(delivery&&!explicitlyMapped&&families.size===1&&genericFinal&&tasksComplete(context!,delivery.fromTasks)&&(/\.(?:md|pdf|html|txt|docx|pptx|xlsx|csv)$/i.test(name)))return {resultKey:delivery.id+':'+(name==='任务交付说明'?'说明':name.replace(/\.(?:md|pdf|html|txt|docx|pptx|xlsx|csv)$/i,'')),resultLabel:name==='任务交付说明'?'交付说明':name.replace(/\.[^.]+$/,''),formal:true}
    return {fallback:true,resultKey:task.id+':'+name,resultLabel:task.subject}
  }
  return team.tasks.filter(t => ['claimed', 'in_progress', 'completed'].includes(t.status)).flatMap(task => [
    ...(task.status === 'completed' && task.researchRelease ? [{ taskId:task.id,id:'reviewed-input-bundle',name:task.researchRelease.schemaVersion === 2 ? 'working-input-bundle.json' : 'reviewed-input-bundle.json',mediaType:'application/json',sizeBytes:Buffer.byteLength(JSON.stringify(task.researchRelease,null,2)) }, ...('reviewEventId' in task.researchRelease && task.researchReviewAudits?.[task.researchRelease.reviewEventId] ? [{ taskId:task.id,id:'independent-review',name:'independent-review.md',mediaType:'text/markdown',sizeBytes:Buffer.byteLength(task.researchReviewAudits[task.researchRelease.reviewEventId]!) }] : [])] : []),
    ...(task.output ? [{ taskId: task.id, id: 'output', name: '任务交付说明', mediaType: 'text/plain', sizeBytes: Buffer.byteLength(task.output), createdAt: task.updatedAt, draft: task.status !== 'completed', ...matchPresentation(task,'任务交付说明',true) }] : []),
    ...(task.publishedArtifacts ?? []).filter(a => task.status === 'completed' || a.attempt === task.attempt).map(a => ({ taskId: task.id, id: a.id, name: a.relativePath.split('/').at(-1) || a.id, mediaType: documentMediaType(a), sizeBytes: a.sizeBytes, createdAt: a.createdAt, draft: task.status !== 'completed', resultKind: task.status === 'completed' ? keyKind(task, a) : undefined, formal: task.status === 'completed' && finished && (isCompactResearch(team) ? reviewedArtifacts.has(`${task.id}:${a.id}`) : inspected) && task.planTask?.logicalId === 'renderer' && a.attempt === task.attempt && /^report\.(?:pdf|html|md)$/i.test(a.relativePath.split('/').at(-1) || ''), ...matchPresentation(task,a.relativePath.split('/').at(-1)||'',a.attempt===task.attempt) })),
  ])
}
export async function readReviewDocument(target: TeamRouteTarget, taskId: string, artifactId: string) {
  const team = await scopedTeam(target)
  const task = team.tasks.find(t => t.id === taskId && ['claimed', 'in_progress', 'completed'].includes(t.status))
  if (!task) throw Error('DOCUMENT_UNAVAILABLE')
  if (task.status === 'completed' && task.researchRelease && ['reviewed-input-bundle','independent-review'].includes(artifactId)) {
    const bundle=assertResearchRelease(team,task)
    if (artifactId === 'reviewed-input-bundle') return { name:'reviewed-input-bundle.json',content:JSON.stringify(bundle,null,2),mediaType:'application/json' }
    if (!('reviewEventId' in bundle) || !task.researchReviewAudits?.[bundle.reviewEventId]) throw Error('DOCUMENT_UNAVAILABLE')
    return { name:'independent-review.md',content:task.researchReviewAudits[bundle.reviewEventId],mediaType:'text/markdown' }
  }
  if (artifactId === 'output' && task.output) {
    if (Buffer.byteLength(task.output) > 8 * 1024 * 1024) throw Error('DOCUMENT_TOO_LARGE')
    return { name: '任务交付说明.txt', content: task.output, mediaType: 'text/plain' }
  }
  const artifact = task.publishedArtifacts?.find(a => a.id === artifactId && (task.status === 'completed' || a.attempt === task.attempt))
  if (!artifact || artifact.sizeBytes > 8 * 1024 * 1024) throw Error('DOCUMENT_UNAVAILABLE')
  const ref = { sourceTaskId: task.id, artifactId }
  const result = task.status === 'completed'
    ? await readAllowedTaskArtifact(target.stateRoot, team, { ...task, dependencies: [task.id], inputArtifacts: [ref], inputArtifactManifest: undefined }, ref)
    : await readCurrentTaskArtifact(target.stateRoot, team, task, artifactId)
  return { name: artifact.relativePath.split('/').at(-1), content: result.content, encoding: result.encoding, mediaType: documentMediaType(artifact) }
}
