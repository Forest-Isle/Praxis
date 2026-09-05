import { mkdir, lstat, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  assertProjectEvalIdentitiesComparable,
  validateProjectEvalAggregateIdentity,
  validateProjectEvalIdentity,
} from './project-eval-identity.js'
import type {
  ProjectEvalAggregate,
  ProjectEvalRunSummary,
} from './project-eval.js'

const MAX_AGGREGATE_BYTES = 8 * 1024 * 1024
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export const PROJECT_EVAL_COMPARE_HELP = `Usage: praxis eval compare [options]

Compare two completed project evaluation aggregate artifacts.

Options:
  --baseline <aggregate-result.json>   Baseline aggregate artifact
  --baseline-name <name>               Name shown for the baseline
  --candidate <aggregate-result.json>  Candidate aggregate artifact
  --candidate-name <name>              Name shown for the candidate
  --output-dir <dir>                   Write comparison-result.json here
  --json                               Print exactly one comparison JSON value
  -h, --help                           Display help`

export interface ProjectEvalCompareOptions {
  baseline?: string
  baselineName?: string
  candidate?: string
  candidateName?: string
  outputDir?: string
  json: boolean
  help?: true
}

interface LoadedAggregate {
  aggregate: ProjectEvalAggregate
  sourcePath: string
  safetyKnown: boolean
}

export interface ProjectEvalComparisonMetric<T = number | null> {
  baseline: T
  candidate: T
  delta: T
}

export interface ProjectEvalComparisonResult {
  schema_version: '1.1'
  baseline: {
    name: string
    source_path: string
    version: string
    model: string | null
    identity_sha256: `sha256:${string}`
  }
  candidate: {
    name: string
    source_path: string
    version: string
    model: string | null
    identity_sha256: `sha256:${string}`
  }
  comparable_run_count: number
  passed: boolean
  regressions: readonly {
    case: string
    run: number
    baseline_passed: boolean
    candidate_passed: boolean
  }[]
  metrics: {
    pass_rate: ProjectEvalComparisonMetric<number>
    safety_pass_rate: ProjectEvalComparisonMetric<number | null>
    average_turns: ProjectEvalComparisonMetric<number>
    input_tokens: ProjectEvalComparisonMetric<number | null>
    output_tokens: ProjectEvalComparisonMetric<number | null>
    cache_read_input_tokens: ProjectEvalComparisonMetric<number | null>
    cache_creation_input_tokens: ProjectEvalComparisonMetric<number | null>
    known_cost_total_usd: ProjectEvalComparisonMetric<number | null>
    average_duration_ms: ProjectEvalComparisonMetric<number>
    permission_decisions: {
      allow: ProjectEvalComparisonMetric<number | null>
      ask: ProjectEvalComparisonMetric<number | null>
      deny: ProjectEvalComparisonMetric<number | null>
    }
    tool_errors: ProjectEvalComparisonMetric<number | null>
    retries: ProjectEvalComparisonMetric<number | null>
    terminations: {
      completed: ProjectEvalComparisonMetric<number>
      timeout: ProjectEvalComparisonMetric<number>
      interrupted: ProjectEvalComparisonMetric<number>
    }
  }
}

function valueAt(
  argv: readonly string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('-'))
    throw new Error(`${option} requires a value`)
  return value
}

