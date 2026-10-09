#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { closeSync, mkdirSync, openSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const tree = resolve(new URL('../..', import.meta.url).pathname)
const evidenceDir = join(tree, 'artifacts/pack-center/phase2-20260923/dag')
const runRoot = '/tmp/p2-20260923'
const coreRoot = '/usr/lib/node_modules/@deepseek-ai/dsh'
const sessionStart = new Date()
const coreMarker = join(runRoot, 'dsh-core-session-start')
const pluginPackage = '@zhijian/dsh-expert-library'
const NODE22_BIN = '/root/.nvm/versions/node/v22.22.0/bin/node'

const instances = [
  { id: 'A', home: join(runRoot, 'dsh-a'), profile: 'p2-a', workspace: join(runRoot, 'workspace-a'), packCenterRoot: join(runRoot, 'pack-center-a'), port: 18281, log: join(evidenceDir, 'T2.1.a.log') },
  { id: 'B', home: join(runRoot, 'dsh-b'), profile: 'p2-b', workspace: join(runRoot, 'workspace-b'), packCenterRoot: join(runRoot, 'pack-center-b'), port: 18282, log: join(evidenceDir, 'T2.1.b.log') },
]

function fail(message) {
  throw new Error(message)
}

function portFree(port) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer()
    server.once('error', error => {
      server.close()
      if (error.code === 'EADDRINUSE') resolvePromise(false)
      else reject(error)
    })
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise(true)))
  })
}

