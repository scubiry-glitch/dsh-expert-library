/**
 * Public HTTPS Git -> fixed, normalized domain-pack snapshot. Linux worker only.
 * No checkout, filters, submodules, credentials, repository scripts or hooks run.
 *
 * Production must additionally run this worker on a quota-limited scratch volume:
 * RLIMIT_FSIZE is per-file; aggregate disk monitoring has a short sampling window.
 * Official interfaces verified against local Git 2.43.7:
 * https://git-scm.com/docs/git-config/2.43.0 (curloptResolve/followRedirects/protocol)
 * https://git-scm.com/docs/git-cat-file/2.42.1 (raw blobs, not --filters)
 * https://git-scm.com/docs/git-ls-tree (NUL-delimited, unquoted names)
 */
import { spawn as nodeSpawn, type SpawnOptions, type ChildProcess } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { mkdir, mkdtemp, readdir, lstat, rm, writeFile, rename, chmod } from 'node:fs/promises'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { assertSafePath, canonicalBytes, sha256, validateReport, parseSemVer, type ValidationReport } from '../../../packages/pack-contract/index.mjs'
import { packDirectory, DEFAULT_LIMITS as ARTIFACT_DEFAULT_LIMITS, type ArtifactSummary, type ArtifactLimits } from '../../../packages/pack-artifact/index.mjs'
import type { DomainPackV2 } from '../../../lib/types/pack-validator.js'
import type * as Validator from '../../../lib/types/pack-validator.js'

export class GitSnapshotError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'GitSnapshotError' }
}
function fail(code: string, message: string): never { throw new GitSnapshotError(code, message) }
export interface GitSnapshotLimits {
  timeoutMs?: number; maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number
  maxArchiveBytes?: number; maxGitBytes?: number; maxObjects?: number; maxLogBytes?: number
  maxTreeBytes?: number; maxPathDepth?: number; maxPreviewBytes?: number
}
const defaults: Required<GitSnapshotLimits> = Object.freeze({
  timeoutMs: 120000, maxFiles: 5000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  maxArchiveBytes: 80 * 1024 * 1024, maxGitBytes: 128 * 1024 * 1024, maxObjects: 20000,
  maxLogBytes: 64 * 1024, maxTreeBytes: 4 * 1024 * 1024, maxPathDepth: 32, maxPreviewBytes: 512 * 1024,
})
export interface GitSnapshotInput {
  url: string; ref: string; outputParent: string; allowedHosts: readonly string[]
  validatorVersion: string; limits?: GitSnapshotLimits; signal?: AbortSignal
}
export interface SnapshotPreview {
  files: Array<{ path: string; sizeBytes: number; sha256: string; text?: string; truncated?: boolean }>
  entities: Record<string, string[]>
  entityDigests?: Record<string, Record<string, string>>
  scriptDeclarations: Array<{ skillId: string; path: string }>
  normalization: { version: 1; gitMetadataExcluded: true; generatedPreserved: true; scriptsExecuted: false }
}
export interface GitSnapshot {
  snapshotDir: string; contentDir: string; archiveFile: string
  sourceUrl: string; requestedRef: string; sourceCommit: string; gitVersion: string
  artifact: ArtifactSummary; report: ValidationReport; reportSha256: string; preview: SnapshotPreview
  /** Absent for an invalid V2 package. report.valid=false is never publishable. */
  packMeta?: DomainPackV2['pack']
}

/** Infrastructure seam for isolated transport tests; never populated from HTTP input/config. */
export interface GitSnapshotInfrastructure {
  resolveHostname?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
}

/** Conservative public-unicast policy. IPv4-mapped/transition IPv6 are not admitted. */
export function isPublicGitAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number]
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  const parts = normalized.split(':')
  const first = Number.parseInt(parts[0] ?? '', 16), second = Number.parseInt(parts[1] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
    && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8))
    && !(first === 0x3fff && second <= 0xfff)
}

