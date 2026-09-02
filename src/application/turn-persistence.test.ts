import { describe, expect, it } from 'vitest'

import type { ModelMessage, ModelToolCall } from '../core/runtime.js'
import { InMemoryTranscriptStore } from '../persistence/in-memory-transcript-store.js'
import type { NativeTranscriptEntry } from '../native/schema.js'
import {
  NativeSessionTranscript,
  type NativeSessionTranscriptLease,
} from './native-session-transcript.js'
import { TurnPersistence } from './turn-persistence.js'

const sessionId = 'turn-persistence-test'
const user = (content: string): ModelMessage => ({ role: 'user', content })
const assistant = (
  content: string,
  toolCalls?: readonly ModelToolCall[],
): ModelMessage => ({
  role: 'assistant',
  content,
  ...(toolCalls === undefined ? {} : { toolCalls }),
})

async function withPersistence<T>(
  operation: (persistence: TurnPersistence) => Promise<T>,
) {
  const store = new InMemoryTranscriptStore()
  const transcript = new NativeSessionTranscript({
    sessionId,
    store,
    createId: (() => {
      let index = 0
      return () => `event-${++index}`
    })(),
    now: () => '2026-08-23T00:00:00.000Z',
  })
  return transcript.withLease({ kind: 'start' }, async (native) =>
    operation(new TurnPersistence({ native })),
  )
}

