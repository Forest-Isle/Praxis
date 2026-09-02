import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PermissionResolver, ToolRegistry } from '../core/runtime.js'
import {
  ClaudeInteractiveToolManager,
  type ClaudePlanApprovalResult,
  type ClaudeQuestion,
} from './claude-interactive-tools.js'

const roots: string[] = []
const sessionId = '85858585-8585-4585-8585-858585858585'

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const base: ToolRegistry = {
  definitions: () => [
    {
      name: 'Read',
      description: 'read',
      inputSchema: { type: 'object' },
    },
  ],
  prepare: async (call) => call,
  execute: async () => ({ content: 'base', isError: false }),
  schedulingPolicy: () => ({ concurrency: 'concurrent' }),
}

async function fixture(
  options: {
    approve?: boolean
    initialMode?: 'default' | 'bypassPermissions'
    askForBash?: boolean
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-interactive-tools-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  await mkdir(configRoot)
  const askUser = vi.fn(async (questions: readonly ClaudeQuestion[]) => ({
    answers: { [questions[0]?.question ?? 'missing']: 'Option A' },
  }))
  const approvePlan = vi.fn(async (): Promise<ClaudePlanApprovalResult> =>
    options.approve === false
      ? ({ behavior: 'deny' } as const)
      : ({ behavior: 'allow', permissionMode: 'default' } as const),
  )
  const permissionResolverForMode = vi.fn(
    (mode: string): PermissionResolver => ({
      resolve: (call) =>
        mode === 'plan' && ['Write', 'ApplyPatch'].includes(call.name)
          ? { behavior: 'deny', reason: 'plan mode' }
          : options.askForBash && call.name === 'Bash'
            ? { behavior: 'ask' }
            : { behavior: 'allow' },
    }),
  )
  const manager = new ClaudeInteractiveToolManager({
    configRoot,
    initialMode: options.initialMode ?? 'default',
    enabledTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
    callbacks: { askUser, approvePlan },
    permissionResolverForMode,
  })
  return {
    configRoot,
    manager,
    registry: manager.registry(base, sessionId),
    askUser,
    approvePlan,
  }
}

async function execute(
  registry: ToolRegistry,
  name: string,
  input: Record<string, unknown>,
) {
  const call = { id: `call_${name}`, name, input }
  return registry.execute(call, { cwd: '/tmp' })
}

describe('ClaudeInteractiveToolManager', () => {
  it('exposes the interactive-only Claude schemas and collects answers', async () => {
    const { registry, askUser } = await fixture()
    expect(registry.definitions().map(({ name }) => name)).toEqual([
      'Read',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
    ])
    expect(
      registry.schedulingPolicy?.({
        id: 'ask-policy',
        name: 'AskUserQuestion',
        input: {},
      }),
    ).toMatchObject({ concurrency: 'exclusive' })
    expect(
      registry.schedulingPolicy?.({ id: 'read', name: 'Read', input: {} }),
    ).toEqual({ concurrency: 'concurrent' })
    expect(
      registry.definitions().find(({ name }) => name === 'AskUserQuestion')
        ?.inputSchema,
    ).toMatchObject({
      properties: {
        questions: {
          minItems: 1,
          maxItems: 4,
          items: { required: ['question', 'header', 'options', 'multiSelect'] },
        },
      },
      required: ['questions'],
      additionalProperties: false,
    })
    const result = await execute(registry, 'AskUserQuestion', {
      questions: [
        {
          question: 'Which option?',
          header: 'Choice',
          options: [
            { label: 'Option A', description: 'First' },
            { label: 'Option B', description: 'Second' },
          ],
          multiSelect: false,
        },
      ],
    })
    expect(result).toEqual({
      content: JSON.stringify({ answers: { 'Which option?': 'Option A' } }),
      isError: false,
    })
    expect(askUser).toHaveBeenCalledOnce()
  })

  it('enters plan mode, allows only its plan file, and exits after approval', async () => {
    const { configRoot, manager, registry, approvePlan } = await fixture()
    const planPath = join(configRoot, 'plans', `praxis-${sessionId}.md`)

    await expect(execute(registry, 'EnterPlanMode', {})).resolves.toEqual({
      content: expect.stringContaining(planPath),
      isError: false,
    })
    expect(manager.consumeTransition('call_EnterPlanMode')).toBe('plan')
    expect(manager.contextMessage(sessionId)).toContain(planPath)
    await expect(manager.isPlanFile(sessionId, planPath)).resolves.toBe(true)
    await expect(
      manager.isPlanFile(sessionId, join(configRoot, 'project.ts')),
    ).resolves.toBe(false)
    expect(
      await manager.permissions(sessionId).resolve({
        id: 'plan-write',
        name: 'Write',
        input: { file_path: planPath, content: '# Plan' },
      }),
    ).toEqual({ behavior: 'allow' })
    expect(
      await manager.permissions(sessionId).resolve({
        id: 'project-write',
        name: 'Write',
        input: { file_path: join(configRoot, 'project.ts'), content: 'x' },
      }),
    ).toEqual({ behavior: 'deny', reason: 'plan mode' })
    expect(
      await manager.permissions(sessionId).resolve({
        id: 'plan-patch',
        name: 'ApplyPatch',
        input: {
          edits: [
            {
              file_path: planPath,
              old_string: '# Plan',
              new_string: '# Updated plan',
            },
          ],
        },
      }),
    ).toEqual({ behavior: 'allow' })
    expect(
      await manager.permissions(sessionId).resolve({
        id: 'project-patch',
        name: 'ApplyPatch',
        input: {
          edits: [
            {
              file_path: join(configRoot, 'project.ts'),
              old_string: 'x',
              new_string: 'y',
            },
          ],
        },
      }),
    ).toEqual({ behavior: 'deny', reason: 'plan mode' })

    await writeFile(planPath, '# Plan\n\n1. Implement it.\n')
    await expect(execute(registry, 'ExitPlanMode', {})).resolves.toEqual({
      content: expect.stringContaining(
        'User approved the plan. Plan mode ended; implementation may begin.',
      ),
      isError: false,
    })
    expect(manager.consumeTransition('call_ExitPlanMode')).toBe('default')
    expect(manager.contextMessage(sessionId)).toBeNull()
    expect(approvePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'exit',
        planPath,
        plan: expect.any(String),
        previousMode: 'default',
      }),
      undefined,
    )
  })

  it('restores plan mode from Claude permission-mode entries', async () => {
    const { manager } = await fixture()
    manager.restore(sessionId, [
      { type: 'permission-mode', permissionMode: 'default', sessionId },
      { type: 'permission-mode', permissionMode: 'plan', sessionId },
    ])
    expect(manager.contextMessage(sessionId)).toContain('Plan mode')
  })

  it('uses the permission mode and feedback selected when approving a plan', async () => {
    const { manager, registry, approvePlan } = await fixture()
    await execute(registry, 'EnterPlanMode', {})
    approvePlan.mockResolvedValueOnce({
      behavior: 'allow',
      permissionMode: 'acceptEdits',
      feedback: 'also update the README',
    })

    await expect(execute(registry, 'ExitPlanMode', {})).resolves.toMatchObject({
      isError: false,
      followUpUserMessages: ['also update the README'],
    })
    expect(manager.consumeTransition('call_ExitPlanMode')).toBe('acceptEdits')
  })

  it('keeps the active bypass permission mode on the shared resolver path', async () => {
    const { manager } = await fixture({ initialMode: 'bypassPermissions' })

    expect(
      await manager.permissions(sessionId).resolve({
        id: 'bypass-bash',
        name: 'Bash',
        input: { command: 'printf ok' },
      }),
    ).toEqual({ behavior: 'allow' })
  })

  it('updates a session permission mode outside a model tool transition', async () => {
    const { configRoot, manager } = await fixture()
    const planPath = join(configRoot, 'plans', `praxis-${sessionId}.md`)

    await manager.setMode(sessionId, 'plan')

    expect(manager.mode(sessionId)).toBe('plan')
    expect(manager.contextMessage(sessionId)).toContain('Plan mode')
    await expect(
      manager.permissions(sessionId).resolve({
        id: 'plan-write',
        name: 'Write',
        input: { file_path: planPath, content: '# Plan' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })

    await manager.setMode(sessionId, 'acceptEdits')
    expect(manager.mode(sessionId)).toBe('acceptEdits')
    expect(manager.contextMessage(sessionId)).toBeNull()
  })

  it('enters without approval and stays in plan mode when exit is declined', async () => {
    const { manager, registry } = await fixture({ approve: false })
    await expect(execute(registry, 'EnterPlanMode', {})).resolves.toMatchObject(
      {
        isError: false,
      },
    )
    expect(manager.consumeTransition('call_EnterPlanMode')).toBe('plan')
    const result = await execute(registry, 'ExitPlanMode', {})
    expect(result.isError).toBe(true)
    expect(manager.consumeTransition('call_ExitPlanMode')).toBeUndefined()
    expect(manager.contextMessage(sessionId)).toContain('Plan mode')
  })

  it('surfaces allowedPrompts at approval and pre-approves only exact approved Bash commands', async () => {
    const { configRoot, manager, registry, approvePlan } = await fixture({
      askForBash: true,
    })
    const planPath = join(configRoot, 'plans', `praxis-${sessionId}.md`)
    const allowedPrompts = [{ tool: 'Bash', prompt: 'npm test' }]

    await expect(execute(registry, 'EnterPlanMode', {})).resolves.toMatchObject(
      { isError: false },
    )
    await writeFile(planPath, '# Plan\n\n1. Implement it.\n')
    await expect(
      execute(registry, 'ExitPlanMode', { allowedPrompts }),
    ).resolves.toMatchObject({ isError: false })

    expect(approvePlan).toHaveBeenCalledWith(
      expect.objectContaining({ allowedPrompts }),
      undefined,
    )
    await expect(
      manager.permissions(sessionId).resolve({
        id: 'bash-approved',
        name: 'Bash',
        input: { command: 'npm test' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      manager.permissions(sessionId).resolve({
        id: 'bash-not-approved',
        name: 'Bash',
        input: { command: 'npm run build' },
      }),
    ).resolves.toMatchObject({ behavior: 'ask' })

    const denied = await fixture({ approve: false, askForBash: true })
    const deniedPlanPath = join(
      denied.configRoot,
      'plans',
      `praxis-${sessionId}.md`,
    )
    await expect(
      execute(denied.registry, 'EnterPlanMode', {}),
    ).resolves.toMatchObject({ isError: false })
    await writeFile(deniedPlanPath, '# Denied plan\n')
    await expect(
      execute(denied.registry, 'ExitPlanMode', { allowedPrompts }),
    ).resolves.toMatchObject({ isError: true })
    await expect(
      denied.manager.permissions(sessionId).resolve({
        id: 'bash-denied',
        name: 'Bash',
        input: { command: 'npm test' },
      }),
    ).resolves.toMatchObject({ behavior: 'ask' })
  })
})
