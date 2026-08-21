import { describe, expect, it } from 'vitest'

import {
  ContextBudget,
  ContextOverflowError,
  ContextRecoveryPlanner,
  estimateModelRequestTokens,
  isPromptTooLongError,
} from './context-budget.js'
import { ModelProviderError } from './runtime.js'

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

  it('reports the provider usage window as authoritative over the estimate', () => {
    const budget = new ContextBudget({
      contextWindowTokens: 100,
      reserveTokens: 20,
    })
    const report = budget.evaluate(
      [{ role: 'user', content: 'x'.repeat(400) }],
      [],
      {
        lastUsage: {
          inputTokens: 40,
          outputTokens: 10,
          contextWindow: 300,
        },
      },
    )

    expect(report.contextWindowTokens).toBe(300)
    expect(report.availableTokens).toBe(280)
    expect(report.source).toBe('provider')
    expect(report.shouldCompact).toBe(false)
  })

  it('ignores malformed provider usage and never shrinks the configured window', () => {
    const budget = new ContextBudget({
      contextWindowTokens: 100,
      reserveTokens: 20,
    })
    const report = budget.evaluate(
      [{ role: 'user', content: 'x'.repeat(400) }],
      [],
      {
        lastUsage: { inputTokens: 0, outputTokens: 0, contextWindow: -5 },
      },
    )

    expect(report.contextWindowTokens).toBe(100)
    expect(report.availableTokens).toBe(80)
    expect(report.shouldCompact).toBe(true)
  })

  it('keeps the no-usage fallback unchanged and tags capability-derived windows', () => {
    const budget = new ContextBudget({
      contextWindowTokens: 100,
      reserveTokens: 20,
      windowSource: 'capability',
    })
    const report = budget.evaluate([{ role: 'user', content: 'x'.repeat(400) }])

    expect(report).toMatchObject({
      contextWindowTokens: 100,
      reserveTokens: 20,
      availableTokens: 80,
      shouldCompact: true,
    })
    expect(report.source).toBe('capability')
  })

  it('observes provider usage for subsequent decisions', () => {
    const budget = new ContextBudget({ contextWindowTokens: 100 })
    budget.observeUsage({ inputTokens: 5, outputTokens: 2, contextWindow: 400 })

    expect(budget.effectiveContextWindow()).toBe(400)
    expect(
      budget.effectiveContextWindow({
        inputTokens: 1,
        outputTokens: 1,
        contextWindow: 250,
      }),
    ).toBe(250)
    // A malformed explicit window is ignored and never shrinks the configured
    // window below the safe configured fallback.
    expect(
      budget.effectiveContextWindow({
        inputTokens: 1,
        outputTokens: 1,
        contextWindow: 1.5,
      }),
    ).toBe(100)
    const report = budget.evaluate([{ role: 'user', content: 'hello' }])
    expect(report.contextWindowTokens).toBe(400)
    expect(report.source).toBe('provider')
  })

  it('forces compaction on a prompt-too-long provider signal and reserves output', () => {
    const budget = new ContextBudget({ contextWindowTokens: 100 })
    const forced = budget.evaluate([{ role: 'user', content: 'hello' }], [], {
      promptTooLong: true,
    })
    expect(forced.shouldCompact).toBe(true)
    expect(forced.source).toBe('estimate')

    const overflowing = budget.evaluate(
      [{ role: 'user', content: 'hello' }],
      [],
      { outputTokens: 120 },
    )
    expect(overflowing.shouldCompact).toBe(true)

    const malformedOutput = budget.evaluate(
      [{ role: 'user', content: 'hello' }],
      [],
      { outputTokens: -1 },
    )
    expect(malformedOutput.shouldCompact).toBe(false)
  })

  it('anchors occupancy at actual usage and adds only post-watermark growth', () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1000,
      reserveTokens: 100,
    })
    const history = [{ role: 'user' as const, content: 'x'.repeat(400) }]
    const nextTurn = [
      ...history,
      { role: 'user' as const, content: 'a'.repeat(80) },
    ]
    const baselineEstimate = estimateModelRequestTokens(history)

    // The completed request reported far fewer input/cache tokens than the
    // deterministic estimator, so occupancy must anchor at the actual count
    // and never double-count the pre-watermark history.
    budget.observeUsage(
      {
        inputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        outputTokens: 999,
        contextWindow: 1000,
      },
      history,
    )

    const unchanged = budget.evaluate(history)
    expect(unchanged.occupancyTokens).toBe(80) // 40 + 30 + 10; output excluded
    expect(unchanged.estimatedTokens).toBe(baselineEstimate)
    expect(unchanged.shouldCompact).toBe(false)

    const grown = budget.evaluate(nextTurn)
    expect(grown.occupancyTokens).toBe(
      80 + (estimateModelRequestTokens(nextTurn) - baselineEstimate),
    )

    // Observing the same usage again never grows the anchor.
    budget.observeUsage(
      {
        inputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 10,
        outputTokens: 999,
        contextWindow: 1000,
      },
      history,
    )
    expect(budget.evaluate(history).occupancyTokens).toBe(80)
  })

  it('fails open on malformed or non-safe observed usage', () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1000,
      reserveTokens: 100,
    })
    const history = [{ role: 'user' as const, content: 'x'.repeat(400) }]
    const fallback = estimateModelRequestTokens(history)

    budget.observeUsage(
      { inputTokens: -5, outputTokens: 0, contextWindow: 1000 },
      history,
    )
    expect(budget.evaluate(history).occupancyTokens).toBe(fallback)

    budget.observeUsage(
      {
        inputTokens: 1.5,
        cacheReadInputTokens: 10,
        outputTokens: 0,
      },
      history,
    )
    expect(budget.evaluate(history).occupancyTokens).toBe(fallback)

    budget.observeUsage(
      { inputTokens: 100, cacheReadInputTokens: -5, outputTokens: 0 },
      history,
    )
    expect(budget.evaluate(history).occupancyTokens).toBe(fallback)

    // Non-safe input is ignored, but a valid window still updates
    // independently.
    budget.observeUsage(
      {
        inputTokens: Number.MAX_SAFE_INTEGER + 1,
        outputTokens: 0,
        contextWindow: 2000,
      },
      history,
    )
    expect(budget.effectiveContextWindow()).toBe(2000)
    const report = budget.evaluate(history)
    expect(report.contextWindowTokens).toBe(2000)
    expect(report.occupancyTokens).toBe(fallback)
  })

  it('emits one bounded diagnostic when usage accounting falls back', () => {
    const diagnostics: string[] = []
    const budget = new ContextBudget({
      contextWindowTokens: 1000,
      onAccountingDiagnostic: (message) => diagnostics.push(message),
    })
    const messages = [{ role: 'user' as const, content: 'hello' }]

    budget.observeUsage({ inputTokens: -1, outputTokens: 0 }, messages)
    budget.observeUsage({ inputTokens: 1.5, outputTokens: 0 }, messages)

    expect(diagnostics).toEqual([
      'Provider input usage was malformed; using deterministic context estimates.',
    ])
    expect(diagnostics[0]?.length).toBeLessThanOrEqual(256)
  })

  it('does not fail a turn when the accounting diagnostic sink throws', () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1000,
      onAccountingDiagnostic: () => {
        throw new Error('diagnostic sink unavailable')
      },
    })

    expect(() =>
      budget.observeUsage({ inputTokens: -1, outputTokens: 0 }, [
        { role: 'user', content: 'hello' },
      ]),
    ).not.toThrow()
  })
})

