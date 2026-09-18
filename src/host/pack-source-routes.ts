/**
 * HTTP surface for onboarding externally-sourced packs, mounted under the
 * existing `/plugins/dsh-expert-library/manage` prefix so it inherits the
 * loopback/token fence registered there (`host/auth.ts`) — these routes are
 * never reachable unauthenticated, and this module does not re-implement that
 * check.
 *
 * Every route re-fetches rather than trusting a previously staged directory:
 * staging state that outlives a request is state an attacker could race, and
 * a re-clone of a pinned revision is cheap and deterministic.
 *
 * @module dsh-expert-library/host/pack-source-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { hashPackageTree } from '../v2/pack-loader.ts'
import type { PackTrustTier } from '../v2/types.ts'
import {
  fetchPackSource,
  installStagedPack,
  isAllowlistedLocator,
  makeStagingDir,
  validateStagedPack,
} from './pack-source.ts'
import {
  findEntry,
  readRegistry,
  removeEntry,
  upsertEntry,
  writeRegistry,
  type PackRegistryEntry,
} from './pack-registry.ts'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Everything the routes need from plugin configuration. */
export interface PackSourceRuntime {
  /** Directory holding vendored packs; empty disables the whole surface. */
  readonly vendorRoot: string
  /** Locator hosts admitted without human review. */
  readonly allowlist: readonly string[]
  /** Ids already installed anywhere (built-in packs plus the ledger). */
  readonly knownPackIds: () => Promise<readonly string[]>
}

/** Read a bounded JSON body. */
function readJson(req: IncomingMessage, maxBytes = 1 << 20): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        resolve(typeof value === 'object' && value !== null ? value as Record<string, unknown> : {})
      } catch (error: unknown) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Handle one pack-source route.
 *
 * @returns true when the route was handled (the caller must not fall through).
 */
