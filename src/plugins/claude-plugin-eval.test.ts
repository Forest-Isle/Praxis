import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'
import {
  initClaudePluginEval,
  runClaudePluginEval,
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
