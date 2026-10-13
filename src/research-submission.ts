import { checkWriterSubmission } from './deep-research-gates.ts'
/** Submission prepares all bytes before publishing and commits its authority with team.json. */
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { canonicalDigest } from './v2/digest.ts'
import { publishTaskArtifact } from './state.ts'
import { amendQualityRun } from './quality-run.ts'
import { isCompactResearch, isV5WorkingTask } from './research-release.ts'
import { publicationNames } from './task-publications.ts'
import type { TeamTask, TeamState } from './types.ts'
export interface SubmissionFile { name: string; source_path: string }
export function submissionFingerprint(args: { submission_id?: string; publications?: SubmissionFile[]; output?: string; attempt_id?: string; execution_state?: string; status?: string; wait_reason?: string }): string { return canonicalDigest(args) }
export async function prepareResearchSubmission(root: string, team: TeamState, task: TeamTask, files: SubmissionFile[]): Promise<void> {
  if (!task.project || task.executionState === 'awaiting_review' || !['claimed','in_progress'].includes(task.status)) throw new Error('SUBMISSION_NOT_WRITABLE')
  const run = team.qualityRuns?.[task.id] ?? (team.qualityRun?.contract.taskId === task.id ? team.qualityRun : undefined)
  const working = isV5WorkingTask(team,task)
  if (!working && (!run || !['pending','repairing'].includes(run.status) || run.attempt !== task.attempt)) throw new Error('SUBMISSION_QUALITY_NOT_WRITABLE')
  const required = working ? [...(task.declaredPublications ?? [])].sort() : run!.contract.deliverables.filter(id => id.startsWith('published:')).map(id => id.slice(10)).sort()
  const names = publicationNames(files.map(f => f.name))
  // Dynamic follow-ups historically had no way to declare files. Match the
  // existing single-file publication flow: bind once before any review, within
  // the submission transaction. Approved template contracts remain exact.
  const firstDeclaration = run !== undefined && isCompactResearch(team) && task.planTask === undefined && task.reportBundle === undefined
    && task.declaredPublications === undefined && !required.length && !task.publishedArtifacts?.length
    && !run.contract.artifactChecks?.length && run.status === 'pending' && run.reviewRounds === 0
    && run.repairRounds === 0 && run.contractFrozenAt === undefined && !task.submissionReceipt
  if (!names.length || (!firstDeclaration && JSON.stringify(required) !== JSON.stringify(names))) {
    throw new Error(`SUBMISSION_FILES_INCOMPLETE: ${JSON.stringify({ expected: required, received: names,
      missing: required.filter(name => !names.includes(name)), unexpected: names.filter(name => !required.includes(name)),
      retryable: true, repairBudgetCharged: false,
      action: !names.length ? 'Provide the task files in publications; do not submit an empty file set.'
        : 'Submit exactly the listed expected names. New tasks may declare produces in expert_teams_create_task.' })}`)
  }
  const project = await realpath(join(root, team.id, task.project.path))
  const contents = await Promise.all(files.map(async file => {
    const parts = file.source_path.replaceAll('\\','/').split('/')
    if (isAbsolute(file.source_path) || parts.some(p => !p || p === '.' || p === '..') || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(file.name)) throw new Error('SUBMISSION_PATH_INVALID')
    const source = await realpath(join(project, ...parts))
    const rel = relative(project, source)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('SUBMISSION_PATH_ESCAPE')
    const content = await readFile(source)
    if (content.length > 20 * 1024 * 1024) throw new Error('SUBMISSION_FILE_TOO_LARGE')
    return { name: file.name, content }
  }))
  await checkWriterSubmission(root, team, task, new Map(contents.map(file => [file.name, file.content.toString('utf8')])))
  if (firstDeclaration) {
    const amended = amendQualityRun(run, {
      eventId: `submission-files:${task.id}:${task.attempt}`, actor: task.assignee ?? run.contract.assignee,
      reason: 'Register the first atomic publication set of an undeclared dynamic task before independent review.',
      contract: { ...run.contract, deliverables: [...run.contract.deliverables, ...names.map(name => `published:${name}`)],
        changedPaths: [...new Set([...run.contract.changedPaths, `${team.id}/${task.project.artifactsPath}/**`.replaceAll('\\', '/')])] },
    }).run
    team.qualityRuns = { ...team.qualityRuns, [task.id]: amended }
    if (team.qualityRun?.contract.taskId === task.id) team.qualityRun = amended
    task.declaredPublications = names
  }
  // Failed commits can leave unreferenced immutable files. They are never authority;
  // consumers can select only publications committed together with the submission.
  for (const file of contents) {
    const artifact = await publishTaskArtifact(root,team,task,file)
    if (!task.publishedArtifacts?.some(a => a.id === artifact.id)) task.publishedArtifacts = [...(task.publishedArtifacts ?? []),artifact]
  }
}
