import { describe, expect, it } from 'vitest'

import type { TuiDiffSnapshot } from './git-diff.js'
import { projectTuiDiffSurface } from './diff-surface-model.js'

const file = (
  path: string,
  additions: number,
  deletions: number,
  patch = '',
) => ({ path, additions, deletions, patch })

const snapshot = (
  files: TuiDiffSnapshot['files'],
  additions = 999,
  deletions = 999,
): TuiDiffSnapshot => ({ files, additions, deletions })

const indexedSources = [
  {
    label: 'Current',
    snapshot: snapshot([file('current.ts', 1, 0)]),
  },
  {
    label: 'T1',
    snapshot: snapshot([
      file('first.ts', 1, 0),
      file('second.ts', 0, 1),
      file('third.ts', 2, 2),
    ]),
  },
  {
    label: 'T2',
    snapshot: snapshot([file('last.ts', 1, 1)]),
  },
] as const

const indexCases = [
  [-4, 0],
  [1.9, 1],
  [99, 2],
  [Number.NaN, 0],
  [Number.POSITIVE_INFINITY, 0],
  [Number.NEGATIVE_INFINITY, 0],
] as const

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe('projectTuiDiffSurface', () => {
  it.each(indexCases)('normalizes source index %s to %s', (input, expected) => {
    const model = projectTuiDiffSurface({
      sources: indexedSources,
      sourceIndex: input,
      selectedIndex: 0,
      viewingFile: false,
      scrollOffset: 0,
    })

    expect(model.title).toBe('Changes since session start')
    expect(model.currentSource).toEqual({
      index: expected,
      label: indexedSources[expected]?.label,
    })
    expect(model.sourceTabs.map((source) => source.selected)).toEqual(
      [0, 1, 2].map((index) => index === expected),
    )
  })

  it.each(indexCases)('normalizes file index %s to %s', (input, expected) => {
    const model = projectTuiDiffSurface({
      sources: indexedSources,
      sourceIndex: 1,
      selectedIndex: input,
      viewingFile: false,
      scrollOffset: 0,
    })

    expect(model.view.kind).toBe('summary')
    if (model.view.kind !== 'summary') throw new Error('expected summary')
    expect(model.view.selectedIndex).toBe(expected)
    expect(model.view.files.map((entry) => entry.path)).toEqual([
      'first.ts',
      'second.ts',
      'third.ts',
    ])
  })

  it.each([
    [-4, 0],
    [1.9, 1],
    [99, 7],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0],
  ] as const)('normalizes scroll offset %s to %s', (input, expected) => {
    const patch = Array.from(
      { length: 25 },
      (_, index) => `+line-${index + 1}`,
    ).join('\n')
    const model = projectTuiDiffSurface({
      sources: [
        {
          label: 'Current',
          snapshot: snapshot([file('long.ts', 25, 0, patch)]),
        },
      ],
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: true,
      scrollOffset: input,
    })

    expect(model.view.kind).toBe('file-detail')
    if (model.view.kind !== 'file-detail') throw new Error('expected detail')
    expect(model.view.scrollOffset).toBe(expected)
    expect(model.view.patchRows[0]?.absoluteIndex).toBe(expected)
    expect(model.view.scrollRange).toEqual({ min: 0, max: 7 })
  })

  it('normalizes file counts and saturates totals independently of snapshot totals', () => {
    const model = projectTuiDiffSurface({
      sources: [
        {
          label: 'Current',
          snapshot: snapshot(
            [
              file('negative.ts', -4, 1.9),
              file('non-finite.ts', Number.NaN, Number.POSITIVE_INFINITY),
              file(
                'unsafe.ts',
                Number.MAX_SAFE_INTEGER + 100,
                Number.MAX_SAFE_INTEGER,
              ),
              file('saturates.ts', 2, 2),
            ],
            -100,
            Number.POSITIVE_INFINITY,
          ),
        },
      ],
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: false,
      scrollOffset: 0,
    })

    expect(model.view.kind).toBe('summary')
    if (model.view.kind !== 'summary') throw new Error('expected summary')
    expect(
      model.view.files.map(({ additions, deletions }) => ({
        additions,
        deletions,
      })),
    ).toEqual([
      { additions: 0, deletions: 1 },
      { additions: 0, deletions: 0 },
      {
        additions: Number.MAX_SAFE_INTEGER,
        deletions: Number.MAX_SAFE_INTEGER,
      },
      { additions: 2, deletions: 2 },
    ])
    expect(model.view.totals).toEqual({
      additions: Number.MAX_SAFE_INTEGER,
      deletions: Number.MAX_SAFE_INTEGER,
    })
    expect(Number.isSafeInteger(model.view.totals.additions)).toBe(true)
    expect(Number.isSafeInteger(model.view.totals.deletions)).toBe(true)
  })

  it('preserves source and file order with source-distinct stable identities', () => {
    const sharedPathSources = [
      {
        label: 'Current',
        snapshot: snapshot([file('same.ts', 1, 0), file('after.ts', 0, 1)]),
      },
      {
        label: 'T1',
        snapshot: snapshot([file('same.ts', 2, 2)]),
      },
    ] as const
    const current = projectTuiDiffSurface({
      sources: sharedPathSources,
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: false,
      scrollOffset: 0,
    })
    const turn = projectTuiDiffSurface({
      sources: sharedPathSources,
      sourceIndex: 1,
      selectedIndex: 0,
      viewingFile: false,
      scrollOffset: 0,
    })
    const reordered = projectTuiDiffSurface({
      sources: [
        sharedPathSources[1],
        {
          label: 'Current',
          snapshot: snapshot([file('after.ts', 0, 1), file('same.ts', 1, 0)]),
        },
      ],
      sourceIndex: 1,
      selectedIndex: 1,
      viewingFile: false,
      scrollOffset: 0,
    })

    expect(current.sourceTabs.map((source) => source.label)).toEqual([
      'Current',
      'T1',
    ])
    expect(current.view.kind).toBe('summary')
    expect(turn.view.kind).toBe('summary')
    expect(reordered.view.kind).toBe('summary')
    if (
      current.view.kind !== 'summary' ||
      turn.view.kind !== 'summary' ||
      reordered.view.kind !== 'summary'
    ) {
      throw new Error('expected summaries')
    }
    expect(current.view.files.map((entry) => entry.path)).toEqual([
      'same.ts',
      'after.ts',
    ])
    expect(current.view.files[0]?.id).not.toBe(turn.view.files[0]?.id)
    expect(reordered.sourceTabs[1]?.id).toBe(current.sourceTabs[0]?.id)
    expect(reordered.view.files[0]?.id).toBe(current.view.files[1]?.id)
    expect(reordered.view.files[1]?.id).toBe(current.view.files[0]?.id)
    expect(current.view.files[0]).not.toHaveProperty('patch')
  })

  it('filters diff metadata while retaining and classifying header-like content', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      'index 111..222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '--- content',
      '+++ content',
      ' unchanged',
      '-removed',
      '+added',
    ].join('\n')
    const model = projectTuiDiffSurface({
      sources: [
        {
          label: 'Current',
          snapshot: snapshot([file('a.txt', 1, 1, patch)]),
        },
      ],
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: true,
      scrollOffset: 0,
    })

    expect(model.view.kind).toBe('file-detail')
    if (model.view.kind !== 'file-detail') throw new Error('expected detail')
    expect(
      model.view.patchRows.map(({ text, kind }) => ({ text, kind })),
    ).toEqual([
      { text: '--- content', kind: 'context' },
      { text: '+++ content', kind: 'context' },
      { text: ' unchanged', kind: 'context' },
      { text: '-removed', kind: 'removed' },
      { text: '+added', kind: 'added' },
    ])
  })

  it('projects an 18-line stable absolute patch window and truthful positions', () => {
    const patch = Array.from(
      { length: 25 },
      (_, index) => `${index % 2 === 0 ? '+' : '-'}line-${index + 1}`,
    ).join('\n')
    const input = {
      sources: [
        {
          label: 'Current',
          snapshot: snapshot([file('long.ts', 13, 12, patch)]),
        },
      ],
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: true,
      scrollOffset: 5,
    } as const
    const first = projectTuiDiffSurface(input)
    const repeated = projectTuiDiffSurface(input)

    expect(first.view.kind).toBe('file-detail')
    expect(repeated.view.kind).toBe('file-detail')
    if (
      first.view.kind !== 'file-detail' ||
      repeated.view.kind !== 'file-detail'
    ) {
      throw new Error('expected details')
    }
    expect(first.view.patchRows).toHaveLength(18)
    expect(first.view.patchRows[0]).toMatchObject({
      text: '-line-6',
      absoluteIndex: 5,
    })
    expect(first.view.patchRows.at(-1)).toMatchObject({
      text: '+line-23',
      absoluteIndex: 22,
    })
    expect(first.view).toMatchObject({
      windowSize: 18,
      totalLines: 25,
      visibleStart: 6,
      visibleEnd: 23,
      scrollRange: { min: 0, max: 7 },
    })
    expect(first.view.patchRows.map((row) => row.id)).toEqual(
      repeated.view.patchRows.map((row) => row.id),
    )
  })

  it('projects empty sources, files, impossible detail, and empty patch safely', () => {
    const noSources = projectTuiDiffSurface({
      sources: [],
      sourceIndex: 99,
      selectedIndex: 99,
      viewingFile: true,
      scrollOffset: 99,
    })
    expect(noSources.currentSource).toBeNull()
    expect(noSources.sourceTabs).toEqual([])
    expect(noSources.view).toMatchObject({
      kind: 'summary',
      files: [],
      selectedIndex: null,
      emptyText: 'No uncommitted changes.',
      cancellation: {
        visualLabel: 'Esc to close',
        screenReaderLabel: 'Escape to close',
      },
    })

    const noFiles = projectTuiDiffSurface({
      sources: [{ label: 'Current', snapshot: snapshot([]) }],
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: true,
      scrollOffset: 0,
    })
    expect(noFiles.currentSource).toEqual({ index: 0, label: 'Current' })
    expect(noFiles.view.kind).toBe('summary')

    const noPatch = projectTuiDiffSurface({
      sources: [
        {
          label: 'Current',
          snapshot: snapshot([file('binary.bin', 0, 0)]),
        },
      ],
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: true,
      scrollOffset: 9,
    })
    expect(noPatch.view).toMatchObject({
      kind: 'file-detail',
      patchRows: [],
      totalLines: 0,
      visibleStart: 0,
      visibleEnd: 0,
      scrollOffset: 0,
      emptyPatchText: 'No patch content.',
      actions: [],
      cancellation: {
        visualLabel: 'Esc to back',
        screenReaderLabel: 'Escape to go back',
      },
    })
  })

  it('projects only implemented summary/detail actions and distinct cancellation', () => {
    const patch = Array.from({ length: 20 }, (_, index) => `+${index}`).join(
      '\n',
    )
    const sources = [
      {
        label: 'Current',
        snapshot: snapshot([file('a.ts', 20, 0, patch)]),
      },
      {
        label: 'T1',
        snapshot: snapshot([file('a.ts', 20, 0, patch)]),
      },
    ] as const
    const summary = projectTuiDiffSurface({
      sources,
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: false,
      scrollOffset: 0,
    })
    const detail = projectTuiDiffSurface({
      sources,
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: true,
      scrollOffset: 0,
    })

    expect(summary.view.kind).toBe('summary')
    expect(detail.view.kind).toBe('file-detail')
    if (summary.view.kind !== 'summary' || detail.view.kind !== 'file-detail') {
      throw new Error('expected summary and detail')
    }
    expect(summary.view.actions.map((action) => action.visualLabel)).toEqual([
      '←/→ to switch source',
      '↑/↓ to select · Enter to view',
    ])
    expect(summary.view.cancellation).toEqual({
      visualLabel: 'Esc to close',
      screenReaderLabel: 'Escape to close',
    })
    expect(detail.view.actions.map((action) => action.visualLabel)).toEqual([
      '←/→ to switch source',
      '↑/↓ to scroll',
    ])
    expect(detail.view.cancellation).toEqual({
      visualLabel: 'Esc to back',
      screenReaderLabel: 'Escape to go back',
    })
  })

  it('does not mutate deeply frozen sources, snapshots, files, or patch text', () => {
    const sources = deepFreeze([
      {
        label: 'Current',
        snapshot: snapshot([
          file('immutable.ts', 1, 1, '@@ -1 +1 @@\n-before\n+after'),
        ]),
      },
    ] as const)
    const before = JSON.stringify(sources)

    expect(() =>
      projectTuiDiffSurface({
        sources,
        sourceIndex: 0,
        selectedIndex: 0,
        viewingFile: true,
        scrollOffset: 0,
      }),
    ).not.toThrow()
    expect(JSON.stringify(sources)).toBe(before)
  })
})
