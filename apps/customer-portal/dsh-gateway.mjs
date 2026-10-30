import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const basePath = '/plugins/dsh-expert-library/customer-gateway'

/** BFF-only DSH transport. The browser never supplies origin or service credentials. */
export function createDshGateway(config, fetcher = fetch) {
  async function call(runtime, method, path, body, timeoutMs = 15_000) {
    if (!config.gatewayTokenDir) throw new Error('DSH_GATEWAY_UNCONFIGURED')
    if (!/^[a-z0-9][a-z0-9-]*$/.test(runtime.backendRef)
      || !Object.hasOwn(config.dshBackends, runtime.backendRef)
      || config.dshBackends[runtime.backendRef] !== runtime.origin) throw new Error('DSH_GATEWAY_UNCONFIGURED')
    const secret = (await readFile(join(config.gatewayTokenDir, `${runtime.backendRef}.token`), 'utf8')).trim()
    if (secret.length < 32) throw new Error('DSH_GATEWAY_UNCONFIGURED')
    const target = new URL(`${basePath}${path}`, runtime.origin)
    const response = await fetcher(target, { method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) {
      const error = new Error(`DSH_GATEWAY_${response.status}`)
      error.status = response.status
      if (response.status === 400) {
        const detail = await response.json().catch(() => undefined)
        if (typeof detail?.error === 'string' && /^[A-Z_]+$/.test(detail.error)) error.code = detail.error
      }
      throw error
    }
    return response.json()
  }
  return {
    adminSettings: runtime => call(runtime, 'GET', '/admin/settings'),
    adminModels: runtime => call(runtime, 'GET', '/admin/models', undefined, 30_000),
    adminUsage: (runtime, days) => call(runtime, 'GET', `/admin/usage?days=${days}`),
    updateAdminSettings: (runtime, body) => call(runtime, 'PUT', '/admin/settings', body),
    mentions: runtime => call(runtime, 'GET', '/mentions'),
    pendingQuestion: (runtime, sessionId) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/question`),
    pendingApproval: (runtime, sessionId) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/approval`),
    answerApproval: (runtime, sessionId, id, decision) => call(runtime, 'POST', `/sessions/${encodeURIComponent(sessionId)}/approval`, { id, decision }),
    answerQuestion: (runtime, sessionId, requestId, answers) => call(runtime, 'POST',
      `/sessions/${encodeURIComponent(sessionId)}/question`, { requestId, answers }),
    webSearchPolicy: (runtime, sessionId) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/web-search`),
    setWebSearchPolicy: (runtime, sessionId, policy) => call(runtime, 'PUT', `/sessions/${encodeURIComponent(sessionId)}/web-search`, { policy }),
    presets: runtime => call(runtime, 'GET', '/presets'),
    createSpace: (runtime, path) => call(runtime, 'POST', '/spaces', { path }),
    createSession: (runtime, sessionId, options = {}) => call(runtime, 'POST', '/sessions', { sessionId, ...options }),
    sessionPreset: (runtime, sessionId) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/preset`),
    selectSessionPreset: (runtime, sessionId, presetId) => call(runtime, 'POST', `/sessions/${encodeURIComponent(sessionId)}/preset`, { presetId }),
    uploadAttachment: (runtime, sessionId, name, data) => call(runtime, 'POST', `/sessions/${encodeURIComponent(sessionId)}/attachments`,
      { name, data }, 30_000),
    removeAttachment: (runtime, sessionId, path) => call(runtime, 'DELETE', `/sessions/${encodeURIComponent(sessionId)}/attachments`,
      { path }),
    sendMessage: (runtime, sessionId, text, requestId, mentions = []) => call(runtime, 'POST', `/sessions/${encodeURIComponent(sessionId)}/messages`,
      { text, requestId, ...(mentions.length ? { mentions } : {}) }),
    conversation: (runtime, sessionId, after, latest = false, before) => call(runtime, 'GET',
      `/sessions/${encodeURIComponent(sessionId)}/messages?${new URLSearchParams({ after: String(after),
        ...(latest ? { latest: '1' } : {}), ...(before === undefined ? {} : { before: String(before) }) })}`),
    activity: (runtime, sessionId, timeoutMs = 5_000) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/activity`, undefined, timeoutMs),
    activityBatch: (runtime, sessionIds, timeoutMs = 8_000) => call(runtime, 'POST', '/sessions/activity-batch', { sessionIds }, timeoutMs),
    workspace: (runtime, sessionId, timeoutMs = 15_000) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/workspace`, undefined, timeoutMs),
    models: (runtime, sessionId) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/workspace/models`, undefined, 30_000),
    conversationModel: (runtime, sessionId) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/model`, undefined, 30_000),
    selectConversationModel: (runtime, sessionId, selection) => call(runtime, 'POST', `/sessions/${encodeURIComponent(sessionId)}/model`, selection, 30_000),
    workspaceAction: (runtime, sessionId, action) => call(runtime, 'POST', `/sessions/${encodeURIComponent(sessionId)}/workspace/action`, action, 60_000),
    document: (runtime, sessionId, taskId, artifactId) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/workspace/documents/${encodeURIComponent(taskId)}/${encodeURIComponent(artifactId)}`),
    listDatasets: (runtime, sessionId, before) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/datasets${before ? `?before=${encodeURIComponent(before)}` : ''}`),
    readDataset: (runtime, sessionId, datasetId, offset) => call(runtime, 'GET', `/sessions/${encodeURIComponent(sessionId)}/datasets/${encodeURIComponent(datasetId)}?offset=${offset}`),
  }
}
