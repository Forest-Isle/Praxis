import { describe, expect, it, vi } from 'vitest'
import { ContextBudget } from '../core/context-budget.js'
import { ModelProviderError, type ModelMessage } from '../core/runtime.js'
import {
  ContextEngine,
  type ContextEnvelope,
  type ContextTransitionPort,
} from './context-engine.js'
import { StaleContextGenerationError } from './context-preparation.js'

const message = (content: string): ModelMessage => ({ role: 'user', content })
const portFor = (
  current: ContextEnvelope,
  next: ContextEnvelope,
  commit = vi.fn(async () => undefined),
): ContextTransitionPort & { commit: typeof commit } => ({
  current: () => current,
  irreducible: () => ({ messages: [message('small')], tools: [] }),
  propose: async () => ({ envelope: next, commit }),
  commit,
})

describe('ContextEngine', () => {
  it('does nothing when the current envelope fits', async () => {
    const commit = vi.fn(async () => undefined)
    const envelope = { messages: [message('ok')], tools: [] }
    const result = await new ContextEngine({
      budget: new ContextBudget({
        contextWindowTokens: 100,
        reserveTokens: 10,
      }),
    }).prepare(portFor(envelope, envelope, commit))
    expect(result).toBe(envelope)
    expect(commit).not.toHaveBeenCalled()
  })

  it('commits one progress-making reactive proposal and retries', async () => {
    const commit = vi.fn(async () => undefined)
    const engine = new ContextEngine({
      budget: new ContextBudget({ contextWindowTokens: 30, reserveTokens: 5 }),
    })
    const result = await engine.recover(
      new ModelProviderError('too long', {
        retryable: false,
        kind: 'prompt_too_long',
      }),
      portFor(
        { messages: [message('x'.repeat(200))], tools: [] },
        { messages: [message('small')], tools: [] },
        commit,
      ),
    )
    expect(result.kind).toBe('retry')
    expect(commit).toHaveBeenCalledOnce()
  })

  it('validates a proactive proposal before committing it', async () => {
    const commit = vi.fn(async () => undefined)
    const engine = new ContextEngine({
      budget: new ContextBudget({ contextWindowTokens: 30, reserveTokens: 5 }),
    })

    await expect(
      engine.prepare(
        portFor(
          { messages: [message('x'.repeat(200))], tools: [] },
          { messages: [message('y'.repeat(200))], tools: [] },
          commit,
        ),
      ),
    ).rejects.toThrow('Context exceeds provider budget')
    expect(commit).not.toHaveBeenCalled()
  })

  it('orders proactive memory coordination around one validated commit', async () => {
    const order: string[] = []
    const current = { messages: [message('x'.repeat(200))], tools: [] }
    const next = { messages: [message('small')], tools: [] }
    const engine = new ContextEngine({
      budget: new ContextBudget({ contextWindowTokens: 30, reserveTokens: 5 }),
      memory: {
        beforeCompact: async () => {
          order.push('memory-before')
        },
        afterCompact: async () => {
          order.push('memory-after')
        },
      },
    })

    await engine.prepare({
      current: () => current,
      irreducible: () => ({ messages: [message('small')], tools: [] }),
      propose: async () => {
        order.push('propose')
        return {
          envelope: next,
          commit: async () => {
            order.push('commit')
          },
        }
      },
    })

    expect(order).toEqual([
      'memory-before',
      'propose',
      'commit',
      'memory-after',
    ])
  })

  it('exhausts a no-progress recovery without committing or looping', async () => {
    const commit = vi.fn(async () => undefined)
    const propose = vi.fn(async () => ({
      envelope: { messages: [message('small')], tools: [] },
      commit,
    }))
    const port: ContextTransitionPort = {
      current: () => ({ messages: [message('small')], tools: [] }),
      irreducible: () => ({ messages: [message('small')], tools: [] }),
      propose,
    }
    const engine = new ContextEngine({
      budget: new ContextBudget({ contextWindowTokens: 30, reserveTokens: 5 }),
    })
    const error = new ModelProviderError('too long', {
      retryable: false,
      kind: 'prompt_too_long',
    })

    await expect(engine.recover(error, port)).resolves.toEqual({
      kind: 'exhausted',
      error,
    })
    await expect(engine.recover(error, port)).resolves.toEqual({
      kind: 'exhausted',
      error,
    })
    expect(propose).toHaveBeenCalledOnce()
    expect(commit).not.toHaveBeenCalled()
  })

  it('propagates a stale replacement without running post-commit memory effects', async () => {
    const beforeCompact = vi.fn(async () => undefined)
    const afterCompact = vi.fn(async () => undefined)
    const stale = new StaleContextGenerationError(1, 2)
    const commit = vi.fn(async () => {
      throw stale
    })
    const engine = new ContextEngine({
      budget: new ContextBudget({ contextWindowTokens: 30, reserveTokens: 5 }),
      memory: { beforeCompact, afterCompact },
    })
    const error = new ModelProviderError('too long', {
      retryable: false,
      kind: 'prompt_too_long',
    })

    await expect(
      engine.recover(error, {
        current: () => ({ messages: [message('x'.repeat(200))], tools: [] }),
        irreducible: () => ({ messages: [message('small')], tools: [] }),
        propose: async () => ({
          envelope: { messages: [message('small')], tools: [] },
          commit,
        }),
      }),
    ).rejects.toBe(stale)
    expect(beforeCompact).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledOnce()
    expect(afterCompact).not.toHaveBeenCalled()
  })

  it('anchors later occupancy to observed provider usage', () => {
    const engine = new ContextEngine({
      budget: new ContextBudget({
        contextWindowTokens: 2_000,
        reserveTokens: 200,
      }),
    })
    const observed = [message('a'.repeat(400))]
    engine.observeUsage({ inputTokens: 600, outputTokens: 10 }, observed, [])

    expect(
      engine.report({ messages: observed, tools: [] })?.occupancyTokens,
    ).toBe(600)
    expect(
      engine.report({
        messages: [...observed, message('b'.repeat(400))],
        tools: [],
      })?.occupancyTokens,
    ).toBeGreaterThan(600)
  })
})
