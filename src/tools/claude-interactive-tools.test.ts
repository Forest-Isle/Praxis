import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PermissionResolver, ToolRegistry } from '../core/runtime.js'
import {
  ClaudeInteractiveToolManager,
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
}

async function fixture(options: { approve?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-interactive-tools-'))
  roots.push(root)
  const configRoot = join(root, 'config')
  await mkdir(configRoot)
  const askUser = vi.fn(async (questions: readonly ClaudeQuestion[]) => ({
    answers: { [questions[0]?.question ?? 'missing']: 'Option A' },
  }))
  const approvePlan = vi.fn(async () => options.approve ?? true)
  const permissionResolverForMode = vi.fn(
    (mode: string): PermissionResolver => ({
      resolve: (call) =>
        mode === 'plan' && call.name === 'Write'
          ? { behavior: 'deny', reason: 'plan mode' }
          : { behavior: 'allow' },
    }),
  )
  const manager = new ClaudeInteractiveToolManager({
    configRoot,
    initialMode: 'default',
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

  it('updates a session permission mode outside a model tool transition', async () => {
    const { configRoot, manager } = await fixture()
    const planPath = join(configRoot, 'plans', `praxis-${sessionId}.md`)

    await manager.setMode(sessionId, 'plan')

    expect(manager.contextMessage(sessionId)).toContain('Plan mode')
    await expect(
      manager.permissions(sessionId).resolve({
        id: 'plan-write',
        name: 'Write',
        input: { file_path: planPath, content: '# Plan' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })

    await manager.setMode(sessionId, 'acceptEdits')
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
})
