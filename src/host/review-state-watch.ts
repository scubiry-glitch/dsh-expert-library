import { watchFile, unwatchFile } from 'node:fs'
import { join } from 'node:path'
import type { TeamRouteTarget } from './team-routes.ts'

/** Passive metadata checks, shared by file; no team parsing or agent activation. */
export function createReviewStateWatch(interval = 2000) {
  const files = new Map<string, { listeners: Set<() => void>; changed: () => void }>()
  const subscribe = (target: TeamRouteTarget, listener: () => void): (() => void) => {
    const paths = [
      ...(target.teamId ? [join(target.stateRoot, target.archived ? 'archive' : '', target.teamId, 'team.json')] : []),
      ...(target.planId ? [join(target.stateRoot, 'plans', `${target.planId}.json`)] : []),
    ]
    for (const path of paths) {
      let entry = files.get(path)
      if (!entry) {
        const listeners = new Set<() => void>()
        const changed = () => { for (const notify of listeners) { try { notify() } catch { /* isolate consumers */ } } }
        entry = { listeners, changed }
        files.set(path, entry)
        watchFile(path, { persistent: false, interval, bigint: true }, changed)
      }
      entry.listeners.add(listener)
    }
    return () => {
      for (const path of paths) {
        const entry = files.get(path)
        entry?.listeners.delete(listener)
        if (entry && !entry.listeners.size) { unwatchFile(path, entry.changed); files.delete(path) }
      }
    }
  }
  return {
    subscribe,
    close() {
      for (const [path, entry] of files) unwatchFile(path, entry.changed)
      files.clear()
    },
  }
}
