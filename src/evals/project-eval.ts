import { join, relative, resolve } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import type { ModelUsage } from '../core/runtime.js'
import type { EvalRuntimeFactory } from './eval-contract.js'
import {
  runProjectEvalCase,
  type ProjectEvalRunResult,
} from './project-eval-runner.js'
import { discoverProjectEvalCases } from './project-eval-schema.js'

export const PROJECT_EVAL_HELP = `Usage: praxis eval [options] <target>

Run deterministic project outcome evaluations in isolated workspaces.

Options:
  --case <glob>          Filter case names
  --tag <tag[,tag]>      Filter tags; repeatable
  --runs <1..50>         Override run count
  --model <model>        Override model
  --allow-tools <rules>  Grant gated tools; comma-separated and repeatable
  --run-verification     Enable verifier subprocesses
  --output-dir <dir>     Write artifacts to this directory
  --keep-temp            Preserve temporary workspaces
  --json                 Print exactly one aggregate JSON value
  --verbose              Print run progress to stderr
  -h, --help             Display help`

export interface ProjectEvalDependencies {
  runtimeFactory: EvalRuntimeFactory
  version?: string
  configRoot: string
}

export interface ProjectEvalOptions {
  target?: string
  caseGlob?: string
  tags: string[]
  runs?: number
  model?: string
  allowTools: string[]
  runVerification: boolean
  outputDir?: string
  keepTemp: boolean
  json: boolean
  verbose: boolean
  help?: true
}

export interface ProjectEvalUsageTotals {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  web_search_requests: number
}

export interface ProjectEvalRunSummary {
  case: string
  run: number
  model: string | null
  passed: boolean
  score: 0 | 1
  turns: number
  usage: ModelUsage | null
  cost_usd: number | null
  cost_known: boolean
  duration_ms: number
  termination: ProjectEvalRunResult['termination']
  error: string | null
  artifact_dir: string
}

export interface ProjectEvalAggregate {
  schema_version: '1.0'
  version: string
  start: string
  duration_ms: number
  target: string
  output_dir: string
  model: string | null
  case_count: number
  planned_run_count: number
  completed_run_count: number
  run_count: number
  passed: number
  failed: number
  pass_rate: number
  total_turns: number
  usage_totals: ProjectEvalUsageTotals
  usage_known_runs: number
  usage_unknown_runs: number
  known_cost_total_usd: number | null
  known_cost_runs: number
  unknown_cost_runs: number
  partial: boolean
  interrupted: boolean
  runs: readonly ProjectEvalRunSummary[]
}

function takeValue(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-'))
    throw new Error(`${option} requires a value`)
  return value
}

function listValues(value: string, option: string): string[] {
  const values = value.split(',').map((item) => item.trim())
  if (values.some((item) => item.length === 0))
    throw new Error(`${option} contains an empty value`)
  return values
}

export function parseProjectEvalOptions(
  argv: readonly string[],
): ProjectEvalOptions {
  const options: ProjectEvalOptions = {
    tags: [],
    allowTools: [],
    runVerification: false,
    keepTemp: false,
    json: false,
    verbose: false,
  }
  const operands: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value) continue
    if (value === '-h' || value === '--help') return { ...options, help: true }
    if (value === '--run-verification') options.runVerification = true
    else if (value === '--keep-temp') options.keepTemp = true
    else if (value === '--json') options.json = true
    else if (value === '--verbose') options.verbose = true
    else if (
      value === '--case' ||
      value === '--model' ||
      value === '--output-dir' ||
      value === '--runs' ||
      value === '--tag' ||
      value === '--allow-tools'
    ) {
      const selected = takeValue(argv, index, value)
      index += 1
      if (value === '--case') options.caseGlob = selected
      else if (value === '--model') options.model = selected
      else if (value === '--output-dir') options.outputDir = selected
      else if (value === '--runs') {
        const runs = Number(selected)
        if (!Number.isInteger(runs) || runs < 1 || runs > 50)
          throw new Error('--runs must be an integer from 1 to 50')
        options.runs = runs
      } else if (value === '--tag')
        options.tags.push(...listValues(selected, value))
      else options.allowTools.push(...listValues(selected, value))
    } else if (value.startsWith('-'))
      throw new Error(`Unknown eval option: ${value}`)
    else operands.push(value)
  }
  if (operands.length !== 1) throw new Error('eval requires one target')
  const target = operands[0]
  if (!target) throw new Error('eval requires one target')
  options.target = target
  return options
}

