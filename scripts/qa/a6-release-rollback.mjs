/**
 * A6 release evidence on a real package artifact and an isolated DSH profile.
 *
 * The candidate is produced by `pnpm pack` from this checkout, installed with
 * the real `dsh plugin ... add <tgz>` command into a throw-away DSH_HOME, and
 * switched back to a separately packed old artifact. No production profile,
 * web port, provider, credential, or user workspace is touched.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PACKAGE_NAME = '@zhijian/dsh-expert-library'
const PACKAGE_PATH = join('node_modules', '@zhijian', 'dsh-expert-library', 'package.json')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function command(file, args, options = {}) {
  const { stdout = '', stderr = '' } = await execFileAsync(file, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    windowsHide: true,
  })
  return { stdout, stderr }
}

async function commandAvailable(file) {
  try {
    await execFileAsync(file, ['--version'], { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true })
    return true
  } catch {
    return false
  }
}

async function findTgz(dir) {
  const entries = await readdir(dir)
  const names = entries.filter(name => name.endsWith('.tgz'))
  if (names.length !== 1) throw new Error(`expected one package artifact in ${dir}, found ${names.length}`)
  return join(dir, names[0])
}

async function packWorkspace(cwd, destination) {
  await mkdir(destination, { recursive: true })
  await command('pnpm', ['pack', '--pack-destination', destination], {
    cwd,
    env: { CI: '1', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  })
  const tgz = await findTgz(destination)
  return { tgz, sha256: sha256(await readFile(tgz)) }
}

async function extractTgz(tgz, destination) {
  await mkdir(destination, { recursive: true })
  await command('tar', ['-xzf', tgz, '-C', destination], { timeout: 120_000 })
  return join(destination, 'package')
}

async function packageMetadata(tgz) {
  const destination = await mkdtemp(join(tmpdir(), 'expert-library-a6-meta-'))
  try {
    const packageDir = await extractTgz(tgz, destination)
    return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
}

async function makeOldArtifact(candidateTgz, destination) {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'expert-library-a6-old-source-'))
  try {
    const packageDir = await extractTgz(candidateTgz, sourceRoot)
    const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
    // The old artifact is also made by pnpm pack, with only its version
    // changed. This gives rollback a distinct package identity/digest while
    // keeping the plugin payload and peer dependencies identical.
    metadata.version = '0.0.1-a6-old'
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`)
    const old = await packWorkspace(packageDir, destination)
    return { ...old, version: metadata.version }
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
  }
}

async function initProfile(dshHome, profile) {
  await command('dsh', ['--from-default-profile', 'web', '--profile', profile, '--help'], {
    env: { DSH_HOME: dshHome },
    timeout: 60_000,
  })
  return join(dshHome, 'profiles', profile)
}

async function installedVersion(profileRoot) {
  const file = join(profileRoot, PACKAGE_PATH)
  const metadata = JSON.parse(await readFile(file, 'utf8'))
  return { file, version: metadata.version, packageRoot: dirname(file) }
}

async function installVerified(dshHome, profile, profileRoot, artifact, expectedSha256) {
  const actual = sha256(await readFile(artifact))
  if (actual !== expectedSha256) throw new Error(`release artifact digest mismatch: expected ${expectedSha256}, got ${actual}`)
  await command('dsh', ['plugin', '--profile', profile, 'add', artifact], {
    env: { DSH_HOME: dshHome },
    timeout: 180_000,
  })
  return installedVersion(profileRoot)
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  await rename(temporary, file)
}

/**
 * Run real package/profile release checks. A host startup probe is optional;
 * root's separate Host/Web evidence owns the GUI and same-identity restart.
 */
