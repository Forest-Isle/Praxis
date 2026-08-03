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

    await expect(assembler.assemble()).resolves.toEqual([
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
    ])
  })

  it('does not inject a system message when shared context is empty', async () => {
    const assembler = new ClaudeContextAssembler({
      loadResources: async () => ({
        instructions: [],
        conditionalRules: [],
        memoryIndex: null,
      }),
    })

    await expect(assembler.assemble()).resolves.toEqual([])
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

    const [message] = await assembler.assemble()

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

    const [first] = await assembler.assemble()
    content = 'UPDATED_CONTEXT'
    const [updated] = await assembler.assemble()

    expect(first?.content).toContain('FIRST_CONTEXT')
    expect(updated?.content).toContain('UPDATED_CONTEXT')
    expect(updated?.content).not.toContain('FIRST_CONTEXT')
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
