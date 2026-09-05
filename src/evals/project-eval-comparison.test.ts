import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import {
  executeProjectEvalCompareCommand,
  loadProjectEvalAggregate,
  parseProjectEvalCompareOptions,
} from './project-eval-comparison.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

function aggregate(passed: boolean, safety = true) {
  return {
    schema_version: '1.0',
    version: 'test',
    start: new Date(0).toISOString(),
    duration_ms: 10,
    target: '/fixture',
    output_dir: '/out',
    model: 'scripted',
    case_count: 1,
    planned_run_count: 1,
    completed_run_count: 1,
    run_count: 1,
    passed: passed ? 1 : 0,
    failed: passed ? 0 : 1,
    pass_rate: passed ? 1 : 0,
    total_turns: 2,
    usage_totals: {
      input_tokens: 3,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      web_search_requests: 0,
    },
    usage_known_runs: 1,
    usage_unknown_runs: 0,
    known_cost_total_usd: null,
    known_cost_runs: 0,
    unknown_cost_runs: 1,
    partial: false,
    interrupted: false,
    safety_passed: safety ? 1 : 0,
    safety_failed: safety ? 0 : 1,
    permission_decisions: { allow: 1, ask: 0, deny: 0 },
    tool_errors: 0,
    retries: 0,
    terminations: { completed: 1, timeout: 0, interrupted: 0 },
    runs: [
      {
        case: 'case',
        run: 1,
        model: 'scripted',
        passed,
        score: passed ? 1 : 0,
        turns: 2,
        usage: { inputTokens: 3, outputTokens: 4 },
        cost_usd: null,
        cost_known: false,
        duration_ms: 10,
        termination: null,
        safety_passed: safety,
        permission_decisions: { allow: 1, ask: 0, deny: 0 },
        tool_errors: 0,
        retries: 0,
        error: null,
        artifact_dir: 'case/run-1',
      },
    ],
  }
}

function aggregateForCases(outcomes: readonly [string, boolean][]) {
  const runs = outcomes.map(([caseName, passed]) => ({
    ...aggregate(passed).runs[0],
    case: caseName,
    passed,
    score: passed ? 1 : 0,
    artifact_dir: `${caseName}/run-1`,
  }))
  const passed = runs.filter((run) => run.passed).length
  return {
    ...aggregate(true),
    case_count: runs.length,
    planned_run_count: runs.length,
    completed_run_count: runs.length,
    run_count: runs.length,
    passed,
    failed: runs.length - passed,
    pass_rate: passed / runs.length,
    total_turns: runs.length * 2,
    usage_totals: {
      input_tokens: runs.length * 3,
      output_tokens: runs.length * 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      web_search_requests: 0,
    },
    usage_known_runs: runs.length,
    usage_unknown_runs: 0,
    known_cost_runs: 0,
    unknown_cost_runs: runs.length,
    safety_passed: runs.length,
    safety_failed: 0,
    permission_decisions: { allow: runs.length, ask: 0, deny: 0 },
    terminations: { completed: runs.length, timeout: 0, interrupted: 0 },
    runs,
  }
}

function removeEvidence(value: ReturnType<typeof aggregate>): void {
  const artifact = value as Record<string, unknown>
  for (const key of [
    'safety_passed',
    'safety_failed',
    'permission_decisions',
    'tool_errors',
    'retries',
    'terminations',
  ])
    delete artifact[key]
  for (const run of value.runs) {
    const oldRun = run as unknown as Record<string, unknown>
    delete oldRun.safety_passed
    delete oldRun.permission_decisions
    delete oldRun.tool_errors
    delete oldRun.retries
  }
}

function onlyRun<T>(runs: readonly T[]): T {
  const run = runs[0]
  if (!run) throw new Error('test aggregate must contain one run')
  return run
}

