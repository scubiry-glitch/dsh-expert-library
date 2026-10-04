import { fromMarkdown } from 'mdast-util-from-markdown'

interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

export interface MarkdownReviewBlock {
  readonly source: string
  readonly visible: string
}

export const normalizeReviewQuote = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim()

const VOID_HTML = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/** Only Markdown prose is a review anchor. Raw HTML is deliberately outside
 * this locator's scope, including Markdown-looking text inside an HTML block.
 * Conservatively exclude intersecting prose blocks; this is not an HTML
 * renderer or a substantive review of the document. */
function htmlRanges(tree: MarkdownNode, length: number): [number, number][] {
  const nodes: MarkdownNode[] = []
  const collect = (node: MarkdownNode): void => {
    if (node.type === 'html') nodes.push(node)
    else node.children?.forEach(collect)
  }
  collect(tree)
  const ranges: [number, number][] = []
  const stack: string[] = []
  let openAt: number | undefined
  for (const node of nodes) {
    const start = node.position?.start.offset ?? 0
    const end = node.position?.end.offset ?? length
    ranges.push([start, end])
    const html = (node.value ?? '').replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    for (const token of html.matchAll(/<\s*(\/?)\s*([a-z][a-z0-9:-]*)\b(?:[^<>"']|"[^"]*"|'[^']*')*>/giu)) {
      const name = token[2]!.toLowerCase()
      if (VOID_HTML.has(name)) continue
      if (token[1] === '/') {
        const index = stack.lastIndexOf(name)
        if (index >= 0) stack.splice(index)
        if (stack.length === 0 && openAt !== undefined) {
          ranges.push([openAt, end])
          openAt = undefined
        }
      } else {
        // HTML does not self-close non-void elements with '/>'. Treat uncertain
        // nesting conservatively, rather than admitting possibly hidden text.
        openAt ??= start
        stack.push(name)
      }
    }
  }
  if (openAt !== undefined) ranges.push([openAt, length])
  return ranges
}

function inlineText(node: MarkdownNode): string {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value ?? ''
  if (node.type === 'break') return '\n'
  if (['emphasis', 'strong', 'link', 'linkReference'].includes(node.type)) return (node.children ?? []).map(inlineText).join('')
  // Images, raw HTML and non-prose content are boundaries, not disappearing
  // strings. No quote may concatenate text across an excluded object.
  return '\u0000'
}

const PROSE_NODES = new Set(['paragraph', 'heading', 'text', 'inlineCode', 'break', 'emphasis', 'strong', 'link', 'linkReference', 'list', 'listItem', 'blockquote'])
function safeProse(node: MarkdownNode): boolean {
  return PROSE_NODES.has(node.type) && (node.children ?? []).every(safeProse)
}
function proseText(node: MarkdownNode): string {
  if (node.type === 'paragraph' || node.type === 'heading') return (node.children ?? []).map(inlineText).join('')
  return (node.children ?? []).map(proseText).join('\n')
}

export function markdownReviewBlocks(markdown: string): readonly MarkdownReviewBlock[] {
  // Preserve all literal punctuation in prose. Only a leading YAML document
  // is metadata; parsing Markdown handles fenced/indented code and emphasis.
  const source = markdown.replace(/^\uFEFF/u, '').replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u, '')
  const tree = fromMarkdown(source)
  const excluded = htmlRanges(tree, source.length)
  const blocks: MarkdownReviewBlock[] = []
  let previousEnd: number | undefined
  const visit = (node: MarkdownNode): void => {
    if (node.type === 'paragraph' || node.type === 'heading'
      || ['list', 'listItem', 'blockquote'].includes(node.type) && safeProse(node)) {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined || excluded.some(([a, b]) => start < b && end > a)) return
      const next = { source: normalizeReviewQuote(source.slice(start, end)), visible: normalizeReviewQuote(proseText(node)) }
      if (previousEnd !== undefined && /^\s*$/u.test(source.slice(previousEnd, start)) && blocks.length > 0) {
        const previous = blocks.pop()!
        blocks.push({ source: normalizeReviewQuote(`${previous.source}\n${next.source}`), visible: normalizeReviewQuote(`${previous.visible}\n${next.visible}`) })
      } else blocks.push(next)
      previousEnd = end
    } else if (!['code', 'html', 'definition', 'image', 'imageReference'].includes(node.type)) {
      node.children?.forEach(visit)
    }
  }
  visit(tree)
  return blocks
}

/** Accept literal visible text or an actual Markdown source excerpt whose
 * decoded prose also occurs in that same block. This preserves inline-code
 * literals and formatting without admitting a link title, URL, metadata or
 * a forged punctuation-normalized identifier as report prose. */
export function hasMarkdownReviewQuote(blocks: readonly MarkdownReviewBlock[], quote: string): boolean {
  const anchor = normalizeReviewQuote(quote)
  if (!anchor || anchor.includes('\u0000')) return false
  if (blocks.some(block => block.visible.split('\u0000').some(part => part.includes(anchor)))) return true
  const decoded = markdownReviewBlocks(quote)
  if (decoded.length !== 1 || !decoded[0]!.visible || decoded[0]!.visible.includes('\u0000')) return false
  return blocks.some(block => block.source.includes(anchor)
    && block.visible.split('\u0000').some(part => part.includes(decoded[0]!.visible)))
}