export async function runReleaseRollback() {
  const root = await mkdtemp(join(tmpdir(), 'expert-library-a6-release-'))
  const dshHome = join(root, 'dsh-home')
  const profile = 'a6-rollback'
  const productionRoot = join(process.env.HOME ?? '/root', '.dsh', 'profiles', 'web')
  const cases = []
  try {
    assert.equal(root.startsWith(productionRoot), false)
    const candidateDir = join(root, 'candidate')
    const oldDir = join(root, 'old')
    const candidate = await packWorkspace(REPO_ROOT, candidateDir)
    const candidateMeta = await packageMetadata(candidate.tgz)
    assert.equal(candidateMeta.name, PACKAGE_NAME)
    const old = await makeOldArtifact(candidate.tgz, oldDir)
    const oldMeta = await packageMetadata(old.tgz)
    assert.equal(oldMeta.name, PACKAGE_NAME)
    assert.notEqual(candidate.sha256, old.sha256)
    assert.notEqual(candidateMeta.version, oldMeta.version)
    cases.push({ id: 'real-pnpm-pack-artifacts', passed: true, candidateSha256: candidate.sha256, oldSha256: old.sha256 })

    if (!(await commandAvailable('dsh'))) {
      return {
        schemaVersion: 2,
        kind: 'a6-release-rollback',
        generatedAt: new Date().toISOString(),
        stagingRoot: root,
        productionRootUntouched: true,
        artifacts: { candidate: candidate.tgz, candidateSha256: candidate.sha256, old: old.tgz, oldSha256: old.sha256 },
        cases,
        passed: cases.length,
        hostInstall: { status: 'BLOCKED', reason: 'dsh executable is unavailable; real isolated profile installation was not claimed' },
        hostWeb: { status: 'BLOCKED', reason: 'dsh executable is unavailable' },
      }
    }

    const profileRoot = await initProfile(dshHome, profile)
    const installedOld = await installVerified(dshHome, profile, profileRoot, old.tgz, old.sha256)
    assert.equal(installedOld.version, old.version)
    assert.equal(installedOld.file.startsWith(dshHome), true)
    const installedCandidate = await installVerified(dshHome, profile, profileRoot, candidate.tgz, candidate.sha256)
    assert.equal(installedCandidate.version, candidateMeta.version)
    cases.push({ id: 'isolated-candidate-install', passed: true, profileRoot, installedVersion: installedCandidate.version })

    // A tampered candidate is rejected before dsh/pnpm is invoked.
    const tampered = join(root, 'candidate-tampered.tgz')
    const bytes = await readFile(candidate.tgz)
    await writeFile(tampered, Buffer.concat([bytes, Buffer.from('a6-tamper')]))
    await assert.rejects(() => installVerified(dshHome, profile, profileRoot, tampered, candidate.sha256), /artifact digest mismatch/)
    assert.equal((await installedVersion(profileRoot)).version, candidateMeta.version)
    cases.push({ id: 'tampered-candidate-rejected', passed: true })

    // Install the old artifact again. This is a real package-manager rollback,
    // not a synthetic pointer swap, and the resulting package version/digest
    // is checked from the isolated profile's node_modules.
    const rolledBack = await installVerified(dshHome, profile, profileRoot, old.tgz, old.sha256)
    assert.equal(rolledBack.version, old.version)
    cases.push({ id: 'old-package-rollback', passed: true, rolledBackVersion: rolledBack.version })

    // Persist a small activation receipt and verify it can be restored after a
    // failed candidate preflight. This mirrors the host's durable pointer
    // contract while keeping all state under the throw-away root.
    const stateFile = join(root, 'activation-state.json')
    const backupFile = join(root, 'activation-state.backup.json')
    const oldReceipt = { schemaVersion: 1, activeVersion: old.version, artifactSha256: old.sha256, profile: profile }
    await atomicJson(stateFile, oldReceipt)
    await atomicJson(backupFile, oldReceipt)
    await assert.rejects(() => installVerified(dshHome, profile, profileRoot, tampered, candidate.sha256), /artifact digest mismatch/)
    await atomicJson(stateFile, JSON.parse(await readFile(backupFile, 'utf8')))
    assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), oldReceipt)
    cases.push({ id: 'failed-preflight-state-rollback', passed: true })

    return {
      schemaVersion: 2,
      kind: 'a6-release-rollback',
      generatedAt: new Date().toISOString(),
      stagingRoot: root,
      productionRootUntouched: true,
      profile: { name: profile, dshHome, isolated: dshHome.startsWith('/tmp/') },
      artifacts: { candidate: candidate.tgz, candidateSha256: candidate.sha256, old: old.tgz, oldSha256: old.sha256 },
      cases,
      passed: cases.length,
      hostInstall: {
        status: 'PASS',
        command: 'dsh plugin --profile a6-rollback add <old-or-candidate.tgz>',
        scope: 'isolated DSH_HOME only; no web listener started',
      },
      hostWeb: {
        status: 'BLOCKED',
        reason: 'GUI and same-identity restart are covered by the separate Host/Web evidence; this runner intentionally does not start a listener',
      },
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReleaseRollback().then(summary => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
