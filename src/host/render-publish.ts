/**
 * 渲染产物外网发布工具（render_publish）——通用基础设施工具，注册在 HOST
 * 入口（src/index.ts），不属于智见点评/专家协作任何领域工具组。
 *
 * Designer 渲染任务生成 HTML5 视觉稿后，把产物发布到
 * `/var/www/dsh-render/<teamId>/<slug>.html`，经 nginx 直出（免登录）得到
 * `https://yy.meizu.life/render/<teamId>/<slug>.html` 公网链接。
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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath, sep } from 'node:path'

/** The caller agent, or a loud failure for non-agent callers. */
function requireCaptain(exec: ToolRunContext): Agent {
  if (!exec.agent) {
    throw new Error('render_publish requires a calling agent (exec.agent was undefined)')
  }
  return exec.agent
}

export function registerRenderPublishTool(ctx: Context): void {
  const PUBLIC_DIR = '/var/www/dsh-render'
  const PUBLIC_BASE = 'https://yy.meizu.life/render'
  ctx.tools.register(defineTool({
    name: 'render_publish',
    description: `把 HTML5 渲染产物发布为公网可访问链接（免登录）：${PUBLIC_BASE}/<teamId>/<slug>.html。Designer 渲染任务完成 HTML5 视觉稿后调用，把产物发布并取得外网链接。注意：产物无鉴权直出，发布前必须确认内容不涉密、可公开。`,
    parameters: {
      teamId: { type: 'string', required: true, description: '发布目录名（惯例取团队/项目 id，单段、无路径分隔符）。' },
      file: { type: 'string', description: 'HTML5 产物文件绝对路径（file 与 html 二选一，file 优先）。' },
      html: { type: 'string', description: 'HTML5 全文（file 与 html 二选一）。' },
      slug: { type: 'string', description: '发布文件名（不含 .html，默认 "index"；仅字母数字与 -_）。' },
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
      let html: string
      const fileArg = String(args.file ?? '').trim()
      if (fileArg !== '') {
        const absolute = resolvePath(cwd, fileArg)
        const insideWorkspace = absolute.startsWith(cwd + sep)
        const insidePublic = absolute.startsWith(PUBLIC_DIR + sep)
        if (!insideWorkspace && !insidePublic) {
          throw new Error(`file 必须在会话工作区内（或发布目录内）：${fileArg}`)
        }
        try {
          html = await readFile(absolute, 'utf8')
        } catch {
          throw new Error(`无法读取产物文件：${fileArg}`)
        }
      } else if (String(args.html ?? '').trim() !== '') {
        html = String(args.html)
      } else {
        throw new Error('file 与 html 至少提供其一')
      }
      if (html.length === 0) throw new Error('产物内容为空')
      const outDir = join(PUBLIC_DIR, teamId)
      await mkdir(outDir, { recursive: true })
      const outFile = join(outDir, `${rawSlug}.html`)
      await writeFile(outFile, html, 'utf8')
      return {
        url: `${PUBLIC_BASE}/${teamId}/${rawSlug}.html`,
        file: outFile,
        teamId,
        publishedAt: new Date().toISOString(),
      }
    },
  }))
}
