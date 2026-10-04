/** Deployment-local semi-automatic pack-center update policy: a pure planner
 * plus an opt-in scheduler. The decision never leaves this host; the center is
 * only ever pulled (one checkUpdates call per tick) exactly like a manual
 * check, and every automatic action flows through the same pinned, journaled
 * operation queue as a manual one. There is no push channel and no retry:
 * a release is auto-acted on at most once, and any terminal failure hands the
 * decision back to a human. */

import { parseSemVer } from '#pack-contract'
import { normalizeUpdateMode, normalizeUpdatePolicy, resolveUpdateMode,
  type PackCenterUpdateMode, type PackCenterUpdatePolicy } from '../settings.ts'
import type { CenterAutoActionView, CenterInstallationsView, CenterManageService, CenterOperationInput,
  CenterOperationView, CenterUpdatePolicyView, CenterUpdatesView } from '../pack-center-wire.ts'

export const AUTO_CHECK_BASE_MS = 6 * 60 * 60 * 1000
export const AUTO_CHECK_MAX_MS = 24 * 60 * 60 * 1000
export const AUTO_CHECK_JITTER = 0.15
/** Reserved operation-key prefix: the HTTP boundary rejects it, so `auto-`
 * actions can only originate from this scheduler. */
export const AUTO_OPERATION_PREFIX = 'auto-'
const AUTO_WAIT_TIMEOUT_CODE = 'AUTO_WAIT_TIMEOUT'
const AUTO_WAIT_DEADLINE_MS = 120_000
const AUTO_WAIT_POLL_MS = 250
/** Local-state races are benign for the check itself; only transport/health
 * failures justify exponential backoff. */
const BENIGN_CHECK_CODES = new Set(['GENERATION_CONFLICT', 'REVISION_CONFLICT', 'STATE_READ_ONLY'])

export function autoInstallKey(releaseId: string): string { return `auto-install:${releaseId}` }
export function autoEnableKey(releaseId: string): string { return `auto-enable:${releaseId}` }

/** True when anything (global default or any per-pack override) is non-manual:
 * only then may a timer be armed. */
export function policyEnabled(policy: PackCenterUpdatePolicy | undefined): boolean {
  if (normalizeUpdateMode(policy?.mode) !== 'manual') return true
  for (const mode of Object.values(policy?.perPack ?? {})) if (normalizeUpdateMode(mode) !== 'manual') return true
  return false
}

export interface AutoAction {
  packId: string; releaseId: string; version: string
  kind: 'install' | 'update_enable'
  operationKey: string
  target: { manifestSha256: string; artifactSha256: string; contentTreeSha256: string }
}
export interface AutoSkip { packId: string; releaseId?: string; mode: PackCenterUpdateMode; reason: string }

/**
 * Pure policy evaluation over the current updates snapshot. Every skip is
 * recorded with a stable reason so the UI can explain inaction. Rule 10 (the
 * operation key already exists in the journal) is what makes this idempotent:
 * an auto key is 1:1 with a releaseId, so a release is acted on at most once
 * ever — which also means `installed_not_enabled` is never retried and a
 * transient failure never becomes a retry storm.
 */
