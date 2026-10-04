/** Read the Host-owned settings from a preset without registering a second owner. */
import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import type { Config } from './index.ts'
import type { ToolsConfig } from './team-core.ts'
import {
  effectiveMemberModel,
  EXPERT_LIBRARY_SETTINGS_NAMESPACE,
  normalizeUpdatePolicy,
  type ExpertLibrarySettings,
} from './settings.ts'

/**
 * A standing preset can be mounted before the Host settings namespace exists.
 * Resolve each read against the current service instead of retaining its first
 * value or installing another namespace. Already-created members and approved
 * plans still own their frozen routes; only new selections consume this view.
 */
export function presetToolsConfig(ctx: Context, entry: Config): ToolsConfig {
  const settings = (): ExpertLibrarySettings | undefined =>
    ctx.get('settings')?.get(EXPERT_LIBRARY_SETTINGS_NAMESPACE) as ExpertLibrarySettings | undefined
  const value = <K extends keyof ExpertLibrarySettings>(key: K): ExpertLibrarySettings[K] =>
    settings()?.[key] ?? entry[key]

  return {
    get stateDir() { return value('stateDir') ?? 'expert-teams' },
    get memberProvider() { return value('memberProvider') ?? 'spawn' },
    get memberModel() { return effectiveMemberModel(settings()) ?? effectiveMemberModel(entry) },
    // Preserve the standalone preset's historical fallback. A registered Host
    // namespace supplies its own explicit value (including zero) above it.
    get memberMaxDepth() { return value('memberMaxDepth') ?? 1 },
    get maxActiveMembers() { return value('maxActiveMembers') ?? 2 },
    get maxMembers() { return value('maxMembers') ?? 8 },
    get knowledgeDir() { return value('knowledgeDir') ?? 'knowledge' },
    get packsDir() { return value('packsDir') ?? 'domain-packs' },
    get expertModelOverrides() { return value('expertModelOverrides') },
    get toolExecution() { return value('toolExecution') },
    get enabledPacks() { return value('enabledPacks') },
    get packPriority() { return value('packPriority') },
    get vendorPacksDir() {
      const current = settings()
      const configured = current?.vendorPacksDir ?? entry.vendorPacksDir
      if (current === undefined) return configured
      // Match the Host's empty vendor-root convention without creating or
      // starting another pack center inside the preset.
      const explicit = configured?.trim()
      if (explicit) return explicit
      const home = process.env['DSH_HOME']?.trim()
      return home ? join(home, 'vendor-packs') : ''
    },
    get packCenterOrigin() { return value('packCenterOrigin') },
    get packCenterDir() { return value('packCenterDir') },
    get packCenterUpdatePolicy() { return normalizeUpdatePolicy(value('packCenterUpdatePolicy')) },
    get packSourceAllowlist() { return value('packSourceAllowlist') },
  }
}
