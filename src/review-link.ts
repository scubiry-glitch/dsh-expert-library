/** Public, non-secret deep links for human review gates. The browser must
 * authenticate with the Host before it can exchange one for a review session. */
export const REVIEW_PAGE_PATH = '/plugins/dsh-expert-library/review'

export type ReviewGate = 'plan' | 'outline' | 'body' | 'activity'

export function reviewPublicUrl(origin: string | undefined, target: {
  captainSessionId: string
  planId?: string
  teamId?: string
  gate: ReviewGate
  taskId?: string
}): string | undefined {
  if (!origin || !target.captainSessionId || (!target.planId && !target.teamId)) return undefined
  let url: URL
  try { url = new URL(origin) } catch { return undefined }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) return undefined
  url.pathname = REVIEW_PAGE_PATH
  url.searchParams.set('captain', target.captainSessionId)
  if (target.planId) url.searchParams.set('plan', target.planId)
  if (target.teamId) url.searchParams.set('team', target.teamId)
  url.searchParams.set('gate', target.gate)
  if (target.taskId) url.searchParams.set('task', target.taskId)
  return url.toString()
}
