import { describe, expect, it } from 'vitest'

import type { TranscriptItem } from './claude-style.js'
import {
  estimateTranscriptLines,
  projectTranscriptTail,
  TRANSCRIPT_TRUNCATION_MARKER,
} from './transcript-viewport.js'

const user = (text: string): TranscriptItem => ({ kind: 'user', text })
const assistant = (text: string): TranscriptItem => ({
  kind: 'assistant',
  text,
})

describe('projectTranscriptTail', () => {
  it('keeps the full history when it fits the budget', () => {
    const items: readonly TranscriptItem[] = [
      user('first prompt'),
      assistant('first reply'),
      user('second prompt'),
      assistant('second reply'),
    ]
    const projected = projectTranscriptTail(items, 20, 80)
    expect(projected).toEqual(items)
    expect(projected).not.toBe(items)
  })

  it('projects the newest multi-turn tail after the first turn', () => {
    const firstTurnUser = user('first prompt')
    const firstTurnReply = assistant(
      Array.from(
        { length: 30 },
        (_, index) => `first reply line ${index}`,
      ).join('\n'),
    )
    const secondTurnUser = user('second prompt')
    const secondTurnReply = assistant(
      'second reply\n- point 1\n- point 2\n- point 3\n- point 4',
    )
    const projected = projectTranscriptTail(
      [firstTurnUser, firstTurnReply, secondTurnUser, secondTurnReply],
      12,
      80,
    )
    // The oversized first turn is dropped; the second prompt and reply stay.
    expect(projected).not.toContain(firstTurnUser)
    expect(projected).not.toContain(firstTurnReply)
    expect(projected).toContain(secondTurnUser)
    expect(projected).toContain(secondTurnReply)
    expect(projected[0]).toBe(secondTurnUser)
    expect(projected[projected.length - 1]).toBe(secondTurnReply)
  })

  it('retains the newest user/assistant content over long bookkeeping history', () => {
    const bookkeeping = Array.from(
      { length: 100 },
      (_, index): TranscriptItem => ({
        kind: 'notice',
        text: `operational notice ${index}`,
      }),
    )
    const newestUser = user('newest prompt')
    const newestReply = assistant('newest reply')
    const projected = projectTranscriptTail(
      [...bookkeeping, newestUser, newestReply],
      10,
      80,
    )
    expect(projected).toContain(newestUser)
    expect(projected).toContain(newestReply)
    expect(projected[projected.length - 1]).toBe(newestReply)
  })

  it('keeps a single oversized newest item as a bounded tail instead of clipping it', () => {
    const huge = assistant(
      Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'),
    )
    const projected = projectTranscriptTail([huge], 4, 80)
    expect(projected).toHaveLength(1)
    const projectedItem = projected[0]
    if (projectedItem === undefined) {
      throw new Error('expected exactly one projected item')
    }
    const text = projectedItem.kind === 'assistant' ? projectedItem.text : ''
    expect(text).toContain('line 99')
    expect(text.startsWith(TRANSCRIPT_TRUNCATION_MARKER)).toBe(true)
    expect(projectedItem).not.toBe(huge)
    expect(estimateTranscriptLines(projectedItem, 80)).toBeLessThanOrEqual(4)
  })

  it('retains the final line of a 100-line newest assistant item and stays bounded', () => {
    const newest = assistant(
      Array.from({ length: 100 }, (_, i) => `reply-${i}`).join('\n'),
    )
    const projected = projectTranscriptTail([newest], 24, 80)
    expect(projected).toHaveLength(1)
    const projectedItem = projected[0]
    if (projectedItem === undefined) {
      throw new Error('expected exactly one projected item')
    }
    const text = projectedItem.kind === 'assistant' ? projectedItem.text : ''
    expect(text).toContain('reply-99')
    expect(text.startsWith(TRANSCRIPT_TRUNCATION_MARKER)).toBe(true)
    expect(projectedItem).not.toBe(newest)
    expect(estimateTranscriptLines(projectedItem, 80)).toBeLessThanOrEqual(24)
  })

  it('returns an empty suffix for an empty history', () => {
    expect(projectTranscriptTail([], 10, 80)).toEqual([])
    expect(projectTranscriptTail([], 0, 80)).toEqual([])
  })

  it('preserves ordering and item object identity in the projected suffix', () => {
    const items: readonly TranscriptItem[] = [
      user('a'),
      user('b'),
      user('c'),
      user('d'),
      user('e'),
      assistant('reply'),
    ]
    const projected = projectTranscriptTail(items, 3, 80)
    expect(projected).toEqual(items.slice(3))
    expect(projected[0]).toBe(items[3])
    expect(projected[2]).toBe(items[5])
  })
})

describe('estimateTranscriptLines', () => {
  it('is conservative about wrapped rows at narrow widths', () => {
    const item = user('x'.repeat(120))
    expect(estimateTranscriptLines(item, 80)).toBe(2)
    expect(estimateTranscriptLines(item, 40)).toBe(3)
  })

  it('counts blank lines and multi-line text', () => {
    expect(estimateTranscriptLines(assistant(''), 80)).toBe(1)
    expect(estimateTranscriptLines(assistant('a\nb\nc'), 80)).toBe(3)
  })

  it('adds fixed chrome rows for decorated entries', () => {
    const thinking = { kind: 'thinking' as const, text: 'a\nb' }
    expect(estimateTranscriptLines(thinking, 80)).toBe(3)
  })
})
