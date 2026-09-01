import { readFile } from 'node:fs/promises'

import type {
  ClaudePluginEvalCase,
  EvalFocus,
} from './claude-plugin-eval-schema.js'
import { resolveContainedPath } from './claude-plugin-eval-schema.js'
export type {
  EvalTraceEvent,
  EvalRunArtifacts,
  EvalGraderResult,
  EvalJudge,
} from '../evals/eval-contract.js'
import type {
  EvalDeterministicGrader,
  EvalRunArtifacts,
  EvalGraderResult,
  EvalJudge,
} from '../evals/eval-contract.js'
import { gradeDeterministicEvalRun } from '../evals/eval-graders.js'

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
      const [result] = await gradeDeterministicEvalRun({
        graders: [item as EvalDeterministicGrader],
        artifacts: options.artifacts,
      })
      if (result) results.push(result)
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
