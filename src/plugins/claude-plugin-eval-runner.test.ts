import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import {
  resolveEvalAllowedTools,
  runClaudePluginEvalOnce,
} from './claude-plugin-eval-runner.js'
import type { ClaudePluginEvalCase } from './claude-plugin-eval-schema.js'

const roots: string[] = []
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
)

function evalCase(dir: string): ClaudePluginEvalCase {
  return {
    schemaVersion: '1.0',
    name: 'case',
    tags: [],
    context: { addDirs: [] },
    execution: {
      prompt: 'run',
      maxTurns: 3,
      timeoutSeconds: 2,
      allowedTools: [],
      env: { EVAL_MARKER: 'isolated' },
    },
    runs: 1,
    graders: [
      {
        type: 'regex',
        name: 'ok',
        target: 'last_message',
        pattern: 'ok',
        flags: '',
        match: 'contains',
        weight: 1,
      },
    ],
    dir,
    source: 'case_yaml',
  }
}

it('requires operator grants for gated case tools', () => {
  expect(() => resolveEvalAllowedTools(['Bash(npm test:*)'], [])).toThrow(
    '--allow-tools',
  )
  expect(
    resolveEvalAllowedTools(['Read', 'Bash(npm test:*)'], ['Bash']),
  ).toEqual(['Read', 'Bash(npm test:*)'])
  expect(
    resolveEvalAllowedTools(['Bash(npm test:unit)'], ['Bash(npm test:*)']),
  ).toEqual(['Bash(npm test:unit)'])
  expect(resolveEvalAllowedTools(['mcp__fixture__read'], ['mcp__*'])).toEqual([
    'mcp__fixture__read',
  ])
  expect(resolveEvalAllowedTools([], [])).toContain('Read')
})

it('passes isolated paths, history, environment, and trace to the runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-runner-test-'))
  roots.push(root)
  const history = join(root, 'history.jsonl')
  await writeFile(history, '{}\n')
  const item = evalCase(root)
  item.context = { ...item.context, historyFile: 'history.jsonl' }
  const create = vi.fn(async (options) => ({
    run: async () => {
      options.eventSink({
        type: 'tool-call',
        call: { id: '1', name: 'Read', input: { file_path: 'x' } },
      })
      return { text: 'ok', turns: 1, costUsd: 0.1 }
    },
  }))
  const result = await runClaudePluginEvalOnce({
    case: item,
    factory: { create },
    pluginDirectories: [],
    scaffold: false,
  })
  expect(result.error).toBeNull()
  expect(result.artifacts.trace).toMatchObject([
    { type: 'tool-call', tool: 'Read' },
  ])
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      historyFile: await realpath(history),
      env: { EVAL_MARKER: 'isolated' },
    }),
  )
  await expect(stat(result.tracePath)).resolves.toBeDefined()
  if (result.tempRoot) roots.push(result.tempRoot)
})

it('reports scaffold failures without starting the runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-scaffold-test-'))
  roots.push(root)
  await writeFile(
    join(root, 'setup.sh'),
    '#!/bin/bash\necho failed >&2\nexit 7\n',
  )
  const item = evalCase(root)
  item.context = { ...item.context, scaffoldScript: 'setup.sh' }
  const create = vi.fn()
  const result = await runClaudePluginEvalOnce({
    case: item,
    factory: { create },
    pluginDirectories: [],
    scaffold: true,
  })
  expect(result.error).toContain('Scaffold failed (7): failed')
  expect(create).not.toHaveBeenCalled()
  if (result.tempRoot) roots.push(result.tempRoot)
})
