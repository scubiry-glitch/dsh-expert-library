/**
 * Manual library management for the 设置页「专家库」card: the write-side
 * counterpart of the read-only preview routes.
 *
 * Design contract (set by the captain, 2026-08-25):
 * - 领域包（`domain-packs/` 下各包）是构建产物，带 `--check` 漂移校验——UI 绝不直接
 *   写包内 JSON；专家/场景的**运行时覆盖**落在 V1 用户自定义层
 *   `<workspace>/<knowledgeDir>/{experts,scenarios}/<id>.json`（惰性生效、
 *   `resolveLibrary` 运行时合并、零漂移），技能落在
 *   `<workspace>/<knowledgeDir>/skills/<id>/`（`resolveSkill` 惰性读取）。
 * - 领域包重建走白名单脚本 `node scripts/build-packs.mjs <id>`（host 端
 *   spawn，仅允许 PACK_BUILD_ALLOWLIST 内的 pack id；不接任意 shell 输入）。
 * - 技能安装：上传 zip（multipart 字段 `zip` + `id`）→ 解压到
 *   `<knowledgeDir>/skills/<id>/`，仅允许安全 id（`isSafeSkillId`），解压后
 *   路径必须留在 skills 根内（防 zip-slip）。
 * - 所有写操作原子化：先写 `.<name>.tmp` 再 rename；失败不留下半成品。
 *
 * 路由（host 端 `src/index.ts` 注册）：
 *   GET    /plugins/dsh-expert-library/manage/experts
 *   PUT    /plugins/dsh-expert-library/manage/experts      body: Expert JSON
 *   DELETE /plugins/dsh-expert-library/manage/experts?id=…
 *   GET    /plugins/dsh-expert-library/manage/scenarios
 *   PUT    /plugins/dsh-expert-library/manage/scenarios    body: Scenario JSON
 *   DELETE /plugins/dsh-expert-library/manage/scenarios?id=…
 *   POST   /plugins/dsh-expert-library/manage/skills       multipart zip + id
 *   POST   /plugins/dsh-expert-library/manage/packs/rebuild  body: { id }
 *   GET    /plugins/dsh-expert-library/manage/knowledge-roots
 * @module dsh-expert-library/host/manage
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { parseExpert, parseScenario } from '../expert-library/registry.ts'
import { isSafeKnowledgeId } from '../knowledge.ts'
import { isSafeSkillId } from '../skills.ts'

/** 领域包重建白名单（id → 构建脚本参数）。 */
const PACK_BUILD_ALLOWLIST: Readonly<Record<string, string>> = {
  'zhijian-realestate': 'zhijian-realestate',
  'bank-finance': 'bank-finance',
  'beike': 'beike',
  'pipeline-domains': 'pipeline-domains',
  'pipeline-general': 'pipeline-general',
  'builtin-library': 'builtin-library',
}

/** Max uploaded skill zip bytes (16 MiB — skills are text + small media). */
const MAX_ZIP_BYTES = 16 * 1024 * 1024

/** 知识根布局（写操作的目标目录）。 */
export interface ManageKnowledgeRoots {
  readonly workspace: string
  readonly knowledgeDir: string
  readonly expertsDir: string
  readonly scenariosDir: string
  readonly skillsDir: string
}

/** Resolve the write targets under one workspace. */
export function manageKnowledgeRoots(workspace: string, knowledgeDir: string): ManageKnowledgeRoots {
  const root = join(workspace, knowledgeDir)
  return {
    workspace,
    knowledgeDir,
    expertsDir: join(root, 'experts'),
    scenariosDir: join(root, 'scenarios'),
    skillsDir: join(root, 'skills'),
  }
}

/** JSON helper: write atomically (tmp + rename). */
async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/** Read a bounded JSON request body. */
function readJsonBody(req: IncomingMessage, maxBytes = 1 << 20): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Parse a multipart/form-data body into fields (only text fields + one zip file). */
function parseMultipart(body: Buffer, boundary: string): { fields: Record<string, string>; file?: { name: string; data: Buffer } } {
  const fields: Record<string, string> = {}
  let file: { name: string; data: Buffer } | undefined
  const parts = body.toString('binary').split(`--${boundary}`)
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headerBlock = part.slice(0, headerEnd)
    const content = Buffer.from(part.slice(headerEnd + 4), 'binary')
    const nameMatch = headerBlock.match(/name="([^"]+)"/)
    const filenameMatch = headerBlock.match(/filename="([^"]+)"/)
    if (nameMatch === null) continue
    const name = nameMatch[1]!
    if (filenameMatch !== null) {
      file = { name: filenameMatch[1]!, data: content }
    } else {
      fields[name] = content.toString('utf8').replace(/\r?\n$/, '')
    }
  }
  return { fields, file }
}

