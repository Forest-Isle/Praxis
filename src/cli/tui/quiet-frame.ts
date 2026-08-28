import { stripVTControlCharacters } from 'node:util'

import type { TuiScreenModel } from './tui-screen-model.js'
import type { TuiRow, TuiRowSegment, TuiTextRole } from './tui-row-ir.js'
import {
  terminalGraphemeWidth,
  terminalGraphemes,
  terminalTextHead,
  terminalTextTail,
  terminalTextWidth,
} from './transcript-viewport.js'

export type QuietFrameDensity =
  'full' | 'standard' | 'compact' | 'narrow' | 'minimal'
export type QuietFrameRegion =
  'identity' | 'transcript' | 'active' | 'focus' | 'composer' | 'status'

export interface QuietFrameRow extends TuiRow {
  readonly region: QuietFrameRegion
  readonly accessibleText?: string
}

export interface QuietFrameCursor {
  readonly rowKey: string
  readonly column: number
}

export interface QuietFrame {
  readonly columns: number
  readonly rows: number
  readonly density: QuietFrameDensity
  readonly lines: readonly QuietFrameRow[]
  readonly cursor?: QuietFrameCursor
}

export interface QuietFrameInput {
  readonly screen: TuiScreenModel
  readonly width: number
  readonly rows: number | undefined
  readonly composerText: string
  readonly composerCursor: number
  readonly shellMode: boolean
  readonly busy: boolean
  readonly status: string
  readonly display?: {
    readonly cwd?: string
    readonly model?: string
    readonly effort?: string
    readonly permissionMode?: string
    readonly version?: string
  }
  readonly focusRows: readonly (TuiRow & { readonly accessibleText?: string })[]
}

export function resolveQuietFrameDensity(width: number): QuietFrameDensity {
  if (width >= 100) return 'full'
  if (width >= 80) return 'standard'
  if (width >= 60) return 'compact'
  if (width >= 40) return 'narrow'
  return 'minimal'
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.floor(value as number)
    : fallback
}

function cleanLines(value: unknown): readonly string[] {
  if (typeof value !== 'string') return []
  return stripVTControlCharacters(value)
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) =>
      [...line]
        .filter((character) => {
          const code = character.charCodeAt(0)
          return !(
            code <= 0x08 ||
            code === 0x0b ||
            code === 0x0c ||
            (code >= 0x0e && code <= 0x1f) ||
            code === 0x7f ||
            (code >= 0x80 && code <= 0x9f)
          )
        })
        .join(''),
    )
}

function cleanActiveTail(
  value: unknown,
  limit: number,
): {
  readonly lines: readonly {
    readonly text: string
    readonly start: number
  }[]
  readonly hidden: boolean
} {
  if (typeof value !== 'string') return { lines: [], hidden: false }
  const max = Math.max(1, limit)
  const preserveTrailingEmpty = limit === Number.POSITIVE_INFINITY
  const end =
    value.endsWith('\n') && !preserveTrailingEmpty
      ? value.length - 1
      : value.length
  const starts: number[] = [end]
  for (let index = end - 1; index >= 0 && starts.length <= max; index -= 1) {
    if (value.charCodeAt(index) === 0x0a) starts.push(index)
  }
  const hidden = starts.length > max
  const start = hidden ? (starts[max] ?? 0) + 1 : 0
  const tail = value.slice(start, end)
  const rawLines = tail.split('\n')
  const lines = cleanLines(tail)
  let lineStart = start
  const positioned = lines.map((text, index) => {
    const result = { text, start: lineStart }
    lineStart += (rawLines[index]?.length ?? 0) + 1
    return result
  })
  return { lines: positioned.slice(-max), hidden }
}

function clean(value: unknown): string {
  return cleanLines(value).join(' ')
}

