import { readFile } from 'node:fs/promises'

import { minimatch } from 'minimatch'

import type {
  ClaudePluginEvalCase,
  ClaudePluginEvalGrader,
  EvalFocus,
  EvalToolMatch,
} from './claude-plugin-eval-schema.js'
import { resolveContainedPath } from './claude-plugin-eval-schema.js'

export interface EvalTraceEvent {
  type: string
  tool?: string
  input?: Record<string, unknown>
  [key: string]: unknown
}
export interface EvalRunArtifacts {
  lastMessage: string
  trace: readonly EvalTraceEvent[]
  cwd: string
}
export interface EvalGraderResult {
  name: string
  passed: boolean
  weight: number
  explanation: string
  judge_votes?: readonly boolean[]
  evidence?: string
  with_only?: boolean
}
export interface EvalJudge {
  vote(request: {
    criteria: string
    focus: string
    baseline?: string
    model: string
    signal?: AbortSignal
  }): Promise<{ passed: boolean; explanation?: string; costUsd: number }>
}

function subset(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      return false
    return Object.entries(expected as Record<string, unknown>).every(
      ([key, value]) => subset((actual as Record<string, unknown>)[key], value),
    )
  }
  return Object.is(actual, expected)
}

function matches(event: EvalTraceEvent, match: EvalToolMatch): boolean {
  const selected = typeof match === 'string' ? { tool: match } : match
  return (
    event.type === 'tool-call' &&
    event.tool === selected.tool &&
    (!selected.input_match || subset(event.input, selected.input_match))
  )
}

async function focusText(
  focus: EvalFocus,
  artifacts: EvalRunArtifacts,
): Promise<string> {
  if (focus === 'last_message') return artifacts.lastMessage
  if (focus === 'trace')
    return artifacts.trace.map((item) => JSON.stringify(item)).join('\n')
  if (focus === 'files') {
    const { glob } = await import('node:fs/promises')
    const names: string[] = []
    for await (const path of glob('**/*', {
      cwd: artifacts.cwd,
      exclude: ['node_modules/**', '.git/**'],
    }))
      names.push(path)
    return names.sort().join('\n')
  }
  return readFile(
    await resolveContainedPath(artifacts.cwd, focus.path, 'Grader focus'),
    'utf8',
  )
}

async function freeGrade(
  grader: Exclude<ClaudePluginEvalGrader, { type: 'llm' | 'baseline' }>,
  artifacts: EvalRunArtifacts,
): Promise<EvalGraderResult> {
  let passed = false
  let evidence = ''
  if (grader.type === 'regex') {
    const target = await focusText(grader.target, artifacts)
    const expression = new RegExp(
      grader.pattern,
      grader.flags.includes('g') ? grader.flags : `${grader.flags}g`,
    )
    const count = [...target.matchAll(expression)].length
    passed =
      grader.match === 'contains'
        ? count > 0
        : grader.match === 'not_contains'
          ? count === 0
          : count === Number(grader.match.slice(6))
    evidence = `matches=${count}`
  } else if (grader.type === 'tool_used') {
    const count = artifacts.trace.filter((event) =>
      matches(event, {
        tool: grader.tool,
        ...(grader.input_match ? { input_match: grader.input_match } : {}),
      }),
    ).length
    passed = count >= grader.min && count <= grader.max
    evidence = `uses=${count}`
  } else if (grader.type === 'tool_order') {
    const before = artifacts.trace.findIndex((event) =>
      matches(event, grader.before),
    )
    const after = artifacts.trace.findIndex(
      (event, index) => index > before && matches(event, grader.after),
    )
    passed = before >= 0 && after > before
    evidence = `before=${before},after=${after}`
  } else {
    const { glob } = await import('node:fs/promises')
    let count = 0
    for await (const path of glob('**/*', { cwd: artifacts.cwd })) {
      if (!minimatch(path, grader.path)) continue
      await resolveContainedPath(artifacts.cwd, path, 'file_exists match')
      count += 1
    }
    passed = grader.exists ? count > 0 : count === 0
    evidence = `files=${count}`
  }
  return {
    name: grader.name,
    passed,
    weight: grader.weight,
    explanation: passed ? 'passed' : 'failed',
    evidence,
    ...(grader.arm === 'with-only' ? { with_only: true } : {}),
  }
}

export async function gradeClaudePluginEvalRun(options: {
  case: ClaudePluginEvalCase
  artifacts: EvalRunArtifacts
  judge?: EvalJudge
  judgeModel: string
  skipPaid?: boolean
  arm: 'with' | 'without'
  signal?: AbortSignal
}): Promise<{
  score: number
  graders: EvalGraderResult[]
  skippedPaidGraders: boolean
  judgeCostUsd: number
}> {
  const results: EvalGraderResult[] = []
  let skippedPaidGraders = false
  let judgeCostUsd = 0
  for (const item of options.case.graders) {
    if (options.arm === 'without' && item.arm === 'with-only') continue
    if (item.type !== 'llm' && item.type !== 'baseline') {
      results.push(await freeGrade(item, options.artifacts))
      continue
    }
    if (options.skipPaid) {
      skippedPaidGraders = true
      continue
    }
    if (!options.judge)
      throw new Error(`Paid grader ${item.name} requires an eval judge`)
    const judge = options.judge
    const focus =
      item.type === 'llm'
        ? await focusText(item.focus, options.artifacts)
        : options.artifacts.lastMessage
    const baseline =
      item.type === 'baseline'
        ? await readFile(
            await resolveContainedPath(
              options.case.dir,
              item.baseline_file,
              'Baseline file',
            ),
            'utf8',
          )
        : undefined
    const votes = await Promise.all(
      Array.from({ length: 3 }, () =>
        judge.vote({
          criteria: item.criteria,
          focus,
          ...(baseline === undefined ? {} : { baseline }),
          model: options.judgeModel,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      ),
    )
    const passed = votes.filter((vote) => vote.passed).length >= 2
    judgeCostUsd += votes.reduce((sum, vote) => sum + vote.costUsd, 0)
    results.push({
      name: item.name,
      passed,
      weight: item.weight,
      explanation:
        votes.find((vote) => vote.explanation)?.explanation ??
        (passed ? 'passed' : 'failed'),
      judge_votes: votes.map((vote) => vote.passed),
      ...(item.arm === 'with-only' ? { with_only: true } : {}),
    })
  }
  const scored = results
  const total = scored.reduce((sum, item) => sum + item.weight, 0)
  const score =
    total === 0
      ? 0
      : scored
          .filter((item) => item.passed)
          .reduce((sum, item) => sum + item.weight, 0) / total
  return { score, graders: results, skippedPaidGraders, judgeCostUsd }
}