/** Manual upstream HEAD check: one constrained `git ls-remote <url> <ref>`. */
export async function gitLsRemoteHead(urlString: string, ref: string, allowedHosts: readonly string[]): Promise<string> {
  const url = validateGitSource(urlString, ref, allowedHosts)
  const head = await new Promise<string>((accept, reject) => {
    const child = nodeSpawn('/usr/bin/git', ['ls-remote', url.href, 'HEAD'], {
      env: { PATH: '/usr/bin:/bin', HOME: '/var/lib/pack-center', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_SSL_NO_VERIFY: undefined },
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    const out: Buffer[] = []; let killed = false
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); reject(new GitSnapshotError('GIT_TIMEOUT', 'Upstream check timed out')) }, 30000)
    child.stdout.on('data', b => out.push(b)); child.stderr.resume()
    child.on('close', code => { clearTimeout(timer); if (killed) return
      if (code !== 0) return reject(new GitSnapshotError('GIT_FETCH_FAILED', 'Upstream check failed'))
      const line = Buffer.concat(out).toString('utf8').split('\n').find(l => l.includes('\t'))
      accept(line ? line.split('\t')[0]! : '') })
  })
  return head
}

export function validateGitSource(urlString: string, ref: string, allowedHosts: readonly string[]): URL {
  if (typeof urlString !== 'string' || /[\s\\\x00-\x1f\x7f]/.test(urlString)) fail('GIT_SOURCE_REJECTED', 'Git source must be a plain HTTPS URL')
  let url: URL
  try { url = new URL(urlString) } catch { return fail('GIT_SOURCE_REJECTED', 'Invalid Git URL') }
  // Test-only fixture allowance: PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE exports
  // one exact "hostname:port" loopback HTTPS origin (e.g. "git.fixture.invalid:8443")
  // admitted with an explicit port. Unset (production default) keeps the strict
  // rule: allowlisted DNS hostname, port 443, no credentials, no query/fragment.
  const fixturePair = process.env.PACK_CENTER_GIT_ALLOW_LOOPBACK_FIXTURE
  const fixtureOrigin = fixturePair === undefined || !fixturePair.includes(':') ? null
    : { hostname: fixturePair.slice(0, fixturePair.lastIndexOf(':')), port: fixturePair.slice(fixturePair.lastIndexOf(':') + 1) }
  const fixtureMatch = fixtureOrigin !== null && url.hostname === fixtureOrigin.hostname && url.port === fixtureOrigin.port
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port !== '' && !fixtureMatch)
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(url.hostname) || isIP(url.hostname)
    || !allowedHosts.includes(url.hostname) || !/^\/[A-Za-z0-9._/-]+$/.test(url.pathname)
    || url.pathname.split('/').some(part => part === '..' || part === '.') || url.href !== urlString) {
    fail('GIT_SOURCE_REJECTED', 'Git source requires an exact allowlisted HTTPS hostname on port 443, without credentials, query or fragment')
  }
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 240 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref)
    || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.split('/').some(p => p.endsWith('.lock') || p.startsWith('.'))) {
    fail('GIT_REF_REJECTED', 'Git ref must be HEAD, a commit id, or a plain branch/tag name')
  }
  return url
}

function limitConfig(overrides: GitSnapshotLimits = {}): Required<GitSnapshotLimits> {
  const result = { ...defaults, ...overrides }
  for (const [key, value] of Object.entries(result)) {
    if (!Object.hasOwn(defaults, key) || !Number.isSafeInteger(value) || value <= 0 || value > defaults[key as keyof GitSnapshotLimits] * 10) fail('GIT_LIMIT_CONFIG', 'Invalid Git snapshot limit')
  }
  return result
}
/** Producer limits can tighten, but never exceed default publisher/client limits. */
export function snapshotArtifactLimits(overrides: GitSnapshotLimits = {}): ArtifactLimits {
  const limits = limitConfig(overrides)
  return {
    maxFileBytes: Math.min(limits.maxFileBytes, ARTIFACT_DEFAULT_LIMITS.maxFileBytes),
    maxFiles: Math.min(limits.maxFiles, ARTIFACT_DEFAULT_LIMITS.maxFiles),
    maxEntries: ARTIFACT_DEFAULT_LIMITS.maxEntries,
    maxTotalBytes: Math.min(limits.maxTotalBytes, ARTIFACT_DEFAULT_LIMITS.maxTotalBytes),
    maxArchiveBytes: Math.min(limits.maxArchiveBytes, ARTIFACT_DEFAULT_LIMITS.maxArchiveBytes),
    maxPathDepth: Math.min(limits.maxPathDepth, ARTIFACT_DEFAULT_LIMITS.maxPathDepth),
  }
}
async function directoryBytes(path: string, maximum: number): Promise<number> {
  let bytes = 0
  async function visit(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const p = join(current, entry.name)
      if (entry.isDirectory()) await visit(p)
      else { try { bytes += (await lstat(p)).size } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
      if (bytes > maximum) fail('GIT_DISK_LIMIT', 'Git object storage exceeded its task limit')
    }
  }
  await visit(path)
  return bytes
}
function rawUtf8(bytes: Buffer): string {
  const result = bytes.toString('utf8')
  if (!Buffer.from(result).equals(bytes)) fail('GIT_PATH_REJECTED', 'Git path is not valid UTF-8')
  return result
}

