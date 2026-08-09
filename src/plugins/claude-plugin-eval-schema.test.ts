import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadClaudePluginEvalCase } from './claude-plugin-eval-schema.js'

const roots: string[] = []
async function root() {
  const value = await mkdtemp(join(tmpdir(), 'eval-schema-'))
  roots.push(value)
  return value
}
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  ),
)

describe('loadClaudePluginEvalCase', () => {
  it('loads strict case.yaml defaults and Skill with-only grading', async () => {
    const dir = await root()
    await writeFile(
      join(dir, 'case.yaml'),
      `schema_version: "1.0"\nname: reads\nexecution:\n  prompt: inspect\ngraders:\n  - type: tool_used\n    name: read-used\n    tool: Skill\n`,
    )
    const loaded = await loadClaudePluginEvalCase(dir)
    expect(loaded).toMatchObject({
      name: 'reads',
      runs: 3,
      source: 'case_yaml',
      execution: { maxTurns: 10, timeoutSeconds: 300 },
      graders: [{ arm: 'with-only' }],
    })
  })

  it('overlays prose on yaml and maps grader bodies', async () => {
    const dir = await root()
    await mkdir(join(dir, 'graders'))
    await writeFile(
      join(dir, 'case.yaml'),
      `schema_version: "1.0"\nname: old\nexecution:\n  prompt: old\ngraders:\n  - type: file_exists\n    name: output\n    path: out.txt\n`,
    )
    await writeFile(
      join(dir, 'prompt.md'),
      `---\nname: mixed\nruns: 2\n---\nnew prompt\n`,
    )
    await writeFile(
      join(dir, 'graders', 'answer.md'),
      `---\ntype: regex\n---\nfinished\n`,
    )
    const loaded = await loadClaudePluginEvalCase(dir)
    expect(loaded.source).toBe('mixed')
    expect(loaded.name).toBe('mixed')
    expect(loaded.execution.prompt).toBe('new prompt')
    expect(loaded.graders).toHaveLength(2)
  })

  it('rejects unknown keys and unsafe environment names', async () => {
    const dir = await root()
    await writeFile(
      join(dir, 'case.yaml'),
      `schema_version: "1.0"\nname: bad\nunknown: true\nexecution:\n  prompt: x\n  env:\n    SECRET: nope\ngraders:\n  - type: regex\n    name: x\n    pattern: x\n`,
    )
    await expect(loadClaudePluginEvalCase(dir)).rejects.toThrow('unknown field')
  })

  it('rejects unsafe names and every file-bearing traversal path', async () => {
    const fields = [
      'name: ../../escape',
      'context:\n  history_file: ../history.jsonl',
      'context:\n  scaffold_script: /tmp/setup.sh',
      'context:\n  add_dirs: [../outside]',
    ]
    for (const field of fields) {
      const dir = await root()
      await writeFile(
        join(dir, 'case.yaml'),
        `schema_version: "1.0"\nname: safe\n${field}\nexecution:\n  prompt: x\ngraders:\n  - type: regex\n    name: ok\n    pattern: x\n`,
      )
      await expect(loadClaudePluginEvalCase(dir)).rejects.toThrow()
    }
  })

  it('bounds inline graders and nested input_match objects', async () => {
    const tooMany = await root()
    const graders = Array.from(
      { length: 257 },
      (_, index) => `  - type: regex\n    name: g-${index}\n    pattern: x`,
    ).join('\n')
    await writeFile(
      join(tooMany, 'case.yaml'),
      `schema_version: "1.0"\nname: bounded\nexecution:\n  prompt: x\ngraders:\n${graders}\n`,
    )
    await expect(loadClaudePluginEvalCase(tooMany)).rejects.toThrow(
      'oversized array',
    )

    const tooDeep = await root()
    const nested = `${Array.from(
      { length: 18 },
      (_, index) => `${' '.repeat(6 + index * 2)}child${index}:`,
    ).join('\n')}\n${' '.repeat(42)}value: x`
    await writeFile(
      join(tooDeep, 'case.yaml'),
      `schema_version: "1.0"\nname: bounded\nexecution:\n  prompt: x\ngraders:\n  - type: tool_used\n    name: tool\n    tool: Read\n    input_match:\n${nested}`,
    )
    await expect(loadClaudePluginEvalCase(tooDeep)).rejects.toThrow('depth')
  })
})
