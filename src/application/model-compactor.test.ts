import { describe, expect, it } from 'vitest'

import type { ModelProvider, ModelRequest } from '../core/runtime.js'
import { ModelCompactor } from './model-compactor.js'

describe('ModelCompactor', () => {
  it('generates a bounded summary without exposing tools', async () => {
    const requests: ModelRequest[] = []
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete(request) {
        requests.push(request)
        yield { type: 'text-delta', delta: 'CURRENT_TASK and DECISION' }
        yield {
          type: 'usage',
          usage: { inputTokens: 50, outputTokens: 5 },
        }
      },
    }
    const compactor = new ModelCompactor(provider)

    const result = await compactor.compact({
      messages: [{ role: 'user', content: 'Keep CURRENT_TASK.' }],
      targetTokens: 100,
      contextWindowTokens: 1_000,
    })

    expect(result.summary).toBe('CURRENT_TASK and DECISION')
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 5 })
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(requests[0]?.tools).toBeUndefined()
    expect(requests[0]?.messages[0]).toMatchObject({ role: 'system' })
  })

  it('rejects tool calls and summaries over the requested bound', async () => {
    const toolProvider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: true },
      async *complete() {
        yield {
          type: 'tool-call',
          call: { id: 'call', name: 'Read', input: {} },
        }
      },
    }
    await expect(
      new ModelCompactor(toolProvider).compact({
        messages: [{ role: 'user', content: 'history' }],
        targetTokens: 10,
        contextWindowTokens: 1_000,
      }),
    ).rejects.toThrow('must not call tools')

    const longProvider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        yield { type: 'text-delta', delta: 'x'.repeat(400) }
      },
    }
    await expect(
      new ModelCompactor(longProvider).compact({
        messages: [{ role: 'user', content: 'history' }],
        targetTokens: 10,
        contextWindowTokens: 1_000,
      }),
    ).rejects.toThrow('exceeded 10 tokens')
  })

  it('refuses an over-window compaction request before calling the provider', async () => {
    let called = false
    const provider: ModelProvider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        called = true
        yield { type: 'text-delta', delta: 'unexpected' }
      },
    }

    await expect(
      new ModelCompactor(provider).compact({
        messages: [{ role: 'user', content: 'history '.repeat(100) }],
        targetTokens: 20,
        contextWindowTokens: 100,
      }),
    ).rejects.toThrow(/estimated=.*window=100.*target=20.*available=80/)
    expect(called).toBe(false)
  })
})
