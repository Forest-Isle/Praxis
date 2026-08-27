import { describe, expect, it } from 'vitest'
import {
  AnsiFullscreenRenderer,
  type AnsiFrame,
} from './ansi-frame-renderer.js'
import type { TuiRow } from './tui-row-ir.js'

const row = (
  text: string,
  role: TuiRow['segments'][number]['role'] = 'body',
): TuiRow => ({
  key: text,
  segments: [{ text, role }],
  height: 1,
})
const frame = (lines: readonly TuiRow[], columns = 20): AnsiFrame => ({
  columns,
  rows: 10,
  lines,
})

describe('AnsiFullscreenRenderer', () => {
  it('mounts and disposes an alternate screen exactly once', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
    })
    renderer.mount()
    renderer.mount()
    expect(renderer.mounted).toBe(true)
    renderer.dispose()
    renderer.dispose()
    expect(output.join('')).toBe(
      '\u001b[?1049h\u001b[?25l\u001b[?25h\u001b[?1049l',
    )
    expect(renderer.mounted).toBe(false)
  })

  it('balances synchronized markers and emits only dirty rows', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
      synchronizedOutput: true,
    })
    renderer.mount()
    renderer.draw(frame([row('a'), row('b')]))
    const first = output.join('')
    output.length = 0
    renderer.draw(frame([row('a'), row('b')]))
    expect(output).toHaveLength(0)
    renderer.draw(frame([row('a'), row('c')]))
    expect(output.join('')).toBe(
      '\u001b[?2026h\u001b[2;1H\u001b[2Kc\u001b[?2026l',
    )
    expect(first).toContain('\u001b[?2026h')
    expect(first).toContain('\u001b[?2026l')
    renderer.dispose()
    expect(output.join('')).toContain('\u001b[?2026l')
  })

  it('erases stale rows and sanitizes, styles, and clips text', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
      styles: { heading: '\u001b[1m' },
    })
    renderer.mount()
    renderer.draw(frame([row('one\n\u001b[31mtwo', 'heading'), row('stale')]))
    output.length = 0
    renderer.draw(frame([row('abcdef')], 4))
    expect(output.join('')).toContain('\u001b[1;1H\u001b[2Kabc…')
    expect(output.join('')).toContain('\u001b[2;1H\u001b[2K')
  })

  it('rejects invalid frames before writing and can dispose after writer errors', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
    })
    renderer.mount()
    expect(() => renderer.draw(frame([], 0))).toThrow(TypeError)
    let fail = true
    const failing = new AnsiFullscreenRenderer({
      writer: {
        write: (x) => {
          output.push(x)
          if (fail && x.includes('hello')) throw new Error('write failed')
        },
      },
    })
    failing.mount()
    expect(() => failing.draw(frame([row('hello')]))).toThrow('write failed')
    fail = false
    expect(() => failing.dispose()).not.toThrow()
  })
})
