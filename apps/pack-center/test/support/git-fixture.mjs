/** Isolated test-only smart HTTPS Git server + process transport adapter. */
import { createServer } from 'node:https'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)

export async function gitFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pack-center-git-fixture-'))
  const work = join(root, 'work'), repos = join(root, 'repos'), outputParent = join(root, 'output')
  await Promise.all([mkdir(work), mkdir(repos), mkdir(outputParent)])
  const env = { PATH: '/usr/bin:/bin', HOME: root, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
  const git = async (...args) => (await exec('/usr/bin/git', args, { cwd: work, env, maxBuffer: 8 * 1024 * 1024 })).stdout.trim()
  await exec('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'tls.key'), '-out', join(root, 'tls.crt'),
    '-days', '1', '-subj', '/CN=git.fixture.invalid', '-addext', 'subjectAltName=DNS:git.fixture.invalid'], { env })
  await cp(fileURLToPath(new URL('../../../../examples/pack-center/demo-v1/', import.meta.url)), work, { recursive: true })
  await git('init', '--initial-branch=main', '--quiet')
  await git('add', '.')
  await git('commit', '--quiet', '-m', 'fixture v1')
  await git('clone', '--bare', '--quiet', work, join(repos, 'repo.git'))
  await git('--git-dir', join(repos, 'repo.git'), 'config', 'http.receivepack', 'false')
  const gitExecPath = await git('--exec-path')
  const requests = [], invocations = []
  const server = createServer({ key: await readFile(join(root, 'tls.key')), cert: await readFile(join(root, 'tls.crt')) }, async (req, res) => {
    requests.push({ url: req.url, headers: req.headers })
    if (options.respond) return options.respond(req, res)
    const url = new URL(req.url, 'https://git.fixture.invalid')
    const child = spawn(join(gitExecPath, 'git-http-backend'), [], { env: { ...env, GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_ADDR: '127.0.0.1',
      HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
    }, stdio: ['pipe', 'pipe', 'pipe'] })
    const output = []
    child.stdout.on('data', bytes => output.push(bytes))
    child.stderr.resume()
    req.pipe(child.stdin)
    child.stdin.on('error', () => {})
    child.on('close', code => {
      const bytes = Buffer.concat(output), marker = bytes.indexOf('\r\n\r\n')
      if (code !== 0 || marker < 0) { res.writeHead(500); res.end(); return }
      const headers = bytes.subarray(0, marker).toString().split('\r\n')
      let status = 200
      for (const header of headers) {
        const colon = header.indexOf(':')
        const name = header.slice(0, colon), value = header.slice(colon + 1).trim()
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
        else res.setHeader(name, value)
      }
      res.writeHead(status); res.end(bytes.subarray(marker + 4))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) })
  return {
    root, work, outputParent, git, requests, invocations,
    async push() { await git('push', '--quiet', join(repos, 'repo.git'), 'main'); return git('rev-parse', 'HEAD') },
    infrastructure: {
      // A public test answer gets validated before the process transport seam redirects
      // exactly this one test host to an ephemeral loopback TLS Git fixture.
      resolveHostname: async hostname => { if (hostname !== 'git.fixture.invalid') throw new Error('unexpected host'); return [{ address: '93.184.216.34', family: 4 }] },
      spawn(command, args, spawnOptions) {
        invocations.push({ command, args: [...args], env: { ...spawnOptions.env } })
        const testArgs = args.flatMap(arg => {
          if (arg === 'http.curloptResolve=git.fixture.invalid:443:93.184.216.34') return [`http.curloptResolve=git.fixture.invalid:${port}:127.0.0.1`]
          if (arg === 'https://git.fixture.invalid/repo.git') return [`https://git.fixture.invalid:${port}/repo.git`]
          return [arg]
        })
        const gitIndex = testArgs.indexOf('/usr/bin/git')
        testArgs.splice(gitIndex + 1, 0, '-c', `http.sslCAInfo=${join(root, 'tls.crt')}`)
        return spawn(command, testArgs, spawnOptions)
      },
    },
    input: { url: 'https://git.fixture.invalid/repo.git', ref: 'main', outputParent, allowedHosts: ['git.fixture.invalid'], validatorVersion: '0.1.0' },
  }
}
