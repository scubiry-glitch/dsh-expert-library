import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { TeamState, TeamTask, TaskArtifactRef, TaskInputManifest } from './types.ts'
import { validateTaskEvidence } from './quality-run.ts'
import { readAllowedTaskArtifact, resolveAllowedArtifact } from './state.ts'

/** Caller owns the team lock. Freeze the default once per real consumer
 * generation. Explicit refs, including [], never get silently replaced. */
export async function prepareDependencyInputs(stateRoot: string, team: TeamState, task: TeamTask, consumerAttempt: number): Promise<TaskInputManifest[]> {
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
      const run = team.qualityRuns?.[sourceId] ?? (team.qualityRun?.contract.taskId === sourceId ? team.qualityRun : undefined)
      // Legacy/control dependencies without publications require no invented
      // file input. A publication is selectable only with a real settled review.
      const current = (source.publishedArtifacts ?? []).filter(artifact => artifact.attempt === source.attempt)
      if (current.length === 0 && run === undefined && (source.publishedArtifacts?.length ?? 0) === 0
        && task.planTask === undefined && source.planTask === undefined && team.structuredQualityPolicy === undefined) continue
      if (run?.status !== 'integrated' || run.attempt !== source.attempt) throw new Error(`INPUT_DEPENDENCY_NOT_REVIEWED: ${sourceId} requires its current integrated quality attempt`)
      const latest = new Map(current.map(artifact => [artifact.reviewId ?? artifact.id, artifact]))
      if (current.length === 0 && run.contract.deliverables.some(id => id !== 'task-output')) {
        // Preserve the pre-publication manual-evidence workflow only for
        // existing unstructured teams. Its limitation is explicit and durable;
        // this is neither a fabricated publication nor a working-copy fallback.
        const legacyManual = task.planTask === undefined && source.planTask === undefined
          && team.structuredQualityPolicy === undefined && (source.publishedArtifacts?.length ?? 0) === 0
          && !run.contract.deliverables.some(id => id.startsWith('published:'))
          && run.latestEvidence !== undefined
        if (legacyManual) {
          validateTaskEvidence(run.contract, run.latestEvidence!, run.attempt)
          legacyUnpinnedSources.push(sourceId)
          continue
        }
        throw new Error(`INPUT_PUBLICATION_MISSING: ${sourceId} declares file deliverables without a current reviewed publication; summary-only dependencies may declare only task-output. Publish and review the needed files before completion, or explicitly declare consumer input_artifacts when creating a new task`)
      }
      const required = run.contract.deliverables.filter(id => id.startsWith('published:'))
      for (const id of required) if (!latest.has(id)) throw new Error(`INPUT_PUBLICATION_MISSING: ${sourceId} lacks reviewed deliverable ${id}`)
      for (const artifact of latest.values()) {
        const path = source.project === undefined ? undefined : `${team.id}/${source.project.artifactsPath}/${artifact.relativePath}`.replaceAll('\\', '/')
        const evidence = run.latestEvidence?.artifacts.find(item => item.id === (artifact.reviewId ?? artifact.id))
        if (evidence === undefined || evidence.taskId !== source.id || evidence.attempt !== artifact.attempt
          || evidence.sha256 !== artifact.sha256 || evidence.path !== path) {
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
  task.inputArtifactManifest = manifest
  return manifest
}
