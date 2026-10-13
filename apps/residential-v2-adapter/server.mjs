import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'

// Account C's frozen Fuzhou release is deliberately demo-only. A new-case
// release and visual acceptance are required before enabling mode=case.
const root = process.env.RESIDENTIAL_V2_ROOT
const jobsRoot = process.env.RESIDENTIAL_V2_JOBS
const port = Number(process.env.RESIDENTIAL_V2_PORT ?? 8793)
if (!root || !jobsRoot || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid adapter configuration')
const golden = join(jobsRoot, '..', 'golden_case_001')
const roles = ['price_full', 'price_external', 'rent_full', 'rent_external']
const releaseId = 'fz_single_property_toolkit_20261008_v2'
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/
const jobPattern = /^rv2-[0-9a-f]{24}$/
const filePattern = /^(price_full|price_external|rent_full|rent_external)-[0-9a-f]{12}$/
const sha = value => createHash('sha256').update(value).digest('hex')
const load = async path => JSON.parse(await readFile(path, 'utf8'))
const hashFile = async path => sha(await readFile(path))

const manifest = await load(join(golden, '05_manifest/four_reports.json'))
const price = await load(join(golden, '02_model/prediction/r4_uncalibrated_prediction.json'))
const rent = await load(join(golden, '06_rent_valuation/02_model/prediction/uncalibrated_prediction.json'))
const priceModel = await load(join(golden, '02_model/audit/model_reference.json'))
const rentModel = await load(join(golden, '06_rent_valuation/02_model/audit/model_reference.json'))
const release = await load(join(root, 'VERSION.json'))
const inputSha = await hashFile(join(root, 'golden_case/case_config.yaml'))
const releaseManifestSha = await hashFile(join(root, 'checksums.sha256'))
if (release.release_id !== releaseId || manifest.release_id !== releaseId || manifest.status !== 'validated_working_draft'
  || manifest.validation?.passed !== true || roles.some(role => !manifest.reports?.[role])) throw Error('golden release not validated')
for (const role of roles) {
  const item = manifest.reports[role]
  if (!item.path.startsWith('deliverables/') || basename(item.path) === item.path
    || await hashFile(join(golden, item.path)) !== item.sha256) throw Error(`golden report mismatch: ${role}`)
}
await mkdir(jobsRoot, { recursive: true, mode: 0o700 })

const capability = suffix => `housevalue.realestate.v2.${suffix}`
const envelope = (suffix, data, error = null) => ({
  ok: error === null, capability: capability(suffix),
  provider: { id: 'rongcheng', version: '0.3.0-demo' },
  provenance: { caliber: '冻结福州黄金样例，仅供 C 账号接线验收', unit: 'demo', release_id: releaseId,
    source: 'fz_single_property_toolkit_20261008_v2', effective_price_month: '2026-06', effective_rent_month: '2026-07' },
  warnings: [{ code: 'DEMO_ONLY', message: '仅限脱敏黄金样例；真实新案尚未启用。' }],
  data: error === null ? data : null, error, truncated: false,
})
const fail = (suffix, code, message) => envelope(suffix, null, { code, message, retry: 'never' })
const binding = input => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('INVALID_INPUT')
  if (input.mode !== 'demo') throw Error('NEW_CASE_NOT_ENABLED')
  if (input.city_code !== 'FZ') throw Error('CITY_OR_BUSINESS_UNAVAILABLE')
  if (typeof input.case_id !== 'string' || !idPattern.test(input.case_id)
    || typeof input.attempt_id !== 'string' || !idPattern.test(input.attempt_id)) throw Error('INVALID_CASE_BINDING')
  if (input.as_of_date !== '2026-09-08') throw Error('DEMO_DATE_MISMATCH')
  const subject = input.subject
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)
    || Object.keys(subject).length !== 1 || subject.demo_case_id !== 'golden_case_001') throw Error('DEMO_SUBJECT_MISMATCH')
  return { case_id: input.case_id, attempt_id: input.attempt_id, city_code: 'FZ', mode: 'demo',
    as_of_date: '2026-09-08', subject: { demo_case_id: 'golden_case_001' }, input_sha256: inputSha,
    release_id: releaseId, stage: 'demo', coverage: { price: true, rent: true }, missing_fields: [],
    price: { model_version: priceModel.model_version, model_artifact_sha256: priceModel.model_sha256,
      feature_snapshot_version: 'FZ_sale_step3_20260805', export_feature_snapshot_version: 'FZ_sale_step3_20260805',
      effective_month: '2026-06' },
    rent: { model_version: rentModel.model_id, effective_month: '2026-07' },
    resource_manifest_sha256: releaseManifestSha,
    visual_review: 'pending', professional_signoff: 'pending' }
}
const bound = input => {
  const value = binding(input)
  if (input.input_sha256 !== inputSha || input.release_id !== releaseId) throw Error('BINDING_MISMATCH')
  return value
}
const snapshot = (input, kind) => `${kind}-${sha(`${input.case_id}:${input.attempt_id}:${inputSha}:${releaseId}`).slice(0, 24)}`
const jobPath = id => join(jobsRoot, id, 'job.json')
const loadJob = async id => jobPattern.test(id) ? load(jobPath(id)).catch(() => undefined) : undefined

