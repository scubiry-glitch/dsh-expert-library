/** Host-local admission for configured provider streams, including captain calls. */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

type Release = () => void
interface Waiter { admit(): void; cancel(reason: unknown): void }
interface Lane { active: number; waiting: Waiter[] }

/** FIFO admission; never changes messages, routes, results, or retry policy. */
export class ProviderRequestQueue {
  private readonly lanes = new Map<string, Lane>()
  private disposed = false
  constructor(private readonly limitFor: (provider: string) => number | undefined) {}

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
    const release = await this.acquire(options.provider, options.signal)
    try { options.signal?.throwIfAborted(); yield* next() }
    finally { release() }
  }
  dispose(): void {
    this.disposed = true
    for (const lane of this.lanes.values()) {
      for (const waiter of [...lane.waiting]) waiter.cancel(new Error('PROVIDER_REQUEST_QUEUE_DISPOSED'))
    }
  }
}

/** Install once in the Host entry, not once per Agent/preset. */
export function installProviderRequestQueue(ctx: Context, limits: () => Record<string, number> | undefined): void {
  const queue = new ProviderRequestQueue(provider => limits()?.[provider])
  ctx.on('llm/stream', (options, next) => queue.stream(options, next), { global: true })
  ctx.effect(() => () => queue.dispose(), 'expert-library: provider request admission')
}