describe('project eval comparison', () => {
  it('parses only the compare option surface', () => {
    expect(
      parseProjectEvalCompareOptions([
        '--baseline',
        'a',
        '--baseline-name',
        'base',
        '--candidate',
        'b',
        '--candidate-name',
        'cand',
      ]),
    ).toMatchObject({
      baseline: 'a',
      candidate: 'b',
      baselineName: 'base',
      candidateName: 'cand',
    })
    expect(() =>
      parseProjectEvalCompareOptions([
        '--baseline',
        'a',
        '--baseline-name',
        'base',
        '--candidate',
        'b',
        '--candidate-name',
        'cand',
        'extra',
      ]),
    ).toThrow('no positional')
    expect(() =>
      parseProjectEvalCompareOptions([
        '--baseline',
        'a',
        '--baseline-name',
        'base',
        '--candidate',
        'b',
        '--candidate-name',
        'cand',
        '--model',
        'ignored',
      ]),
    ).toThrow('Unknown eval compare option: --model')
  })

  it('writes deterministic output and returns 0/1 for both directions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-eval-compare-'))
    roots.push(root)
    const baseline = join(root, 'baseline.json')
    const candidate = join(root, 'candidate.json')
    await writeFile(baseline, JSON.stringify(aggregate(false)))
    await writeFile(candidate, JSON.stringify(aggregate(true)))
    const output: string[] = []
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          baseline,
          '--baseline-name',
          'base',
          '--candidate',
          candidate,
          '--candidate-name',
          'cand',
          '--json',
        ],
        { stdout: (value) => output.push(value), stderr: () => undefined },
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      passed: true,
      comparable_run_count: 1,
    })
    const resultPath = join(root, 'comparison-result.json')
    await expect(readFile(resultPath, 'utf8')).resolves.toContain(
      '"passed": true',
    )
    output.length = 0
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          candidate,
          '--baseline-name',
          'base',
          '--candidate',
          baseline,
          '--candidate-name',
          'cand',
          '--json',
        ],
        { stdout: (value) => output.push(value), stderr: () => undefined },
      ),
    ).resolves.toBe(1)

    const unsafe = join(root, 'unsafe.json')
    await writeFile(unsafe, JSON.stringify(aggregate(true, false)))
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          candidate,
          '--baseline-name',
          'base',
          '--candidate',
          unsafe,
          '--candidate-name',
          'unsafe',
        ],
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).resolves.toBe(1)
  })

  it('does not pass when safety evidence is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-eval-compare-old-'))
    roots.push(root)
    const old = aggregate(true)
    removeEvidence(old)
    const left = join(root, 'left.json')
    const right = join(root, 'right.json')
    const output: string[] = []
    await writeFile(left, JSON.stringify(old))
    await writeFile(right, JSON.stringify(old))
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          left,
          '--baseline-name',
          'base',
          '--candidate',
          right,
          '--candidate-name',
          'cand',
          '--json',
        ],
        {
          stdout: (value) => output.push(value),
          stderr: () => undefined,
        },
      ),
    ).resolves.toBe(1)
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      passed: false,
      metrics: {
        safety_pass_rate: { baseline: null, candidate: null, delta: null },
        permission_decisions: {
          allow: { baseline: null, candidate: null, delta: null },
        },
        tool_errors: { baseline: null, candidate: null, delta: null },
        retries: { baseline: null, candidate: null, delta: null },
      },
    })
  })

  it('fails when a matching run regresses despite aggregate pass-rate parity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-eval-compare-rate-'))
    roots.push(root)
    const baselinePath = join(root, 'baseline.json')
    const candidatePath = join(root, 'candidate.json')
    await writeFile(
      baselinePath,
      JSON.stringify(
        aggregateForCases([
          ['case-a', true],
          ['case-b', false],
        ]),
      ),
    )
    await writeFile(
      candidatePath,
      JSON.stringify(
        aggregateForCases([
          ['case-a', false],
          ['case-b', true],
        ]),
      ),
    )
    const output: string[] = []
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          baselinePath,
          '--baseline-name',
          'base',
          '--candidate',
          candidatePath,
          '--candidate-name',
          'cand',
          '--json',
        ],
        { stdout: (value) => output.push(value), stderr: () => undefined },
      ),
    ).resolves.toBe(1)
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      passed: false,
      regressions: [{ case: 'case-a', run: 1 }],
      metrics: { pass_rate: { delta: 0 } },
    })
  })

  it('preserves known sides and emits null deltas for incomplete usage and cost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-eval-compare-null-'))
    roots.push(root)
    const baseline = aggregate(true) as unknown as {
      known_cost_total_usd: number | null
      known_cost_runs: number
      unknown_cost_runs: number
      runs: { cost_usd: number | null; cost_known: boolean }[]
    }
    baseline.known_cost_total_usd = 0.5
    baseline.known_cost_runs = 1
    baseline.unknown_cost_runs = 0
    onlyRun(baseline.runs).cost_usd = 0.5
    onlyRun(baseline.runs).cost_known = true
    const candidate = aggregate(true) as unknown as {
      usage_totals: { input_tokens: number; output_tokens: number }
      usage_known_runs: number
      usage_unknown_runs: number
      runs: { usage: { inputTokens: number; outputTokens: number } | null }[]
    }
    candidate.usage_totals.input_tokens = 0
    candidate.usage_totals.output_tokens = 0
    candidate.usage_known_runs = 0
    candidate.usage_unknown_runs = 1
    onlyRun(candidate.runs).usage = null
    const baselinePath = join(root, 'baseline.json')
    const candidatePath = join(root, 'candidate.json')
    await writeFile(baselinePath, JSON.stringify(baseline))
    await writeFile(candidatePath, JSON.stringify(candidate))
    const output: string[] = []
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          baselinePath,
          '--baseline-name',
          'base',
          '--candidate',
          candidatePath,
          '--candidate-name',
          'cand',
          '--json',
        ],
        { stdout: (value) => output.push(value), stderr: () => undefined },
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({
      metrics: {
        input_tokens: { baseline: 3, candidate: null, delta: null },
        output_tokens: { baseline: 4, candidate: null, delta: null },
        known_cost_total_usd: {
          baseline: 0.5,
          candidate: null,
          delta: null,
        },
      },
    })
  })

  it('rejects internally inconsistent, partial, and mismatched aggregates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-eval-compare-invalid-'))
    roots.push(root)
    const invalidPath = join(root, 'invalid.json')
    const invalid = aggregate(true)
    invalid.passed = 0
    invalid.failed = 1
    invalid.pass_rate = 0
    await writeFile(invalidPath, JSON.stringify(invalid))
    await expect(loadProjectEvalAggregate(invalidPath)).rejects.toThrow(
      'does not match run outcomes',
    )

    const duplicatePath = join(root, 'duplicate.json')
    await writeFile(
      duplicatePath,
      JSON.stringify(
        aggregateForCases([
          ['duplicate', true],
          ['duplicate', true],
        ]),
      ),
    )
    await expect(loadProjectEvalAggregate(duplicatePath)).rejects.toThrow(
      'duplicate (case,run) key',
    )

    const baselinePath = join(root, 'baseline.json')
    const partialPath = join(root, 'partial.json')
    const mismatchPath = join(root, 'mismatch.json')
    await writeFile(baselinePath, JSON.stringify(aggregate(true)))
    const partial = aggregate(true)
    partial.planned_run_count = 2
    partial.partial = true
    await writeFile(partialPath, JSON.stringify(partial))
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          baselinePath,
          '--baseline-name',
          'base',
          '--candidate',
          partialPath,
          '--candidate-name',
          'cand',
        ],
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toThrow('complete, uninterrupted')

    const mismatch = aggregate(true)
    onlyRun(mismatch.runs).case = 'different-case'
    onlyRun(mismatch.runs).artifact_dir = 'different-case/run-1'
    await writeFile(mismatchPath, JSON.stringify(mismatch))
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          baselinePath,
          '--baseline-name',
          'base',
          '--candidate',
          mismatchPath,
          '--candidate-name',
          'cand',
        ],
        { stdout: () => undefined, stderr: () => undefined },
      ),
    ).rejects.toThrow('different comparable run sets')
  })

  it('rejects symlink inputs and returns 130 without writing when aborted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-eval-compare-abort-'))
    roots.push(root)
    const baselinePath = join(root, 'baseline.json')
    const linkedPath = join(root, 'linked.json')
    const candidatePath = join(root, 'candidate.json')
    await writeFile(baselinePath, JSON.stringify(aggregate(true)))
    await writeFile(candidatePath, JSON.stringify(aggregate(true)))
    await symlink(baselinePath, linkedPath)
    await expect(loadProjectEvalAggregate(linkedPath)).rejects.toThrow(
      'contains symlink',
    )
    const oversizedPath = join(root, 'oversized.json')
    await writeFile(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(loadProjectEvalAggregate(oversizedPath)).rejects.toThrow(
      'exceeds 8 MiB',
    )

    const controller = new AbortController()
    controller.abort()
    await expect(
      executeProjectEvalCompareCommand(
        [
          '--baseline',
          baselinePath,
          '--baseline-name',
          'base',
          '--candidate',
          candidatePath,
          '--candidate-name',
          'cand',
        ],
        { stdout: () => undefined, stderr: () => undefined },
        process.cwd(),
        controller.signal,
      ),
    ).resolves.toBe(130)
    await expect(lstat(join(root, 'comparison-result.json'))).rejects.toThrow()
  })
})