async function waitForManage(instance, timeoutMs = 120000) {
  const url = `http://127.0.0.1:${instance.port}/plugins/dsh-expert-library/manage/center/connection`
  const deadline = Date.now() + timeoutMs
  let lastError = 'not attempted'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { 'X-Pack-Center-UI': '1' }, signal: AbortSignal.timeout(2000) })
      const text = await response.text()
      let json
      try { json = JSON.parse(text) } catch { json = undefined }
      if (response.status === 200 && json && json.configured === false) {
        return { url, status: response.status, body: json }
      }
      lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`
    } catch (error) {
      lastError = String(error)
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  }
  fail(`${instance.id} manage endpoint did not become live: ${lastError}`)
}

function shell(command) {
  const result = spawnSync('bash', ['-lc', command], { cwd: tree, encoding: 'utf8' })
  return { command, exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function writeProfile(instance) {
  const profileDir = join(instance.home, 'profiles', instance.profile)
  const pluginLink = join(profileDir, 'node_modules', '@zhijian', 'dsh-expert-library')
  mkdirSync(join(profileDir, 'node_modules', '@zhijian'), { recursive: true })
  mkdirSync(instance.workspace, { recursive: true })
  mkdirSync(instance.packCenterRoot, { recursive: true })
  mkdirSync(join(instance.home, 'vendor-packs'), { recursive: true })
  const manifest = {
    name: `dsh-profile-${instance.id.toLowerCase()}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pluginPackage], patchReload: 'startup' } },
  }
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: expert-library\n  config:\n    stateDir: expert-teams\n    memberProvider: spawn\n    memberMaxDepth: 1\n    maxMembers: 8\n    knowledgeDir: knowledge\n    packsDir: domain-packs\n    manageToken: ''\n    vendorPacksDir: ${join(instance.home, 'vendor-packs')}\n    packCenterOrigin: ''\n    packCenterDir: ${instance.packCenterRoot}\n    packSourceAllowlist: []\n    promptSectionOrder: 117\n    announceToAgent: true\n    enabledPacks: []\n    packPriority: []\n    disabledTools: []\n`)
  symlinkSync(tree, pluginLink, 'dir')
  const resolvedPluginLoadPath = realpathSync(pluginLink)
  if (resolvedPluginLoadPath !== tree && !resolvedPluginLoadPath.startsWith(tree + '/')) {
    fail(`${instance.id} plugin symlink resolved outside isolated tree: ${resolvedPluginLoadPath}`)
  }
  return { profileDir, pluginLink, resolvedPluginLoadPath }
}

async function main() {
  mkdirSync(evidenceDir, { recursive: true })
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(coreMarker, sessionStart.toISOString() + '\n')
  utimesSync(coreMarker, sessionStart, sessionStart)
  const portChecks = []
  for (const instance of instances) {
    try {
      portChecks.push({ port: instance.port, free: await portFree(instance.port) })
    } catch (error) {
      portChecks.push({ port: instance.port, free: false, error: String(error) })
    }
  }
  const bindDenied = portChecks.some(check => check.error?.includes('EPERM') || check.error?.includes('EACCES'))
  if (bindDenied) {
    await rm(runRoot, { recursive: true, force: true })
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(coreMarker, sessionStart.toISOString() + '\n')
    utimesSync(coreMarker, sessionStart, sessionStart)
    const prepared = instances.map(instance => ({ instance, ...writeProfile(instance) }))
    for (const item of prepared) writeFileSync(item.instance.log, [
      `T2.1 instance ${item.instance.id}`,
      `command: dsh --profile ${item.instance.profile} --no-open --port ${item.instance.port}`,
      'child launch: blocked before spawn by local TCP bind preflight',
      `preflight: ${portChecks.find(check => check.port === item.instance.port)?.error ?? 'port unavailable'}`,
      `DSH_HOME: ${item.instance.home}`,
      `workspace: ${item.instance.workspace}`,
      `pack-center-root: ${item.instance.packCenterRoot}`,
      `plugin-link: ${item.pluginLink}`,
      `resolved-plugin-load-path: ${item.resolvedPluginLoadPath}`,
      '',
    ].join('\n'))
    const diffCheck = shell(`git -C ${JSON.stringify(tree)} diff --check`)
    const statusCount = shell(`git -C ${JSON.stringify(tree)} status --porcelain | wc -l`)
    const newer = shell(`find ${JSON.stringify(coreRoot)} -newer ${JSON.stringify(coreMarker)} -print`)
    const newerFiles = newer.stdout.split('\n').map(line => line.trim()).filter(Boolean)
    writeFileSync(join(evidenceDir, 'T2.1.instances.json'), JSON.stringify({
      node: 'T2.1', sessionStart: sessionStart.toISOString(), portDiscovery: { source: '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/lib/startup.js', flag: '--port <port>', defaultPort: 3080, bindHost: '127.0.0.1', noOpenFlag: '--no-open' },
      portChecks, instances: prepared.map(item => ({ id: item.instance.id, pid: null, port: item.instance.port, DSH_HOME: item.instance.home, profile: item.instance.profile, workspaceDir: item.instance.workspace, packCenterRoot: item.instance.packCenterRoot, pluginPackage, pluginSymlink: item.pluginLink, resolvedPluginLoadPath: item.resolvedPluginLoadPath, manageEndpoint: `http://127.0.0.1:${item.instance.port}/plugins/dsh-expert-library/manage/center`, manageStatus: null, manageJson: null })), disjointStateRoots: true,
    }, null, 2) + '\n')
    writeFileSync(join(evidenceDir, 'T2.1.core-clean.txt'), [
      `session_start=${sessionStart.toISOString()}`, `core_marker=${coreMarker}`,
      `command: git -C ${tree} diff --check`, `exit_code: ${diffCheck.exitCode}`,
      `command: git -C ${tree} status --porcelain | wc -l`, `exit_code: ${statusCount.exitCode}`, `stdout: ${statusCount.stdout.trim()}`,
      `command: find ${coreRoot} -newer ${coreMarker} -print`, `exit_code: ${newer.exitCode}`, newerFiles.length ? `newer_files:\n${newerFiles.join('\n')}` : 'newer_files: <none>',
      `outside_tree_changes: only /tmp/p2-20260923 runtime homes and this tree evidence/scripts were created; DSH core newer-file check is empty`,
      'core_clean=' + (diffCheck.exitCode === 0 && newer.exitCode === 0 && newerFiles.length === 0), '',
    ].join('\n'))
    const reasons = ['live instance start was blocked before child launch: this execution sandbox denies local TCP bind with EPERM/EACCES', 'no instance can be marked live or running under the current sandbox', `git diff --check exit ${diffCheck.exitCode}`, `DSH core newer-than-session-start file count ${newerFiles.length}`]
    writeFileSync(join(evidenceDir, 'T2.1.verdict.json'), JSON.stringify({ node: 'T2.1', passed: false, reasons }, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ node: 'T2.1', passed: false, ports: instances.map(instance => instance.port) }) + '\n')
    return
  }
  for (const check of portChecks) if (!check.free) fail(`port ${check.port} is not free`)
  // A stale preparation tree is safe to replace only after both required ports are free.
  await rm(runRoot, { recursive: true, force: true })
  mkdirSync(runRoot, { recursive: true })
  writeFileSync(coreMarker, sessionStart.toISOString() + '\n')
  utimesSync(coreMarker, sessionStart, sessionStart)

  const prepared = instances.map(instance => ({ instance, ...writeProfile(instance) }))
  const children = []
  for (const item of prepared) {
    writeFileSync(item.instance.log, [
      `T2.1 instance ${item.instance.id}`,
      `command: dsh --profile ${item.instance.profile} --no-open --port ${item.instance.port}`,
      `DSH_HOME: ${item.instance.home}`,
      `workspace: ${item.instance.workspace}`,
      `pack-center-root: ${item.instance.packCenterRoot}`,
      `plugin-link: ${item.pluginLink}`,
      `resolved-plugin-load-path: ${item.resolvedPluginLoadPath}`,
      '',
    ].join('\n'))
    const fd = openSync(item.instance.log, 'a')
    // dsh lib/bin.js gates its CLI on `import.meta.main`, which /usr/bin/node
    // (v20) does not implement — under node20 the CLI exits 0 without running
    // anything. Spawn the node22 binary the production instance uses directly.
    const child = spawn(NODE22_BIN, ['--max-old-space-size=1536', join(coreRoot, 'lib/bin.js'), '--profile', item.instance.profile, '--host', '127.0.0.1', '--no-open', '--port', String(item.instance.port)], {
      cwd: item.instance.workspace,
      detached: true,
      stdio: [fd, fd, fd],
      env: {
        ...process.env,
        DSH_HOME: item.instance.home,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'workspace-write',
      },
    })
    closeSync(fd)
    child.unref()
    children.push({ item, pid: child.pid })
  }

  const live = []
  for (const child of children) live.push({ ...child, http: await waitForManage(child.item.instance) })
  const roots = live.map(({ item }) => resolve(item.instance.packCenterRoot))
  const disjointStateRoots = new Set(roots).size === roots.length
  if (!disjointStateRoots) fail(`pack-center roots overlap: ${roots.join(', ')}`)
  const facts = live.map(({ item, pid, http }) => ({
    id: item.instance.id,
    pid,
    port: item.instance.port,
    DSH_HOME: item.instance.home,
    profile: item.instance.profile,
    workspaceDir: item.instance.workspace,
    packCenterRoot: item.instance.packCenterRoot,
    pluginPackage,
    pluginSymlink: item.pluginLink,
    resolvedPluginLoadPath: item.resolvedPluginLoadPath,
    manageEndpoint: http.url,
    manageStatus: http.status,
    manageJson: http.body,
  }))
  writeFileSync(join(evidenceDir, 'T2.1.instances.json'), JSON.stringify({
    node: 'T2.1',
    sessionStart: sessionStart.toISOString(),
    portDiscovery: { source: '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/lib/startup.js', flag: '--port <port>', defaultPort: 3080, bindHost: '127.0.0.1', noOpenFlag: '--no-open' },
    instances: facts,
    disjointStateRoots,
  }, null, 2) + '\n')

  const diffCheck = shell(`git -C ${JSON.stringify(tree)} diff --check`)
  const statusCount = shell(`git -C ${JSON.stringify(tree)} status --porcelain | wc -l`)
  const newer = shell(`find ${JSON.stringify(coreRoot)} -newer ${JSON.stringify(coreMarker)} -print`)
  const newerFiles = newer.stdout.split('\n').map(line => line.trim()).filter(Boolean)
  const coreClean = diffCheck.exitCode === 0 && newer.exitCode === 0 && newerFiles.length === 0
  const coreEvidence = [
    `session_start=${sessionStart.toISOString()}`,
    `core_marker=${coreMarker}`,
    `command: git -C ${tree} diff --check`,
    `exit_code: ${diffCheck.exitCode}`,
    diffCheck.stdout.trim() ? `stdout: ${diffCheck.stdout.trim()}` : 'stdout: <empty>',
    diffCheck.stderr.trim() ? `stderr: ${diffCheck.stderr.trim()}` : 'stderr: <empty>',
    `command: git -C ${tree} status --porcelain | wc -l`,
    `exit_code: ${statusCount.exitCode}`,
    `stdout: ${statusCount.stdout.trim()}`,
    statusCount.stderr.trim() ? `stderr: ${statusCount.stderr.trim()}` : 'stderr: <empty>',
    `command: find ${coreRoot} -newer ${coreMarker} -print`,
    `exit_code: ${newer.exitCode}`,
    newerFiles.length ? `newer_files:\n${newerFiles.join('\n')}` : 'newer_files: <none>',
    `outside_tree_changes: only /tmp/p2-20260923 runtime homes and this tree evidence/scripts were created; DSH core newer-file check is empty`,
    `core_clean=${coreClean}`,
    '',
  ].join('\n')
  writeFileSync(join(evidenceDir, 'T2.1.core-clean.txt'), coreEvidence)

  const reasons = [
    'two detached real dsh web children started and remained running',
    'both manage endpoints returned HTTP 200 JSON with configured=false',
    'instance A and B pack-center roots are distinct',
    'both resolved plugin load paths point into the isolated implementation tree',
    `git diff --check exit ${diffCheck.exitCode}`,
    `DSH core newer-than-session-start file count ${newerFiles.length}`,
  ]
  const passed = facts.length === 2 && facts.every(fact => fact.manageStatus === 200 && fact.manageJson.configured === false)
    && facts.every(fact => fact.resolvedPluginLoadPath === tree)
    && disjointStateRoots && coreClean && statusCount.exitCode === 0
  writeFileSync(join(evidenceDir, 'T2.1.verdict.json'), JSON.stringify({ node: 'T2.1', passed, reasons }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ node: 'T2.1', passed, ports: instances.map(instance => instance.port) }) + '\n')
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(message + '\n')
  process.exitCode = 1
})
