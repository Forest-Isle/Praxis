import { describe, expect, it } from 'vitest'

import { DurableFollowUpTracker } from './durable-follow-up.js'

function batch(
  id: string,
  messages: readonly string[],
  acknowledge: () => Promise<void>,
) {
  return { id, messages, acknowledge }
}

describe('DurableFollowUpTracker', () => {
  it('deduplicates identical batches, rejects conflicts, and matches exact multisets', async () => {
    const tracker = new DurableFollowUpTracker()
    let acknowledgements = 0
    const first = batch('stable', ['a', 'a'], async () => {
      acknowledgements += 1
    })
    tracker.register(first)
    tracker.register(batch('stable', ['a', 'a'], async () => undefined))
    expect(() =>
      tracker.register(batch('stable', ['a'], async () => undefined)),
    ).toThrow()
    await tracker.followUpUserMessagesCompleted(['a'])
    expect(acknowledgements).toBe(0)
    await tracker.followUpUserMessagesCompleted(['a', 'a', 'extra'])
    expect(acknowledgements).toBe(1)
    expect(tracker.size()).toBe(0)
  })

  it('removes only after successful acknowledgement and retries failures', async () => {
    const tracker = new DurableFollowUpTracker()
    let attempts = 0
    tracker.register(
      batch('retry', ['message'], async () => {
        attempts += 1
        if (attempts === 1) throw new Error('not durable')
      }),
    )
    await expect(
      tracker.followUpUserMessagesCompleted(['message']),
    ).rejects.toThrow()
    expect(tracker.size()).toBe(1)
    await tracker.followUpUserMessagesCompleted(['message'])
    expect(attempts).toBe(2)
    expect(tracker.size()).toBe(0)
    tracker.register(
      batch('empty', [], async () => {
        throw new Error('ignored')
      }),
    )
    expect(tracker.size()).toBe(0)
  })
})