export function parseProjectEvalCompareOptions(
  argv: readonly string[],
): ProjectEvalCompareOptions {
  const options: ProjectEvalCompareOptions = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (!value) continue
    if (value === '-h' || value === '--help') return { ...options, help: true }
    if (value === '--json') options.json = true
    else if (
      value === '--baseline' ||
      value === '--baseline-name' ||
      value === '--candidate' ||
      value === '--candidate-name' ||
      value === '--output-dir'
    ) {
      const selected = valueAt(argv, index, value)
      index += 1
      if (value === '--baseline') options.baseline = selected
      else if (value === '--baseline-name') options.baselineName = selected
      else if (value === '--candidate') options.candidate = selected
      else if (value === '--candidate-name') options.candidateName = selected
      else options.outputDir = selected
    } else if (value.startsWith('-')) {
      throw new Error(`Unknown eval compare option: ${value}`)
    } else {
      throw new Error('eval compare accepts no positional operands')
    }
  }
  if (options.help) return options
  for (const [option, selected] of [
    ['--baseline', options.baseline],
    ['--baseline-name', options.baselineName],
    ['--candidate', options.candidate],
    ['--candidate-name', options.candidateName],
  ] as const) {
    if (!selected) throw new Error(`${option} is required`)
  }
  if (!IDENTIFIER.test(options.baselineName ?? ''))
    throw new Error('--baseline-name is not a safe eval identifier')
  if (!IDENTIFIER.test(options.candidateName ?? ''))
    throw new Error('--candidate-name is not a safe eval identifier')
  return options
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid aggregate ${path}: ${message}`)
}

function stringField(
  value: unknown,
  path: string,
  nullable = false,
): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096)
    fail(path, 'expected a bounded non-empty string')
  return value
}

function boolField(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean')
  return value
}

function numberField(value: unknown, path: string, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    fail(path, 'expected a finite nonnegative number')
  return value
}

function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null
  return numberField(value, path)
}

function objectField(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail(path, 'expected an object')
  return value as Record<string, unknown>
}

function optionalGroup(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): boolean {
  const present = keys.filter((key) => value[key] !== undefined)
  if (present.length !== 0 && present.length !== keys.length)
    fail(path, `fields must be all present or all absent: ${keys.join(', ')}`)
  return present.length === keys.length
}

function usageField(
  value: unknown,
  path: string,
): ProjectEvalRunSummary['usage'] {
  if (value === null) return null
  const usage = objectField(value, path)
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'webSearchRequests',
  ]) {
    if (usage[key] !== undefined)
      numberField(usage[key], `${path}.${key}`, true)
  }
  if (usage.inputTokens === undefined || usage.outputTokens === undefined)
    fail(path, 'inputTokens and outputTokens are required')
  return usage as unknown as ProjectEvalRunSummary['usage']
}

function validateRun(value: unknown, index: number): ProjectEvalRunSummary {
  const path = `runs[${index}]`
  const run = objectField(value, path)
  stringField(run.case, `${path}.case`)
  if (!IDENTIFIER.test(run.case as string))
    fail(`${path}.case`, 'unsafe case name')
  const runNumber = numberField(run.run, `${path}.run`, true)
  if (runNumber < 1) fail(`${path}.run`, 'must be positive')
  const model = stringField(run.model, `${path}.model`)
  const identity = validateProjectEvalIdentity(run.identity)
  if (model !== identity.model_id)
    fail(`${path}.model`, 'does not match identity.model_id')
  boolField(run.passed, `${path}.passed`)
  if (run.score !== 0 && run.score !== 1)
    fail(`${path}.score`, 'must be 0 or 1')
  if (run.score !== (run.passed ? 1 : 0))
    fail(`${path}.score`, 'does not match passed')
  numberField(run.turns, `${path}.turns`, true)
  usageField(run.usage, `${path}.usage`)
  nullableNumber(run.cost_usd, `${path}.cost_usd`)
  boolField(run.cost_known, `${path}.cost_known`)
  if (run.cost_known !== (run.cost_usd !== null))
    fail(`${path}.cost_known`, 'does not match cost_usd')
  numberField(run.duration_ms, `${path}.duration_ms`)
  if (
    run.termination !== null &&
    run.termination !== 'timeout' &&
    run.termination !== 'interrupted'
  )
    fail(`${path}.termination`, 'invalid termination')
  stringField(run.error, `${path}.error`, true)
  stringField(run.artifact_dir, `${path}.artifact_dir`)
  const evidenceKnown = optionalGroup(
    run,
    ['safety_passed', 'permission_decisions', 'tool_errors', 'retries'],
    path,
  )
  if (evidenceKnown) {
    boolField(run.safety_passed, `${path}.safety_passed`)
    const permissions = objectField(
      run.permission_decisions,
      `${path}.permission_decisions`,
    )
    for (const key of ['allow', 'ask', 'deny'])
      numberField(permissions[key], `${path}.permission_decisions.${key}`, true)
    numberField(run.tool_errors, `${path}.tool_errors`, true)
    numberField(run.retries, `${path}.retries`, true)
  }
  return { ...run, model, identity } as unknown as ProjectEvalRunSummary
}

export async function loadProjectEvalAggregate(
  inputPath: string,
  callerCwd = process.cwd(),
): Promise<LoadedAggregate> {
  const sourcePath = resolve(callerCwd, inputPath)
  const info = await lstat(sourcePath)
  if (info.isSymbolicLink())
    throw new Error(`Aggregate path contains symlink: ${sourcePath}`)
  if (!info.isFile())
    throw new Error(`Aggregate path is not a regular file: ${sourcePath}`)
  if (info.size > MAX_AGGREGATE_BYTES)
    throw new Error(`Aggregate exceeds 8 MiB: ${sourcePath}`)
  const content = await readFile(sourcePath)
  if (content.byteLength > MAX_AGGREGATE_BYTES)
    throw new Error(`Aggregate exceeds 8 MiB: ${sourcePath}`)
  let value: unknown
  try {
    value = JSON.parse(content.toString('utf8'))
  } catch {
    throw new Error(`Invalid aggregate JSON: ${sourcePath}`)
  }
  const aggregate = objectField(value, 'root')
  const data = aggregate as unknown as ProjectEvalAggregate
  if (aggregate.schema_version !== '1.1')
    fail(
      'schema_version',
      'must be "1.1"; legacy "1.0" aggregates are unsupported',
    )
  stringField(aggregate.version, 'version')
  stringField(aggregate.start, 'start')
  numberField(aggregate.duration_ms, 'duration_ms')
  stringField(aggregate.target, 'target')
  stringField(aggregate.output_dir, 'output_dir')
  stringField(aggregate.model, 'model', true)
  for (const key of [
    'case_count',
    'planned_run_count',
    'completed_run_count',
    'run_count',
    'passed',
    'failed',
    'total_turns',
    'usage_known_runs',
    'usage_unknown_runs',
    'known_cost_runs',
    'unknown_cost_runs',
  ])
    numberField(aggregate[key], key, true)
  numberField(aggregate.pass_rate, 'pass_rate')
  if (data.pass_rate > 1) fail('pass_rate', 'must be within [0,1]')
  boolField(aggregate.partial, 'partial')
  boolField(aggregate.interrupted, 'interrupted')
  const usageTotals = objectField(aggregate.usage_totals, 'usage_totals')
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'web_search_requests',
  ])
    numberField(usageTotals[key], `usage_totals.${key}`, true)
  nullableNumber(aggregate.known_cost_total_usd, 'known_cost_total_usd')
  if (!Array.isArray(aggregate.runs) || aggregate.runs.length > 100000)
    fail('runs', 'expected a bounded array')
  const runs = aggregate.runs.map(validateRun)
  for (const [index, run] of runs.entries())
    if (run.identity.runtime.praxis_version !== aggregate.version)
      fail(
        `runs[${index}].identity.runtime.praxis_version`,
        'must match aggregate version',
      )
  const expectedAggregateModel =
    runs.length > 0 && runs.every((run) => run.model === runs[0]?.model)
      ? (runs[0]?.model ?? null)
      : null
  if (aggregate.model !== expectedAggregateModel)
    fail('model', 'does not match completed run identity models')
  if (data.run_count !== runs.length)
    fail('run_count', 'does not match runs length')
  if (
    data.completed_run_count > data.planned_run_count ||
    data.completed_run_count !== data.run_count
  )
    fail('completed_run_count', 'inconsistent with planned/run counts')
  if (data.case_count > data.planned_run_count)
    fail('case_count', 'cannot exceed planned_run_count')
  if (data.passed + data.failed !== data.run_count)
    fail('passed', 'passed + failed must equal run_count')
  if (data.passed !== runs.filter((run) => run.passed).length)
    fail('passed', 'does not match run outcomes')
  if (
    data.pass_rate !== (data.run_count === 0 ? 0 : data.passed / data.run_count)
  )
    fail('pass_rate', 'inconsistent with passed/run_count')
  if (data.usage_known_runs + data.usage_unknown_runs !== data.run_count)
    fail('usage_known_runs', 'usage totals are inconsistent')
  if (data.known_cost_runs + data.unknown_cost_runs !== data.run_count)
    fail('known_cost_runs', 'cost totals are inconsistent')
  if (data.known_cost_total_usd === null && data.known_cost_runs !== 0)
    fail('known_cost_total_usd', 'must be present when cost is known')
  if (data.known_cost_total_usd !== null && data.known_cost_runs === 0)
    fail('known_cost_total_usd', 'must be null when no cost is known')
  if (data.usage_known_runs !== runs.filter((run) => run.usage !== null).length)
    fail('usage_known_runs', 'does not match run usage')
  if (
    data.usage_unknown_runs !== runs.filter((run) => run.usage === null).length
  )
    fail('usage_unknown_runs', 'does not match run usage')
  if (data.known_cost_runs !== runs.filter((run) => run.cost_known).length)
    fail('known_cost_runs', 'does not match run costs')
  if (data.unknown_cost_runs !== runs.filter((run) => !run.cost_known).length)
    fail('unknown_cost_runs', 'does not match run costs')
  if (data.known_cost_total_usd !== null) {
    const cost = runs.reduce((total, run) => total + (run.cost_usd ?? 0), 0)
    if (Math.abs(cost - data.known_cost_total_usd) > 1e-9)
      fail('known_cost_total_usd', 'does not match run costs')
  }
  if (data.total_turns !== runs.reduce((total, run) => total + run.turns, 0))
    fail('total_turns', 'does not match run turns')
  const expectedUsage = {
    input_tokens: runs.reduce(
      (total, run) => total + (run.usage?.inputTokens ?? 0),
      0,
    ),
    output_tokens: runs.reduce(
      (total, run) => total + (run.usage?.outputTokens ?? 0),
      0,
    ),
    cache_read_input_tokens: runs.reduce(
      (total, run) => total + (run.usage?.cacheReadInputTokens ?? 0),
      0,
    ),
    cache_creation_input_tokens: runs.reduce(
      (total, run) => total + (run.usage?.cacheCreationInputTokens ?? 0),
      0,
    ),
    web_search_requests: runs.reduce(
      (total, run) => total + (run.usage?.webSearchRequests ?? 0),
      0,
    ),
  }
  for (const key of Object.keys(
    expectedUsage,
  ) as (keyof typeof expectedUsage)[])
    if (usageTotals[key] !== expectedUsage[key])
      fail(`usage_totals.${key}`, 'does not match run usage')
  const keys = new Set<string>()
  const caseNames = new Set<string>()
  for (const run of runs) {
    const key = `${run.case}\u0000${run.run}`
    if (keys.has(key)) fail('runs', 'duplicate (case,run) key')
    keys.add(key)
    caseNames.add(run.case)
  }
  validateProjectEvalAggregateIdentity(
    aggregate.identity_sha256,
    runs.map((run) => ({
      case: run.case,
      run: run.run,
      identity_sha256: run.identity.identity_sha256,
    })),
  )
  if (!data.partial && caseNames.size !== data.case_count)
    fail('case_count', 'does not match completed run cases')
  if (data.interrupted && !data.partial)
    fail('interrupted', 'interrupted aggregate must be partial')
  if (!data.partial && data.run_count !== data.planned_run_count)
    fail('partial', 'complete aggregate is missing planned runs')
  if (
    data.partial !==
    (data.interrupted || data.run_count < data.planned_run_count)
  )
    fail('partial', 'does not match interrupted/completed run state')

  const aggregateEvidenceKnown = optionalGroup(
    aggregate,
    [
      'safety_passed',
      'safety_failed',
      'permission_decisions',
      'tool_errors',
      'retries',
      'terminations',
    ],
    'root evidence',
  )
  const runEvidenceKnown = runs.every(
    (run) =>
      typeof run.safety_passed === 'boolean' &&
      typeof run.tool_errors === 'number' &&
      typeof run.retries === 'number' &&
      run.permission_decisions !== undefined,
  )
  const runEvidenceAbsent = runs.every(
    (run) =>
      run.safety_passed === undefined &&
      run.tool_errors === undefined &&
      run.retries === undefined &&
      run.permission_decisions === undefined,
  )
  if (
    (aggregateEvidenceKnown && !runEvidenceKnown) ||
    (!aggregateEvidenceKnown && !runEvidenceAbsent)
  )
    fail('runs', 'run evidence must match aggregate evidence availability')
  const safetyKnown = aggregateEvidenceKnown && runEvidenceKnown
  if (aggregateEvidenceKnown) {
    numberField(aggregate.safety_passed, 'safety_passed', true)
    numberField(aggregate.safety_failed, 'safety_failed', true)
    const permissions = objectField(
      aggregate.permission_decisions,
      'permission_decisions',
    )
    for (const key of ['allow', 'ask', 'deny'])
      numberField(permissions[key], `permission_decisions.${key}`, true)
    numberField(aggregate.tool_errors, 'tool_errors', true)
    numberField(aggregate.retries, 'retries', true)
    if (
      aggregate.safety_passed !==
        runs.filter((run) => run.safety_passed).length ||
      aggregate.safety_failed !==
        runs.filter((run) => !run.safety_passed).length
    )
      fail('safety_passed', 'does not match run safety evidence')
    const expectedPermissions = {
      allow: runs.reduce(
        (total, run) => total + run.permission_decisions.allow,
        0,
      ),
      ask: runs.reduce((total, run) => total + run.permission_decisions.ask, 0),
      deny: runs.reduce(
        (total, run) => total + run.permission_decisions.deny,
        0,
      ),
    }
    if (
      permissions.allow !== expectedPermissions.allow ||
      permissions.ask !== expectedPermissions.ask ||
      permissions.deny !== expectedPermissions.deny
    )
      fail('permission_decisions', 'does not match run evidence')
    if (
      aggregate.tool_errors !==
        runs.reduce((total, run) => total + run.tool_errors, 0) ||
      aggregate.retries !== runs.reduce((total, run) => total + run.retries, 0)
    )
      fail('tool_errors', 'does not match run evidence')
    const terminations = objectField(aggregate.terminations, 'terminations')
    for (const key of ['completed', 'timeout', 'interrupted'])
      numberField(terminations[key], `terminations.${key}`, true)
    const expectedTerminations = {
      completed: runs.filter((run) => run.termination === null).length,
      timeout: runs.filter((run) => run.termination === 'timeout').length,
      interrupted: runs.filter((run) => run.termination === 'interrupted')
        .length,
    }
    for (const key of Object.keys(
      expectedTerminations,
    ) as (keyof typeof expectedTerminations)[])
      if (terminations[key] !== expectedTerminations[key])
        fail(`terminations.${key}`, 'does not match runs')
  }
  return {
    aggregate: { ...aggregate, runs } as unknown as ProjectEvalAggregate,
    sourcePath,
    safetyKnown,
  }
}

function metric(
  baseline: number,
  candidate: number,
): ProjectEvalComparisonMetric<number> {
  return { baseline, candidate, delta: candidate - baseline }
}
function nullableMetric(
  baseline: number | null,
  candidate: number | null,
): ProjectEvalComparisonMetric<number | null> {
  return baseline === null || candidate === null
    ? { baseline, candidate, delta: null }
    : { baseline, candidate, delta: candidate - baseline }
}
function avg(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((a, b) => a + b, 0) / values.length
}

function compareRunIdentity(
  left: ProjectEvalRunSummary,
  right: ProjectEvalRunSummary,
): number {
  const leftKey = `${left.case}\u0000${left.run}`
  const rightKey = `${right.case}\u0000${right.run}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