export function planAutoActions(input: {
  policy: PackCenterUpdatePolicy
  updates: CenterUpdatesView
  installations: CenterInstallationsView
  operations: CenterOperationView[]
  activationAvailable: boolean
}): { actions: AutoAction[]; skipped: AutoSkip[] } {
  const actions: AutoAction[] = []
  const skipped: AutoSkip[] = []
  const skip = (packId: string, mode: PackCenterUpdateMode, reason: string, releaseId?: string): void =>
    void skipped.push({ packId, releaseId, mode, reason })
  for (const item of input.updates.items) {
    const mode = resolveUpdateMode(input.policy, item.packId)
    if (mode === 'manual') { skip(item.packId, mode, 'manual', item.current.releaseId); continue }
    if (item.status !== 'update_available' || !item.candidate) { skip(item.packId, mode, item.status, item.current.releaseId); continue }
    const candidate = item.candidate
    const key = mode === 'download' ? autoInstallKey(candidate.releaseId) : autoEnableKey(candidate.releaseId)
    const existing = input.operations.find(job => job.request.operationKey === key)
    if (existing) { skip(item.packId, mode, `already_${existing.status}`, candidate.releaseId); continue }
    if (item.blockedReasons.some(row => row.releaseId === candidate.releaseId && row.reasons.length)) { skip(item.packId, mode, 'blocked', candidate.releaseId); continue }
    if (!candidate.compatibility.compatible || !candidate.downloadAvailability.available) { skip(item.packId, mode, 'not_installable', candidate.releaseId); continue }
    const stillActive = item.current.active && input.installations.items.some(entry =>
      entry.source === 'center' && entry.active && entry.releaseId === item.current.releaseId)
    if (!stillActive) { skip(item.packId, mode, 'not_active', candidate.releaseId); continue }
    let candidateSemver, currentSemver
    try {
      candidateSemver = parseSemVer(candidate.version)
      currentSemver = parseSemVer(item.current.version)
    } catch { skip(item.packId, mode, 'invalid_version', candidate.releaseId); continue }
    if (candidateSemver.prerelease.length > 0) { skip(item.packId, mode, 'prerelease', candidate.releaseId); continue }
    let kind: AutoAction['kind']
    if (mode === 'download') {
      kind = 'install'
      // Caching what is already cached is a no-op; the enable tier is exempt —
      // an already-cached candidate enables through the offline local path.
      if (item.candidateCached) { skip(item.packId, mode, 'already_cached', candidate.releaseId); continue }
    } else {
      const sameMinor = candidateSemver.major === currentSemver.major && candidateSemver.minor === currentSemver.minor
      const patchBump = candidateSemver.patch > currentSemver.patch
      if (!sameMinor || !patchBump) { skip(item.packId, mode, 'requires_manual', candidate.releaseId); continue }
      if (!input.activationAvailable) { skip(item.packId, mode, 'activation_unavailable', candidate.releaseId); continue }
      kind = 'update_enable'
    }
    actions.push({
      packId: item.packId, releaseId: candidate.releaseId, version: candidate.version, kind,
      operationKey: key,
      target: { manifestSha256: candidate.manifestSha256, artifactSha256: candidate.artifactSha256, contentTreeSha256: candidate.contentTreeSha256 },
    })
  }
  return { actions, skipped }
}

export interface PackCenterAutoUpdateOptions {
  service: CenterManageService
  /** Live policy thunk; re-read on every sync and every action. Never captured. */
  policy: () => PackCenterUpdatePolicy
  /** Mirrors the manager's requireRemote gate: only a configured origin may poll. */
  originConfigured: () => boolean
  /** Injectable clock for tests; defaults to setTimeout with `.unref()` so the
   * process can always exit. */
  schedule?: (callback: () => void, ms: number) => () => void
  now?: () => number
  baseIntervalMs?: number
  maxIntervalMs?: number
  jitterRatio?: number
}
/** Scheduler liveness in the exact browser-safe wire shape (plus an `enabled`
 * convenience flag that the HTTP projection strips). */
export interface PackCenterAutoUpdateStatus extends CenterUpdatePolicyView {
  enabled: boolean
}

const iso = (value: number) => new Date(value).toISOString()

