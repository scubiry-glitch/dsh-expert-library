/**
 * Durable Expert Teams session events and their emitter.
 *
 * Every team-state mutation appends one event to the captain's Session, so
 * the web client's Conversation Node mechanism can fold the tree view from
 * the session log deterministically (same mechanism as `tool-workflow`'s
 * `tool-workflow/*` record events). Events append to the captain's session
 * even when a member agent performed the mutation, so the captain's
 * conversation stream stays the single authoritative monitor surface.
 *
 * ## Closed event vocabulary (audit gap #4 residual — documented limitation)
 *
 * The harness's session-event vocabulary is a **closed generated constant**:
 * `KNOWN_SESSION_EVENT_TYPES` (`@deepseek-ai/dsh-session` rc.8, emitted by
 * `scripts/gen-persistence-catalog.ts`) contains no `expert-teams/*` types,
 * and there is **no registration surface** — the generator comment states a
 * registration API is "deferred until such a consumer exists". Worse, the
 * durability contract has no writer escape hatch either:
 *
 * - `Session.append(type, data, ...opts)` accepts any type in-process, but
 *   `opts` is a `SurfaceIntent` available **only** for surface-eligible
 *   types — there is no way to write the envelope's `ignorable: true` marker
 *   (`SessionEvent.ignorable`) through append.
 * - The persistence read path (`dsh-session-persistence`
 *   `assertEventsSupported`) refuses to reconstruct any session whose durable
 *   log contains an event type outside the constant **unless** the event
 *   carries `ignorable: true`: such a log "was likely written by a newer
 *   harness", and silently skipping a required event would reconstruct a
 *   wrong session.
 *
 * Consequence: appending `expert-teams/*` events today would work in-process
 * but **poison the captain's session log** — after the next restart the
 * session could no longer be loaded at all. Dropping the records is therefore
 * the only safe behavior in this harness generation, and this module keeps
 * that guard **but makes it observable**: every dropped event is counted
 * (per type + total) and the counters ride the provider-audit payload
 * (`GET /plugins/dsh-expert-library/audit` → `eventsDropped`), so the
 * "provider-called events evaporate" failure is visible instead of silent.
 * Disk state remains the authoritative source for the activity panel.
 *
 * Future harnesses: when `KNOWN_SESSION_EVENT_TYPES` gains a registration
 * surface or `Session.append` exposes an `ignorable` writer, flip the
 * {@link AppendTeamEventOptions.isKnown} seam (or feature-detect the writer)
 * and start appending the marked records.
 *
 * Types and the `SessionEventMap` merge live in `event-types.ts` (zero
 * imports) so the browser program can load them without host augmentations.
 * @module dsh-expert-library/events
 */

import type { Context } from '@deepseek-ai/cordis'
import * as dshSession from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session/types'
import type { ExpertTeamsEventType } from './event-types.ts'

/** Event types already reported as unsupported, to avoid repetitive logs. */
const skippedEventTypes = new Set<ExpertTeamsEventType>()

/** Per-type drop counts since the last {@link resetDroppedSessionEvents}. */
const droppedCounts = new Map<ExpertTeamsEventType, number>()
let droppedTotal = 0

/** Snapshot of the dropped-session-event counters (wire shape of `eventsDropped`). */
export interface DroppedSessionEvents {
  /** Total dropped events across all types. */
  readonly total: number
  /** Drop count per `expert-teams/*` event type (present only when > 0). */
  readonly byType: Partial<Record<ExpertTeamsEventType, number>>
}

/**
 * Live snapshot of the dropped-event counters: events the closed session
 * vocabulary forced this plugin to omit. Frozen; surfaced by the `/audit`
 * route (`eventsDropped`).
 */
export function droppedSessionEvents(): DroppedSessionEvents {
  const byType: Partial<Record<ExpertTeamsEventType, number>> = {}
  for (const [type, count] of droppedCounts) byType[type] = count
  return Object.freeze({ total: droppedTotal, byType: Object.freeze(byType) })
}

/** Test seam: reset the drop counters (module-level state is process-global). */
export function resetDroppedSessionEvents(): void {
  droppedCounts.clear()
  droppedTotal = 0
}

/**
 * The harness's closed event vocabulary, read defensively (the export may not
 * exist in older/newer builds): `true` only for types the running harness
 * recognizes and can durably round-trip.
 */
function harnessRecognizes(type: ExpertTeamsEventType): boolean {
  const known = (dshSession as unknown as {
    KNOWN_SESSION_EVENT_TYPES?: ReadonlySet<string>
  }).KNOWN_SESSION_EVENT_TYPES
  return known?.has(type) === true
}

/** Options of {@link appendTeamEvent}. */
export interface AppendTeamEventOptions {
  /**
   * Override the vocabulary check (tests simulate a harness that recognizes /
   * refuses types; a future harness with a registration surface replaces the
   * default). Defaults to the live `KNOWN_SESSION_EVENT_TYPES` lookup.
   */
  readonly isKnown?: (type: ExpertTeamsEventType) => boolean
}

/**
 * Append one Expert Teams event to a Session, containing failures (a broken
 * durable record must never break team tool execution).
 *
 * Events outside the harness's closed vocabulary are **omitted and counted**:
 * the durable log cannot carry unmarked unknown types (the persistence read
 * path would refuse the whole session on restart), and `Session.append`
 * exposes no `ignorable: true` writer. `droppedSessionEvents()` makes the
 * omission observable via `GET /plugins/dsh-expert-library/audit`.
 *
 * @param ctx - the plugin context (for logging).
 * @param session - the session to record into (the captain's, normally).
 * @param type - the event type.
 * @param data - the event payload.
 * @param options - optional seams (see {@link AppendTeamEventOptions}).
 */
export function appendTeamEvent(
  ctx: Context,
  session: Session,
  type: ExpertTeamsEventType,
  data: SessionEventMap[ExpertTeamsEventType],
  options: AppendTeamEventOptions = {},
): void {
  const isKnown = options.isKnown ?? harnessRecognizes
  if (!isKnown(type)) {
    // Closed-vocabulary drop — counted, logged once per type, never written.
    droppedCounts.set(type, (droppedCounts.get(type) ?? 0) + 1)
    droppedTotal += 1
    if (!skippedEventTypes.has(type)) {
      skippedEventTypes.add(type)
      ctx.logger.debug(
        `expert-teams: session event "${type}" omitted (closed session vocabulary; counted in /audit eventsDropped)`,
      )
    }
    return
  }
  try {
    session.append(type, data)
  } catch (error: unknown) {
    ctx.logger.warn(`expert-teams: session record failed after ${type}: ${String(error)}`)
  }
}

/**
 * Resolve the captain's live Session for event recording. The captain agent
 * may be offline (its team outlives the session), in which case the caller's
 * own session is used as the fallback record target.
 * @param ctx - the plugin context (injects `agents`).
 * @param captainSessionId - the captain's durable session id.
 * @param fallback - the calling agent's session, used when the captain is not live.
 * @returns the session to record into.
 */
export function captainSessionOf(
  ctx: Context,
  captainSessionId: string,
  fallback: Session,
): Session {
  const captain = ctx.agents.get(captainSessionId as SessionId)
  return captain?.session ?? fallback
}
