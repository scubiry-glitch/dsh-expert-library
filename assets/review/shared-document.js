const title = document.getElementById('title')
const status = document.getElementById('status')
const preview = document.getElementById('preview')
const download = document.getElementById('download')
const params = new URLSearchParams(location.hash.slice(1))
const token = params.get('share')
let blobUrl
document.getElementById('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); status.textContent = '分享链接已复制。' }
  catch { status.textContent = '复制失败，请从浏览器地址栏手动复制链接。' }
})
async function load() {
  if (!token) { title.textContent = '链接无效'; status.textContent = '分享链接缺少访问码。'; return }
  try {
    const response = await fetch('/plugins/dsh-expert-library/review/api/shared-document', {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ token }),
    })
    if (!response.ok) throw Error('DOCUMENT_UNAVAILABLE')
    const data = await response.json()
    const item = data.document
    const bytes = item.encoding === 'base64' ? Uint8Array.from(atob(item.content), c => c.charCodeAt(0)) : item.content
    blobUrl = URL.createObjectURL(new Blob([bytes], { type: item.mediaType }))
    title.textContent = item.name
    status.textContent = `此链接仅可查看这份文件，有效至 ${new Date(data.expiresAt).toLocaleString()}。`
    download.href = blobUrl; download.download = item.name; download.hidden = false
    if (item.mediaType === 'application/pdf') {
      const frame = document.createElement('iframe'); frame.title = item.name; frame.src = blobUrl; preview.append(frame)
    } else if (['image/png', 'image/jpeg', 'image/webp'].includes(item.mediaType)) {
      const image = document.createElement('img'); image.alt = item.name; image.src = blobUrl; preview.append(image)
    } else if (item.mediaType === 'text/html') {
      const frame = document.createElement('iframe'); frame.title = item.name; frame.sandbox = ''; frame.src = blobUrl; preview.append(frame)
    } else if (!item.encoding) {
      const pre = document.createElement('pre'); pre.textContent = item.content; preview.append(pre)
    } else preview.textContent = '此格式请下载后查看。'
  } catch {
    title.textContent = '文件暂时无法打开'
    status.textContent = '链接可能已过期，或文件已有更新。请让分享人重新生成链接。'
  }
}
window.addEventListener('pagehide', () => { if (blobUrl) URL.revokeObjectURL(blobUrl) })
void load()
