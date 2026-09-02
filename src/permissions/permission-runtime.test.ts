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
  autoModePermissionOutcome,
  type PermissionBehavior,
  type ModelProvider,
  type PermissionUpdate,
  permissionDecisionSource,
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

const exactRule = (filePath: string) => `/${filePath.replaceAll('\\', '/')}`

describe('permission update runtime integration', () => {
  it('resolves ApplyPatch batches with rule, mode, and target precedence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-apply-permission-'))
    const call = (filePath = join(cwd, 'file.txt')) => ({
      id: 'apply',
      name: 'ApplyPatch',
      input: {
        edits: [{ file_path: filePath, old_string: 'old', new_string: 'new' }],
      },
    })
    const update = (
      toolName: 'ApplyPatch' | 'Edit',
      behavior: PermissionBehavior,
      ruleContent = '',
    ): PermissionUpdate => ({
      type: 'addRules',
      rules: [{ toolName, ruleContent }],
      behavior,
      destination: 'session',
    })
    const resolveCall = (
      permissionMode: ConstructorParameters<
        typeof ClaudePermissionResolver
      >[0]['permissionMode'],
      permissionUpdates: PermissionUpdate[] = [],
      filePath = join(cwd, 'file.txt'),
    ) =>
      new ClaudePermissionResolver({
        cwd,
        settings: [],
        ...(permissionMode ? { permissionMode } : {}),
      }).resolve(call(filePath), { cwd, permissionUpdates })

    await expect(resolveCall('default')).resolves.toMatchObject({
      behavior: 'ask',
    })
    await expect(
      resolveCall('default', [update('ApplyPatch', 'allow')]),
    ).resolves.toMatchObject({ behavior: 'allow' })
    await expect(
      resolveCall('default', [update('Edit', 'allow')]),
    ).resolves.toMatchObject({ behavior: 'allow' })
    await expect(
      resolveCall('default', [
        update('ApplyPatch', 'allow', exactRule(join(cwd, 'file.txt'))),
      ]),
    ).resolves.toMatchObject({ behavior: 'allow' })
    await expect(
      resolveCall('default', [
        update('Edit', 'allow', exactRule(join(cwd, 'file.txt'))),
      ]),
    ).resolves.toMatchObject({ behavior: 'allow' })
    await expect(
      resolveCall('default', [
        update('ApplyPatch', 'ask'),
        update('Edit', 'allow'),
      ]),
    ).resolves.toMatchObject({ behavior: 'ask' })
    await expect(
      resolveCall('default', [
        update('Edit', 'ask'),
        update('ApplyPatch', 'allow'),
      ]),
    ).resolves.toMatchObject({ behavior: 'ask' })
    await expect(
      resolveCall('default', [
        update('ApplyPatch', 'deny'),
        update('Edit', 'allow'),
      ]),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      resolveCall('plan', [update('ApplyPatch', 'allow')]),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(
      resolveCall('plan', [update('Edit', 'allow')]),
    ).resolves.toMatchObject({ behavior: 'deny' })
    await expect(resolveCall('dontAsk')).resolves.toMatchObject({
      behavior: 'deny',
    })
    await expect(resolveCall('acceptEdits')).resolves.toMatchObject({
      behavior: 'allow',
    })
    await expect(resolveCall('bypassPermissions')).resolves.toMatchObject({
      behavior: 'allow',
    })

    const deniedTarget = join(cwd, 'denied.txt')
    await expect(
      new ClaudePermissionResolver({ cwd, settings: [] }).resolve(
        {
          id: 'apply-mixed',
          name: 'ApplyPatch',
          input: {
            edits: [
              {
                file_path: join(cwd, 'allowed.txt'),
                old_string: 'old',
                new_string: 'new',
              },
              {
                file_path: deniedTarget,
                old_string: 'old',
                new_string: 'new',
              },
            ],
          },
        },
        {
          cwd,
          permissionUpdates: [
            update('ApplyPatch', 'allow'),
            update('Edit', 'deny', exactRule(deniedTarget)),
          ],
        },
      ),
    ).resolves.toMatchObject({
      behavior: 'deny',
      reason: `Denied by Claude permission rule Edit(${exactRule(deniedTarget)})`,
    })
  })

  it('aggregates outside-directory suggestions across ApplyPatch targets', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-apply-suggestions-'))
    const firstOutside = await mkdtemp(
      join(tmpdir(), 'praxis-apply-first-outside-'),
    )
    const secondOutside = await mkdtemp(
      join(tmpdir(), 'praxis-apply-second-outside-'),
    )
    const decision = await new ClaudePermissionResolver({
      cwd,
      settings: [],
    }).resolve(
      {
        id: 'apply-outside',
        name: 'ApplyPatch',
        input: {
          edits: [
            {
              file_path: join(firstOutside, 'first.txt'),
              old_string: 'old',
              new_string: 'new',
            },
            {
              file_path: join(secondOutside, 'second.txt'),
              old_string: 'old',
              new_string: 'new',
            },
          ],
        },
      },
      { cwd },
    )
    const suggestedDirectories =
      decision.behavior === 'ask'
        ? (decision.suggestions ?? []).flatMap((suggestion) =>
            suggestion.type === 'addDirectories' ? suggestion.directories : [],
          )
        : []

    expect(decision).toMatchObject({
      behavior: 'ask',
      reason: 'Path is outside allowed working directories',
    })
    expect(new Set(suggestedDirectories)).toEqual(
      new Set([firstOutside, secondOutside]),
    )
  })

  it('denies ApplyPatch when the auto classifier is unavailable', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'praxis-apply-auto-'))
    const decision = await new ClaudePermissionResolver({
      cwd,
      settings: [],
      permissionMode: 'auto',
      autoClassifier: async () => {
        throw new Error('classifier unavailable')
      },
    }).resolve(
      {
        id: 'apply-auto',
        name: 'ApplyPatch',
        input: {
          edits: [
            {
              file_path: join(cwd, 'file.txt'),
              old_string: 'old',
              new_string: 'new',
            },
          ],
        },
      },
      { cwd },
    )

    expect(decision).toEqual({
      behavior: 'deny',
      reason: 'Auto mode classifier failed: classifier unavailable',
    })
    expect(permissionDecisionSource(decision)).toBe('auto-classifier')
    expect(autoModePermissionOutcome(decision)).toBe('unavailable')
  })

  it('retains indexed original ApplyPatch paths for outside-root safety', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-apply-original-'))
    const outside = await mkdtemp(join(tmpdir(), 'praxis-apply-outside-'))
    const linked = join(outside, 'linked.txt')
    const inside = join(root, 'inside.txt')
    await writeFile(inside, 'old')
    await symlink(inside, linked)
    const resolver = new ClaudePermissionResolver({ cwd: root, settings: [] })
    await expect(
      resolver.resolve(
        {
          id: 'apply',
          name: 'ApplyPatch',
          input: {
            edits: [
              { file_path: inside, old_string: 'old', new_string: 'new' },
            ],
          },
        },
        {
          cwd: root,
          originalCall: {
            id: 'original',
            name: 'ApplyPatch',
            input: {
              edits: [
                { file_path: linked, old_string: 'old', new_string: 'new' },
              ],
            },
          },
        },
      ),
    ).resolves.toMatchObject({
      behavior: 'ask',
      reason: 'Path is outside allowed working directories',
    })
  })

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
