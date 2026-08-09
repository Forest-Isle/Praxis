import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'
import {
  initClaudePluginEval,
  runClaudePluginEval,
  type EvalRunReport,
} from './claude-plugin-eval.js'

const roots: string[] = []
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
)

it('runs real orchestration through injected ephemeral runtime and writes aggregate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-run-'))
  roots.push(root)
  const evalDir = join(root, 'evals', 'case')
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(evalDir, { recursive: true }),
  )
  await writeFile(
    join(evalDir, 'case.yaml'),
    `schema_version: "1.0"\nname: case\nruns: 1\nexecution:\n  prompt: finish\ngraders:\n  - type: regex\n    name: answer\n    pattern: finished\n`,
  )
  const created: string[] = []
  const result = await runClaudePluginEval({
    target: root,
    cwd: root,
    configRoot: join(root, 'config'),
    allowTools: [],
    json: true,
    judgeModel: 'haiku',
    keepTemp: false,
    scaffold: false,
    tags: [],
    threshold: 1,
    verbose: false,
    outputDir: 'results',
    dependencies: {
      runtimeFactory: {
        create: async (options) => {
          created.push(options.cwd)
          return {
            run: async () => ({ text: 'finished', turns: 1, costUsd: 0.01 }),
          }
        },
      },
      claudeVersion: '2.1.208',
    },
  })
  expect(result.code).toBe(0)
  expect((result.aggregate.cases as { score: number }[])[0]?.score).toBe(1)
  expect(
    JSON.parse(
      await readFile(join(root, 'results', 'aggregate-result.json'), 'utf8'),
    ).claude_version,
  ).toBe('2.1.208')
  const createdRoot = created[0]
  expect(createdRoot).toBeDefined()
  await expect(stat(createdRoot as string)).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

it('writes exact bare init templates and refuses overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-init-'))
  roots.push(root)
  await expect(
    initClaudePluginEval({
      cwd: root,
      name: 'sample',
      bare: true,
      interactive: false,
      isTTY: false,
    }),
  ).resolves.toBe(0)
  expect(
    await readFile(join(root, 'evals', 'sample', 'prompt.md'), 'utf8'),
  ).toContain('allowed_tools: [Read, Glob, Grep, Skill]')
  await expect(
    initClaudePluginEval({
      cwd: root,
      name: 'sample',
      bare: true,
      interactive: false,
      isTTY: false,
    }),
  ).rejects.toThrow('already exists')
})

it('accounts for judge cost and stops with a partial report at the run ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-budget-'))
  roots.push(root)
  const evalDir = join(root, 'evals', 'budget')
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(evalDir, { recursive: true }),
  )
  await writeFile(
    join(evalDir, 'case.yaml'),
    `schema_version: "1.0"\nname: budget\nruns: 2\nexecution:\n  prompt: finish\ngraders:\n  - type: llm\n    name: judge\n    criteria: correct\n`,
  )
  const vote = vi.fn(async () => ({ passed: true, costUsd: 0.01 }))
  const created: string[] = []
  const result = await runClaudePluginEval({
    target: root,
    cwd: root,
    configRoot: join(root, 'config'),
    allowTools: [],
    json: true,
    judgeModel: 'haiku',
    keepTemp: false,
    maxCostUsd: 0.1,
    scaffold: false,
    tags: [],
    threshold: 1,
    verbose: false,
    outputDir: 'results',
    dependencies: {
      runtimeFactory: {
        create: async (options) => {
          created.push(options.cwd)
          return {
            run: async () => ({ text: 'finished', turns: 1, costUsd: 0.08 }),
          }
        },
      },
      judge: { vote },
    },
  })
  expect(result.code).toBe(2)
  expect(result.aggregate).toMatchObject({
    partial: true,
    partial_reason: 'cost_ceiling',
    cost_usd: 0.11,
  })
  const report = (result.aggregate.cases as { runs: EvalRunReport[] }[])[0]
  expect(report?.runs).toHaveLength(1)
  expect(report?.runs[0]?.judge_cost_usd).toBeCloseTo(0.03)
  expect(vote).toHaveBeenCalledTimes(3)
  await expect(stat(created[0] as string)).rejects.toMatchObject({
    code: 'ENOENT',
  })

  const unknownCost = await runClaudePluginEval({
    target: root,
    cwd: root,
    configRoot: join(root, 'config'),
    allowTools: [],
    json: true,
    judgeModel: 'haiku',
    keepTemp: false,
    maxCostUsd: 1,
    runs: 1,
    scaffold: false,
    tags: [],
    threshold: 1,
    verbose: false,
    outputDir: 'unknown-cost-results',
    dependencies: {
      runtimeFactory: {
        create: async () => ({
          run: async () => ({ text: 'finished', turns: 1 }),
        }),
      },
      judge: { vote },
    },
  })
  expect(unknownCost.code).toBe(1)
  expect(
    (unknownCost.aggregate.cases as { runs: EvalRunReport[] }[])[0]?.runs[0]
      ?.error,
  ).toContain('Cannot enforce --max-cost-usd')
})

it('writes interrupt results and cleans failed run directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-interrupt-'))
  roots.push(root)
  const evalDir = join(root, 'evals', 'interrupted')
  await import('node:fs/promises').then(({ mkdir }) =>
    mkdir(evalDir, { recursive: true }),
  )
  await writeFile(
    join(evalDir, 'case.yaml'),
    `schema_version: "1.0"\nname: interrupted\nexecution:\n  prompt: finish\ngraders:\n  - type: regex\n    name: answer\n    pattern: finished\n`,
  )
  const controller = new AbortController()
  let created = ''
  const result = await runClaudePluginEval({
    target: root,
    cwd: root,
    configRoot: join(root, 'config'),
    allowTools: [],
    json: true,
    judgeModel: 'haiku',
    keepTemp: false,
    scaffold: false,
    tags: [],
    threshold: 1,
    verbose: false,
    outputDir: 'results',
    signal: controller.signal,
    dependencies: {
      runtimeFactory: {
        create: async (options) => {
          created = options.cwd
          return {
            run: async () => {
              controller.abort()
              throw new DOMException('cancelled', 'AbortError')
            },
          }
        },
      },
    },
  })
  expect(result.code).toBe(130)
  expect(result.aggregate).toMatchObject({
    partial: true,
    partial_reason: 'interrupted',
  })
  expect(
    (result.aggregate.cases as { runs: EvalRunReport[] }[])[0]?.runs[0]?.error,
  ).toBe('Eval run interrupted')
  await expect(stat(created)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(
    stat(join(root, 'results', 'aggregate-result.json')),
  ).resolves.toBeDefined()
})
