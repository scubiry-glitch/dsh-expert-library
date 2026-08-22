/**
 * Canonical serialization, hashing and deep-freezing utilities shared by the
 * TeamTemplate Compiler (Phase 3) and the Quality Gate Runtime (Phase 4).
 *
 * Everything here is deterministic: `canonicalize` sorts object keys and
 * normalizes number edge cases, so equal *values* always serialize to equal
 * strings regardless of key insertion order, and `canonicalDigest` yields the
 * same SHA-256 for the same semantic content. The compiler uses this for the
 * ExecutionPlan digest ("同一模板 + 同一绑定 ⇒ 同构 DAG", §4.3), and the gate
 * runtime uses it for artifact hashes (§3.6/§6).
 *
 * Pure module: no I/O, no global state; the only import is the Node built-in
 * `crypto` (same dependency the legacy `src/state.ts` already uses).
 * @module dsh-expert-library/v2/digest
 */

import { createHash } from 'node:crypto'

/**
 * Serialize any JSON-safe value into a canonical string: object keys are
 * sorted, `undefined` object values are dropped (arrays keep `null` for
 * `undefined` items, mirroring JSON semantics), and `-0`/`NaN`/infinities are
 * normalized so bit-identical JSON text cannot differ.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number': {
      if (Number.isNaN(value) || value === Infinity || value === -Infinity) return 'null'
      return Object.is(value, -0) ? '0' : JSON.stringify(value)
    }
    case 'string':
      return JSON.stringify(value)
    case 'bigint':
      return `${value}n`
    case 'undefined':
      return 'null'
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map(item => canonicalize(item)).join(',')}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
        .filter(key => record[key] !== undefined)
        .sort()
      return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
    }
    default:
      return JSON.stringify(String(value))
  }
}

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** SHA-256 hex digest over the canonical serialization of a value. */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalize(value))
}

/**
 * Recursively freeze a value (objects and arrays), making it immutable at
 * runtime. The compiler freezes every ExecutionPlan; the quality runtime
 * freezes its round reports. Only acyclic data is expected here.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}
