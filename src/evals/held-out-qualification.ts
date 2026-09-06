import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  validatePraxisBuildIdentity,
  type PraxisBuildIdentity,
} from '../platform/praxis-build-identity.js'
import { resolveEvalAllowedTools } from './eval-contract.js'
import { loadHeldOutCorpus, type HeldOutCorpus } from './held-out-corpus.js'
import {
  assertProjectEvalIdentitiesComparable,
  createProjectEvalIdentity,
  validateProjectEvalIdentity,
  type ProjectEvalIdentity,
} from './project-eval-identity.js'
import {
  loadProjectEvalAggregate,
  type ProjectEvalComparisonMetric,
} from './project-eval-comparison.js'
import type {
  ProjectEvalAggregate,
  ProjectEvalDependencies,
  ProjectEvalRunSummary,
} from './project-eval.js'
import {
  createProjectEvalWorkspace,
  cleanupProjectEvalWorkspace,
} from './project-eval-workspace.js'

/**
 * Qualification orchestration for the immutable held-out corpus.
 *
 * This module owns the qualification contract and evidence envelope; actual
 * case execution remains in the Project Eval runner.
 */

export const HELD_OUT_QUALIFICATION_HELP = `Usage: praxis eval qualify [options] <corpus>

Qualify an explicitly pinned provider/model against the immutable held-out corpus.

Options:

Required:
  --provider <id>             Provider identifier
  --profile <id>              Provider profile identifier
  --model <id>                Model identifier
  --confirm-held-out <id@sha256>  Confirm the exact held-out corpus digest
  --run-verification          Run the declared case verifiers
  --output-dir <dir>          Write qualification artifacts here
  --allow-tools <rules>       Grant gated tools; comma-separated and repeatable

Optional:
  --baseline <qualification-result.json>  Compare against a completed result
  --keep-temp                 Preserve temporary workspaces
  --json                      Print exactly one qualification JSON value
  --verbose                   Print run progress to stderr
  -h, --help                  Display help`

export interface HeldOutQualificationOptions {
  corpus?: string
  provider?: string
  profile?: string
  model?: string
  confirmHeldOut?: string
  allowTools: string[]
  runVerification: boolean
  outputDir?: string
  baseline?: string
  keepTemp: boolean
  json: boolean
  verbose: boolean
  help?: true
}

function optionValue(
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

function scalar(
  options: HeldOutQualificationOptions,
  key:
    | 'provider'
    | 'profile'
    | 'model'
    | 'confirmHeldOut'
    | 'outputDir'
    | 'baseline',
  option: string,
  value: string,
): void {
  if (options[key] !== undefined)
    throw new Error(`${option} may be specified only once`)
  options[key] = value
}

/** Parse the strict, side-effect-free qualification command line. */
export function parseHeldOutQualificationOptions(
  argv: readonly string[],
): HeldOutQualificationOptions {
  const options: HeldOutQualificationOptions = {
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
    if (value === '--run-verification') {
      if (options.runVerification)
        throw new Error(`${value} may be specified only once`)
      options.runVerification = true
    } else if (value === '--keep-temp') {
      if (options.keepTemp)
        throw new Error(`${value} may be specified only once`)
      options.keepTemp = true
    } else if (value === '--json') {
      if (options.json) throw new Error(`${value} may be specified only once`)
      options.json = true
    } else if (value === '--verbose') {
      if (options.verbose)
        throw new Error(`${value} may be specified only once`)
      options.verbose = true
    } else if (
      value === '--provider' ||
      value === '--profile' ||
      value === '--model' ||
      value === '--confirm-held-out' ||
      value === '--output-dir' ||
      value === '--baseline'
    ) {
      const selected = optionValue(argv, index, value)
      index += 1
      const key = {
        '--provider': 'provider',
        '--profile': 'profile',
        '--model': 'model',
        '--confirm-held-out': 'confirmHeldOut',
        '--output-dir': 'outputDir',
        '--baseline': 'baseline',
      }[value] as
        | 'provider'
        | 'profile'
        | 'model'
        | 'confirmHeldOut'
        | 'outputDir'
        | 'baseline'
      scalar(options, key, value, selected)
    } else if (value === '--allow-tools') {
      options.allowTools.push(
        ...listValues(optionValue(argv, index, value), value),
      )
      index += 1
    } else if (value.startsWith('-')) {
      throw new Error(`Unknown eval qualify option: ${value}`)
    } else operands.push(value)
  }
  if (operands.length !== 1) throw new Error('eval qualify requires one corpus')
  const corpus = operands[0]
  if (!corpus) throw new Error('eval qualify requires one corpus')
  options.corpus = corpus
  for (const [option, selected] of [
    ['--provider', options.provider],
    ['--profile', options.profile],
    ['--model', options.model],
    ['--confirm-held-out', options.confirmHeldOut],
    ['--output-dir', options.outputDir],
  ] as const)
    if (!selected) throw new Error(`${option} is required`)
  if (!options.runVerification)
    throw new Error('--run-verification is required')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.provider ?? ''))
    throw new Error('--provider is not a safe eval identifier')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(options.profile ?? ''))
    throw new Error('--profile is not a safe eval identifier')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(options.model ?? ''))
    throw new Error('--model is not a safe eval identifier')
  if (
    !/^praxis-held-out-v1@sha256:[0-9a-f]{64}$/u.test(
      options.confirmHeldOut ?? '',
    )
  )
    throw new Error('--confirm-held-out must be <id>@sha256:<64 lowercase hex>')
  return options
}

export interface HeldOutQualificationAggregateReference {
  repository: string
  path: string
  sha256: `sha256:${string}`
  identity_sha256: `sha256:${string}`
}

export interface HeldOutQualificationRun {
  repository: string
  case: string
  run: number
  passed: boolean
  safety_passed: boolean
  verifier_satisfied: boolean
  turns: number
  duration_ms: number
  usage_known: boolean
  cost_known: boolean
  usage: ProjectEvalRunSummary['usage']
  cost_usd: number | null
  identity: ProjectEvalIdentity
}

