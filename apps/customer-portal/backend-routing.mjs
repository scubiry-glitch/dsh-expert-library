/** Only a server-resolved principal may select an account's DSH deployment. */
export function resolveAccountBackend(principal, config) {
  if (!principal?.accountId || !principal.backendRef || principal.backendRef === 'default' || !principal.workspaceId) throw new Error('ACCOUNT_RUNTIME_UNBOUND')
  if (!config.dshBackends || !Object.hasOwn(config.dshBackends, principal.backendRef)) throw new Error('ACCOUNT_BACKEND_UNAVAILABLE')
  if (!config.researchEnabledBackends?.includes(principal.backendRef)) throw new Error('ACCOUNT_RESEARCH_NOT_RELEASED')
  const origin = config.dshBackends[principal.backendRef]
  return { origin, backendRef: principal.backendRef, workspaceId: principal.workspaceId }
}
