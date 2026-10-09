export interface ArtifactSummary {
  artifactSha256: string;
  /** The original, uncompressed tar byte length. */
  sizeBytes: number;
  contentTreeSha256: string;
  fileCount: number;
  /** Sum of regular-file lengths, excluding tar headers and padding. */
  contentSizeBytes: number;
}
export type ExpectedArtifact = Pick<ArtifactSummary, 'artifactSha256' | 'sizeBytes' | 'contentTreeSha256' | 'fileCount'>;
export interface ArtifactLimits {
  maxArchiveBytes?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  maxEntries?: number;
  maxPathDepth?: number;
}
export const DEFAULT_LIMITS: Readonly<Required<ArtifactLimits>>;
/** root must be a caller-owned frozen tree; output's parent must exist. Never overwrites. */
export function packDirectory(root: string, outputFile: string, limits?: ArtifactLimits): Promise<ArtifactSummary>;
/** expected must come from a previously authenticated manifest. destination must not exist. */
export function extractArtifact(archiveFile: string, destination: string, expected: ExpectedArtifact, limits?: ArtifactLimits): Promise<ArtifactSummary>;
