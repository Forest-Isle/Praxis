import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import {
  projectQuietInkFrameLines,
  QuietInkFrame,
} from './quiet-frame-adapter.js'
import type { QuietFrame } from './quiet-frame.js'

const frame = (
  segments: QuietFrame['lines'][number]['segments'][],
  cursor?: QuietFrame['cursor'],
): QuietFrame => ({
  columns: 20,
  rows: segments.length,
  density: 'standard',
  lines: segments.map((items, index) => ({
    key: `row:${index}`,
    segments: items,
    height: 1,
    region: 'transcript',
  })),
  ...(cursor === undefined ? {} : { cursor }),
})

describe('projectQuietInkFrameLines', () => {
  it('maps all row roles and preserves stable keys', () => {
    const roles = [
      'body',
      'heading',
      'muted',
      'accent',
      'success',
      'warning',
      'error',
      'tool',
      'selection',
      'input',
      'diffAdded',
      'diffRemoved',
    ] as const
    const result = projectQuietInkFrameLines(
      frame(roles.map((role) => [{ text: role, role }])),
    )
    expect(result.map((line) => line.key)).toEqual(
      roles.map((_, i) => `row:${i}`),
    )
    expect(result.map((line) => line.segments[0]?.role)).toEqual([
      'body',
      'heading',
      'muted',
      'focusMarker',
      'success',
      'warning',
      'error',
      'info',
      'focusMarker',
      'inputMarker',
      'diffAdded',
      'diffRemoved',
    ])
  })

  it('uses code points and selects the next segment at boundaries', () => {
    const result = projectQuietInkFrameLines(
      frame(
        [
          [
            { text: 'a', role: 'body' },
            { text: '界b', role: 'input' },
          ],
        ],
        { rowKey: 'row:0', column: 1 },
      ),
    )
    expect(result[0]?.segments).toEqual([
      { text: 'a', role: 'body' },
      { text: '界', role: 'inputMarker', cursor: true },
      { text: 'b', role: 'inputMarker' },
    ])
  })

  it('appends one cursor cell at row end and uses accessible text for screen readers', () => {
    const source = frame([[{ text: 'hi', role: 'body' }]], {
      rowKey: 'row:0',
      column: 2,
    })
    const normal = projectQuietInkFrameLines(source)
    expect(normal[0]?.segments).toEqual([
      { text: 'hi', role: 'body' },
      { text: ' ', role: 'body', cursor: true },
    ])
    const accessible = {
      ...source.lines[0],
      key: 'row:0',
      segments: [{ text: 'hi', role: 'body' as const }],
      height: 1,
      region: 'transcript' as const,
      accessibleText: 'spoken',
    }
    expect(
      projectQuietInkFrameLines({ ...source, lines: [accessible] }, true)[0]
        ?.segments,
    ).toEqual([{ text: 'spoken', role: 'body' }])
    expect(projectQuietInkFrameLines(source, true)[0]?.segments).toEqual([
      { text: 'hi', role: 'body' },
    ])
  })

  it('selects a grapheme by terminal-cell cursor position across roles', () => {
    const result = projectQuietInkFrameLines(
      frame(
        [
          [
            { text: 'a', role: 'body' },
            { text: '界b', role: 'input' },
          ],
        ],
        { rowKey: 'row:0', column: 2 },
      ),
    )
    expect(result[0]?.segments).toEqual([
      { text: 'a', role: 'body' },
      { text: '界', role: 'inputMarker', cursor: true },
      { text: 'b', role: 'inputMarker' },
    ])
  })

  it('keeps a ZWJ emoji whole when the cursor occupies its second cell', () => {
    const result = projectQuietInkFrameLines(
      frame([[{ text: 'x👩‍💻y', role: 'input' }]], {
        rowKey: 'row:0',
        column: 2,
      }),
    )
    expect(result[0]?.segments).toEqual([
      { text: 'x', role: 'inputMarker' },
      { text: '👩‍💻', role: 'inputMarker', cursor: true },
      { text: 'y', role: 'inputMarker' },
    ])
  })

  it('renders only the projected borderless lines', () => {
    const source = frame([
      [{ text: 'Praxis', role: 'heading' }],
      [{ text: 'you> hello', role: 'input' }],
    ])
    const app = render(<QuietInkFrame frame={source} />)
    expect(app.lastFrame()).toBe('Praxis\nyou> hello')
    expect(app.lastFrame()).not.toMatch(/[╭╮╰╯│]/u)
  })
})
