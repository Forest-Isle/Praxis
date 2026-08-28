import { stripVTControlCharacters } from 'node:util'

import type { QuietFrameCursor } from './quiet-frame.js'
import type { TuiRow, TuiTextRole } from './tui-row-ir.js'

export interface AnsiFrameWriter {
  write(chunk: string): void
}

export interface AnsiFrame {
  readonly columns: number
  readonly rows: number
  readonly lines: readonly TuiRow[]
  readonly cursor?: QuietFrameCursor
}

export interface AnsiFullscreenRendererOptions {
  readonly writer: AnsiFrameWriter
  readonly synchronizedOutput?: boolean
  readonly styles?: Partial<Record<TuiTextRole, string>>
}

interface ResolvedAnsiCursor extends QuietFrameCursor {
  readonly row: number
}

const ALTERNATE_SCREEN_ENTER = '\u001b[?1049h'
const ALTERNATE_SCREEN_LEAVE = '\u001b[?1049l'
const HIDE_CURSOR = '\u001b[?25l'
const SHOW_CURSOR = '\u001b[?25h'
const SYNCHRONIZED_BEGIN = '\u001b[?2026h'
const SYNCHRONIZED_END = '\u001b[?2026l'
const RESET = '\u001b[0m'

function validateFrame(frame: AnsiFrame): void {
  if (frame === null || typeof frame !== 'object') {
    throw new TypeError('ANSI frame must be an object')
  }
  for (const key of ['columns', 'rows'] as const) {
    const value = frame[key]
    if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new TypeError(`ANSI frame ${key} must be a positive finite integer`)
    }
  }
  if (!Array.isArray(frame.lines)) {
    throw new TypeError('ANSI frame lines must be an array')
  }
  if (frame.cursor !== undefined) {
    if (
      frame.cursor === null ||
      typeof frame.cursor !== 'object' ||
      typeof frame.cursor.rowKey !== 'string' ||
      frame.cursor.rowKey.length === 0 ||
      !Number.isFinite(frame.cursor.column) ||
      !Number.isInteger(frame.cursor.column) ||
      frame.cursor.column < 0
    ) {
      throw new TypeError(
        'ANSI frame cursor must have a non-empty row key and non-negative integer column',
      )
    }
  }
}

function renderLine(
  row: TuiRow,
  styles: Partial<Record<TuiTextRole, string>> | undefined,
  columns: number,
): string {
  const segments = row.segments.map((segment) => ({
    text: stripVTControlCharacters(segment.text).replace(/[\r\n]/gu, ''),
    role: segment.role,
  }))
  const visibleLength = segments.reduce(
    (length, segment) => length + Array.from(segment.text).length,
    0,
  )
  const wasTruncated = visibleLength > columns
  const targetLength = wasTruncated ? Math.max(0, columns - 1) : columns
  let remaining = targetLength
  let line = ''
  for (const segment of segments) {
    if (remaining === 0) break
    const text = Array.from(segment.text).slice(0, remaining).join('')
    remaining -= Array.from(text).length
    const style = styles?.[segment.role]
    line += style === undefined ? text : `${style}${text}${RESET}`
  }
  if (wasTruncated) line += '…'
  if (line.length === 0) line = ' '
  return line
}

export class AnsiFullscreenRenderer {
  readonly #writer: AnsiFrameWriter
  readonly #synchronizedOutput: boolean
  #styles: Partial<Record<TuiTextRole, string>> | undefined
  #mounted = false
  #previousLines: readonly string[] = []
  #previousCursor: ResolvedAnsiCursor | undefined

  constructor(options: AnsiFullscreenRendererOptions) {
    this.#writer = options.writer
    this.#synchronizedOutput = options.synchronizedOutput === true
    this.#styles = options.styles
  }

  setStyles(styles?: Partial<Record<TuiTextRole, string>>): void {
    this.#styles = styles
  }

  get mounted(): boolean {
    return this.#mounted
  }

  mount(): void {
    if (this.#mounted) return
    this.#writer.write(ALTERNATE_SCREEN_ENTER)
    this.#writer.write(HIDE_CURSOR)
    if (this.#synchronizedOutput) this.#writer.write(SYNCHRONIZED_BEGIN)
    this.#mounted = true
  }

  draw(frame: AnsiFrame): void {
    if (!this.#mounted)
      throw new Error('ANSI fullscreen renderer is not mounted')
    validateFrame(frame)
    const lines = frame.lines.map((row) =>
      renderLine(row, this.#styles, frame.columns),
    )
    const previousLines = this.#previousLines
    const changed =
      lines.length !== previousLines.length ||
      lines.some((line, index) => line !== previousLines[index])
    const cursorRow = frame.cursor
      ? frame.lines.findIndex((row) => row.key === frame.cursor?.rowKey)
      : -1
    const nextCursor =
      cursorRow >= 0 && frame.cursor !== undefined
        ? {
            rowKey: frame.cursor.rowKey,
            column: Math.min(frame.cursor.column, frame.columns - 1),
            row: cursorRow,
          }
        : undefined
    const cursorChanged =
      nextCursor?.rowKey !== this.#previousCursor?.rowKey ||
      nextCursor?.column !== this.#previousCursor?.column ||
      nextCursor?.row !== this.#previousCursor?.row
    if (!changed && !cursorChanged) return

    if (this.#synchronizedOutput) this.#writer.write(SYNCHRONIZED_BEGIN)
    try {
      if (changed) {
        if (this.#previousCursor !== undefined || nextCursor !== undefined)
          this.#writer.write(HIDE_CURSOR)
        const commonLength = Math.max(lines.length, previousLines.length)
        for (let index = 0; index < commonLength; index += 1) {
          const line = lines[index]
          if (line !== undefined) {
            if (line === previousLines[index]) continue
            this.#writer.write(`\u001b[${index + 1};1H\u001b[2K${line}`)
          } else {
            this.#writer.write(`\u001b[${index + 1};1H\u001b[2K`)
          }
        }
        this.#previousLines = lines
      }
      if (nextCursor !== undefined) {
        this.#writer.write(`\u001b[${cursorRow + 1};${nextCursor.column + 1}H`)
        this.#writer.write(SHOW_CURSOR)
      } else if (this.#previousCursor !== undefined)
        this.#writer.write(HIDE_CURSOR)
      this.#previousCursor = nextCursor
    } finally {
      if (this.#synchronizedOutput) this.#writer.write(SYNCHRONIZED_END)
    }
  }

  dispose(): void {
    if (!this.#mounted) return
    try {
      if (this.#synchronizedOutput) this.#writer.write(SYNCHRONIZED_END)
      this.#writer.write(SHOW_CURSOR)
      this.#writer.write(ALTERNATE_SCREEN_LEAVE)
    } finally {
      this.#mounted = false
      this.#previousLines = []
      this.#previousCursor = undefined
    }
  }
}
