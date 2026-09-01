import { glob, readFile, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { minimatch } from 'minimatch'

import {
  type EvalDeterministicGrader,
  type EvalFocus,
  type EvalGraderResult,
  type EvalRunArtifacts,
  type EvalToolMatch,
} from './eval-contract.js'

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

function matches(
  event: EvalRunArtifacts['trace'][number],
  match: EvalToolMatch,
): boolean {
  const selected = typeof match === 'string' ? { tool: match } : match
  return (
    event.type === 'tool-call' &&
    event.tool === selected.tool &&
    (!selected.input_match || subset(event.input, selected.input_match))
  )
}

async function containedPath(root: string, candidate: string): Promise<string> {
  const rootPath = await realpath(resolve(root))
  const path = await realpath(resolve(rootPath, candidate))
  if (path !== rootPath && !path.startsWith(`${rootPath}${sep}`))
    throw new Error(`Grader path escapes workspace: ${candidate}`)
  return path
}

async function focusText(
  focus: EvalFocus,
  artifacts: EvalRunArtifacts,
): Promise<string> {
  if (focus === 'last_message') return artifacts.lastMessage
  if (focus === 'trace')
    return artifacts.trace.map((item) => JSON.stringify(item)).join('\n')
  if (focus === 'files') {
    const names: string[] = []
    for await (const path of glob('**/*', {
      cwd: artifacts.cwd,
      exclude: ['node_modules/**', '.git/**'],
    }))
      names.push(path)
    return names.sort().join('\n')
  }
  return readFile(await containedPath(artifacts.cwd, focus.path), 'utf8')
}

export async function gradeDeterministicEvalRun(options: {
  graders: readonly EvalDeterministicGrader[]
  artifacts: EvalRunArtifacts
}): Promise<EvalGraderResult[]> {
  const results: EvalGraderResult[] = []
  for (const grader of options.graders) {
    let passed = false
    let evidence = ''
    if (grader.type === 'regex') {
      const target = await focusText(grader.target, options.artifacts)
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
      const count = options.artifacts.trace.filter((event) =>
        matches(event, {
          tool: grader.tool,
          ...(grader.input_match ? { input_match: grader.input_match } : {}),
        }),
      ).length
      passed = count >= grader.min && count <= grader.max
      evidence = `uses=${count}`
    } else if (grader.type === 'tool_order') {
      const before = options.artifacts.trace.findIndex((event) =>
        matches(event, grader.before),
      )
      const after = options.artifacts.trace.findIndex(
        (event, index) => index > before && matches(event, grader.after),
      )
      passed = before >= 0 && after > before
      evidence = `before=${before},after=${after}`
    } else {
      let count = 0
      for await (const path of glob('**/*', { cwd: options.artifacts.cwd })) {
        if (!minimatch(path, grader.path)) continue
        await containedPath(options.artifacts.cwd, path)
        count += 1
      }
      passed = grader.exists ? count > 0 : count === 0
      evidence = `files=${count}`
    }
    results.push({
      name: grader.name,
      passed,
      weight: grader.weight,
      explanation: passed ? 'passed' : 'failed',
      evidence,
      ...(grader.arm === 'with-only' ? { with_only: true } : {}),
    })
  }
  return results
}
