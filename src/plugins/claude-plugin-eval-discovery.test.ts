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
