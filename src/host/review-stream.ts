import type { ServerResponse } from 'node:http'
import type { ConversationPage } from './review-conversation.ts'
import type { ReviewSessionEvent } from './review-event-hub.ts'

/** Subscribe before reading: live messages must never overtake replay cursors. */
export async function openReviewStream(res: ServerResponse, options: {
  after: number
  expiresAt: number
  subscribe: (listener: (event: ReviewSessionEvent) => void) => () => void
  read: (after: number, latest: boolean) => Promise<ConversationPage>
  authorized: () => Promise<boolean>
  heartbeatMs?: number
  stateUpdates?: boolean
}): Promise<void> {
  let closed = false
  let replaying = true
  let cursor = options.after
  let pendingBytes = 0
  const pending: ReviewSessionEvent[] = []
  let unsubscribe = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let checking = false
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    pending.length = 0
    res.off('close', cleanup)
    res.off('error', close)
  }
  const close = () => { cleanup(); if (!res.destroyed) res.end() }
  const send = (name: string, payload: unknown, seq?: number): boolean => {
    if (closed || res.destroyed) return false
    if (Date.now() >= options.expiresAt) { close(); return false }
    try {
      // A false write has accepted this frame, but a slow consumer must reconnect
      // from the last frame it actually received instead of growing Host memory.
      if (!res.write(`${seq === undefined || seq < 0 ? '' : `id: ${seq}\n`}event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)) close()
    } catch { close() }
    return !closed
  }
  const deliver = (event: ReviewSessionEvent) => {
    if (event.type === 'conversation') {
      if (event.message.seq <= cursor) return
      if (send('conversation', event.message, event.message.seq)) cursor = event.message.seq
    } else if (event.type === 'close') close()
    else if (event.type === 'assistant') send('assistant', event.value)
    else send('state', {})
  }
  res.on('close', cleanup)
  res.on('error', close)
  try {
    const dispose = options.subscribe(event => {
      if (closed) return
      if (!replaying) { deliver(event); return }
      pendingBytes += Buffer.byteLength(JSON.stringify(event))
      if (pending.length >= 512 || pendingBytes > 2 * 1024 * 1024) { close(); return }
      pending.push(event)
    })
    unsubscribe = dispose
    if (closed) { dispose(); return }
    heartbeat = setInterval(() => {
      if (closed || res.destroyed) { close(); return }
      if (checking) return
      checking = true
      void options.authorized().then(valid => {
        if (!valid) { send('access-expired', {}); close(); return }
        send('heartbeat', {})
      }).catch(close).finally(() => { checking = false })
    }, options.heartbeatMs ?? 15_000)
    heartbeat.unref()
    if (cursor < 0) {
      const page = await options.read(-1, true)
      if (!send('snapshot', page, page.nextCursor)) return
      cursor = page.nextCursor
    } else {
      // Replay every page, never jump to the latest page after a long outage.
      // Bound work per connection; EventSource resumes from checkpoint on retry.
      for (let count = 0; !closed; count++) {
        const page = await options.read(cursor, false)
        if (closed) return
        if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < cursor
          || (page.hasMore && page.nextCursor === cursor)) throw Error('invalid conversation cursor')
        for (const message of page.messages) deliver({ type: 'conversation', message })
        cursor = Math.max(cursor, page.nextCursor)
        if (!send('checkpoint', { cursor }, cursor)) return
        if (!page.hasMore) break
        if (count >= 99) { close(); return }
      }
    }
    if (closed) return
    replaying = false
    for (const event of pending) deliver(event)
    pending.length = 0
    send('ready', { cursor, protocol: 2, stateUpdates: options.stateUpdates === true }, cursor)
  } catch {
    // Do not advance the durable cursor on read failure.
    send('resync', {})
    close()
  }
}