export function createGitSnapshotFetcher(infrastructure: GitSnapshotInfrastructure = {}) {
  const resolveHostname = infrastructure.resolveHostname ?? (hostname => lookup(hostname, { all: true, verbatim: true }))
  const spawn = infrastructure.spawn ?? nodeSpawn
  return async function fetchSnapshot(input: GitSnapshotInput): Promise<GitSnapshot> {
    const url = validateGitSource(input.url, input.ref, input.allowedHosts)
    parseSemVer(input.validatorVersion)
    if (!isAbsolute(input.outputParent)) fail('GIT_OUTPUT_REJECTED', 'Snapshot parent must be absolute and caller-controlled')
    const parent = await lstat(input.outputParent)
    if (!parent.isDirectory() || parent.isSymbolicLink()) fail('GIT_OUTPUT_REJECTED', 'Snapshot parent must be a real directory')
    const limits = limitConfig(input.limits)
    if (input.signal?.aborted) fail('GIT_ABORTED', 'Git snapshot was cancelled')
    const deadline = Date.now() + limits.timeoutMs
    const addresses = await new Promise<Array<{ address: string; family: number }>>((accept, reject) => {
      const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort) }
      const timer = setTimeout(() => { cleanup(); reject(new GitSnapshotError('GIT_TIMEOUT', 'Git DNS lookup timed out')) }, limits.timeoutMs)
      const abort = () => { cleanup(); reject(new GitSnapshotError('GIT_ABORTED', 'Git DNS lookup was cancelled')) }
      input.signal?.addEventListener('abort', abort, { once: true })
      resolveHostname(url.hostname).then(accept, () => reject(new GitSnapshotError('GIT_DNS_FAILED', 'Git hostname resolution failed')))
        .finally(cleanup)
    })
    if (!addresses.length || addresses.some(value => !isPublicGitAddress(value.address) || value.family !== isIP(value.address))) {
      fail('GIT_NETWORK_REJECTED', 'Every resolved Git destination must be public unicast')
    }
    // Pin one approved address; TLS still verifies the original hostname. No redirects.
    const address = addresses[0]!.address
    const pin = `${url.hostname}:443:${isIP(address) === 6 ? `[${address}]` : address}`
    const scratch = await mkdtemp(join(resolve(input.outputParent), '.git-snapshot-'))
    const repository = join(scratch, 'repository.git'), content = join(scratch, 'content'), home = join(scratch, 'home')
    let logBytes = 0
    const children = new Set<ChildProcess>()
    const terminate = (child: ChildProcess) => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } }
    try {
      await chmod(scratch, 0o700)
      await mkdir(home, { mode: 0o700 }); await mkdir(content, { mode: 0o700 })
      const env: NodeJS.ProcessEnv = {
        PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: home, TMPDIR: scratch, LANG: 'C', LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false',
        GIT_ALLOW_PROTOCOL: 'https', GIT_PROTOCOL_FROM_USER: '0', GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_REPLACE_OBJECTS: '1', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0',
      }
      const config = [
        'protocol.allow=never', 'protocol.https.allow=always', 'http.followRedirects=false', 'http.proxy=',
        'http.sslVerify=true', 'http.emptyAuth=false', 'http.delegation=none', 'http.extraHeader=', 'http.cookieFile=',
        'http.saveCookies=false', 'http.curloptResolve=', `http.curloptResolve=${pin}`, 'http.maxRequests=1',
        'http.lowSpeedLimit=1024', 'http.lowSpeedTime=15', 'credential.helper=', 'core.askPass=/bin/false',
        'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'core.fsmonitor=false', 'core.logAllRefUpdates=false',
        'init.templateDir=', 'fetch.recurseSubmodules=false', 'submodule.recurse=false', 'fetch.unpackLimit=1',
        'fetch.fsckObjects=true', 'transfer.fsckObjects=true', 'fetch.writeCommitGraph=false', 'gc.auto=0',
        'maintenance.auto=false', 'pack.threads=1', 'protocol.version=2',
      ].flatMap(value => ['-c', value])
      async function git(args: string[], maxBytes: number, inputBytes?: Buffer): Promise<Buffer> {
        if (input.signal?.aborted) fail('GIT_ABORTED', 'Git snapshot was cancelled')
        const remaining = deadline - Date.now()
        if (remaining <= 0) fail('GIT_TIMEOUT', 'Git snapshot time limit exceeded')
        return new Promise((accept, reject) => {
          const child = spawn('/usr/bin/prlimit', [
            `--fsize=${limits.maxGitBytes}`, '--as=1073741824', `--cpu=${Math.ceil(limits.timeoutMs / 1000) + 1}`, '--nofile=128',
            '--', '/usr/bin/git', ...config, ...args,
          ], { cwd: scratch, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
          children.add(child)
          let failure: Error | undefined, byteCount = 0, settled = false
          const chunks: Buffer[] = []
          const stop = (error: Error) => { failure ??= error; terminate(child) }
          const abort = () => stop(new GitSnapshotError('GIT_ABORTED', 'Git snapshot was cancelled'))
          input.signal?.addEventListener('abort', abort, { once: true })
          const timer = setTimeout(() => stop(new GitSnapshotError('GIT_TIMEOUT', 'Git snapshot time limit exceeded')), remaining)
          let checking = false
          const diskTimer = setInterval(() => {
            if (checking) return
            checking = true
            directoryBytes(scratch, limits.maxGitBytes + limits.maxTotalBytes + limits.maxArchiveBytes).catch(error => stop(error)).finally(() => { checking = false })
          }, 50)
          const finish = (error?: Error) => {
            if (settled) return
            settled = true; children.delete(child); clearTimeout(timer); clearInterval(diskTimer)
            input.signal?.removeEventListener('abort', abort)
            if (failure || error) reject(failure ?? error); else accept(Buffer.concat(chunks))
          }
          child.on('error', error => { failure = new GitSnapshotError('GIT_EXEC_FAILED', `Cannot start isolated Git process: ${error.name}`) })
          child.stdout?.on('data', (chunk: Buffer) => {
            byteCount += chunk.length
            if (byteCount > maxBytes) stop(new GitSnapshotError('GIT_OUTPUT_LIMIT', 'Git command output exceeded its task limit'))
            else chunks.push(chunk)
          })
          child.stderr?.on('data', (chunk: Buffer) => {
            logBytes += chunk.length
            if (logBytes > limits.maxLogBytes) stop(new GitSnapshotError('GIT_LOG_LIMIT', 'Git diagnostic output exceeded its task limit'))
          })
          child.on('close', code => finish(code === 0 ? undefined : new GitSnapshotError('GIT_FETCH_FAILED', 'Git could not produce a trusted snapshot (remote errors are not exposed)')))
          child.stdin?.on('error', () => {})
          child.stdin?.end(inputBytes)
        })
      }
      const gitVersion = (await git(['--version'], 256)).toString().trim()
      const version = /^git version (\d+)\.(\d+)\./.exec(gitVersion)
      if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 43)) fail('GIT_VERSION_UNSUPPORTED', 'Worker requires Git 2.43 or newer with curloptResolve')
      await git(['init', '--bare', '--quiet', '--template=', repository], 4096)
      if (input.ref !== 'HEAD' && !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(input.ref)) await git(['check-ref-format', '--allow-onelevel', input.ref], 4096)
      // --depth=1 is also a security invariant: Git rejects dumb HTTP before its
      // object walker can follow untrusted http-alternates URLs. Do not remove it.
      // https://github.com/git/git/blob/v2.43.7/remote-curl.c#L1083-L1094
      await git(['--git-dir', repository, 'fetch', '--no-tags', '--depth=1', '--no-recurse-submodules', '--no-auto-maintenance', '--quiet', '--', url.href, input.ref], 4096)
      await directoryBytes(repository, limits.maxGitBytes)
      const sourceCommit = (await git(['--git-dir', repository, 'rev-parse', '--verify', 'FETCH_HEAD^{commit}'], 256)).toString().trim()
      if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(sourceCommit)) fail('GIT_COMMIT_INVALID', 'Git did not resolve exactly one commit')
      const allObjects = await git(['--git-dir', repository, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], limits.maxObjects * 96)
      let objectTotal = 0, objectCount = 0
      for (const line of allObjects.toString().trim().split('\n')) {
        const match = /^[a-f0-9]{40,64} (blob|tree|commit|tag) (\d+)$/.exec(line)
        if (!match) fail('GIT_OBJECT_INVALID', 'Git object inventory is malformed')
        objectCount++; objectTotal += Number(match[2])
        if (objectCount > limits.maxObjects || objectTotal > limits.maxGitBytes) fail('GIT_OBJECT_LIMIT', 'Git object count or expanded bytes exceed task limits')
      }
      const listing = await git(['--git-dir', repository, 'ls-tree', '-r', '-l', '-z', sourceCommit], limits.maxTreeBytes)
      const preview: SnapshotPreview = { files: [], entities: {}, entityDigests: {}, scriptDeclarations: [], normalization: { version: 1, gitMetadataExcluded: true, generatedPreserved: true, scriptsExecuted: false } }
      let total = 0, previewBytes = 0
      const paths = new Set<string>()
      for (const entry of rawUtf8(listing).split('\0').filter(Boolean)) {
        const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40,64}) +([0-9]+|-)\t([\s\S]+)$/.exec(entry)
        if (!match || match[2] !== 'blob' || !['100644', '100755'].includes(match[1]!)) fail('GIT_ENTRY_REJECTED', 'Only ordinary Git files are permitted; links and submodules are forbidden')
        const relative = match[5]!, size = Number(match[4])
        try { assertSafePath(relative) } catch { fail('GIT_PATH_REJECTED', 'Git contains an unsafe or non-normalized path') }
        if (relative.split('/').length > limits.maxPathDepth || paths.has(relative)) fail('GIT_PATH_REJECTED', 'Git path is duplicated or too deep')
        paths.add(relative); total += size
        if (paths.size > limits.maxFiles || size > limits.maxFileBytes || total > limits.maxTotalBytes || !Number.isSafeInteger(size)) fail('GIT_CONTENT_LIMIT', 'Git package exceeds file count or byte limits')
        const bytes = await git(['--git-dir', repository, 'cat-file', 'blob', match[3]!], limits.maxFileBytes)
        if (bytes.length !== size) fail('GIT_OBJECT_INVALID', 'Git blob length differs from frozen tree')
        const file = join(content, relative)
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 })
        const item: SnapshotPreview['files'][number] = { path: relative, sizeBytes: size, sha256: sha256(bytes) }
        const text = bytes.toString('utf8')
        if (!bytes.includes(0) && Buffer.from(text).equals(bytes) && previewBytes < limits.maxPreviewBytes) {
          const capacity = Math.min(8192, limits.maxPreviewBytes - previewBytes)
          let end = Math.min(bytes.length, capacity)
          // Do not cut a UTF-8 code point (or emit invalid canonical-JSON strings).
          while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
          item.text = bytes.subarray(0, end).toString('utf8'); item.truncated = end !== bytes.length
          previewBytes += Buffer.byteLength(item.text)
        }
        preview.files.push(item)
      }
      if (input.signal?.aborted) fail('GIT_ABORTED', 'Git snapshot was cancelled')
      if (Date.now() >= deadline) fail('GIT_TIMEOUT', 'Git snapshot time limit exceeded')
      // The plugin build intentionally separates JS in lib/ and declarations in lib/types/.
      const { loadPackFromDir } = await import(new URL('../../../lib/pack-validator.js', import.meta.url).href) as typeof Validator
      const loaded = await loadPackFromDir(content)
      const pack = loaded.pack
      const report: ValidationReport = {
        schemaVersion: 1, validatorVersion: input.validatorVersion, packSchemaVersion: 2,
        valid: loaded.ok, diagnostics: loaded.diagnostics.map(d => ({ ...d })), entityCounts: {},
        permissions: { execScripts: [], internalOnly: false },
      }
      if (pack) {
        for (const key of ['experts', 'scenarios', 'teamTemplates', 'outputTemplates', 'qualityPolicies', 'toolProviders', 'knowledgeProviders', 'domainKnowledge', 'methodPacks', 'skillPackages'] as const) {
          report.entityCounts[key] = pack[key].length
          preview.entities[key] = pack[key].map(entity => entity.id)
          // Review-only semantic fingerprints (not the protocol signing encoder):
          // entities may contain ordinary JSON fractional values. Sort all object
          // keys while preserving arrays so property order alone is not a change.
          preview.entityDigests![key] = Object.fromEntries(pack[key].map(entity => [entity.id, sha256(JSON.stringify(entity, (_name, value: unknown) => {
            if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
            return value
          }))]))
        }
        for (const skill of pack.skillPackages) {
          for (const path of skill.permissions.execScripts) {
            preview.scriptDeclarations.push({ skillId: skill.id, path })
            const entry = `${skill.source.root}/${path}`
            try { assertSafePath(entry); report.permissions!.execScripts.push(entry) }
            catch {
              report.valid = false
              report.diagnostics.push({ severity: 'error', code: 'script-declaration-unsafe', message: 'A declared script does not have a safe package-relative path', path: `skillPackages.${skill.id}.permissions.execScripts` })
            }
          }
          if (skill.permissions.internalOnly || !skill.source.license) report.permissions!.internalOnly = true
        }
      }
      if (!validateReport(report).ok) fail('GIT_REPORT_INVALID', 'Shared validator produced a nonconforming report')
      const artifact = await packDirectory(content, join(scratch, 'artifact.tar'), snapshotArtifactLimits(limits))
      const reportSha256 = sha256(canonicalBytes(report))
      await writeFile(join(scratch, 'report.json'), canonicalBytes(report), { flag: 'wx', mode: 0o600 })
      await writeFile(join(scratch, 'preview.json'), canonicalBytes(preview), { flag: 'wx', mode: 0o600 })
      await rm(repository, { recursive: true, force: true }); await rm(home, { recursive: true, force: true })
      if (input.signal?.aborted) fail('GIT_ABORTED', 'Git snapshot was cancelled')
      if (Date.now() >= deadline) fail('GIT_TIMEOUT', 'Git snapshot time limit exceeded')
      // Only the final rename makes a completed snapshot visible to caller discovery.
      const snapshotDir = join(input.outputParent, `snapshot-${scratch.slice(scratch.lastIndexOf('-') + 1)}`)
      await rename(scratch, snapshotDir)
      return {
        snapshotDir, contentDir: join(snapshotDir, 'content'), archiveFile: join(snapshotDir, 'artifact.tar'),
        sourceUrl: url.href, requestedRef: input.ref, sourceCommit, gitVersion, artifact, report, reportSha256, preview,
        ...(pack ? { packMeta: pack.pack } : {}),
      }
    } catch (error) {
      for (const child of children) terminate(child)
      await rm(scratch, { recursive: true, force: true })
      throw error
    }
  }
}

/** No runtime option can bypass HTTPS, public IP checks, or hostname pinning. */
export const fetchGitSnapshot = createGitSnapshotFetcher()
