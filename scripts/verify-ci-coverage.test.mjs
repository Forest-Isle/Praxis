import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { coverageContractDiagnostics } from './verify-ci-coverage.mjs'

const packageData = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
const config = (await import('../vitest.config.ts')).default
const workflow = parse(
  await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  ),
)

describe('CI coverage contract verifier', () => {
  it('accepts the repository contract', () =>
    expect(coverageContractDiagnostics(packageData, config, workflow)).toEqual(
      [],
    ))
  it('rejects coverage configured at the ignored top-level path', () => {
    const invalid = JSON.parse(JSON.stringify(config))
    invalid.coverage = invalid.test.coverage
    delete invalid.test.coverage
    expect(
      coverageContractDiagnostics(packageData, invalid, workflow).join('\n'),
    ).toContain('test.coverage')
  })
  it('rejects extra production exclusions', () => {
    const invalid = JSON.parse(JSON.stringify(config))
    invalid.test.coverage.exclude.push('src/providers/**')
    expect(
      coverageContractDiagnostics(packageData, invalid, workflow).join('\n'),
    ).toContain('exclude test, declaration, and __tests__ files')
  })
  it('rejects a local check disconnected from the verifier', () => {
    const invalid = JSON.parse(JSON.stringify(packageData))
    invalid.scripts.check = invalid.scripts.check.replace(
      'npm run verify:ci-coverage',
      '',
    )
    expect(
      coverageContractDiagnostics(invalid, config, workflow).join('\n'),
    ).toContain('scripts.check must invoke npm run verify:ci-coverage')
  })
  it.each([
    [
      'missing Coverage job',
      (pkg, ci) => delete ci.jobs.coverage,
      'Coverage job',
    ],
    [
      'aggregate dependency',
      (_pkg, ci) => {
        ci.jobs.required.needs = ci.jobs.required.needs.filter(
          (entry) => entry !== 'coverage',
        )
      },
      'depend on coverage',
    ],
    [
      'package command',
      (pkg) => delete pkg.scripts['test:coverage'],
      'test:coverage',
    ],
  ])('rejects %s', (_name, mutate, message) => {
    const pkg = JSON.parse(JSON.stringify(packageData))
    const cfg = JSON.parse(JSON.stringify(config))
    const ci = JSON.parse(JSON.stringify(workflow))
    mutate(pkg, ci)
    expect(coverageContractDiagnostics(pkg, cfg, ci).join('\n')).toContain(
      message,
    )
  })
})
