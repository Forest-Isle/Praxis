import { describe, expect, it } from 'vitest'

import {
  ClaudeConditionalRuleResolver,
  ClaudeContextAssembler,
} from './context.js'

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

    await expect(assembler.assemble()).resolves.toEqual({
      systemMessages: [
        {
          role: 'system',
          content: `# Shared Claude context

Instructions are ordered from broadest to most specific. Auto-memory is background context and does not override instructions.

## Instructions

### user: /config/CLAUDE.md
GLOBAL_INSTRUCTION

### project: /workspace/CLAUDE.md
PROJECT_INSTRUCTION

## Auto-memory

### project: /config/projects/workspace/memory/MEMORY.md
MEMORY_CONTEXT`,
        },
      ],
    })
  })

  it('does not inject a system message when shared context is empty', async () => {
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    await expect(assembler.assemble()).resolves.toEqual({ systemMessages: [] })
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

    const { systemMessages: messages } = await assembler.assemble()
    expect(messages.map((message) => message.content)).toEqual([
      'CUSTOM_SYSTEM',
      expect.stringContaining('PROJECT_CONTEXT'),
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
    expect(assembled.systemMessages).toHaveLength(1)
    expect(assembled.systemMessages[0]?.content).toContain('PROJECT_CONTEXT')
    expect(JSON.stringify(assembled.systemMessages)).not.toContain(
      'ENVIRONMENT_MARKER',
    )
    expect(assembled.firstUserMessageContext).toMatch(
      /GIT_STATUS_MARKER[\s\S]*ENVIRONMENT_MARKER[\s\S]*MEMORY_PATH_MARKER/,
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
    expect(assembled.firstUserMessageContext).toBeUndefined()
    expect(assembled.systemMessages).toEqual([
      { role: 'system', content: '# Environment\nENVIRONMENT_MARKER' },
    ])
  })

  it('ignores dynamic relocation with a custom system prompt', async () => {
    let loads = 0
    const assembler = new ClaudeContextAssembler({
      systemPrompt: 'CUSTOM_SYSTEM',
      excludeDynamicSystemPromptSections: true,
      loadDynamicContext: async () => {
        loads += 1
        return { environment: 'SHOULD_NOT_LOAD' }
      },
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    await expect(assembler.assemble()).resolves.toEqual({
      systemMessages: [{ role: 'system', content: 'CUSTOM_SYSTEM' }],
    })
    expect(loads).toBe(0)
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

    const { systemMessages } = await assembler.assemble()
    const [message] = systemMessages

    expect(message?.content).toContain('MEMORY_LINE_200')
    expect(message?.content).not.toContain('MEMORY_LINE_201')
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

    const { systemMessages: firstMessages } = await assembler.assemble()
    const [first] = firstMessages
    content = 'UPDATED_CONTEXT'
    const { systemMessages: updatedMessages } = await assembler.assemble()
    const [updated] = updatedMessages

    expect(first?.content).toContain('FIRST_CONTEXT')
    expect(updated?.content).toContain('UPDATED_CONTEXT')
    expect(updated?.content).not.toContain('FIRST_CONTEXT')
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
    expect(assembled.systemMessages[0]?.content).toContain('/isolated/worktree')
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
