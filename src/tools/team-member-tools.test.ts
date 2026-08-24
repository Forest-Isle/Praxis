import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ModelToolCall, ToolRegistry } from '../core/runtime.js'
import { TeamMemberToolRegistry } from './team-member-tools.js'

const base: ToolRegistry = {
  definitions: () =>
    ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Agent'].map((name) => ({
      name,
      description: name,
      inputSchema: {},
    })),
  prepare: async (call) => call,
  execute: async () => ({ content: 'ok', isError: false }),
}

function call(name: string, input: Record<string, unknown>): ModelToolCall {
  return { id: name, name, input }
}

describe('TeamMemberToolRegistry', () => {
  it('filters definitions and rejects bypass paths and read-only mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-team-tools-'))
    await writeFile(join(cwd, 'file.txt'), 'ok')
    try {
      const registry = new TeamMemberToolRegistry({
        base,
        access: 'read-only',
        cwd,
      })
      expect(registry.definitions().map((entry) => entry.name)).toEqual([
        'Read',
        'Glob',
        'Grep',
        'Bash',
      ])
      await expect(
        registry.execute(call('Agent', {}), { cwd }),
      ).rejects.toThrow(/unavailable/u)
      await expect(
        registry.execute(call('Read', { file_path: '../outside' }), { cwd }),
      ).rejects.toThrow(/outside/u)
      await expect(
        registry.execute(call('Bash', { command: 'rm file.txt' }), { cwd }),
      ).rejects.toThrow(/read-only/u)
      await expect(
        registry.execute(call('Bash', { command: 'head /etc/passwd' }), {
          cwd,
        }),
      ).rejects.toThrow(/outside|denied|approval/u)
      await expect(
        registry.execute(call('Bash', { command: 'cd .. && ls' }), { cwd }),
      ).rejects.toThrow(/read-only|outside|denied|approval/u)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('keeps write members from using dangerous git operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-team-tools-'))
    try {
      const registry = new TeamMemberToolRegistry({
        base,
        access: 'write',
        cwd,
      })
      await expect(
        registry.execute(call('Bash', { command: 'git push' }), { cwd }),
      ).rejects.toThrow(/git operation/u)
      await expect(
        registry.execute(call('Bash', { command: 'git commit -am changes' }), {
          cwd,
        }),
      ).rejects.toThrow(/git operation/u)
      await expect(
        registry.execute(call('Bash', { command: 'command git push' }), {
          cwd,
        }),
      ).rejects.toThrow(/git operation/u)
      await expect(
        registry.execute(call('Bash', { command: 'sudo git push' }), { cwd }),
      ).rejects.toThrow(/wrapper|denied/u)
      await expect(
        registry.execute(
          call('Bash', { command: 'find . -exec git push \\;' }),
          {
            cwd,
          },
        ),
      ).rejects.toThrow(/find|git operation/u)
      await expect(
        registry.execute(call('Bash', { command: 'bash -c "git push"' }), {
          cwd,
        }),
      ).rejects.toThrow(/interpreter|denied/u)
      await expect(
        registry.execute(call('Bash', { command: 'xargs git push' }), { cwd }),
      ).rejects.toThrow(/wrapper|denied/u)
      await expect(
        registry.execute(call('Bash', { command: 'node --eval "git push"' }), {
          cwd,
        }),
      ).rejects.toThrow(/interpreter|denied/u)
      await expect(
        registry.execute(call('Bash', { command: 'git status' }), { cwd }),
      ).resolves.toMatchObject({ isError: false })
      await expect(
        registry.execute(call('Bash', { command: 'npm test' }), { cwd }),
      ).resolves.toMatchObject({ isError: false })
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('revalidates prepared calls, cwd, symlinks, and sandbox overrides', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-team-tools-'))
    const outside = await mkdtemp(join(tmpdir(), 'praxis-team-outside-'))
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(cwd, 'escape'))
    try {
      const registry = new TeamMemberToolRegistry({
        base: {
          ...base,
          prepare: async () => call('Bash', { command: 'git push' }),
        },
        access: 'write',
        cwd,
      })
      await expect(
        registry.prepare(call('Bash', { command: 'git status' }), { cwd }),
      ).rejects.toThrow(/git operation/u)
      await expect(
        registry.execute(call('Read', { file_path: 'escape/secret.txt' }), {
          cwd,
        }),
      ).rejects.toThrow(/outside/u)
      await expect(
        registry.execute(call('Read', { file_path: 'file.txt' }), {
          cwd: outside,
        }),
      ).rejects.toThrow(/cwd|workspace/u)
      await expect(
        registry.execute(
          call('Bash', {
            command: 'git status',
            dangerouslyDisableSandbox: true,
          }),
          { cwd },
        ),
      ).rejects.toThrow(/dangerouslyDisableSandbox/u)
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})
