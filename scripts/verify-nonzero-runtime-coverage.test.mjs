import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  diagnoseCoverageSummary,
  discoverProductionPaths,
  readAndDiagnoseCoverageSummary,
} from './verify-nonzero-runtime-coverage.mjs'

const entry = (total, covered) => ({ statements: { total, covered } })

describe('nonzero runtime coverage gate', () => {
  it('rejects zero-covered runtime modules while allowing covered and type-only modules', () => {
    const result = diagnoseCoverageSummary(
      {
        total: entry(10, 10),
        'src/type-only.ts': entry(0, 0),
        'src/covered.ts': entry(4, 2),
        'src/zero.ts': entry(3, 0),
      },
      '/repo',
      ['src/type-only.ts', 'src/covered.ts', 'src/zero.ts'],
    )
    expect(result.ok).toBe(false)
    expect(result.zeroCovered).toEqual(['src/zero.ts'])
    expect(result.checkedRuntimeModules).toBe(2)
  })

  it('reports multiple zero-covered modules in sorted repository-relative order', () => {
    const result = diagnoseCoverageSummary(
      {
        'src/zeta.ts': entry(1, 0),
        'src/alpha.ts': entry(2, 0),
        'src/middle.ts': entry(1, 1),
      },
      '/repo',
      ['src/zeta.ts', 'src/alpha.ts', 'src/middle.ts'],
    )
    expect(result.zeroCovered).toEqual(['src/alpha.ts', 'src/zeta.ts'])
    expect(result.errors.at(-1)).toContain('src/alpha.ts, src/zeta.ts')
  })

  it('fails closed for malformed, missing, and outside-root summaries', async () => {
    expect(diagnoseCoverageSummary({}, '/repo', ['src/ok.ts']).ok).toBe(false)
    expect(
      diagnoseCoverageSummary(
        { 'src/bad.ts': { statements: { total: 1 } } },
        '/repo',
        ['src/bad.ts'],
      ).ok,
    ).toBe(false)
    expect(
      diagnoseCoverageSummary(
        { '../outside.ts': entry(1, 1), 'src/ok.ts': entry(1, 1) },
        '/repo',
        ['src/ok.ts'],
      ).ok,
    ).toBe(false)

    const directory = await mkdtemp(path.join(os.tmpdir(), 'praxis-coverage-'))
    try {
      const missing = await readAndDiagnoseCoverageSummary(
        path.join(directory, 'missing.json'),
        '/repo',
      )
      expect(missing.ok).toBe(false)
      const invalidPath = path.join(directory, 'invalid.json')
      await writeFile(invalidPath, '{not json')
      const invalid = await readAndDiagnoseCoverageSummary(invalidPath, '/repo')
      expect(invalid.ok).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects omitted expected modules and sorts missing paths', () => {
    const result = diagnoseCoverageSummary(
      { 'src/present.ts': entry(1, 1) },
      '/repo',
      ['src/zeta.ts', 'src/present.ts', 'src/alpha.ts'],
    )
    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      'missing coverage entries: src/alpha.ts, src/zeta.ts',
    )
  })

  it('discovers only configured production source files', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'praxis-source-'))
    try {
      const source = path.join(directory, 'src')
      await writeFile(path.join(directory, 'placeholder'), '')
      await mkdir(path.join(source, '__tests__'), { recursive: true })
      await mkdir(path.join(source, 'nested'), { recursive: true })
      for (const file of [
        'runtime.ts',
        'view.tsx',
        'runtime.test.ts',
        'runtime.spec.ts',
        'types.d.ts',
      ]) {
        await writeFile(path.join(source, file), '')
      }
      await writeFile(path.join(source, '__tests__', 'hidden.ts'), '')
      await writeFile(path.join(source, 'nested', 'nested.ts'), '')
      expect(await discoverProductionPaths(directory)).toEqual([
        'src/nested/nested.ts',
        'src/runtime.ts',
        'src/view.tsx',
      ])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reports source discovery failures separately from invalid JSON', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'praxis-no-source-'))
    try {
      const summaryPath = path.join(directory, 'summary.json')
      await writeFile(summaryPath, JSON.stringify({ total: entry(0, 0) }))
      const result = await readAndDiagnoseCoverageSummary(
        summaryPath,
        directory,
      )
      expect(result.ok).toBe(false)
      expect(result.errors[0]).toContain('unable to discover production paths')
      expect(result.errors.join('\n')).not.toContain(
        'invalid coverage summary JSON',
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
