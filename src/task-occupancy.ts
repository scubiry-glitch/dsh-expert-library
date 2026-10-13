import type { TeamTask } from './types.ts'

/** A submitted or externally blocked attempt retains ownership, but not a worker's execution slot. */
export function occupiesMemberExecutionSlot(task: TeamTask): boolean {
  return (task.status === 'claimed' || task.status === 'in_progress')
    && task.executionState !== 'awaiting_review'
    && task.executionState !== 'blocked_external'
}
