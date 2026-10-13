import { pinResearchReleases, isV5WorkingTask, assertResearchRelease } from './research-release.ts'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TeamState, TeamTask, TaskArtifactRef, TaskInputManifest } from './types.ts'
import { validateTaskEvidence } from './quality-run.ts'
import { readAllowedTaskArtifact, resolveAllowedArtifact } from './state.ts'

/** Caller owns the team lock. Freeze the default once per real consumer
 * generation. Explicit refs, including [], never get silently replaced. */
export async function prepareDependencyInputs(stateRoot: string, team: TeamState, task: TeamTask, consumerAttempt: number): Promise<TaskInputManifest[]> {
  pinResearchReleases(team, task)
  const automatic = task.inputArtifactBinding?.mode === 'dependency-default'
  const select = (task.inputArtifacts === undefined && task.dispatch === undefined && task.status === 'pending')
    || (automatic && task.inputArtifactBinding!.consumerAttempt !== consumerAttempt)
  if (select) {
    const refs: TaskArtifactRef[] = []
    const legacyUnpinnedSources: string[] = []
    const reviewDisabled = team.structuredQualityPolicy?.required === false
    for (const sourceId of reviewDisabled ? [] : task.dependencies) {
      const source = team.tasks.find(candidate => candidate.id === sourceId)
      if (source?.status !== 'completed') throw new Error(`INPUT_DEPENDENCY_NOT_READY: ${sourceId} must be completed before selecting inputs`)
      if (source.humanChoice !== undefined) {
        if (source.humanChoiceReceipt === undefined) throw new Error(`HUMAN_CHOICE_MISSING: ${sourceId}`)
        continue
      }
      const run = team.qualityRuns?.[sourceId] ?? (team.qualityRun?.contract.taskId === sourceId ? team.qualityRun : undefined)
      // Legacy/control dependencies without publications require no invented
      // file input. A publication is selectable only with a real settled review.
      const current = (source.publishedArtifacts ?? []).filter(artifact => artifact.attempt === source.attempt)
      if (current.length === 0 && run === undefined && (source.publishedArtifacts?.length ?? 0) === 0
        && task.planTask === undefined && source.planTask === undefined && team.structuredQualityPolicy === undefined) continue
      const working = isV5WorkingTask(team,source)
      if (working) assertResearchRelease(team,source)
      if (!working && (run?.status !== 'integrated' || run.attempt !== source.attempt)) throw new Error(`INPUT_DEPENDENCY_NOT_REVIEWED: ${sourceId} requires its current integrated quality attempt`)
      const declared = working ? new Set(source.declaredPublications!.map(name => `published:${name}`)) : undefined
      const latest = new Map(current.filter(artifact => declared === undefined || declared.has(artifact.reviewId ?? artifact.id))
        .map(artifact => [artifact.reviewId ?? artifact.id, artifact]))
      if (current.length === 0 && run!.contract.deliverables.some(id => id !== 'task-output')) {
        // Preserve the pre-publication manual-evidence workflow only for
        // existing unstructured teams. Its limitation is explicit and durable;
        // this is neither a fabricated publication nor a working-copy fallback.
        const legacyManual = task.planTask === undefined && source.planTask === undefined
          && team.structuredQualityPolicy === undefined && (source.publishedArtifacts?.length ?? 0) === 0
          && !run!.contract.deliverables.some(id => id.startsWith('published:'))
          && run!.latestEvidence !== undefined
        if (legacyManual) {
          validateTaskEvidence(run!.contract, run!.latestEvidence!, run!.attempt)
          legacyUnpinnedSources.push(sourceId)
          continue
        }
        throw new Error(`INPUT_PUBLICATION_MISSING: ${sourceId} declares file deliverables without a current reviewed publication; summary-only dependencies may declare only task-output. Publish and review the needed files before completion, or explicitly declare consumer input_artifacts when creating a new task`)
      }
      const required = working ? source.declaredPublications!.map(n=>`published:${n}`) : run!.contract.deliverables.filter(id => id.startsWith('published:'))
      for (const id of required) if (!latest.has(id)) throw new Error(`INPUT_PUBLICATION_MISSING: ${sourceId} lacks reviewed deliverable ${id}`)
      const selected = task.plannedArtifactInputs === undefined ? undefined : new Set(task.plannedArtifactInputs
        .filter(input => task.inputSourceOverrides?.[input.fromTask] === undefined
          ? input.fromTask === (source.planTask?.logicalId ?? sourceId)
          : task.inputSourceOverrides[input.fromTask] === sourceId).map(input => input.artifact))
      if (selected?.size === 0) throw new Error(`INPUT_PLAN_DEPENDENCY_UNJUSTIFIED: ${sourceId} has no approved input requirement`)
      for (const name of selected ?? []) if (name !== 'task-output' && !latest.has(`published:${name}`)) throw new Error(`INPUT_PUBLICATION_MISSING: ${sourceId} lacks planned input ${name}`)
      for (const artifact of latest.values()) {
        if (selected !== undefined && !selected.has(artifact.reviewId?.replace(/^published:/u, '') ?? '')) continue
        const path = source.project === undefined ? undefined : `${team.id}/${source.project.artifactsPath}/${artifact.relativePath}`.replaceAll('\\', '/')
        const evidence = run?.latestEvidence?.artifacts.find(item => item.id === (artifact.reviewId ?? artifact.id))
        if (!working && (evidence === undefined || evidence.taskId !== source.id || evidence.attempt !== artifact.attempt
          || evidence.sha256 !== artifact.sha256 || evidence.path !== path)) {
          throw new Error(`INPUT_PUBLICATION_NOT_REVIEWED: ${sourceId}/${artifact.id} is not the current integrated evidence version`)
        }
        refs.push({ sourceTaskId: source.id, artifactId: artifact.id })
      }
    }
    // Persist these choices even if their bytes fail validation below. A later
    // retry must restore this version, not select an opportunistic replacement.
    task.inputArtifacts = refs
    task.inputArtifactBinding = { mode: 'dependency-default', consumerAttempt, ...(legacyUnpinnedSources.length === 0 ? {} : { legacyUnpinnedSources }), ...(reviewDisabled ? { reviewDisabled: true as const } : {}) }
    task.inputArtifactManifest = undefined
  }
  // Freeze every expected identity before inspecting any bytes. In particular,
  // a missing/corrupt first file must not leave later refs or its SHA mutable on
  // the next retry. realpath of the file is deliberately deferred until read;
  // recovering bytes must resolve to this exact declared immutable location.
  if (task.inputArtifactManifest === undefined) {
    const root = await realpath(stateRoot)
    task.inputArtifactManifest = (task.inputArtifacts ?? []).map(ref => {
      const { source, artifact } = resolveAllowedArtifact(team, task, ref)
      if (source.project === undefined) throw new Error(`INPUT_PUBLICATION_MISSING: ${source.id} has no source Project`)
      return { sourceTaskId: source.id, artifactId: artifact.id,
        ...(artifact.reviewId === undefined ? {} : { reviewArtifactId: artifact.reviewId }),
        attempt: artifact.attempt, sha256: artifact.sha256,
        versionPath: resolve(root, team.id, source.project.artifactsPath, artifact.relativePath) }
    })
  }
  if (task.inputArtifactManifest !== undefined) {
    const key = (ref: TaskArtifactRef): string => `${ref.sourceTaskId}\u0000${ref.artifactId}`
    const refs = task.inputArtifacts ?? []
    const fixed = new Set(task.inputArtifactManifest.map(key))
    if (fixed.size !== task.inputArtifactManifest.length || fixed.size !== refs.length || refs.some(ref => !fixed.has(key(ref)))) {
      throw new Error('INPUT_VERSION_CHANGED: persisted input references and manifest disagree; restore the fixed input identity instead of rebuilding it')
    }
  }
  const manifest: TaskInputManifest[] = []
  for (const ref of task.inputArtifacts ?? []) {
    const { source, artifact } = resolveAllowedArtifact(team, task, ref)
    await readAllowedTaskArtifact(stateRoot, team, task, ref)
    const item: TaskInputManifest = { sourceTaskId: source.id, artifactId: artifact.id,
      ...(artifact.reviewId === undefined ? {} : { reviewArtifactId: artifact.reviewId }),
      attempt: artifact.attempt, sha256: artifact.sha256,
      versionPath: await realpath(join(stateRoot, team.id, source.project!.artifactsPath, artifact.relativePath)) }
    const frozen = task.inputArtifactManifest?.find(value => value.sourceTaskId === ref.sourceTaskId && value.artifactId === ref.artifactId)
    if (frozen !== undefined && (frozen.attempt !== item.attempt || frozen.sha256 !== item.sha256 || frozen.reviewArtifactId !== item.reviewArtifactId || frozen.versionPath !== item.versionPath)) throw new Error(`INPUT_VERSION_CHANGED: fixed publication ${artifact.id} no longer matches its persisted identity`)
    manifest.push(item)
  }
  for (const [logical, sourceId] of Object.entries(task.inputSourceOverrides ?? {})) {
    const revision = task.inputRevisions?.slice().reverse().find(row => row.logicalSource === logical)
    if (revision === undefined || revision.replacementTaskId !== sourceId) throw new Error('INPUT_REVISION_RECEIPT_MISSING: replacement source has no captain receipt')
    const expected = revision.nextManifest.filter(item => item.sourceTaskId === sourceId)
    const actual = manifest.filter(item => item.sourceTaskId === sourceId)
    if (expected.length !== actual.length || expected.some(item => !actual.some(other =>
      item.artifactId === other.artifactId && item.sha256 === other.sha256 && item.attempt === other.attempt
      && item.reviewArtifactId === other.reviewArtifactId && item.versionPath === other.versionPath))) {
      throw new Error('INPUT_VERSION_CHANGED: revised source differs from the captain-approved publication')
    }
  }
  task.inputArtifactManifest = manifest
  return manifest
}
