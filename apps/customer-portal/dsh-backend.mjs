export async function probeBackend(config, fetchImpl = fetch) {
  const endpoint = new URL('/plugins/dsh-expert-library/review', config.dshBackendUrl)
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    return {
      reachable: true,
      reviewRouteAvailable: response.status !== 404 && response.status < 500,
      status: response.status,
    }
  } catch (error) {
    return { reachable: false, reviewRouteAvailable: false, error: error instanceof Error ? error.name : 'UnknownError' }
  }
}
