import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'
import { gradeClaudePluginEvalRun } from './claude-plugin-eval-graders.js'
import type { ClaudePluginEvalCase } from './claude-plugin-eval-schema.js'

const roots: string[] = []
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
)

it('scores free graders and three-vote paid graders by weight', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'eval-grade-'))
  roots.push(cwd)
  await writeFile(join(cwd, 'done.txt'), 'yes')
  const item = {
    name: 'case',
    dir: cwd,
    source: 'case_yaml',
    schemaVersion: '1.0',
    tags: [],
    context: { addDirs: [] },
    execution: {
      prompt: 'x',
      maxTurns: 10,
      timeoutSeconds: 30,
      allowedTools: [],
      env: {},
    },
    runs: 1,
    graders: [
      {
        type: 'regex',
        name: 'answer',
        target: 'last_message',
        pattern: 'done',
        flags: '',
        match: 'contains',
        weight: 2,
      },
      {
        type: 'tool_used',
        name: 'read',
        tool: 'Read',
        min: 1,
        max: 1,
        weight: 1,
      },
      {
        type: 'file_exists',
        name: 'file',
        path: '*.txt',
        exists: true,
        weight: 1,
      },
      {
        type: 'llm',
        name: 'judge',
        criteria: 'good',
        focus: 'last_message',
        weight: 2,
      },
    ],
  } satisfies ClaudePluginEvalCase
  const vote = vi
    .fn()
    .mockResolvedValueOnce({ passed: true, costUsd: 0.01 })
    .mockResolvedValueOnce({ passed: false, costUsd: 0.01 })
    .mockResolvedValueOnce({ passed: true, costUsd: 0.01 })
  const result = await gradeClaudePluginEvalRun({
    case: item,
    artifacts: {
      lastMessage: 'done',
      cwd,
      trace: [{ type: 'tool-call', tool: 'Read', input: {} }],
    },
    judge: { vote },
    judgeModel: 'haiku',
    arm: 'with',
  })
  expect(result.score).toBe(1)
  expect(result.judgeCostUsd).toBeCloseTo(0.03)
  expect(vote).toHaveBeenCalledTimes(3)
})

it('scores with-only graders only in the plugin arm', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'eval-grade-arm-'))
  roots.push(cwd)
  const item = {
    name: 'case',
    dir: cwd,
    source: 'case_yaml',
    schemaVersion: '1.0',
    tags: [],
    context: { addDirs: [] },
    execution: {
      prompt: 'x',
      maxTurns: 10,
      timeoutSeconds: 30,
      allowedTools: [],
      env: {},
    },
    runs: 1,
    graders: [
      {
        type: 'regex',
        name: 'plugin-only',
        target: 'last_message',
        pattern: 'plugin',
        flags: '',
        match: 'contains',
        weight: 1,
        arm: 'with-only',
      },
      {
        type: 'regex',
        name: 'common',
        target: 'last_message',
        pattern: 'answer',
        flags: '',
        match: 'contains',
        weight: 1,
      },
    ],
  } satisfies ClaudePluginEvalCase
  const withResult = await gradeClaudePluginEvalRun({
    case: item,
    artifacts: { lastMessage: 'plugin answer', cwd, trace: [] },
    judgeModel: 'haiku',
    arm: 'with',
  })
  const withoutResult = await gradeClaudePluginEvalRun({
    case: item,
    artifacts: { lastMessage: 'answer', cwd, trace: [] },
    judgeModel: 'haiku',
    arm: 'without',
  })
  expect(withResult.score).toBe(1)
  expect(withResult.graders).toHaveLength(2)
  expect(withoutResult.score).toBe(1)
  expect(withoutResult.graders.map((grader) => grader.name)).toEqual(['common'])
})
