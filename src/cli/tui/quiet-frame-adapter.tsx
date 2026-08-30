import { Text } from 'ink'

import type { QuietFrame, QuietFrameRow } from './quiet-frame.js'
import { useTuiTheme, type TuiTextRole } from './theme.js'
import type { TuiTextRole as RowIrTextRole } from './tui-row-ir.js'
import {
  terminalGraphemeWidth,
  terminalGraphemes,
  terminalTextWidth,
} from './transcript-viewport.js'

export interface QuietInkLineSegment {
  readonly text: string
  readonly role: TuiTextRole
  readonly cursor?: boolean
}

export interface QuietInkFrameLine {
  readonly key: string
  readonly segments: readonly QuietInkLineSegment[]
}

const ROLE_MAP: Readonly<Record<RowIrTextRole, TuiTextRole>> = {
  body: 'body',
  heading: 'heading',
  muted: 'muted',
  accent: 'focusMarker',
  success: 'success',
  warning: 'warning',
  error: 'error',
  tool: 'info',
  selection: 'focusMarker',
  textSelection: 'inputCursor',
  input: 'inputMarker',
  diffAdded: 'diffAdded',
  diffRemoved: 'diffRemoved',
}

function plainText(row: QuietFrameRow): string {
  return row.segments.map((segment) => segment.text).join('') || ' '
}

export function projectQuietInkFrameLines(
  frame: QuietFrame,
  screenReader = false,
): readonly QuietInkFrameLine[] {
  return frame.lines.map((row) => {
    if (screenReader)
      return {
        key: row.key,
        segments: [
          {
            text: row.accessibleText ?? plainText(row),
            role: 'body',
          },
        ],
      }
    const cursor =
      frame.cursor?.rowKey === row.key ? frame.cursor.column : undefined
    if (cursor === undefined)
      return {
        key: row.key,
        segments: row.segments.map((segment) => ({
          ...segment,
          role: ROLE_MAP[segment.role],
        })),
      }
    const output: QuietInkLineSegment[] = []
    let position = 0
    let inserted = false
    for (const segment of row.segments) {
      const chars = terminalGraphemes(segment.text)
      const mappedRole = ROLE_MAP[segment.role]
      const segmentWidth = terminalTextWidth(segment.text)
      if (!inserted && cursor >= position && cursor < position + segmentWidth) {
        let offset = 0
        let cell = position
        for (const [index, grapheme] of chars.entries()) {
          const width = terminalGraphemeWidth(grapheme)
          if (cursor < cell + width) {
            offset = index
            break
          }
          cell += width
        }
        const before = chars.slice(0, offset).join('')
        const at = chars[offset] ?? ' '
        const after = chars
          .slice(offset + (offset < chars.length ? 1 : 0))
          .join('')
        if (before) output.push({ text: before, role: mappedRole })
        output.push({ text: at, role: mappedRole, cursor: true })
        if (after) output.push({ text: after, role: mappedRole })
        inserted = true
      } else output.push({ text: segment.text, role: mappedRole })
      position += segmentWidth
    }
    if (!inserted) output.push({ text: ' ', role: 'body', cursor: true })
    return { key: row.key, segments: output }
  })
}

export interface QuietInkFrameProps {
  readonly frame: QuietFrame
  readonly screenReader?: boolean
}

export function QuietInkFrame({
  frame,
  screenReader = false,
}: QuietInkFrameProps) {
  const theme = useTuiTheme()
  const lines = projectQuietInkFrameLines(frame, screenReader)
  return (
    <>
      {lines.map((line) => (
        <Text key={line.key}>
          {line.segments.map((segment, index) => {
            const style = theme.text[segment.role]
            return (
              <Text
                key={`${line.key}:${index}`}
                {...style}
                {...(segment.cursor || style.inverse ? { inverse: true } : {})}
              >
                {segment.text}
              </Text>
            )
          })}
        </Text>
      ))}
    </>
  )
}
