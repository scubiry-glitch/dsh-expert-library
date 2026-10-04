/**
 * Read-only Expert Teams state diagnostics.
 *
 * Doctor deliberately does not acquire mutation locks, repair files, wake
 * agents, or delete stale records. It reports what an operator can inspect or
 * repair with the normal staged-plan/team tools.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isStagedPlan, readStagedPlan, STAGED_PLAN_DIR } from './staged-plan.ts'
import { listArchivedTeamIds, readArchivedTeam, readTeam } from './state.ts'
import { restoreCapabilityScopeWithReport } from './capability-scope.ts'
import type { StagedPlan, TeamState } from './types.ts'

export const DOCTOR_SCHEMA_VERSION = 1 as const

export type DoctorSeverity = 'info' | 'warning' | 'error'

export interface DoctorFinding {
  readonly code: string
  readonly severity: DoctorSeverity
  readonly path: string
  readonly message: string
  readonly remediation: string
}

export interface DoctorReport {
  readonly schemaVersion: typeof DOCTOR_SCHEMA_VERSION
  readonly checkedAt: number
  readonly stateRoot: string
  readonly findings: readonly DoctorFinding[]
  readonly summary: {
    readonly info: number
    readonly warning: number
    readonly error: number
  }
}

function finding(
  findings: DoctorFinding[],
  code: string,
  severity: DoctorSeverity,
  path: string,
  message: string,
  remediation: string,
): void {
  findings.push({ code, severity, path, message, remediation })
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8')) as unknown
}

async function inspectMailbox(
  mailboxPath: string,
  knownKeys: ReadonlySet<string>,
  findings: DoctorFinding[],
): Promise<void> {
  const key = mailboxPath.split('/').pop()?.replace(/\.jsonl$/u, '') ?? mailboxPath
  if (!knownKeys.has(key)) {
    finding(findings, 'mailbox.orphan', 'warning', mailboxPath, `mailbox has no matching team participant: ${key}`, 'Inspect the sender/recipient and remove it only through the normal team lifecycle.')
  }
  let text: string
  try {
    text = await readFile(mailboxPath, 'utf8')
  } catch (error) {
    finding(findings, 'mailbox.read_failed', 'error', mailboxPath, errorText(error), 'Restore readable mailbox permissions or recover the team from its archive.')
    return
  }
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (line === '') continue
    try {
      JSON.parse(line)
    } catch (error) {
      finding(findings, 'mailbox.invalid_jsonl', 'error', `${mailboxPath}:${index + 1}`, `invalid JSONL: ${errorText(error)}`, 'Move the malformed line to an evidence copy, then use the mailbox recovery procedure; do not edit team.json by hand.')
    }
  }
}

function inspectTeamShape(team: TeamState, teamPath: string, findings: DoctorFinding[]): void {
  const memberNames = new Set(team.members.map(member => member.name))
  const taskIds = new Set(team.tasks.map(task => task.id))
  for (const task of team.tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) {
        finding(findings, 'task.missing_dependency', 'error', `${teamPath}:task:${task.id}`, `dependency does not exist: ${dependency}`, 'Edit the original staged plan or reassign the task through the team tools.')
      }
      if (dependency === task.id) {
        finding(findings, 'task.self_dependency', 'error', `${teamPath}:task:${task.id}`, 'task depends on itself', 'Discard the invalid plan and stage a corrected DAG.')
      }
    }
    if (task.assignee !== undefined && task.assignee !== '' && !memberNames.has(task.assignee) && task.assignee !== 'captain') {
      finding(findings, 'task.unknown_assignee', 'error', `${teamPath}:task:${task.id}`, `assignee is not a team member: ${task.assignee}`, 'Reassign the task to a live member or captain with expert_teams_reassign_task.')
    }
    if (task.status === 'in_progress' && (task.attemptId === undefined || task.attemptId === '')) {
      finding(findings, 'task.missing_attempt', 'error', `${teamPath}:task:${task.id}`, 'in_progress task has no attempt_id', 'Stop or reassign the task, then claim a fresh attempt through the scheduler.')
    }
  }
  for (const member of team.members) {
    if (member.capabilityScope !== undefined) {
      const restored = restoreCapabilityScopeWithReport(member.capabilityScope, { expertId: member.name, role: member.role ?? 'member' })
      for (const warning of restored.warnings) {
        finding(findings, 'scope.legacy_fields', 'warning', `${teamPath}:member:${member.name}:capabilityScope`, warning, 'Recreate the member from the current profile so its capability scope is normalized.')
      }
    }
    if (member.status !== 'removed' && (member.provider ?? '') === '') {
      finding(findings, 'member.route_missing_provider', 'warning', `${teamPath}:member:${member.name}`, 'active member has no persisted provider route', 'Inspect the profile/provider compatibility report before starting another attempt.')
    }
  }
  if (team.halted === true && team.tasks.some(task => task.status === 'in_progress')) {
    finding(findings, 'team.halted_with_work', 'info', teamPath, 'halted team still has in-progress work; this is recoverable state', 'Use expert_teams_resume explicitly, or inspect the live attempt before reassigning it.')
  }
}

async function inspectTeamDirectory(
  stateRoot: string,
  teamId: string,
  findings: DoctorFinding[],
  now: number,
  archived = false,
): Promise<void> {
  const base = archived ? join(stateRoot, 'archive', teamId) : join(stateRoot, teamId)
  const teamPath = join(base, 'team.json')
  let raw: unknown
  try {
    raw = await readJson(teamPath)
  } catch (error) {
    finding(findings, 'team.invalid_json', 'error', teamPath, errorText(error), 'Restore the team from the last archive or stop using this state root until the malformed record is isolated.')
    return
  }
  const loaded = archived ? await readArchivedTeam(stateRoot, teamId) : await readTeam(stateRoot, teamId)
  if (loaded === undefined) {
    finding(findings, 'team.invalid_schema', 'error', teamPath, 'team.json is not a valid durable team record', 'Run doctor again after restoring a compatible state schema; do not spawn from this record.')
    return
  }
  inspectTeamShape(loaded, teamPath, findings)
  const knownKeys = new Set(['captain', ...loaded.members.map(member => member.name)])
  const inbox = join(base, 'inbox')
  try {
    for (const entry of await readdir(inbox, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) await inspectMailbox(join(inbox, entry.name), knownKeys, findings)
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      finding(findings, 'mailbox.scan_failed', 'error', inbox, errorText(error), 'Restore the inbox directory or inspect the archive manually.')
    }
  }
  if (loaded.halted === true && loaded.resumedAt !== undefined && loaded.resumedAt > now) {
    finding(findings, 'team.invalid_resume_time', 'error', teamPath, 'resumedAt is in the future', 'Repair the record through the team state migration or restore an earlier snapshot.')
  }
  void raw
}

async function inspectLocks(stateRoot: string, findings: DoctorFinding[], now: number): Promise<void> {
  const lockRoot = join(stateRoot, '.locks')
  try {
    for (const entry of await readdir(lockRoot, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const lockPath = join(lockRoot, entry.name)
      let lockText = ''
      try { lockText = await readFile(lockPath, 'utf8') } catch (error) {
        finding(findings, 'lock.read_failed', 'error', lockPath, errorText(error), 'Inspect the lock owner and recover only after confirming no mutation is active.')
        continue
      }
      const pid = Number.parseInt(lockText.split('\n', 1)[0] ?? '', 10)
      const mtime = await stat(lockPath).then(value => value.mtimeMs).catch(() => now)
      let alive = false
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true } catch { alive = false }
      }
      if (!alive && now - mtime > 60_000) {
        finding(findings, 'lock.stale', 'warning', lockPath, `lock owner ${Number.isSafeInteger(pid) ? pid : 'unknown'} is not alive`, 'Only remove it after confirming the owning DSH process is stopped; normal mutations clean locks automatically.')
      } else if (!alive) {
        finding(findings, 'lock.owner_missing', 'info', lockPath, 'lock owner is not currently observable', 'Recheck after the current mutation window; do not remove a fresh lock blindly.')
      }
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      finding(findings, 'lock.scan_failed', 'error', lockRoot, errorText(error), 'Inspect state-root permissions and retry doctor.')
    }
  }
}

async function inspectPlans(stateRoot: string, findings: DoctorFinding[], now: number): Promise<void> {
  const plansRoot = join(stateRoot, STAGED_PLAN_DIR)
  try {
    for (const entry of await readdir(plansRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.journal.json')) continue
      const planId = entry.name.slice(0, -'.json'.length)
      const path = join(plansRoot, entry.name)
      let plan: StagedPlan | undefined
      try { plan = await readStagedPlan(stateRoot, planId) } catch (error) {
        finding(findings, 'plan.invalid_schema', 'error', path, errorText(error), 'Discard or recover the plan through its CAS-aware plan tools; never approve a malformed record.')
        continue
      }
      if (plan === undefined) {
        finding(findings, 'plan.missing_record', 'error', path, 'plan file could not be read as a staged plan', 'Restore the plan journal or archive it as an incomplete plan.')
        continue
      }
      if (plan.status !== 'completed' && plan.status !== 'failed' && plan.status !== 'discarded' && plan.status !== 'expired' && plan.expiresAt <= now) {
        finding(findings, 'plan.expired_active', 'warning', path, `plan ${plan.planId} passed expiresAt while still ${plan.status}`, 'Use plan discard/recovery; do not approve an expired digest.')
      }
      if ((plan.status === 'running' || plan.status === 'completed') && plan.appliedTeamId === undefined) {
        finding(findings, 'plan.missing_team_link', 'error', path, `${plan.status} plan has no appliedTeamId`, 'Reconcile the plan against team state before resuming or reporting success.')
      }
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      finding(findings, 'plan.scan_failed', 'error', plansRoot, errorText(error), 'Inspect state-root permissions and retry doctor.')
    }
  }
}

/** Inspect one Expert Teams state root without changing it. */
export async function inspectExpertTeamsState(stateRoot: string, now = Date.now()): Promise<DoctorReport> {
  const findings: DoctorFinding[] = []
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      finding(findings, 'state.missing', 'info', stateRoot, 'state root does not exist yet', 'Create a team through plan stage/apply; no repair is needed.')
    } else {
      finding(findings, 'state.unreadable', 'error', stateRoot, errorText(error), 'Check state-root permissions and retry doctor.')
    }
    return makeReport(stateRoot, findings, now)
  }
  await inspectLocks(stateRoot, findings, now)
  await inspectPlans(stateRoot, findings, now)
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive' || entry.name === 'plans' || entry.name === '.locks') continue
    await inspectTeamDirectory(stateRoot, entry.name, findings, now)
  }
  for (const teamId of await listArchivedTeamIds(stateRoot)) {
    await inspectTeamDirectory(stateRoot, teamId, findings, now, true)
  }
  return makeReport(stateRoot, findings, now)
}

function makeReport(stateRoot: string, findings: readonly DoctorFinding[], checkedAt: number): DoctorReport {
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    checkedAt,
    stateRoot,
    findings,
    summary: {
      info: findings.filter(item => item.severity === 'info').length,
      warning: findings.filter(item => item.severity === 'warning').length,
      error: findings.filter(item => item.severity === 'error').length,
    },
  }
}

/** Aggregate diagnostics for multiple workspaces while keeping each path visible. */
export async function inspectExpertTeamsRoots(stateRoots: readonly string[], now = Date.now()): Promise<readonly DoctorReport[]> {
  return Promise.all(stateRoots.map(root => inspectExpertTeamsState(root, now)))
}
