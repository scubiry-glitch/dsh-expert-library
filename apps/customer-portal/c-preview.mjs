import { readFile } from 'node:fs/promises'

export const C_PREVIEW_SESSION_ID = 'a22587ef-d99f-4123-b032-ea9a121a170d'
export const C_PREVIEW_SESSION = Object.freeze({ id: C_PREVIEW_SESSION_ID,
  title: '贵州租金与旅居市场分析 · 只读预览', createdAt: Date.UTC(2026, 9, 9, 2, 20), preview: true })

/** Fixed, account-scoped snapshot of the existing 98wiki team. No live team API is reachable. */
export function createCustomerPreview(root = new URL('./private-previews/guizhou-v5/', import.meta.url)) {
  const visible = principal => principal?.slug === 'zhijian' && principal?.backendRef === 'zhijian-demo-c'
  const workspace = async () => {
    const state = JSON.parse(await readFile(new URL('workspace.json', root), 'utf8'))
    if (state.preview?.kind !== 'external-read-only' || state.team?.id !== '贵州租金与旅居市场分析-v5'
      || state.plan?.planId !== 'plan-e8c5a4c2d6a34409c5ab29429a6fe977') throw new Error('preview snapshot invalid')
    return state
  }
  const available = async () => workspace().then(() => true, () => false)
  const document = async (taskId, artifactId) => {
    const state = await workspace()
    const item = state.documents.find(doc => doc.formal && doc.taskId === taskId && doc.id === artifactId)
    if (!item) return undefined
    const loaded = JSON.parse(await readFile(new URL(`documents/${item.taskId}-${item.id}.json`, root), 'utf8'))
    if (loaded?.name !== item.name || loaded?.mediaType !== item.mediaType || typeof loaded?.content !== 'string')
      throw new Error('preview document invalid')
    return loaded
  }
  return { session: C_PREVIEW_SESSION, visible, available, workspace, document }
}
