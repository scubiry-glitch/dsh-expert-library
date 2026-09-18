/**
 * The vendored-pack ledger: which externally-sourced packs are installed, at
 * which immutable revision, and where to roll back to.
 *
 * It lives *beside* the vendor root, not inside any pack, so recording an
 * install never perturbs a pack's own tree digest. The in-pack copy of the
 * same facts is `PackMeta.provenance`, which *is* digest-covered — the two are
 * written together and a mismatch between them means someone edited one side.
 *
 * Reads are fail-soft (a missing or malformed ledger reads as empty: an
 * unreadable ledger must not take the plugin down). Writes are atomic
 * (tmp + rename), mirroring `host/manage.ts`.
 *
 * @module dsh-expert-library/host/pack-registry
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { PackTrustTier } from '../v2/types.ts'

/** Ledger file name under the vendor root. */
export const REGISTRY_FILE = 'registry.json'

/** Current ledger schema version. */
export const REGISTRY_SCHEMA_VERSION = 1

/** One installed pack, with the anchor needed to undo the last install. */
export interface PackRegistryEntry {
  /** Pack id (must match `pack.json`). */
  readonly id: string
  /** Fetch locator, recorded verbatim as given. */
  readonly locator: string
  /** Immutable revision currently installed — a commit id, never a branch. */
  readonly revision: string
  /** Pack tree digest at install time. */
  readonly digest: string
  /** Ref the operator asked for before resolution, when one was given. */
  readonly requestedRef?: string
  /** License identifier the source declared, when it declared one. */
  readonly license?: string
  /** Tier this install was admitted under. */
  readonly trust: PackTrustTier
  /** Install instant, ISO-8601. */
  readonly installedAt: string
  /** The revision this install replaced, kept as the rollback anchor. */
  readonly previous?: {
    readonly revision: string
    readonly digest: string
    readonly installedAt: string
  }
}

/** The ledger document. */
export interface PackRegistry {
  readonly schemaVersion: number
  readonly packs: readonly PackRegistryEntry[]
}

/** An empty ledger. */
export function emptyRegistry(): PackRegistry {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, packs: [] }
}

/** Ledger path under one vendor root. */
export function registryPath(vendorRoot: string): string {
  return join(vendorRoot, REGISTRY_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

const TRUST_TIERS: readonly string[] = ['reviewed', 'auto-allowlisted', 'community']

/** Parse one entry, dropping anything that fails the shape check. */
function parseEntry(value: unknown): PackRegistryEntry | undefined {
  if (!isRecord(value)) return undefined
  const id = stringOf(value['id'])
  const locator = stringOf(value['locator'])
  const revision = stringOf(value['revision'])
  const digest = stringOf(value['digest'])
  const trust = stringOf(value['trust'])
  const installedAt = stringOf(value['installedAt'])
  if (id === undefined || locator === undefined || revision === undefined) return undefined
  if (digest === undefined || trust === undefined || installedAt === undefined) return undefined
  if (!TRUST_TIERS.includes(trust)) return undefined
  const previousRaw = value['previous']
  const previous = isRecord(previousRaw)
    && stringOf(previousRaw['revision']) !== undefined
    && stringOf(previousRaw['digest']) !== undefined
    && stringOf(previousRaw['installedAt']) !== undefined
    ? {
        revision: stringOf(previousRaw['revision'])!,
        digest: stringOf(previousRaw['digest'])!,
        installedAt: stringOf(previousRaw['installedAt'])!,
      }
    : undefined
  return {
    id,
    locator,
    revision,
    digest,
    trust: trust as PackTrustTier,
    installedAt,
    ...stringOf(value['requestedRef']) === undefined ? {} : { requestedRef: stringOf(value['requestedRef'])! },
    ...stringOf(value['license']) === undefined ? {} : { license: stringOf(value['license'])! },
    ...previous === undefined ? {} : { previous },
  }
}

/**
 * Parse a ledger document. Unparseable input, or an unknown schema version,
 * yields an empty ledger rather than throwing — a damaged ledger must not
 * block the plugin, and every write re-establishes a valid one.
 */
export function parseRegistry(raw: unknown): PackRegistry {
  if (!isRecord(raw)) return emptyRegistry()
  if (raw['schemaVersion'] !== REGISTRY_SCHEMA_VERSION) return emptyRegistry()
  const packs = Array.isArray(raw['packs']) ? raw['packs'] : []
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    packs: packs.map(parseEntry).filter((entry): entry is PackRegistryEntry => entry !== undefined),
  }
}

/** Read the ledger; missing or malformed reads as empty. */
export async function readRegistry(vendorRoot: string): Promise<PackRegistry> {
  try {
    return parseRegistry(JSON.parse(await readFile(registryPath(vendorRoot), 'utf8')))
  } catch {
    return emptyRegistry()
  }
}

/** Write the ledger atomically (tmp + rename). */
export async function writeRegistry(vendorRoot: string, registry: PackRegistry): Promise<void> {
  await mkdir(vendorRoot, { recursive: true })
  const target = registryPath(vendorRoot)
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

/** One entry by pack id. */
export function findEntry(registry: PackRegistry, id: string): PackRegistryEntry | undefined {
  return registry.packs.find(entry => entry.id === id)
}

/**
 * Insert or replace one entry, carrying the replaced revision forward as the
 * rollback anchor. A first-time install has no anchor.
 */
export function upsertEntry(registry: PackRegistry, entry: PackRegistryEntry): PackRegistry {
  const existing = findEntry(registry, entry.id)
  const next: PackRegistryEntry = existing === undefined || entry.previous !== undefined
    ? entry
    : {
        ...entry,
        previous: { revision: existing.revision, digest: existing.digest, installedAt: existing.installedAt },
      }
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    packs: [...registry.packs.filter(item => item.id !== entry.id), next],
  }
}

/** Drop one entry. */
export function removeEntry(registry: PackRegistry, id: string): PackRegistry {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    packs: registry.packs.filter(entry => entry.id !== id),
  }
}
