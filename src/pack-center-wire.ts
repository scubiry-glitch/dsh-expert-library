/** Browser-safe DTOs only. No host imports, credentials, filesystem paths, or PEM text. */
export interface CenterConnectionView {
  configured: boolean
  configuredOrigin: string | null
  activationAvailable: boolean
  revision: number
  connection: null | {
    origin: string; centerId: string; organizationId: string; deploymentId: string
    credentialId: string; credentialExpiresAt: string; boundAt: string; bound: boolean
    signingKeyFingerprints: Record<string, string>
  }
  errorCode?: string
}
export interface CenterReleaseSummary {
  releaseId: string; packId: string; version: string; ownerOrgId: string; name: string; publishedAt: string
  manifestSha256: string; artifactSha256: string; contentTreeSha256: string
  compatibility: { compatible: boolean; reasons: string[] }
  downloadAvailability: { available: boolean; code?: string }
  dependencies: Array<{ packId: string; releaseId: string; version: string }>
}
export interface CenterReleaseDetail extends CenterReleaseSummary {
  sourceCommit: string; notes: string; license: string
  validation: { valid: boolean; diagnostics: Array<{ severity: string; code: string; message: string }> }
  diff: { available: boolean; code?: string; text: string }
}
export interface CenterCatalogView {
  items: CenterReleaseSummary[]; nextCursor: string | null
  checkedAt: string | null; hasSnapshot: boolean; stale: boolean; errorCode?: string
}
export interface CenterInstalledRelease {
  releaseId: string; packId: string; version: string; source: 'center' | 'legacy'
  centerId?: string; ownerOrgId?: string; installedAt: string; active: boolean
  previousReleaseId?: string; artifactSha256: string; contentTreeSha256: string
  manifestSha256?: string
  integrity: 'verified' | 'unavailable'; errorCode?: string
}
export interface CenterInstallationsView {
  generation: number; mode: 'normal' | 'recovered-read-only'
  items: CenterInstalledRelease[]; warningCode?: string
}
export interface CenterUpdatesView {
  checkedAt: string | null; hasSnapshot: boolean; stale: boolean; errorCode?: string
  generation: number
  items: Array<{
    packId: string; current: CenterInstalledRelease
    latestVisible: CenterReleaseSummary | null; candidate: CenterReleaseSummary | null
    candidateCached: boolean
    status: 'update_available' | 'blocked' | 'no_stable_release' | 'up_to_date'
    blockedReasons: Array<{ releaseId: string; reasons: string[] }>
  }>
}
export interface CenterOperationInput {
  operationKey: string
  kind: 'install' | 'update_enable' | 'enable' | 'disable' | 'rollback' | 'uninstall'
  expectedGeneration: number
  releaseId?: string; packId?: string; connectionRevision?: number
  target?: { manifestSha256: string; artifactSha256: string; contentTreeSha256: string }
}
export interface CenterOperationView {
  operationId: string; request: CenterOperationInput
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  phase: string; createdAt: string; updatedAt: string
  result?: { generation: number; outcome: 'succeeded' | 'installed_not_enabled'; releaseId?: string; packId?: string; activated?: boolean; errorCode?: string }
  errorCode?: string
}
export interface CenterBindInput {
  bindingCode: string; expectedRevision: number; expectedCenterId: string
  trustedSigningKeys: Record<string, string>
}
export interface CenterManageService {
  connection(): Promise<CenterConnectionView>
  bind(input: CenterBindInput): Promise<CenterConnectionView>
  unbind(input: { expectedRevision: number }): Promise<CenterConnectionView>
  catalog(input?: { packId?: string; limit?: number; beforeId?: string }): Promise<CenterCatalogView>
  release(id: string): Promise<CenterReleaseDetail>
  installations(): Promise<CenterInstallationsView>
  checkUpdates(): Promise<CenterUpdatesView>
  updates(): Promise<CenterUpdatesView>
  enqueue(input: CenterOperationInput): Promise<CenterOperationView>
  operations(): Promise<CenterOperationView[]>
  operation(id: string): Promise<CenterOperationView>
  retry(id: string): Promise<CenterOperationView>
  start(): Promise<void>
  close(): Promise<void>
}
