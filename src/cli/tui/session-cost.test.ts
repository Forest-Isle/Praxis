import { describe, expect, it } from 'vitest'

import {
  accumulateSessionCost,
  createSessionCostState,
  formatCostUsd,
  formatCount,
  formatDuration,
  formatSessionCostReport,
} from './session-cost.js'

describe('session cost model', () => {
  it('accumulates usage and cost across models and provider default without mutating state', () => {
    const state = createSessionCostState()
    const next = accumulateSessionCost(state, {
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 2,
      },
      costUsd: 0.0002,
      durationApiMs: 150,
      wallDurationMs: 500,
      modelUsage: {
        sonnet: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 2,
        },
      },
    })
    const accumulated = accumulateSessionCost(next, {
      usage: { inputTokens: 3, outputTokens: 1 },
      costUsd: 0.0001,
      durationApiMs: 50,
      wallDurationMs: 100,
    })

    expect(state).toEqual(createSessionCostState())
    expect(next).not.toBe(state)
    expect(accumulated).not.toBe(next)
    expect(accumulated.models).toEqual({
      sonnet: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 0,
      },
      'provider default': {
        inputTokens: 3,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    })
    expect(accumulated.knownCostUsd).toBeCloseTo(0.0003, 10)
    expect(accumulated.hasUnknownCost).toBe(false)
    expect(accumulated.durationApiMs).toBe(200)
    expect(accumulated.durationWallMs).toBe(600)
  })

  it('merges repeated turns for the same model and keeps optional cache fields summed', () => {
    let state = createSessionCostState()
    state = accumulateSessionCost(state, {
      usage: { inputTokens: 5, outputTokens: 2 },
      modelUsage: {
        sonnet: {
          inputTokens: 5,
          outputTokens: 2,
          cacheCreationInputTokens: 1,
        },
      },
    })
    state = accumulateSessionCost(state, {
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadInputTokens: 4,
      },
      modelUsage: {
        sonnet: {
          inputTokens: 7,
          outputTokens: 3,
          cacheReadInputTokens: 4,
        },
      },
    })
    expect(state.models.sonnet).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 1,
    })
  })

  it('marks unknown-cost turns while retaining known costs and known usage', () => {
    let state = createSessionCostState()
    state = accumulateSessionCost(state, {
      usage: { inputTokens: 10, outputTokens: 4 },
      costUsd: 0.0002,
      modelUsage: {
        sonnet: { inputTokens: 10, outputTokens: 4 },
      },
    })
    state = accumulateSessionCost(state, {
      usage: { inputTokens: 5, outputTokens: 2 },
      modelUsage: {
        haiku: { inputTokens: 5, outputTokens: 2 },
      },
    })
    expect(state.knownCostUsd).toBeCloseTo(0.0002, 10)
    expect(state.hasUnknownCost).toBe(true)
    const report = formatSessionCostReport(state)
    expect(report).toContain('Total cost: $0.0002')
    expect(report).toContain(
      '(costs may be inaccurate due to usage of unknown models)',
    )
    expect(report).toContain('sonnet: 10 input · 4 output')
    expect(report).toContain('haiku: 5 input · 2 output')
  })

  it('treats negative and non-finite costs as unknown rather than summing them', () => {
    const negative = accumulateSessionCost(createSessionCostState(), {
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: -1,
    })
    expect(negative.knownCostUsd).toBe(0)
    expect(negative.hasUnknownCost).toBe(true)

    const nonFinite = accumulateSessionCost(createSessionCostState(), {
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: Number.NaN,
    })
    expect(nonFinite.knownCostUsd).toBe(0)
    expect(nonFinite.hasUnknownCost).toBe(true)
  })

  it('formats an empty report deterministically without an unknown-pricing warning', () => {
    const report = formatSessionCostReport(createSessionCostState())
    expect(report).toBe(
      [
        'Total cost: $0.0000',
        'Total duration (API): 0ms',
        'Total duration (wall): 0ms',
        'Total code changes: 0 lines added, 0 lines removed',
        'Usage by model:',
      ].join('\n'),
    )
  })

  it('formats money, durations, and counts deterministically', () => {
    expect(formatCostUsd(0)).toBe('$0.0000')
    expect(formatCostUsd(0.000321)).toBe('$0.0003')
    expect(formatCostUsd(0.5)).toBe('$0.50')
    expect(formatCostUsd(1.234)).toBe('$1.23')

    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(2000)).toBe('2s')
    expect(formatDuration(61000)).toBe('1m 1s')
    expect(formatDuration(3600000)).toBe('1h 0m')

    expect(formatCount(0)).toBe('0')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(1234567)).toBe('1,234,567')
  })
})
