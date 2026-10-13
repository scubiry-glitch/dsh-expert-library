/** Host-local admission for configured provider streams, including captain calls. */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'

type Release = () => void
interface Waiter { admit(): void; cancel(reason: unknown): void }
interface Lane { active: number; waiting: Waiter[] }
interface RequestTiming {
  sequence: number; sessionId: string | null; provider: string; model: string;
  queuedAt: number; admittedAt?: number; endedAt?: number; waitMs?: number; streamMs?: number;
  status: 'waiting' | 'active' | 'finished' | 'closed' | 'failed' | 'canceled' | 'rejected';
}

/** FIFO admission; never changes messages, routes, results, or retry policy. */
export class ProviderRequestQueue {
  private readonly lanes = new Map<string, Lane>()
  private disposed = false
  private readonly generation = randomUUID()
  private readonly timings: RequestTiming[] = []
  private sequence = 0
  constructor(private readonly limitFor: (provider: string) => number | undefined) {}

  /** Bounded Host-generation diagnostics; never stores messages, tools, errors or credentials. */
  snapshot() {
    return { generation: this.generation, capturedAt: Date.now(), capacity: 2048,
      totalRequests: this.sequence, evicted: this.sequence - this.timings.length,
      requests: this.timings.map(row => ({ ...row })) }
  }

  private limit(provider: string): number {
    const n = this.limitFor(provider)
    return Number.isSafeInteger(n) && n! >= 1 ? n! : Infinity
  }
  private drain(provider: string, lane: Lane): void {
    while (!this.disposed && lane.waiting.length && lane.active < this.limit(provider)) {
      lane.waiting.shift()!.admit()
    }
    if (lane.active === 0 && lane.waiting.length === 0 && this.lanes.get(provider) === lane) this.lanes.delete(provider)
  }
  acquire(provider: string, signal?: AbortSignal): Promise<Release> {
    if (this.disposed) return Promise.reject(new Error('PROVIDER_REQUEST_QUEUE_DISPOSED'))
    if (signal?.aborted) return Promise.reject(signal.reason)
    const lane = this.lanes.get(provider) ?? { active: 0, waiting: [] }
    if (lane.waiting.length >= 128) return Promise.reject(new Error('PROVIDER_REQUEST_QUEUE_FULL'))
    this.lanes.set(provider, lane)
    return new Promise<Release>((resolve, reject) => {
      let pending = true
      const cleanup = (): void => signal?.removeEventListener('abort', aborted)
      const waiter: Waiter = {
        admit: () => {
          if (!pending) return
          pending = false; cleanup(); lane.active++
          let released = false
          resolve(() => {
            if (released) return
            released = true; lane.active--; this.drain(provider, lane)
          })
        },
        cancel: reason => {
          if (!pending) return
          pending = false; cleanup()
          const index = lane.waiting.indexOf(waiter)
          if (index !== -1) lane.waiting.splice(index, 1)
          reject(reason); this.drain(provider, lane)
        },
      }
      const aborted = (): void => waiter.cancel(signal?.reason)
      lane.waiting.push(waiter)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
      else this.drain(provider, lane)
    })
  }
  async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const queued = performance.now()
    const row: RequestTiming = { sequence: ++this.sequence, sessionId: options.sessionId ?? null,
      provider: options.provider, model: options.model, queuedAt: Date.now(), status: 'waiting' }
    this.timings.push(row)
    if (this.timings.length > 2048) this.timings.shift()
    let release: Release
    try { release = await this.acquire(options.provider, options.signal) }
    catch (error) {
      row.status = options.signal?.aborted ? 'canceled' : 'rejected'
      row.endedAt = Date.now(); row.waitMs = Math.max(0, performance.now() - queued)
      throw error
    }
    const admitted = performance.now()
    row.admittedAt = Date.now(); row.waitMs = Math.max(0, admitted - queued); row.status = 'active'
    try { options.signal?.throwIfAborted(); yield* next(); row.status = 'finished' }
    catch (error) { row.status = options.signal?.aborted ? 'canceled' : 'failed'; throw error }
    finally {
      if (row.status === 'active') row.status = 'closed'
      row.endedAt = Date.now(); row.streamMs = Math.max(0, performance.now() - admitted)
      release()
    }
  }
  dispose(): void {
    this.disposed = true
    for (const lane of this.lanes.values()) {
      for (const waiter of [...lane.waiting]) waiter.cancel(new Error('PROVIDER_REQUEST_QUEUE_DISPOSED'))
    }
  }
}

/** Install once in the Host entry, not once per Agent/preset. */
export function installProviderRequestQueue(ctx: Context, limits: () => Record<string, number> | undefined): ProviderRequestQueue {
  const queue = new ProviderRequestQueue(provider => limits()?.[provider])
  ctx.on('llm/stream', (options, next) => queue.stream(options, next), { global: true })
  ctx.effect(() => () => queue.dispose(), 'expert-library: provider request admission')
  return queue
}