function clipRowSegments(
  segments: readonly TuiRowSegment[],
  columns: number,
): readonly TuiRowSegment[] {
  const limit = Math.max(0, columns)
  const total = segments.reduce(
    (sum, segment) => sum + terminalTextWidth(segment.text),
    0,
  )
  if (total <= limit) return segments
  const budget = Math.max(0, limit - 1)
  let used = 0
  const output: TuiRowSegment[] = []
  let stopped = false
  for (const segment of segments) {
    const kept: string[] = []
    for (const cluster of terminalGraphemes(segment.text)) {
      const width = terminalGraphemeWidth(cluster)
      if (used + width > budget) {
        stopped = true
        break
      }
      kept.push(cluster)
      used += width
    }
    if (kept.length) output.push({ ...segment, text: kept.join('') })
    if (stopped || used >= budget) break
  }
  const role = output.at(-1)?.role ?? segments[0]?.role ?? 'body'
  if (limit > 0) output.push({ text: '…', role })
  return output
}

function windowComposer(
  text: string,
  cursor: number,
  prefix: string,
  columns: number,
): { text: string; cursor: number } {
  const clusters = terminalGraphemes(text)
  const codePoints = Array.from(text)
  const sourceCursor = Number.isFinite(cursor)
    ? Math.min(Math.max(0, Math.floor(cursor)), codePoints.length)
    : 0
  let codePointOffset = 0
  let insertion = clusters.length
  for (const [index, cluster] of clusters.entries()) {
    const nextOffset = codePointOffset + Array.from(cluster).length
    if (sourceCursor <= codePointOffset) {
      insertion = index
      break
    }
    if (sourceCursor < nextOffset) {
      insertion = index + 1
      break
    }
    codePointOffset = nextOffset
  }
  const before = clusters.slice(0, insertion)
  const after = clusters.slice(insertion)
  const prefixWidth = terminalTextWidth(prefix)
  if (columns <= prefixWidth) {
    const marker = columns > 0 ? '…' : ''
    const shown = terminalTextHead(prefix, Math.max(0, columns - 1))
    return { text: `${shown}${marker}`, cursor: Math.max(0, columns - 1) }
  }
  const available = Math.max(0, columns - prefixWidth)
  const endCursor = after.length === 0
  const fullWidth = terminalTextWidth(text) + (endCursor ? 1 : 0)
  if (fullWidth <= available)
    return {
      text: `${prefix}${text}`,
      cursor: prefixWidth + terminalTextWidth(before.join('')),
    }

  const leading = before.length > 0
  const trailing = after.length > 0
  const markerCells = (leading ? 1 : 0) + (trailing ? 1 : 0)
  let budget = Math.max(0, available - markerCells - (endCursor ? 1 : 0))
  const afterFirst = after[0] ?? ''
  const afterFirstWidth = terminalGraphemeWidth(afterFirst)
  let visibleAfter = after.length && afterFirstWidth <= budget ? afterFirst : ''
  if (visibleAfter) budget -= afterFirstWidth
  const visibleBefore = terminalTextTail(before.join(''), budget)
  budget -= terminalTextWidth(visibleBefore)
  if (!visibleAfter && after.length) {
    visibleAfter = terminalTextHead(after.join(''), budget)
    budget -= terminalTextWidth(visibleAfter)
  } else if (after.length > 1 && budget > 0) {
    const remainder = terminalTextHead(after.slice(1).join(''), budget)
    visibleAfter += remainder
  }
  const lead = visibleBefore !== before.join('') ? '…' : ''
  const tail = visibleAfter !== after.join('') ? '…' : ''
  const value = `${prefix}${lead}${visibleBefore}${visibleAfter}${tail}${endCursor ? ' ' : ''}`
  return {
    text: value,
    cursor: prefixWidth + terminalTextWidth(lead + visibleBefore),
  }
}

export function createQuietFrameRow(
  key: string,
  text: string,
  region: QuietFrameRegion,
  role: TuiTextRole = 'body',
  accessibleText?: string,
): QuietFrameRow {
  const value = clean(text) || ' '
  const segment: TuiRowSegment = { text: value, role }
  return {
    key,
    segments: [segment],
    height: 1,
    source: key,
    region,
    ...(accessibleText === undefined
      ? {}
      : { accessibleText: clean(accessibleText) }),
  }
}