/** Serve one management route (registered by the host). */
export async function handleManage(
  ctx: unknown,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  workspace: string,
  knowledgeDir: string,
): Promise<void> {
  const roots = manageKnowledgeRoots(workspace, knowledgeDir)
  const path = url.pathname.replace(/\/+$/, '')
  const method = req.method ?? 'GET'
  const send = (status: number, value: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const sendError = (status: number, message: string): void => send(status, { ok: false, error: message })

  try {
    // ── GET roots ────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/plugins/dsh-expert-library/manage/knowledge-roots') {
      send(200, { ok: true, ...roots })
      return
    }

    // ── GET experts ──────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/plugins/dsh-expert-library/manage/experts') {
      let names: string[] = []
      try {
        names = (await readdir(roots.expertsDir)).filter((name) => name.endsWith('.json'))
      } catch {
        names = []
      }
      const experts = []
      for (const name of names.sort()) {
        const id = name.slice(0, -'.json'.length)
        try {
          const raw = await readFile(join(roots.expertsDir, name), 'utf8')
          const parsed = parseExpert(JSON.parse(raw))
          experts.push(parsed === undefined ? { id, invalid: true } : { id, name: parsed.name, role: parsed.role })
        } catch {
          experts.push({ id, invalid: true })
        }
      }
      send(200, { ok: true, experts })
      return
    }

    // ── PUT experts ──────────────────────────────────────────────────────────
    if (method === 'PUT' && path === '/plugins/dsh-expert-library/manage/experts') {
      const body = await readJsonBody(req)
      const expert = parseExpert(body)
      if (expert === undefined) {
        sendError(400, 'invalid expert JSON — check id/name/role/background/principles/deliverables')
        return
      }
      await writeJsonAtomic(join(roots.expertsDir, `${expert.id}.json`), body)
      send(200, { ok: true, id: expert.id, name: expert.name })
      return
    }

    // ── DELETE experts ───────────────────────────────────────────────────────
    if (method === 'DELETE' && path === '/plugins/dsh-expert-library/manage/experts') {
      const id = url.searchParams.get('id') ?? ''
      if (!isSafeKnowledgeId(id)) {
        sendError(400, 'invalid expert id')
        return
      }
      try {
        await rm(join(roots.expertsDir, `${id}.json`), { force: true })
        send(200, { ok: true, id })
      } catch (error) {
        sendError(500, `delete failed: ${String(error)}`)
      }
      return
    }

    // ── GET scenarios ────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/plugins/dsh-expert-library/manage/scenarios') {
      let names: string[] = []
      try {
        names = (await readdir(roots.scenariosDir)).filter((name) => name.endsWith('.json'))
      } catch {
        names = []
      }
      const scenarios = []
      for (const name of names.sort()) {
        const id = name.slice(0, -'.json'.length)
        try {
          const raw = await readFile(join(roots.scenariosDir, name), 'utf8')
          const parsed = parseScenario(JSON.parse(raw))
          scenarios.push(parsed === undefined ? { id, invalid: true } : { id, name: parsed.name, tasks: parsed.tasks.length })
        } catch {
          scenarios.push({ id, invalid: true })
        }
      }
      send(200, { ok: true, scenarios })
      return
    }

    // ── PUT scenarios ────────────────────────────────────────────────────────
    if (method === 'PUT' && path === '/plugins/dsh-expert-library/manage/scenarios') {
      const body = await readJsonBody(req)
      const scenario = parseScenario(body)
      if (scenario === undefined) {
        sendError(400, 'invalid scenario JSON — check id/name/description/experts/tasks/deliverable')
        return
      }
      await writeJsonAtomic(join(roots.scenariosDir, `${scenario.id}.json`), body)
      send(200, { ok: true, id: scenario.id, name: scenario.name })
      return
    }

    // ── DELETE scenarios ─────────────────────────────────────────────────────
    if (method === 'DELETE' && path === '/plugins/dsh-expert-library/manage/scenarios') {
      const id = url.searchParams.get('id') ?? ''
      if (!isSafeKnowledgeId(id)) {
        sendError(400, 'invalid scenario id')
        return
      }
      try {
        await rm(join(roots.scenariosDir, `${id}.json`), { force: true })
        send(200, { ok: true, id })
      } catch (error) {
        sendError(500, `delete failed: ${String(error)}`)
      }
      return
    }

    // ── POST skills (multipart zip install) ──────────────────────────────────
    if (method === 'POST' && path === '/plugins/dsh-expert-library/manage/skills') {
      const contentType = req.headers['content-type'] ?? ''
      const boundaryMatch = contentType.match(/boundary=([^;]+)/)
      if (boundaryMatch === null) {
        sendError(400, 'expected multipart/form-data with boundary')
        return
      }
      const body = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        let total = 0
        req.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_ZIP_BYTES) {
            reject(new Error('zip too large'))
            req.destroy()
            return
          }
          chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
      })
      const boundary = boundaryMatch[1]!.replace(/^"|"$/g, '')
      const { fields, file } = parseMultipart(body, boundary)
      const id = (fields['id'] ?? '').trim()
      if (!isSafeSkillId(id)) {
        sendError(400, `invalid skill id "${id}" — use letters/digits/._- ≤64 chars, no separators`)
        return
      }
      if (file === undefined) {
        sendError(400, 'missing zip file field')
        return
      }
      // Zip-slip guard: unzip into a temp dir, verify every entry stays inside.
      const os = await import('node:os')
      const tmpRoot = join(os.tmpdir(), `dsh-skill-${createHash('sha256').update(id + Date.now().toString()).digest('hex').slice(0, 16)}`)
      await mkdir(tmpRoot, { recursive: true })
      const zipPath = join(tmpRoot, 'upload.zip')
      await writeFile(zipPath, file.data)
      // 解压到独立子目录（upload.zip 自身留在 tmpRoot，不参与顶层目录判定）。
      const extractRoot = join(tmpRoot, 'extract')
      await mkdir(extractRoot, { recursive: true })
      const targetRoot = join(roots.skillsDir, id)
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn('unzip', ['-q', zipPath, '-d', extractRoot], { stdio: 'pipe' })
          let stderr = ''
          child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
          child.on('error', reject)
          child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`unzip failed (${code}): ${stderr.slice(0, 300)}`))
          })
        })
        // Walk the extracted tree; reject anything escaping extractRoot.
        const extractedFiles: string[] = []
        const walk = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const abs = join(dir, entry.name)
            if (!abs.startsWith(extractRoot)) throw new Error('zip-slip: entry escapes temp root')
            if (entry.isDirectory()) await walk(abs)
            else extractedFiles.push(abs)
          }
        }
        await walk(extractRoot)
        if (!extractedFiles.some((file) => file.endsWith('SKILL.md'))) {
          throw new Error('zip does not contain SKILL.md')
        }
        // 剥离单一顶层目录：zip 常以 `<skill>/SKILL.md` 打包，此时应把该目录的
        // 内容直接放到 `skills/<id>/`（避免 `skills/<id>/<skill>/SKILL.md` 嵌套）。
        // __MACOSX 元数据目录不参与顶层判定。
        const contentRoot = (() => {
          const rels = extractedFiles.map((file) => file.slice(extractRoot.length + 1))
          const topLevel = new Set(rels.map((rel) => rel.split('/')[0]).filter((top) => top !== '__MACOSX'))
          if (topLevel.size === 1) {
            return join(extractRoot, [...topLevel][0]!)
          }
          return extractRoot
        })()
        await rm(targetRoot, { recursive: true, force: true })
        await mkdir(targetRoot, { recursive: true })
        let copied = 0
        const walkCopy = async (dir: string): Promise<void> => {
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const abs = join(dir, entry.name)
            if (!abs.startsWith(extractRoot)) throw new Error('zip-slip: entry escapes temp root')
            const rel = abs.slice(contentRoot.length + 1)
            if (rel.startsWith('__MACOSX/') || rel.includes('/__MACOSX/') || entry.name === '__MACOSX') continue
            if (entry.isDirectory()) {
              await mkdir(join(targetRoot, rel), { recursive: true })
              await walkCopy(abs)
            } else {
              const dest = join(targetRoot, rel)
              await mkdir(join(dest, '..'), { recursive: true })
              await rename(abs, dest)
              copied += 1
            }
          }
        }
        await walkCopy(contentRoot)
        send(200, { ok: true, id, files: copied })
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
      }
      return
    }

    // ── POST packs/rebuild (whitelisted build script) ────────────────────────
    if (method === 'POST' && path === '/plugins/dsh-expert-library/manage/packs/rebuild') {
      const body = (await readJsonBody(req)) as { id?: unknown }
      const id = typeof body?.id === 'string' ? body.id.trim() : ''
      const packArg = PACK_BUILD_ALLOWLIST[id]
      if (packArg === undefined) {
        sendError(400, `pack id "${id}" not in rebuild allowlist: ${Object.keys(PACK_BUILD_ALLOWLIST).join(', ')}`)
        return
      }
      const moduleRoot = fileURLToPath(new URL('../../', import.meta.url))
      const script = join(moduleRoot, 'scripts', 'build-packs.mjs')
      const output = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn('node', [script, packArg], {
          cwd: moduleRoot,
          stdio: 'pipe',
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
      })
      if (output.code !== 0) {
        send(500, { ok: false, error: `rebuild failed (${output.code})`, stdout: output.stdout.slice(-2000), stderr: output.stderr.slice(-2000) })
        return
      }
      send(200, { ok: true, stdout: output.stdout.slice(-4000), stderr: output.stderr.slice(-2000) })
      return
    }

    sendError(404, `no manage route for ${method} ${path}`)
  } catch (error) {
    sendError(500, `manage route error: ${String(error)}`)
  }
}
