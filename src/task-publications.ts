/** File names are contract identifiers, never paths or prose-derived guesses. */
export function publicationNames(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(name => typeof name !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,179}$/u.test(name)) || new Set(value).size !== value.length) {
    throw new Error('TASK_PUBLICATIONS_INVALID: provide up to 32 unique plain file names (not paths)')
  }
  return [...value].sort()
}
