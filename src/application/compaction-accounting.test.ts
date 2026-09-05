import { describe, expect, it, vi } from 'vitest'
import type { TranscriptEvent } from '../core/transcript-event.js'
import { ModelPricingRegistry } from '../core/usage.js'
import type {
  CompactionReceiptStore,
  NativeCompactionReceipt,
} from '../persistence/native-compaction-receipt-store.js'
import { CompactionAccounting } from './compaction-accounting.js'
import { CompactionTransactionError } from './compaction-errors.js'
import { ClaudeSessionCostTracker } from './session-cost-tracker.js'
import type { TurnCompactionMetric } from './turn-accounting.js'

interface MutableReceiptRow {
  receipt: NativeCompactionReceipt
  acknowledged: boolean
}

const defaultMetric: TurnCompactionMetric = {
  model: 'compact-model',
  usage: { inputTokens: 2, outputTokens: 1 },
  durationApiMs: 4,
  durationApiWithoutRetriesMs: 3,
}

function tracker(sessionId = 'session'): ClaudeSessionCostTracker {
  return new ClaudeSessionCostTracker({ sessionId, now: () => 0 })
}

function ids(...values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? `generated-${index}`
}

function memoryStore(initial: MutableReceiptRow[] = []) {
  const rows = initial
  const prepare = vi.fn(async (receipt: NativeCompactionReceipt) => {
    rows.push({ receipt: structuredClone(receipt), acknowledged: false })
  })
  const acknowledge = vi.fn(async (sessionId: string, receiptId: string) => {
    const row = rows.find(
      (candidate) =>
        candidate.receipt.sessionId === sessionId &&
        candidate.receipt.receiptId === receiptId,
    )
    if (!row) throw new Error('receipt missing')
    row.acknowledged = true
  })
  const list = vi.fn(async (sessionId: string) =>
    rows
      .filter((row) => row.receipt.sessionId === sessionId)
      .map((row) => ({ ...row, receipt: structuredClone(row.receipt) })),
  )
  const store: CompactionReceiptStore = { prepare, acknowledge, list }
  return { rows, store, prepare, acknowledge, list }
}

function transcriptFor(
  receipts: readonly NativeCompactionReceipt[],
): TranscriptEvent[] {
  const events: TranscriptEvent[] = [
    {
      kind: 'messages',
      id: 'root',
      parentId: null,
      sessionId: receipts[0]?.sessionId ?? 'session',
      timestamp: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'before' }],
    },
  ]
  for (const receipt of receipts) {
    events.push(
      {
        kind: 'context-boundary',
        id: receipt.boundaryId,
        parentId: null,
        sessionId: receipt.sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        logicalParentId: 'root',
        trigger: receipt.trigger,
        preTokens: 10,
        postTokens: 2,
        durationMs: receipt.metric.durationApiMs,
      },
      {
        kind: 'context-summary',
        id: receipt.summaryId,
        parentId: receipt.boundaryId,
        sessionId: receipt.sessionId,
        timestamp: '2026-01-01T00:00:00.000Z',
        summary: 'summary',
      },
    )
  }
  return events
}

async function prepareOne(options: {
  sessionId?: string
  activeTracker?: ClaudeSessionCostTracker
  metric?: TurnCompactionMetric
  pricing?: ModelPricingRegistry
  createId?: () => string
  receiptState?: ReturnType<typeof memoryStore>
  costStateStore?: { save(snapshot: unknown): Promise<void> }
  recoverBeforePrepare?: boolean
}) {
  const sessionId = options.sessionId ?? 'session'
  const activeTracker = options.activeTracker ?? tracker(sessionId)
  const receiptState = options.receiptState ?? memoryStore()
  const accounting = new CompactionAccounting({
    sessionId,
    tracker: activeTracker,
    receiptStore: receiptState.store,
    readTranscript: async () =>
      transcriptFor(receiptState.rows.map((row) => row.receipt)),
    createId: options.createId ?? ids('receipt', 'boundary', 'summary'),
    ...(options.pricing ? { pricing: options.pricing } : {}),
    ...(options.costStateStore
      ? { costStateStore: options.costStateStore }
      : {}),
  })
  if (options.recoverBeforePrepare) await accounting.recover()
  const transaction = await accounting.prepare({
    trigger: 'manual',
    metric: options.metric ?? defaultMetric,
  })
  const receipt = receiptState.rows.at(-1)?.receipt
  if (!receipt) throw new Error('receipt was not prepared')
  return { accounting, activeTracker, receiptState, transaction, receipt }
}

