import { describe, expect, it } from 'vitest'

import {
  projectContextSnapshot,
  type ContextSnapshot,
} from '../../core/context.js'
import {
  ClaudeConditionalRuleResolver,
  ClaudeContextAssembler,
} from './context.js'

const project = (snapshot: ContextSnapshot) => projectContextSnapshot(snapshot)

describe('ClaudeContextAssembler', () => {
  it('assembles ordered instructions and auto-memory as provider-neutral system context', async () => {
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => ({
        instructions: [
          {
            path: '/config/CLAUDE.md',
            scope: 'user',
            content: 'GLOBAL_INSTRUCTION\n',
          },
          {
            path: '/workspace/CLAUDE.md',
            scope: 'project',
            content: 'PROJECT_INSTRUCTION\n',
          },
        ],
        conditionalRules: [],
        memoryIndex: {
          path: '/config/projects/workspace/memory/MEMORY.md',
          scope: 'project',
          content: 'MEMORY_CONTEXT\n',
        },
      }),
    })

    const assembled = await assembler.assemble()
    expect(
      project(assembled).systemMessages.map((message) => message.content),
    ).toEqual([
      expect.stringContaining('You are Praxis'),
      `# Shared Claude context

Instructions are ordered from broadest to most specific. Auto-memory is background context and does not override instructions.

## Instructions

### user: /config/CLAUDE.md
GLOBAL_INSTRUCTION

### project: /workspace/CLAUDE.md
PROJECT_INSTRUCTION

## Auto-memory

### project: /config/projects/workspace/memory/MEMORY.md
MEMORY_CONTEXT`,
      expect.stringMatching(/^# Current date\n\d{4}-\d{2}-\d{2}$/u),
    ])
    expect(project(assembled).stableSystemSectionCount).toBe(3)
  })

  it('keeps only the default product policy when shared context is empty', async () => {
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    const assembled = await assembler.assemble()
    expect(project(assembled).systemMessages).toEqual([
      { role: 'system', content: expect.stringContaining('Praxis') },
      {
        role: 'system',
        content: expect.stringMatching(/^# Current date\n\d{4}-\d{2}-\d{2}$/u),
      },
    ])
    expect(assembled.sections.map((section) => section.id)).toEqual([
      'product-policy',
      'current-date',
    ])
  })

  it('places custom and appended system prompts around shared context', async () => {
    const assembler = new ClaudeContextAssembler({
      systemPrompt: 'CUSTOM_SYSTEM',
      appendSystemPrompt: 'APPENDED_SYSTEM',
      loadResources: async () => ({
        instructions: [
          {
            path: '/workspace/CLAUDE.md',
            scope: 'project',
            content: 'PROJECT_CONTEXT',
          },
        ],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    const { systemMessages: messages } = project(await assembler.assemble())
    expect(messages.map((message) => message.content)).toEqual([
      'CUSTOM_SYSTEM',
      expect.stringContaining('PROJECT_CONTEXT'),
      expect.stringMatching(/^# Current date\n\d{4}-\d{2}-\d{2}$/u),
      'APPENDED_SYSTEM',
    ])
  })

  it('moves dynamic sections into first-user context when requested', async () => {
    const assembler = new ClaudeContextAssembler({
      excludeDynamicSystemPromptSections: true,
      loadDynamicContext: async () => ({
        environment: '# Environment\nENVIRONMENT_MARKER',
        memory: '# Memory\nMEMORY_PATH_MARKER',
        gitStatus: '# gitStatus\nGIT_STATUS_MARKER',
      }),
      loadResources: async () => ({
        instructions: [
          {
            path: '/workspace/CLAUDE.md',
            scope: 'project',
            content: 'PROJECT_CONTEXT',
          },
        ],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    const assembled = await assembler.assemble()
    const projection = project(assembled)
    expect(projection.systemMessages).toHaveLength(4)
    expect(JSON.stringify(projection.systemMessages)).toContain(
      'PROJECT_CONTEXT',
    )
    expect(JSON.stringify(projection.systemMessages)).toContain(
      'MEMORY_PATH_MARKER',
    )
    expect(JSON.stringify(projection.systemMessages)).not.toContain(
      'ENVIRONMENT_MARKER',
    )
    expect(projection.firstUserMessageContext).toMatch(
      /GIT_STATUS_MARKER[\s\S]*ENVIRONMENT_MARKER/,
    )
    expect(projection.firstUserMessageContext).not.toContain(
      'MEMORY_PATH_MARKER',
    )
  })

  it('keeps dynamic sections in the default system prompt', async () => {
    const assembler = new ClaudeContextAssembler({
      loadDynamicContext: async () => ({
        environment: '# Environment\nENVIRONMENT_MARKER',
      }),
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    const assembled = await assembler.assemble()
    const projection = project(assembled)
    expect(projection.firstUserMessageContext).toBeUndefined()
    expect(projection.systemMessages.map((message) => message.content)).toEqual(
      [
        expect.stringContaining('You are Praxis'),
        expect.stringMatching(/^# Current date\n\d{4}-\d{2}-\d{2}$/u),
        '# Environment\nENVIRONMENT_MARKER',
      ],
    )
  })

  it('replaces only the base policy when using a custom system prompt', async () => {
    let loads = 0
    const assembler = new ClaudeContextAssembler({
      systemPrompt: 'CUSTOM_SYSTEM',
      excludeDynamicSystemPromptSections: true,
      loadDynamicContext: async () => {
        loads += 1
        return { environment: 'CUSTOM_RUNTIME_CONTEXT' }
      },
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    const projection = project(await assembler.assemble())
    expect(projection).toMatchObject({
      systemMessages: [
        { role: 'system', content: 'CUSTOM_SYSTEM' },
        {
          role: 'system',
          content: expect.stringMatching(/^# Current date/u),
        },
      ],
      firstUserMessageContext: expect.stringContaining(
        'CUSTOM_RUNTIME_CONTEXT',
      ),
      stableSystemSectionCount: 2,
    })
    expect(loads).toBe(1)
  })

  it('keeps bare mode limited to explicitly appended context', async () => {
    let resourceLoads = 0
    const assembler = new ClaudeContextAssembler({
      bare: true,
      appendSystemPrompt: 'EXPLICIT_CONTEXT',
      loadResources: async () => {
        resourceLoads += 1
        return {
          instructions: [],
          conditionalRules: [],
          memoryIndex: null,
        }
      },
      loadDynamicContext: async () => ({ environment: 'AUTOMATIC_CONTEXT' }),
    })

    const assembled = await assembler.assemble({ lifecycleId: 'bare' })
    expect(assembled.sections).toEqual([
      {
        id: 'append-system',
        content: 'EXPLICIT_CONTEXT',
        placement: 'system',
        stability: 'session',
      },
    ])
    expect(resourceLoads).toBe(0)
    expect(JSON.stringify(assembled)).not.toContain('AUTOMATIC_CONTEXT')
  })

  it('limits the auto-memory index to the first 200 lines', async () => {
    const memoryLines = Array.from(
      { length: 201 },
      (_, index) => `MEMORY_LINE_${String(index + 1).padStart(3, '0')}`,
    )
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [],
        memoryIndex: {
          path: '/config/projects/workspace/memory/MEMORY.md',
          scope: 'project',
          content: memoryLines.join('\n'),
        },
      }),
    })

    const { systemMessages } = project(await assembler.assemble())
    const serialized = JSON.stringify(systemMessages)
    expect(serialized).toContain('MEMORY_LINE_200')
    expect(serialized).not.toContain('MEMORY_LINE_201')
  })

  it('reloads shared resources for each assembly', async () => {
    let content = 'FIRST_CONTEXT'
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => ({
        instructions: [
          { path: '/workspace/CLAUDE.md', scope: 'project', content },
        ],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    const { systemMessages: firstMessages } = project(
      await assembler.assemble(),
    )
    content = 'UPDATED_CONTEXT'
    const { systemMessages: updatedMessages } = project(
      await assembler.assemble(),
    )

    expect(JSON.stringify(firstMessages)).toContain('FIRST_CONTEXT')
    expect(JSON.stringify(updatedMessages)).toContain('UPDATED_CONTEXT')
    expect(JSON.stringify(updatedMessages)).not.toContain('FIRST_CONTEXT')
  })

  it('loads shared and dynamic context for the requested runtime cwd', async () => {
    const resourceCwds: Array<string | undefined> = []
    const dynamicCwds: Array<string | undefined> = []
    const assembler = new ClaudeContextAssembler({
      loadResources: async (cwd) => {
        resourceCwds.push(cwd)
        return { instructions: [], conditionalRules: [], memoryIndex: null }
      },
      loadDynamicContext: async (cwd) => {
        dynamicCwds.push(cwd)
        return { environment: `# Environment\n${cwd ?? ''}` }
      },
    })

    const assembled = await assembler.assemble({ cwd: '/isolated/worktree' })

    expect(resourceCwds).toEqual(['/isolated/worktree'])
    expect(dynamicCwds).toEqual(['/isolated/worktree'])
    expect(JSON.stringify(project(assembled).systemMessages)).toContain(
      '/isolated/worktree',
    )
  })

  it('keeps session snapshots byte-identical across ordinary turns', async () => {
    let resourceVersion = 0
    let dynamicVersion = 0
    let dateVersion = 0
    const assembler = new ClaudeContextAssembler({
      now: () => new Date(2026, 7, 22 + dateVersion++),
      loadResources: async () => ({
        instructions: [
          {
            path: '/workspace/CLAUDE.md',
            scope: 'project',
            content: `RESOURCE_${++resourceVersion}`,
          },
        ],
        conditionalRules: [],
        memoryIndex: null,
      }),
      loadDynamicContext: async () => ({
        environment: `ENVIRONMENT_${++dynamicVersion}`,
      }),
    })

    const first = await assembler.assemble({
      cwd: '/workspace',
      lifecycleId: 'session-1',
    })
    const second = await assembler.assemble({
      cwd: '/workspace',
      lifecycleId: 'session-1',
    })
    const other = await assembler.assemble({
      cwd: '/workspace',
      lifecycleId: 'session-2',
    })

    expect(second).toEqual(first)
    expect(JSON.stringify(first)).toContain('RESOURCE_1')
    expect(JSON.stringify(first)).toContain('ENVIRONMENT_1')
    expect(JSON.stringify(other)).toContain('RESOURCE_2')
    expect(JSON.stringify(other)).toContain('ENVIRONMENT_2')
    expect(resourceVersion).toBe(2)
    expect(dynamicVersion).toBe(2)
    expect(dateVersion).toBe(2)
  })

  it('invalidates only sections affected by the lifecycle reason', async () => {
    let resourceVersion = 0
    let dynamicVersion = 0
    let mcpVersion = 0
    const assembler = new ClaudeContextAssembler({
      now: () => new Date(2026, 7, 22),
      loadResources: async () => ({
        instructions: [
          {
            path: '/workspace/CLAUDE.md',
            scope: 'project',
            content: `RESOURCE_${++resourceVersion}`,
          },
        ],
        conditionalRules: [],
        memoryIndex: null,
      }),
      loadDynamicContext: async () => ({
        environment: `ENVIRONMENT_${++dynamicVersion}`,
      }),
      loadMcpInstructions: async () => [
        { server: 'zeta', instructions: `MCP_${++mcpVersion}` },
      ],
    })
    const options = { cwd: '/workspace', lifecycleId: 'session-1' }

    const first = await assembler.assemble(options)
    assembler.invalidate({
      lifecycleId: 'session-1',
      reason: 'resource-reload',
    })
    const resourcesReloaded = await assembler.assemble(options)
    assembler.invalidate({
      lifecycleId: 'session-1',
      reason: 'tool-pool',
    })
    const toolsReloaded = await assembler.assemble(options)

    expect(JSON.stringify(first)).toContain('RESOURCE_1')
    expect(JSON.stringify(resourcesReloaded)).toContain('RESOURCE_2')
    expect(JSON.stringify(resourcesReloaded)).toContain('ENVIRONMENT_1')
    expect(JSON.stringify(resourcesReloaded)).toContain('MCP_1')
    expect(JSON.stringify(toolsReloaded)).toContain('RESOURCE_2')
    expect(JSON.stringify(toolsReloaded)).toContain('ENVIRONMENT_1')
    expect(JSON.stringify(toolsReloaded)).toContain('MCP_2')
    const toolsProjection = project(toolsReloaded)
    const resourcesProjection = project(resourcesReloaded)
    expect(
      toolsProjection.systemMessages.slice(
        0,
        toolsProjection.stableSystemSectionCount,
      ),
    ).toEqual(
      resourcesProjection.systemMessages.slice(
        0,
        resourcesProjection.stableSystemSectionCount,
      ),
    )
    expect(resourceVersion).toBe(2)
    expect(dynamicVersion).toBe(1)
    expect(mcpVersion).toBe(2)
  })

  it('reports instruction loads once per cached session resource lifecycle', async () => {
    const loads: Array<{
      paths: string[]
      lifecycleId?: string
      reason: string
    }> = []
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => ({
        instructions: [
          {
            path: '/workspace/CLAUDE.md',
            scope: 'project',
            content: 'PROJECT_CONTEXT',
          },
        ],
        conditionalRules: [],
        memoryIndex: null,
      }),
      onInstructionsLoaded: async (resources, context) => {
        loads.push({
          paths: resources.map(({ path }) => path),
          ...(context.lifecycleId === undefined
            ? {}
            : { lifecycleId: context.lifecycleId }),
          reason: context.reason,
        })
      },
    })
    const options = { cwd: '/workspace', lifecycleId: 'session-1' }

    await assembler.assemble(options)
    await assembler.assemble(options)
    assembler.invalidate({ lifecycleId: 'session-1', reason: 'compact' })
    await assembler.assemble(options)

    expect(loads).toEqual([
      {
        paths: ['/workspace/CLAUDE.md'],
        lifecycleId: 'session-1',
        reason: 'session_start',
      },
      {
        paths: ['/workspace/CLAUDE.md'],
        lifecycleId: 'session-1',
        reason: 'compact',
      },
    ])
  })

  it('orders MCP instructions deterministically and records provenance', async () => {
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [],
        memoryIndex: null,
      }),
      loadMcpInstructions: async () => [
        { server: 'zeta', instructions: 'ZETA' },
        { server: 'alpha', instructions: 'ALPHA' },
      ],
    })

    const assembled = await assembler.assemble({ lifecycleId: 'session-1' })
    expect(assembled.sections.map((section) => section.id)).toEqual([
      'product-policy',
      'current-date',
      'mcp-instructions:alpha',
      'mcp-instructions:zeta',
    ])
    expect(project(assembled).stableSystemSectionCount).toBe(2)
    expect(JSON.stringify(project(assembled).systemMessages)).toMatch(
      /alpha[\s\S]*ALPHA[\s\S]*zeta[\s\S]*ZETA/,
    )
  })

  it('retries a failed snapshot input instead of caching a rejection', async () => {
    let attempts = 0
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('temporary resource failure')
        return { instructions: [], conditionalRules: [], memoryIndex: null }
      },
    })
    const options = { lifecycleId: 'session-1' }

    await expect(assembler.assemble(options)).rejects.toThrow(
      'temporary resource failure',
    )
    const assembled = await assembler.assemble(options)
    expect(assembled.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'product-policy' }),
      ]),
    )
    expect(attempts).toBe(2)
  })
})

