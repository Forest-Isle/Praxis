import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AgentRuntime,
  type ModelProvider,
  type PermissionUpdate,
} from '../core/runtime.js'
import { LocalToolRegistry } from '../tools/local-tools.js'
import { ClaudePermissionResolver } from './claude-permission-resolver.js'

const provider: ModelProvider = {
  capabilities: { streaming: true, usage: true, tools: true },
  async *complete() {},
}

const observer = {
  async assistantCompleted() {},
  async toolCompleted() {},
}

describe('permission update runtime integration', () => {
  it('prompts for a workspace symlink that resolves outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-permission-symlink-'))
    const cwd = join(root, 'workspace')
    const outside = join(root, 'outside')
    await Promise.all([mkdir(cwd), mkdir(outside)])
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const linked = join(cwd, 'linked')
    await symlink(outside, linked)
    const decisions: unknown[] = []
    const runtime = new AgentRuntime(provider, undefined, {
      tools: new LocalToolRegistry({ cwd }),
      permissions: new ClaudePermissionResolver({ cwd, settings: [] }),
    })

    const result = await runtime.executeDirectToolCall(
      {
        id: 'glob-symlink',
        name: 'Glob',
        input: { path: linked, pattern: '*.txt' },
      },
      {
        cwd,
        observer,
        approveTool(_call, _original, decision) {
          decisions.push(decision)
          return true
        },
      },
    )

    expect(decisions).toEqual([
      expect.objectContaining({
        behavior: 'ask',
        reason: 'Path is outside allowed working directories',
      }),
    ])
    expect(result).toMatchObject({ isError: false })
    expect(result.content).toContain(join(linked, 'secret.txt'))
  })

  it('grants an outside directory for the current and later file calls', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-permission-runtime-'))
    const cwd = join(root, 'workspace')
    const outside = join(root, 'shared')
    await Promise.all([mkdir(cwd), mkdir(outside)])
    await writeFile(join(outside, 'input.txt'), 'outside')
    const updates: PermissionUpdate[] = []
    const runtime = new AgentRuntime(provider, undefined, {
      tools: new LocalToolRegistry({ cwd }),
      permissions: new ClaudePermissionResolver({ cwd, settings: [] }),
    })

    const read = await runtime.executeDirectToolCall(
      {
        id: 'read-outside',
        name: 'Read',
        input: { file_path: join(outside, 'input.txt') },
      },
      {
        cwd,
        observer,
        approveTool: (_call, _original, decision) => ({
          behavior: 'allow',
          updatedPermissions:
            decision?.behavior === 'ask' ? (decision.suggestions ?? []) : [],
        }),
        onPermissionUpdates(items) {
          updates.push(...items)
        },
      },
    )
    expect(read).toMatchObject({ content: '1\toutside', isError: false })
    const canonicalOutside = await realpath(outside)
    expect(updates).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Read', ruleContent: `/${canonicalOutside}/**` }],
        behavior: 'allow',
        destination: 'session',
      },
    ])

    const firstWrite = await runtime.executeDirectToolCall(
      {
        id: 'write-outside',
        name: 'Write',
        input: { file_path: join(outside, 'first.txt'), content: 'first' },
      },
      {
        cwd,
        observer,
        permissionUpdates: updates,
        approveTool: (_call, _original, decision) => ({
          behavior: 'allow',
          updatedPermissions:
            decision?.behavior === 'ask' ? (decision.suggestions ?? []) : [],
        }),
        onPermissionUpdates(items) {
          updates.push(...items)
        },
      },
    )
    expect(firstWrite.isError).toBe(false)
    expect(updates).toContainEqual({
      type: 'addDirectories',
      directories: [canonicalOutside],
      destination: 'session',
    })

    const secondWrite = await runtime.executeDirectToolCall(
      {
        id: 'write-later',
        name: 'Write',
        input: { file_path: join(outside, 'later.txt'), content: 'later' },
      },
      {
        cwd,
        observer,
        permissionUpdates: updates,
        approveTool() {
          throw new Error('session directory approval should be reused')
        },
      },
    )
    expect(secondWrite.isError).toBe(false)
    await expect(readFile(join(outside, 'later.txt'), 'utf8')).resolves.toBe(
      'later',
    )
  })
})
