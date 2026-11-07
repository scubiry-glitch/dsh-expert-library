/** Customer-visible targets derived from this account's live DSH provider grants. */
export interface CustomerDataMention {
  readonly name: string
  readonly kind: 'data-source'
  readonly provider: string
}

export interface CustomerCapabilityMention {
  readonly name: string
  readonly kind: 'domain-pack' | 'expert' | 'pack-review'
  readonly id: string
  readonly version: string
  readonly description: string
  readonly packId?: string
  readonly packVersion?: string
  readonly packName?: string
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

export type CustomerMention = CustomerDataMention | CustomerCapabilityMention
export const CUSTOMER_MENTION_CONTEXT_PREFIX = '[[customer-verified-mentions:v1]]'

export interface CustomerMentionSelection {
  readonly kind: 'domain-pack' | 'expert' | 'pack-review'
  readonly id: string
  readonly version: string
  readonly name: string
}

interface ProviderInventory {
  readonly providers: readonly string[]
  availableCredentials(): readonly string[]
  localDbDatabases(): readonly { id: string; sensitivity?: string }[]
}

export function customerMentions(inventory: ProviderInventory | undefined): CustomerDataMention[] {
  if (!inventory) return []
  const providers = new Set(inventory.providers)
  const credentials = new Set(inventory.availableCredentials())
  const targets: CustomerDataMention[] = []
  if (providers.has('zyt') && credentials.has('ZYT_API_KEY')) targets.push({ name: '智见', kind: 'data-source', provider: 'zyt' })
  if (providers.has('beike') && credentials.has('BEIKE_MCP_API_KEY')) targets.push({ name: '贝壳', kind: 'data-source', provider: 'beike' })
  if (providers.has('wind') && credentials.has('WIND_API_KEY')) targets.push({ name: '万得', kind: 'data-source', provider: 'wind' })
  if (providers.has('cddataos') && credentials.has('CDDATAOS_CREDENTIALS')) targets.push({ name: '成都数据运营平台', kind: 'data-source', provider: 'cddataos' })
  if (providers.has('localdb')) {
    for (const db of inventory.localDbDatabases()) {
      if (db.sensitivity !== 'internal') targets.push({ name: `数据-${db.id}`, kind: 'data-source', provider: 'localdb' })
    }
  }
  return targets
}

/** The browser's selected objects are hints; current account inventory is authoritative. */
export function verifyCustomerMentionSelections(
  text: string, available: readonly CustomerMention[], selected: readonly CustomerMentionSelection[],
): CustomerCapabilityMention[] | undefined {
  if (selected.length > 4) return undefined
  const verified: CustomerCapabilityMention[] = []
  const seen = new Set<string>()
  for (const item of selected) {
    if (!item || !['domain-pack', 'expert', 'pack-review'].includes(item.kind)
      || typeof item.id !== 'string' || typeof item.version !== 'string' || typeof item.name !== 'string'
      || seen.has(`${item.kind}:${item.id}`)) return undefined
    const match = available.find(candidate => candidate.kind === item.kind && candidate.id === item.id
      && candidate.version === item.version && candidate.name === item.name)
    if (!match || match.kind === 'data-source' || !text.includes(`@${item.name}`)) return undefined
    seen.add(`${item.kind}:${item.id}`)
    verified.push(match)
  }
  const selectedNames = new Set(verified.map(item => item.name))
  const dataNames = new Set(available.filter(item => item.kind === 'data-source').map(item => item.name))
  for (const match of text.matchAll(/(?:^|[\s(（])@([^\s@，。！？、,!?;；:：)\]）]{1,64})/gu)) {
    if (!dataNames.has(match[1]!) && !selectedNames.has(match[1]!)) return undefined
  }
  return verified
}

/** Privileged review calls need a selection in the latest admitted user turn. */
export function latestVerifiedCustomerMention(events: readonly unknown[], selection: CustomerMentionSelection): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as any
    if (!event || event.type !== 'user/message' || (event.surfaceOp && event.surfaceOp !== 'append')
      || event.data?.source?.kind !== 'user') continue
    const content = event.data?.content
    if (!Array.isArray(content) || content.length < 2 || content[1]?.type !== 'text'
      || typeof content[1].text !== 'string' || !content[1].text.startsWith(`${CUSTOMER_MENTION_CONTEXT_PREFIX}\n`)) return false
    try {
      const selected = JSON.parse(content[1].text.slice(CUSTOMER_MENTION_CONTEXT_PREFIX.length + 1))
      return Array.isArray(selected) && selected.some(item => item?.kind === selection.kind
        && item.id === selection.id && item.version === selection.version && item.name === selection.name)
    } catch { return false }
  }
  return false
}

/** Mentions typed directly into the editor are checked again at send time. */
export function unavailableCustomerMention(text: string, available: readonly CustomerMention[]): string | undefined {
  const granted = new Set(available.map(item => item.name))
  for (const match of text.matchAll(/(?:^|[\s(（])@([^\s@，。！？、,!?;；:：)\]）]{1,64})/gu)) {
    if (!granted.has(match[1]!)) return match[1]
  }
  return undefined
}
