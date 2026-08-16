import { describe, expect, it, vi } from 'vitest'
import { structuredPatch } from 'diff'
import type * as DiffModule from 'diff'

import { countLineChanges } from './line-changes.js'

vi.mock('diff', async (importOriginal) => {
  const original = await importOriginal<typeof DiffModule>()
  return {
    ...original,
    structuredPatch: vi.fn(original.structuredPatch),
  }
})

const mockedStructuredPatch = vi.mocked(structuredPatch)

describe('countLineChanges', () => {
  it('returns zeros for identical contents', () => {
    expect(countLineChanges('a\nb\n', 'a\nb\n')).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
    })
  })

  it('counts a single-line replacement as one added and one removed', () => {
    expect(countLineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
    })
  })

  it('counts a pure insertion', () => {
    expect(countLineChanges('a\nc\n', 'a\nb\nc\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 0,
    })
  })

  it('counts a pure deletion', () => {
    expect(countLineChanges('a\nb\nc\n', 'a\nc\n')).toEqual({
      linesAdded: 0,
      linesRemoved: 1,
    })
  })

  it('sums multiple hunks', () => {
    expect(
      countLineChanges('a\nb\nc\nd\ne\nf\ng\nh\n', 'A\nb\nc\nd\ne\nf\ng\nH\n'),
    ).toEqual({ linesAdded: 2, linesRemoved: 2 })
  })

  it('counts CRLF line changes', () => {
    expect(countLineChanges('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
    })
    expect(countLineChanges('a\r\nc\r\n', 'a\r\nb\r\nc\r\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 0,
    })
  })

  it('counts trailing-newline additions and removals', () => {
    expect(countLineChanges('a', 'a\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
    })
    expect(countLineChanges('a\n', 'a')).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
    })
  })

  it('counts nonempty and empty new files', () => {
    expect(countLineChanges('', 'a\nb\n', { newFile: true })).toEqual({
      linesAdded: 3,
      linesRemoved: 0,
    })
    expect(countLineChanges('', 'a', { newFile: true })).toEqual({
      linesAdded: 1,
      linesRemoved: 0,
    })
    expect(countLineChanges('', '', { newFile: true })).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
    })
  })

  it('counts a full overwrite', () => {
    expect(countLineChanges('a\nb\nc\n', 'x\ny\nz\n')).toEqual({
      linesAdded: 3,
      linesRemoved: 3,
    })
    expect(countLineChanges('', 'a\nb\n')).toEqual({
      linesAdded: 2,
      linesRemoved: 0,
    })
    expect(countLineChanges('a\nb\n', '')).toEqual({
      linesAdded: 0,
      linesRemoved: 2,
    })
  })

  it('returns exact zeros when structuredPatch times out with undefined', () => {
    mockedStructuredPatch.mockImplementationOnce(
      () => undefined as unknown as ReturnType<typeof structuredPatch>,
    )

    expect(countLineChanges('a\nb\nc\n', 'x\ny\nz\n')).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
    })

    expect(countLineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
    })
  })

  it('counts literal ampersand and dollar content unchanged', () => {
    expect(countLineChanges('a & b\n', 'a & b\nc\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 0,
    })
    expect(countLineChanges('a $ b\n', 'a $ b\nc\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 0,
    })
    expect(countLineChanges('cost: $5 & $6\n', 'cost: $50 & $60\n')).toEqual({
      linesAdded: 1,
      linesRemoved: 1,
    })
  })
})
