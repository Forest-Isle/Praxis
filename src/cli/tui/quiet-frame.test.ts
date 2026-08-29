import { describe, expect, it } from 'vitest'

import { projectQuietFrame, resolveQuietFrameDensity } from './quiet-frame.js'
import type { TuiScreenModel } from './tui-screen-model.js'
import type { TuiRow } from './tui-row-ir.js'
import { terminalTextWidth } from './transcript-viewport.js'

type SourceRow = TuiRow & { readonly accessibleText?: string }

function sourceRow(
  key: string,
  text: string,
  accessibleText?: string,
  role: TuiRow['segments'][number]['role'] = 'body',
): SourceRow {
  return {
    key,
    segments: [{ text, role }],
    height: 1,
    source: key,
    ...(accessibleText === undefined ? {} : { accessibleText }),
  }
}

function screen(
  overrides: {
    intro?: 'welcome' | 'identity' | 'none'
    sessionLabel?: string
    rows?: readonly TuiRow[]
    active?: { text: string; thinking: string; visible: boolean }
  } = {},
): TuiScreenModel {
  return {
    presentation: {
      kind: 'fullscreen',
      fixedViewport: true,
      screenReader: false,
      viewport: { columns: 80, rows: 24, revision: 0, source: 'override' },
    },
    body: {
      kind: 'conversation',
      intro: overrides.intro ?? 'none',
      ...(overrides.sessionLabel === undefined
        ? {}
        : { sessionLabel: overrides.sessionLabel }),
      resumed: false,
      freshSession: false,
      hasConversationHistory: true,
      transcript: {
        entries: [],
        rows: overrides.rows ?? [],
        pageRows: 10,
        maxScrollOffset: 0,
        scrollOffset: 0,
        readingMode: 'normal',
        active: overrides.active ?? { text: '', thinking: '', visible: false },
      },
      foreground: { kind: 'compose', overlays: [] },
    },
  }
}

function frame(
  overrides: Partial<Parameters<typeof projectQuietFrame>[0]> = {},
) {
  return projectQuietFrame({
    screen: screen(),
    width: 80,
    rows: undefined,
    composerText: '',
    composerCursor: 0,
    shellMode: false,
    busy: false,
    status: 'Ready',
    focusRows: [],
    ...overrides,
  })
}

