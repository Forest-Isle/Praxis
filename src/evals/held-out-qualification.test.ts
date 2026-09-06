import { createHash } from 'node:crypto'
import {
  access,
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type {
  EvalRuntimeFactoryOptions,
  IdentifiedEvalRuntimeFactory,
} from './eval-contract.js'
import { computeProjectEvalAggregateIdentity } from './project-eval-identity.js'
import {
  executeHeldOutQualificationCommand,
  parseHeldOutQualificationOptions,
  type HeldOutQualificationResult,
} from './held-out-qualification.js'

const roots: string[] = []
const corpus = resolve('test/corpora/project-evals/praxis-held-out-v1')
const corpusDigest =
  'sha256:47dfad705f94463ce885e06a61601724be309f9d423241a4df91afde1503ccdb'
const baselineBuild = {
  schema_version: '1.0' as const,
  source_revision: `git:${'a'.repeat(40)}` as `git:${string}`,
  source_dirty: false,
  artifact_sha256: `sha256:${'b'.repeat(64)}` as `sha256:${string}`,
}
const candidateBuild = {
  schema_version: '1.0' as const,
  source_revision: `git:${'c'.repeat(40)}` as `git:${string}`,
  source_dirty: false,
  artifact_sha256: `sha256:${'d'.repeat(64)}` as `sha256:${string}`,
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function newPath(prefix: string, child: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return join(root, child)
}

function qualificationArgs(
  outputDir: string,
  overrides: {
    baseline?: string
    confirm?: string
    allowTools?: string
    model?: string
  } = {},
): string[] {
  return [
    '--provider',
    'fixture-provider',
    '--profile',
    'fixture-profile',
    '--model',
    overrides.model ?? 'fixture/model:qualified@v1',
    '--confirm-held-out',
    overrides.confirm ?? `praxis-held-out-v1@${corpusDigest}`,
    '--run-verification',
    '--allow-tools',
    overrides.allowTools ?? 'Bash,Read,Glob,Grep,Edit,Write',
    '--output-dir',
    outputDir,
    ...(overrides.baseline ? ['--baseline', overrides.baseline] : []),
    corpus,
  ]
}

const solutions: ReadonlyArray<{
  prompt: string
  path: string
  source: string
}> = [
  {
    prompt: 'add renderConfig',
    path: 'src/cli.cjs',
    source: `module.exports.renderConfig = (config, options = {}) => options.json ? JSON.stringify(config) + '\\n' : Object.entries(config).map(([key, value]) => key + '=' + value).join('\\n') + '\\n';`,
  },
  {
    prompt: 'make each defined environment value override',
    path: 'src/config.cjs',
    source: `module.exports.loadConfig = (fileValues, envValues) => ({...fileValues, ...Object.fromEntries(Object.entries(envValues).filter(([, value]) => value !== undefined))});`,
  },
  {
    prompt: 'preserve explicit zero and false values',
    path: 'src/config.cjs',
    source: `module.exports.loadConfig = (fileValues, envValues) => ({port: 3000, debug: true, ...fileValues, ...envValues});`,
  },
  {
    prompt: 'make parsePort accept only integer numbers',
    path: 'src/config.cjs',
    source: `module.exports.parsePort = (value) => { if (!Number.isInteger(value) || value < 1 || value > 65535) throw new RangeError('port must be an integer from 1 to 65535'); return value; };`,
  },
  {
    prompt: 'export truncateMiddle',
    path: 'src/index.cjs',
    source: `module.exports.truncateMiddle = (value, maxLength) => value.length <= maxLength ? value : value.slice(0, Math.floor((maxLength - 1) / 2)) + '…' + value.slice(value.length - Math.ceil((maxLength - 1) / 2));`,
  },
  {
    prompt: 'export wordStats',
    path: 'src/index.cjs',
    source: `module.exports.wordStats = (value) => { const words = value.trim() ? value.trim().toLowerCase().split(/\\s+/u) : []; return {words: words.length, unique: new Set(words).size}; };`,
  },
  {
    prompt: 'normalize any run of whitespace',
    path: 'src/slug.cjs',
    source: `module.exports.slugify = (value) => value.toLowerCase().replace(/[\\s_-]+/gu, '-').replace(/^-|-$/gu, '');`,
  },
  {
    prompt: 'make truncate throw',
    path: 'src/index.cjs',
    source: `module.exports.truncate = (value, maxLength) => { if (!Number.isInteger(maxLength) || maxLength < 0) throw new RangeError('maxLength must be a non-negative integer'); return value.slice(0, maxLength); };`,
  },
  {
    prompt: 'make filterCompleted return',
    path: 'src/store.cjs',
    source: `module.exports.filterCompleted = (tasks, completed) => completed === undefined ? tasks : tasks.filter((task) => task.completed === completed);`,
  },
  {
    prompt: 'reject adding an existing ID',
    path: 'src/store.cjs',
    source: `module.exports.addTask = (tasks, task) => { if (tasks.some((item) => item.id === task.id)) throw new Error('duplicate task id: ' + task.id); return [...tasks, task]; };`,
  },
  {
    prompt: 'parse JSON storage only',
    path: 'src/store.cjs',
    source: `module.exports.parseTasks = (source) => { const value = JSON.parse(source); if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id)) throw new TypeError('task data must be an array of tasks'); return value; };`,
  },
  {
    prompt: 'sort tasks by descending priority stably',
    path: 'src/sort.cjs',
    source: `module.exports.byPriority = (tasks) => tasks.map((task, index) => ({task, index})).sort((left, right) => right.task.priority - left.task.priority || left.index - right.index).map(({task}) => task);`,
  },
]

async function applySolution(cwd: string, prompt: string): Promise<void> {
  const solution = solutions.find((item) => prompt.includes(item.prompt))
  if (!solution)
    throw new Error(`Missing scripted solution for prompt: ${prompt}`)
  await appendFile(join(cwd, solution.path), `\n${solution.source}\n`)
}

interface FactoryHarness {
  factory: IdentifiedEvalRuntimeFactory
  counts: { identify: number; create: number; run: number }
}

function factoryHarness(
  options: {
    solve?: boolean
    failPrompt?: string
    endpoint?: string
    abortController?: AbortController
    abortOnRun?: number
    onCreate?: (factoryOptions: EvalRuntimeFactoryOptions) => void
  } = {},
): FactoryHarness {
  const counts = { identify: 0, create: 0, run: 0 }
  return {
    counts,
    factory: {
      identify: async (factoryOptions) => {
        counts.identify += 1
        return {
          providerId: factoryOptions.provider ?? 'fixture-provider',
          profileId: factoryOptions.providerProfile ?? 'fixture-profile',
          protocol: 'fixture',
          endpoint: options.endpoint ?? 'https://fixture.invalid/v1',
          modelId: factoryOptions.model ?? 'fixture/model:qualified@v1',
        }
      },
      create: async (factoryOptions) => {
        counts.create += 1
        options.onCreate?.(factoryOptions)
        return {
          run: async (prompt) => {
            counts.run += 1
            if (options.abortOnRun === counts.run)
              options.abortController?.abort('test interruption')
            if (
              options.solve &&
              !options.abortController?.signal.aborted &&
              !prompt.includes(options.failPrompt ?? '\u0000')
            )
              await applySolution(factoryOptions.cwd, prompt)
            return { text: 'scripted', turns: ((counts.run - 1) % 3) + 1 }
          },
          close: async () => undefined,
        }
      },
    },
  }
}

async function executeQualification(options: {
  output: string
  harness: FactoryHarness
  baseline?: string
  build?: typeof baselineBuild
  version?: string
  signal?: AbortSignal
  argv?: string[]
  configRoot?: string
}): Promise<{
  code: number
  stdout: string[]
  stderr: string[]
  result?: HeldOutQualificationResult
}> {
  const configRoot =
    options.configRoot ??
    (await newPath('praxis-qualification-config-', 'config'))
  const stdout: string[] = []
  const stderr: string[] = []
  const code = await executeHeldOutQualificationCommand(
    options.argv ??
      qualificationArgs(options.output, {
        ...(options.baseline ? { baseline: options.baseline } : {}),
      }),
    {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    {
      runtimeFactory: options.harness.factory,
      loadBuildIdentity: async () => options.build ?? baselineBuild,
      version: options.version ?? 'baseline-version',
      configRoot,
    },
    process.cwd(),
    options.signal,
  )
  const resultPath = join(options.output, 'qualification-result.json')
  const result = await readFile(resultPath, 'utf8')
    .then((value) => JSON.parse(value) as HeldOutQualificationResult)
    .catch(() => undefined)
  return { code, stdout, stderr, ...(result ? { result } : {}) }
}

async function copyQualification(
  source: string,
  name: string,
): Promise<string> {
  const target = await newPath(`praxis-qualification-${name}-`, 'baseline')
  await cp(source, target, { recursive: true })
  return target
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] as number
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

let sharedBaselineRoot = ''
let sharedBaselineOutput = ''
let sharedBaselineResult: HeldOutQualificationResult

beforeAll(async () => {
  sharedBaselineRoot = await mkdtemp(
    join(tmpdir(), 'praxis-qualification-shared-baseline-'),
  )
  sharedBaselineOutput = join(sharedBaselineRoot, 'result')
  const execution = await executeQualification({
    output: sharedBaselineOutput,
    harness: factoryHarness({ solve: true }),
    build: baselineBuild,
    version: 'baseline-version',
  })
  if (execution.code !== 0 || !execution.result)
    throw new Error('Failed to prepare shared qualification baseline')
  sharedBaselineResult = execution.result
}, 30_000)

afterAll(async () => {
  if (sharedBaselineRoot)
    await rm(sharedBaselineRoot, { recursive: true, force: true })
})

describe.sequential('held-out qualification command', () => {
  it('parses the explicit pin and rejects duplicate or malformed options', () => {
    const parsed = parseHeldOutQualificationOptions(
      qualificationArgs('/tmp/qualification'),
    )
    expect(parsed).toMatchObject({
      provider: 'fixture-provider',
      profile: 'fixture-profile',
      model: 'fixture/model:qualified@v1',
      runVerification: true,
    })
    expect(() =>
      parseHeldOutQualificationOptions([
        ...qualificationArgs('/tmp/qualification').slice(0, 2),
        '--provider',
        'other',
        ...qualificationArgs('/tmp/qualification').slice(2),
      ]),
    ).toThrow('only once')
    expect(() =>
      parseHeldOutQualificationOptions([
        ...qualificationArgs('/tmp/qualification'),
        'extra',
      ]),
    ).toThrow('requires one corpus')
  })

  it('help is side-effect free and preflight reports the pin before runtime creation', async () => {
    const literalTmpRoot = await mkdtemp('/tmp/praxis-qualification-help-')
    roots.push(literalTmpRoot)
    const output = join(literalTmpRoot, 'candidate')
    let buildLoads = 0
    let reportObserved = false
    const stderr: string[] = []
    const controller = new AbortController()
    const harness = factoryHarness({
      onCreate: () => {
        reportObserved = stderr.some((value) => value.includes('runs=36'))
        controller.abort('stop after preflight report')
      },
    })
    const configRoot = await newPath(
      'praxis-qualification-help-config-',
      'config',
    )
    const help: string[] = []
    await expect(
      executeHeldOutQualificationCommand(
        ['--help'],
        { stdout: (value) => help.push(value), stderr: () => undefined },
        {
          runtimeFactory: harness.factory,
          loadBuildIdentity: async () => {
            buildLoads += 1
            return baselineBuild
          },
          configRoot,
        },
      ),
    ).resolves.toBe(0)
    expect(help.join('')).toContain('praxis eval qualify')
    expect({ buildLoads, ...harness.counts }).toEqual({
      buildLoads: 0,
      identify: 0,
      create: 0,
      run: 0,
    })

    await expect(
      executeHeldOutQualificationCommand(
        qualificationArgs(output),
        { stdout: () => undefined, stderr: (value) => stderr.push(value) },
        {
          runtimeFactory: harness.factory,
          loadBuildIdentity: async () => {
            buildLoads += 1
            return baselineBuild
          },
          version: 'baseline-version',
          configRoot,
        },
        process.cwd(),
        controller.signal,
      ),
    ).resolves.toBe(130)
    expect({ buildLoads, ...harness.counts, reportObserved }).toEqual({
      buildLoads: 1,
      identify: 13,
      create: 1,
      run: 1,
      reportObserved: true,
    })
    expect(stderr.join('')).not.toContain('https://fixture.invalid')
  }, 30_000)

  it('rejects confirmation, grants, identity, and occupied output before runtime creation', async () => {
    const cases: Array<{
      name: string
      argv: (output: string) => string[]
      harness: FactoryHarness
      message: string
      prepare?: (output: string) => Promise<void>
    }> = [
      {
        name: 'confirmation',
        argv: (output) =>
          qualificationArgs(output, {
            confirm: `praxis-held-out-v1@sha256:${'0'.repeat(64)}`,
          }),
        harness: factoryHarness(),
        message: 'does not match',
      },
      {
        name: 'grants',
        argv: (output) => qualificationArgs(output, { allowTools: 'Read' }),
        harness: factoryHarness(),
        message: 'grant it with --allow-tools',
      },
      {
        name: 'identity',
        argv: (output) => qualificationArgs(output),
        harness: (() => {
          const harness = factoryHarness()
          harness.factory.identify = async () => ({
            providerId: 'other-provider',
            profileId: 'fixture-profile',
            protocol: 'fixture',
            endpoint: 'https://fixture.invalid/v1',
            modelId: 'fixture/model:qualified@v1',
          })
          return harness
        })(),
        message: 'does not match requested pin',
      },
      {
        name: 'occupied-output',
        argv: (output) => qualificationArgs(output),
        harness: factoryHarness(),
        message: 'must not already exist',
        prepare: async (output) => {
          await writeFile(output, 'occupied')
        },
      },
    ]
    for (const item of cases) {
      const output = await newPath(`praxis-qualification-${item.name}-`, 'out')
      await item.prepare?.(output)
      await expect(
        executeQualification({
          output,
          harness: item.harness,
          argv: item.argv(output),
        }),
      ).rejects.toThrow(item.message)
      expect(item.harness.counts.create).toBe(0)
    }
  }, 30_000)

  it('runs all twelve held-out cases three times through Project Eval without provider execution', async () => {
    expect(sharedBaselineResult).toMatchObject({
      completed_run_count: 36,
      passed: 36,
      qualified: null,
      optimization_claim_allowed: false,
      usage_totals: null,
      known_cost_total_usd: null,
    })
    expect(sharedBaselineResult.cases).toHaveLength(12)
    expect(sharedBaselineResult.runs).toHaveLength(36)
    expect(sharedBaselineResult.aggregates.map(({ path }) => path)).toEqual([
      'repositories/config-kit/aggregate-result.json',
      'repositories/string-kit/aggregate-result.json',
      'repositories/task-store/aggregate-result.json',
    ])
  }, 30_000)

  it('qualifies comparable cross-build evidence, detects regressions, and blocks unknown optimization claims', async () => {
    expect(sharedBaselineResult).toMatchObject({
      passed: 36,
      failed: 0,
      median_turns: 2,
      p95_turns: 3,
      qualified: null,
      optimization_claim_allowed: false,
    })
    const durations = sharedBaselineResult.runs.map((run) => run.duration_ms)
    expect(sharedBaselineResult.median_duration_ms).toBe(median(durations))
    expect(sharedBaselineResult.p95_duration_ms).toBe(percentile95(durations))
    const baselinePath = join(sharedBaselineOutput, 'qualification-result.json')

    const candidateOutput = await newPath(
      'praxis-qualification-candidate-',
      'result',
    )
    const candidate = await executeQualification({
      output: candidateOutput,
      harness: factoryHarness({ solve: true }),
      baseline: baselinePath,
      build: candidateBuild,
      version: 'candidate-version',
    })
    expect(candidate.code).toBe(0)
    expect(candidate.result).toMatchObject({
      passed: 36,
      qualified: true,
      optimization_claim_allowed: false,
      usage_totals: null,
      known_cost_total_usd: null,
      regressions: [],
    })
    expect(candidate.result?.plan_sha256).not.toBe(
      sharedBaselineResult.plan_sha256,
    )

    const regressionOutput = await newPath(
      'praxis-qualification-regression-',
      'result',
    )
    const regression = await executeQualification({
      output: regressionOutput,
      harness: factoryHarness({
        solve: true,
        failPrompt: 'add renderConfig',
      }),
      baseline: baselinePath,
      build: candidateBuild,
      version: 'candidate-version',
    })
    expect(regression.code).toBe(1)
    expect(regression.result).toMatchObject({
      passed: 33,
      failed: 3,
      qualified: false,
      optimization_claim_allowed: false,
    })
    expect(regression.result?.regressions).toHaveLength(3)

    const incompatibleHarness = factoryHarness({
      endpoint: 'https://other.invalid/v1',
    })
    const incompatibleOutput = await newPath(
      'praxis-qualification-incompatible-',
      'result',
    )
    await expect(
      executeQualification({
        output: incompatibleOutput,
        harness: incompatibleHarness,
        baseline: baselinePath,
        build: candidateBuild,
        version: 'candidate-version',
      }),
    ).rejects.toThrow('non-comparable identity')
    expect(incompatibleHarness.counts.create).toBe(0)
  }, 60_000)

  it('rejects incomplete or unsafe qualification evidence before comparison', async () => {
    const tamperRoot = await copyQualification(
      sharedBaselineOutput,
      'invalid-evidence',
    )
    const aggregatePath = join(
      tamperRoot,
      'repositories/config-kit/aggregate-result.json',
    )
    const resultPath = join(tamperRoot, 'qualification-result.json')
    const originalAggregateSource = await readFile(aggregatePath, 'utf8')
    const originalResultSource = await readFile(resultPath, 'utf8')
    const configRoot = await newPath(
      'praxis-qualification-invalid-config-',
      'config',
    )
    const rejectedOutputRoot = await mkdtemp(
      join(tmpdir(), 'praxis-qualification-rejected-'),
    )
    roots.push(rejectedOutputRoot)
    const rejectedOutput = (name: string): string =>
      join(rejectedOutputRoot, name)

    const aggregate = JSON.parse(originalAggregateSource) as {
      duration_ms: number
    }
    aggregate.duration_ms += 1
    await writeFile(aggregatePath, JSON.stringify(aggregate))
    await expect(
      executeQualification({
        output: rejectedOutput('aggregate-tamper'),
        harness: factoryHarness(),
        baseline: resultPath,
        configRoot,
      }),
    ).rejects.toThrow('aggregate hash mismatch')
    await writeFile(aggregatePath, originalAggregateSource)

    const summary = JSON.parse(
      originalResultSource,
    ) as HeldOutQualificationResult
    ;(summary as { median_turns: number }).median_turns += 1
    await writeFile(resultPath, JSON.stringify(summary))
    await expect(
      executeQualification({
        output: rejectedOutput('summary-tamper'),
        harness: factoryHarness(),
        baseline: resultPath,
        configRoot,
      }),
    ).rejects.toThrow('statistics diverge')
    await writeFile(resultPath, originalResultSource)

    const incompleteResult = JSON.parse(
      originalResultSource,
    ) as HeldOutQualificationResult
    ;(
      incompleteResult.runs as HeldOutQualificationResult['runs'][number][]
    ).pop()
    await writeFile(resultPath, JSON.stringify(incompleteResult))
    await expect(
      executeQualification({
        output: rejectedOutput('incomplete'),
        harness: factoryHarness(),
        baseline: resultPath,
        configRoot,
      }),
    ).rejects.toThrow('completed run count')
    await writeFile(resultPath, originalResultSource)

    const escapedAggregate = JSON.parse(originalAggregateSource) as {
      runs: Array<{ artifact_dir: string }>
    }
    ;(escapedAggregate.runs[0] as { artifact_dir: string }).artifact_dir =
      '../outside'
    const escapedAggregateSource = JSON.stringify(escapedAggregate)
    await writeFile(aggregatePath, escapedAggregateSource)
    const escapedResult = JSON.parse(
      originalResultSource,
    ) as HeldOutQualificationResult
    ;(
      escapedResult.aggregates as Array<
        HeldOutQualificationResult['aggregates'][number]
      >
    )[0] = {
      ...(escapedResult
        .aggregates[0] as HeldOutQualificationResult['aggregates'][number]),
      sha256: sha256(escapedAggregateSource),
    }
    await writeFile(resultPath, JSON.stringify(escapedResult))
    await expect(
      executeQualification({
        output: rejectedOutput('escaped-artifact'),
        harness: factoryHarness(),
        baseline: resultPath,
        configRoot,
      }),
    ).rejects.toThrow('artifact directory is invalid')
    await writeFile(aggregatePath, originalAggregateSource)
    await writeFile(resultPath, originalResultSource)

    const missingArtifactPath = join(
      tamperRoot,
      'repositories/config-kit/config-kit.fix-env-precedence/run-1/trace.jsonl',
    )
    const missingArtifactSource = await readFile(missingArtifactPath)
    await rm(missingArtifactPath)
    await expect(
      executeQualification({
        output: rejectedOutput('missing-artifact'),
        harness: factoryHarness(),
        baseline: resultPath,
        configRoot,
      }),
    ).rejects.toThrow('artifact is missing or unsafe')
    await writeFile(missingArtifactPath, missingArtifactSource)

    const mixedAggregate = JSON.parse(originalAggregateSource) as {
      identity_sha256: `sha256:${string}`
      runs: Array<HeldOutQualificationResult['runs'][number]>
    }
    const mixedRun = mixedAggregate
      .runs[1] as HeldOutQualificationResult['runs'][number]
    const otherCaseRun = mixedAggregate.runs.find(
      (run) => run.case !== mixedRun.case,
    ) as HeldOutQualificationResult['runs'][number]
    mixedRun.identity = otherCaseRun.identity
    mixedAggregate.identity_sha256 = computeProjectEvalAggregateIdentity(
      mixedAggregate.runs.map((run) => ({
        case: run.case,
        run: run.run,
        identity_sha256: run.identity.identity_sha256,
      })),
    )
    const mixedAggregateSource = JSON.stringify(mixedAggregate)
    await writeFile(aggregatePath, mixedAggregateSource)
    const mixedResult = JSON.parse(
      originalResultSource,
    ) as HeldOutQualificationResult
    const mixedReference = (
      mixedResult.aggregates as Array<
        HeldOutQualificationResult['aggregates'][number]
      >
    )[0] as HeldOutQualificationResult['aggregates'][number]
    ;(
      mixedResult.aggregates as Array<
        HeldOutQualificationResult['aggregates'][number]
      >
    )[0] = {
      ...mixedReference,
      sha256: sha256(mixedAggregateSource),
      identity_sha256: mixedAggregate.identity_sha256,
    }
    const qualificationRun = mixedResult.runs.find(
      (run) =>
        run.repository === 'config-kit' &&
        run.case === mixedRun.case &&
        run.run === mixedRun.run,
    ) as HeldOutQualificationResult['runs'][number]
    qualificationRun.identity = mixedRun.identity
    await writeFile(resultPath, JSON.stringify(mixedResult))
    await expect(
      executeQualification({
        output: rejectedOutput('mixed-identity'),
        harness: factoryHarness(),
        baseline: resultPath,
        configRoot,
      }),
    ).rejects.toThrow('mixed identities')
  }, 60_000)

  it('returns 130 and omits the final result when execution is cancelled', async () => {
    const output = await newPath('praxis-qualification-cancel-', 'result')
    const controller = new AbortController()
    const harness = factoryHarness({
      solve: true,
      abortController: controller,
      abortOnRun: 1,
    })
    const execution = await executeQualification({
      output,
      harness,
      signal: controller.signal,
    })
    expect(execution.code).toBe(130)
    expect(execution.result).toBeUndefined()
    await expect(
      access(join(output, 'qualification-result.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(harness.counts.run).toBe(1)
  }, 30_000)
})
