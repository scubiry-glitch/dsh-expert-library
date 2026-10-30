import { readFile } from 'node:fs/promises'

/** Read-only, server-to-server usage projection. The caller supplies a server-resolved account ID. */
export function createModelUsageClient(config, fetchImpl = fetch) {
  return async accountId => {
    if (!config.modelUsageUrl || !config.modelUsageTokenFile || !/^[a-z0-9][a-z0-9-]*$/.test(accountId)) {
      throw new Error('model usage unavailable')
    }
    const token = (await readFile(config.modelUsageTokenFile, 'utf8')).trim()
    const url = new URL('/internal/usage', config.modelUsageUrl)
    url.searchParams.set('account_id', accountId)
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` },
      redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error('model usage unavailable')
    const usage = await response.json()
    if (typeof usage?.day !== 'string' || !Number.isSafeInteger(usage.dailyQuota)
      || !Number.isSafeInteger(usage.chargedTokens) || !Array.isArray(usage.days)) throw new Error('invalid model usage')
    if (usage.points) {
      const validCents = value => Number.isSafeInteger(value) && value >= 0
      if (!Number.isSafeInteger(usage.points.tokensPerPoint) || usage.points.tokensPerPoint < 1
        || !validCents(usage.points.dailyQuotaCents) || !validCents(usage.points.chargedCents)
        || !validCents(usage.points.remainingCents) || !Array.isArray(usage.points.days)
        || usage.points.days.some(day => typeof day.day !== 'string' || !validCents(day.chargedCents))) {
        throw new Error('invalid model usage points')
      }
    }
    return usage
  }
}
