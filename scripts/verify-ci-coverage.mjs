import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const expected = {
  provider: 'v8',
  include: ['src/**/*.{ts,tsx}'],
  exclude: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', '**/__tests__/**'],
  reporter: ['text-summary', 'json-summary'],
  thresholds: { statements: 79, branches: 70, functions: 85, lines: 81 },
}

const same = (actual, wanted) =>
  JSON.stringify(actual) === JSON.stringify(wanted)

export function coverageContractDiagnostics(
  packageData,
  vitestConfig,
  workflow,
) {
  const diagnostics = []
  const scripts = packageData?.scripts ?? {}
  const coverage = vitestConfig?.test?.coverage ?? {}
  const job = workflow?.jobs?.coverage
  const required = workflow?.jobs?.required

  if (!vitestConfig?.test?.coverage) {
    diagnostics.push(
      'Vitest coverage configuration must be under test.coverage',
    )
  }

  if (packageData?.devDependencies?.['@vitest/coverage-v8'] !== '^4.1.10') {
    diagnostics.push('package.json must pin @vitest/coverage-v8 to ^4.1.10')
  }
  if (
    scripts['test:coverage'] !==
    'vitest run --coverage && node scripts/verify-nonzero-runtime-coverage.mjs'
  ) {
    diagnostics.push(
      'package.json must define test:coverage with global thresholds and per-runtime-module enforcement',
    )
  }
  if (scripts['verify:ci-coverage'] !== 'node scripts/verify-ci-coverage.mjs') {
    diagnostics.push('package.json must define verify:ci-coverage')
  }
  if (!scripts.check?.includes('npm run verify:ci-coverage')) {
    diagnostics.push('scripts.check must invoke npm run verify:ci-coverage')
  }
  if (coverage.provider !== expected.provider)
    diagnostics.push('Vitest coverage provider must be v8')
  if (!same(coverage.include, expected.include))
    diagnostics.push('Vitest coverage include must be src/**/*.{ts,tsx}')
  if (!same(coverage.exclude, expected.exclude)) {
    diagnostics.push(
      'Vitest coverage must exclude test, declaration, and __tests__ files',
    )
  }
  if (!same(coverage.reporter, expected.reporter))
    diagnostics.push(
      'Vitest coverage reporters must be text-summary and json-summary',
    )
  for (const [metric, floor] of Object.entries(expected.thresholds)) {
    if (coverage.thresholds?.[metric] !== floor)
      diagnostics.push(`Vitest ${metric} coverage floor must be ${floor}`)
  }
  if (!job) {
    diagnostics.push('CI workflow must define a Coverage job')
  } else {
    if (
      job.name !== 'Coverage' ||
      job['runs-on'] !== 'ubuntu-latest' ||
      job['timeout-minutes'] !== 20
    )
      diagnostics.push('Coverage job must be Ubuntu with a 20 minute timeout')
    const setup = job.steps?.find((step) =>
      step.uses?.startsWith('actions/setup-node@'),
    )
    if (setup?.with?.['node-version'] !== 24 || setup?.with?.cache !== 'npm')
      diagnostics.push('Coverage job must use Node 24 with npm cache')
    if (!job.steps?.some((step) => step.run === 'npm ci'))
      diagnostics.push('Coverage job must run npm ci')
    if (!job.steps?.some((step) => step.run === 'npm run test:coverage'))
      diagnostics.push('Coverage job must run npm run test:coverage')
    const prerequisites = job.steps?.find(
      (step) => step.name === 'Install terminal and Linux sandbox test tools',
    )
    if (!prerequisites) {
      diagnostics.push(
        'Coverage job must include the Linux test tools prerequisite step',
      )
    } else {
      const run = prerequisites.run ?? ''
      for (const command of ['rg', 'expect', 'tmux', 'bwrap', 'socat']) {
        if (!run.includes(`command -v ${command} >/dev/null`))
          diagnostics.push(
            `Coverage prerequisite must verify command -v ${command}`,
          )
      }
      if (
        !run.includes('apt-get install -y ripgrep expect tmux bubblewrap socat')
      )
        diagnostics.push(
          'Coverage prerequisite must install the Linux test tools',
        )
      if (!run.includes('kernel.apparmor_restrict_unprivileged_userns'))
        diagnostics.push(
          'Coverage prerequisite must handle AppArmor user namespaces',
        )
    }
  }
  if (!required?.needs?.includes('coverage'))
    diagnostics.push('Required CI aggregate must depend on coverage')
  if (
    required?.steps?.[0]?.env?.COVERAGE_RESULT !==
    '${{ needs.coverage.result }}'
  )
    diagnostics.push('Required CI aggregate must export COVERAGE_RESULT')
  if (!required?.steps?.[0]?.run?.includes('test "$COVERAGE_RESULT" = success'))
    diagnostics.push('Required CI aggregate must require successful coverage')
  return diagnostics
}

async function main() {
  const root = new URL('../', import.meta.url)
  const packageData = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  )
  const vitestConfig = (await import(new URL('vitest.config.ts', root))).default
  const workflow = parse(
    await readFile(new URL('.github/workflows/ci.yml', root), 'utf8'),
  )
  const diagnostics = coverageContractDiagnostics(
    packageData,
    vitestConfig,
    workflow,
  )
  if (diagnostics.length) {
    console.error(diagnostics.map((entry) => `- ${entry}`).join('\n'))
    process.exitCode = 1
    return
  }
  console.log(
    'CI coverage contract is wired: V8 src coverage floors, per-runtime-module enforcement, and protected Coverage lane are present',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
