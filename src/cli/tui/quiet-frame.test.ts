import { describe, expect, it } from 'vitest'

import { projectQuietFrame, resolveQuietFrameDensity } from './quiet-frame.js'
import type { TuiScreenModel } from './tui-screen-model.js'
import type { TuiRow } from './tui-row-ir.js'

type SourceRow = TuiRow & { readonly accessibleText?: string }

function sourceRow(
  key: string,
  text: string,
  accessibleText?: string,
): SourceRow {
  return {
    key,
    segments: [{ text, role: 'body' }],
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
        rows: [sourceRow('turn:1', 'you> hello')],
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
    expect(value.lines[2]?.segments[0]?.text).toBe('praxis> first')
    expect(value.lines[3]?.segments[0]?.text).toBe('        second')
    expect(value.lines[4]?.accessibleText).toBe('Thinking: checking')
  })

  it('omits permanent identity chrome after the intro', () => {
    const value = frame({ screen: screen({ intro: 'none' }) })
    expect(value.lines.some(({ region }) => region === 'identity')).toBe(false)
    expect(value.lines.map(({ key }) => key)).toEqual([
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

  it('reports a clamped visible cursor column including the composer prefix', () => {
    expect(frame({ composerText: 'hello', composerCursor: 2 }).cursor).toEqual({
      rowKey: 'quiet:composer',
      column: 7,
    })
    expect(
      frame({
        width: 8,
        shellMode: true,
        composerText: 'command',
        composerCursor: 999,
      }).cursor,
    ).toEqual({ rowKey: 'quiet:composer', column: 7 })
    expect(frame({ composerCursor: Number.NaN }).cursor?.column).toBe(5)
  })

  it('keeps unrelated row keys stable across status and input changes', () => {
    const source = screen({ rows: [sourceRow('turn:stable', 'praxis> ok')] })
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
})
