/** Domain-owned craft declarations and Host-frozen selections. No domain names or defaults. */
export type SkillCraftRole = 'writer' | 'renderer' | 'reviewer'
export type SkillCraftArtifactRole = 'md' | 'html' | 'pdf' | 'evidence'

/** The only selection fields an AI may submit. Paths, hashes and checks are Host-resolved. */
export interface SkillCraftSelection {
  readonly packId: string
  readonly skillId: string
  readonly variant?: string
  readonly reason: string
}

/** Referenced by SkillPackageManifest.craft; all paths are relative to the owning pack. */
export interface SkillCraftDeclaration {
  readonly schemaVersion: 1
  readonly description: string
  readonly applicability: readonly string[]
  /** Artifact formats this selected policy actually covers; never inferred from names. */
  readonly artifactRoles: readonly SkillCraftArtifactRole[]
  readonly variants?: Readonly<Record<string, { readonly description: string }>>
  /** Same-pack skill IDs: dependencies must be explicitly included in the AI selection. */
  readonly requires?: readonly string[]
  readonly conflicts?: readonly string[]
  readonly materials: readonly {
    readonly id: string
    readonly path: string
    readonly roles: readonly SkillCraftRole[]
    /** Absent applies to every variant. Empty roles keeps a reference out of mandatory prompts. */
    readonly variants?: readonly string[]
  }[]
  readonly checks: readonly {
    readonly id: string
    readonly entrypoint: string
    readonly version: string
    readonly resultIds: readonly string[]
    readonly variants?: readonly string[]
  }[]
  readonly reviewAreas: readonly { readonly id: string; readonly description: string }[]
}

export interface FrozenSkillCraftPack {
  readonly packId: string
  readonly version: string
  /** Host-resolved installed source. Never accepted as part of an AI selection. */
  readonly root: string
  readonly treeDigest: string
  readonly releaseId?: string
}

export interface FrozenSkillCraftContract {
  readonly version: 1
  readonly digest: string
  readonly artifactRoles: readonly SkillCraftArtifactRole[]
  readonly selections: readonly (SkillCraftSelection & {
    readonly skillVersion: string
    readonly skillDigest: string
    readonly declarationPath: string
    readonly declarationDigest: string
  })[]
  readonly packs: readonly FrozenSkillCraftPack[]
  readonly materials: readonly {
    readonly packId: string
    readonly skillId: string
    readonly id: string
    readonly path: string
    readonly sha256: string
    readonly bytes: number
    readonly roles: readonly SkillCraftRole[]
  }[]
  readonly checks: readonly {
    readonly packId: string
    readonly id: string
    readonly entrypoint: string
    readonly sha256: string
    readonly version: string
    readonly resultIds: readonly string[]
  }[]
  readonly reviewAreas: readonly { readonly id: string; readonly description: string }[]
}

/** Generic report transport; the selected pack determines the actual acceptance policy. */
export interface SkillCraftArtifactCheck {
  readonly id: 'selected-skill-craft-v1'
  readonly md: string
  readonly html: string
  readonly pdf: string
  readonly craftEvidence: string
  readonly selection: FrozenSkillCraftContract
}

export interface SkillCraftCheckResult {
  readonly id: string
  readonly status: 'passed' | 'failed' | 'unverified'
  readonly detail: string
}

/** Pack entrypoints receive bytes, never producer-selected local paths or commands. */
export interface SkillCraftRunnerInput {
  readonly protocolVersion: 1
  readonly selections: readonly SkillCraftSelection[]
  readonly resultIds: readonly string[]
  readonly artifacts: Readonly<Record<SkillCraftArtifactRole, {
    readonly id: string
    readonly sha256: string
    readonly content: string
    readonly encoding: 'utf8' | 'base64'
  }>>
  readonly host: { readonly browserExecutablePath?: string }
}