export async function handlePackSourceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: PackSourceRuntime,
): Promise<boolean> {
  const path = url.pathname.replace(/\/+$/, '')
  const method = req.method ?? 'GET'
  const base = '/plugins/dsh-expert-library/manage/packs'
  if (!path.startsWith(`${base}/`)) return false
  const leaf = path.slice(base.length + 1)
  if (!['onboard', 'registry', 'rollback', 'vendored'].includes(leaf)) return false

  const send = (status: number, value: unknown): boolean => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
    return true
  }
  const fail = (status: number, error: string): boolean => send(status, { ok: false, error })

  if (runtime.vendorRoot === '') {
    return fail(400, 'vendored packs are disabled: set vendorPacksDir (or DSH_HOME) to enable this surface')
  }

  try {
    // ── GET registry ────────────────────────────────────────────────────────
    if (method === 'GET' && leaf === 'registry') {
      const registry = await readRegistry(runtime.vendorRoot)
      const packs = await Promise.all(registry.packs.map(async (entry) => {
        const dir = join(runtime.vendorRoot, entry.id)
        let installedDigest: string | undefined
        try {
          installedDigest = await hashPackageTree(dir, { exclude: ['generated/'] })
        } catch {
          installedDigest = undefined
        }
        return {
          ...entry,
          /** `clean` when the on-disk tree still matches the recorded digest. */
          state: installedDigest === undefined ? 'missing' : installedDigest === entry.digest ? 'clean' : 'modified',
          rollbackAvailable: entry.previous !== undefined,
        }
      }))
      return send(200, { ok: true, packs })
    }

    // ── POST onboard ────────────────────────────────────────────────────────
    if (method === 'POST' && leaf === 'onboard') {
      const body = await readJson(req)
      const locator = stringField(body, 'locator')
      if (locator === undefined) return fail(400, 'locator is required')
      const ref = stringField(body, 'ref')
      const approve = body['approve'] === true

      const allowlisted = isAllowlistedLocator(locator, runtime.allowlist)
      const trust: PackTrustTier = allowlisted ? 'auto-allowlisted' : approve ? 'reviewed' : 'community'
      if (!allowlisted && !approve) {
        // Fetch and report, but do not install: the reviewer decides with the
        // real diagnostics in hand rather than on the locator alone.
        const staging = await makeStagingDir('review')
        try {
          const fetched = await fetchPackSource({ locator, ...ref === undefined ? {} : { ref }, into: join(staging, 'pack') })
          if (!fetched.ok) return fail(400, fetched.error)
          const validation = await validateStagedPack(join(staging, 'pack'), await runtime.knownPackIds())
          return send(200, {
            ok: false,
            needsReview: true,
            revision: fetched.revision,
            valid: validation.ok,
            packId: validation.packId,
            diagnostics: validation.diagnostics,
            entityCounts: validation.entityCounts,
            hint: 're-send with approve:true to install this revision under the reviewed tier',
          })
        } finally {
          await rm(staging, { recursive: true, force: true }).catch(() => undefined)
        }
      }

      const staging = await makeStagingDir('onboard')
      try {
        const fetched = await fetchPackSource({ locator, ...ref === undefined ? {} : { ref }, into: join(staging, 'pack') })
        if (!fetched.ok) return fail(400, fetched.error)
        const stagedDir = join(staging, 'pack')
        const validation = await validateStagedPack(stagedDir, await runtime.knownPackIds())
        if (!validation.ok || validation.packId === undefined) {
          return send(422, {
            ok: false,
            revision: fetched.revision,
            packId: validation.packId,
            diagnostics: validation.diagnostics,
            entityCounts: validation.entityCounts,
          })
        }
        const installed = await installStagedPack(stagedDir, runtime.vendorRoot, validation.packId)
        if (!installed.ok) return fail(409, installed.error)

        // The in-pack copy is digest-covered, so it is written before the
        // digest is taken; the ledger records the same facts beside the pack.
        const entry: PackRegistryEntry = {
          id: validation.packId,
          locator,
          revision: fetched.revision,
          digest: installed.digest,
          trust,
          installedAt: new Date().toISOString(),
          ...ref === undefined ? {} : { requestedRef: ref },
        }
        const registry = upsertEntry(await readRegistry(runtime.vendorRoot), entry)
        await writeRegistry(runtime.vendorRoot, registry)
        return send(200, {
          ok: true,
          packId: entry.id,
          revision: entry.revision,
          digest: entry.digest,
          trust,
          drift: installed.health.drift,
          entityCounts: validation.entityCounts,
        })
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    // ── POST rollback ───────────────────────────────────────────────────────
    if (method === 'POST' && leaf === 'rollback') {
      const body = await readJson(req)
      const id = stringField(body, 'id')
      if (id === undefined) return fail(400, 'id is required')
      const registry = await readRegistry(runtime.vendorRoot)
      const entry = findEntry(registry, id)
      if (entry === undefined) return fail(404, `pack "${id}" is not in the vendored ledger`)
      if (entry.previous === undefined) return fail(409, `pack "${id}" has no recorded rollback anchor`)
      // The previous tree is not retained, so rollback re-fetches the anchored
      // revision — the ledger stores what to fetch, not a copy nobody verifies.
      const staging = await makeStagingDir('rollback')
      try {
        const fetched = await fetchPackSource({
          locator: entry.locator,
          ref: entry.previous.revision,
          into: join(staging, 'pack'),
        })
        if (!fetched.ok) return fail(400, fetched.error)
        const validation = await validateStagedPack(join(staging, 'pack'), await runtime.knownPackIds())
        if (!validation.ok) return send(422, { ok: false, diagnostics: validation.diagnostics })
        const installed = await installStagedPack(join(staging, 'pack'), runtime.vendorRoot, id)
        if (!installed.ok) return fail(409, installed.error)
        const rolled: PackRegistryEntry = {
          id,
          locator: entry.locator,
          revision: fetched.revision,
          digest: installed.digest,
          trust: entry.trust,
          installedAt: new Date().toISOString(),
          previous: { revision: entry.revision, digest: entry.digest, installedAt: entry.installedAt },
          ...entry.requestedRef === undefined ? {} : { requestedRef: entry.requestedRef },
        }
        await writeRegistry(runtime.vendorRoot, upsertEntry(registry, rolled))
        return send(200, { ok: true, packId: id, revision: rolled.revision, digest: rolled.digest })
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    // ── DELETE vendored ─────────────────────────────────────────────────────
    if (method === 'DELETE' && leaf === 'vendored') {
      const id = url.searchParams.get('id') ?? ''
      if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(id)) return fail(400, 'invalid pack id')
      const registry = await readRegistry(runtime.vendorRoot)
      if (findEntry(registry, id) === undefined) return fail(404, `pack "${id}" is not in the vendored ledger`)
      await rm(join(runtime.vendorRoot, id), { recursive: true, force: true })
      await writeRegistry(runtime.vendorRoot, removeEntry(registry, id))
      return send(200, { ok: true, id })
    }

    return false
  } catch (error: unknown) {
    return fail(500, `pack source route error: ${String(error)}`)
  }
}
