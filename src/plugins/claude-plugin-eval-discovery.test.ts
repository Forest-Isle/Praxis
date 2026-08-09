import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'
import { discoverClaudePluginEvals } from './claude-plugin-eval-discovery.js'

const roots: string[] = []
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
)

it('discovers bounded evals cases and applies anchored case/tag filters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-discovery-'))
  roots.push(root)
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(root, '.claude-plugin', 'plugin.json'),
    '{"name":"sample"}',
  )
  for (const [name, tags] of [
    ['alpha', '[fast]'],
    ['alphabet', '[slow]'],
  ] as const) {
    const dir = join(root, 'evals', name)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'case.yaml'),
      `schema_version: "1.0"\nname: ${name}\ntags: ${tags}\nexecution:\n  prompt: x\ngraders:\n  - type: regex\n    name: ok\n    pattern: x\n`,
    )
  }
  const result = await discoverClaudePluginEvals({
    target: root,
    cwd: root,
    configRoot: join(root, 'config'),
    caseGlob: 'alpha',
    tags: ['fast'],
  })
  expect(result.cases.map((item) => item.name)).toEqual(['alpha'])
  expect(result.plugins).toHaveLength(1)
})

it('rejects duplicate output names and non-plugin explicit directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eval-discovery-invalid-'))
  roots.push(root)
  for (const dirName of ['one', 'two']) {
    const dir = join(root, 'evals', dirName)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'case.yaml'),
      `schema_version: "1.0"\nname: duplicate\nexecution:\n  prompt: x\ngraders:\n  - type: regex\n    name: ok\n    pattern: x\n`,
    )
  }
  await expect(
    discoverClaudePluginEvals({
      target: root,
      cwd: root,
      configRoot: join(root, 'config'),
    }),
  ).rejects.toThrow('Duplicate eval case name')

  await rm(join(root, 'evals', 'two'), { recursive: true, force: true })
  const caseFile = join(root, 'evals', 'one', 'case.yaml')
  await mkdir(join(root, 'evals', 'one', 'fixture'))
  await writeFile(
    caseFile,
    `schema_version: "1.0"\nname: unique\nplugins: [fixture]\nexecution:\n  prompt: x\ngraders:\n  - type: regex\n    name: ok\n    pattern: x\n`,
  )
  await expect(
    discoverClaudePluginEvals({
      target: root,
      cwd: root,
      configRoot: join(root, 'config'),
    }),
  ).rejects.toThrow('is not a plugin')
})
