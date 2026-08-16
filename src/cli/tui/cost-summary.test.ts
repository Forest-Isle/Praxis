import { describe, expect, it } from 'vitest'

import {
  formatCostSummary,
  type CostModelUsage,
  type CostSummary,
} from './cost-summary.js'

const emptySummary: CostSummary = {
  totalCostUsd: 0,
  apiDurationMs: 0,
  wallDurationMs: 0,
  linesAdded: 0,
  linesRemoved: 0,
  hasUnknownModelCost: false,
  modelUsage: [],
}

const lineAt = (text: string, index: number): string => {
  const line = text.split('\n')[index]
  if (line === undefined) {
    throw new Error(`expected formatted summary line at index ${index}`)
  }
  return line
}

const totalCostText = (totalCostUsd: number): string =>
  lineAt(formatCostSummary({ ...emptySummary, totalCostUsd }), 0).slice(23)

const apiDurationText = (apiDurationMs: number): string =>
  lineAt(formatCostSummary({ ...emptySummary, apiDurationMs }), 1).slice(23)

describe('formatCostSummary', () => {
  it('renders the exact empty /cost text', () => {
    expect(formatCostSummary(emptySummary)).toBe(
      'Total cost:            $0.0000\n' +
        'Total duration (API):  0s\n' +
        'Total duration (wall): 0s\n' +
        'Total code changes:    0 lines added, 0 lines removed\n' +
        'Usage:                 0 input, 0 output, 0 cache read, 0 cache write',
    )
  })

  it('renders the exact nonempty /cost text', () => {
    const summary: CostSummary = {
      totalCostUsd: 2.5,
      apiDurationMs: 60000,
      wallDurationMs: 3600000,
      linesAdded: 1,
      linesRemoved: 1,
      hasUnknownModelCost: true,
      modelUsage: [
        {
          model: 'model-a',
          canonicalName: 'Model A',
          inputTokens: 1234,
          outputTokens: 500,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 50,
          webSearchRequests: 1500,
          costUsd: 1.25,
        },
        {
          model: 'model-a',
          canonicalName: 'Model A',
          inputTokens: 100,
          outputTokens: 200,
          costUsd: 0.25,
        },
        {
          model: 'model-b',
          canonicalName: 'Model B',
          inputTokens: 10,
          outputTokens: 20,
          costUsd: 0.5,
        },
      ],
    }

    expect(formatCostSummary(summary)).toBe(
      'Total cost:            $2.50 (costs may be inaccurate due to usage of unknown models)\n' +
        'Total duration (API):  1m 0s\n' +
        'Total duration (wall): 1h 0m 0s\n' +
        'Total code changes:    1 line added, 1 line removed\n' +
        'Usage by model:\n' +
        '             Model A:  1.3k input, 700 output, 100 cache read, 50 cache write, 1.5k web search ($1.50)\n' +
        '             Model B:  10 input, 20 output, 0 cache read, 0 cache write ($0.5000)',
    )
  })

  describe('cost boundaries', () => {
    it.each<[number, string]>([
      [0, '$0.0000'],
      [0.5, '$0.5000'],
      [0.5001, '$0.50'],
      [1.005, '$1.00'],
      [2.675, '$2.68'],
      [1.5, '$1.50'],
    ])('formats total cost %s as %s', (totalCostUsd, expected) => {
      expect(totalCostText(totalCostUsd)).toBe(expected)
    })
  })

  describe('duration formatting', () => {
    it.each<[number, string]>([
      [0, '0s'],
      [0.5, '0.0s'],
      [59999, '59s'],
      [60000, '1m 0s'],
      [119999, '2m 0s'],
      [3600000, '1h 0m 0s'],
      [7199999, '2h 0m 0s'],
      [86400000, '1d 0h 0m'],
      [172799999, '2d 0h 0m'],
    ])('formats API duration %s as %s', (apiDurationMs, expected) => {
      expect(apiDurationText(apiDurationMs)).toBe(expected)
    })
  })

  describe('invalid inputs', () => {
    it.each<[string, CostSummary, string]>([
      [
        'negative total cost',
        { ...emptySummary, totalCostUsd: -0.01 },
        'totalCostUsd',
      ],
      [
        'non-finite total cost',
        { ...emptySummary, totalCostUsd: Number.POSITIVE_INFINITY },
        'totalCostUsd',
      ],
      [
        'NaN total cost',
        { ...emptySummary, totalCostUsd: Number.NaN },
        'totalCostUsd',
      ],
      [
        'negative API duration',
        { ...emptySummary, apiDurationMs: -1 },
        'apiDurationMs',
      ],
      [
        'negative wall duration',
        { ...emptySummary, wallDurationMs: -1 },
        'wallDurationMs',
      ],
      [
        'fractional lines added',
        { ...emptySummary, linesAdded: 1.5 },
        'linesAdded',
      ],
      [
        'fractional lines removed',
        { ...emptySummary, linesRemoved: 1.5 },
        'linesRemoved',
      ],
      [
        'negative lines removed',
        { ...emptySummary, linesRemoved: -1 },
        'linesRemoved',
      ],
      [
        'missing unknown-cost flag',
        {
          ...emptySummary,
          hasUnknownModelCost: undefined as unknown as boolean,
        },
        'hasUnknownModelCost',
      ],
      [
        'non-boolean unknown-cost flag',
        {
          ...emptySummary,
          hasUnknownModelCost: 'yes' as unknown as boolean,
        },
        'hasUnknownModelCost',
      ],
      [
        'non-array model usage',
        { ...emptySummary, modelUsage: 'none' as unknown as CostModelUsage[] },
        'modelUsage',
      ],
      [
        'empty model name',
        {
          ...emptySummary,
          modelUsage: [
            {
              model: '',
              canonicalName: 'M',
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            },
          ],
        },
        'model',
      ],
      [
        'empty canonical name',
        {
          ...emptySummary,
          modelUsage: [
            {
              model: 'm',
              canonicalName: '',
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
            },
          ],
        },
        'canonicalName',
      ],
      [
        'non-object model usage entry',
        {
          ...emptySummary,
          modelUsage: [null as unknown as CostModelUsage],
        },
        'modelUsage entries',
      ],
      [
        'fractional input tokens',
        {
          ...emptySummary,
          modelUsage: [
            {
              model: 'm',
              canonicalName: 'M',
              inputTokens: 1.5,
              outputTokens: 0,
              costUsd: 0,
            },
          ],
        },
        'inputTokens',
      ],
      [
        'negative output tokens',
        {
          ...emptySummary,
          modelUsage: [
            {
              model: 'm',
              canonicalName: 'M',
              inputTokens: 0,
              outputTokens: -1,
              costUsd: 0,
            },
          ],
        },
        'outputTokens',
      ],
      [
        'negative costUsd',
        {
          ...emptySummary,
          modelUsage: [
            {
              model: 'm',
              canonicalName: 'M',
              inputTokens: 0,
              outputTokens: 0,
              costUsd: -0.1,
            },
          ],
        },
        'costUsd',
      ],
      [
        'non-finite costUsd',
        {
          ...emptySummary,
          modelUsage: [
            {
              model: 'm',
              canonicalName: 'M',
              inputTokens: 0,
              outputTokens: 0,
              costUsd: Number.POSITIVE_INFINITY,
            },
          ],
        },
        'costUsd',
      ],
      [
        'fractional cache read tokens',
        {
          ...emptySummary,
          modelUsage: [
            {
              model: 'm',
              canonicalName: 'M',
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 1.5,
              costUsd: 0,
            },
          ],
        },
        'cacheReadInputTokens',
      ],
      [
        'fractional web search requests',
        {
          ...emptySummary,
          modelUsage: [
            {
              model: 'm',
              canonicalName: 'M',
              inputTokens: 0,
              outputTokens: 0,
              webSearchRequests: 2.5,
              costUsd: 0,
            },
          ],
        },
        'webSearchRequests',
      ],
    ])('throws TypeError for %s', (_label, summary, field) => {
      const format = (): string => formatCostSummary(summary)
      expect(format).toThrow(TypeError)
      expect(format).toThrow(new RegExp(field))
    })
  })
})
