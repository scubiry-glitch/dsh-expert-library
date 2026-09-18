#!/usr/bin/env node
/**
 * `dsh-pack` — the developer-facing entry for external domain packs.
 *
 * Two halves, deliberately different in kind:
 *
 * - `check` runs **locally, offline**, against the same loader the platform
 *   uses (`loadPackFromDir`, via `adapt-partner-pack.mjs`). A contributor gets
 *   the platform's verdict before pushing, so "it passed on my machine" cannot
 *   mean something different from "it passed on the platform".
 * - Everything else talks to the running gateway's `/manage/packs/*` routes,
 *   which own the fetch/validate/install pipeline. The CLI re-implements none
 *   of it, so there is exactly one copy of the supply-chain logic.
 *
 * Usage:
 *   dsh-pack check <packDir>
 *   dsh-pack list
 *   dsh-pack onboard <locator> [--ref <ref>] [--approve]
 *   dsh-pack rollback <id>
 *   dsh-pack remove <id>
 *
 * Options:
 *   --base <url>    Gateway base (default http://127.0.0.1:3080)
 *   --token <tok>   Manage token; defaults to DSH_EXPERT_LIBRARY_MANAGE_TOKEN
 *
 * @module dsh-expert-library/scripts/dsh-pack
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANAGE_TOKEN_HEADER = 'x-expert-library-manage-token'
const MANAGE_TOKEN_ENV = 'DSH_EXPERT_LIBRARY_MANAGE_TOKEN'

/** Parse argv into a command, positionals, and flags. */
function parseArgs(argv) {
  const positionals = []
  const flags = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[name] = true
      } else {
        flags[name] = next
        i += 1
      }
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flags }
}

/** Resolve the gateway base and token. */
function resolveEndpoint(flags) {
  const base = typeof flags.base === 'string' ? flags.base : 'http://127.0.0.1:3080'
  const token = typeof flags.token === 'string'
    ? flags.token
    : (process.env[MANAGE_TOKEN_ENV] ?? '')
  return { base: base.replace(/\/+$/, ''), token }
}

/** One JSON request against the manage surface. */
async function callManage(path, init, endpoint) {
  const headers = { ...(init?.headers ?? {}) }
  if (endpoint.token !== '') headers[MANAGE_TOKEN_HEADER] = endpoint.token
  let res
  try {
    res = await fetch(`${endpoint.base}${path}`, { ...init, headers })
  } catch (error) {
    throw new Error(
      `cannot reach ${endpoint.base} — is the gateway running? (${String(error)})`,
    )
  }
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  if (res.status === 403) {
    throw new Error(
      endpoint.token === ''
        ? 'refused: this surface is loopback-only unless a manage token is supplied (--token or '
          + `${MANAGE_TOKEN_ENV})`
        : 'refused: the manage token was rejected',
    )
  }
  // The gateway's own browser-session gate answers before any plugin handler,
  // so a CLI without a session cookie lands here. Say so explicitly: an empty
  // result would otherwise read as "no packs installed" — a silent lie.
  if (res.status === 401) {
    throw new Error(
      'refused by the gateway auth gate (401). The manage surface sits behind the platform browser '
      + 'session, which this CLI does not carry — use the settings page card, or run against a '
      + 'gateway whose auth gate is disabled.',
    )
  }
  // Any other error status without a structured body is a transport-level
  // failure, not a business answer; never let it look like an empty result.
  if (body === null && res.status >= 400) {
    throw new Error(`HTTP ${res.status} from ${path} (no JSON body)`)
  }
  return { status: res.status, body }
}

/** `check` — the platform's own loader, run offline against a directory. */
function check(packDir) {
  const script = join(HERE, 'adapt-partner-pack.mjs')
  const result = spawnSync(process.execPath, [script, 'check', packDir], { stdio: 'inherit' })
  return result.status ?? 1
}