function withRegion(
  source: TuiRow & { readonly accessibleText?: string },
  region: QuietFrameRegion,
): QuietFrameRow {
  const segments = source.segments.map((segment) => ({
    ...segment,
    text: clean(segment.text) || ' ',
  }))
  return {
    ...source,
    segments,
    region,
    ...(source.source === undefined ? {} : { source: source.source }),
    ...(source.accessibleText === undefined
      ? {}
      : { accessibleText: clean(source.accessibleText) }),
  }
}

function selectQuietFocusRows(
  rows: readonly (TuiRow & { readonly accessibleText?: string })[],
  budget: number,
): readonly (TuiRow & { readonly accessibleText?: string })[] {
  const limit = Number.isFinite(budget)
    ? Math.max(0, Math.floor(budget))
    : budget === Number.POSITIVE_INFINITY
      ? rows.length
      : 0
  if (limit === 0 || rows.length === 0) return []
  if (rows.length <= limit) return rows
  const selected = rows.findIndex((row) =>
    row.segments.some((segment) => segment.role === 'selection'),
  )
  if (limit === 1)
    return [rows[selected >= 0 ? selected : 0] as (typeof rows)[number]]

  const anchorIndexes = new Set<number>([0, rows.length - 1])
  if (selected >= 0) anchorIndexes.add(selected)
  const chosen = new Set<number>()
  if (anchorIndexes.size <= limit) {
    for (const index of anchorIndexes) chosen.add(index)
  } else {
    chosen.add(0)
    if (selected >= 0) chosen.add(selected)
    if (chosen.size < limit) chosen.add(rows.length - 1)
  }
  const center = selected >= 0 ? selected : 0
  const candidates = rows
    .map((_, index) => index)
    .filter((index) => !chosen.has(index))
    .sort((left, right) => {
      const distance = Math.abs(left - center) - Math.abs(right - center)
      return distance || left - right
    })
  for (const index of candidates) {
    if (chosen.size >= limit) break
    chosen.add(index)
  }
  return rows.filter((_, index) => chosen.has(index))
}

function projectIdentity(
  input: QuietFrameInput,
  density: QuietFrameDensity,
): QuietFrameRow[] {
  const body = input.screen.body
  if (body.kind === 'session-picker')
    return [
      createQuietFrameRow(
        'quiet:identity',
        'Praxis · Sessions',
        'identity',
        'heading',
      ),
    ]
  if (body.intro !== 'identity' && body.intro !== 'welcome') return []
  const bits = ['Praxis']
  if (body.sessionLabel) bits.push(`session ${clean(body.sessionLabel)}`)
  if (density === 'full' || density === 'standard') {
    if (input.display?.version) bits.push(`v${clean(input.display.version)}`)
    if (input.display?.model) bits.push(`model ${clean(input.display.model)}`)
    if (input.display?.cwd)
      bits.push(`cwd ${clean(input.display.cwd).slice(0, 80)}`)
  }
  return [
    createQuietFrameRow(
      'quiet:identity',
      bits.join(' · '),
      'identity',
      'heading',
      'Praxis session identity',
    ),
  ]
}

