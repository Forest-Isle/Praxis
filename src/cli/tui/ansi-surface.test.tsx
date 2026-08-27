import { describe, expect, it } from 'vitest'

import { projectAnsiSurfaceFrame } from './ansi-surface.js'

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
  } as any
}

describe('projectAnsiSurfaceFrame', () => {
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
      'hello',
      'streaming',
      '❯ prompt',
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
      rows: 3,
      input: 'x',
      busy: false,
      status: 'ok',
      onError: () => undefined,
    })
    expect(frame.lines.map((line) => line.segments[0]?.text)).toEqual([
      'line-9',
      '❯ x',
      '● ok',
    ])
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