/** Print a diagnostics list the way the build does. */
function printDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    console.log('  (no diagnostics)')
    return
  }
  for (const item of diagnostics) {
    console.log(`  [${item.severity}] ${item.code} @ ${item.path}: ${item.message}`)
  }
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const [command, ...rest] = positionals

  if (command === undefined || command === 'help' || flags.help === true) {
    console.log('usage: dsh-pack <check|list|onboard|rollback|remove> [...]')
    console.log('  check <packDir>                          validate a local pack offline')
    console.log('  list                                     installed vendored packs')
    console.log('  onboard <locator> [--ref R] [--approve]  fetch, validate, install')
    console.log('  rollback <id>                            return to the previous revision')
    console.log('  remove <id>                              uninstall a vendored pack')
    return command === undefined ? 2 : 0
  }

  if (command === 'check') {
    const packDir = rest[0]
    if (packDir === undefined) {
      console.error('dsh-pack check: a pack directory is required')
      return 2
    }
    // Offline by construction: no endpoint is resolved on this path.
    return check(packDir)
  }

  const endpoint = resolveEndpoint(flags)

  if (command === 'list') {
    const { body } = await callManage('/plugins/dsh-expert-library/manage/packs/registry', {}, endpoint)
    const packs = body?.packs ?? []
    if (packs.length === 0) {
      console.log('no vendored packs installed')
      return 0
    }
    for (const pack of packs) {
      console.log(`${pack.id}  ${pack.revision.slice(0, 12)}  ${pack.trust}  ${pack.state}`
        + `${pack.rollbackAvailable ? '  (rollback available)' : ''}`)
      console.log(`  from ${pack.locator}${pack.requestedRef === undefined ? '' : ` @ ${pack.requestedRef}`}`)
    }
    return 0
  }

  if (command === 'onboard') {
    const locator = rest[0]
    if (locator === undefined) {
      console.error('dsh-pack onboard: a locator is required')
      return 2
    }
    const payload = { locator, approve: flags.approve === true }
    if (typeof flags.ref === 'string') payload.ref = flags.ref
    const { status, body } = await callManage(
      '/plugins/dsh-expert-library/manage/packs/onboard',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      endpoint,
    )
    if (body?.ok === true) {
      console.log(`installed ${body.packId} @ ${body.revision} (${body.trust}, drift=${body.drift})`)
      return 0
    }
    if (body?.needsReview === true) {
      console.log(`fetched ${body.revision} — this host is not allowlisted, so nothing was installed.`)
      console.log(`pack id: ${body.packId ?? '(unresolved)'}  valid: ${body.valid}`)
      printDiagnostics(body.diagnostics)
      console.log(body.hint ?? 're-run with --approve to install.')
      return 1
    }
    console.error(`refused (HTTP ${status}): ${body?.error ?? 'unparseable response'}`)
    printDiagnostics(body?.diagnostics)
    return 1
  }

  if (command === 'rollback') {
    const id = rest[0]
    if (id === undefined) {
      console.error('dsh-pack rollback: a pack id is required')
      return 2
    }
    const { status, body } = await callManage(
      '/plugins/dsh-expert-library/manage/packs/rollback',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) },
      endpoint,
    )
    if (body?.ok === true) {
      console.log(`rolled back ${id} to ${body.revision}`)
      return 0
    }
    console.error(`rollback failed (HTTP ${status}): ${body?.error ?? 'unparseable response'}`)
    return 1
  }

  if (command === 'remove') {
    const id = rest[0]
    if (id === undefined) {
      console.error('dsh-pack remove: a pack id is required')
      return 2
    }
    const { status, body } = await callManage(
      `/plugins/dsh-expert-library/manage/packs/vendored?id=${encodeURIComponent(id)}`,
      { method: 'DELETE' },
      endpoint,
    )
    if (body?.ok === true) {
      console.log(`removed ${id}`)
      return 0
    }
    console.error(`remove failed (HTTP ${status}): ${body?.error ?? 'unparseable response'}`)
    return 1
  }

  console.error(`unknown command "${command}" — try: dsh-pack help`)
  return 2
}

// Report refusals as one line, not a stack: every failure this CLI raises is an
// operator-facing condition (auth, unreachable gateway, refused pack), and the
// stack only buries the sentence that matters.
try {
  process.exitCode = await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
