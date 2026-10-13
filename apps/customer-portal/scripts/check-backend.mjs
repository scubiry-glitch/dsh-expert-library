import { readConfig } from '../config.mjs'
import { probeBackend } from '../dsh-backend.mjs'

try {
  const result = await probeBackend(readConfig())
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!result.reachable || !result.reviewRouteAvailable) process.exitCode = 1
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Invalid configuration'}\n`)
  process.exitCode = 1
}