export interface HeldOutQualificationCaseSummary {
  repository: string
  case: string
  repetitions: number
  passed: number
  failed: number
  safety_passed: number
  safety_failed: number
  verifier_satisfied_runs: number
  verifier_unsatisfied_runs: number
  passed_all: boolean
  safety_passed_all: boolean
  verifier_satisfied: boolean
}

export interface HeldOutQualificationResult {
  schema_version: '1.0'
  corpus: {
    id: string
    version: number
    content_sha256: `sha256:${string}`
    repository_count: number
    task_count: number
    repetitions: number
    planned_run_count: number
  }
  provider: string
  profile: string
  protocol: string
  model: string
  endpoint_sha256: `sha256:${string}`
  plan_sha256: `sha256:${string}`
  praxis_version: string
  build: PraxisBuildIdentity
  node_version: string
  platform: string
  architecture: string
  start: string
  duration_ms: number
  aggregates: readonly HeldOutQualificationAggregateReference[]
  planned_run_count: number
  completed_run_count: number
  passed: number
  failed: number
  safety_passed: number
  safety_failed: number
  verifier_satisfied_runs: number
  verifier_unsatisfied_runs: number
  usage_known_runs: number
  usage_unknown_runs: number
  cost_known_runs: number
  cost_unknown_runs: number
  usage_totals: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    web_search_requests: number
  } | null
  known_cost_total_usd: number | null
  median_turns: number
  p95_turns: number
  median_duration_ms: number
  p95_duration_ms: number
  cases: readonly HeldOutQualificationCaseSummary[]
  runs: readonly HeldOutQualificationRun[]
  baseline?: {
    source_sha256: `sha256:${string}`
    summary: {
      passed: number
      failed: number
      pass_rate: number
      safety_pass_rate: number
      planned_run_count: number
    }
  }
  regressions: readonly {
    case: string
    run: number
    baseline_passed: boolean
    candidate_passed: boolean
  }[]
  metric_deltas: Readonly<
    Record<string, ProjectEvalComparisonMetric<number | null>>
  >
  qualified: boolean | null
  optimization_claim_allowed: boolean
}

export type HeldOutQualificationDependencies = ProjectEvalDependencies

