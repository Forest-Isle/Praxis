import { describe, expect, it, vi } from 'vitest'
import { TurnMemoryCoordinator } from './turn-memory-coordinator.js'

describe('TurnMemoryCoordinator', () => {
  it('consumes a settled project recall once', () => {
    const consumeIfSettled = vi
      .fn()
      .mockReturnValueOnce({ content: 'recall', attachmentCount: 1 })
      .mockReturnValueOnce(null)
    const coordinator = new TurnMemoryCoordinator({
      sessionId: 's',
      projectRecall: {
        prefetch: () => ({ consumeIfSettled }),
        recordRead: vi.fn(),
        recordCompact: vi.fn(),
      },
    })
    coordinator.prefetch({ turnId: 't', prompt: 'hello' })
    expect(coordinator.consumeRecall()).toEqual({
      content: 'recall',
      attachmentCount: 1,
    })
    expect(coordinator.consumeRecall()).toBeNull()
  })

  it('starts recall without awaiting and forwards successful observations', async () => {
    const consumeIfSettled = vi.fn(() => null)
    const prefetch = vi.fn(() => ({ consumeIfSettled }))
    const observeContext = vi.fn(async () => true)
    const observe = vi.fn()
    const coordinator = new TurnMemoryCoordinator({
      sessionId: 'session',
      session: {
        summary: async () => 'summary',
        waitForCompact: async () => undefined,
        observeContext,
      },
      projectRecall: {
        prefetch,
        recordRead: vi.fn(),
        recordCompact: vi.fn(),
      },
      projectExtraction: { observe, close: async () => undefined },
    })

    expect(
      coordinator.prefetch({ turnId: 'turn', prompt: 'remember this' }),
    ).toBeUndefined()
    expect(prefetch).toHaveBeenCalledWith({
      sessionId: 'session',
      turnId: 'turn',
      prompt: 'remember this',
    })

    const messages = [{ role: 'user' as const, content: 'hello' }]
    const projectMessages = [
      { id: 'message', role: 'user' as const, content: 'hello' },
    ]
    await coordinator.observeSuccess({
      messageId: 'message',
      occupancyTokens: 123,
      toolCalls: 2,
      messages,
      projectMessages,
      directMaintenance: true,
    })

    expect(observeContext).toHaveBeenCalledWith(123, 2, 'message', messages)
    expect(observe).toHaveBeenCalledWith({
      sessionId: 'session',
      messages: projectMessages,
      directMaintenance: true,
    })
  })

  it('isolates optional memory failures', async () => {
    const warn = vi.fn()
    const coordinator = new TurnMemoryCoordinator({
      sessionId: 's',
      warn,
      session: {
        summary: async () => {
          throw new Error('broken')
        },
        waitForCompact: async () => {
          throw new Error('busy')
        },
        observeContext: async () => {
          throw new Error('observe')
        },
      },
      projectExtraction: {
        observe: () => {
          throw new Error('extract')
        },
        close: async () => undefined,
      },
    })
    expect(await coordinator.sessionSummary()).toBe('')
    await coordinator.beforeCompact()
    await coordinator.observeSuccess({
      messageId: 'm',
      occupancyTokens: 1,
      toolCalls: 0,
      messages: [],
      projectMessages: [],
    })
    expect(warn).toHaveBeenCalledTimes(4)
  })
})
