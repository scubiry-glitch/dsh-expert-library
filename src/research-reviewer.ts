import type { TeamState, TeamTask } from './types.ts'

/** Same role requirement for action guidance and the actual admission gate. */
export function requiresDesignCritic(team: TeamState, task: TeamTask): boolean {
  return team.planRef?.scenarioId === '98wiki-deep-research'
    && /^[2345]\./u.test(team.planRef.templateVersion)
    && ['renderer', 'render_revision_1'].includes(task.planTask?.logicalId ?? '')
}

export function boundDesignCritic(team: TeamState, task: TeamTask): string | undefined {
  if (!requiresDesignCritic(team, task)) return undefined
  return team.members.find(member => member.status !== 'removed' && member.name !== task.assignee
    && member.capabilityScope?.expertId === 'design-critic')?.name
}