async function runJob(job) {
  try {
    const dir = join(jobsRoot, job.job_id)
    const files = []
    for (const role of roles) {
      const source = join(golden, manifest.reports[role].path)
      const actual = await hashFile(source)
      if (actual !== manifest.reports[role].sha256) throw Error(`golden source changed: ${role}`)
      const name = basename(source)
      const fileId = `${role}-${actual.slice(0, 12)}`
      const destination = join(dir, `${fileId}.docx`)
      await copyFile(source, destination)
      const size = (await stat(destination)).size
      if (await hashFile(destination) !== actual) throw Error(`copy changed: ${role}`)
      files.push({ role, file_id: fileId, filename: name, size_bytes: size, sha256: actual })
    }
    job = { ...job, status: 'succeeded', quality_status: 'passed', files,
      quality_receipt: 'golden_case_001/05_manifest/four_reports.json', completed_at: new Date().toISOString() }
    await writeFile(jobPath(job.job_id), JSON.stringify(job), { mode: 0o600 })
  } catch (error) {
    await writeFile(jobPath(job.job_id), JSON.stringify({ ...job, status: 'failed',
      error: String(error), completed_at: new Date().toISOString() }), { mode: 0o600 })
  }
}

async function dispatch(suffix, input) {
  if (suffix === 'subject.validate') return binding(input)
  if (suffix === 'marketvalue.infer') {
    const b = bound(input)
    return { ...b, inference_id: snapshot(input, 'price-inference'), snapshot_id: snapshot(input, 'price'),
      unit_price_yuan: price.predicted_unit_price_yuan_sqm, total_price_yuan: price.predicted_total_price_yuan,
      effective_month: '2026-06', evidence_ref: 'golden_case_001/02_model/prediction/r4_uncalibrated_prediction.json' }
  }
  if (suffix === 'rentvalue.infer') {
    const b = bound(input)
    return { ...b, inference_id: snapshot(input, 'rent-inference'), snapshot_id: snapshot(input, 'rent'),
      monthly_rent_yuan: rent.estimated_monthly_rent_yuan,
      unit_rent_yuan_m2_month: rent.estimated_unit_rent_yuan_sqm_month,
      effective_month: '2026-07', evidence_ref: 'golden_case_001/06_rent_valuation/02_model/prediction/uncalibrated_prediction.json' }
  }
  if (suffix === 'report.generate') {
    const b = bound(input)
    if (input.business !== 'both' || JSON.stringify(input.roles) !== JSON.stringify(roles)
      || input.price_snapshot_id !== snapshot(input, 'price') || input.rent_snapshot_id !== snapshot(input, 'rent')
      || typeof input.idempotency_key !== 'string' || !idPattern.test(input.idempotency_key)) throw Error('INVALID_REPORT_REQUEST')
    const jobId = `rv2-${sha(`${b.case_id}:${b.attempt_id}:${input.idempotency_key}`).slice(0, 24)}`
    const previous = await loadJob(jobId)
    const fingerprint = sha(JSON.stringify({ ...b, business: input.business, roles: input.roles,
      price_snapshot_id: input.price_snapshot_id, rent_snapshot_id: input.rent_snapshot_id }))
    if (previous && previous.request_fingerprint !== fingerprint) throw Error('IDEMPOTENCY_CONFLICT')
    if (!previous) {
      if ((await readdir(jobsRoot)).filter(name => jobPattern.test(name)).length >= 50) throw Error('DEMO_JOB_LIMIT')
      const dir = join(jobsRoot, jobId)
      await mkdir(dir, { mode: 0o700 })
      const job = { ...b, job_id: jobId, status: 'queued', quality_status: 'pending',
        request_fingerprint: fingerprint, created_at: new Date().toISOString() }
      await writeFile(jobPath(jobId), JSON.stringify(job), { mode: 0o600, flag: 'wx' })
      setImmediate(() => void runJob(job))
    }
    return { ...b, job_id: jobId, status: previous?.status ?? 'queued' }
  }
  if (suffix === 'job.status' || suffix === 'file.get') {
    const job = await loadJob(input.job_id)
    if (!job || job.case_id !== input.case_id || job.attempt_id !== input.attempt_id
      || job.input_sha256 !== inputSha || job.release_id !== releaseId)
      throw Error('JOB_NOT_FOUND')
    const b = { case_id: job.case_id, attempt_id: job.attempt_id, city_code: job.city_code,
      input_sha256: job.input_sha256, release_id: job.release_id, stage: job.stage }
    if (suffix === 'job.status') return { ...b, job_id: job.job_id, status: job.status,
      quality_status: job.quality_status, files: job.status === 'succeeded' ? job.files : [],
      ...(job.error ? { error: job.error } : {}) }
    if (job.status !== 'succeeded') throw Error('JOB_NOT_READY')
    const file = job.files.find(item => item.file_id === input.file_id)
    if (!file) throw Error('FILE_NOT_FOUND')
    return { ...b, job_id: job.job_id, ...file,
      download_ref: `/api/residential-v2/files/${job.job_id}/${file.file_id}` }
  }
  throw Error('CAPABILITY_UNKNOWN')
}

