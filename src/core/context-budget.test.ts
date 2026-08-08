import { describe, expect, it } from 'vitest'

import {
  ContextBudget,
  ContextOverflowError,
  estimateModelRequestTokens,
} from './context-budget.js'

describe('ContextBudget', () => {
  it('counts signed and redacted thinking retained for provider resume', () => {
    const withoutThinking = estimateModelRequestTokens([
      { role: 'assistant', content: '' },
    ])
    const withThinking = estimateModelRequestTokens([
      {
        role: 'assistant',
        content: '',
        thinkingBlocks: [
          {
            type: 'thinking',
            thinking: 'a'.repeat(40),
            signature: 'b'.repeat(40),
          },
          { type: 'redacted_thinking', data: 'c'.repeat(40) },
        ],
      },
    ])

    expect(withThinking).toBeGreaterThan(withoutThinking + 20)
  })

  it('budgets messages and tool definitions with multilingual text', () => {
    const plain = estimateModelRequestTokens([
      { role: 'user', content: 'a'.repeat(400) },
    ])
    const multilingual = estimateModelRequestTokens([
      { role: 'user', content: '你'.repeat(400) },
    ])
    const withTools = estimateModelRequestTokens(
      [{ role: 'user', content: 'hello' }],
      [
        {
          name: 'Read',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: { file_path: { type: 'string' } },
          },
        },
      ],
    )

    expect(plain).toBeGreaterThanOrEqual(100)
    expect(multilingual).toBeGreaterThan(plain)
    expect(withTools).toBeGreaterThan(
      estimateModelRequestTokens([{ role: 'user', content: 'hello' }]),
    )
    expect(
      estimateModelRequestTokens([
        {
          role: 'tool',
          toolCallId: 'read-image',
          content: '',
          images: [
            {
              type: 'image',
              mediaType: 'image/png',
              data: 'a'.repeat(400),
            },
          ],
          isError: false,
        },
      ]),
    ).toBeGreaterThan(plain)
  })

  it('reports available and overflow tokens and fails actionably', () => {
    const budget = new ContextBudget({
      contextWindowTokens: 100,
      reserveTokens: 20,
    })
    const report = budget.evaluate([{ role: 'user', content: 'x'.repeat(400) }])

    expect(report).toMatchObject({
      contextWindowTokens: 100,
      reserveTokens: 20,
      availableTokens: 80,
      shouldCompact: true,
    })
    expect(() => budget.assertFits(report)).toThrow(ContextOverflowError)
    expect(() => budget.assertFits(report)).toThrow(
      /estimated=.*window=100.*reserve=20.*available=80/,
    )
  })
})
