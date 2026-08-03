import { describe, expect, it } from 'vitest'

import { ClaudeContextAssembler } from './context.js'

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
      loadResources: async () => ({ instructions: [], memoryIndex: null }),
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
