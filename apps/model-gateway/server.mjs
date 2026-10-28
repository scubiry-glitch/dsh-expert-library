import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

// Report reviewers can carry several frozen artifact receipts in one DSH turn.
// Keep an explicit per-request bound while allowing those authenticated calls.
// Leave headroom for one oversized turn so the tenant's earlier compaction
// threshold can recover an existing session that already crossed 4 MB.
const MAX_BODY_BYTES = 8_000_000
const MAX_OUTPUT_TOKENS = 8_192
// Captain sessions use `session-<uuid>`; DSH continuable members use the bare UUID.
const SESSION_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const dayOf = ms => new Date(ms).toISOString().slice(0, 10)
const digest = value => createHash('sha256').update(value).digest('hex')
const deny = (res, status, code) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify({ error: { code, message: code } }))
}

export class UsageLedger {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS model_calls (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, session_id TEXT NOT NULL,
        day TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER,
        reserved_tokens INTEGER NOT NULL, charged_tokens INTEGER NOT NULL,
        input_tokens INTEGER, cache_read_tokens INTEGER, output_tokens INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending','complete','upstream_error','interrupted'))
      );
      CREATE INDEX IF NOT EXISTS model_calls_by_account_day ON model_calls(account_id,day);
      CREATE INDEX IF NOT EXISTS model_calls_by_session ON model_calls(account_id,session_id,created_at);`)
  }
  close() { this.db.close() }
  reserve({ accountId, sessionId, tokens, dailyQuota, now = Date.now() }) {
    const day = dayOf(now), id = randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const spent = this.db.prepare('SELECT COALESCE(SUM(charged_tokens),0) AS total FROM model_calls WHERE account_id=? AND day=?').get(accountId, day).total
      if (spent + tokens > dailyQuota) { this.db.exec('ROLLBACK'); return undefined }
      this.db.prepare(`INSERT INTO model_calls(id,account_id,session_id,day,created_at,reserved_tokens,charged_tokens,status)
        VALUES (?,?,?,?,?,?,?,'pending')`).run(id, accountId, sessionId, day, now, tokens, tokens)
      this.db.exec('COMMIT')
      return id
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  finalize(id, usage, status) {
    const valid = value => Number.isSafeInteger(value) && value >= 0
    const input = usage?.prompt_tokens, output = usage?.completion_tokens
    const cache = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0
    const measured = valid(input) && valid(output) && valid(cache) && cache <= input
    // Missing usage keeps the conservative reservation, including interrupted streams.
    this.db.prepare(`UPDATE model_calls SET completed_at=?, status=?, charged_tokens=?,
      input_tokens=?, cache_read_tokens=?, output_tokens=? WHERE id=? AND status='pending'`).run(
      Date.now(), status,
      status === 'upstream_error' ? 0 : measured ? Math.max(input + output, 0) : this.db.prepare('SELECT reserved_tokens FROM model_calls WHERE id=?').get(id)?.reserved_tokens ?? 0,
      measured ? input - cache : null, measured ? cache : null, measured ? output : null, id,
    )
  }
  totals(accountId, day = dayOf(Date.now())) {
    return this.db.prepare(`SELECT COALESCE(SUM(charged_tokens),0) AS chargedTokens,
      COALESCE(SUM(input_tokens),0) AS inputTokens,
      COALESCE(SUM(cache_read_tokens),0) AS cacheReadTokens,
      COALESCE(SUM(output_tokens),0) AS outputTokens,
      COUNT(*) AS calls FROM model_calls WHERE account_id=? AND day=?`).get(accountId, day)
  }
  recentDays(accountId, sinceDay) {
    return this.db.prepare(`SELECT day, COALESCE(SUM(charged_tokens),0) AS chargedTokens,
      COUNT(*) AS calls FROM model_calls WHERE account_id=? AND day>=?
      GROUP BY day ORDER BY day DESC`).all(accountId, sinceDay)
  }
}

async function bodyOf(req, { anthropic = false } = {}) {
  const chunks = []; let size = 0; let oversized = false
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) { oversized = true; continue }
    chunks.push(chunk)
  }
  if (oversized) return undefined
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)
      || typeof body.model !== 'string' || !body.model || body.stream !== true) return undefined
    if (!anthropic) body.stream_options = { include_usage: true }
    body.max_tokens = Math.min(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
    return body
  } catch { return undefined }
}

const GLM_MODELS = new Set(['glm-5.3', 'glm-5.3[1m]', 'glm-4.7'])
const ZAI_MODELS = new Set(['glm-5.3', 'glm-5.3-flash'])

function usageFromEvent(event, anthropic, previous) {
  if (!anthropic) return event?.usage && typeof event.usage === 'object' ? event.usage : previous
  const source = event?.type === 'message_start' ? event.message?.usage : event?.type === 'message_delta' ? event.usage : undefined
  if (!source || typeof source !== 'object') return previous
  const valid = n => Number.isSafeInteger(n) && n >= 0
  const cache = valid(source.cache_read_input_tokens) ? source.cache_read_input_tokens : 0
  const created = valid(source.cache_creation_input_tokens) ? source.cache_creation_input_tokens : 0
  const input = valid(source.input_tokens) ? source.input_tokens + cache + created : previous?.prompt_tokens
  const output = valid(source.output_tokens) ? source.output_tokens : previous?.completion_tokens
  return { prompt_tokens: input, completion_tokens: output,
    prompt_tokens_details: { cached_tokens: cache || previous?.prompt_tokens_details?.cached_tokens || 0 } }
}

/** Account-scoped, loopback-only model proxy. No arbitrary URL or provider path is accepted. */
export function createModelGateway(config, { ledger = new UsageLedger(), upstreamFetch = fetch } = {}) {
  const accounts = new Map(config.accounts.map(account => [account.tokenHash, account]))
  const accountsById = new Map(config.accounts.map(account => [account.id, account]))
  return createServer(async (req, res) => {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') return deny(res, 403, 'FORBIDDEN')
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"ok":true}'); return
    }
    if (req.method === 'GET' && req.url?.startsWith('/internal/usage?')) {
      if (!config.usageToken) return deny(res, 404, 'NOT_FOUND')
      const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
      const expected = Buffer.from(config.usageToken)
      const actual = Buffer.from(supplied)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return deny(res, 401, 'UNAUTHENTICATED')
      const url = new URL(req.url, 'http://127.0.0.1')
      const accountId = url.searchParams.get('account_id')
      if (url.searchParams.size !== 1 || !accountId || !accountsById.has(accountId)) return deny(res, 404, 'NOT_FOUND')
      const account = accountsById.get(accountId)
      const day = dayOf(Date.now())
      const totals = ledger.totals(accountId, day)
      const sinceDay = dayOf(Date.now() - 6 * 86_400_000)
      const days = ledger.recentDays(accountId, sinceDay)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(JSON.stringify({ day, timezone: 'UTC', dailyQuota: account.dailyQuota,
        chargedTokens: totals.chargedTokens, remainingTokens: Math.max(0, account.dailyQuota - totals.chargedTokens),
        inputTokens: totals.inputTokens, cacheReadTokens: totals.cacheReadTokens,
        outputTokens: totals.outputTokens, calls: totals.calls, days }))
      return
    }
    const provider = req.method === 'POST' && req.url === '/chat/completions' ? 'deepseek'
      : req.method === 'POST' && (req.url === '/glm/v1/messages' || req.url === '/glm/v1/messages?beta=true') ? 'glm'
      : req.method === 'POST' && req.url === '/zai/chat/completions' ? 'zai' : undefined
    if (!provider) return deny(res, 404, 'NOT_FOUND')
    const auth = req.headers.authorization
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7)
      : provider === 'glm' && typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : ''
    const account = token.length >= 32 ? accounts.get(digest(token)) : undefined
    if (!account) return deny(res, 401, 'UNAUTHENTICATED')
    if (provider !== 'deepseek' && !account.glmEnabled) return deny(res, 403, 'FORBIDDEN')
    const presentedSession = req.headers['x-deepseek-harness-session-id']
    // DSH child calls can omit the captain header. The account credential still
    // authenticates the request and the daily quota remains account-wide; mark
    // these calls explicitly as unattributed instead of rejecting member work.
    if (presentedSession !== undefined && (typeof presentedSession !== 'string' || !SESSION_ID.test(presentedSession))) {
      return deny(res, 400, 'SESSION_REQUIRED')
    }
    const sessionId = presentedSession ?? `unattributed:${account.id}`
    const body = await bodyOf(req, { anthropic: provider === 'glm' })
    if (!body) return deny(res, 400, 'INVALID_REQUEST')
    if (provider === 'glm' && !GLM_MODELS.has(body.model)
      || provider === 'zai' && !ZAI_MODELS.has(body.model)) return deny(res, 400, 'INVALID_MODEL')
    const payload = JSON.stringify(body)
    // Measured DSH requests use at most about one token per four JSON bytes.
    // Reserve one per three bytes plus maximum output, leaving room for a
    // tool-result follow-up while still settling against provider usage.
    const reservation = Math.ceil(Buffer.byteLength(payload, 'utf8') / 3) + body.max_tokens
    const callId = ledger.reserve({ accountId: account.id, sessionId, tokens: reservation, dailyQuota: account.dailyQuota })
    if (!callId) return deny(res, 429, 'QUOTA_EXCEEDED')
    let status = 'interrupted', usage
    try {
      const upstreamUrl = provider === 'glm' ? `https://open.bigmodel.cn/api/anthropic/v1/messages${req.url.endsWith('?beta=true') ? '?beta=true' : ''}`
        : provider === 'zai' ? 'https://api.z.ai/api/coding/paas/v4/chat/completions'
          : 'https://api.deepseek.com/chat/completions'
      const upstreamHeaders = { 'content-type': 'application/json', accept: 'text/event-stream' }
      if (provider === 'glm') {
        upstreamHeaders['x-api-key'] = config.glmKey
        upstreamHeaders['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01'
      } else upstreamHeaders.authorization = `Bearer ${provider === 'zai' ? config.zaiKey : config.upstreamKey}`
      const upstream = await upstreamFetch(upstreamUrl, {
        method: 'POST', headers: upstreamHeaders,
        body: payload, signal: AbortSignal.timeout(300_000),
      })
      if (!upstream.ok || !upstream.body) {
        status = 'upstream_error'
        return deny(res, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502, 'UPSTREAM_ERROR')
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      const decoder = new TextDecoder()
      let lineBuffer = ''
      for await (const chunk of upstream.body) {
        if (!res.destroyed) res.write(chunk)
        lineBuffer += decoder.decode(chunk, { stream: true })
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''
        if (lineBuffer.length > 65_536) lineBuffer = ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const event = JSON.parse(line.slice(5).trimStart())
            usage = usageFromEvent(event, provider === 'glm', usage)
          } catch { /* non-JSON or [DONE] */ }
        }
      }
      status = 'complete'
      res.end()
    } catch {
      if (!res.headersSent) deny(res, 502, 'UPSTREAM_UNAVAILABLE')
      else res.destroy()
    } finally { ledger.finalize(callId, usage, status) }
  })
}

