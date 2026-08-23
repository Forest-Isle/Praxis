import { describe, expect, it } from 'vitest'
import {
  projectTranscriptPresentation,
  type TranscriptItem,
} from './transcript-presentation.js'
import {
  estimateTranscriptEntryLines,
  projectTranscriptPresentationTail,
  projectTranscriptPresentationWindow,
  transcriptPresentationLineCount,
  TRANSCRIPT_TRUNCATION_MARKER,
} from './transcript-viewport.js'

describe('presentation viewport', () => {
  it('preserves wrap state across logical lines and hard words', () => {
    const repeatedLines = projectTranscriptPresentation(
      [
        {
          kind: 'notice',
          text: Array.from({ length: 100 }, () => 'word '.repeat(20)).join(
            '\n',
          ),
        },
      ],
      'normal',
    )[0]
    const hardWord = projectTranscriptPresentation(
      [
        {
          kind: 'notice',
          text: `${'x'.repeat(95)} trailing words after hard wrap`,
        },
      ],
      'normal',
    )[0]
    const wideExactFill = projectTranscriptPresentation(
      [{ kind: 'notice', text: `${'界'.repeat(31)} tail` }],
      'normal',
    )[0]
    if (!repeatedLines || !hardWord || !wideExactFill)
      throw new Error('expected notice presentation entries')
    expect(estimateTranscriptEntryLines(repeatedLines, 32, 'normal')).toBe(400)
    expect(estimateTranscriptEntryLines(repeatedLines, 40, 'normal')).toBe(300)
    expect(estimateTranscriptEntryLines(repeatedLines, 80, 'normal')).toBe(200)
    expect(estimateTranscriptEntryLines(hardWord, 32, 'normal')).toBe(5)
    expect(estimateTranscriptEntryLines(hardWord, 40, 'normal')).toBe(4)
    expect(estimateTranscriptEntryLines(hardWord, 80, 'normal')).toBe(2)
    expect(estimateTranscriptEntryLines(wideExactFill, 32, 'normal')).toBe(3)
  })

  it('counts wrapped read summaries instead of assuming one row', () => {
    expect(
      estimateTranscriptEntryLines(
        { kind: 'read-summary', key: 'read-summary', count: 123 },
        32,
        'normal',
      ),
    ).toBeGreaterThan(1)
  })

  it('keeps paired entries indivisible and preserves keys', () => {
    const items = [
      { kind: 'user' as const, text: 'old' },
      {
        kind: 'tool' as const,
        call: { id: 'x', name: 'Bash', input: {} },
        detail: '',
      },
      { kind: 'tool-result' as const, callId: 'x', text: 'ok', isError: false },
      { kind: 'assistant' as const, text: 'new' },
    ]
    const entries = projectTranscriptPresentation(items, 'normal')
    const tail = projectTranscriptPresentationTail(entries, 2, 80, 'normal')
    expect(tail.map((entry) => entry.key)).toEqual(['item-3'])
    expect(
      projectTranscriptPresentation(items, 'normal').map((entry) => entry.key),
    ).toEqual(entries.map((entry) => entry.key))
  })

  it('bounds an oversized newest text entry without mutating it', () => {
    const item = {
      kind: 'assistant' as const,
      text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'),
    }
    const entry = projectTranscriptPresentation([item], 'normal')[0]
    if (!entry) throw new Error('missing entry')
    const projected = projectTranscriptPresentationTail(
      [entry],
      4,
      80,
      'normal',
    )[0]
    expect(projected?.kind).toBe('item')
    if (projected?.kind === 'item' && projected.item.kind === 'assistant') {
      expect(projected.item.text).toContain('line 99')
      expect(projected.item.text.startsWith(TRANSCRIPT_TRUNCATION_MARKER)).toBe(
        true,
      )
      expect(
        estimateTranscriptEntryLines(projected, 80, 'normal'),
      ).toBeLessThanOrEqual(4)
    }
    expect(item.text).toContain('line 0')
  })

  it('retains the newest suffix of an oversized unbroken line', () => {
    const text = `discard-${'x'.repeat(80)}-newest-suffix`
    const entries = projectTranscriptPresentation(
      [{ kind: 'assistant', text }],
      'normal',
    )

    const projected = projectTranscriptPresentationTail(
      entries,
      3,
      10,
      'normal',
    )
    const retained = projected[0]
    expect(retained?.kind).toBe('item')
    if (retained?.kind !== 'item' || retained.item.kind !== 'assistant') {
      throw new Error('expected a projected assistant entry')
    }
    expect(retained.item.text).toMatch(/^….*suffix$/u)
    expect(retained.item.text).not.toBe(TRANSCRIPT_TRUNCATION_MARKER)
    expect(
      estimateTranscriptEntryLines(retained, 10, 'normal'),
    ).toBeLessThanOrEqual(3)
  })

  it('keeps grapheme clusters intact when projecting a wide text tail', () => {
    const text = `older\n${'界'.repeat(20)}\nnewest 👩‍💻🙂尾`
    const entries = projectTranscriptPresentation(
      [{ kind: 'assistant', text }],
      'normal',
    )
    const source = JSON.stringify(entries)
    const projected = projectTranscriptPresentationTail(
      entries,
      4,
      20,
      'normal',
    )
    const retained = projected[0]
    expect(retained?.kind).toBe('item')
    if (retained?.kind !== 'item' || retained.item.kind !== 'assistant') {
      throw new Error('expected a projected assistant entry')
    }
    expect(retained.item.text).toContain('👩‍💻🙂尾')
    expect(retained.item.text).not.toMatch(/[\uD800-\uDBFF]$/u)
    expect(retained.item.text).not.toMatch(/\u200D$/u)
    expect(
      estimateTranscriptEntryLines(retained, 20, 'normal'),
    ).toBeLessThanOrEqual(4)
    expect(JSON.stringify(entries)).toBe(source)
  })

  it('stays bounded when the truncation marker fills the available width', () => {
    const entries = projectTranscriptPresentation(
      [{ kind: 'assistant', text: 'newest-content' }],
      'normal',
    )
    const projected = projectTranscriptPresentationTail(entries, 2, 1, 'normal')
    const retained = projected[0]
    if (retained?.kind !== 'item' || retained.item.kind !== 'assistant') {
      throw new Error('expected a projected assistant entry')
    }
    expect(retained.item.text).toBe(TRANSCRIPT_TRUNCATION_MARKER)
    expect(
      estimateTranscriptEntryLines(retained, 1, 'normal'),
    ).toBeLessThanOrEqual(2)
  })

  it('selects an older entry window from the full line count', () => {
    const entries = projectTranscriptPresentation(
      Array.from({ length: 12 }, (_, i) => ({
        kind: 'user' as const,
        text: `prompt ${i}`,
      })),
      'normal',
    )
    const projected = projectTranscriptPresentationWindow(
      entries,
      3,
      80,
      3,
      'normal',
    )
    expect(projected.map((entry) => entry.key)).toEqual(['item-9'])
    expect(
      projected.reduce(
        (rows, entry) =>
          rows + estimateTranscriptEntryLines(entry, 80, 'normal'),
        0,
      ),
    ).toBeLessThanOrEqual(3)
  })

  it('keeps the oldest entry reachable at the maximum scroll offset', () => {
    const entries = projectTranscriptPresentation(
      [
        { kind: 'assistant', text: 'oldest line one\noldest line two' },
        { kind: 'user', text: 'middle' },
        { kind: 'user', text: 'newest' },
      ],
      'normal',
    )
    const budget = 4
    const maxOffset =
      transcriptPresentationLineCount(entries, 80, 'normal') - budget
    const projected = projectTranscriptPresentationWindow(
      entries,
      budget,
      80,
      maxOffset,
      'normal',
    )

    expect(projected.map((entry) => entry.key)).toEqual(['item-0'])
    expect(
      projected.reduce(
        (rows, entry) =>
          rows + estimateTranscriptEntryLines(entry, 80, 'normal'),
        0,
      ),
    ).toBeLessThanOrEqual(budget)
  })

  it('keeps the bounded start tail with complete following entries', () => {
    const oldest = {
      kind: 'assistant' as const,
      text: Array.from({ length: 10 }, (_, index) => `oldest-${index}`).join(
        '\n',
      ),
    }
    const entries = projectTranscriptPresentation(
      [
        oldest,
        { kind: 'user', text: 'middle' },
        { kind: 'user', text: 'newest' },
      ],
      'normal',
    )
    const source = JSON.stringify(entries)
    const newest = entries[2]
    if (!newest) throw new Error('expected newest entry')
    const newestRows = estimateTranscriptEntryLines(newest, 80, 'normal')
    const projected = projectTranscriptPresentationWindow(
      entries,
      5,
      80,
      newestRows,
      'normal',
    )

    expect(projected.map((entry) => entry.key)).toEqual(['item-0', 'item-1'])
    expect(projected[0]?.key).toBe(entries[0]?.key)
    expect(projected[0]?.kind).toBe('item')
    if (
      projected[0]?.kind === 'item' &&
      projected[0].item.kind === 'assistant'
    ) {
      expect(projected[0].item.text).toContain('oldest-9')
      expect(projected[0].item.text).toContain(TRANSCRIPT_TRUNCATION_MARKER)
    }
    expect(
      transcriptPresentationLineCount(projected, 80, 'normal'),
    ).toBeLessThanOrEqual(5)
    expect(projected.map((entry) => entry.key)).not.toContain('item-2')
    expect(JSON.stringify(entries)).toBe(source)
  })

  it.each([
    [
      'unpaired tool detail',
      [
        {
          kind: 'tool',
          call: { id: 'tool', name: 'Glob', input: { pattern: '**/*' } },
          detail: 'detail '.repeat(500),
        },
      ] satisfies readonly TranscriptItem[],
    ],
    [
      'paired tool heading',
      [
        {
          kind: 'tool',
          call: {
            id: 'tool',
            name: 'Bash',
            input: { command: `run-${'x'.repeat(2_000)}` },
          },
          detail: '',
        },
        {
          kind: 'tool-result',
          callId: 'tool',
          text: 'done',
          isError: false,
        },
      ] satisfies readonly TranscriptItem[],
    ],
    [
      'unpaired shell command',
      [
        {
          kind: 'shell',
          callId: 'shell',
          command: `run-${'x'.repeat(2_000)}`,
        },
      ] satisfies readonly TranscriptItem[],
    ],
  ])(
    'bounds oversized %s chrome without mutating its source',
    (_name, items) => {
      const entries = projectTranscriptPresentation(items, 'audit')
      const source = JSON.stringify(entries)
      const projected = projectTranscriptPresentationTail(
        entries,
        6,
        80,
        'audit',
      )

      expect(projected).toHaveLength(1)
      expect(projected[0]?.key).toBe(entries[0]?.key)
      expect(JSON.stringify(entries)).toBe(source)
      expect(
        projected.reduce(
          (rows, entry) =>
            rows + estimateTranscriptEntryLines(entry, 80, 'audit'),
          0,
        ),
      ).toBeLessThanOrEqual(6)
    },
  )

  it('omits an unshrinkable context block instead of overflowing the viewport', () => {
    const entries = projectTranscriptPresentation(
      [
        {
          kind: 'context',
          usedTokens: 1_000,
          contextWindowTokens: 200_000,
          skills: Array.from({ length: 20 }, (_, index) => ({
            name: `skill-${index}`,
            tokens: 100,
          })),
          memoryFiles: Array.from({ length: 20 }, (_, index) => ({
            path: `/memory-${index}.md`,
            tokens: 100,
          })),
        },
      ],
      'normal',
    )
    const source = JSON.stringify(entries)
    const projected = projectTranscriptPresentationTail(
      entries,
      8,
      80,
      'normal',
    )

    expect(projected).toEqual([])
    expect(JSON.stringify(entries)).toBe(source)
  })

  const oversizedResults: readonly (readonly [
    string,
    readonly TranscriptItem[],
  ])[] = [
    [
      'paired tool',
      [
        {
          kind: 'tool',
          call: { id: 'tool', name: 'Bash', input: {} },
          detail: '',
        },
        {
          kind: 'tool-result',
          callId: 'tool',
          text: 'prefix\n'.repeat(200) + 'tool suffix',
          isError: false,
        },
      ],
    ],
    [
      'paired shell stderr',
      [
        { kind: 'shell', callId: 'shell', command: 'cmd' },
        {
          kind: 'shell-result',
          callId: 'shell',
          stdout: '',
          stderr: 'prefix\n'.repeat(200) + 'shell suffix',
          isError: false,
        },
      ],
    ],
    [
      'orphan tool',
      [
        {
          kind: 'tool-result',
          callId: 'orphan',
          text: 'prefix\n'.repeat(200) + 'orphan suffix',
          isError: false,
        },
      ],
    ],
    [
      'orphan shell stderr',
      [
        {
          kind: 'shell-result',
          callId: 'orphan-shell',
          stdout: '',
          stderr: 'prefix\n'.repeat(200) + 'orphan shell suffix',
          isError: false,
        },
      ],
    ],
  ]

  it.each(oversizedResults)(
    'bounds oversized %s results without mutating source',
    (_name, items) => {
      const entries = projectTranscriptPresentation(items, 'audit')
      const source = JSON.stringify(entries)
      const projected = projectTranscriptPresentationTail(
        entries,
        8,
        80,
        'audit',
      )
      expect(projected).toHaveLength(1)
      expect(projected[0]?.key).toBe(entries[0]?.key)
      expect(JSON.stringify(entries)).toBe(source)
      const retained = projected[0]
      if (!retained) throw new Error('expected projected entry')
      expect(
        estimateTranscriptEntryLines(retained, 80, 'audit'),
      ).toBeLessThanOrEqual(8)
      const rendered = JSON.stringify(projected[0])
      expect(rendered).toContain('suffix')
      expect(rendered).toContain(TRANSCRIPT_TRUNCATION_MARKER)
    },
  )

  it('budgets collapsed normal tool output separately from complete audit output', () => {
    const items: readonly TranscriptItem[] = [
      {
        kind: 'tool',
        call: { id: 'tool', name: 'Glob', input: { pattern: '**/*' } },
        detail: 'Glob **/*',
      },
      {
        kind: 'tool-result',
        callId: 'tool',
        text: Array.from({ length: 120 }, (_, index) => `result-${index}`).join(
          '\n',
        ),
        isError: false,
      },
    ]
    const normal = projectTranscriptPresentation(items, 'normal')[0]
    const audit = projectTranscriptPresentation(items, 'audit')[0]
    if (!normal || !audit) throw new Error('expected projected tool entries')

    const normalRows = estimateTranscriptEntryLines(normal, 80, 'normal')
    const auditRows = estimateTranscriptEntryLines(audit, 80, 'audit')
    expect(normalRows).toBeLessThanOrEqual(8)
    expect(auditRows).toBeGreaterThanOrEqual(120)
    expect(auditRows).toBeGreaterThan(normalRows)
  })

  it('accounts for complete orphan shell output before bounding the visible tail', () => {
    const entries = projectTranscriptPresentation(
      [
        {
          kind: 'shell-result',
          callId: 'orphan-shell',
          stdout:
            Array.from({ length: 120 }, (_, index) => `stdout-${index}`).join(
              '\n',
            ) + '\n',
          stderr: 'final-stderr-suffix',
          isError: true,
        },
      ],
      'normal',
    )
    const entry = entries[0]
    if (!entry) throw new Error('expected orphan shell entry')
    expect(estimateTranscriptEntryLines(entry, 80, 'normal')).toBeGreaterThan(
      120,
    )

    const projected = projectTranscriptPresentationTail(
      entries,
      6,
      80,
      'normal',
    )[0]
    if (!projected) throw new Error('expected bounded orphan shell entry')
    expect(
      estimateTranscriptEntryLines(projected, 80, 'normal'),
    ).toBeLessThanOrEqual(6)
    expect(JSON.stringify(projected)).toContain('final-stderr-suffix')
    if (projected.kind !== 'orphan-shell-result')
      throw new Error('expected bounded orphan shell entry')
    expect(projected.item.stdout).toContain('\n\nfinal-stderr-suffix')
  })
})
