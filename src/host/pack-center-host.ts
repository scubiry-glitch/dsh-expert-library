/** Plugin-owned lifecycle and actual runtime preflight. No DSH core changes. */
import type { Context } from '@deepseek-ai/cordis'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ToolsConfig } from '../team-core.ts'
import type { CenterManageService } from '../pack-center-wire.ts'
import { builtinLegacyPack } from '../v2/compat.ts'
import { buildZhijianDomainPack } from '../v2/zhijian-pack.ts'
import { buildCollabDomainPack } from '../collab/templates.ts'
import { resolveLibrary } from '../expert-library/registry.ts'
import { preflightManagedActivation } from './pack-runtime.ts'
import { createPackCenterManager } from './pack-center-manager.ts'
import { PackCenterClientError } from './pack-center-client.ts'
import { sanitizePackOperationError } from './pack-center-operations.ts'

export function resolvePackCenterDir(configured: string | undefined, dshHome = process.env['DSH_HOME']): string {
  const explicit = configured?.trim()
  const root = explicit || (dshHome?.trim() ? join(dshHome.trim(), 'expert-library-pack-center') : '')
  if (root && (!isAbsolute(root) || resolve(root) !== root || root === parse(root).root || root === homedir())) {
    throw new PackCenterClientError('CENTER_INVALID_STORAGE')
  }
  return root
}

/** Origin and private storage changes require a plugin restart. In-flight jobs
 * finish against the captured source, and running tasks keep the old inventory.
 * Never silently replace an active local source with an empty new directory. */
export function createPackCenterHost(ctx: Context, config: ToolsConfig, workspaces: () => readonly string[]) {
  type Manager = ReturnType<typeof createPackCenterManager>
  const configured = () => ({ root: resolvePackCenterDir(config.packCenterDir), origin: config.packCenterOrigin?.trim() || undefined })
  let captured: ReturnType<typeof configured> | undefined
  let instance: Promise<Manager | null> | undefined
  let closed = false
  const fail = (code: string): never => { throw new PackCenterClientError(code) }
  function changed() { return captured !== undefined && JSON.stringify(configured()) !== JSON.stringify(captured) }

  async function bases() {
    const knowledgeDir = config.knowledgeDir
    const paths = [...new Set(workspaces().filter(Boolean))]
    if (!paths.length) paths.push(process.cwd())
    const result = [builtinLegacyPack(), buildZhijianDomainPack()]
    for (const path of paths) result.push(buildCollabDomainPack([...(await resolveLibrary(ctx, path, knowledgeDir)).experts.values()]))
    return result
  }
  async function get(): Promise<Manager | null> {
    if (closed) return fail('OPERATION_CLOSED')
    if (!instance) {
      captured = configured()
      const source = captured
      instance = (async () => {
        if (!source.root) {
          if (source.origin) fail('CENTER_INVALID_STORAGE')
          return null
        }
        const metadata = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
        const actualBases = await bases(), builtinVersions: Record<string, string> = {}
        for (const base of actualBases) {
          if (builtinVersions[base.pack.id] && builtinVersions[base.pack.id] !== base.pack.version) fail('CENTER_BASES_REQUIRED')
          builtinVersions[base.pack.id] = base.pack.version
        }
        return createPackCenterManager({ root: source.root, origin: source.origin,
          capabilities: { pluginVersion: metadata.version, packSchemaVersions: [2] }, builtinVersions,
          async validateActivation(state) {
            // Capture the same settings that the runtime consumes, before I/O.
            const selection = { packsDir: config.packsDir, vendorPacksDir: config.vendorPacksDir,
              enabledPacks: config.enabledPacks ? [...config.enabledPacks] : undefined,
              packPriority: config.packPriority ? [...config.packPriority] : undefined }
            try { await preflightManagedActivation(ctx, selection, await bases(), state) } catch (error) {
              // The generic SDK intentionally strips arbitrary callback errors.
              // Project our real resolver's known codes at this host boundary.
              throw new PackCenterClientError(sanitizePackOperationError(error))
            }
          },
        })
      })()
    }
    return instance
  }
  async function invoke<K extends keyof CenterManageService>(key: K, ...args: Parameters<CenterManageService[K]>): Promise<Awaited<ReturnType<CenterManageService[K]>>> {
    const manager = await get()
    if (changed()) fail('CENTER_RESTART_REQUIRED')
    if (!manager) return fail('CENTER_DISABLED')
    const action = manager[key] as (...input: Parameters<CenterManageService[K]>) => ReturnType<CenterManageService[K]>
    return await action(...args) as Awaited<ReturnType<CenterManageService[K]>>
  }
  const service: CenterManageService = {
    async connection() {
      const manager = await get()
      const value = manager ? await manager.connection() : { configured: false, configuredOrigin: null, activationAvailable: false, revision: 0, connection: null }
      return { ...value, ...(changed() ? { errorCode: 'CENTER_RESTART_REQUIRED' } : {}) }
    },
    bind: input => invoke('bind', input), unbind: input => invoke('unbind', input),
    catalog: input => invoke('catalog', input), release: id => invoke('release', id),
    async installations() { const manager = await get(); return manager ? manager.installations() : { generation: 0, mode: 'normal', items: [] } },
    checkUpdates: () => invoke('checkUpdates'),
    async updates() { const manager = await get(); return manager ? manager.updates() : { generation: 0, items: [], hasSnapshot: false, stale: true, checkedAt: null } },
    enqueue: input => invoke('enqueue', input),
    async operations() { const manager = await get(); return manager ? manager.operations() : [] },
    operation: id => invoke('operation', id), retry: id => invoke('retry', id),
    async start() { const manager = await get(); if (manager) await manager.start() },
    async close() { closed = true; const manager = await instance; if (manager) await manager.close() },
  }
  return { service, async activeSnapshot() {
    const manager = await get()
    return manager ? manager.activeSnapshot() : { generation: 0, mode: 'normal' as const, packs: [], suppressedLegacyPaths: [] }
  } }
}
