import { describe, expect, it } from 'vitest'

import {
  generateToolUseSummary,
  type ToolUseSummaryInput,
} from './tool-use-summary.js'

describe('generateToolUseSummary', () => {
  it('uses the provider with the Claude summary prompt and returns text', async () => {
    let request: unknown
    const provider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete(nextRequest: unknown) {
        request = nextRequest
        yield { type: 'text-delta' as const, delta: 'Read config.json' }
      },
    }
    const tools: ToolUseSummaryInput[] = [
      { name: 'Read', input: { file_path: 'config.json' }, output: '{}' },
    ]

    await expect(
      generateToolUseSummary(
        provider,
        tools,
        new AbortController().signal,
        'I need the config',
      ),
    ).resolves.toBe('Read config.json')
    expect(request).toMatchObject({
      messages: [
        {
          role: 'system',
          content: expect.stringContaining('short summary label'),
        },
        {
          role: 'user',
          content: expect.stringContaining('Tool: Read'),
        },
      ],
    })
  })

  it('does not call the provider after cancellation', async () => {
    const controller = new AbortController()
    let called = false
    const provider = {
      capabilities: { streaming: true, usage: true, tools: false },
      async *complete() {
        called = true
        yield { type: 'text-delta' as const, delta: 'unused' }
      },
    }
    controller.abort()

    await expect(
      generateToolUseSummary(provider, [], controller.signal),
    ).resolves.toBeNull()
    expect(called).toBe(false)
  })
})
