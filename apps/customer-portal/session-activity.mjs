export function workspaceHasRunningTask(state) {
  // The customer gateway reports live Agent activity; durable task status can
  // remain in_progress after the Agent has stopped or is waiting for input.
  return state?.running === true
}

/** Read only the signed-in account's sessions, with bounded backend concurrency. */
export async function readSessionActivity(sessions, readWorkspace, concurrency = 6, deadlineMs = 8_000) {
  const results = Array(sessions.length)
  let failed = 0
  let next = 0
  let settled = 0
  let expired = false
  const workers = Promise.all(Array.from({ length: Math.min(concurrency, sessions.length) }, async () => {
    while (!expired && next < sessions.length) {
      const index = next++
      const session = sessions[index]
      try {
        const state = await readWorkspace(session)
        if (!expired) results[index] = { id: session.id, running: workspaceHasRunningTask(state) }
      } catch { if (!expired) failed++ }
      if (!expired) settled++
    }
  }))
  let timer
  try {
    await Promise.race([workers, new Promise(resolve => {
      timer = setTimeout(() => { expired = true; resolve() }, deadlineMs)
    })])
  } finally { clearTimeout(timer) }
  return { items: results.filter(Boolean), hasUnknown: failed > 0 || settled < sessions.length }
}
