import { describe, expect, it } from 'vitest'

import {
  projectAnsiQuietFrame,
  projectAnsiSurfaceFrame,
  supportsAnsiSurface,
} from './ansi-surface.js'
import type { QuietFrame } from './quiet-frame.js'
import type { TuiScreenModel } from './tui-screen-model.js'

function screen(overrides: Record<string, unknown> = {}) {
  return {
    presentation: {
      kind: 'fullscreen',
      fixedViewport: true,
      screenReader: false,
      viewport: { columns: 40, rows: 6 },
    },
    body: {
      kind: 'conversation',
      intro: 'none',
      transcript: {
        rows: [
          {
            key: 'entry:0',
            segments: [{ text: 'hello', role: 'body' }],
            height: 1,
          },
        ],
        active: { text: 'streaming', thinking: '', visible: true },
      },
      foreground: { kind: 'compose', overlays: [] },
      ...overrides,
    },
  } as unknown as TuiScreenModel
}

describe('projectAnsiSurfaceFrame', () => {
  it('preserves a QuietFrame exactly without inventing legacy chrome', () => {
    const quiet: QuietFrame = {
      columns: 72,
      rows: 5,
      density: 'compact',
      lines: [
        {
          key: 'quiet:choice:heading',
          segments: [
            { text: 'Permission', role: 'heading' },
            { text: ' · Bash', role: 'muted' },
          ],
          height: 1,
          region: 'focus',
          accessibleText: 'Permission request for Bash',
        },
        {
          key: 'quiet:choice:allow',
          segments: [{ text: '❯ Allow once', role: 'selection' }],
          height: 1,
          region: 'focus',
        },
      ],
      cursor: { rowKey: 'quiet:choice:allow', column: 2 },
    }
    const projected = projectAnsiQuietFrame(quiet)
    expect(projected).toEqual({
      columns: 72,
      rows: 5,
      lines: quiet.lines,
      cursor: quiet.cursor,
    })
    expect(projected.lines).toBe(quiet.lines)
    expect(projected.cursor).toBe(quiet.cursor)
    expect(projected.lines.map((line) => line.key)).not.toContain('composer')
    expect(projected.lines.map((line) => line.key)).not.toContain('status')
    expect(projected.lines.map((line) => line.key)).not.toContain(
      'ansi:header:identity',
    )
  })

  it('supports only an unobstructed conversation composer', () => {
    expect(supportsAnsiSurface(screen())).toBe(true)
    expect(supportsAnsiSurface(screen({ intro: 'welcome' }))).toBe(false)
    expect(supportsAnsiSurface(screen({ intro: 'identity' }))).toBe(false)
    expect(
      supportsAnsiSurface(
        screen({
          foreground: { kind: 'priority', surface: { title: 'Wait' } },
        }),
      ),
    ).toBe(false)
    expect(
      supportsAnsiSurface(
        screen({
          foreground: {
            kind: 'compose',
            overlays: [{ kind: 'exit-confirmation' }],
          },
        }),
      ),
    ).toBe(false)
    expect(
      supportsAnsiSurface(screen({ kind: 'session-picker', surface: {} })),
    ).toBe(false)
  })

  it('projects transcript, active stream, composer, and status in order', () => {
    const frame = projectAnsiSurfaceFrame({
      screen: screen(),
      width: 40,
      rows: 6,
      input: 'prompt',
      busy: true,
      status: 'Ready',
      onError: () => undefined,
    })
    expect(frame.lines.map((line) => line.segments[0]?.text)).toEqual([
      'Praxis',
      'Ready',
      'hello',
      'streaming',
      '❯ prompt▌',
      '● Ready · busy',
    ])
  })

  it('projects multiline active text and thinking as stable rows', () => {
    const frame = projectAnsiSurfaceFrame({
      screen: screen({
        transcript: {
          rows: [],
          active: {
            text: 'first\nsecond',
            thinking: 'ponder\nmore',
            visible: true,
          },
        },
      }),
      width: 40,
      rows: 8,
      input: '',
      busy: true,
      status: 'working',
      onError: () => undefined,
    })
    expect(frame.lines.map((line) => line.key)).toEqual([
      'ansi:header:identity',
      'ansi:header:context',
      'ansi:active:text:0',
      'ansi:active:text:1',
      'ansi:active:thinking:0',
      'ansi:active:thinking:1',
      'composer',
      'status',
    ])
  })

  it('bounds content while preserving composer and status', () => {
    const frame = projectAnsiSurfaceFrame({
      screen: screen({
        transcript: {
          rows: Array.from({ length: 10 }, (_, index) => ({
            key: `entry:${index}`,
            segments: [{ text: `line-${index}`, role: 'body' }],
            height: 1,
          })),
          active: { text: '', thinking: '', visible: false },
        },
      }),
      width: 40,
      rows: 5,
      input: 'x',
      busy: false,
      status: 'ok',
      onError: () => undefined,
    })
    expect(frame.lines.map((line) => line.segments[0]?.text)).toEqual([
      'Praxis',
      'Ready',
      'line-9',
      '❯ x▌',
      '● ok',
    ])
  })

  it('fits tiny viewports while retaining composer and status', () => {
    for (const rows of [2, 3]) {
      const frame = projectAnsiSurfaceFrame({
        screen: screen(),
        width: 40,
        rows,
        input: 'x',
        busy: false,
        status: 'ok',
        onError: () => undefined,
      })
      expect(frame.lines).toHaveLength(rows)
      expect(frame.lines.slice(-2).map((line) => line.key)).toEqual([
        'composer',
        'status',
      ])
    }
  })

  it('summarizes picker surfaces without stringifying objects', () => {
    const frame = projectAnsiSurfaceFrame({
      screen: screen({
        kind: 'session-picker',
        surface: { query: 'abc', choices: ['one', 'two'] },
      }),
      width: 40,
      rows: 5,
      input: '',
      busy: false,
      status: 'ok',
      onError: () => undefined,
    })
    expect(frame.lines.map((line) => line.segments[0]?.text)).toContain(
      'query: abc',
    )
    expect(frame.lines.map((line) => line.segments[0]?.text)).not.toContain(
      '[object Object]',
    )
  })
})