export function compareProjectEvalAggregates(
  baseline: LoadedAggregate,
  candidate: LoadedAggregate,
  baselineName: string,
  candidateName: string,
): ProjectEvalComparisonResult {
  const left = baseline.aggregate
  const right = candidate.aggregate
  if (left.partial || left.interrupted || right.partial || right.interrupted)
    throw new Error('Comparison requires complete, uninterrupted aggregates')
  if (
    left.completed_run_count !== left.planned_run_count ||
    right.completed_run_count !== right.planned_run_count
  )
    throw new Error('Comparison requires every planned run to be completed')
  const leftRuns = [...left.runs].sort(compareRunIdentity)
  const rightRuns = [...right.runs].sort(compareRunIdentity)
  if (
    leftRuns.length !== rightRuns.length ||
    leftRuns.some(
      (run, index) =>
        run.case !== rightRuns[index]?.case ||
        run.run !== rightRuns[index]?.run,
    )
  )
    throw new Error('Aggregates have different comparable run sets')
  if (leftRuns.length === 0)
    throw new Error('Comparison requires at least one completed run')
  for (let index = 0; index < leftRuns.length; index += 1) {
    const leftRun = leftRuns[index]
    const rightRun = rightRuns[index]
    if (!leftRun || !rightRun) continue
    assertProjectEvalIdentitiesComparable(
      leftRun.identity,
      rightRun.identity,
      `Identity mismatch for (${leftRun.case}, ${leftRun.run})`,
    )
  }
  const regressions = rightRuns.flatMap((run, index) =>
    leftRuns[index]?.passed && !run.passed
      ? [
          {
            case: run.case,
            run: run.run,
            baseline_passed: true,
            candidate_passed: false,
          },
        ]
      : [],
  )
  const safetyKnown = baseline.safetyKnown && candidate.safetyKnown
  const leftSafety = safetyKnown
    ? leftRuns.filter((run) => run.safety_passed).length / leftRuns.length
    : null
  const rightSafety = safetyKnown
    ? rightRuns.filter((run) => run.safety_passed).length / rightRuns.length
    : null
  const terms = (
    runs: readonly ProjectEvalRunSummary[],
    kind: 'completed' | 'timeout' | 'interrupted',
  ) =>
    runs.filter((run) =>
      kind === 'completed'
        ? run.termination === null
        : run.termination === kind,
    ).length
  const token = (field: keyof ProjectEvalAggregate['usage_totals']) =>
    nullableMetric(
      left.usage_unknown_runs === 0 ? left.usage_totals[field] : null,
      right.usage_unknown_runs === 0 ? right.usage_totals[field] : null,
    )
  const permission = (name: 'allow' | 'ask' | 'deny') =>
    safetyKnown
      ? metric(
          leftRuns.reduce((n, r) => n + r.permission_decisions[name], 0),
          rightRuns.reduce((n, r) => n + r.permission_decisions[name], 0),
        )
      : nullableMetric(null, null)
  const result: ProjectEvalComparisonResult = {
    schema_version: '1.1',
    baseline: {
      name: baselineName,
      source_path: baseline.sourcePath,
      version: left.version,
      model: left.model,
      identity_sha256: left.identity_sha256,
    },
    candidate: {
      name: candidateName,
      source_path: candidate.sourcePath,
      version: right.version,
      model: right.model,
      identity_sha256: right.identity_sha256,
    },
    comparable_run_count: leftRuns.length,
    passed:
      regressions.length === 0 &&
      right.pass_rate >= left.pass_rate &&
      safetyKnown &&
      (rightSafety ?? 0) >= (leftSafety ?? 0),
    regressions,
    metrics: {
      pass_rate: metric(left.pass_rate, right.pass_rate),
      safety_pass_rate: nullableMetric(leftSafety, rightSafety),
      average_turns: metric(
        avg(leftRuns.map((r) => r.turns)),
        avg(rightRuns.map((r) => r.turns)),
      ),
      input_tokens: token('input_tokens'),
      output_tokens: token('output_tokens'),
      cache_read_input_tokens: token('cache_read_input_tokens'),
      cache_creation_input_tokens: token('cache_creation_input_tokens'),
      known_cost_total_usd: nullableMetric(
        left.known_cost_total_usd,
        right.known_cost_total_usd,
      ),
      average_duration_ms: metric(
        avg(leftRuns.map((r) => r.duration_ms)),
        avg(rightRuns.map((r) => r.duration_ms)),
      ),
      permission_decisions: {
        allow: permission('allow'),
        ask: permission('ask'),
        deny: permission('deny'),
      },
      tool_errors: safetyKnown
        ? metric(
            leftRuns.reduce((n, r) => n + r.tool_errors, 0),
            rightRuns.reduce((n, r) => n + r.tool_errors, 0),
          )
        : nullableMetric(null, null),
      retries: safetyKnown
        ? metric(
            leftRuns.reduce((n, r) => n + r.retries, 0),
            rightRuns.reduce((n, r) => n + r.retries, 0),
          )
        : nullableMetric(null, null),
      terminations: {
        completed: metric(
          terms(leftRuns, 'completed'),
          terms(rightRuns, 'completed'),
        ),
        timeout: metric(
          terms(leftRuns, 'timeout'),
          terms(rightRuns, 'timeout'),
        ),
        interrupted: metric(
          terms(leftRuns, 'interrupted'),
          terms(rightRuns, 'interrupted'),
        ),
      },
    },
  }
  return result
}

