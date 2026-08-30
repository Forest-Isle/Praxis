import { stripVTControlCharacters } from 'node:util'

import type { QuietFrame, QuietFrameRow } from './quiet-frame.js'
import {
  terminalGraphemeWidth,
  terminalGraphemes,
  terminalTextWidth,
} from './transcript-viewport.js'

export type TerminalMouseEvent =
  | {
      readonly kind: 'press' | 'drag' | 'release'
      readonly column: number
      readonly row: number
    }
  | {
      readonly kind: 'wheel'
      readonly direction: 'older' | 'newer'
      readonly column: number
      readonly row: number
    }

export interface TerminalSelectionPoint {
  readonly row: number
  readonly column: number
}

export type TerminalSelectionEdge = 'none' | 'older' | 'newer'

export interface TerminalSelectionVisibleRow {
  readonly physicalRow: number
  readonly logicalRow: number
  readonly row: QuietFrameRow
  readonly text: string
}

export interface TerminalSelectionContext {
  readonly frame: QuietFrame
  readonly transcriptRowCount: number
  readonly transcriptScrollOffset: number
  readonly maxTranscriptScrollOffset: number
  readonly visibleTranscriptRows: readonly TerminalSelectionVisibleRow[]
}

export interface TerminalSelectionState {
  readonly phase: 'idle' | 'dragging' | 'selected'
  readonly anchor: TerminalSelectionPoint | null
  readonly focus: TerminalSelectionPoint | null
  readonly rows: ReadonlyMap<number, string>
  readonly edge: TerminalSelectionEdge
}

export interface TerminalSelectionRelease {
  readonly state: TerminalSelectionState
  readonly text: string | null
}

