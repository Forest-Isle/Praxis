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
  it('allows ToolSearch by default without approval', async () => {
    let approvals = 0
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [
          {
            name: 'ToolSearch',
            description: 'Search deferred tools',
            inputSchema: { type: 'object' },
          },
        ],
        prepare: async (call) => call,
        execute: async () => ({ content: 'searched', isError: false }),
      },
      permissions: new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
      }),
    })

    await expect(
      runtime.executeDirectToolCall(
        { id: 'tool-search', name: 'ToolSearch', input: { query: 'mcp' } },
        {
          cwd: '/workspace',
          observer,
          approveTool() {
            approvals += 1
            return true
          },
        },
      ),
    ).resolves.toMatchObject({ content: 'searched', isError: false })
    expect(approvals).toBe(0)
  })

  it('allows read-only tool metadata by default while preserving rule precedence', async () => {
    const toolName = 'mcp__fixture__read'
    let executions = 0
    const runtime = new AgentRuntime(provider, undefined, {
      tools: {
        definitions: () => [
          {
            name: toolName,
            description: 'Read-only fixture tool',
            inputSchema: { type: 'object' },
          },
        ],
        prepare: async (call, context) => {
          if (call.name === toolName) {
            context.toolPermission = { readOnly: true }
          }
          return call
        },
        execute: async () => {
          executions += 1
          return { content: 'read', isError: false }
        },
      },
      permissions: new ClaudePermissionResolver({
        cwd: '/workspace',
        settings: [],
      }),
    })

    await expect(
      runtime.executeDirectToolCall(
        { id: 'read-default', name: toolName, input: {} },
        {
          cwd: '/workspace',
          observer,
          approveTool() {
            throw new Error('read-only default should not ask')
          },
        },
      ),
    ).resolves.toMatchObject({ content: 'read', isError: false })
    expect(executions).toBe(1)

    let approvals = 0
    await expect(
      runtime.executeDirectToolCall(
        { id: 'read-ask', name: toolName, input: {} },
        {
          cwd: '/workspace',
          observer,
          permissionUpdates: [
            {
              type: 'addRules',
              rules: [{ toolName, ruleContent: '' }],
              behavior: 'ask',
              destination: 'session',
            },
          ],
          approveTool() {
            approvals += 1
            return true
          },
        },
      ),
    ).resolves.toMatchObject({ content: 'read', isError: false })
    expect(approvals).toBe(1)
    expect(executions).toBe(2)

    await expect(
      runtime.executeDirectToolCall(
        { id: 'read-deny', name: toolName, input: {} },
        {
          cwd: '/workspace',
          observer,
          permissionUpdates: [
            {
              type: 'addRules',
              rules: [{ toolName, ruleContent: '' }],
              behavior: 'deny',
              destination: 'session',
            },
          ],
          approveTool() {
            throw new Error('denied read-only tool should not ask')
          },
        },
      ),
    ).resolves.toMatchObject({ isError: true })
    expect(executions).toBe(2)

    await expect(
      runtime.executeDirectToolCall(
        { id: 'unknown', name: 'mcp__fixture__unknown', input: {} },
        {
          cwd: '/workspace',
          observer,
          approveTool() {
            throw new Error('unknown tool should not ask')
          },
        },
      ),
    ).resolves.toMatchObject({ isError: true })
    expect(executions).toBe(2)
  })

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
        suggestions: expect.arrayContaining([
          expect.objectContaining({
            type: 'addRules',
            rules: [
              {
                toolName: 'Read',
                ruleContent: `/${linked.replaceAll('\\', '/')}/**`,
              },
            ],
          }),
          expect.objectContaining({
            type: 'addRules',
            rules: [
              {
                toolName: 'Read',
                ruleContent: `/${(await realpath(outside)).replaceAll('\\', '/')}/**`,
              },
            ],
          }),
        ]),
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
    const readRules = updates.filter((update) => update.type === 'addRules')
    expect(readRules).toHaveLength(new Set([outside, canonicalOutside]).size)
    expect(readRules).toEqual(
      expect.arrayContaining(
        [outside, canonicalOutside].map((directory) => ({
          type: 'addRules',
          rules: [{ toolName: 'Read', ruleContent: `/${directory}/**` }],
          behavior: 'allow',
          destination: 'session',
        })),
      ),
    )

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
      directories: [...new Set([outside, canonicalOutside])],
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
