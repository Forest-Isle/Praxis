import { stripVTControlCharacters } from 'node:util'

import { describe, expect, it } from 'vitest'
import {
  AnsiFullscreenRenderer,
  type AnsiFrame,
} from './ansi-frame-renderer.js'
import type { TuiRow, TuiTextRole } from './tui-row-ir.js'

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
      '\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[?25h\u001b[?1049l',
    )
    expect(renderer.mounted).toBe(false)
  })

  it('rolls back a mount that fails after entering the alternate screen', () => {
    const output: string[] = []
    let fail = true
    const mountError = new Error('cursor initialization failed')
    const renderer = new AnsiFullscreenRenderer({
      writer: {
        write: (chunk) => {
          output.push(chunk)
          if (fail && chunk === '\u001b[?25l') throw mountError
        },
      },
    })

    expect(() => renderer.mount()).toThrow(mountError)
    expect(output).toEqual([
      '\u001b[?1049h',
      '\u001b[?25l',
      '\u001b[?25h',
      '\u001b[?1049l',
    ])
    expect(renderer.mounted).toBe(false)
    expect(() => renderer.draw(frame([]))).toThrow(
      'ANSI fullscreen renderer is not mounted',
    )

    fail = false
    output.length = 0
    renderer.mount()
    expect(renderer.mounted).toBe(true)
    renderer.dispose()
    expect(output.join('')).toBe(
      '\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[?25h\u001b[?1049l',
    )
  })

  it('rolls back synchronized mount failures independently and preserves the original error', () => {
    const output: string[] = []
    let fail = true
    const mountError = new Error('synchronized output initialization failed')
    const renderer = new AnsiFullscreenRenderer({
      writer: {
        write: (chunk) => {
          output.push(chunk)
          if (fail && chunk === '\u001b[?2026h') throw mountError
          if (fail && chunk === '\u001b[?2026l')
            throw new Error('synchronized output rollback failed')
        },
      },
      synchronizedOutput: true,
    })

    expect(() => renderer.mount()).toThrow(mountError)
    expect(output).toEqual([
      '\u001b[?1049h',
      '\u001b[?25l',
      '\u001b[?1000h',
      '\u001b[?1002h',
      '\u001b[?1003h',
      '\u001b[?1006h',
      '\u001b[?2026h',
      '\u001b[?1006l',
      '\u001b[?1003l',
      '\u001b[?1002l',
      '\u001b[?1000l',
      '\u001b[?2026l',
      '\u001b[?25h',
      '\u001b[?1049l',
    ])
    expect(renderer.mounted).toBe(false)

    fail = false
    output.length = 0
    renderer.mount()
    expect(renderer.mounted).toBe(true)
    renderer.dispose()
    expect(output.join('')).toBe(
      '\u001b[?1049h\u001b[?25l\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?2026h\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[?2026l\u001b[?25h\u001b[?1049l',
    )
  })

  it('rolls back a partial mouse-mode enable and preserves its original error', () => {
    const output: string[] = []
    const mountError = new Error('third mouse mode failed')
    const renderer = new AnsiFullscreenRenderer({
      writer: {
        write: (chunk) => {
          output.push(chunk)
          if (chunk === '\u001b[?1003h') throw mountError
        },
      },
    })

    expect(() => renderer.mount()).toThrow(mountError)
    expect(output).toEqual([
      '\u001b[?1049h',
      '\u001b[?25l',
      '\u001b[?1000h',
      '\u001b[?1002h',
      '\u001b[?1003h',
      '\u001b[?1003l',
      '\u001b[?1002l',
      '\u001b[?1000l',
      '\u001b[?25h',
      '\u001b[?1049l',
    ])
    expect(renderer.mounted).toBe(false)
  })

  it('attempts every disposal restoration and throws the first error', () => {
    const output: string[] = []
    const firstError = new Error('mouse disable failed')
    let fail = false
    const renderer = new AnsiFullscreenRenderer({
      writer: {
        write: (chunk) => {
          output.push(chunk)
          if (fail && chunk === '\u001b[?1006l') throw firstError
          if (fail && chunk === '\u001b[?25h')
            throw new Error('cursor show failed')
        },
      },
    })
    renderer.mount()
    output.length = 0
    fail = true
    expect(() => renderer.dispose()).toThrow(firstError)
    expect(output).toEqual([
      '\u001b[?1006l',
      '\u001b[?1003l',
      '\u001b[?1002l',
      '\u001b[?1000l',
      '\u001b[?25h',
      '\u001b[?1049l',
    ])
    const count = output.length
    renderer.dispose()
    expect(output).toHaveLength(count)
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

  it('clears the screen and invalidates the dirty-row cache', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
      synchronizedOutput: true,
    })
    renderer.mount()
    renderer.draw(frame([row('same')]))
    output.length = 0
    renderer.clear()
    expect(output.join('')).toContain(
      '\u001b[?2026h\u001b[2J\u001b[H\u001b[?2026l',
    )
    output.length = 0
    renderer.draw(frame([row('same')]))
    expect(output.join('')).toContain('\u001b[1;1H\u001b[2Ksame')
    renderer.dispose()
    expect(() => renderer.clear()).toThrow('not mounted')
  })

  it('moves or hides the cursor without redrawing unchanged rows', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
    })
    renderer.mount()
    renderer.draw({
      ...frame([row('first'), row('second')]),
      cursor: { rowKey: 'first', column: 2 },
    })
    output.length = 0

    renderer.draw({
      ...frame([row('first'), row('second')]),
      cursor: { rowKey: 'first', column: 3 },
    })
    expect(output.join('')).toBe('\u001b[1;4H\u001b[?25h')
    expect(output.join('')).not.toContain('\u001b[2K')

    output.length = 0
    renderer.draw({
      ...frame([row('first'), row('second')]),
      cursor: { rowKey: 'first', column: 3 },
    })
    expect(output).toHaveLength(0)

    renderer.draw({
      ...frame([row('first'), row('second')]),
      cursor: { rowKey: 'missing', column: 3 },
    })
    expect(output.join('')).toBe('\u001b[?25l')
    expect(output.join('')).not.toContain('\u001b[2K')
  })

  it('tracks cursor physical rows, clamps columns, and restores it after writes', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
    })
    const keyed = (key: string): TuiRow => ({
      key,
      segments: [{ text: 'same', role: 'body' }],
      height: 1,
    })
    renderer.mount()
    renderer.draw({
      ...frame([keyed('a'), keyed('b')], 4),
      cursor: { rowKey: 'a', column: 99 },
    })
    expect(output.join('')).toContain('\u001b[1;4H\u001b[?25h')

    output.length = 0
    renderer.draw({
      ...frame([keyed('b'), keyed('a')], 4),
      cursor: { rowKey: 'a', column: 99 },
    })
    expect(output.join('')).toBe('\u001b[2;4H\u001b[?25h')
    expect(output.join('')).not.toContain('\u001b[2K')

    output.length = 0
    renderer.draw({
      ...frame(
        [
          keyed('b'),
          { ...keyed('a'), segments: [{ text: 'next', role: 'body' }] },
        ],
        4,
      ),
      cursor: { rowKey: 'a', column: 1 },
    })
    expect(output.join('')).toBe(
      '\u001b[?25l\u001b[2;1H\u001b[2Knext\u001b[2;2H\u001b[?25h',
    )
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

  it('clips by terminal cells without splitting graphemes or leaking segments', () => {
    const render = (
      line: TuiRow,
      columns: number,
      styles?: Partial<Record<TuiTextRole, string>>,
    ) => {
      const output: string[] = []
      const options = {
        writer: { write: (chunk: string) => output.push(chunk) },
      }
      const renderer = new AnsiFullscreenRenderer(
        styles === undefined ? options : { ...options, styles },
      )
      renderer.mount()
      renderer.draw(frame([line], columns))
      return output.join('')
    }

    expect(render(row('e\u0301e\u0301e\u0301'), 3)).toContain(
      'e\u0301e\u0301e\u0301',
    )
    expect(render(row('👩‍💻'), 2)).toContain('👩‍💻')
    expect(render(row('界界'), 3)).toContain('界…')

    const leaking = render(
      {
        key: 'wide',
        segments: [
          { text: '界', role: 'body' },
          { text: 'leak', role: 'heading' },
        ],
        height: 1,
      },
      2,
    )
    expect(leaking.endsWith('…')).toBe(true)
    expect(stripVTControlCharacters(leaking)).toBe('…')

    expect(
      render(
        {
          key: 'styled',
          segments: [
            { text: 'a', role: 'body' },
            { text: 'b', role: 'heading' },
          ],
          height: 1,
        },
        2,
        { body: '\u001b[31m', heading: '\u001b[1m' },
      ),
    ).toContain('\u001b[31ma\u001b[0m\u001b[1mb\u001b[0m')
  })

  it('applies replacement styles to subsequent draws', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
      styles: { body: '\u001b[31m' },
    })
    renderer.mount()
    renderer.draw(frame([row('one')]))
    output.length = 0
    renderer.setStyles({ body: '\u001b[32m' })
    renderer.draw(frame([row('one')]))
    expect(output.join('')).toContain(
      '\u001b[1;1H\u001b[2K\u001b[32mone\u001b[0m',
    )
  })

  it('rejects invalid frames before writing and can dispose after writer errors', () => {
    const output: string[] = []
    const renderer = new AnsiFullscreenRenderer({
      writer: { write: (x) => output.push(x) },
    })
    renderer.mount()
    expect(() => renderer.draw(frame([], 0))).toThrow(TypeError)
    output.length = 0
    expect(() =>
      renderer.draw({
        ...frame([]),
        cursor: { rowKey: 'row', column: Number.NaN },
      }),
    ).toThrow(TypeError)
    expect(output).toHaveLength(0)
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