export function createPackCenterAutoUpdate(options: PackCenterAutoUpdateOptions) {
  const base = options.baseIntervalMs ?? AUTO_CHECK_BASE_MS
  const max = options.maxIntervalMs ?? AUTO_CHECK_MAX_MS
  const jitterRatio = options.jitterRatio ?? AUTO_CHECK_JITTER
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? ((callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  const { service } = options

  let armed = false, inFlight = false, closed = false
  let intervalMs = base
  let cancel: (() => void) | undefined
  let dueAt: number | null = null
  let lastCheckAt: string | null = null
  let lastCheckErrorCode: string | undefined
  let lastApplyAt: string | null = null
  let running: Promise<void> | undefined
  const recent: CenterAutoActionView[] = []

  function record(entry: CenterAutoActionView): void {
    recent.push(entry)
    if (recent.length > 20) recent.splice(0, recent.length - 20)
  }
  function enabled(): boolean {
    return !closed && options.originConfigured() && policyEnabled(options.policy())
  }
  function arm(): void {
    if (armed || closed) return
    const delay = Math.max(1, Math.round(intervalMs * (1 + (Math.random() * 2 - 1) * jitterRatio)))
    armed = true
    dueAt = now() + delay
    cancel = schedule(() => { armed = false; cancel = undefined; dueAt = null; running = tick() }, delay)
  }
  function disarm(): void {
    cancel?.(); cancel = undefined
    armed = false; dueAt = null
  }
  /** Re-evaluate the gates. Only ever affects the next tick; an in-flight
   * batch finishes under the policy it started with. */
  function sync(): void {
    if (closed) return
    if (enabled()) arm()
    else disarm()
  }
  function waitForTerminal(operationId: string): Promise<CenterOperationView> {
    return (async () => {
      const deadline = now() + AUTO_WAIT_DEADLINE_MS
      for (;;) {
        const job = await service.operation(operationId)
        if (closed) return job
        if (job.status !== 'queued' && job.status !== 'running') return job
        if (now() >= deadline) return { ...job, status: 'failed', errorCode: AUTO_WAIT_TIMEOUT_CODE }
        await new Promise(resolve => setTimeout(resolve, AUTO_WAIT_POLL_MS))
      }
    })()
  }
  async function runOnce(): Promise<void> {
    if (closed) return
    const current = options.policy()
    if (!options.originConfigured() || !policyEnabled(current)) return
    // Pure local snapshots; no network in either call.
    const connection = await service.connection()
    if (!connection.connection?.bound) { lastCheckErrorCode = 'CENTER_NOT_BOUND'; return }
    // The single periodic network behavior of this plugin, and only when the
    // deployment administrator opted in above.
    const view = await service.checkUpdates()
    lastCheckAt = iso(now())
    if (view.errorCode) throw Object.assign(new Error(view.errorCode), { code: view.errorCode })
    lastCheckErrorCode = undefined
    const [installations, operations] = [await service.installations(), await service.operations()]
    const plan = planAutoActions({ policy: current, updates: view, installations, operations,
      activationAvailable: connection.activationAvailable })
    if (!plan.actions.length) return
    lastApplyAt = lastCheckAt
    for (const action of plan.actions) {
      if (closed) break
      // Mid-batch policy changes stop the remaining actions immediately.
      if (!policyEnabled(options.policy()) || !options.originConfigured()) {
        record({ packId: action.packId, releaseId: action.releaseId, version: action.version,
          kind: action.kind, operationKey: action.operationKey, at: iso(now()), outcome: 'skipped', detail: 'policy_changed' })
        break
      }
      try {
        // Re-read generation and revision immediately before each enqueue; a
        // stale value fails closed in the queue fences (by design).
        const fresh = await service.installations()
        const revision = (await service.connection()).revision
        const input: CenterOperationInput = {
          operationKey: action.operationKey, kind: action.kind,
          expectedGeneration: fresh.generation, releaseId: action.releaseId,
          connectionRevision: revision, target: action.target,
        }
        const job = await service.enqueue(input)
        record({ packId: action.packId, releaseId: action.releaseId, version: action.version,
          kind: action.kind, operationKey: action.operationKey, at: iso(now()), outcome: 'enqueued' })
        const terminal = await waitForTerminal(job.operationId)
        const outcome = terminal.status === 'succeeded' ? 'succeeded' : 'failed'
        record({ packId: action.packId, releaseId: action.releaseId, version: action.version,
          kind: action.kind, operationKey: action.operationKey, at: iso(now()), outcome,
          errorCode: terminal.errorCode ?? terminal.result?.errorCode })
        // `installed_not_enabled` is a safe downgrade (cache kept, activation
        // declined by preflight): never retried, never escalated. Any failure
        // ends the batch too — the next tick re-plans from scratch, and the
        // existing operation key keeps this release from auto-retrying.
        if (outcome === 'failed' || terminal.result?.outcome === 'installed_not_enabled') break
      } catch (error) {
        const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'INTERNAL_ERROR'
        record({ packId: action.packId, releaseId: action.releaseId, version: action.version,
          kind: action.kind, operationKey: action.operationKey, at: iso(now()), outcome: 'failed', errorCode: code })
        break
      }
    }
  }
  async function tick(): Promise<void> {
    if (inFlight || closed) return
    inFlight = true
    try {
      await runOnce()
      intervalMs = base
    } catch (error) {
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'INTERNAL_ERROR'
      lastCheckErrorCode = code
      if (!BENIGN_CHECK_CODES.has(code)) intervalMs = Math.min(intervalMs * 2, max)
    } finally {
      inFlight = false
      // Release the runOnce handle so a later call starts a fresh tick; the
      // completed promise must never satisfy another `??=` assignment.
      running = undefined
      sync()
    }
  }

  return {
    sync,
    runOnce: () => running ??= tick(),
    status(): PackCenterAutoUpdateStatus {
      const normalized = normalizeUpdatePolicy(options.policy())
      return {
        mode: normalizeUpdateMode(normalized.mode),
        perPack: Object.fromEntries(Object.entries(normalized.perPack ?? {}).map(([key, value]) => [key, normalizeUpdateMode(value)])),
        enabled: enabled(),
        timerRunning: armed && !closed,
        tickInFlight: inFlight,
        intervalMs: armed ? intervalMs : null,
        nextCheckAt: dueAt === null ? null : iso(dueAt),
        lastCheckAt,
        ...(lastCheckErrorCode === undefined ? {} : { lastCheckErrorCode }),
        lastApplyAt,
        recent: [...recent],
      }
    },
    async close(): Promise<void> {
      closed = true
      disarm()
      try { await running } catch { /* the batch observes `closed` at each step */ }
    },
  }
}