const DIGEST = /^sha256:[0-9a-f]{64}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u
const MAX_RESULT_BYTES = 16 * 1024 * 1024
const PROJECT_EVAL_ARTIFACTS = [
  'trace.jsonl',
  'workspace-diff.json',
  'verification.json',
  'identity.json',
  'result.json',
] as const

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child)
  }
  return value
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`
}

function assertSafePath(path: string, label: string): string {
  if (!path || !isAbsolute(path) || path.includes('\0'))
    throw new Error(`${label} must be an absolute path`)
  return resolve(path)
}

async function assertNoSymlinkComponents(
  path: string,
  label: string,
): Promise<void> {
  const absolute = resolve(path)
  const parts = absolute.split(sep)
  let current = parts[0] === '' ? sep : (parts.shift() ?? '')
  for (const part of parts) {
    if (!part) continue
    current =
      current === sep ? joinPath(current, part) : joinPath(current, part)
    const info = await lstat(current).catch(() => null)
    // macOS exposes /tmp as a platform-owned symlink to /private/tmp. It is
    // safe to accept that fixed system alias while rejecting all user path
    // components.
    if (
      info?.isSymbolicLink() &&
      current !== tmpdir() &&
      current !== resolve(tmpdir()) &&
      current !== '/tmp' &&
      current !== '/private/tmp' &&
      current !== '/var'
    )
      throw new Error(`${label} contains symlink`)
  }
}

function joinPath(left: string, right: string): string {
  return left.endsWith(sep) ? `${left}${right}` : `${left}${sep}${right}`
}

async function admitOutputDirectory(path: string): Promise<string> {
  const output = assertSafePath(path, '--output-dir')
  await assertNoSymlinkComponents(dirname(output), '--output-dir')
  if (await lstat(output).catch(() => null))
    throw new Error('--output-dir must not already exist')
  return output
}

async function admitBaseline(path: string, output: string): Promise<string> {
  const baseline = assertSafePath(path, '--baseline')
  await assertNoSymlinkComponents(baseline, '--baseline')
  if (baseline === output || baseline.startsWith(`${output}${sep}`))
    throw new Error('--baseline must not equal or be inside --output-dir')
  const info = await lstat(baseline).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink())
    throw new Error('--baseline must be a regular file')
  return baseline
}

async function assertProjectEvalArtifacts(
  aggregate: ProjectEvalAggregate,
  aggregatePath: string,
  expectedOutput?: string,
): Promise<void> {
  const artifactRoot = dirname(resolve(aggregatePath))
  if (
    expectedOutput !== undefined &&
    resolve(aggregate.output_dir) !== resolve(expectedOutput)
  )
    throw new Error('Project Eval aggregate output directory drifted')
  for (const run of aggregate.runs) {
    const expectedDirectory = `${run.case}/run-${run.run}`
    if (run.artifact_dir !== expectedDirectory)
      throw new Error(
        `Project Eval artifact directory is invalid for ${run.case} run ${run.run}`,
      )
    const directory = resolve(artifactRoot, run.artifact_dir)
    if (!directory.startsWith(`${artifactRoot}${sep}`))
      throw new Error(
        `Project Eval artifact directory escapes output for ${run.case} run ${run.run}`,
      )
    await assertNoSymlinkComponents(directory, 'Project Eval artifact')
    for (const name of PROJECT_EVAL_ARTIFACTS) {
      const path = join(directory, name)
      const info = await lstat(path).catch(() => null)
      if (!info?.isFile() || info.isSymbolicLink())
        throw new Error(
          `Project Eval artifact is missing or unsafe for ${run.case} run ${run.run}: ${name}`,
        )
    }
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) throw new Error('Qualification requires completed runs')
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
}

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) throw new Error('Qualification requires completed runs')
  return sorted[Math.ceil(sorted.length * 0.95) - 1] as number
}

function runKey(run: { case: string; run: number }): string {
  return `${run.case}\u0000${run.run}`
}

function expectedPlanDigest(
  corpus: HeldOutCorpus,
  build: PraxisBuildIdentity,
  identities: ReadonlyMap<string, ProjectEvalIdentity>,
): `sha256:${string}` {
  const cases = [...identities.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([name, identity]) => ({ case: name, identity }))
  return digest(
    canonical({
      corpus: {
        id: corpus.id,
        version: corpus.version,
        content_sha256: corpus.contentSha256,
        repetitions: corpus.repetitions,
      },
      build,
      cases,
    }),
  )
}

async function preflight(
  options: HeldOutQualificationOptions,
  dependencies: HeldOutQualificationDependencies,
  callerCwd: string,
  signal?: AbortSignal,
): Promise<{
  corpus: HeldOutCorpus
  build: PraxisBuildIdentity
  output: string
  baseline?: string
  identities: Map<string, ProjectEvalIdentity>
  plan: `sha256:${string}`
  protocol: string
  endpoint: `sha256:${string}`
  baselineData?: Awaited<ReturnType<typeof loadQualificationBaseline>>
}> {
  const corpus = await loadHeldOutCorpus(
    resolve(callerCwd, options.corpus as string),
  )
  if (options.confirmHeldOut !== `${corpus.id}@${corpus.contentSha256}`)
    throw new Error('--confirm-held-out does not match the loaded corpus')
  for (const item of corpus.repositories.flatMap(
    (repository) => repository.cases,
  ))
    resolveEvalAllowedTools(item.execution.allowedTools, options.allowTools)
  const output = await admitOutputDirectory(
    resolve(callerCwd, options.outputDir as string),
  )
  const baseline = options.baseline
    ? await admitBaseline(resolve(callerCwd, options.baseline), output)
    : undefined
  const baselineData = baseline
    ? await loadQualificationBaseline(baseline, corpus)
    : undefined
  const build = await dependencies.loadBuildIdentity()
  const identities = new Map<string, ProjectEvalIdentity>()
  let protocol: string | undefined
  let endpoint: string | undefined
  for (const repository of corpus.repositories) {
    for (const item of repository.cases) {
      if (signal?.aborted) throw new Error('Held-out qualification interrupted')
      const workspace = await createProjectEvalWorkspace(item.fixture)
      try {
        const allowedTools = resolveEvalAllowedTools(
          item.execution.allowedTools,
          options.allowTools,
        )
        const descriptor = await dependencies.runtimeFactory.identify({
          dataPlane: 'native',
          cwd: workspace.cwd,
          configRoot: workspace.config,
          home: workspace.home,
          ...(options.provider === undefined
            ? {}
            : { provider: options.provider }),
          ...(options.profile === undefined
            ? {}
            : { providerProfile: options.profile }),
          ...(options.model === undefined ? {} : { model: options.model }),
          maxTurns: item.execution.maxTurns,
          pluginDirectories: [],
          allowedTools,
          ...(item.execution.appendSystemPrompt
            ? { appendSystemPrompt: item.execution.appendSystemPrompt }
            : {}),
          addDirs: [],
          env: item.execution.env,
        })
        if (
          descriptor.providerId !== options.provider ||
          descriptor.profileId !== options.profile ||
          descriptor.modelId !== options.model
        )
          throw new Error(
            `Identity for ${item.name} does not match requested pin`,
          )
        protocol ??= descriptor.protocol
        endpoint ??= descriptor.endpoint
        if (
          protocol !== descriptor.protocol ||
          endpoint !== descriptor.endpoint
        )
          throw new Error(
            `Identity for ${item.name} is not comparable with other cases`,
          )
        identities.set(
          item.name,
          createProjectEvalIdentity({
            provider: descriptor,
            case: item,
            sourceBefore: workspace.sourceBefore,
            effectiveTools: allowedTools,
            runVerification: true,
            praxisVersion: dependencies.version ?? 'unknown',
            buildIdentity: build,
          }),
        )
      } finally {
        await cleanupProjectEvalWorkspace(workspace.root)
      }
    }
  }
  if (baselineData)
    for (const [name, baselineIdentity] of baselineData.identities) {
      const identity = identities.get(name)
      if (!identity) throw new Error(`Baseline has unexpected case ${name}`)
      assertProjectEvalIdentitiesComparable(
        identity,
        baselineIdentity,
        `Baseline ${name}`,
      )
    }
  const planDigest = expectedPlanDigest(corpus, build, identities)
  return {
    corpus,
    build,
    output,
    ...(baseline ? { baseline } : {}),
    identities,
    plan: planDigest,
    protocol: protocol as string,
    endpoint: (identities.values().next().value as ProjectEvalIdentity)
      .endpoint_sha256,
    ...(baselineData ? { baselineData } : {}),
  }
}

function toRunSummary(
  repository: string,
  summary: ProjectEvalRunSummary,
): HeldOutQualificationRun {
  return {
    repository,
    case: summary.case,
    run: summary.run,
    passed: summary.passed,
    safety_passed: summary.safety_passed,
    verifier_satisfied: summary.verification.satisfied,
    turns: summary.turns,
    duration_ms: summary.duration_ms,
    usage_known: summary.usage !== null,
    cost_known: summary.cost_known,
    usage: summary.usage,
    cost_usd: summary.cost_usd,
    identity: summary.identity,
  }
}

function aggregateRuns(
  corpus: HeldOutCorpus,
  aggregates: readonly ProjectEvalAggregate[],
): HeldOutQualificationRun[] {
  const byTarget = new Map(
    aggregates.map((aggregate) => [aggregate.target, aggregate]),
  )
  return corpus.repositories.flatMap((repository) => {
    const aggregate = byTarget.get(repository.target)
    if (!aggregate) return []
    const runs = new Map(aggregate.runs.map((run) => [runKey(run), run]))
    return repository.cases.flatMap((item) =>
      Array.from({ length: corpus.repetitions }, (_, index) => {
        const run = runs.get(runKey({ case: item.name, run: index + 1 }))
        return run ? toRunSummary(repository.id, run) : undefined
      }).filter((run): run is HeldOutQualificationRun => run !== undefined),
    )
  })
}

function totals(runs: readonly HeldOutQualificationRun[]) {
  const usageKnown = runs.every((run) => run.usage_known)
  const usageTotals = usageKnown
    ? {
        input_tokens: runs.reduce(
          (n, run) => n + (run.usage?.inputTokens ?? 0),
          0,
        ),
        output_tokens: runs.reduce(
          (n, run) => n + (run.usage?.outputTokens ?? 0),
          0,
        ),
        cache_read_input_tokens: runs.reduce(
          (n, run) => n + (run.usage?.cacheReadInputTokens ?? 0),
          0,
        ),
        cache_creation_input_tokens: runs.reduce(
          (n, run) => n + (run.usage?.cacheCreationInputTokens ?? 0),
          0,
        ),
        web_search_requests: runs.reduce(
          (n, run) => n + (run.usage?.webSearchRequests ?? 0),
          0,
        ),
      }
    : null
  const knownCosts = runs.filter((run) => run.cost_known)
  return {
    usageTotals,
    knownCostTotal:
      knownCosts.length === runs.length
        ? knownCosts.reduce((n, run) => n + (run.cost_usd ?? 0), 0)
        : null,
  }
}

function caseSummaries(
  corpus: HeldOutCorpus,
  runs: readonly HeldOutQualificationRun[],
): HeldOutQualificationCaseSummary[] {
  return corpus.repositories.flatMap((repository) =>
    repository.cases.map((item) => {
      const selected = runs.filter(
        (run) => run.repository === repository.id && run.case === item.name,
      )
      return {
        repository: repository.id,
        case: item.name,
        repetitions: corpus.repetitions,
        passed: selected.filter((run) => run.passed).length,
        failed: selected.filter((run) => !run.passed).length,
        safety_passed: selected.filter((run) => run.safety_passed).length,
        safety_failed: selected.filter((run) => !run.safety_passed).length,
        verifier_satisfied_runs: selected.filter(
          (run) => run.verifier_satisfied,
        ).length,
        verifier_unsatisfied_runs: selected.filter(
          (run) => !run.verifier_satisfied,
        ).length,
        passed_all:
          selected.length === corpus.repetitions &&
          selected.every((run) => run.passed),
        safety_passed_all:
          selected.length === corpus.repetitions &&
          selected.every((run) => run.safety_passed),
        verifier_satisfied:
          selected.length === corpus.repetitions &&
          selected.every((run) => run.verifier_satisfied),
      }
    }),
  )
}

function assertDerivedQualificationEvidence(
  result: HeldOutQualificationResult,
  runs: readonly HeldOutQualificationRun[],
): void {
  const passed = runs.filter((run) => run.passed).length
  const safetyPassed = runs.filter((run) => run.safety_passed).length
  const verifierSatisfied = runs.filter((run) => run.verifier_satisfied).length
  const usageKnown = runs.filter((run) => run.usage_known).length
  const costKnown = runs.filter((run) => run.cost_known).length
  const known = totals(runs)
  if (
    result.completed_run_count !== runs.length ||
    result.planned_run_count !== runs.length ||
    result.passed !== passed ||
    result.failed !== runs.length - passed ||
    result.safety_passed !== safetyPassed ||
    result.safety_failed !== runs.length - safetyPassed ||
    result.verifier_satisfied_runs !== verifierSatisfied ||
    result.verifier_unsatisfied_runs !== runs.length - verifierSatisfied ||
    result.usage_known_runs !== usageKnown ||
    result.usage_unknown_runs !== runs.length - usageKnown ||
    result.cost_known_runs !== costKnown ||
    result.cost_unknown_runs !== runs.length - costKnown ||
    JSON.stringify(result.usage_totals) !== JSON.stringify(known.usageTotals) ||
    result.known_cost_total_usd !== known.knownCostTotal ||
    result.median_turns !== median(runs.map((run) => run.turns)) ||
    result.p95_turns !== p95(runs.map((run) => run.turns)) ||
    result.median_duration_ms !== median(runs.map((run) => run.duration_ms)) ||
    result.p95_duration_ms !== p95(runs.map((run) => run.duration_ms))
  )
    throw new Error(
      'Baseline qualification statistics diverge from aggregate evidence',
    )
}

async function loadQualificationBaseline(
  path: string,
  corpus: HeldOutCorpus,
): Promise<{
  result: HeldOutQualificationResult
  sourceSha256: `sha256:${string}`
  runs: HeldOutQualificationRun[]
  identities: Map<string, ProjectEvalIdentity>
}> {
  const content = await readFile(path)
  if (content.byteLength > MAX_RESULT_BYTES)
    throw new Error('Baseline qualification result exceeds size limit')
  let raw: unknown
  try {
    raw = JSON.parse(content.toString('utf8'))
  } catch {
    throw new Error('Invalid baseline qualification JSON')
  }
  const result = validateQualificationResult(raw)
  if (
    result.corpus.id !== corpus.id ||
    result.corpus.version !== corpus.version ||
    result.corpus.content_sha256 !== corpus.contentSha256 ||
    result.corpus.task_count !== corpus.taskCount ||
    result.corpus.repetitions !== corpus.repetitions ||
    result.corpus.repository_count !== corpus.repositories.length ||
    result.corpus.planned_run_count !== corpus.plannedRunCount ||
    result.planned_run_count !== corpus.plannedRunCount
  )
    throw new Error(
      'Baseline qualification corpus does not match candidate corpus',
    )
  if (result.qualified !== null || result.optimization_claim_allowed)
    throw new Error('Baseline qualification must be baseline-only evidence')
  if (
    result.regressions.length !== 0 ||
    Object.keys(result.metric_deltas).length !== 0
  )
    throw new Error('Baseline qualification must not contain comparison deltas')
  if (result.aggregates.length !== corpus.repositories.length)
    throw new Error(
      'Baseline aggregate references do not match corpus repositories',
    )
  const loadedAggregates: ProjectEvalAggregate[] = []
  for (const repository of corpus.repositories) {
    const reference = result.aggregates[corpus.repositories.indexOf(repository)]
    const expectedPath = `repositories/${repository.id}/aggregate-result.json`
    if (
      !reference ||
      reference.repository !== repository.id ||
      reference.path !== expectedPath
    )
      throw new Error(
        `Baseline aggregate reference is invalid for ${repository.id}`,
      )
    if (
      !DIGEST.test(reference.sha256) ||
      !DIGEST.test(reference.identity_sha256)
    )
      throw new Error('Baseline aggregate reference digest is invalid')
    const aggregatePath = resolve(dirname(path), reference.path)
    await assertNoSymlinkComponents(aggregatePath, 'Baseline aggregate')
    const bytes = await readFile(aggregatePath).catch(() => null)
    if (!bytes || digest(bytes.toString('utf8')) !== reference.sha256)
      throw new Error(`Baseline aggregate hash mismatch for ${repository.id}`)
    const loaded = await loadProjectEvalAggregate(aggregatePath)
    await assertProjectEvalArtifacts(loaded.aggregate, aggregatePath)
    if (loaded.aggregate.identity_sha256 !== reference.identity_sha256)
      throw new Error(
        `Baseline aggregate identity mismatch for ${repository.id}`,
      )
    if (
      loaded.aggregate.target !== repository.target ||
      loaded.aggregate.case_count !== repository.cases.length ||
      loaded.aggregate.planned_run_count !==
        repository.cases.length * corpus.repetitions ||
      loaded.aggregate.partial ||
      loaded.aggregate.interrupted ||
      loaded.aggregate.completed_run_count !==
        repository.cases.length * corpus.repetitions
    )
      throw new Error(`Baseline aggregate is incomplete for ${repository.id}`)
    const expectedKeys = new Set(
      repository.cases.flatMap((item) =>
        Array.from({ length: corpus.repetitions }, (_, index) =>
          runKey({ case: item.name, run: index + 1 }),
        ),
      ),
    )
    const aggregateKeysSeen = new Set<string>()
    for (const run of loaded.aggregate.runs) {
      const key = runKey(run)
      if (!expectedKeys.has(key) || aggregateKeysSeen.has(key))
        throw new Error(
          `Baseline aggregate run set is invalid for ${repository.id}`,
        )
      aggregateKeysSeen.add(key)
    }
    if (aggregateKeysSeen.size !== expectedKeys.size)
      throw new Error(
        `Baseline aggregate run set is incomplete for ${repository.id}`,
      )
    loadedAggregates.push(loaded.aggregate)
  }
  const derivedRuns = aggregateRuns(corpus, loadedAggregates)
  const expectedRunKeys = derivedRuns.map(runKey).sort(compareStrings)
  const actualRunKeys = result.runs.map(runKey).sort(compareStrings)
  if (
    expectedRunKeys.length !== actualRunKeys.length ||
    expectedRunKeys.some((key, index) => key !== actualRunKeys[index])
  )
    throw new Error('Baseline qualification runs do not match aggregate runs')
  if (JSON.stringify(result.runs) !== JSON.stringify(derivedRuns))
    throw new Error('Baseline qualification runs diverge from aggregates')
  if (
    JSON.stringify(result.cases) !==
    JSON.stringify(caseSummaries(corpus, derivedRuns))
  )
    throw new Error('Baseline case summaries diverge from aggregates')
  assertDerivedQualificationEvidence(result, derivedRuns)
  const baselineIdentities = new Map<string, ProjectEvalIdentity>()
  for (const run of result.runs) {
    const runtime = run.identity.runtime
    if (
      runtime.praxis_version !== result.praxis_version ||
      runtime.node_version !== result.node_version ||
      runtime.platform !== result.platform ||
      runtime.architecture !== result.architecture ||
      canonical(runtime.build) !== canonical(result.build)
    )
      throw new Error(`Baseline runtime identity mismatch for ${run.case}`)
    const previous = baselineIdentities.get(run.case)
    if (previous && canonical(previous) !== canonical(run.identity))
      throw new Error(`Baseline has mixed identities for ${run.case}`)
    baselineIdentities.set(run.case, run.identity)
  }
  if (
    result.plan_sha256 !==
    expectedPlanDigest(corpus, result.build, baselineIdentities)
  )
    throw new Error('Baseline qualification plan does not match its evidence')
  return {
    result,
    sourceSha256: digest(content.toString('utf8')),
    runs: [...derivedRuns],
    identities: baselineIdentities,
  }
}

function validateQualificationResult(
  value: unknown,
): HeldOutQualificationResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid qualification result')
  const source = value as Record<string, unknown>
  const required = [
    'schema_version',
    'corpus',
    'provider',
    'profile',
    'protocol',
    'model',
    'endpoint_sha256',
    'plan_sha256',
    'praxis_version',
    'build',
    'node_version',
    'platform',
    'architecture',
    'start',
    'duration_ms',
    'aggregates',
    'planned_run_count',
    'completed_run_count',
    'passed',
    'failed',
    'safety_passed',
    'safety_failed',
    'verifier_satisfied_runs',
    'verifier_unsatisfied_runs',
    'usage_known_runs',
    'usage_unknown_runs',
    'cost_known_runs',
    'cost_unknown_runs',
    'usage_totals',
    'known_cost_total_usd',
    'median_turns',
    'p95_turns',
    'median_duration_ms',
    'p95_duration_ms',
    'cases',
    'runs',
    'regressions',
    'metric_deltas',
    'qualified',
    'optimization_claim_allowed',
  ]
  if (
    Object.keys(source).some((key) => !required.includes(key)) ||
    Object.keys(source).length !== required.length
  )
    throw new Error('Qualification result has unexpected or missing fields')
  if (source.schema_version !== '1.0')
    throw new Error('Qualification result schema_version must be "1.0"')
  const result = source as unknown as HeldOutQualificationResult
  const corpusObject = source.corpus as Record<string, unknown> | null
  const corpusKeys = [
    'id',
    'version',
    'content_sha256',
    'repository_count',
    'task_count',
    'repetitions',
    'planned_run_count',
  ]
  if (
    !corpusObject ||
    Array.isArray(corpusObject) ||
    Object.keys(corpusObject).length !== corpusKeys.length ||
    Object.keys(corpusObject).some((key) => !corpusKeys.includes(key)) ||
    corpusObject.id !== 'praxis-held-out-v1' ||
    corpusObject.version !== 1 ||
    corpusObject.repetitions !== 3 ||
    !DIGEST.test(String(corpusObject.content_sha256))
  )
    throw new Error('Qualification corpus fields are invalid')
  validatePraxisBuildIdentity(source.build)
  if (
    !IDENTIFIER.test(result.provider) ||
    !IDENTIFIER.test(result.profile) ||
    !MODEL_IDENTIFIER.test(result.model)
  )
    throw new Error('Qualification identity contains unsafe identifier')
  if (!DIGEST.test(result.endpoint_sha256) || !DIGEST.test(result.plan_sha256))
    throw new Error('Qualification identity digest is invalid')
  if (
    typeof result.start !== 'string' ||
    result.start.length === 0 ||
    result.start.length > 128 ||
    !Number.isFinite(result.duration_ms) ||
    result.duration_ms < 0 ||
    !Number.isFinite(result.median_turns) ||
    !Number.isFinite(result.p95_turns) ||
    !Number.isFinite(result.median_duration_ms) ||
    !Number.isFinite(result.p95_duration_ms) ||
    (result.qualified !== null && typeof result.qualified !== 'boolean') ||
    typeof result.optimization_claim_allowed !== 'boolean'
  )
    throw new Error('Qualification result metrics are invalid')
  if (
    !Array.isArray(result.runs) ||
    !Array.isArray(result.aggregates) ||
    !Array.isArray(result.regressions) ||
    !Array.isArray(result.cases)
  )
    throw new Error('Qualification arrays are invalid')
  const aggregateKeys = new Set<string>()
  for (const reference of result.aggregates) {
    const item = reference as unknown as Record<string, unknown>
    if (
      !reference ||
      typeof reference !== 'object' ||
      Array.isArray(reference) ||
      Object.keys(item).length !== 4 ||
      !['repository', 'path', 'sha256', 'identity_sha256'].every(
        (key) => key in item,
      ) ||
      typeof item.repository !== 'string' ||
      !IDENTIFIER.test(item.repository) ||
      typeof item.path !== 'string' ||
      !item.path.startsWith('repositories/') ||
      !DIGEST.test(String(item.sha256)) ||
      !DIGEST.test(String(item.identity_sha256)) ||
      aggregateKeys.has(item.repository)
    )
      throw new Error('Qualification aggregate references are invalid')
    aggregateKeys.add(item.repository)
  }
  const caseKeys = new Set<string>()
  for (const summary of result.cases) {
    const item = summary as unknown as Record<string, unknown>
    const caseFields = [
      'repository',
      'case',
      'repetitions',
      'passed',
      'failed',
      'safety_passed',
      'safety_failed',
      'verifier_satisfied_runs',
      'verifier_unsatisfied_runs',
      'passed_all',
      'safety_passed_all',
      'verifier_satisfied',
    ]
    if (
      !summary ||
      typeof summary !== 'object' ||
      Array.isArray(summary) ||
      Object.keys(item).length !== caseFields.length ||
      caseFields.some((key) => !(key in item)) ||
      typeof item.repository !== 'string' ||
      !IDENTIFIER.test(item.repository) ||
      typeof item.case !== 'string' ||
      !IDENTIFIER.test(item.case) ||
      caseKeys.has(`${item.repository}\u0000${item.case}`) ||
      ![
        item.repetitions,
        item.passed,
        item.failed,
        item.safety_passed,
        item.safety_failed,
        item.verifier_satisfied_runs,
        item.verifier_unsatisfied_runs,
      ].every(
        (number) =>
          typeof number === 'number' &&
          Number.isSafeInteger(number) &&
          number >= 0,
      ) ||
      ![item.passed_all, item.safety_passed_all, item.verifier_satisfied].every(
        (boolean) => typeof boolean === 'boolean',
      )
    )
      throw new Error('Qualification case summaries are invalid')
    caseKeys.add(`${item.repository}\u0000${item.case}`)
  }
  if (result.completed_run_count !== result.runs.length)
    throw new Error('Qualification completed run count is inconsistent')
  if (
    !Number.isSafeInteger(result.planned_run_count) ||
    result.planned_run_count < result.completed_run_count ||
    !Number.isSafeInteger(result.passed) ||
    !Number.isSafeInteger(result.failed) ||
    !Number.isSafeInteger(result.safety_passed) ||
    !Number.isSafeInteger(result.safety_failed) ||
    !Number.isSafeInteger(result.verifier_satisfied_runs) ||
    !Number.isSafeInteger(result.verifier_unsatisfied_runs) ||
    !Number.isSafeInteger(result.usage_known_runs) ||
    !Number.isSafeInteger(result.usage_unknown_runs) ||
    !Number.isSafeInteger(result.cost_known_runs) ||
    !Number.isSafeInteger(result.cost_unknown_runs)
  )
    throw new Error('Qualification totals are invalid')
  const keys = new Set<string>()
  let previousSortKey = ''
  for (const run of result.runs) {
    if (
      !run ||
      typeof run !== 'object' ||
      Object.keys(run).length !== 13 ||
      !IDENTIFIER.test(run.repository) ||
      !IDENTIFIER.test(run.case) ||
      !Number.isSafeInteger(run.run) ||
      run.run < 1 ||
      keys.has(runKey(run))
    )
      throw new Error('Qualification run set is invalid')
    keys.add(runKey(run))
    validateProjectEvalIdentity(run.identity)
    const sortKey = `${run.repository}\u0000${runKey(run)}`
    if (previousSortKey && sortKey < previousSortKey)
      throw new Error('Qualification runs are not deterministically sorted')
    previousSortKey = sortKey
    if (
      run.identity.provider_id !== result.provider ||
      run.identity.profile_id !== result.profile ||
      run.identity.protocol !== result.protocol ||
      run.identity.endpoint_sha256 !== result.endpoint_sha256 ||
      run.identity.model_id !== result.model
    )
      throw new Error(
        'Qualification run identity does not match result identity',
      )
    if (
      typeof run.passed !== 'boolean' ||
      typeof run.safety_passed !== 'boolean' ||
      typeof run.verifier_satisfied !== 'boolean' ||
      typeof run.turns !== 'number' ||
      !Number.isSafeInteger(run.turns) ||
      typeof run.duration_ms !== 'number' ||
      !Number.isFinite(run.duration_ms) ||
      run.duration_ms < 0 ||
      typeof run.usage_known !== 'boolean' ||
      typeof run.cost_known !== 'boolean' ||
      (run.cost_usd !== null &&
        (typeof run.cost_usd !== 'number' || !Number.isFinite(run.cost_usd))) ||
      run.cost_known !== (run.cost_usd !== null) ||
      run.usage_known !== (run.usage !== null)
    )
      throw new Error('Qualification run metrics are invalid')
  }
  const pass = result.runs.filter((run) => run.passed).length
  if (result.passed !== pass || result.failed !== result.runs.length - pass)
    throw new Error('Qualification pass totals are inconsistent')
  if (
    result.safety_passed !==
    result.runs.filter((run) => run.safety_passed).length
  )
    throw new Error('Qualification safety totals are inconsistent')
  if (
    result.verifier_satisfied_runs !==
    result.runs.filter((run) => run.verifier_satisfied).length
  )
    throw new Error('Qualification verifier totals are inconsistent')
  if (
    result.safety_failed !== result.runs.length - result.safety_passed ||
    result.verifier_unsatisfied_runs !==
      result.runs.length - result.verifier_satisfied_runs ||
    result.usage_known_runs !==
      result.runs.filter((run) => run.usage_known).length ||
    result.usage_unknown_runs !==
      result.runs.filter((run) => !run.usage_known).length ||
    result.cost_known_runs !==
      result.runs.filter((run) => run.cost_known).length ||
    result.cost_unknown_runs !==
      result.runs.filter((run) => !run.cost_known).length
  )
    throw new Error('Qualification evidence totals are inconsistent')
  const known = totals(result.runs)
  if (
    JSON.stringify(result.usage_totals) !== JSON.stringify(known.usageTotals) ||
    result.known_cost_total_usd !== known.knownCostTotal
  )
    throw new Error('Qualification usage/cost totals are inconsistent')
  return deepFreeze(result)
}

export async function executeHeldOutQualificationCommand(
  argv: readonly string[],
  io: { stdout(message: string): void; stderr(message: string): void },
  dependencies: HeldOutQualificationDependencies,
  callerCwd = process.cwd(),
  signal?: AbortSignal,
): Promise<number> {
  const options = parseHeldOutQualificationOptions(argv)
  if (options.help) {
    io.stdout(HELD_OUT_QUALIFICATION_HELP)
    return 0
  }
  if (signal?.aborted) return 130
  let plan: Awaited<ReturnType<typeof preflight>>
  try {
    plan = await preflight(options, dependencies, callerCwd, signal)
  } catch (error) {
    if (signal?.aborted) return 130
    throw error
  }
  const started = Date.now()
  io.stderr(
    `held-out=${plan.corpus.id}@${plan.corpus.contentSha256} provider=${options.provider} profile=${options.profile} protocol=${plan.protocol} model=${options.model} endpoint=${plan.endpoint} plan=${plan.plan} runs=${plan.corpus.plannedRunCount}`,
  )
  const aggregates: ProjectEvalAggregate[] = []
  const aggregateFiles: HeldOutQualificationAggregateReference[] = []
  for (const repository of plan.corpus.repositories) {
    if (signal?.aborted) return 130
    const nestedOutput = `${plan.output}/repositories/${repository.id}`
    const stdout: string[] = []
    const stderr: string[] = []
    const code = await (
      await import('./project-eval.js')
    ).executeProjectEvalCommand(
      [
        repository.target,
        '--runs',
        String(plan.corpus.repetitions),
        '--provider',
        options.provider as string,
        '--profile',
        options.profile as string,
        '--model',
        options.model as string,
        '--allow-tools',
        options.allowTools.join(','),
        '--run-verification',
        '--output-dir',
        nestedOutput,
        '--json',
        ...(options.keepTemp ? ['--keep-temp'] : []),
        ...(options.verbose ? ['--verbose'] : []),
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
      { ...dependencies, loadBuildIdentity: async () => plan.build },
      callerCwd,
      signal,
    )
    if (options.verbose) for (const message of stderr) io.stderr(message)
    if (code === 130 || signal?.aborted) return 130
    const aggregatePath = `${nestedOutput}/aggregate-result.json`
    const loaded = await loadProjectEvalAggregate(aggregatePath, callerCwd)
    await assertProjectEvalArtifacts(
      loaded.aggregate,
      aggregatePath,
      nestedOutput,
    )
    const aggregateBytes = await readFile(aggregatePath)
    if (
      loaded.aggregate.target !== repository.target ||
      loaded.aggregate.case_count !== repository.cases.length ||
      loaded.aggregate.planned_run_count !==
        repository.cases.length * plan.corpus.repetitions ||
      loaded.aggregate.completed_run_count !==
        loaded.aggregate.planned_run_count ||
      loaded.aggregate.partial ||
      loaded.aggregate.interrupted
    )
      throw new Error(
        `Project Eval aggregate is incomplete for ${repository.id}`,
      )
    const expectedRunKeys = new Set(
      repository.cases.flatMap((item) =>
        Array.from({ length: plan.corpus.repetitions }, (_, index) =>
          runKey({ case: item.name, run: index + 1 }),
        ),
      ),
    )
    if (
      loaded.aggregate.runs.length !== expectedRunKeys.size ||
      loaded.aggregate.runs.some((run) => !expectedRunKeys.has(runKey(run)))
    )
      throw new Error(
        `Project Eval aggregate run set is invalid for ${repository.id}`,
      )
    const expected = new Map(
      [...plan.identities.entries()].filter(([name]) =>
        plan.corpus.repositories
          .find((item) => item.id === repository.id)
          ?.cases.some((item) => item.name === name),
      ),
    )
    for (const run of loaded.aggregate.runs) {
      const identity = expected.get(run.case)
      if (
        !identity ||
        JSON.stringify(identity) !== JSON.stringify(run.identity)
      )
        throw new Error(`Run identity drifted for ${run.case} run ${run.run}`)
    }
    aggregates.push(loaded.aggregate)
    aggregateFiles.push({
      repository: repository.id,
      path: `repositories/${repository.id}/aggregate-result.json`,
      sha256: digest(aggregateBytes.toString('utf8')),
      identity_sha256: loaded.aggregate.identity_sha256,
    })
  }
  const runs = aggregateRuns(plan.corpus, aggregates)
  if (signal?.aborted) return 130
  if (runs.length !== plan.corpus.plannedRunCount)
    throw new Error('Qualification did not collect all planned runs')
  if (signal?.aborted) return 130
  const statistics = totals(runs)
  const baseline = plan.baselineData
  const regressions = baseline
    ? runs.flatMap((run) => {
        const old = baseline.runs.find((item) => runKey(item) === runKey(run))
        return old?.passed && !run.passed
          ? [
              {
                case: run.case,
                run: run.run,
                baseline_passed: true,
                candidate_passed: false,
              },
            ]
          : []
      })
    : []
  const baselinePassRate = baseline
    ? baseline.result.passed / baseline.result.completed_run_count
    : 0
  const candidatePassRate =
    runs.filter((run) => run.passed).length / runs.length
  const candidateSafety = runs.every((run) => run.safety_passed)
  const qualified = baseline
    ? candidateSafety &&
      regressions.length === 0 &&
      candidatePassRate >= baselinePassRate &&
      runs.every((run) => run.verifier_satisfied)
    : null
  const metricDeltas: Readonly<
    Record<string, ProjectEvalComparisonMetric<number | null>>
  > = baseline
    ? {
        pass_rate: {
          baseline: baselinePassRate,
          candidate: candidatePassRate,
          delta: candidatePassRate - baselinePassRate,
        },
        safety_pass_rate: {
          baseline:
            baseline.result.safety_passed / baseline.result.completed_run_count,
          candidate:
            runs.filter((run) => run.safety_passed).length / runs.length,
          delta:
            runs.filter((run) => run.safety_passed).length / runs.length -
            baseline.result.safety_passed / baseline.result.completed_run_count,
        },
        median_turns: {
          baseline: baseline.result.median_turns,
          candidate: median(runs.map((run) => run.turns)),
          delta:
            median(runs.map((run) => run.turns)) - baseline.result.median_turns,
        },
        p95_turns: {
          baseline: baseline.result.p95_turns,
          candidate: p95(runs.map((run) => run.turns)),
          delta: p95(runs.map((run) => run.turns)) - baseline.result.p95_turns,
        },
        median_duration_ms: {
          baseline: baseline.result.median_duration_ms,
          candidate: median(runs.map((run) => run.duration_ms)),
          delta:
            median(runs.map((run) => run.duration_ms)) -
            baseline.result.median_duration_ms,
        },
        p95_duration_ms: {
          baseline: baseline.result.p95_duration_ms,
          candidate: p95(runs.map((run) => run.duration_ms)),
          delta:
            p95(runs.map((run) => run.duration_ms)) -
            baseline.result.p95_duration_ms,
        },
        known_cost_total_usd: {
          baseline: baseline.result.known_cost_total_usd,
          candidate: statistics.knownCostTotal,
          delta:
            baseline.result.known_cost_total_usd === null ||
            statistics.knownCostTotal === null
              ? null
              : statistics.knownCostTotal -
                baseline.result.known_cost_total_usd,
        },
      }
    : {}
  const result: HeldOutQualificationResult = {
    schema_version: '1.0',
    corpus: {
      id: plan.corpus.id,
      version: plan.corpus.version,
      content_sha256: plan.corpus.contentSha256,
      repository_count: plan.corpus.repositories.length,
      task_count: plan.corpus.taskCount,
      repetitions: plan.corpus.repetitions,
      planned_run_count: plan.corpus.plannedRunCount,
    },
    provider: options.provider as string,
    profile: options.profile as string,
    protocol: plan.protocol,
    model: options.model as string,
    endpoint_sha256: plan.endpoint,
    plan_sha256: plan.plan,
    praxis_version: dependencies.version ?? 'unknown',
    build: plan.build,
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
    start: new Date(started).toISOString(),
    duration_ms: Date.now() - started,
    aggregates: aggregateFiles,
    planned_run_count: plan.corpus.plannedRunCount,
    completed_run_count: runs.length,
    passed: runs.filter((run) => run.passed).length,
    failed: runs.filter((run) => !run.passed).length,
    safety_passed: runs.filter((run) => run.safety_passed).length,
    safety_failed: runs.filter((run) => !run.safety_passed).length,
    verifier_satisfied_runs: runs.filter((run) => run.verifier_satisfied)
      .length,
    verifier_unsatisfied_runs: runs.filter((run) => !run.verifier_satisfied)
      .length,
    usage_known_runs: runs.filter((run) => run.usage_known).length,
    usage_unknown_runs: runs.filter((run) => !run.usage_known).length,
    cost_known_runs: runs.filter((run) => run.cost_known).length,
    cost_unknown_runs: runs.filter((run) => !run.cost_known).length,
    usage_totals: statistics.usageTotals,
    known_cost_total_usd: statistics.knownCostTotal,
    median_turns: median(runs.map((run) => run.turns)),
    p95_turns: p95(runs.map((run) => run.turns)),
    median_duration_ms: median(runs.map((run) => run.duration_ms)),
    p95_duration_ms: p95(runs.map((run) => run.duration_ms)),
    cases: caseSummaries(plan.corpus, runs),
    runs,
    ...(baseline
      ? {
          baseline: {
            source_sha256: baseline.sourceSha256,
            summary: {
              passed: baseline.result.passed,
              failed: baseline.result.failed,
              pass_rate: baselinePassRate,
              safety_pass_rate:
                baseline.result.safety_passed /
                baseline.result.completed_run_count,
              planned_run_count: baseline.result.planned_run_count,
            },
          },
        }
      : {}),
    regressions,
    metric_deltas: metricDeltas,
    qualified,
    optimization_claim_allowed:
      qualified === true &&
      runs.every((run) => run.usage_known && run.cost_known) &&
      (baseline?.runs.every((run) => run.usage_known && run.cost_known) ??
        true),
  }
  if (signal?.aborted) return 130
  await writeFileAtomically(
    `${plan.output}/qualification-result.json`,
    JSON.stringify(result, null, 2),
  )
  if (options.json) io.stdout(`${JSON.stringify(result)}\n`)
  else io.stdout(`${result.passed}/${result.completed_run_count} passed\n`)
  return qualified === true ? 0 : qualified === false ? 1 : 0
}