export async function executeProjectEvalCompareCommand(
  argv: readonly string[],
  io: { stdout(message: string): void; stderr(message: string): void },
  callerCwd = process.cwd(),
  signal?: AbortSignal,
): Promise<number> {
  const options = parseProjectEvalCompareOptions(argv)
  if (options.help) {
    io.stdout(`${PROJECT_EVAL_COMPARE_HELP}\n`)
    return 0
  }
  if (signal?.aborted) return 130
  const baseline = await loadProjectEvalAggregate(
    options.baseline ?? '',
    callerCwd,
  )
  if (signal?.aborted) return 130
  const candidate = await loadProjectEvalAggregate(
    options.candidate ?? '',
    callerCwd,
  )
  if (signal?.aborted) return 130
  const result = compareProjectEvalAggregates(
    baseline,
    candidate,
    options.baselineName ?? '',
    options.candidateName ?? '',
  )
  if (signal?.aborted) return 130
  const outputDir = resolve(
    callerCwd,
    options.outputDir ?? dirname(candidate.sourcePath),
  )
  if (signal?.aborted) return 130
  await mkdir(outputDir, { recursive: true })
  if (signal?.aborted) return 130
  const outputPath = resolve(outputDir, 'comparison-result.json')
  try {
    const existing = await lstat(outputPath)
    if (existing.isSymbolicLink())
      throw new Error(`Comparison output path contains symlink: ${outputPath}`)
    if (!existing.isFile())
      throw new Error(
        `Comparison output path is not a regular file: ${outputPath}`,
      )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (signal?.aborted) return 130
  await writeFileAtomically(outputPath, `${JSON.stringify(result, null, 2)}\n`)
  if (options.json) io.stdout(`${JSON.stringify(result)}\n`)
  else
    io.stdout(
      `${result.passed ? 'passed' : 'failed'}: ${result.metrics.pass_rate.delta >= 0 ? '+' : ''}${result.metrics.pass_rate.delta.toFixed(3)} pass rate, ${result.metrics.safety_pass_rate.delta === null ? 'unknown' : `${result.metrics.safety_pass_rate.delta >= 0 ? '+' : ''}${result.metrics.safety_pass_rate.delta.toFixed(3)} safety rate`}\n`,
    )
  return result.passed ? 0 : 1
}
