/**
 * 渲染产物外网发布工具（render_publish）——通用基础设施工具，注册在 HOST
 * 入口（src/index.ts），不属于智见点评/专家协作任何领域工具组。
 *
 * Designer 渲染任务生成 HTML5 视觉稿或 PDF 后，经 nginx 静态直出。
 * 可用 DSH_RENDER_PUBLIC_DIR / DSH_RENDER_PUBLIC_BASE 为租户划分发布空间；
 * 两者均未设置时沿用历史发布路径。
 *
 * 安全约束：
 * - teamId：SafeId 规则（字母/数字开头，内部 ._-，≤64，无路径分隔符）；
 * - slug：仅字母数字与 -_（≤80），禁止点段与分隔符（防穿越）；
 * - 源文件：会话工作区内包含性校验（同 workspace-file），或发布目录内；
 * - 产物无鉴权直出——调用前必须确认内容不涉密、可公开。
 * @module dsh-expert-library/host/render-publish
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024

function within(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep)
}

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('render_publish requires a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

export function registerRenderPublishTool(ctx: Context): void {
  const configuredDir = process.env.DSH_RENDER_PUBLIC_DIR?.trim()
  const configuredBase = process.env.DSH_RENDER_PUBLIC_BASE?.trim()
  if ((configuredDir === undefined) !== (configuredBase === undefined)) {
    throw new Error('DSH_RENDER_PUBLIC_DIR 与 DSH_RENDER_PUBLIC_BASE 必须同时配置')
  }
  const PUBLIC_DIR = configuredDir ?? '/var/www/dsh-render'
  const PUBLIC_BASE = (configuredBase ?? 'https://yy.meizu.life/render').replace(/\/$/, '')
  if (!PUBLIC_DIR.startsWith('/') || resolvePath(PUBLIC_DIR) !== PUBLIC_DIR) {
    throw new Error('DSH_RENDER_PUBLIC_DIR 必须是规范化的绝对路径')
  }
  const baseUrl = new URL(PUBLIC_BASE)
  if (baseUrl.protocol !== 'https:' || baseUrl.search || baseUrl.hash) {
    throw new Error('DSH_RENDER_PUBLIC_BASE 必须是无查询参数的 HTTPS URL')
  }
  ctx.tools.register(defineTool({
    name: 'render_publish',
    description: `把 HTML5 或 PDF 渲染产物发布为公网可访问链接（免登录）：${PUBLIC_BASE}/<teamId>/<slug>.<html|pdf>。注意：产物无鉴权直出，发布前必须确认内容不涉密、可公开。`,
    parameters: {
      teamId: { type: 'string', required: true, description: '发布目录名（惯例取团队/项目 id，单段、无路径分隔符）。' },
      file: { type: 'string', description: 'HTML5 或 PDF 产物文件路径（file 与 html 二选一，file 优先）。' },
      html: { type: 'string', description: 'HTML5 全文（file 与 html 二选一）。' },
      slug: { type: 'string', description: '发布文件名（不含扩展名，默认 "index"；仅字母数字与 -_）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          file: { type: 'string', required: true },
          teamId: { type: 'string', required: true },
          publishedAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已发布：${value.url}`,
      }],
    },
    async execute(args, exec) {
      const captain = requireCaptain(exec)
      const cwd = captain.session.header.cwd ?? process.cwd()
      const teamId = String(args.teamId ?? '').trim()
      if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(teamId)) {
        throw new Error(`teamId 非法：${teamId}（须单段、字母数字开头、≤64 字符，无路径分隔符）`)
      }
      const rawSlug = String(args.slug ?? '').trim() || 'index'
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(rawSlug)) {
        throw new Error(`slug 非法：${rawSlug}（仅字母数字与 -_，≤80 字符）`)
      }
      let content: Buffer
      let extension = 'html'
      const fileArg = String(args.file ?? '').trim()
      if (fileArg !== '') {
        const absolute = await realpath(resolvePath(cwd, fileArg))
        const workspaceRoot = await realpath(cwd)
        const publicRoot = await realpath(PUBLIC_DIR)
        if (!within(workspaceRoot, absolute) && !within(publicRoot, absolute)) {
          throw new Error(`file 必须在会话工作区内（或发布目录内）：${fileArg}`)
        }
        extension = /\.pdf$/i.test(absolute) ? 'pdf' : 'html'
        if (!/\.(?:html?|pdf)$/i.test(absolute)) throw new Error('只支持 HTML 或 PDF 文件')
        const fileStat = await stat(absolute)
        if (!fileStat.isFile() || fileStat.size > MAX_ARTIFACT_BYTES) throw new Error('产物须为不超过 16 MiB 的普通文件')
        content = await readFile(absolute)
        if (extension === 'pdf' && !content.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
          throw new Error('PDF 文件格式无效')
        }
      } else if (String(args.html ?? '').trim() !== '') {
        content = Buffer.from(String(args.html), 'utf8')
      } else {
        throw new Error('file 与 html 至少提供其一')
      }
      if (content.length === 0 || content.length > MAX_ARTIFACT_BYTES) throw new Error('产物须为 1 字节到 16 MiB')
      const outDir = join(PUBLIC_DIR, teamId)
      await mkdir(outDir, { recursive: true })
      const publicRoot = await realpath(PUBLIC_DIR)
      if (!within(publicRoot, await realpath(outDir))) throw new Error('发布目录越界')
      const outFile = join(outDir, `${rawSlug}.${extension}`)
      const tempFile = join(outDir, `.${rawSlug}.${randomUUID()}.tmp`)
      try {
        await writeFile(tempFile, content, { flag: 'wx', mode: 0o644 })
        await rename(tempFile, outFile)
      } finally {
        await rm(tempFile, { force: true })
      }
      return {
        url: `${PUBLIC_BASE}/${encodeURIComponent(teamId)}/${rawSlug}.${extension}`,
        file: outFile,
        teamId,
        publishedAt: new Date().toISOString(),
      }
    },
  }))
}
