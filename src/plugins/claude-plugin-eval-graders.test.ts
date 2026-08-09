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
    .mockResolvedValueOnce({ passed: true })
    .mockResolvedValueOnce({ passed: false })
    .mockResolvedValueOnce({ passed: true })
  const result = await gradeClaudePluginEvalRun({
    case: item,
    artifacts: {
      lastMessage: 'done',
      cwd,
      trace: [{ type: 'tool-call', tool: 'Read', input: {} }],
    },
    judge: { vote },
    judgeModel: 'haiku',
  })
  expect(result.score).toBe(1)
  expect(vote).toHaveBeenCalledTimes(3)
})
