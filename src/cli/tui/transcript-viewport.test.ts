import { describe, expect, it } from 'vitest'
import {
  projectTranscriptPresentation,
  type TranscriptPresentationEntry,
  type TranscriptItem,
} from './transcript-presentation.js'
import {
  createTranscriptEntryViewportIndex,
  estimateTranscriptEntryLines,
  projectTranscriptPresentationTail,
  projectTranscriptPresentationWindow,
  projectTranscriptEntryRows,
  transcriptPresentationLineCount,
  TRANSCRIPT_TRUNCATION_MARKER,
  terminalGraphemeWidth,
  terminalTextHead,
  terminalTextTail,
  terminalTextWidth,
} from './transcript-viewport.js'

describe('presentation viewport', () => {
  it('provides grapheme-safe terminal-cell helpers', () => {
    const text = '界e\u0301👩‍💻'
    expect(terminalTextWidth(text)).toBe(5)
    expect(terminalGraphemeWidth('界')).toBe(2)
    expect(terminalTextHead(text, 3)).toBe('界e\u0301')
    expect(terminalTextTail(text, 2)).toBe('👩‍💻')
    expect(terminalTextHead('界x', 1)).toBe('')
    expect(terminalTextTail('x界', 1)).toBe('')
    expect(terminalTextHead(text, 0)).toBe('')
    expect(terminalTextHead(text, -1)).toBe('')
    expect(terminalTextTail(text, Number.NaN)).toBe('')
    expect(terminalTextTail(text, Number.POSITIVE_INFINITY)).toBe('')
  })
  it('exposes the authoritative physical rows for an entry', () => {
    const entry = projectTranscriptPresentation(
      [{ kind: 'assistant', text: '界'.repeat(20) }],
      'normal',
    )[0]
    if (!entry) throw new Error('missing assistant presentation entry')
    const rows = projectTranscriptEntryRows(entry, 10, 'normal')
    if (!rows) throw new Error('missing projected rows')
    expect(rows[0]).toBe('')
    expect(rows[1]).toContain('praxis>')
    expect(rows.slice(1).join('')).toContain('界'.repeat(20))
  })

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
    ).toBe(1)
  })

  it('keeps the path on successful individual Read summaries and matches narrow wrapping', () => {
    const entry: TranscriptPresentationEntry = {
      kind: 'tool',
      key: 'read-path',
      item: {
        kind: 'tool',
        call: {
          id: 'read-path',
          name: 'Read',
          input: { file_path: 'src/components/example.ts' },
        },
        detail: '',
      },
      result: {
        kind: 'tool-result',
        callId: 'read-path',
        text: 'export const value = 1',
        isError: false,
      },
    }
    const wideRows = projectTranscriptEntryRows(entry, 80, 'normal')
    expect(wideRows).toEqual(['✓ Read  src/components/example.ts'])
    const narrowRows = projectTranscriptEntryRows(entry, 10, 'normal')
    if (!narrowRows) throw new Error('expected narrow Read rows')
    expect(narrowRows.join('')).toContain('src/components/example.ts')
    expect(estimateTranscriptEntryLines(entry, 10, 'normal')).toBe(
      narrowRows.length,
    )
  })

  it('keeps grouped Read summaries in count grammar', () => {
    const entry = { kind: 'read-summary' as const, key: 'reads', count: 2 }
    expect(projectTranscriptEntryRows(entry, 80, 'normal')).toEqual([
      '✓ Read 2 files',
    ])
    expect(estimateTranscriptEntryLines(entry, 80, 'normal')).toBe(1)
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
    expect(retained.item.text.startsWith(TRANSCRIPT_TRUNCATION_MARKER)).toBe(
      true,
    )
    expect(retained.item.text.endsWith('suffix')).toBe(true)
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

  it('strips terminal controls from a plain oversized viewport slice', () => {
    const text = Array.from(
      { length: 20 },
      (_, index) => `\u001b[31mcontrolled-${index}\u001b[0m`,
    ).join('\n')
    const entries = projectTranscriptPresentation(
      [{ kind: 'assistant', text }],
      'audit',
    )
    const projected = projectTranscriptPresentationTail(
      entries,
      4,
      40,
      'audit',
    )[0]

    expect(projected?.viewportSlice?.text).toContain('controlled-19')
    expect(projected?.viewportSlice?.text).not.toContain('\u001b')
    expect(
      entries[0]?.kind === 'item' && entries[0].item.kind === 'assistant'
        ? entries[0].item.text
        : '',
    ).toContain('\u001b[31m')
  })

  it('uses the remaining row when the truncation marker fills the width', () => {
    const entries = projectTranscriptPresentation(
      [{ kind: 'assistant', text: 'newest-content' }],
      'normal',
    )
    const projected = projectTranscriptPresentationTail(entries, 2, 1, 'normal')
    const retained = projected[0]
    if (retained?.kind !== 'item' || retained.item.kind !== 'assistant') {
      throw new Error('expected a projected assistant entry')
    }
    expect(retained.item.text).toBe(`${TRANSCRIPT_TRUNCATION_MARKER}\nt`)
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
    expect(projected.map((entry) => entry.key)).toEqual(['item-9', 'item-10'])
    expect(projected[0]?.viewportSlice).toBeUndefined()
    expect(projected[1]?.viewportSlice?.rows).toBe(1)
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

    expect(projected.map((entry) => entry.key)).toEqual(['item-0', 'item-1'])
    expect(projected[0]?.viewportSlice).toBeUndefined()
    expect(projected[1]?.viewportSlice?.rows).toBe(1)
    expect(
      projected.reduce(
        (rows, entry) =>
          rows + estimateTranscriptEntryLines(entry, 80, 'normal'),
        0,
      ),
    ).toBeLessThanOrEqual(budget)
  })

  it('indexes assistant slices at the same width used by Markdown rendering', () => {
    const text = `oldest-${'x'.repeat(248)}`
    const entries = projectTranscriptPresentation(
      [{ kind: 'assistant', text }],
      'normal',
    )
    const budget = 4
    const maxOffset =
      transcriptPresentationLineCount(entries, 12, 'normal') - budget
    const projected = projectTranscriptPresentationWindow(
      entries,
      budget,
      12,
      maxOffset,
      'normal',
    )

    expect(projected[0]?.viewportSlice?.text).toContain('old')
    expect(projected[0]?.viewportSlice?.text).not.toMatch(/^\n{2,}/u)
    expect(
      transcriptPresentationLineCount(projected, 12, 'normal'),
    ).toBeLessThanOrEqual(budget)
  })

  it('uses the same word-wrapped rows for assistant measurement and slicing', () => {
    const entries = projectTranscriptPresentation(
      [{ kind: 'assistant', text: 'aaaaaa bbbbbb cccccc' }],
      'normal',
    )
    expect(transcriptPresentationLineCount(entries, 14, 'normal')).toBe(4)

    const visibleByOffset = [0, 1, 2, 3].map((scrollOffset) => {
      const projected = projectTranscriptPresentationWindow(
        entries,
        2,
        14,
        scrollOffset,
        'normal',
      )[0]
      return projected?.kind === 'item' && projected.item.kind === 'assistant'
        ? projected.item.text
        : ''
    })

    expect(visibleByOffset.join(' ')).toContain('cccccc')
    expect(visibleByOffset.join(' ')).toContain('bbbbbb')
    expect(visibleByOffset.join(' ')).toContain('aaaaaa')
  })

  it('matches Ink wide-grapheme wrapping at a one-column content width', () => {
    const entry = projectTranscriptPresentation(
      [{ kind: 'assistant', text: '界' }],
      'normal',
    )[0]
    if (!entry) throw new Error('expected an assistant entry')
    const index = createTranscriptEntryViewportIndex(entry, 5, 'normal')

    expect(estimateTranscriptEntryLines(entry, 5, 'normal')).toBe(4)
    expect(index?.rows).toEqual(['', 'praxi', 's> ', '界'])
  })

  it.each([
    [
      'thinking',
      { kind: 'thinking' as const, text: `oldest-thinking-${'x'.repeat(160)}` },
      'oldest-thinking-',
    ],
    [
      'compact',
      {
        kind: 'compact' as const,
        summary: `oldest-compact-${'x'.repeat(160)}`,
      },
      'oldest-compact-',
    ],
  ])(
    'does not synthesize leading padding for oversized %s content',
    (_name, item, oldestMarker) => {
      const entries = projectTranscriptPresentation([item], 'audit')
      const budget = 9
      const maxOffset = Math.max(
        0,
        transcriptPresentationLineCount(entries, 12, 'audit') - budget,
      )
      const projected = projectTranscriptPresentationWindow(
        entries,
        budget,
        12,
        maxOffset,
        'audit',
      )
      const slice = projected[0]?.viewportSlice

      expect(slice?.text.replaceAll('\n', '')).toContain(oldestMarker)
      expect(slice?.text).not.toMatch(/^\n{2,}/u)
      expect(slice?.rows).toBeLessThanOrEqual(budget)
    },
  )

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

  it('bounds a huge failed shell line before normal row projection', () => {
    const output = 'x'.repeat(100_000)
    const items: readonly TranscriptItem[] = [
      { kind: 'shell', callId: 'shell', command: 'run' },
      {
        kind: 'shell-result',
        callId: 'shell',
        stdout: output,
        stderr: '',
        isError: true,
      },
    ]
    const normal = projectTranscriptPresentation(items, 'normal')[0]
    const audit = projectTranscriptPresentation(items, 'audit')[0]
    if (!normal || !audit) throw new Error('expected projected shell entries')
    const source = JSON.stringify(normal)
    const normalRows = projectTranscriptEntryRows(normal, 40, 'normal')
    const auditRows = projectTranscriptEntryRows(audit, 40, 'audit')
    if (!normalRows || !auditRows) throw new Error('expected projected rows')
    expect(normalRows.length).toBeLessThanOrEqual(9)
    expect(normalRows.at(-1)).toContain(TRANSCRIPT_TRUNCATION_MARKER)
    expect(normalRows.every((row) => terminalTextWidth(row) <= 38)).toBe(true)
    expect(auditRows.some((row) => row.includes('x'.repeat(30)))).toBe(true)
    expect(JSON.stringify(normal)).toBe(source)
  })

  it('counts a huge newline-heavy failed shell preview without materializing it', () => {
    const output = 'line\n'.repeat(100_000)
    const items: readonly TranscriptItem[] = [
      { kind: 'shell', callId: 'shell-lines', command: 'run-lines' },
      {
        kind: 'shell-result',
        callId: 'shell-lines',
        stdout: output,
        stderr: '',
        isError: true,
      },
    ]
    const normal = projectTranscriptPresentation(items, 'normal')[0]
    const audit = projectTranscriptPresentation(items, 'audit')[0]
    if (!normal || !audit) throw new Error('expected projected shell entries')
    const source = JSON.stringify(normal)
    const normalRows = projectTranscriptEntryRows(normal, 40, 'normal')
    if (!normalRows) throw new Error('expected normal projected rows')
    expect(normalRows.length).toBeLessThanOrEqual(9)
    expect(normalRows.at(-1)?.replace(/^\s+/u, '')).toBe(
      '… +99997 lines (ctrl+o to expand)',
    )
    expect(normalRows.every((row) => terminalTextWidth(row) <= 38)).toBe(true)
    expect(estimateTranscriptEntryLines(audit, 40, 'audit')).toBeGreaterThan(
      normalRows.length,
    )
    expect(JSON.stringify(normal)).toBe(source)
  })

  it('uses one stable normal row for running and successful tools and shells', () => {
    const cases: readonly (readonly [readonly TranscriptItem[], string])[] = [
      [
        [
          {
            kind: 'tool',
            call: {
              id: 'running-tool',
              name: 'Bash',
              input: { command: 'pwd' },
            },
            detail: '',
          },
        ],
        '… Bash  pwd',
      ],
      [
        [
          {
            kind: 'tool',
            call: { id: 'successful-tool', name: 'Glob', input: {} },
            detail: 'src/**/*.ts',
          },
          {
            kind: 'tool-result',
            callId: 'successful-tool',
            text: 'hidden successful output',
            isError: false,
          },
        ],
        '✓ Glob · src/**/*.ts',
      ],
      [
        [{ kind: 'shell', callId: 'running-shell', command: 'npm test' }],
        '… Bash  npm test',
      ],
      [
        [
          { kind: 'shell', callId: 'successful-shell', command: 'npm test' },
          {
            kind: 'shell-result',
            callId: 'successful-shell',
            stdout: 'hidden',
            stderr: '',
            isError: false,
          },
        ],
        '✓ Bash  npm test',
      ],
    ]

    for (const [items, expected] of cases) {
      const entry = projectTranscriptPresentation(items, 'normal')[0]
      if (!entry) throw new Error('expected a projected operation')
      expect(projectTranscriptEntryRows(entry, 80, 'normal')).toEqual([
        expected,
      ])
      expect(estimateTranscriptEntryLines(entry, 80, 'normal')).toBe(1)
    }
  })

  it('shows bounded normal failure detail and expands successful output in audit', () => {
    const failedItems: readonly TranscriptItem[] = [
      {
        kind: 'tool',
        call: { id: 'failed', name: 'Bash', input: { command: 'npm test' } },
        detail: '',
      },
      {
        kind: 'tool-result',
        callId: 'failed',
        text: Array.from({ length: 20 }, (_, index) => `failure-${index}`).join(
          '\n',
        ),
        isError: true,
      },
    ]
    const failed = projectTranscriptPresentation(failedItems, 'normal')[0]
    if (!failed) throw new Error('expected failed tool entry')
    const failedRows = projectTranscriptEntryRows(failed, 80, 'normal')
    expect(failedRows?.[0]).toBe('! Bash  npm test')
    expect(failedRows?.join('\n')).toContain('Error: failure-0')
    expect(failedRows?.join('\n')).toContain('ctrl+o to expand')
    expect(failedRows?.length).toBeLessThanOrEqual(5)
    expect(estimateTranscriptEntryLines(failed, 80, 'normal')).toBe(
      failedRows?.length,
    )

    const successfulItems: readonly TranscriptItem[] = [
      {
        kind: 'tool',
        call: { id: 'success', name: 'Bash', input: { command: 'npm test' } },
        detail: '',
      },
      {
        kind: 'tool-result',
        callId: 'success',
        text: 'audit-visible-output',
        isError: false,
      },
    ]
    const normal = projectTranscriptPresentation(successfulItems, 'normal')[0]
    const audit = projectTranscriptPresentation(successfulItems, 'audit')[0]
    if (!normal || !audit) throw new Error('expected successful tool entry')
    expect(projectTranscriptEntryRows(normal, 80, 'normal')).toEqual([
      '✓ Bash  npm test',
    ])
    expect(
      projectTranscriptEntryRows(audit, 80, 'audit')?.join('\n'),
    ).toContain('audit-visible-output')
  })

  it('keeps explicit screen-reader speaker and operation wording', () => {
    const entries = projectTranscriptPresentation(
      [
        { kind: 'user', text: 'hello' },
        { kind: 'assistant', text: 'answer' },
        {
          kind: 'tool',
          call: { id: 'tool', name: 'Read', input: { file_path: 'a.ts' } },
          detail: '',
        },
      ],
      'screen-reader',
    )
    expect(
      entries.flatMap(
        (entry) => projectTranscriptEntryRows(entry, 80, 'screen-reader') ?? [],
      ),
    ).toEqual([
      '',
      '',
      'You: hello',
      '',
      'Praxis:',
      'answer',
      '',
      'Running tool: Read  a.ts',
    ])
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
