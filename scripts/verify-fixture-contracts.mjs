import { fileURLToPath } from 'node:url'
import { validateFixtureContracts } from './lib/fixture-contracts.mjs'

export async function verifyFixtureContracts(
  root = fileURLToPath(new URL('../', import.meta.url)),
) {
  const result = await validateFixtureContracts(root)
  if (result.diagnostics.length) {
    console.error(result.diagnostics.map((entry) => `- ${entry}`).join('\n'))
    return false
  }
  const behaviors = result.manifest.behaviors.length
  const evidence = result.manifest.behaviors.reduce(
    (count, behavior) => count + behavior.evidence.length,
    0,
  )
  const fixtures = result.manifest.behaviors.reduce(
    (count, behavior) =>
      count +
      behavior.evidence.filter((entry) => entry.kind === 'fixture').length,
    0,
  )
  const riskTotals = result.manifest.behaviors.reduce(
    (totals, behavior) => {
      if (behavior.risk !== 'none') totals[behavior.risk] += 1
      totals.exemptions += behavior.evidenceRequirements.exemptions.length
      return totals
    },
    { low: 0, medium: 0, high: 0, release: 0, exemptions: 0 },
  )
  console.log(
    `Fixture contract is valid: schema v${result.manifest.schemaVersion}; ${behaviors} behaviors, ${evidence} evidence entries, ${fixtures} fixtures, ${result.manifest.gates.length} gates; risk tiers low=${riskTotals.low}, medium=${riskTotals.medium}, high=${riskTotals.high}, release=${riskTotals.release}; exemptions=${riskTotals.exemptions}`,
  )
  return true
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const valid = await verifyFixtureContracts()
  if (!valid) process.exitCode = 1
}