describe('quiet frame', () => {
  it('resolves every density boundary deterministically', () => {
    expect(
      [120, 100, 99, 80, 79, 60, 59, 40, 39, Number.NaN].map(
        resolveQuietFrameDensity,
      ),
    ).toEqual([
      'full',
      'full',
      'standard',
      'standard',
      'compact',
      'compact',
      'narrow',
      'narrow',
      'minimal',
      'minimal',
    ])
  })

  it('orders optional identity, transcript, active stream, composer, and status', () => {
    const value = frame({
      screen: screen({
        intro: 'identity',
        sessionLabel: 'abc12345',
        rows: [sourceRow('turn:1', '❯ hello')],
        active: { text: 'first\nsecond', thinking: 'checking', visible: true },
      }),
      width: 100,
      composerText: 'next',
      composerCursor: 4,
      display: { version: '0.40.0', model: 'test', cwd: '/workspace' },
    })
    expect(value.lines.map(({ region }) => region)).toEqual([
      'identity',
      'transcript',
      'active',
      'active',
      'active',
      'composer',
      'status',
    ])
    expect(value.lines[0]?.segments[0]?.text).toContain('session abc12345')
    expect(value.lines[2]?.segments[0]?.text).toBe('⏺ first')
    expect(value.lines[3]?.segments[0]?.text).toBe('        second')
    expect(value.lines[4]?.accessibleText).toBe('Thinking: checking')
  })

  it('retains a bounded newest active tail while screen-reader stays complete', () => {
    const text = Array.from(
      { length: 1000 },
      (_, index) => `line-${index}`,
    ).join('\n')
    const value = frame({
      rows: 24,
      screen: screen({
        active: { text, thinking: '', visible: true },
      }),
    })
    const active = value.lines.filter(({ region }) => region === 'active')
    expect(active).toHaveLength(22)
    expect(active[0]?.segments[0]?.text).toContain('… line-978')
    expect(active.at(-1)?.segments[0]?.text).toContain('line-999')
    expect(value.lines.at(-1)?.key).toBe('quiet:status')

    const thinking =
      Array.from({ length: 1000 }, (_, index) => `thought-${index}`).join(
        '\n',
      ) + '\n'
    const thinkingFrame = frame({
      rows: 24,
      screen: screen({
        active: { text: '', thinking, visible: true },
      }),
    })
    const visibleThinking = thinkingFrame.lines.filter(
      ({ region }) => region === 'active',
    )
    expect(visibleThinking).toHaveLength(22)
    expect(visibleThinking[0]?.segments[0]?.text).toContain('thought-978')
    expect(visibleThinking.at(-1)?.segments[0]?.text).toContain('thought-999')

    const base = screen({ active: { text, thinking, visible: true } })
    const conversation = base.body as Extract<
      typeof base.body,
      { kind: 'conversation' }
    >
    const reader = frame({
      rows: undefined,
      screen: {
        ...base,
        presentation: { ...base.presentation, screenReader: true },
        body: {
          ...conversation,
          transcript: {
            ...conversation.transcript,
            readingMode: 'screen-reader',
          },
        },
      },
    })
    expect(
      reader.lines.filter(({ region }) => region === 'active').length,
    ).toBeGreaterThan(2000)
    expect(base.body).toEqual(
      screen({ active: { text, thinking, visible: true } }).body,
    )
  })

  it('keeps screen-reader active output complete despite finite terminal rows', () => {
    const value = frame({
      rows: 2,
      screen: {
        ...screen({
          active: {
            text: 'one\ntwo\nthree\nfour',
            thinking: 'checking\nwaiting',
            visible: true,
          },
        }),
        presentation: {
          ...screen().presentation,
          screenReader: true,
        },
      },
    })
    const active = value.lines.filter(({ region }) => region === 'active')
    expect(active.map((row) => row.accessibleText)).toEqual([
      'Praxis: one',
      'two',
      'three',
      'four',
      'Thinking: checking',
      'waiting',
    ])
    expect(value.lines.at(-1)?.key).toBe('quiet:status')
    expect(value.rows).toBe(value.lines.length)
  })

  it('keeps active text and thinking keys tied to source offsets across tail shifts', () => {
    const project = (text: string, thinking: string) =>
      frame({
        rows: 5,
        screen: screen({ active: { text, thinking, visible: true } }),
      }).lines.filter(({ region }) => region === 'active')
    const first = project('text-0\ntext-1\ntext-2\ntext-3\ntext-4', '')
    const appended = project(
      'text-0\ntext-1\ntext-2\ntext-3\ntext-4\ntext-5',
      '',
    )
    const appendedPartial = project(
      'text-0\ntext-1\ntext-2\ntext-3\ntext-4\ntext-5!',
      '',
    )
    const keyFor = (rows: typeof first, text: string) =>
      rows.find((row) => row.accessibleText?.includes(text))?.key
    expect(keyFor(first, 'text-3')).toBe(keyFor(appended, 'text-3'))
    expect(keyFor(first, 'text-4')).toBe(keyFor(appended, 'text-4'))
    expect(keyFor(appended, 'text-5')).toBe(keyFor(appendedPartial, 'text-5!'))
    const firstThinking = project(
      '',
      'thought-0\nthought-1\nthought-2\nthought-3\nthought-4',
    )
    const appendedThinking = project(
      '',
      'thought-0\nthought-1\nthought-2\nthought-3\nthought-4\nthought-5',
    )
    expect(keyFor(firstThinking, 'thought-3')).toBe(
      keyFor(appendedThinking, 'thought-3'),
    )
    expect(keyFor(firstThinking, 'thought-4')).toBe(
      keyFor(appendedThinking, 'thought-4'),
    )
  })

  it('omits permanent identity chrome after the intro', () => {
    const value = frame({ screen: screen({ intro: 'none' }) })
    expect(value.lines.some(({ region }) => region === 'identity')).toBe(false)
    expect(value.lines.map(({ key }) => key)).toEqual([
      'quiet:composer',
      'quiet:status',
    ])
  })

  it('keeps only semantic minimal-density rows while screen readers retain the complete frame', () => {
    const base = screen({
      intro: 'identity',
      sessionLabel: 'abc12345',
      rows: [
        sourceRow('turn:ordinary', 'ordinary transcript'),
        sourceRow('turn:error', 'failed transcript', undefined, 'error'),
      ],
      active: { text: 'streamed text', thinking: 'working', visible: true },
    })
    const normal = frame({
      width: 39,
      screen: base,
      focusRows: [sourceRow('decision', 'Allow', undefined, 'selection')],
    })
    expect(normal.lines.map(({ key }) => key)).toEqual([
      'turn:error',
      'decision',
      'quiet:status',
    ])
    expect(normal.lines.some(({ region }) => region === 'identity')).toBe(false)
    expect(normal.lines.some(({ region }) => region === 'active')).toBe(false)

    const conversation = base.body as Extract<
      typeof base.body,
      { kind: 'conversation' }
    >
    const reader = frame({
      width: 39,
      screen: {
        ...base,
        presentation: { ...base.presentation, screenReader: true },
        body: {
          ...conversation,
          transcript: {
            ...conversation.transcript,
            readingMode: 'screen-reader',
          },
        },
      },
    })
    expect(reader.lines.map(({ key }) => key)).toEqual([
      'quiet:identity',
      'turn:ordinary',
      'turn:error',
      'quiet:active:text:0',
      'quiet:active:thinking:0',
      'quiet:composer',
      'quiet:status',
    ])
  })

  it('uses viewport pressure for the newest transcript while preserving composer and status', () => {
    const value = frame({
      screen: screen({
        intro: 'welcome',
        rows: [
          sourceRow('turn:1', 'oldest'),
          sourceRow('turn:2', 'middle'),
          sourceRow('turn:3', 'newest'),
        ],
      }),
      rows: 4,
    })
    expect(value.lines.map(({ key }) => key)).toEqual([
      'turn:2',
      'turn:3',
      'quiet:composer',
      'quiet:status',
    ])
  })

  it('uses focus instead of composer and preserves the focused row in a two-row viewport', () => {
    const value = frame({
      rows: 2,
      composerText: 'not visible',
      focusRows: [sourceRow('permission:allow', '❯ Allow once')],
    })
    expect(value.lines.map(({ key }) => key)).toEqual([
      'permission:allow',
      'quiet:status',
    ])
    expect(value.cursor).toBeUndefined()
  })

  it('retains focus heading, selected choice, footer, and status in an oversized viewport', () => {
    const focusRows = [
      sourceRow('permission:heading', 'Edit permissions', undefined, 'heading'),
      ...Array.from({ length: 21 }, (_, index) =>
        sourceRow(`permission:option:${index}`, `Option ${index}`),
      ),
      sourceRow('permission:selected', '❯ Allow', undefined, 'selection'),
      sourceRow('permission:footer', '↑/↓ select  Enter open  Esc close'),
    ]
    const value = frame({ rows: 24, focusRows, status: 'Ready' })
    const keys = value.lines.map(({ key }) => key)
    expect(value.lines).toHaveLength(24)
    expect(keys).toEqual(
      expect.arrayContaining([
        'permission:heading',
        'permission:selected',
        'permission:footer',
        'quiet:status',
      ]),
    )
    expect(keys.indexOf('permission:heading')).toBeLessThan(
      keys.indexOf('permission:selected'),
    )
    expect(keys.indexOf('permission:selected')).toBeLessThan(
      keys.indexOf('permission:footer'),
    )
  })

  it('selects deterministic bounded focus windows and preserves source order', () => {
    const rows = [
      sourceRow('heading', 'Heading', undefined, 'heading'),
      sourceRow('a', 'A'),
      sourceRow('selected', 'Selected', undefined, 'selection'),
      sourceRow('b', 'B'),
      sourceRow('footer', 'Footer'),
    ]
    expect(
      frame({ rows: 2, focusRows: rows }).lines.map((row) => row.key),
    ).toEqual(['selected', 'quiet:status'])
    expect(
      frame({ rows: 4, focusRows: rows }).lines.map((row) => row.key),
    ).toEqual(['heading', 'selected', 'footer', 'quiet:status'])
  })

  it('reports a clamped visible cursor column including the composer prefix', () => {
    expect(frame({ composerText: 'hello', composerCursor: 2 }).cursor).toEqual({
      rowKey: 'quiet:composer',
      column: 4,
    })
    expect(
      frame({
        width: 8,
        shellMode: true,
        composerText: 'command',
        composerCursor: 999,
      }).cursor,
    ).toEqual({ rowKey: 'quiet:composer', column: 7 })
    expect(frame({ composerCursor: Number.NaN }).cursor?.column).toBe(2)
  })

  it('keeps unrelated row keys stable across status and input changes', () => {
    const source = screen({ rows: [sourceRow('turn:stable', '⏺ ok')] })
    const first = frame({ screen: source, composerText: 'a', status: 'Ready' })
    const second = frame({
      screen: source,
      composerText: 'ab',
      status: 'Working',
      busy: true,
    })
    expect(first.lines.map(({ key }) => key)).toEqual(
      second.lines.map(({ key }) => key),
    )
  })

  it('strips complete VT/control sequences from segments and accessible labels without mutating sources', () => {
    const focus = sourceRow(
      'focus:1',
      'Allow \u001b[31mnow\u001b[0m\u0007',
      'Selected \u001b[32mallow\u001b[0m\nnow',
    )
    const before = structuredClone(focus)
    const value = frame({ focusRows: [focus] })
    expect(value.lines[0]?.segments[0]?.text).toBe('Allow now')
    expect(value.lines[0]?.accessibleText).toBe('Selected allow now')
    expect(focus).toEqual(before)
  })

  it('keeps compact identity concise and status meaningful without color', () => {
    const value = frame({
      screen: screen({ intro: 'welcome', sessionLabel: 'session' }),
      width: 60,
      busy: true,
      status: '',
      display: { version: '0.40.0', model: 'test', cwd: '/workspace' },
    })
    expect(value.lines[0]?.segments[0]?.text).toBe('Praxis · session session')
    expect(value.lines.at(-1)?.segments[0]?.text).toBe('Working · In progress')
    expect(value.lines.at(-1)?.accessibleText).toBe('Working · In progress')
  })

  it.each([40, 60, 80, 100, 120])(
    'bounds transcript, composer, and status rows at %i columns',
    (width) => {
      const source: SourceRow = {
        ...sourceRow(
          'decision',
          'x'.repeat(width - 1) + '界',
          'full decision text',
        ),
        segments: [
          { text: 'x'.repeat(width - 1) + '界', role: 'heading' },
          { text: 'later role must not leak', role: 'error' },
        ],
      }
      const composerText =
        'L'.repeat(width * 2) + '界e\u0301👩‍💻' + 'R'.repeat(width * 2)
      const value = frame({
        width,
        screen: screen({ rows: [source] }),
        composerText,
        composerCursor: width * 2 + 6,
        status: 'status '.repeat(width),
      })
      for (const row of value.lines)
        expect(
          terminalTextWidth(
            row.segments.map((segment) => segment.text).join(''),
          ),
        ).toBeLessThanOrEqual(width)
      expect(
        value.lines.find((row) => row.key === 'decision')?.segments,
      ).toEqual([
        { text: 'x'.repeat(width - 1), role: 'heading' },
        { text: '…', role: 'heading' },
      ])
      expect(
        value.lines.find((row) => row.key === 'decision')?.accessibleText,
      ).toBe('full decision text')
      expect(source.segments).toEqual([
        { text: 'x'.repeat(width - 1) + '界', role: 'heading' },
        { text: 'later role must not leak', role: 'error' },
      ])
      const composer = value.lines.find((row) => row.key === 'quiet:composer')
      const composerOutput = composer?.segments[0]?.text ?? ''
      expect(composerOutput).toMatch(/^❯ …/u)
      expect(composerOutput).toContain('界e\u0301👩‍💻R')
      expect(composerOutput).toMatch(/…$/u)
      expect(value.cursor?.column).toBeGreaterThanOrEqual(5)
      expect(value.cursor?.column).toBeLessThan(width)
      expect(
        value.lines
          .at(-1)
          ?.segments.map((segment) => segment.text)
          .join(''),
      ).toMatch(/…$/u)
    },
  )

  it('windows long composer text around beginning, middle, and end cursors', () => {
    const middle = 'L'.repeat(80) + '界e\u0301👩‍💻' + 'R'.repeat(80)
    const sourceLength = Array.from(middle).length
    const start = frame({ width: 40, composerText: middle, composerCursor: 0 })
    const centered = frame({
      width: 40,
      composerText: middle,
      composerCursor: 86,
    })
    const end = frame({
      width: 40,
      composerText: middle,
      composerCursor: sourceLength,
    })
    const output = (value: ReturnType<typeof frame>) =>
      value.lines.find((row) => row.key === 'quiet:composer')?.segments[0]
        ?.text ?? ''

    expect(output(start)).toMatch(/^❯ L+…$/u)
    expect(start.cursor?.column).toBe(2)
    expect(output(centered)).toMatch(/^❯ …/u)
    expect(output(centered)).toContain('界e\u0301👩‍💻R')
    expect(output(centered)).toMatch(/…$/u)
    expect(centered.cursor?.column).toBeLessThan(40)
    expect(output(end)).toMatch(/^❯ …R+ $/u)
    expect(end.cursor?.column).toBe(39)

    const shell = frame({
      width: 40,
      shellMode: true,
      composerText: middle,
      composerCursor: 86,
    })
    expect(output(shell)).toMatch(/^! …/u)
    expect(shell.cursor?.column).toBeLessThan(40)
  })

  it('snaps code-point cursors inside graphemes to their end boundary', () => {
    const combining = 'L'.repeat(80) + 'e\u0301' + 'R'.repeat(80)
    const combiningInside = frame({
      width: 40,
      composerText: combining,
      composerCursor: 81,
    })
    const combiningEnd = frame({
      width: 40,
      composerText: combining,
      composerCursor: 82,
    })
    expect(combiningInside.lines).toEqual(combiningEnd.lines)
    expect(combiningInside.cursor).toEqual(combiningEnd.cursor)

    const zwj = 'L'.repeat(80) + '👩‍💻' + 'R'.repeat(80)
    const zwjInside = frame({
      width: 40,
      composerText: zwj,
      composerCursor: 81,
    })
    const zwjEnd = frame({
      width: 40,
      composerText: zwj,
      composerCursor: 83,
    })
    expect(zwjInside.lines).toEqual(zwjEnd.lines)
    expect(zwjInside.cursor).toEqual(zwjEnd.cursor)
  })

  it('bounds prompts no wider than their stable prefix', () => {
    for (const width of [1, 2, 4, 5, 7]) {
      const value = frame({
        width,
        shellMode: true,
        composerText: 'command',
        composerCursor: 3,
      })
      const text =
        value.lines.find((line) => line.key === 'quiet:composer')?.segments[0]
          ?.text ?? ''
      expect(terminalTextWidth(text)).toBeLessThanOrEqual(width)
      expect(text).toMatch(/…$/u)
      expect(value.cursor?.column).toBeLessThan(width)
    }
    const user = frame({
      width: 5,
      composerText: 'command',
      composerCursor: 3,
    })
    expect(
      terminalTextWidth(
        user.lines.find((line) => line.key === 'quiet:composer')?.segments[0]
          ?.text ?? '',
      ),
    ).toBe(5)
    expect(user.cursor?.column).toBe(3)
  })
})
