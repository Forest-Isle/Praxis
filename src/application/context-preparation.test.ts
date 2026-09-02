import { describe, expect, it, vi } from 'vitest'

import {
  createContextSnapshot,
  type ContextAssembler,
} from '../core/context.js'
import type { ModelMessage } from '../core/runtime.js'
import {
  ContextPreparation,
  StaleContextGenerationError,
} from './context-preparation.js'

const assembler = (version: string): ContextAssembler => ({
  assemble: async () =>
    createContextSnapshot([
      {
        id: 'stable',
        content: `stable-${version}`,
        placement: 'system',
        stability: 'session',
      },
      {
        id: 'volatile',
        content: `volatile-${version}`,
        placement: 'system',
        stability: 'volatile',
      },
      {
        id: 'first-user',
        content: `first-${version}`,
        placement: 'first-user',
        stability: 'session',
      },
    ]),
})

const user = (content: string): ModelMessage => ({ role: 'user', content })

describe('ContextPreparation', () => {
  it('orders system, decorated history, memory, and pending messages with attachments', async () => {
    const image = {
      type: 'image' as const,
      mediaType: 'image/png' as const,
      data: 'AA==',
    }
    const history = [user('old'), user('current prompt')]
    const memory = [user('memory')]
    const pending = [{ ...user('pending'), images: [image] }]
    const preparation = new ContextPreparation({
      assembler: assembler('one'),
      sources: {
        history: () => history,
        memory: () => memory,
        activeTools: () => [
          {
            name: 'Read',
            description: 'read',
            inputSchema: { type: 'object' },
          },
        ],
      },
      agentMentions: () => ({
        prompt: 'current prompt',
        messages: ['mention-a', 'mention-b'],
      }),
    })

    await preparation.refresh()
    const projection = preparation.project({ pendingMessages: pending })

    expect(projection.generation).toBe(1)
    expect(projection.stableSystemMessageCount).toBe(1)
    expect(projection.envelope.messages).toEqual([
      { role: 'system', content: 'stable-one' },
      { role: 'system', content: 'volatile-one' },
      { role: 'user', content: 'first-one\n\nold' },
      { role: 'user', content: 'mention-a' },
      { role: 'user', content: 'mention-b' },
      { role: 'user', content: 'current prompt' },
      { role: 'user', content: 'memory' },
      { role: 'user', content: 'pending', images: [image] },
    ])
    expect(projection.envelope.tools).toEqual([
      {
        name: 'Read',
        description: 'read',
        inputSchema: { type: 'object' },
      },
    ])
    expect(projection.envelope.messages.at(-1)).toBe(pending[0])
    expect(projection.envelope.messages[2]).not.toBe(history[0])
  })

  it('snapshots live sources while keeping the generation stable', async () => {
    let history: readonly ModelMessage[] = [user('history-one')]
    let memory: readonly ModelMessage[] = [user('memory-one')]
    let tools = [
      { name: 'one', description: 'one', inputSchema: { type: 'object' } },
    ]
    let version = 'one'
    const preparation = new ContextPreparation({
      assembler: {
        assemble: async () =>
          createContextSnapshot([
            {
              id: 'stable',
              content: 'stable',
              placement: 'system',
              stability: 'session',
            },
            {
              id: 'volatile',
              content: `volatile-${version}`,
              placement: 'system',
              stability: 'volatile',
            },
          ]),
      },
      sources: {
        history: () => history,
        memory: () => memory,
        activeTools: () => tools,
      },
    })

    await preparation.refresh()
    const first = preparation.project()
    history = [user('history-two')]
    memory = [user('memory-two')]
    tools = [
      { name: 'two', description: 'two', inputSchema: { type: 'object' } },
    ]
    version = 'two'
    await preparation.refresh()
    const second = preparation.project()

    expect(first.generation).toBe(1)
    expect(second.generation).toBe(1)
    expect(JSON.stringify(second.envelope.messages)).toContain('history-two')
    expect(JSON.stringify(second.envelope.messages)).toContain('memory-two')
    expect(JSON.stringify(second.envelope.messages)).toContain('volatile-two')
    expect(second.envelope.tools).toEqual(tools)
    expect(second.envelope.tools[0]).not.toBe(tools[0])
  })

  it('retains the last prepared context when refresh fails', async () => {
    let fail = false
    const preparation = new ContextPreparation({
      assembler: {
        assemble: async () => {
          if (fail) throw new Error('refresh failed')
          return createContextSnapshot([
            {
              id: 'system',
              content: 'prepared',
              placement: 'system',
              stability: 'session',
            },
          ])
        },
      },
      sources: {
        history: () => [user('history')],
        memory: () => [],
        activeTools: () => [],
      },
    })
    await preparation.refresh()
    fail = true
    await expect(preparation.refresh()).rejects.toThrow('refresh failed')
    expect(preparation.project().envelope.messages[0]).toEqual({
      role: 'system',
      content: 'prepared',
    })
  })

  it('guards monotonic replacements and preserves failed proposals', async () => {
    const preparation = new ContextPreparation({
      assembler: assembler('one'),
      sources: {
        history: () => [user('live')],
        memory: () => [user('memory')],
        activeTools: () => [],
      },
    })
    await preparation.refresh()

    const first = preparation.proposeHistoryReplacement({
      historyMessages: [user('replacement-one')],
    })
    const second = preparation.proposeHistoryReplacement({
      historyMessages: [user('replacement-two')],
    })
    expect(preparation.project().generation).toBe(1)
    const release = vi.fn<() => Promise<string>>()
    let resolveRelease!: (value: string) => void
    release.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRelease = resolve
        }),
    )
    const firstCommit = first.commit(release)
    const secondReplace = vi.fn(async () => 'second')
    const secondCommit = second.commit(secondReplace)
    await Promise.resolve()
    resolveRelease('first')
    await expect(firstCommit).resolves.toEqual({
      generation: 2,
      value: 'first',
    })
    expect(preparation.project().generation).toBe(2)
    await expect(secondCommit).rejects.toMatchObject({
      expectedGeneration: 1,
      actualGeneration: 2,
    })
    expect(secondReplace).not.toHaveBeenCalled()
    expect(preparation.project().generation).toBe(2)

    const discarded = preparation.proposeHistoryReplacement({
      historyMessages: [user('discarded')],
    })
    expect(discarded.generation).toBe(3)
    expect(preparation.project().generation).toBe(2)

    const failed = preparation.proposeHistoryReplacement({
      historyMessages: [user('failed')],
    })
    await expect(
      failed.commit(async () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope')
    expect(preparation.project().generation).toBe(2)
    const third = preparation.proposeHistoryReplacement({
      historyMessages: [user('replacement-three')],
    })
    await expect(third.commit(async () => 'third')).resolves.toEqual({
      generation: 3,
      value: 'third',
    })
    const duplicateReplace = vi.fn(async () => 'duplicate')
    await expect(third.commit(duplicateReplace)).rejects.toBeInstanceOf(
      StaleContextGenerationError,
    )
    expect(duplicateReplace).not.toHaveBeenCalled()
    expect(preparation.project().generation).toBe(3)
  })

  it('rejects invalid starting and overflowing generations', async () => {
    const sources = {
      history: () => [],
      memory: () => [],
      activeTools: () => [],
    }
    expect(
      () => new ContextPreparation({ sources, initialGeneration: 0 }),
    ).toThrow('positive safe integer')
    expect(
      () =>
        new ContextPreparation({
          sources,
          initialGeneration: Number.MAX_SAFE_INTEGER + 1,
        }),
    ).toThrow('positive safe integer')
    const preparation = new ContextPreparation({
      sources,
      initialGeneration: Number.MAX_SAFE_INTEGER,
    })
    await preparation.refresh()
    expect(() =>
      preparation.proposeHistoryReplacement({ historyMessages: [] }),
    ).toThrow('Number.MAX_SAFE_INTEGER')
  })
})