describe('TurnPersistence', () => {
  it('isolates views, supports projection-only commits, and refreshes explicitly', async () => {
    await withPersistence(async (persistence) => {
      const entry = {
        type: 'user',
        uuid: 'projection-1',
        parentUuid: null,
        message: { role: 'user', content: 'projected' },
      } as NativeTranscriptEntry
      const initial = persistence.view()
      expect(initial.projectionTail).toEqual({
        byteLength: 0,
        lastLineHash: null,
        lastEventId: null,
        newlineTerminated: true,
      })
      await persistence.commit({ kind: 'projection', entries: [entry] })
      const view = persistence.view()
      ;(view.projectionEntries as NativeTranscriptEntry[]).push(entry)
      ;(view.activeEvents as unknown[]).push({})
      ;(view.projectionTail as { byteLength: number }).byteLength = 99
      expect(persistence.view().projectionEntries).toHaveLength(1)
      expect(persistence.view().activeEvents).toHaveLength(0)
      expect(persistence.view().projectionTail.byteLength).toBe(1)

      await persistence.commit({
        kind: 'messages',
        input: { messages: [user('native')] },
      })
      expect(persistence.view().projectionEntries).toHaveLength(1)
      const refreshed = persistence.refresh()
      expect(refreshed.projectionEntries.at(-1)).toMatchObject({
        message: { content: 'native' },
      })
      expect(refreshed.projectionTail.byteLength).toBe(1)
    })
  })

  it('commits staged projection only after the authoritative message append', async () => {
    await withPersistence(async (persistence) => {
      const entry = {
        type: 'user',
        uuid: 'combined-1',
        parentUuid: null,
        message: { role: 'user', content: 'combined' },
      } as NativeTranscriptEntry
      const receipt = await persistence.commit({
        kind: 'messages',
        input: { messages: [user('combined')] },
        projectionEntries: [entry],
      })
      expect(receipt).toEqual({ kind: 'messages', eventId: 'event-1' })
      expect(persistence.view().projectionEntries).toEqual([entry])
    })

    const failing = {
      activeEvents: () => [],
      activeMessages: () => [],
      interruption: () => ({ kind: 'none' as const }),
      beginToolExecution: async () => undefined,
      appendToolCompletion: async () => undefined,
      appendMessages: async () => {
        throw new Error('append failed')
      },
      appendCompaction: async () => ({ boundaryId: 'b', summaryId: 's' }),
    }
    const persistence = new TurnPersistence({ native: failing })
    await expect(
      persistence.commit({
        kind: 'messages',
        input: { messages: [user('not persisted')] },
        projectionEntries: [
          {
            type: 'user',
            uuid: 'not-published',
            parentUuid: null,
            message: { role: 'user', content: 'not persisted' },
          } as NativeTranscriptEntry,
        ],
      }),
    ).rejects.toThrow('append failed')
    expect(persistence.view().projectionEntries).toEqual([])
    await expect(
      persistence.commit({
        kind: 'projection',
        entries: [
          {
            type: 'user',
            uuid: 'after-failure',
            parentUuid: null,
            message: { role: 'user', content: 'after failure' },
          } as NativeTranscriptEntry,
        ],
      }),
    ).resolves.toMatchObject({ kind: 'projection' })
  })

  it('rejects invalid commands without native mutation and keeps the queue usable', async () => {
    let nativeMutations = 0
    const native = {
      activeEvents: () => [],
      activeMessages: () => [],
      interruption: () => ({ kind: 'none' as const }),
      beginToolExecution: async () => {
        nativeMutations += 1
      },
      appendToolCompletion: async () => {
        nativeMutations += 1
      },
      appendMessages: async () => {
        nativeMutations += 1
        return 'native-event'
      },
      appendCompaction: async () => {
        nativeMutations += 1
        return { boundaryId: 'boundary', summaryId: 'summary' }
      },
    }
    const persistence = new TurnPersistence({ native })
    const entry = {
      type: 'user',
      uuid: 'valid-after-invalid',
      parentUuid: null,
      message: { role: 'user', content: 'valid' },
    } as NativeTranscriptEntry

    await expect(
      persistence.commit({ kind: 'messages', input: { messages: [] } }),
    ).rejects.toThrow('native transcript cannot append empty messages')
    await expect(
      persistence.commit({ kind: 'projection', entries: [] }),
    ).rejects.toThrow('Cannot append an empty projection')
    await expect(
      persistence.commit({
        kind: 'messages',
        input: { messages: [user('valid native')] },
        projectionEntries: [],
      }),
    ).rejects.toThrow('Cannot append an empty projection')

    expect(nativeMutations).toBe(0)
    const uncloneable = {
      kind: 'projection' as const,
      entries: [
        {
          type: 'user',
          uuid: 'uncloneable',
          parentUuid: null,
          message: { role: 'user', content: 'uncloneable' },
          runtimeValue: () => undefined,
        } as NativeTranscriptEntry,
      ],
    }
    let uncloneablePromise: Promise<unknown> | undefined
    expect(() => {
      uncloneablePromise = persistence.commit(uncloneable)
    }).not.toThrow()
    const laterValidPromise = persistence.commit({
      kind: 'projection',
      entries: [entry],
    })
    if (uncloneablePromise === undefined)
      throw new Error('uncloneable commit did not return a promise')
    await expect(uncloneablePromise).rejects.toThrow()
    await expect(laterValidPromise).resolves.toEqual({
      kind: 'projection',
      lastProjectionId: entry.uuid,
    })
    expect(nativeMutations).toBe(0)
  })

  it('deeply isolates nested views and owns commands at invocation time', async () => {
    await withPersistence(async (persistence) => {
      const call = {
        id: 'nested-call',
        name: 'fixture',
        input: { nested: { value: 'original' } },
      }
      const entry = {
        type: 'assistant',
        uuid: 'nested-projection',
        parentUuid: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'original' }],
        },
      } as NativeTranscriptEntry
      await persistence.commit({
        kind: 'messages',
        input: { messages: [assistant('', [call])] },
        projectionEntries: [entry],
      })
      const baseline = persistence.view()
      const mutated = persistence.view()
      const projection = mutated.projectionEntries[0]
      const projectionMessage =
        projection?.type === 'assistant'
          ? (projection.message as { content?: unknown })
          : undefined
      if (Array.isArray(projectionMessage?.content)) {
        const content = projectionMessage.content[0]
        if (content && typeof content === 'object' && 'text' in content)
          content.text = 'mutated'
      }
      const event = mutated.activeEvents[0]
      if (event?.kind === 'messages') {
        const message = event.messages[0]
        if (message?.role === 'assistant') {
          const eventCall = message.toolCalls?.[0]
          if (eventCall) eventCall.input.nested = { value: 'mutated' }
        }
      }
      const activeMessage = mutated.activeMessages[0]
      if (activeMessage?.role === 'assistant') {
        const activeCall = activeMessage.toolCalls?.[0]
        if (activeCall) activeCall.input.nested = { value: 'mutated' }
      }
      if (mutated.interruption.kind === 'recoverable-tools') {
        const interruptionCall = mutated.interruption.calls[0]
        if (interruptionCall)
          interruptionCall.input.nested = { value: 'mutated' }
      }
      expect(persistence.view()).toEqual(baseline)
    })

    let nativeMessages: readonly ModelMessage[] | undefined
    const native: NativeSessionTranscriptLease = {
      activeEvents: () => [],
      activeMessages: () => [],
      interruption: () => ({ kind: 'none' }),
      beginToolExecution: async () => undefined,
      appendToolCompletion: async () => undefined,
      appendMessages: async (input) => {
        nativeMessages = input.messages
        return 'native-event'
      },
      appendCompaction: async () => ({
        boundaryId: 'boundary',
        summaryId: 'summary',
      }),
    }
    const persistence = new TurnPersistence({ native })
    const commandCall = {
      id: 'command-call',
      name: 'fixture',
      input: { nested: { value: 'original' } },
    }
    const commandEntry = {
      type: 'assistant',
      uuid: 'command-projection',
      parentUuid: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'original' }],
      },
    } as NativeTranscriptEntry
    const command = {
      kind: 'messages' as const,
      input: { messages: [assistant('', [commandCall])] },
      projectionEntries: [commandEntry],
    }
    const pending = persistence.commit(command)
    commandCall.input.nested.value = 'mutated'
    commandEntry.message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'mutated' }],
    }
    await pending
    expect(nativeMessages?.[0]).toEqual(
      assistant('', [
        {
          id: 'command-call',
          name: 'fixture',
          input: { nested: { value: 'original' } },
        },
      ]),
    )
    expect(persistence.view().projectionEntries[0]).toEqual({
      type: 'assistant',
      uuid: 'command-projection',
      parentUuid: null,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'original' }],
      },
    })
  })

  it('serializes concurrent native messages and tool lifecycle commits in invocation order', async () => {
    await withPersistence(async (persistence) => {
      const call = { id: 'call-1', name: 'fixture', input: {} }
      const first = persistence.commit({
        kind: 'messages',
        input: { messages: [assistant('', [call])] },
      })
      const started = persistence.commit({
        kind: 'tool-execution-started',
        callId: call.id,
      })
      const completed = persistence.commit({
        kind: 'tool-completion',
        input: {
          callId: call.id,
          result: { content: 'result', isError: false },
        },
      })
      await Promise.all([first, started, completed])
      expect(persistence.view().activeMessages).toEqual([
        assistant('', [call]),
        {
          role: 'tool',
          toolCallId: call.id,
          content: 'result',
          isError: false,
        },
      ])
    })
  })

  it('commits compaction atomically without refreshing compatibility projection', async () => {
    await withPersistence(async (persistence) => {
      await persistence.commit({
        kind: 'messages',
        input: { messages: [user('old'), assistant('suffix')] },
      })
      const before = persistence.view().projectionEntries
      const receipt = await persistence.commit({
        kind: 'compaction',
        input: {
          summary: 'summary',
          trigger: 'auto',
          preTokens: 10,
          postTokens: 4,
          durationMs: 1,
          preservedMessages: [user('suffix')],
        },
      })
      expect(receipt).toMatchObject({
        kind: 'compaction',
        boundaryId: 'event-2',
        summaryId: 'event-3',
      })
      expect(persistence.view().projectionEntries).toEqual(before)
      const refreshed = persistence.refresh().projectionEntries
      expect(
        refreshed.some((entry) => entry.subtype === 'compact_boundary'),
      ).toBe(true)
      expect(refreshed.some((entry) => entry.isCompactSummary === true)).toBe(
        true,
      )
      expect(
        refreshed.some(
          (entry) =>
            typeof entry.message === 'object' &&
            entry.message !== null &&
            'content' in entry.message &&
            entry.message.content === 'suffix',
        ),
      ).toBe(true)
    })
  })
})