function safeCoordinate(value: string): number | null {
  if (!/^[0-9]+$/u.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number - 1 : null
}

/** Parse one complete SGR mouse report. Coordinates returned here are zero based. */
export function parseTerminalMouseReport(
  value: string,
): TerminalMouseEvent | null {
  if (typeof value !== 'string') return null
  const report = value.codePointAt(0) === 0x1b ? value.slice(1) : value
  const match = /^\[<([0-9]+);([0-9]+);([0-9]+)([Mm])$/u.exec(report)
  if (!match) return null
  const code = Number(match[1])
  const column = safeCoordinate(match[2] ?? '')
  const row = safeCoordinate(match[3] ?? '')
  if (!Number.isSafeInteger(code) || column === null || row === null)
    return null
  const final = match[4]
  if (code === 0 && final === 'M') return { kind: 'press', column, row }
  if (code === 0 && final === 'm') return { kind: 'release', column, row }
  if (final === 'M' && code === 32) return { kind: 'drag', column, row }
  if (final === 'M' && code === 64)
    return { kind: 'wheel', direction: 'older', column, row }
  if (final === 'M' && code === 65)
    return { kind: 'wheel', direction: 'newer', column, row }
  return null
}

function cleanRowText(row: QuietFrameRow): string {
  return stripVTControlCharacters(
    row.segments.map((segment) => segment.text).join(''),
  )
}

function finiteOffset(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export function clampTranscriptScrollOffset(
  offset: number,
  maxOffset: number,
): number {
  const maximum = finiteOffset(maxOffset)
  return Math.min(maximum, finiteOffset(offset))
}

export function createTerminalSelectionContext(
  frame: QuietFrame,
  transcriptRowCount: number,
  transcriptScrollOffset: number,
  maxTranscriptScrollOffset: number,
): TerminalSelectionContext {
  const rows = frame.lines
    .map((row, physicalRow) => ({ row, physicalRow }))
    .filter(
      ({ row }) => row.region === 'transcript' && cleanRowText(row) !== '…',
    )
  const count = finiteOffset(transcriptRowCount)
  const offset = clampTranscriptScrollOffset(
    transcriptScrollOffset,
    maxTranscriptScrollOffset,
  )
  const first = finiteOffset(maxTranscriptScrollOffset) - offset
  const droppedLeading = Math.max(0, count - rows.length)
  return {
    frame,
    transcriptRowCount: count,
    transcriptScrollOffset: offset,
    maxTranscriptScrollOffset: finiteOffset(maxTranscriptScrollOffset),
    visibleTranscriptRows: rows.map(({ row, physicalRow }, index) => ({
      physicalRow,
      logicalRow: first + droppedLeading + index,
      row,
      text: cleanRowText(row),
    })),
  }
}

export function createTerminalSelectionState(): TerminalSelectionState {
  return {
    phase: 'idle',
    anchor: null,
    focus: null,
    rows: new Map(),
    edge: 'none',
  }
}

function rowAtPhysical(
  context: TerminalSelectionContext,
  point: TerminalSelectionPoint,
): TerminalSelectionVisibleRow | undefined {
  return context.visibleTranscriptRows.find(
    (row) => row.physicalRow === point.row,
  )
}

function clampColumn(column: number, text: string): number {
  const width = terminalTextWidth(text)
  if (!Number.isFinite(column)) return 0
  return Math.max(0, Math.min(Math.trunc(column), Math.max(0, width - 1)))
}

function snapshotRows(
  state: TerminalSelectionState,
  context: TerminalSelectionContext,
): ReadonlyMap<number, string> {
  const rows = new Map(state.rows)
  let changed = false
  for (const visible of context.visibleTranscriptRows) {
    if (state.rows.get(visible.logicalRow) === visible.text) continue
    rows.set(visible.logicalRow, visible.text)
    changed = true
  }
  return changed ? rows : state.rows
}

function pointFor(
  context: TerminalSelectionContext,
  point: TerminalSelectionPoint,
): TerminalSelectionPoint | null {
  const row = rowAtPhysical(context, point)
  if (!row) return null
  return { row: row.logicalRow, column: clampColumn(point.column, row.text) }
}

function edgeFor(
  context: TerminalSelectionContext,
  physicalRow: number,
): TerminalSelectionEdge {
  const first = context.visibleTranscriptRows[0]?.physicalRow
  const last = context.visibleTranscriptRows.at(-1)?.physicalRow
  if (first === undefined || last === undefined) return 'none'
  if (physicalRow <= first)
    return context.transcriptScrollOffset < context.maxTranscriptScrollOffset
      ? 'older'
      : 'none'
  if (physicalRow >= last)
    return context.transcriptScrollOffset > 0 ? 'newer' : 'none'
  return 'none'
}

export function startTerminalSelection(
  context: TerminalSelectionContext,
  point: TerminalSelectionPoint,
): TerminalSelectionState {
  const logical = pointFor(context, point)
  if (!logical) return createTerminalSelectionState()
  return {
    phase: 'dragging',
    anchor: logical,
    focus: logical,
    rows: snapshotRows(createTerminalSelectionState(), context),
    edge: 'none',
  }
}

export function updateTerminalSelection(
  state: TerminalSelectionState,
  context: TerminalSelectionContext,
  point: TerminalSelectionPoint,
): TerminalSelectionState {
  if (state.phase !== 'dragging') return state
  const logical =
    pointFor(context, point) ??
    (context.visibleTranscriptRows.length > 0
      ? (() => {
          const first = context.visibleTranscriptRows[0]
          const last = context.visibleTranscriptRows.at(-1)
          if (!first || !last) return null
          const target = point.row <= first.physicalRow ? first : last
          return {
            row: target.logicalRow,
            column: clampColumn(point.column, target.text),
          }
        })()
      : null)
  if (!logical) return state
  const rows = snapshotRows(state, context)
  const edge = edgeFor(context, point.row)
  if (
    state.focus?.row === logical.row &&
    state.focus.column === logical.column &&
    state.edge === edge &&
    rows === state.rows
  )
    return state
  return { ...state, focus: logical, rows, edge }
}

export function refreshTerminalSelection(
  state: TerminalSelectionState,
  context: TerminalSelectionContext,
  edge: TerminalSelectionEdge = state.edge,
): TerminalSelectionState {
  if (state.phase !== 'dragging') return state
  const visible = context.visibleTranscriptRows
  if (visible.length === 0) return state
  const target =
    edge === 'older'
      ? visible[0]
      : edge === 'newer'
        ? visible.at(-1)
        : undefined
  const rows = snapshotRows(state, context)
  if (!target) return rows === state.rows ? state : { ...state, rows }
  const focus = {
    row: target.logicalRow,
    column: clampColumn(state.focus?.column ?? 0, target.text),
  }
  const nextEdge = edgeFor(context, target.physicalRow)
  if (
    state.focus?.row === focus.row &&
    state.focus.column === focus.column &&
    state.edge === nextEdge &&
    rows === state.rows
  )
    return state
  return { ...state, focus, rows, edge: nextEdge }
}

function normalizedPoints(
  state: TerminalSelectionState,
): [TerminalSelectionPoint, TerminalSelectionPoint] | null {
  if (!state.anchor || !state.focus) return null
  return state.anchor.row < state.focus.row ||
    (state.anchor.row === state.focus.row &&
      state.anchor.column <= state.focus.column)
    ? [state.anchor, state.focus]
    : [state.focus, state.anchor]
}

function selectedText(text: string, start: number, end: number): string {
  const output: string[] = []
  let cell = 0
  for (const grapheme of terminalGraphemes(text)) {
    const width = terminalGraphemeWidth(grapheme)
    const clusterEnd = cell + Math.max(1, width) - 1
    if (clusterEnd >= start && cell <= end) output.push(grapheme)
    cell += width
  }
  return output.join('')
}

export function releaseTerminalSelection(
  state: TerminalSelectionState,
  context: TerminalSelectionContext,
  point?: TerminalSelectionPoint,
): TerminalSelectionRelease {
  const updated =
    point && state.phase === 'dragging'
      ? updateTerminalSelection(state, context, point)
      : state
  const selected = {
    ...updated,
    phase:
      updated.anchor && updated.focus
        ? ('selected' as const)
        : ('idle' as const),
    edge: 'none' as const,
  }
  const points = normalizedPoints(selected)
  if (!points) return { state: selected, text: null }
  const [start, end] = points
  const text: string[] = []
  for (let row = start.row; row <= end.row; row += 1) {
    const value = selected.rows.get(row)
    if (value === undefined) return { state: selected, text: null }
    text.push(
      selectedText(
        value,
        row === start.row ? start.column : 0,
        row === end.row ? end.column : Number.MAX_SAFE_INTEGER,
      ),
    )
  }
  return { state: selected, text: text.join('\n') }
}

export function projectTerminalSelection(
  frame: QuietFrame,
  state: TerminalSelectionState,
  context: TerminalSelectionContext,
): QuietFrame {
  const points = normalizedPoints(state)
  if (!points || state.phase === 'idle') return frame
  const [start, end] = points
  const lines = frame.lines.map((row) => {
    const visible = context.visibleTranscriptRows.find(
      (item) => item.row.key === row.key,
    )
    if (
      !visible ||
      visible.logicalRow < start.row ||
      visible.logicalRow > end.row
    )
      return row
    const lower = visible.logicalRow === start.row ? start.column : 0
    const upper =
      visible.logicalRow === end.row ? end.column : Number.MAX_SAFE_INTEGER
    const segments: {
      text: string
      role: QuietFrameRow['segments'][number]['role']
    }[] = []
    let position = 0
    for (const segment of row.segments) {
      const plain = stripVTControlCharacters(segment.text)
      for (const grapheme of terminalGraphemes(plain)) {
        const width = terminalGraphemeWidth(grapheme)
        const clusterEnd = position + Math.max(1, width) - 1
        const role =
          clusterEnd >= lower && position <= upper
            ? 'textSelection'
            : segment.role
        const previous = segments.at(-1)
        if (previous?.role === role)
          segments[segments.length - 1] = {
            ...previous,
            text: previous.text + grapheme,
          }
        else segments.push({ text: grapheme, role })
        position += width
      }
    }
    return { ...row, segments }
  })
  return { ...frame, lines }
}
