import { describe, expect, it } from 'vitest'

import type { ClaudeSessionCostState } from '../persistence/claude-cost-state-store.js'
import { ClaudeSessionCostTracker } from './session-cost-tracker.js'

function restoredState(
  overrides: Partial<ClaudeSessionCostState> = {},
): ClaudeSessionCostState {
  return {
    sessionId: 's1',
    totalCostUsd: 0,
    apiDurationMs: 0,
    apiDurationWithoutRetriesMs: 0,
    toolDurationMs: 0,
    wallDurationMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
    modelUsage: {},
    ...overrides,
  }
}

describe('ClaudeSessionCostTracker', () => {
  it('initializes an exact zero state with empty model usage', () => {
    const now = () => 5_000
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1', now })

    expect(tracker.snapshot()).toEqual({
      sessionId: 's1',
      totalCostUsd: 0,
      apiDurationMs: 0,
      apiDurationWithoutRetriesMs: 0,
      toolDurationMs: 0,
      wallDurationMs: 0,
      linesAdded: 0,
      linesRemoved: 0,
      modelUsage: {},
      hasUnknownModelCost: false,
    })
  })

  it('accumulates wall duration from the injected clock', () => {
    let currentTime = 1_000
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      now: () => currentTime,
    })

    currentTime = 3_500

    expect(tracker.snapshot().wallDurationMs).toBe(2_500)
  })

  it('restores persisted state and resumes the wall duration', () => {
    let currentTime = 100_000
    const restored = restoredState({
      totalCostUsd: 1.25,
      apiDurationMs: 500,
      apiDurationWithoutRetriesMs: 400,
      toolDurationMs: 300,
      wallDurationMs: 12_000,
      linesAdded: 10,
      linesRemoved: 4,
      modelUsage: {
        'claude-sonnet-4': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 1.25,
        },
      },
    })
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      restored,
      now: () => currentTime,
    })

    currentTime = 115_000
    const snapshot = tracker.snapshot()

    expect(snapshot.wallDurationMs).toBe(27_000)
    expect(snapshot.totalCostUsd).toBe(1.25)
    expect(snapshot.apiDurationMs).toBe(500)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(400)
    expect(snapshot.toolDurationMs).toBe(300)
    expect(snapshot.linesAdded).toBe(10)
    expect(snapshot.linesRemoved).toBe(4)
    expect(snapshot.modelUsage['claude-sonnet-4']).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 1.25,
    })
    expect(snapshot.hasUnknownModelCost).toBe(false)
  })

  it('does not resume wall duration when restored duration is zero', () => {
    let currentTime = 100_000
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      restored: restoredState(),
      now: () => currentTime,
    })

    currentTime = 105_000

    expect(tracker.snapshot().wallDurationMs).toBe(5_000)
  })

  it('aggregates repeated models while preserving first-insertion order', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.01,
    })
    tracker.recordTurn({
      model: 'model-b',
      usage: { inputTokens: 20, outputTokens: 6 },
      costUsd: 0.02,
    })
    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 3, outputTokens: 2 },
      costUsd: 0.005,
    })

    const snapshot = tracker.snapshot()
    expect(Object.keys(snapshot.modelUsage)).toEqual(['model-a', 'model-b'])
    expect(snapshot.modelUsage['model-a']).toEqual({
      inputTokens: 13,
      outputTokens: 7,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0.015,
    })
    expect(snapshot.modelUsage['model-b']).toEqual({
      inputTokens: 20,
      outputTokens: 6,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUsd: 0.02,
    })
    expect(snapshot.totalCostUsd).toBeCloseTo(0.035, 10)
  })

  it('flags unknown model cost and keeps the flag for the session', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 10, outputTokens: 5 },
    })

    let snapshot = tracker.snapshot()
    expect(snapshot.hasUnknownModelCost).toBe(true)
    expect(snapshot.totalCostUsd).toBe(0)
    expect(snapshot.modelUsage['model-a']?.costUsd).toBe(0)

    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 0.5,
    })

    snapshot = tracker.snapshot()
    expect(snapshot.hasUnknownModelCost).toBe(true)
    expect(snapshot.totalCostUsd).toBe(0.5)
    expect(snapshot.modelUsage['model-a']?.costUsd).toBe(0.5)
  })

  it('does not flag unknown cost for a costless turn without usage', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    expect(tracker.snapshot().hasUnknownModelCost).toBe(false)
  })

  it('totals cache, search, duration, tool, and line metrics per turn', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordTurn({
      model: 'model-a',
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 30,
      },
      webSearchRequests: 3,
      costUsd: 0.75,
      apiDurationMs: 1_200,
      apiDurationWithoutRetriesMs: 1_000,
      toolDurationMs: 800,
      linesAdded: 5,
      linesRemoved: 2,
    })

    const snapshot = tracker.snapshot()
    expect(snapshot.modelUsage['model-a']).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 30,
      webSearchRequests: 3,
      costUsd: 0.75,
    })
    expect(snapshot.apiDurationMs).toBe(1_200)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(1_000)
    expect(snapshot.toolDurationMs).toBe(800)
    expect(snapshot.linesAdded).toBe(5)
    expect(snapshot.linesRemoved).toBe(2)
  })

  it('mirrors api duration into the without-retries total when omitted', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 1, outputTokens: 1 },
      apiDurationMs: 400,
    })

    const snapshot = tracker.snapshot()
    expect(snapshot.apiDurationMs).toBe(400)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(400)
  })

  it('records global durations independently of model usage rows', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordDurations({
      apiDurationMs: 500,
      apiDurationWithoutRetriesMs: 400,
      toolDurationMs: 300,
    })

    const snapshot = tracker.snapshot()
    expect(snapshot.apiDurationMs).toBe(500)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(400)
    expect(snapshot.toolDurationMs).toBe(300)
    expect(snapshot.modelUsage).toEqual({})
    expect(snapshot.totalCostUsd).toBe(0)
  })

  it('accumulates recordDurations and mirrors the api total when retry-free is omitted', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordDurations({ apiDurationMs: 400 })
    tracker.recordDurations({ apiDurationMs: 100, toolDurationMs: 50 })
    tracker.recordDurations({ apiDurationMs: 25, toolDurationMs: 75 })

    const snapshot = tracker.snapshot()
    expect(snapshot.apiDurationMs).toBe(525)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(525)
    expect(snapshot.toolDurationMs).toBe(125)
  })

  it('adds nothing when no duration is supplied', () => {
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      now: () => 100,
    })
    tracker.recordDurations({ apiDurationMs: 100 })

    const before = tracker.snapshot()
    tracker.recordDurations({})

    expect(tracker.snapshot()).toEqual(before)
  })

  it('rejects invalid recordDurations values atomically', () => {
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      now: () => 100,
    })
    tracker.recordDurations({ apiDurationMs: 100, toolDurationMs: 50 })

    const before = tracker.snapshot()

    expect(() => tracker.recordDurations({ apiDurationMs: -1 })).toThrow(
      TypeError,
    )
    expect(tracker.snapshot()).toEqual(before)
    expect(() => tracker.recordDurations({ apiDurationMs: NaN })).toThrow(
      TypeError,
    )
    expect(tracker.snapshot()).toEqual(before)
    expect(() => tracker.recordDurations({ apiDurationMs: Infinity })).toThrow(
      TypeError,
    )
    expect(tracker.snapshot()).toEqual(before)
    expect(() =>
      tracker.recordDurations({ apiDurationWithoutRetriesMs: -5 }),
    ).toThrow(TypeError)
    expect(tracker.snapshot()).toEqual(before)
    expect(() => tracker.recordDurations({ toolDurationMs: -1 })).toThrow(
      TypeError,
    )
    expect(tracker.snapshot()).toEqual(before)
    expect(() => tracker.recordDurations({ toolDurationMs: NaN })).toThrow(
      TypeError,
    )
    expect(tracker.snapshot()).toEqual(before)
  })

  it('rejects recordDurations overflow atomically', () => {
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      now: () => 100,
    })
    tracker.recordDurations({ apiDurationMs: 1e308, toolDurationMs: 1e308 })

    const before = tracker.snapshot()

    expect(() => tracker.recordDurations({ apiDurationMs: 1e308 })).toThrow(
      TypeError,
    )
    expect(tracker.snapshot()).toEqual(before)
    expect(() => tracker.recordDurations({ toolDurationMs: 1e308 })).toThrow(
      TypeError,
    )
    expect(tracker.snapshot()).toEqual(before)
  })

  it('rejects an invalid turn tool duration atomically via the shared duration validation', () => {
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      now: () => 100,
    })
    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 1, outputTokens: 1 },
      toolDurationMs: 5,
    })

    const before = tracker.snapshot()

    expect(() =>
      tracker.recordTurn({
        model: 'model-a',
        usage: { inputTokens: 1, outputTokens: 1 },
        toolDurationMs: -1,
      }),
    ).toThrow(TypeError)
    expect(tracker.snapshot()).toEqual(before)
  })

  it('treats omitted metrics as zero', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 1, outputTokens: 1 },
    })

    const snapshot = tracker.snapshot()
    expect(snapshot.apiDurationMs).toBe(0)
    expect(snapshot.apiDurationWithoutRetriesMs).toBe(0)
    expect(snapshot.toolDurationMs).toBe(0)
    expect(snapshot.linesAdded).toBe(0)
    expect(snapshot.linesRemoved).toBe(0)
  })

  it('accumulates background line changes independently of model turns', async () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })
    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 5, outputTokens: 1 },
      linesAdded: 1,
    })

    await Promise.all([
      Promise.resolve().then(() =>
        tracker.recordLineChanges({ linesAdded: 4 }),
      ),
      Promise.resolve().then(() =>
        tracker.recordLineChanges({ linesRemoved: 3 }),
      ),
      Promise.resolve().then(() =>
        tracker.recordLineChanges({ linesAdded: 2, linesRemoved: 1 }),
      ),
    ])

    const snapshot = tracker.snapshot()
    expect(snapshot.linesAdded).toBe(7)
    expect(snapshot.linesRemoved).toBe(4)
  })

  it('treats omitted line metrics as zero', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })

    tracker.recordLineChanges({ linesAdded: 3 })

    const snapshot = tracker.snapshot()
    expect(snapshot.linesAdded).toBe(3)
    expect(snapshot.linesRemoved).toBe(0)
  })

  it('returns fresh snapshot objects that cannot mutate tracker state', () => {
    const tracker = new ClaudeSessionCostTracker({ sessionId: 's1' })
    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.5,
    })

    const first = tracker.snapshot()
    const second = tracker.snapshot()
    expect(first).not.toBe(second)
    expect(first.modelUsage['model-a']).not.toBe(second.modelUsage['model-a'])

    const mutable = first as unknown as {
      totalCostUsd: number
      wallDurationMs: number
      hasUnknownModelCost: boolean
      modelUsage: { 'model-a': { inputTokens: number; costUsd: number } }
    }
    mutable.totalCostUsd = 999
    mutable.wallDurationMs = 999
    mutable.hasUnknownModelCost = true
    mutable.modelUsage['model-a'].inputTokens = 999
    mutable.modelUsage['model-a'].costUsd = 999

    const fresh = tracker.snapshot()
    expect(fresh.totalCostUsd).toBe(0.5)
    expect(fresh.hasUnknownModelCost).toBe(false)
    expect(fresh.modelUsage['model-a']?.inputTokens).toBe(10)
    expect(fresh.modelUsage['model-a']?.costUsd).toBe(0.5)
  })

  it('copies restored state so caller-owned aliases cannot affect the tracker', () => {
    const restored = {
      sessionId: 's1',
      totalCostUsd: 1.25,
      apiDurationMs: 500,
      apiDurationWithoutRetriesMs: 400,
      toolDurationMs: 300,
      wallDurationMs: 12_000,
      linesAdded: 10,
      linesRemoved: 4,
      modelUsage: {
        'model-a': {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUsd: 1.25,
        },
      },
    }
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      restored,
    })

    restored.totalCostUsd = 999
    restored.modelUsage['model-a'].inputTokens = 999

    const snapshot = tracker.snapshot()
    expect(snapshot.totalCostUsd).toBe(1.25)
    expect(snapshot.modelUsage['model-a']?.inputTokens).toBe(100)
  })

  it('rejects a blank session id', () => {
    expect(() => new ClaudeSessionCostTracker({ sessionId: '  ' })).toThrow(
      TypeError,
    )
  })

  it('rejects a restored state with a different session id', () => {
    const restored = restoredState({ sessionId: 'other' })

    expect(
      () => new ClaudeSessionCostTracker({ sessionId: 's1', restored }),
    ).toThrow(TypeError)
  })

  it('rejects invalid turn input atomically, leaving the prior snapshot unchanged', () => {
    const currentTime = 50_000
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      now: () => currentTime,
    })
    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0.1,
      apiDurationMs: 100,
      linesAdded: 2,
      linesRemoved: 1,
    })

    const before = tracker.snapshot()

    const invalidTurns = [
      { model: ' ', usage: { inputTokens: 1, outputTokens: 1 } },
      { model: 'model-a', usage: { inputTokens: -1, outputTokens: 1 } },
      { model: 'model-a', usage: { inputTokens: 1, outputTokens: 1.5 } },
      {
        model: 'model-a',
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: -0.5,
      },
      {
        model: 'model-a',
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: NaN,
      },
      {
        model: 'model-a',
        usage: { inputTokens: 1, outputTokens: 1 },
        apiDurationMs: Infinity,
      },
      {
        model: 'model-a',
        usage: { inputTokens: 1, outputTokens: 1 },
        webSearchRequests: -2,
      },
      {
        model: 'model-a',
        usage: { inputTokens: 1, outputTokens: 1 },
        linesAdded: 2.5,
      },
    ] as const

    for (const invalid of invalidTurns) {
      expect(() => tracker.recordTurn(invalid)).toThrow(TypeError)
      expect(tracker.snapshot()).toEqual(before)
    }

    expect(() => tracker.recordLineChanges({ linesAdded: -1 })).toThrow(
      TypeError,
    )
    expect(tracker.snapshot()).toEqual(before)
  })

  it('rejects safe-integer overflow atomically', () => {
    const currentTime = 100
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      now: () => currentTime,
    })
    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
    })

    const before = tracker.snapshot()

    expect(() =>
      tracker.recordTurn({
        model: 'model-a',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    ).toThrow(TypeError)
    expect(tracker.snapshot()).toEqual(before)
  })

  it('rejects finite cost overflow atomically', () => {
    const currentTime = 100
    const tracker = new ClaudeSessionCostTracker({
      sessionId: 's1',
      now: () => currentTime,
    })
    tracker.recordTurn({
      model: 'model-a',
      usage: { inputTokens: 1, outputTokens: 1 },
      costUsd: 1e308,
    })

    const before = tracker.snapshot()

    expect(() =>
      tracker.recordTurn({
        model: 'model-a',
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 1e308,
      }),
    ).toThrow(TypeError)
    expect(tracker.snapshot()).toEqual(before)
  })
})
