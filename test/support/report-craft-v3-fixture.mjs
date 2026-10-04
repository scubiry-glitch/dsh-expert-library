/** Current domain ledger only. Legacy v1/v2 fixture and historical artifacts remain unchanged. */
import { createCraftV2Fixture, rebuildCraftV2Fixture } from './report-craft-v2-fixture.mjs'
export function createCraftV3Fixture(options = {}) {
  const fixture = createCraftV2Fixture(options)
  fixture.evidence.schemaVersion = 2
  fixture.evidence.policyClaims = []
  return rebuildCraftV2Fixture(fixture)
}
export { rebuildCraftV2Fixture as rebuildCraftV3Fixture }