function respond(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length,
    'cache-control': 'no-store' })
  res.end(body)
}
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/health' && req.method === 'GET') return respond(res, 200, {
    ok: true, release_id: releaseId, mode: 'demo', new_cases_enabled: false,
    visual_review: 'pending', professional_signoff: 'pending' })
  const internalJob = /^\/internal-jobs\/(rv2-[0-9a-f]{24})$/.exec(url.pathname)
  if (internalJob && req.method === 'GET') {
    const job = await loadJob(internalJob[1])
    if (!job || job.mode !== 'demo') return respond(res, 404, { error: 'JOB_NOT_FOUND' })
    return respond(res, 200, { job_id: job.job_id, status: job.status, quality_status: job.quality_status,
      release_id: job.release_id, completed_at: job.completed_at ?? null,
      files: job.status === 'succeeded' ? job.files : [] })
  }
  const file = /^\/internal-files\/(rv2-[0-9a-f]{24})\/((?:price_full|price_external|rent_full|rent_external)-[0-9a-f]{12})$/.exec(url.pathname)
  if (file && req.method === 'GET') {
    const job = await loadJob(file[1])
    const item = job?.status === 'succeeded' ? job.files?.find(row => row.file_id === file[2]) : undefined
    if (!item || !filePattern.test(item.file_id)) return respond(res, 404, { error: 'FILE_NOT_FOUND' })
    const path = join(jobsRoot, job.job_id, `${item.file_id}.docx`)
    try {
      if ((await stat(path)).size !== item.size_bytes || await hashFile(path) !== item.sha256) throw Error('FILE_CHECKSUM_MISMATCH')
      res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-length': item.size_bytes, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
        'x-content-sha256': item.sha256,
        'cache-control': 'private, no-store' })
      return createReadStream(path).pipe(res)
    } catch { return respond(res, 409, { error: 'FILE_CHECKSUM_MISMATCH' }) }
  }
  const match = /^\/api\/v2\/capabilities\/(subject\.validate|marketvalue\.infer|rentvalue\.infer|report\.generate|job\.status|file\.get)$/.exec(url.pathname)
  if (!match) return respond(res, 404, { error: 'NOT_FOUND' })
  const suffix = match[1]
  if (req.method !== (suffix === 'job.status' || suffix === 'file.get' ? 'GET' : 'POST'))
    return respond(res, 405, fail(suffix, 'METHOD_NOT_ALLOWED', '请求方式不匹配'))
  let input
  if (req.method === 'GET') input = Object.fromEntries(url.searchParams)
  else {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64_000) return respond(res, 413, fail(suffix, 'INPUT_TOO_LARGE', '请求超过上限'))
      chunks.push(chunk)
    }
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { return respond(res, 400, fail(suffix, 'INVALID_JSON', '请求不是 JSON')) }
  }
  try { return respond(res, 200, envelope(suffix, await dispatch(suffix, input))) }
  catch (error) {
    const code = error instanceof Error ? error.message : 'INTERNAL_ERROR'
    const known = /^[A-Z_]+$/.test(code)
    return respond(res, known ? 400 : 500, fail(suffix, known ? code : 'INTERNAL_ERROR',
      known ? code : '接线服务内部错误'))
  }
})
for (const name of await readdir(jobsRoot)) {
  if (!jobPattern.test(name)) continue
  const job = await loadJob(name)
  if (job?.status === 'queued') setImmediate(() => void runJob(job))
}
server.listen(port, '127.0.0.1')