export function projectQuietFrame(input: QuietFrameInput): QuietFrame {
  const columns = positive(input.width, 1)
  const viewportRows =
    input.rows === undefined ? undefined : positive(input.rows, 1)
  const screenReader = input.screen.presentation.screenReader
  const density = resolveQuietFrameDensity(columns)
  const minimalVisualDensity = !screenReader && density === 'minimal'
  const lines: QuietFrameRow[] = []
  if (!minimalVisualDensity) lines.push(...projectIdentity(input, density))
  const body = input.screen.body
  if (body.kind === 'conversation') {
    lines.push(
      ...body.transcript.rows
        .filter(
          (item) =>
            !minimalVisualDensity ||
            item.segments.some((segment) => segment.role === 'error'),
        )
        .map((item) => withRegion(item, 'transcript')),
    )
    if (body.transcript.active.visible && !minimalVisualDensity) {
      const activeTail = screenReader
        ? cleanActiveTail(body.transcript.active.text, Number.POSITIVE_INFINITY)
        : cleanActiveTail(
            body.transcript.active.text,
            viewportRows === undefined ? 200 : Math.max(1, viewportRows - 2),
          )
      const activeText = activeTail.lines
      if (activeText.some(({ text }) => Boolean(text)))
        activeText.forEach(({ text: part, start }, index) =>
          lines.push(
            createQuietFrameRow(
              `quiet:active:text:${start}`,
              `${index === 0 ? 'praxis> ' : '        '}${index === 0 && activeTail.hidden ? '… ' : ''}${part}`,
              'active',
              'body',
              `${index === 0 ? 'Praxis: ' : ''}${part}`,
            ),
          ),
        )
      const thinking = screenReader
        ? cleanActiveTail(
            body.transcript.active.thinking,
            Number.POSITIVE_INFINITY,
          )
        : cleanActiveTail(
            body.transcript.active.thinking,
            viewportRows === undefined ? 200 : Math.max(1, viewportRows - 2),
          )
      if (thinking.lines.some(({ text }) => Boolean(text)))
        thinking.lines.forEach(({ text: part, start }, index) =>
          lines.push(
            createQuietFrameRow(
              `quiet:active:thinking:${start}`,
              `${index === 0 ? '… ' : '  '}${part}`,
              'active',
              'muted',
              `${index === 0 ? 'Thinking: ' : ''}${part}`,
            ),
          ),
        )
    }
  }
  const focus =
    input.focusRows.length > 0
      ? input.focusRows.map((item) => withRegion(item, 'focus'))
      : [
          createQuietFrameRow(
            'quiet:composer',
            `${input.shellMode ? 'shell>' : 'you>'} ${clean(input.composerText)}`,
            'composer',
            'input',
            `${input.shellMode ? 'Shell' : 'Composer'} input field`,
          ),
        ]
  lines.push(...focus)
  const statusText = `${input.busy ? 'Working · ' : ''}${clean(input.status) || (input.busy ? 'In progress' : 'Ready')}`
  lines.push(
    createQuietFrameRow(
      'quiet:status',
      statusText,
      'status',
      input.busy ? 'warning' : 'muted',
      statusText,
    ),
  )

  if (
    !screenReader &&
    viewportRows !== undefined &&
    lines.length > viewportRows
  ) {
    const status = lines.at(-1) as QuietFrameRow
    const focusStart = lines.findIndex(
      (item) => item.region === 'focus' || item.region === 'composer',
    )
    const focusRows =
      focusStart >= 0
        ? selectQuietFocusRows(
            lines.slice(focusStart, -1),
            viewportRows - 1,
          ).map((row) => row as QuietFrameRow)
        : []
    const budget = Math.max(0, viewportRows - focusRows.length - 1)
    const beforeFocus =
      focusStart >= 0 ? lines.slice(0, focusStart) : lines.slice(0, -1)
    const retained = beforeFocus.slice(-budget)
    const compact = [...retained, ...focusRows, status]
    lines.splice(0, lines.length, ...compact)
  }
  const composerPrefix = `${input.shellMode ? 'shell>' : 'you>'} `
  if (!screenReader) {
    for (let index = 0; index < lines.length; index += 1) {
      const row = lines[index]
      if (!row) continue
      if (row.key === 'quiet:composer' && input.focusRows.length === 0) {
        const projection = windowComposer(
          clean(input.composerText),
          Number.isFinite(input.composerCursor) ? input.composerCursor : 0,
          composerPrefix,
          columns,
        )
        lines[index] = {
          ...row,
          segments: [
            { text: projection.text, role: row.segments[0]?.role ?? 'input' },
          ],
        }
      } else {
        lines[index] = {
          ...row,
          segments: clipRowSegments(row.segments, columns),
        }
      }
    }
  }
  const composer = lines.find((item) => item.key === 'quiet:composer')
  const cursorColumn = composer
    ? windowComposer(
        clean(input.composerText),
        Number.isFinite(input.composerCursor) ? input.composerCursor : 0,
        composerPrefix,
        columns,
      ).cursor
    : 0
  const cursor = composer
    ? {
        rowKey: composer.key,
        column: Math.min(Math.max(0, cursorColumn), columns - 1),
      }
    : undefined
  return {
    columns,
    rows: (screenReader ? lines.length : (viewportRows ?? lines.length)) || 1,
    density,
    lines,
    ...(cursor ? { cursor } : {}),
  }
}