function aggregateUsage(
  results: readonly ProjectEvalRunResult[],
): ProjectEvalUsageTotals {
  const totals: ProjectEvalUsageTotals = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    web_search_requests: 0,
  }
  for (const result of results) {
    if (!result.usage) continue
    totals.input_tokens += result.usage.inputTokens
    totals.output_tokens += result.usage.outputTokens
    totals.cache_read_input_tokens += result.usage.cacheReadInputTokens ?? 0
    totals.cache_creation_input_tokens +=
      result.usage.cacheCreationInputTokens ?? 0
    totals.web_search_requests += result.usage.webSearchRequests ?? 0
  }
  return totals
}

function runSummary(
  result: ProjectEvalRunResult,
  outputDirectory: string,
): ProjectEvalRunSummary {
  return {
    case: result.case,
    run: result.run,
    model: result.model,
    passed: result.passed,
    score: result.score,
    turns: result.turns,
    usage: result.usage,
    cost_usd: result.cost_usd,
    cost_known: result.cost_known,
    duration_ms: result.duration_ms,
    termination: result.termination,
    error: result.error,
    artifact_dir: relative(
      outputDirectory,
      join(outputDirectory, result.case, `run-${result.run}`),
    ).replaceAll('\\', '/'),
  }
}

export async function executeProjectEvalCommand(
  argv: readonly string[],
  io: { stdout(message: string): void; stderr(message: string): void },
  dependencies: ProjectEvalDependencies,
  callerCwd = process.cwd(),
  signal?: AbortSignal,
): Promise<number> {
  const options = parseProjectEvalOptions(argv)
  if (options.help) {
    io.stdout(PROJECT_EVAL_HELP)
    return 0
  }
  if (!options.target) throw new Error('eval requires one target')

  const target = resolve(callerCwd, options.target)
  const cases = await discoverProjectEvalCases(
    target,
    options.caseGlob,
    options.tags,
  )
  const outputDirectory = options.outputDir
    ? resolve(callerCwd, options.outputDir)
    : join(
        dependencies.configRoot,
        'evals',
        'results',
        new Date().toISOString().replaceAll(':', '-'),
      )
  const plannedRunCount = cases.reduce(
    (total, definition) => total + (options.runs ?? definition.runs),
    0,
  )
  const results: ProjectEvalRunResult[] = []
  const started = Date.now()
  let interrupted = signal?.aborted ?? false

  runs: for (const definition of cases) {
    for (
      let runIndex = 1;
      runIndex <= (options.runs ?? definition.runs);
      runIndex += 1
    ) {
      if (signal?.aborted) {
        interrupted = true
        break runs
      }
      const result = await runProjectEvalCase({
        case: definition,
        factory: dependencies.runtimeFactory,
        run: runIndex,
        allowTools: options.allowTools,
        ...(options.model === undefined ? {} : { model: options.model }),
        keepTemp: options.keepTemp,
        runVerification: options.runVerification,
        outputDir: outputDirectory,
        version: dependencies.version ?? 'unknown',
        ...(signal === undefined ? {} : { signal }),
      })
      results.push(result)
      if (options.verbose)
        io.stderr(
          `${definition.name} run ${runIndex}: ${result.passed ? 'passed' : 'failed'}\n`,
        )
      if (signal?.aborted || result.termination === 'interrupted') {
        interrupted = true
        break runs
      }
    }
  }

  const passed = results.filter((result) => result.passed).length
  const knownCostResults = results.filter((result) => result.cost_known)
  const aggregate: ProjectEvalAggregate = {
    schema_version: '1.0',
    version: dependencies.version ?? 'unknown',
    start: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    target,
    output_dir: outputDirectory,
    model: options.model ?? null,
    case_count: cases.length,
    planned_run_count: plannedRunCount,
    completed_run_count: results.length,
    run_count: results.length,
    passed,
    failed: results.length - passed,
    pass_rate: results.length === 0 ? 0 : passed / results.length,
    total_turns: results.reduce((total, result) => total + result.turns, 0),
    usage_totals: aggregateUsage(results),
    usage_known_runs: results.filter((result) => result.usage !== null).length,
    usage_unknown_runs: results.filter((result) => result.usage === null)
      .length,
    known_cost_total_usd:
      knownCostResults.length === 0
        ? null
        : knownCostResults.reduce(
            (total, result) => total + (result.cost_usd ?? 0),
            0,
          ),
    known_cost_runs: knownCostResults.length,
    unknown_cost_runs: results.length - knownCostResults.length,
    partial: interrupted || results.length < plannedRunCount,
    interrupted,
    runs: results.map((result) => runSummary(result, outputDirectory)),
  }
  await writeFileAtomically(
    join(outputDirectory, 'aggregate-result.json'),
    JSON.stringify(aggregate, null, 2),
  )
  if (options.json) io.stdout(`${JSON.stringify(aggregate)}\n`)
  else io.stdout(`${passed}/${results.length} passed\n`)
  return interrupted ? 130 : passed === results.length ? 0 : 1
}
