import type { KeyLike } from 'node:crypto'

export const SCHEMA_VERSION: 1
export const PROTOCOL_VERSION: 1
export const ERROR_CODES: readonly string[]
export interface ContractIssue { path: string; code: string; message: string }
export interface ValidationResult { ok: boolean; issues: ContractIssue[] }
export class ContractError extends Error {
  code: string
  details: ContractIssue[]
  constructor(code: string, message: string, details?: ContractIssue[])
}
export interface ParsedSemVer { major: string; minor: string; patch: string; prerelease: string[]; build: string[] }
export function parseSemVer(value: string): ParsedSemVer
export function compareSemVer(a: string, b: string): -1 | 0 | 1

export type DistributionScope =
  | { kind: 'organization' }
  | { kind: 'authenticated' }
  | { kind: 'selected'; organizationIds: string[]; deploymentIds: string[] }
export type Principal =
  | { kind: 'human'; userId: string; organizationId: string; roles: Array<'developer' | 'reviewer' | 'admin'> }
  | { kind: 'deployment'; deploymentId: string; organizationId: string; scopes: Array<'catalog:read' | 'release:download'> }
export interface VersionInterval { minVersion: string; maxVersionExclusive?: string }
export interface DependencyLock {
  packId: string
  ownerOrgId: string
  releaseId: string
  version: string
  artifactSha256: string
  contentTreeSha256: string
}
export interface BuiltinDependency extends VersionInterval { packId: string }
export interface ReleaseManifest {
  schemaVersion: 1
  protocolVersion: 1
  normalizationVersion: 1
  digestAlgorithmVersion: 1
  signatureAlgorithm: 'Ed25519'
  archiveFormat: 'tar'
  centerId: string
  releaseId: string
  packId: string
  ownerOrgId: string
  version: string
  sourceCommit: string
  artifactSha256: string
  contentTreeSha256: string
  reportSha256: string
  validatorVersion: string
  packSchemaVersion: 2
  requiresPlugin: VersionInterval
  dependencyLock: DependencyLock[]
  builtinDependencies: BuiltinDependency[]
  /** Exact downloadable uncompressed tar byte length, NOT the sum of file sizes. */
  sizeBytes: number
  fileCount: number
  approvedSubmissionId: string
  signingKeyId: string
}
/** Read-only catalog metadata can describe versions the installer must refuse. Shape remains catalog v1. */
export interface CatalogRelease extends Omit<ReleaseManifest, 'schemaVersion' | 'protocolVersion' | 'normalizationVersion' | 'digestAlgorithmVersion' | 'signatureAlgorithm' | 'archiveFormat' | 'packSchemaVersion'> {
  schemaVersion: number
  protocolVersion: number
  normalizationVersion: number
  digestAlgorithmVersion: number
  signatureAlgorithm: string
  archiveFormat: string
  packSchemaVersion: number
}
export type SubmissionStatus = 'draft' | 'validating' | 'validation_failed' | 'validated' | 'pending_review' | 'approved' | 'changes_requested' | 'rejected' | 'withdrawn'
export interface SubmissionSnapshot {
  sourceCommit: string
  artifactSha256: string
  contentTreeSha256: string
  reportSha256: string
  validatorVersion: string
  sizeBytes: number
  fileCount: number
}
export interface Submission {
  schemaVersion: 1
  submissionId: string
  ownerOrgId: string
  authorId: string
  packId: string
  version: string
  stateVersion: number
  status: SubmissionStatus
  source: { url: string; ref: string }
  distribution: DistributionScope
  snapshot?: SubmissionSnapshot
  previousSubmissionId?: string
}
export interface ValidationReport {
  schemaVersion: 1
  validatorVersion: string
  packSchemaVersion: 2
  valid: boolean
  diagnostics: Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string; path?: string }>
  entityCounts: Record<string, number>
  permissions?: { execScripts: string[]; internalOnly: boolean }
}
export type OperationKind = 'install' | 'enable' | 'disable' | 'update' | 'update_enable' | 'rollback' | 'uninstall'
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export interface Operation {
  schemaVersion: 1
  operationId: string
  kind: OperationKind
  status: OperationStatus
  packId: string
  idempotencyKey: string
  expectedGeneration: number
  target?: { releaseId: string; artifactSha256: string; contentTreeSha256: string }
  resultGeneration?: number
  error?: { code: string; message: string }
}
export interface ContractMap {
  release: ReleaseManifest
  submission: Submission
  report: ValidationReport
  operation: Operation
  scope: DistributionScope
  principal: Principal
}
export function validateReleaseManifest(value: unknown): ValidationResult
export function validateCatalogRelease(value: unknown): ValidationResult
export function validateSubmission(value: unknown): ValidationResult
export function validateReport(value: unknown): ValidationResult
export function validateOperation(value: unknown): ValidationResult
export function validateDistributionScope(value: unknown): ValidationResult
export function validatePrincipal(value: unknown): ValidationResult
export function assertContract<K extends keyof ContractMap>(kind: K, value: unknown): ContractMap[K]
export const TRANSITIONS: Readonly<Record<'submission' | 'release' | 'operation', Readonly<Record<string, readonly string[]>>>>
/** State edge only. Caller MUST enforce identity, snapshot, report, CAS and transaction requirements. */
export function assertTransition(kind: 'submission' | 'release' | 'operation', from: string, to: string): void

export function canonicalJson(value: unknown): string
export function canonicalBytes(value: unknown): Buffer
export function sha256(bytes: string | Uint8Array): string
export function assertSafePath(path: string): string
export interface TreeFile { path: string; sizeBytes: number; sha256: string }
export interface TreeDigest { contentTreeSha256: string; fileCount: number; sizeBytes: number; files: TreeFile[] }
export function hashContentTree(entries: ReadonlyArray<{ path: string; bytes: Uint8Array }>): TreeDigest
export function hashContentDirectory(root: string): Promise<TreeDigest>
export interface SignedReleaseManifest { manifest: ReleaseManifest; signature: string }
export function manifestSigningBytes(manifest: ReleaseManifest): Buffer
export function signReleaseManifest(manifest: ReleaseManifest, privateKey: KeyLike): SignedReleaseManifest
export function verifyReleaseManifest(envelope: unknown, trustedKeys: ReadonlyMap<string, KeyLike> | Record<string, KeyLike>): ReleaseManifest
export interface Capabilities { pluginVersion: string; packSchemaVersions?: readonly number[] }
export function checkCompatibility(manifest: CatalogRelease, capabilities: Capabilities): { compatible: boolean; reasons: string[] }
export interface UpdateSelection {
  current: ReleaseManifest
  latestVisible: CatalogRelease | null
  candidate: ReleaseManifest | null
  blockedReasons: Array<{ releaseId: string; reasons: string[] }>
  candidateCached: boolean
  status: 'update_available' | 'blocked' | 'no_stable_release' | 'up_to_date'
}
/** Dependencies, reverse dependencies, authorization and local integrity are rechecked by the installer. */
export function selectUpdateCandidate(input: {
  current: ReleaseManifest
  releases: readonly CatalogRelease[]
  capabilities: Capabilities
  cachedReleaseIds?: readonly string[]
}): UpdateSelection