describe('CompactionAccounting', () => {
  it('publishes synchronously, saves before acknowledgement, and commits once', async () => {
    const order: string[] = []
    let releaseSave: (() => void) | undefined
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('save')
          releaseSave = resolve
        }),
    )
    const receiptState = memoryStore()
    receiptState.acknowledge.mockImplementation(async () => {
      order.push('ack')
      const row = receiptState.rows[0]
      if (!row) throw new Error('receipt missing')
      row.acknowledged = true
    })
    const prepared = await prepareOne({
      receiptState,
      costStateStore: { save },
    })
    const committing = prepared.transaction.commit({
      kind: 'compaction',
      boundaryId: prepared.transaction.boundaryId,
      summaryId: prepared.transaction.summaryId,
    })

    expect(prepared.activeTracker.snapshot()).toMatchObject({
      apiDurationMs: 4,
      modelUsage: { 'compact-model': { inputTokens: 2, outputTokens: 1 } },
    })
    expect(order).toEqual(['save'])
    releaseSave?.()
    await committing
    expect(order).toEqual(['save', 'ack'])
    await expect(
      prepared.transaction.commit({
        kind: 'compaction',
        boundaryId: prepared.transaction.boundaryId,
        summaryId: prepared.transaction.summaryId,
      }),
    ).rejects.toThrow('already committed')
  })

  it('uses the prepared fixed price during recovery after pricing changes', async () => {
    const receiptState = memoryStore()
    const prepared = await prepareOne({
      receiptState,
      metric: {
        model: 'priced-model',
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
        durationApiMs: 1,
        durationApiWithoutRetriesMs: 1,
      },
      pricing: new ModelPricingRegistry({
        'priced-model': { inputPerMillionUsd: 1, outputPerMillionUsd: 1 },
      }),
    })
    const recovered = tracker()
    await new CompactionAccounting({
      sessionId: 'session',
      tracker: recovered,
      receiptStore: receiptState.store,
      pricing: new ModelPricingRegistry({
        'priced-model': {
          inputPerMillionUsd: 999,
          outputPerMillionUsd: 999,
        },
      }),
      readTranscript: async () => transcriptFor([prepared.receipt]),
    }).recover()
    expect(recovered.snapshot().totalCostUsd).toBe(1)
  })

  it('treats capacity metadata as non-metered duration-only accounting', async () => {
    const prepared = await prepareOne({
      metric: {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          contextWindow: 200_000,
          maxOutputTokens: 8_192,
        },
        durationApiMs: 2,
        durationApiWithoutRetriesMs: 1,
      },
    })
    await prepared.transaction.commit({
      kind: 'compaction',
      boundaryId: prepared.transaction.boundaryId,
      summaryId: prepared.transaction.summaryId,
    })
    expect(prepared.activeTracker.snapshot()).toMatchObject({
      apiDurationMs: 2,
      apiDurationWithoutRetriesMs: 1,
      modelUsage: {},
      hasUnknownModelCost: false,
    })
  })

  it.each([
    ['unsafe', ['../receipt', 'boundary', 'summary']],
    ['duplicate', ['same', 'same', 'summary']],
  ])(
    'classifies %s generated transaction IDs as blocked validation',
    async (_label, generated) => {
      const accounting = new CompactionAccounting({
        sessionId: 'session',
        tracker: tracker(),
        createId: ids(...generated),
      })
      await expect(
        accounting.prepare({ trigger: 'auto', metric: defaultMetric }),
      ).rejects.toMatchObject({
        metadata: {
          trigger: 'auto',
          phase: 'validation',
          durableState: 'not_committed',
          recoveryDisposition: 'blocked',
        },
      })
    },
  )

  it('does not consume a prepared transaction for a mismatched Transcript receipt', async () => {
    const prepared = await prepareOne({})
    await expect(
      prepared.transaction.commit({
        kind: 'compaction',
        boundaryId: 'wrong-boundary',
        summaryId: prepared.transaction.summaryId,
      }),
    ).rejects.toMatchObject({
      metadata: {
        phase: 'transcript_commit',
        durableState: 'indeterminate',
        recoveryDisposition: 'blocked',
      },
    })
    await prepared.transaction.commit({
      kind: 'compaction',
      boundaryId: prepared.transaction.boundaryId,
      summaryId: prepared.transaction.summaryId,
    })
    expect(
      prepared.activeTracker.snapshot().modelUsage['compact-model']
        ?.inputTokens,
    ).toBe(2)
  })

  it.each(['save', 'ack'] as const)(
    'retries recovery after %s failure without applying twice',
    async (failurePoint) => {
      const order: string[] = []
      let fail = true
      const receiptState = memoryStore()
      const save = vi.fn(async () => {
        order.push('save')
        if (failurePoint === 'save' && fail) {
          fail = false
          throw new Error('save failed')
        }
      })
      receiptState.acknowledge.mockImplementation(async () => {
        order.push('ack')
        if (failurePoint === 'ack' && fail) {
          fail = false
          throw new Error('ack failed')
        }
        const row = receiptState.rows[0]
        if (!row) throw new Error('receipt missing')
        row.acknowledged = true
      })
      const prepared = await prepareOne({
        receiptState,
        costStateStore: { save },
        recoverBeforePrepare: true,
      })
      await expect(
        prepared.transaction.commit({
          kind: 'compaction',
          boundaryId: prepared.transaction.boundaryId,
          summaryId: prepared.transaction.summaryId,
        }),
      ).rejects.toMatchObject({
        metadata: {
          phase: 'accounting_commit',
          durableState: 'committed',
          recoveryDisposition: 'reconcile',
        },
      })
      expect(
        prepared.activeTracker.snapshot().modelUsage['compact-model']
          ?.inputTokens,
      ).toBe(2)
      await prepared.accounting.recover()
      expect(
        prepared.activeTracker.snapshot().modelUsage['compact-model']
          ?.inputTokens,
      ).toBe(2)
      expect(receiptState.rows[0]?.acknowledged).toBe(true)
      expect(order.slice(-2)).toEqual(['save', 'ack'])
    },
  )

  it.each(['transcript', 'list'] as const)(
    'allows same-instance recovery retry after a %s read failure',
    async (failurePoint) => {
      let fail = true
      const receiptState = memoryStore()
      if (failurePoint === 'list')
        receiptState.list.mockImplementation(async () => {
          if (fail) {
            fail = false
            throw new Error('list failed')
          }
          return []
        })
      const readTranscript = vi.fn(async () => {
        if (failurePoint === 'transcript' && fail) {
          fail = false
          throw new Error('read failed')
        }
        return []
      })
      const accounting = new CompactionAccounting({
        sessionId: 'session',
        tracker: tracker(),
        receiptStore: receiptState.store,
        readTranscript,
      })
      await expect(accounting.recover()).rejects.toBeInstanceOf(
        CompactionTransactionError,
      )
      await expect(accounting.recover()).resolves.toBeUndefined()
    },
  )

  it('shares concurrent recovery and performs one durable scan', async () => {
    let release: (() => void) | undefined
    const receiptState = memoryStore()
    const readTranscript = vi.fn(
      () =>
        new Promise<TranscriptEvent[]>((resolve) => {
          release = () => resolve([])
        }),
    )
    const accounting = new CompactionAccounting({
      sessionId: 'session',
      tracker: tracker(),
      receiptStore: receiptState.store,
      readTranscript,
    })
    const first = accounting.recover()
    const second = accounting.recover()
    release?.()
    await Promise.all([first, second])
    expect(readTranscript).toHaveBeenCalledOnce()
    expect(receiptState.list).toHaveBeenCalledOnce()
  })

  it('leaves an orphan receipt unacknowledged and contributes zero', async () => {
    const receiptState = memoryStore()
    await prepareOne({ receiptState })
    const recovered = tracker()
    await new CompactionAccounting({
      sessionId: 'session',
      tracker: recovered,
      receiptStore: receiptState.store,
      readTranscript: async () => [],
    }).recover()
    expect(recovered.snapshot().modelUsage).toEqual({})
    expect(receiptState.rows[0]?.acknowledged).toBe(false)
  })

  it.each(['partial', 'wrong-trigger', 'duplicate'] as const)(
    'fails closed on %s Transcript evidence before tracker mutation',
    async (failureKind) => {
      const receiptState = memoryStore()
      const prepared = await prepareOne({ receiptState })
      const valid = transcriptFor([prepared.receipt])
      const boundary = valid[1]
      if (!boundary) throw new Error('boundary missing')
      const events =
        failureKind === 'partial'
          ? valid.slice(0, 2)
          : failureKind === 'duplicate'
            ? [...valid, structuredClone(boundary)]
            : valid.map((event) =>
                event.kind === 'context-boundary'
                  ? { ...event, trigger: 'auto' as const }
                  : event,
              )
      const recovered = tracker()
      await expect(
        new CompactionAccounting({
          sessionId: 'session',
          tracker: recovered,
          receiptStore: receiptState.store,
          readTranscript: async () => events,
        }).recover(),
      ).rejects.toMatchObject({
        metadata: { phase: 'recovery', recoveryDisposition: 'blocked' },
      })
      expect(recovered.snapshot().modelUsage).toEqual({})
    },
  )

  it('recovers an exact pair from the complete Transcript when it is off the active branch', async () => {
    const receiptState = memoryStore()
    const prepared = await prepareOne({ receiptState })
    const events = transcriptFor([prepared.receipt])
    events.push({
      kind: 'messages',
      id: 'alternate-leaf',
      parentId: 'root',
      sessionId: 'session',
      timestamp: '2026-01-01T00:00:00.000Z',
      messages: [{ role: 'user', content: 'active sibling' }],
    })
    const recovered = tracker()
    await new CompactionAccounting({
      sessionId: 'session',
      tracker: recovered,
      receiptStore: receiptState.store,
      readTranscript: async () => events,
    }).recover()
    expect(recovered.snapshot().modelUsage['compact-model']?.inputTokens).toBe(
      2,
    )
  })

  it('trusts acknowledged durable receipts after later cumulative tracker growth', async () => {
    const receiptState = memoryStore()
    const save = vi.fn(async () => undefined)
    const prepared = await prepareOne({
      receiptState,
      costStateStore: { save },
    })
    await prepared.transaction.commit({
      kind: 'compaction',
      boundaryId: prepared.transaction.boundaryId,
      summaryId: prepared.transaction.summaryId,
    })
    prepared.activeTracker.recordTurn({
      model: 'later-model',
      usage: { inputTokens: 3, outputTokens: 1 },
      costUsd: 0.5,
    })
    const before = prepared.activeTracker.snapshot()
    save.mockClear()
    await new CompactionAccounting({
      sessionId: 'session',
      tracker: prepared.activeTracker,
      receiptStore: receiptState.store,
      costStateStore: { save },
      readTranscript: async () => transcriptFor([prepared.receipt]),
    }).recover()
    expect(prepared.activeTracker.snapshot()).toMatchObject(before)
    expect(save).not.toHaveBeenCalled()
  })

  it('reconstructs acknowledged no-store receipts once in Transcript order', async () => {
    const receiptState = memoryStore()
    const generating = tracker()
    const first = await prepareOne({
      activeTracker: generating,
      receiptState,
      createId: ids('z-receipt', 'boundary-1', 'summary-1'),
      metric: { ...defaultMetric, usage: { inputTokens: 1, outputTokens: 0 } },
    })
    await first.transaction.commit({
      kind: 'compaction',
      boundaryId: first.transaction.boundaryId,
      summaryId: first.transaction.summaryId,
    })
    const second = await prepareOne({
      activeTracker: generating,
      receiptState,
      createId: ids('a-receipt', 'boundary-2', 'summary-2'),
      metric: { ...defaultMetric, usage: { inputTokens: 2, outputTokens: 0 } },
    })
    await second.transaction.commit({
      kind: 'compaction',
      boundaryId: second.transaction.boundaryId,
      summaryId: second.transaction.summaryId,
    })
    receiptState.list.mockImplementation(async () =>
      [...receiptState.rows].reverse().map((row) => ({ ...row })),
    )
    const recovered = tracker()
    const accounting = new CompactionAccounting({
      sessionId: 'session',
      tracker: recovered,
      receiptStore: receiptState.store,
      readTranscript: async () =>
        transcriptFor([first.receipt, second.receipt]),
    })
    await accounting.recover()
    await accounting.recover()
    expect(recovered.snapshot().modelUsage['compact-model']?.inputTokens).toBe(
      3,
    )
  })

  it('orders an unacknowledged durable chain by fingerprints instead of filenames', async () => {
    const receiptState = memoryStore()
    const generating = tracker()
    const first = await prepareOne({
      activeTracker: generating,
      receiptState,
      createId: ids('z-receipt', 'boundary-1', 'summary-1'),
      metric: { ...defaultMetric, usage: { inputTokens: 1, outputTokens: 0 } },
    })
    await first.transaction.commit({
      kind: 'compaction',
      boundaryId: first.transaction.boundaryId,
      summaryId: first.transaction.summaryId,
    })
    const second = await prepareOne({
      activeTracker: generating,
      receiptState,
      createId: ids('a-receipt', 'boundary-2', 'summary-2'),
      metric: { ...defaultMetric, usage: { inputTokens: 2, outputTokens: 0 } },
    })
    await second.transaction.commit({
      kind: 'compaction',
      boundaryId: second.transaction.boundaryId,
      summaryId: second.transaction.summaryId,
    })
    for (const row of receiptState.rows) row.acknowledged = false
    receiptState.acknowledge.mockClear()
    receiptState.list.mockImplementation(async () =>
      [...receiptState.rows].reverse().map((row) => ({ ...row })),
    )
    const recovered = tracker()
    await new CompactionAccounting({
      sessionId: 'session',
      tracker: recovered,
      receiptStore: receiptState.store,
      costStateStore: { save: vi.fn(async () => undefined) },
      readTranscript: async () =>
        transcriptFor([first.receipt, second.receipt]),
    }).recover()
    expect(recovered.snapshot().modelUsage['compact-model']?.inputTokens).toBe(
      3,
    )
    expect(receiptState.acknowledge.mock.calls.map((call) => call[1])).toEqual([
      'z-receipt',
      'a-receipt',
    ])
  })

  it.each(['ambiguous', 'no-candidate'] as const)(
    'fails closed for a %s durable fingerprint chain',
    async (kind) => {
      const receiptState = memoryStore()
      const source = tracker()
      if (kind === 'no-candidate')
        source.recordTurn({
          model: 'prior',
          usage: { inputTokens: 5, outputTokens: 0 },
          costUsd: 0,
        })
      const first = await prepareOne({
        activeTracker: source,
        receiptState,
        createId: ids('receipt-1', 'boundary-1', 'summary-1'),
      })
      const receipts = [first.receipt]
      if (kind === 'ambiguous') {
        const second = await prepareOne({
          activeTracker: tracker(),
          receiptState,
          createId: ids('receipt-2', 'boundary-2', 'summary-2'),
        })
        receipts.push(second.receipt)
      }
      const recovered = tracker()
      await expect(
        new CompactionAccounting({
          sessionId: 'session',
          tracker: recovered,
          receiptStore: receiptState.store,
          costStateStore: { save: async () => undefined },
          readTranscript: async () => transcriptFor(receipts),
        }).recover(),
      ).rejects.toMatchObject({
        metadata: { phase: 'recovery', recoveryDisposition: 'blocked' },
      })
      expect(recovered.snapshot().modelUsage).toEqual({})
    },
  )

  it('rejects configured receipt recovery without a complete Transcript reader', async () => {
    const accounting = new CompactionAccounting({
      sessionId: 'session',
      tracker: tracker(),
      receiptStore: memoryStore().store,
    })
    await expect(accounting.recover()).rejects.toMatchObject({
      metadata: { phase: 'recovery', recoveryDisposition: 'blocked' },
    })
  })
})
