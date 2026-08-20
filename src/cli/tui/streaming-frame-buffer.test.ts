import { describe, expect, it } from 'vitest'

import {
  DEFAULT_FRAME_INTERVAL_MS,
  StreamingFrameBuffer,
  type StreamingFrame,
  type StreamingFrameScheduler,
} from './streaming-frame-buffer.js'

/**
 * Deterministic scheduler so tests advance frames without real timers or fixed
 * sleeps. Each scheduled callback runs when the clock crosses its deadline.
 */
class ManualScheduler implements StreamingFrameScheduler {
  private queue: { id: number; callback: () => void; at: number }[] = []
  private nextId = 1
  private clock = 0

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId
    this.nextId += 1
    this.queue.push({ id, callback, at: this.clock + delayMs })
    return id
  }

  cancel(handle: unknown): void {
    this.queue = this.queue.filter((item) => item.id !== handle)
  }

  advance(ms: number): void {
    this.clock += ms
    const due = this.queue
      .filter((item) => item.at <= this.clock)
      .sort((a, b) => a.at - b.at || a.id - b.id)
    this.queue = this.queue.filter((item) => item.at > this.clock)
    for (const item of due) item.callback()
  }

  get pendingCount(): number {
    return this.queue.length
  }

  get lastDelay(): number | undefined {
    const last = this.queue[this.queue.length - 1]
    return last === undefined ? undefined : last.at - this.clock
  }
}

function createHarness(frameIntervalMs = 33) {
  const scheduler = new ManualScheduler()
  const frames: StreamingFrame[] = []
  const buffer = new StreamingFrameBuffer({
    publish: (frame) => frames.push(frame),
    scheduler,
    frameIntervalMs,
  })
  return { scheduler, frames, buffer }
}

describe('streaming frame buffer', () => {
  it('coalesces a burst of deltas into one bounded frame per interval', () => {
    const { scheduler, frames, buffer } = createHarness()
    buffer.appendText('a')
    buffer.appendText('b')
    buffer.appendText('c')
    // No synchronous publish; exactly one frame is scheduled for the burst.
    expect(frames).toHaveLength(0)
    expect(scheduler.pendingCount).toBe(1)
    scheduler.advance(33)
    expect(frames).toEqual([{ text: 'abc', thinking: '' }])
    // The next burst waits for the next frame boundary.
    buffer.appendText('d')
    buffer.appendText('e')
    scheduler.advance(33)
    expect(frames).toEqual([
      { text: 'abc', thinking: '' },
      { text: 'abcde', thinking: '' },
    ])
  })

  it('uses the bounded cadence by default and exposes effective text', () => {
    const scheduler = new ManualScheduler()
    const frames: StreamingFrame[] = []
    const buffer = new StreamingFrameBuffer({
      publish: (frame) => frames.push(frame),
      scheduler,
    })
    expect(DEFAULT_FRAME_INTERVAL_MS).toBe(33)
    buffer.appendText('first')
    expect(scheduler.lastDelay).toBe(33)
    expect(buffer.text).toBe('first')
    expect(buffer.hasPending).toBe(true)
  })

  it('never loses or reorders deltas across many frames', () => {
    const { scheduler, frames, buffer } = createHarness()
    const chunks = Array.from({ length: 300 }, (_, index) => `c${index}/`)
    for (let index = 0; index < chunks.length; index += 10) {
      for (const chunk of chunks.slice(index, index + 10)) {
        buffer.appendText(chunk)
      }
      scheduler.advance(33)
    }
    buffer.flush()
    const finalText = chunks.join('')
    expect(frames.at(-1)?.text).toBe(finalText)
    // Every published frame is a prefix of the final text, so deltas are never
    // reordered or dropped: later frames grow the same committed string.
    for (const frame of frames) {
      expect(finalText.startsWith(frame.text)).toBe(true)
    }
    expect(frames.length).toBeGreaterThanOrEqual(2)
    expect(frames.at(-2)?.text.length ?? 0).toBeLessThan(
      frames.at(-1)?.text.length ?? 0,
    )
  })

  it('flushes pending deltas immediately and cancels the scheduled frame', () => {
    const { scheduler, frames, buffer } = createHarness()
    buffer.appendText('x')
    buffer.appendText('y')
    expect(frames).toHaveLength(0)
    buffer.flush()
    expect(frames).toEqual([{ text: 'xy', thinking: '' }])
    expect(scheduler.pendingCount).toBe(0)
    // The canceled frame must not publish a duplicate later.
    scheduler.advance(1000)
    expect(frames).toHaveLength(1)
  })

  it('publishes a final unterminated partial frame at a boundary', () => {
    const { frames, buffer } = createHarness()
    buffer.appendText('partial')
    expect(frames).toHaveLength(0)
    buffer.flush()
    expect(frames.at(-1)?.text).toBe('partial')
    // A second boundary with no new deltas is not published twice.
    buffer.flush()
    expect(frames).toHaveLength(1)
  })

  it('resets text and thinking independently while preserving the other stream', () => {
    const { scheduler, frames, buffer } = createHarness()
    buffer.appendText('hello')
    buffer.appendThinking('reasoning')
    scheduler.advance(33)
    expect(frames.at(-1)).toEqual({ text: 'hello', thinking: 'reasoning' })

    buffer.resetThinking()
    buffer.flush()
    expect(frames.at(-1)).toEqual({ text: 'hello', thinking: '' })

    buffer.resetText()
    buffer.appendText('world')
    scheduler.advance(33)
    expect(frames.at(-1)).toEqual({ text: 'world', thinking: '' })
    expect(buffer.text).toBe('world')
  })

  it('keeps committed text stable when only thinking deltas arrive', () => {
    const { scheduler, frames, buffer } = createHarness()
    buffer.appendText('text')
    scheduler.advance(33)
    buffer.appendThinking('thought')
    scheduler.advance(33)
    expect(frames.at(-1)).toEqual({ text: 'text', thinking: 'thought' })
    buffer.appendThinking(' more')
    scheduler.advance(33)
    expect(frames.at(-1)).toEqual({ text: 'text', thinking: 'thought more' })
  })

  it('dispose cancels pending work and ignores later appends', () => {
    const { scheduler, frames, buffer } = createHarness()
    buffer.appendText('a')
    expect(scheduler.pendingCount).toBe(1)
    buffer.dispose()
    expect(buffer.isDisposed).toBe(true)
    expect(buffer.hasPending).toBe(false)
    expect(scheduler.pendingCount).toBe(0)
    buffer.appendText('b')
    buffer.appendThinking('c')
    buffer.flush()
    scheduler.advance(1000)
    expect(frames).toHaveLength(0)
  })

  it('drops discarded deltas on reset and never replays them', () => {
    const { scheduler, frames, buffer } = createHarness()
    buffer.appendText('old')
    buffer.resetText()
    scheduler.advance(33)
    buffer.appendText('new')
    buffer.flush()
    expect(frames.map((frame) => frame.text)).toEqual(['', 'new'])
  })
})
