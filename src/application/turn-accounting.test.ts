import { describe, expect, it } from 'vitest'

import { ModelPricingRegistry } from '../core/usage.js'
import { ClaudeSessionCostTracker } from './session-cost-tracker.js'
import { TurnAccounting } from './turn-accounting.js'

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
})

function tracker() {
  return new ClaudeSessionCostTracker({
    sessionId: 'turn-accounting-test',
    now: () => 0,
  })
}

describe('TurnAccounting', () => {
  it('preflights compaction without mutation and commits once against latest state', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    const compactUsage = usage(2, 1)
    const compactInput = {
      model: 'compact-model',
      usage: compactUsage,
      durationApiMs: 4,
      durationApiWithoutRetriesMs: 3,
    }
    const prepared = accounting.prepareCompaction({
      ...compactInput,
    })
    compactUsage.inputTokens = 99
    compactInput.model = 'mutated-model'
    expect(cost.snapshot()).toMatchObject({
      apiDurationMs: 0,
      apiDurationWithoutRetriesMs: 0,
      modelUsage: {},
    })

    cost.recordTurn({ model: 'other-model', usage: usage(1, 1) })
    prepared.commit()

    expect(cost.snapshot()).toMatchObject({
      apiDurationMs: 4,
      apiDurationWithoutRetriesMs: 3,
      modelUsage: {
        'other-model': expect.objectContaining({ inputTokens: 1 }),
        'compact-model': expect.objectContaining({ inputTokens: 2 }),
      },
    })
    const outcome = accounting.complete({
      kind: 'runtime',
      recovery: [],
      result: { usage: usage(0, 0) },
    })
    expect(outcome.modelUsage).toEqual({ 'compact-model': usage(2, 1) })
    expect(() => prepared.commit()).toThrow(
      'Prepared compaction accounting was already committed',
    )
  })

  it('keeps inclusive runtime output separate from unrecorded tracker metrics', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({
      tracker: cost,
      pricing: new ModelPricingRegistry({
        'compact-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
        'runtime-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })
    const compact = accounting.prepareCompaction({
      model: 'compact-model',
      usage: usage(2, 1),
      durationApiMs: 4,
      durationApiWithoutRetriesMs: 4,
    })
    compact.commit()

    const outcome = accounting.complete({
      kind: 'runtime',
      recovery: [],
      result: {
        usage: usage(5, 3),
        modelUsage: {
          'runtime-model': {
            ...usage(5, 3),
            contextWindow: 100,
          },
        },
        unrecordedModelUsage: {},
        durationApiMs: 6,
        durationApiWithoutRetriesMs: 5,
        unrecordedDurationApiMs: 0,
        unrecordedDurationApiWithoutRetriesMs: 0,
        durationToolMs: 7,
        linesAdded: 2,
        linesRemoved: 1,
      },
    })
    expect(outcome).toMatchObject({
      usage: usage(7, 4),
      durationApiMs: 10,
      modelUsage: {
        'compact-model': usage(2, 1),
        'runtime-model': expect.objectContaining({
          inputTokens: 5,
          contextWindow: 100,
        }),
      },
    })
    expect(cost.snapshot()).toMatchObject({
      apiDurationMs: 4,
      apiDurationWithoutRetriesMs: 4,
      toolDurationMs: 7,
      linesAdded: 2,
      linesRemoved: 1,
      modelUsage: {
        'compact-model': expect.objectContaining({ inputTokens: 2 }),
      },
    })
    expect(cost.snapshot().modelUsage['runtime-model']).toBeUndefined()
  })

  it('applies recovery and shell asymmetry exactly', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    const outcome = accounting.complete({
      kind: 'shell',
      recovery: [
        {
          isError: true,
          usage: {
            ...usage(1, 1),
            cacheCreationInputTokens: 1,
            cacheCreationInputTokens1h: 1,
          },
          modelUsage: { 'recovery-model': usage(1, 1) },
          durationApiMs: 100,
          durationToolMs: 2,
          linesAdded: 10,
        },
        {
          isError: false,
          usage: {
            ...usage(2, 1),
            cacheCreationInputTokens: 2,
            cacheCreationInputTokens1h: 2,
          },
          modelUsage: {
            'recovery-model': {
              ...usage(2, 1),
              cacheCreationInputTokens: 2,
              cacheCreationInputTokens1h: 2,
            },
          },
          durationApiMs: 100,
          durationToolMs: 3,
          linesAdded: 4,
        },
      ],
      result: {
        isError: true,
        usage: {
          ...usage(3, 2),
          cacheCreationInputTokens: 3,
          cacheCreationInputTokens1h: 3,
        },
        modelUsage: { 'shell-model': usage(3, 2) },
        durationApiMs: 7,
        durationToolMs: 5,
        linesAdded: 20,
      },
    })
    expect(outcome).toMatchObject({
      usage: {
        ...usage(6, 4),
        cacheCreationInputTokens: 6,
        cacheCreationInputTokens1h: 6,
      },
      modelUsage: {
        'recovery-model': {
          ...usage(2, 1),
          cacheCreationInputTokens: 2,
          cacheCreationInputTokens1h: 2,
        },
      },
      durationApiMs: 7,
    })
    expect(cost.snapshot()).toMatchObject({
      apiDurationMs: 7,
      apiDurationWithoutRetriesMs: 7,
      toolDurationMs: 10,
      linesAdded: 4,
      linesRemoved: 0,
    })
    expect(cost.snapshot().modelUsage['shell-model']).toBeUndefined()
  })

  it('records successful shell usage, cost, durations, and lines while ignoring recovery API durations', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({
      tracker: cost,
      pricing: new ModelPricingRegistry({
        'recovery-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
        'shell-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })
    const outcome = accounting.complete({
      kind: 'shell',
      recovery: [
        {
          isError: false,
          usage: usage(2, 1),
          modelUsage: { 'recovery-model': usage(2, 1) },
          durationApiMs: 1000,
          durationApiWithoutRetriesMs: 900,
          durationToolMs: 3,
          linesAdded: 4,
          linesRemoved: 2,
        },
      ],
      result: {
        isError: false,
        usage: usage(5, 2),
        modelUsage: { 'shell-model': usage(5, 2) },
        durationApiMs: 11,
        durationApiWithoutRetriesMs: 9,
        durationToolMs: 7,
        linesAdded: 6,
        linesRemoved: 1,
      },
    })
    expect(outcome).toMatchObject({
      usage: usage(7, 3),
      modelUsage: {
        'recovery-model': usage(2, 1),
        'shell-model': usage(5, 2),
      },
      durationApiMs: 11,
    })
    expect(outcome.costUsd).toBeCloseTo(10 / 1_000_000)
    expect(cost.snapshot()).toMatchObject({
      apiDurationMs: 11,
      apiDurationWithoutRetriesMs: 9,
      toolDurationMs: 10,
      linesAdded: 10,
      linesRemoved: 3,
      hasUnknownModelCost: false,
    })
  })

  it('sums known public cost while retaining unknown tracker rows', () => {
    const priced = tracker()
    const accounting = new TurnAccounting({
      tracker: priced,
      pricing: new ModelPricingRegistry({
        known: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })
    const outcome = accounting.complete({
      kind: 'runtime',
      recovery: [],
      result: {
        usage: usage(3, 3),
        modelUsage: {
          known: usage(1, 1),
          unknown: usage(2, 2),
        },
      },
    })
    expect(outcome.costUsd).toBe(2 / 1_000_000)
    expect(priced.snapshot().modelUsage).toEqual(
      expect.objectContaining({
        known: expect.anything(),
        unknown: expect.anything(),
      }),
    )
    expect(priced.snapshot().hasUnknownModelCost).toBe(true)

    const allUnknown = tracker()
    const unknownAccounting = new TurnAccounting({ tracker: allUnknown })
    const unknownOutcome = unknownAccounting.complete({
      kind: 'runtime',
      recovery: [],
      result: {
        usage: usage(1, 1),
        modelUsage: { unknown: usage(1, 1) },
      },
    })
    expect(unknownOutcome.costUsd).toBeUndefined()
    expect(allUnknown.snapshot().modelUsage.unknown).toMatchObject({
      inputTokens: 1,
      outputTokens: 1,
    })
    expect(allUnknown.snapshot().hasUnknownModelCost).toBe(true)
  })

  it('leaves live state unchanged when aggregate validation fails', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    const before = cost.snapshot()
    expect(() =>
      accounting.complete({
        kind: 'runtime',
        recovery: [
          {
            isError: false,
            modelUsage: {
              same: { ...usage(1, 1), contextWindow: 100 },
            },
          },
        ],
        result: {
          usage: usage(1, 1),
          modelUsage: {
            same: { ...usage(1, 1), contextWindow: 200 },
          },
        },
      }),
    ).toThrow('conflicting contextWindow values')
    expect(cost.snapshot()).toMatchObject({
      apiDurationMs: before.apiDurationMs,
      modelUsage: {},
      totalCostUsd: 0,
    })
  })

  it('retains a zero compaction model row only in public output', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    const prepared = accounting.prepareCompaction({
      model: 'zero-model',
      usage: usage(0, 0),
      durationApiMs: 0,
      durationApiWithoutRetriesMs: 0,
    })
    prepared.commit()
    const outcome = accounting.complete({
      kind: 'runtime',
      recovery: [],
      result: { usage: usage(0, 0) },
    })
    expect(outcome.modelUsage).toEqual({ 'zero-model': usage(0, 0) })
    expect(cost.snapshot().modelUsage['zero-model']).toBeUndefined()
  })

  it('allows one successful completion and retries after failed validation', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    expect(() =>
      accounting.complete({
        kind: 'runtime',
        recovery: [
          {
            isError: false,
            modelUsage: {
              same: { ...usage(1, 1), contextWindow: 100 },
            },
          },
        ],
        result: {
          usage: usage(1, 1),
          modelUsage: {
            same: { ...usage(1, 1), contextWindow: 200 },
          },
        },
      }),
    ).toThrow('conflicting contextWindow values')
    expect(cost.snapshot().modelUsage).toEqual({})

    const successful = accounting.complete({
      kind: 'runtime',
      recovery: [],
      result: {
        usage: usage(2, 1),
        modelUsage: { successful: usage(2, 1) },
        durationApiMs: 4,
        durationApiWithoutRetriesMs: 3,
        durationToolMs: 6,
        linesAdded: 2,
        linesRemoved: 1,
      },
    })
    expect(successful).toMatchObject({
      usage: usage(2, 1),
      modelUsage: { successful: usage(2, 1) },
      durationApiMs: 4,
    })
    const afterSuccess = cost.snapshot()
    expect(() =>
      accounting.complete({
        kind: 'runtime',
        recovery: [],
        result: { usage: usage(1, 1) },
      }),
    ).toThrow('Turn accounting is already complete')
    expect(cost.snapshot()).toEqual(afterSuccess)
  })

  it('rejects outstanding plans and prepare after completion', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    const prepared = accounting.prepareCompaction({
      model: 'compact-model',
      usage: usage(1, 0),
      durationApiMs: 0,
      durationApiWithoutRetriesMs: 0,
    })
    expect(() =>
      accounting.prepareCompaction({
        model: 'other-model',
        usage: usage(0, 0),
        durationApiMs: 0,
        durationApiWithoutRetriesMs: 0,
      }),
    ).toThrow('already outstanding')
    expect(() =>
      accounting.complete({
        kind: 'runtime',
        recovery: [],
        result: { usage: usage(0, 0) },
      }),
    ).toThrow('accounting is outstanding')
    prepared.commit()
    accounting.complete({
      kind: 'runtime',
      recovery: [],
      result: { usage: usage(0, 0) },
    })
    expect(() =>
      accounting.prepareCompaction({
        model: 'after-model',
        usage: usage(0, 0),
        durationApiMs: 0,
        durationApiWithoutRetriesMs: 0,
      }),
    ).toThrow('after turn completion')
  })

  it('fails a prepared commit against latest tracker state without contribution', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    const prepared = accounting.prepareCompaction({
      model: 'same-model',
      usage: usage(1, 0),
      durationApiMs: 2,
      durationApiWithoutRetriesMs: 2,
    })
    cost.recordTurn({
      model: 'same-model',
      usage: usage(Number.MAX_SAFE_INTEGER, 0),
    })
    const before = cost.snapshot()
    expect(() => prepared.commit()).toThrow(
      'inputTokens total must be a safe integer',
    )
    expect(cost.snapshot()).toMatchObject({
      modelUsage: before.modelUsage,
      apiDurationMs: before.apiDurationMs,
    })
    expect(() => prepared.commit()).toThrow('already committed')
    const outcome = accounting.complete({
      kind: 'runtime',
      recovery: [],
      result: { usage: usage(0, 0) },
    })
    expect(outcome).toEqual({ usage: usage(0, 0) })
  })

  it('preflights cumulative compaction overflow and metadata conflicts', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    accounting
      .prepareCompaction({
        model: 'compact-model',
        usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 },
        durationApiMs: 0,
        durationApiWithoutRetriesMs: 0,
      })
      .commit()
    const before = cost.snapshot()
    expect(() =>
      accounting.prepareCompaction({
        model: 'compact-model',
        usage: usage(1, 0),
        durationApiMs: 0,
        durationApiWithoutRetriesMs: 0,
      }),
    ).toThrow('Model usage total overflow')
    expect(cost.snapshot()).toMatchObject({ modelUsage: before.modelUsage })

    const metadataCost = tracker()
    const metadataAccounting = new TurnAccounting({ tracker: metadataCost })
    metadataAccounting
      .prepareCompaction({
        model: 'metadata-model',
        usage: { ...usage(1, 0), contextWindow: 100 },
        durationApiMs: 0,
        durationApiWithoutRetriesMs: 0,
      })
      .commit()
    const metadataBefore = metadataCost.snapshot()
    expect(() =>
      metadataAccounting.prepareCompaction({
        model: 'metadata-model',
        usage: { ...usage(1, 0), contextWindow: 200 },
        durationApiMs: 0,
        durationApiWithoutRetriesMs: 0,
      }),
    ).toThrow('conflicting contextWindow values')
    expect(metadataCost.snapshot()).toMatchObject({
      modelUsage: metadataBefore.modelUsage,
      apiDurationMs: metadataBefore.apiDurationMs,
    })
  })

  it('validates metadata across successful recovery and unrecorded runtime rows', () => {
    const cost = tracker()
    const accounting = new TurnAccounting({ tracker: cost })
    const before = cost.snapshot()
    expect(() =>
      accounting.complete({
        kind: 'runtime',
        recovery: [
          {
            isError: false,
            modelUsage: { same: { ...usage(1, 0), contextWindow: 100 } },
          },
        ],
        result: {
          usage: usage(1, 0),
          modelUsage: { same: { ...usage(1, 0), contextWindow: 100 } },
          unrecordedModelUsage: {
            same: { ...usage(1, 0), contextWindow: 200 },
          },
        },
      }),
    ).toThrow('conflicting contextWindow values')
    expect(cost.snapshot()).toMatchObject({
      modelUsage: before.modelUsage,
      apiDurationMs: before.apiDurationMs,
    })

    const invalidCost = tracker()
    const invalidAccounting = new TurnAccounting({ tracker: invalidCost })
    const invalidBefore = invalidCost.snapshot()
    expect(() =>
      invalidAccounting.complete({
        kind: 'runtime',
        recovery: [],
        result: {
          usage: {
            ...usage(1, 0),
            cacheCreationInputTokens: 1,
            cacheCreationInputTokens1h: 2,
          },
        },
      }),
    ).toThrow('Model usage has an invalid cacheCreationInputTokens1h counter')
    expect(invalidCost.snapshot()).toEqual(invalidBefore)
  })

  it('preflights tracker overflow before duration and line mutations', () => {
    const cost = tracker()
    cost.recordTurn({
      model: 'overflow',
      usage: usage(Number.MAX_SAFE_INTEGER, 0),
    })
    const accounting = new TurnAccounting({ tracker: cost })
    const before = cost.snapshot()
    expect(() =>
      accounting.complete({
        kind: 'runtime',
        recovery: [],
        result: {
          usage: usage(1, 0),
          modelUsage: { overflow: usage(1, 0) },
          durationApiMs: 10,
          durationToolMs: 20,
          linesAdded: 3,
          linesRemoved: 2,
        },
      }),
    ).toThrow('inputTokens total must be a safe integer')
    expect(cost.snapshot()).toEqual(before)
  })
})