describe('ClaudeConditionalRuleResolver', () => {
  it('matches project-relative read paths and skips rules already attached', async () => {
    const resolver = new ClaudeConditionalRuleResolver({
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [
          {
            path: '/workspace/.claude/rules/root.md',
            scope: 'project',
            content: 'ROOT_RULE',
            globs: ['packages/app/src/**/*.ts'],
            baseDirectory: '/workspace',
            rawContent: '---\npaths: ["src/**/*.ts"]\n---\nTYPESCRIPT_RULE',
          },
          {
            path: '/workspace/packages/app/.claude/rules/nested.md',
            scope: 'project',
            content: 'NESTED_RULE',
            globs: ['src/**/*.ts'],
            baseDirectory: '/workspace/packages/app',
            rawContent: '---\npaths: ["src/**/*.ts"]\n---\nNESTED_RULE',
          },
          {
            path: '/config/rules/tests.md',
            scope: 'user',
            content: 'TEST_RULE',
            globs: ['**/*.test.ts'],
            baseDirectory: '/workspace/packages/app',
            rawContent: '---\npaths: ["**/*.test.ts"]\n---\nTEST_RULE',
          },
          {
            path: '/workspace/.claude/rules/wrong-base.md',
            scope: 'project',
            content: 'WRONG_BASE_RULE',
            globs: ['src/**/*.ts'],
            baseDirectory: '/workspace',
            rawContent: '---\npaths: ["src/**/*.ts"]\n---\nWRONG_BASE_RULE',
          },
          {
            path: '/workspace/packages/app/.claude/rules/dotdot-name.md',
            scope: 'project',
            content: 'DOTDOT_NAME_RULE',
            globs: ['..config/**/*.ts'],
            baseDirectory: '/workspace/packages/app',
            rawContent:
              '---\npaths: ["..config/**/*.ts"]\n---\nDOTDOT_NAME_RULE',
          },
        ],
        memoryIndex: null,
      }),
    })

    await expect(
      resolver.resolve('/workspace/packages/app/src/app.test.ts', [
        '/workspace/packages/app/.claude/rules/nested.md',
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ path: '/workspace/.claude/rules/root.md' }),
      expect.objectContaining({ path: '/config/rules/tests.md' }),
    ])
    await expect(resolver.resolve('/outside/src/app.test.ts')).resolves.toEqual(
      [],
    )
    await expect(
      resolver.resolve('/workspace/packages/app/..config/app.ts'),
    ).resolves.toEqual([
      expect.objectContaining({
        path: '/workspace/packages/app/.claude/rules/dotdot-name.md',
      }),
    ])
  })
})