export function readGatewayConfig(env = process.env) {
  const source = JSON.parse(readFileSync(env.MODEL_GATEWAY_CONFIG, 'utf8'))
  const upstreamKey = readFileSync(env.MODEL_GATEWAY_KEY_FILE, 'utf8').trim()
  const usageToken = env.MODEL_GATEWAY_USAGE_TOKEN_FILE ? readFileSync(env.MODEL_GATEWAY_USAGE_TOKEN_FILE, 'utf8').trim() : undefined
  const glmKey = env.MODEL_GATEWAY_GLM_KEY_FILE ? readFileSync(env.MODEL_GATEWAY_GLM_KEY_FILE, 'utf8').trim() : undefined
  const zaiKey = env.MODEL_GATEWAY_ZAI_KEY_FILE ? readFileSync(env.MODEL_GATEWAY_ZAI_KEY_FILE, 'utf8').trim() : undefined
  if (usageToken !== undefined && usageToken.length < 32) throw new Error('invalid model usage credential')
  if (!upstreamKey || !Array.isArray(source.accounts) || source.accounts.length === 0) throw new Error('model gateway unconfigured')
  const accounts = source.accounts.map(row => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(row.id) || !/^[0-9a-f]{64}$/.test(row.tokenHash)
      || !Number.isSafeInteger(row.dailyQuota) || row.dailyQuota < 1
      || (row.glmEnabled !== undefined && typeof row.glmEnabled !== 'boolean')) throw new Error('invalid model gateway account')
    return { id: row.id, tokenHash: row.tokenHash, dailyQuota: row.dailyQuota, glmEnabled: row.glmEnabled === true }
  })
  if (accounts.some(row => row.glmEnabled) && (!glmKey || !zaiKey)) throw new Error('GLM gateway unconfigured')
  if (new Set(accounts.map(row => row.id)).size !== accounts.length || new Set(accounts.map(row => row.tokenHash)).size !== accounts.length) throw new Error('duplicate model gateway account')
  const port = Number(env.MODEL_GATEWAY_PORT ?? 3190)
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('invalid model gateway port')
  if (typeof env.MODEL_GATEWAY_DB !== 'string' || !env.MODEL_GATEWAY_DB.startsWith('/')) throw new Error('invalid model gateway database path')
  return { accounts, upstreamKey, glmKey, zaiKey, usageToken, port, dbPath: env.MODEL_GATEWAY_DB }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  const config = readGatewayConfig()
  const gateway = createModelGateway(config, { ledger: new UsageLedger(config.dbPath) })
  gateway.listen(config.port, '127.0.0.1', () => process.stdout.write(`Model gateway listening on 127.0.0.1:${config.port}\n`))
}
