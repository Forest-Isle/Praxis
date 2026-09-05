import type { ModelUsage } from '../core/runtime.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import { BoundedProcessRunner } from '../platform/bounded-process-runner.js'
import {
  redactSensitiveValue,
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import { gradeDeterministicEvalRun } from './eval-graders.js'
import {
  normalizeEvalTraceEvent,
  resolveEvalAllowedTools,
  type EvalGraderResult,
  type EvalRuntimeFactoryIdentityOptions,
  type IdentifiedEvalRuntimeFactory,
  type EvalTraceEvent,
} from './eval-contract.js'
import {
  createProjectEvalIdentity,
  type ProjectEvalIdentity,
} from './project-eval-identity.js'
import type { ProjectEvalCase } from './project-eval-schema.js'
import {
  cleanupProjectEvalWorkspace,
  createProjectEvalWorkspace,
  diffProjectEvalWorkspace,
} from './project-eval-workspace.js'
import { minimatch } from 'minimatch'
import { join } from 'node:path'

export type ProjectEvalTermination = 'timeout' | 'interrupted' | null

export interface ProjectEvalVerificationResult {
  schema_version: '1.0'
  name: string
  command: string
  argv: readonly string[]
  exit_code: number | null
  timed_out: boolean
  stdout: string
  stderr: string
  truncated: boolean
  duration_ms: number
  passed: boolean
  error: string | null
}

export interface ProjectEvalRunResult {
  schema_version: '1.1'
  case: string
  run: number
  version: string
  model: string
  identity: ProjectEvalIdentity
  passed: boolean
  score: 0 | 1
  turns: number
  usage: ModelUsage | null
  cost_usd: number | null
  cost_known: boolean
  duration_ms: number
  termination: ProjectEvalTermination
  safety_passed: boolean
  permission_decisions: { allow: number; ask: number; deny: number }
  tool_errors: number
  retries: number
  graders: readonly EvalGraderResult[]
  checks: readonly EvalGraderResult[]
  artifacts: {
    trace: 'trace.jsonl'
    workspace_diff: 'workspace-diff.json'
    verification: 'verification.json'
    identity: 'identity.json'
    result: 'result.json'
  }
  error: string | null
  cleanup_errors: readonly string[]
  temp_root: string | null
}

const SAFETY_CHECKS = [
  'trace-bounds',
  'runtime-close',
  'workspace-manifest',
  'source-unchanged',
  'allowed-paths',
  'forbidden-paths',
  'artifact-write',
  'temp-cleanup',
] as const

function runEvidence(
  trace: readonly EvalTraceEvent[],
  checks: readonly EvalGraderResult[],
): Pick<
  ProjectEvalRunResult,
  'safety_passed' | 'permission_decisions' | 'tool_errors' | 'retries'
> {
  const permission_decisions = { allow: 0, ask: 0, deny: 0 }
  let tool_errors = 0
  let retries = 0
  for (const event of trace) {
    if (event.type === 'permission-decision') {
      const behavior = event.behavior
      if (behavior === 'allow' || behavior === 'ask' || behavior === 'deny')
        permission_decisions[behavior] += 1
    } else if (event.type === 'tool-result' && event.isError === true)
      tool_errors += 1
    else if (event.type === 'api-retry') retries += 1
  }
  return {
    safety_passed: SAFETY_CHECKS.every(
      (name) => checks.find((check) => check.name === name)?.passed === true,
    ),
    permission_decisions,
    tool_errors,
    retries,
  }
}

interface ProjectEvalRunOptions {
  case: ProjectEvalCase
  factory: IdentifiedEvalRuntimeFactory
  run: number
  allowTools?: readonly string[]
  model?: string
  keepTemp?: boolean
  runVerification?: boolean
  outputDir: string
  version: string
  signal?: AbortSignal
}

function check(
  name: string,
  passed: boolean,
  explanation: string,
  evidence?: string,
): EvalGraderResult {
  return {
    name,
    passed,
    weight: 1,
    explanation,
    ...(evidence === undefined ? {} : { evidence }),
  }
}

const MAX_TRACE_EVENTS = 10_000
const MAX_TRACE_BYTES = 8 * 1024 * 1024

function serializeTrace(value: unknown): string {
  try {
    const seen = new WeakSet<object>()
    return (
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === 'bigint') return String(item)
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[Circular]'
          seen.add(item)
        }
        return item
      }) ?? 'null'
    )
  } catch {
    return '"[Unserializable]"'
  }
}

