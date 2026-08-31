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
  console.log(
    `Fixture contract is valid: ${behaviors} behaviors, ${evidence} evidence entries, ${fixtures} fixtures, ${result.manifest.gates.length} gates`,
  )
  return true
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const valid = await verifyFixtureContracts()
  if (!valid) process.exitCode = 1
}
