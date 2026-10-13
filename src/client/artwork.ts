import { expertPortraitId, expertPortraitUrl, sharedPortraitId, hasPortraitAvatar } from '../review-portraits.ts'
/**
 * Shared Zhijian hand-drawn expert artwork lookup for the activity panel and the conversation
 * card: role keywords map to the packaged role images; the captain always
 * uses the lead expert.
 * @module dsh-expert-library/client/artwork
 */

/** Artwork route prefix served by the plugin host half. */
export const ART_BASE = '/plugins/dsh-expert-library/assets/'
const ART_VERSION = '?v=zhijian-experts-20261006'

/** Captain artwork (always the lead expert). */
export const LEAD_ART = `${ART_BASE}team-lead.png${ART_VERSION}`

/** Status action artwork per member activity. */
export const ACTION_ART: Record<'working' | 'idle' | 'unknown', string> = {
  working: `${ART_BASE}action-working.png${ART_VERSION}`,
  idle: `${ART_BASE}action-sleeping.png${ART_VERSION}`,
  unknown: `${ART_BASE}action-thinking.png${ART_VERSION}`,
}

/**
 * Named identity first, then a stable shared character appropriate to the role.
 * @param name - the member's display name.
 * @param role - the member's role text.
 * @returns an artwork URL even for a new pack with no declared portrait.
 */
export function memberArtUrl(name: string, role: string, expertId?: string, avatar = false): string | null {
  const named = expertPortraitId({ name, role, expertId })
  if (named) return expertPortraitUrl(named, avatar)
  const shared = sharedPortraitId(expertId || name, role || name)
  return expertPortraitUrl(shared, avatar && hasPortraitAvatar(shared))
}

/** Named artwork must never leave an empty member card if an asset fails to load. */
export function memberArtFallback(event: { currentTarget: HTMLImageElement }): void {
  const img = event.currentTarget
  const fallback = `${ART_BASE}researcher.png${ART_VERSION}`
  if (img.getAttribute('src') !== fallback) img.src = fallback
}