function verifierEnvironment(
  evalEnvironment: Readonly<Record<string, string>>,
  home: string,
  temporaryDirectory: string,
): Record<string, string> {
  const environment: Record<string, string> = {
    ...evalEnvironment,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  }
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ] as const) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

export async function runProjectEvalCase(
  options: ProjectEvalRunOptions,
): Promise<ProjectEvalRunResult> {
  if (!Number.isSafeInteger(options.run) || options.run < 1)
    throw new Error('Project eval run index must be a positive integer')
  if (options.case.verification.length && !options.runVerification)
    throw new Error('Verification requires --run-verification')

  const allowedTools = resolveEvalAllowedTools(
    options.case.execution.allowedTools,
    options.allowTools ?? [],
  )
  const sensitiveValues = sensitiveEnvironmentValues(
    process.env,
    options.case.execution.env,
  )
  const errorText = (error: unknown): string =>
    redactSensitiveText(
      error instanceof Error ? error.message : String(error),
      sensitiveValues,
    )

  const workspace = await createProjectEvalWorkspace(options.case.fixture)
  const trace: EvalTraceEvent[] = []
  const traceRecords: string[] = []
  let traceBytes = 0
  let traceOverflow = false
  const verifications: ProjectEvalVerificationResult[] = []
  const verifierChecks: EvalGraderResult[] = []
  const cleanupErrors: string[] = []
  const started = Date.now()
  let runtime:
    Awaited<ReturnType<IdentifiedEvalRuntimeFactory['create']>> | undefined
  let runtimeCompleted = false
  let runtimeError: string | null = null
  let runtimeCloseError: string | null = null
  let termination: ProjectEvalTermination = null
  let turns = 0
  let usage: ModelUsage | null = null
  let costUsd: number | null = null
  let lastMessage = ''
  let graderError: string | null = null
  let graders: EvalGraderResult[] = []

  const effectiveModel = options.model ?? options.case.execution.model
  const factoryOptions: EvalRuntimeFactoryIdentityOptions = {
    dataPlane: 'native',
    cwd: workspace.cwd,
    configRoot: workspace.config,
    home: workspace.home,
    maxTurns: options.case.execution.maxTurns,
    pluginDirectories: [],
    allowedTools,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(options.case.execution.appendSystemPrompt
      ? { appendSystemPrompt: options.case.execution.appendSystemPrompt }
      : {}),
    addDirs: [],
    env: options.case.execution.env,
  }
  let identity: ProjectEvalIdentity
  try {
    const descriptor = await options.factory.identify(factoryOptions)
    identity = createProjectEvalIdentity({
      provider: descriptor,
      case: options.case,
      sourceBefore: workspace.sourceBefore,
      effectiveTools: allowedTools,
      runVerification: options.runVerification ?? false,
      praxisVersion: options.version,
    })
  } catch (error) {
    await cleanupProjectEvalWorkspace(workspace.root).catch(() => undefined)
    throw error
  }

  const runtimeController = new AbortController()
  let deadlineReached = false
  const forwardAbort = () => runtimeController.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal?.aborted) forwardAbort()
  const runtimeTimer = setTimeout(() => {
    deadlineReached = true
    runtimeController.abort(
      new DOMException('Eval run timed out', 'AbortError'),
    )
  }, options.case.execution.timeoutSeconds * 1000)

  try {
    runtime = await options.factory.create({
      ...factoryOptions,
      eventSink: (event) => {
        if (traceOverflow) return
        try {
          const normalized = normalizeEvalTraceEvent(event)
          const redacted = redactSensitiveValue(
            normalized,
            sensitiveValues,
          ) as EvalTraceEvent
          const encoded = serializeTrace(redacted)
          const bytes = Buffer.byteLength(encoded)
          const nextBytes = traceBytes + bytes + (trace.length ? 1 : 0)
          if (trace.length >= MAX_TRACE_EVENTS || nextBytes > MAX_TRACE_BYTES) {
            traceOverflow = true
            return
          }
          trace.push(JSON.parse(encoded) as EvalTraceEvent)
          traceRecords.push(encoded)
          traceBytes = nextBytes
        } catch {
          traceOverflow = true
        }
      },
    })
    const result = await runtime.run(
      options.case.execution.prompt,
      runtimeController.signal,
    )
    lastMessage = result.text
    turns = result.turns
    usage = result.usage ?? null
    costUsd = result.costUsd ?? null
    if (options.signal?.aborted) {
      termination = 'interrupted'
      runtimeError = 'Eval run interrupted'
    } else if (deadlineReached || runtimeController.signal.aborted) {
      termination = 'timeout'
      runtimeError = 'Eval run timed out'
    } else {
      runtimeCompleted = true
    }
  } catch (error) {
    runtimeError = errorText(error)
    if (options.signal?.aborted) {
      termination = 'interrupted'
      runtimeError = 'Eval run interrupted'
    } else if (deadlineReached || runtimeController.signal.aborted) {
      termination = 'timeout'
      runtimeError = 'Eval run timed out'
    }
  } finally {
    clearTimeout(runtimeTimer)
    options.signal?.removeEventListener('abort', forwardAbort)
    try {
      await runtime?.close?.()
    } catch (error) {
      runtimeCloseError = errorText(error)
      cleanupErrors.push(`Runtime cleanup failed: ${runtimeCloseError}`)
    }
  }

  if (runtimeCompleted && !runtimeCloseError && !termination) {
    for (const verifier of options.case.verification) {
      const verifierStarted = Date.now()
      try {
        const result = await new BoundedProcessRunner({
          cwd: workspace.cwd,
          maxOutputBytes: 64 * 1024,
        }).run({
          command: verifier.command,
          args: [...verifier.args],
          cwd: workspace.cwd,
          timeoutMs: verifier.timeoutSeconds * 1000,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          env: verifierEnvironment(
            options.case.execution.env,
            workspace.home,
            workspace.root,
          ),
          inheritEnvironment: false,
          redactExplicitEnvironment: true,
        })
        const passed = result.code === 0 && !result.timedOut
        const verifierError = result.timedOut
          ? 'Verifier timed out'
          : result.code === 0
            ? null
            : `Verifier exited with code ${result.code}`
        verifications.push({
          schema_version: '1.0',
          name: verifier.name,
          command: verifier.command,
          argv: [...verifier.args],
          exit_code: result.code,
          timed_out: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.truncated,
          duration_ms: Date.now() - verifierStarted,
          passed,
          error: verifierError,
        })
        verifierChecks.push(
          check(
            `verifier:${verifier.name}`,
            passed,
            passed ? 'Verifier passed' : (verifierError ?? 'Verifier failed'),
          ),
        )
      } catch (error) {
        const message = errorText(error)
        if (options.signal?.aborted) termination = 'interrupted'
        verifications.push({
          schema_version: '1.0',
          name: verifier.name,
          command: verifier.command,
          argv: [...verifier.args],
          exit_code: null,
          timed_out: false,
          stdout: '',
          stderr: '',
          truncated: false,
          duration_ms: Date.now() - verifierStarted,
          passed: false,
          error: message,
        })
        verifierChecks.push(check(`verifier:${verifier.name}`, false, message))
        if (termination === 'interrupted') break
      }
    }
  }

  const verifiersPassed = verifierChecks.every((item) => item.passed)
  if (
    runtimeCompleted &&
    !runtimeCloseError &&
    !termination &&
    verifiersPassed &&
    options.case.graders.length > 0
  ) {
    try {
      graders = await gradeDeterministicEvalRun({
        graders: options.case.graders,
        artifacts: { lastMessage, trace, cwd: workspace.cwd },
      })
    } catch (error) {
      graderError = errorText(error)
    }
  }

  let manifestError: string | null = null
  let after: Awaited<ReturnType<typeof workspace.manifest>> | undefined
  let sourceAfter: Awaited<ReturnType<typeof workspace.manifest>> | undefined
  try {
    after = await workspace.manifest(workspace.cwd)
    sourceAfter = await workspace.manifest(options.case.fixture)
  } catch (error) {
    manifestError = errorText(error)
  }
  const workspaceDiff = after
    ? await diffProjectEvalWorkspace(workspace.before, after)
    : { added: [], modified: [], deleted: [], changed: [] }
  const sourceUnchanged =
    sourceAfter !== undefined &&
    JSON.stringify(sourceAfter) === JSON.stringify(workspace.sourceBefore)
  const allowedPaths = workspaceDiff.changed.every((path) =>
    options.case.expect.allowedChangedPaths.some((pattern) =>
      minimatch(path, pattern),
    ),
  )
  const expectedPaths = options.case.expect.expectedChangedPaths.every(
    (pattern) => workspaceDiff.changed.some((path) => minimatch(path, pattern)),
  )
  const forbiddenPaths = !workspaceDiff.changed.some((path) =>
    options.case.expect.forbiddenChangedPaths.some((pattern) =>
      minimatch(path, pattern),
    ),
  )

  const checks: EvalGraderResult[] = [
    check(
      'runtime',
      runtimeCompleted && runtimeError === null,
      runtimeCompleted
        ? 'Runtime completed'
        : (runtimeError ?? 'Runtime failed'),
    ),
    check(
      'termination',
      termination === null,
      termination === null ? 'Run completed' : `Run ${termination}`,
    ),
    check(
      'trace-bounds',
      !traceOverflow,
      traceOverflow ? 'Trace exceeded artifact bounds' : 'Trace within bounds',
    ),
    check(
      'runtime-close',
      runtimeCloseError === null,
      runtimeCloseError === null
        ? runtime
          ? 'Runtime closed'
          : 'Runtime was not created'
        : `Runtime cleanup failed: ${runtimeCloseError}`,
    ),
    ...verifierChecks,
    ...graders.map((grader) =>
      check(
        `grader:${grader.name}`,
        grader.passed,
        grader.explanation,
        grader.evidence,
      ),
    ),
    ...(graderError
      ? [check('graders', false, `Project graders failed: ${graderError}`)]
      : []),
    check(
      'workspace-manifest',
      manifestError === null && after !== undefined,
      manifestError ?? 'Workspace manifest completed',
    ),
    check(
      'source-unchanged',
      sourceUnchanged,
      sourceUnchanged ? 'Source fixture unchanged' : 'Source fixture changed',
    ),
    check(
      'allowed-paths',
      allowedPaths,
      allowedPaths ? 'All changes are allowed' : 'Unexpected path mutation',
      workspaceDiff.changed.join('\n'),
    ),
    check(
      'expected-paths',
      expectedPaths,
      expectedPaths
        ? 'Expected changes are present'
        : 'Expected change missing',
      workspaceDiff.changed.join('\n'),
    ),
    check(
      'forbidden-paths',
      forbiddenPaths,
      forbiddenPaths ? 'No forbidden changes' : 'Forbidden path changed',
      workspaceDiff.changed.join('\n'),
    ),
  ]

  const runDirectory = join(
    options.outputDir,
    options.case.name,
    `run-${options.run}`,
  )
  let artifactError: string | null = null
  try {
    await writeFileAtomically(
      join(runDirectory, 'trace.jsonl'),
      traceRecords.join('\n'),
    )
    await writeFileAtomically(
      join(runDirectory, 'workspace-diff.json'),
      JSON.stringify({ schema_version: '1.0', ...workspaceDiff }, null, 2),
    )
    await writeFileAtomically(
      join(runDirectory, 'verification.json'),
      JSON.stringify(verifications, null, 2),
    )
    await writeFileAtomically(
      join(runDirectory, 'identity.json'),
      JSON.stringify(identity, null, 2),
    )
  } catch (error) {
    artifactError = errorText(error)
  }
  checks.push(
    check(
      'artifact-write',
      artifactError === null,
      artifactError ?? 'Run artifacts written',
    ),
  )

  let tempCleanupError: string | null = null
  if (!options.keepTemp) {
    try {
      await cleanupProjectEvalWorkspace(workspace.root)
    } catch (error) {
      tempCleanupError = errorText(error)
      cleanupErrors.push(`Temp cleanup failed: ${tempCleanupError}`)
    }
  }
  checks.push(
    check(
      'temp-cleanup',
      tempCleanupError === null,
      options.keepTemp
        ? 'Temporary workspace kept by request'
        : tempCleanupError === null
          ? 'Temporary workspace removed'
          : `Temporary workspace cleanup failed: ${tempCleanupError}`,
    ),
  )

  const passed = checks.every((item) => item.passed)
  const evidence = runEvidence(trace, checks)
  const primaryError =
    runtimeError ??
    graderError ??
    verifications.find((verification) => verification.error)?.error ??
    manifestError ??
    checks.find((item) => !item.passed)?.explanation ??
    null
  const result: ProjectEvalRunResult = {
    schema_version: '1.1',
    case: options.case.name,
    run: options.run,
    version: options.version,
    model: identity.model_id,
    identity,
    passed,
    score: passed ? 1 : 0,
    turns,
    usage,
    cost_usd: costUsd,
    cost_known: costUsd !== null,
    duration_ms: Date.now() - started,
    termination,
    ...evidence,
    graders,
    checks,
    artifacts: {
      trace: 'trace.jsonl',
      workspace_diff: 'workspace-diff.json',
      verification: 'verification.json',
      identity: 'identity.json',
      result: 'result.json',
    },
    error: primaryError,
    cleanup_errors: cleanupErrors,
    temp_root: options.keepTemp ? workspace.root : null,
  }
  await writeFileAtomically(
    join(runDirectory, 'result.json'),
    JSON.stringify(result, null, 2),
  )
  return result
}
