const EMPTY_OPENERS = /^(?:你好|您好|嗨|在吗|开始|继续|测试|谢谢|收到|好的|好|hi|hello|test)[\s，,。.!！?？]*$/iu
const LEADING_REQUEST = /^(?:(?:你好|您好)[，,。.!！?？\s]*)?(?:请(?:你|帮我|帮忙)?|麻烦(?:你)?|帮我|我想|我需要|想要|能否|可以(?:帮我)?)[\s，,:：]*/u
const VAGUE_REQUEST = /^(?:写|做|生成|制作|整理|输出|分析|研究|讨论|聊聊|看看)(?:一[个份篇项张]|个|份|篇|项)?(?:研究|报告|分析|文章|方案|计划|文档|PPT|表格|事情|问题|内容)?$/u

/** A stable, local title suggestion. Empty or context-free messages keep “新会话”. */
export function titleFromUserMessage(text) {
  if (typeof text !== 'string') return null
  const clean = text.replace(/https?:\/\/\S+/giu, ' ')
    .replace(/@[\p{L}\p{N}._-]+/gu, ' ')
    .replace(/[`*_#>]/g, ' ')
    .replace(/\s+/g, ' ').trim()
  if (!clean || EMPTY_OPENERS.test(clean)) return null
  const first = clean.split(/[。！？!?；;\n]/u).map(part => part.trim()).find(Boolean)
  if (!first) return null
  const candidate = first.replace(LEADING_REQUEST, '').replace(/^[\s，,:：·—-]+|[\s，,:：·—-]+$/gu, '')
  if (EMPTY_OPENERS.test(candidate) || VAGUE_REQUEST.test(candidate)
    || /^(?:研究|报告|分析|问题|内容|这个|那个|看一下)$/u.test(candidate)) return null
  const chars = [...candidate]
  if (chars.length < 5 || !/[\p{Script=Han}\p{L}]/u.test(candidate)) return null
  const title = chars.slice(0, 24).join('').trim().replace(/[，,:：·—-]+$/u, '')
  return title.length >= 5 ? title : null
}