describe('ContextRecoveryPlanner', () => {
  it('advances through bounded recovery stages and stays blocked', () => {
    const planner = new ContextRecoveryPlanner()
    expect(planner.stage).toBe('preflight')
    expect(planner.advance()).toBe('microcompact')
    expect(planner.advance()).toBe('auto-compact')
    expect(planner.advance()).toBe('reactive-retry')
    expect(planner.advance()).toBe('blocked')
    expect(planner.advance()).toBe('blocked')
  })

  it('allows a single reactive retry before reporting blocked', () => {
    const planner = new ContextRecoveryPlanner()
    expect(planner.reactiveRetriesRemaining).toBe(1)
    expect(planner.consumeReactiveRetry()).toBe('reactive-retry')
    expect(planner.reactiveRetriesRemaining).toBe(0)
    expect(planner.consumeReactiveRetry()).toBe('blocked')
    expect(planner.consumeReactiveRetry()).toBe('blocked')
  })

  it('trips a consecutive-failure circuit breaker of three', () => {
    const planner = new ContextRecoveryPlanner()
    planner.recordFailure()
    expect(planner.stage).toBe('preflight')
    planner.recordFailure()
    expect(planner.stage).toBe('preflight')
    planner.recordFailure()
    expect(planner.stage).toBe('blocked')
    planner.recordSuccess()
    expect(planner.stage).toBe('preflight')
    expect(planner.reactiveRetriesRemaining).toBe(1)
  })

  it('validates planner bounds', () => {
    expect(
      () => new ContextRecoveryPlanner({ maxReactiveRetries: -1 }),
    ).toThrow('maxReactiveRetries must be a nonnegative integer')
    expect(
      () => new ContextRecoveryPlanner({ consecutiveFailureThreshold: 0 }),
    ).toThrow('consecutiveFailureThreshold must be a positive integer')
  })
})

describe('isPromptTooLongError', () => {
  it('recognizes provider context-overflow messages', () => {
    const tooLong = new ModelProviderError(
      'The prompt is too long for the model context window',
      { retryable: false },
    )
    expect(isPromptTooLongError(tooLong)).toBe(true)

    const contextLength = new ModelProviderError(
      "This model's maximum context length is 200000 tokens",
      { retryable: false },
    )
    expect(isPromptTooLongError(contextLength)).toBe(true)

    const unrelated = new ModelProviderError('Rate limit exceeded', {
      retryable: true,
    })
    expect(isPromptTooLongError(unrelated)).toBe(false)
    expect(isPromptTooLongError(new Error('prompt is too long'))).toBe(false)
  })
})
