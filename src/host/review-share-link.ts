import { reviewPublicUrl } from '../review-link.ts'
import { issueReviewAccess } from './review-access.ts'

/** Chat handoff: scoped access in the fragment, plus the exact human gate. */
export async function issueReviewShareLink(stateRoot: string, origin: string | undefined,
  target: Parameters<typeof reviewPublicUrl>[1]): Promise<string | undefined> {
  const publicUrl = reviewPublicUrl(origin, target)
  if (publicUrl === undefined) return undefined
  const access = await issueReviewAccess(stateRoot, {
    captainSessionId: target.captainSessionId,
    ...(target.planId === undefined ? {} : { planId: target.planId }),
    ...(target.teamId === undefined ? {} : { teamId: target.teamId }),
  })
  const url = new URL(publicUrl)
  url.hash = `share=${access.token}`
  return url.toString()
}
