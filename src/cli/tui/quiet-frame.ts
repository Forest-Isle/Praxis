import { stripVTControlCharacters } from 'node:util'

import type { TuiScreenModel } from './tui-screen-model.js'
import type { TuiRow, TuiRowSegment, TuiTextRole } from './tui-row-ir.js'

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
      line.replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f]/gu,
        '',
      ),
    )
}

function clean(value: unknown): string {
  return cleanLines(value).join(' ')
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
  const density = resolveQuietFrameDensity(columns)
  const lines: QuietFrameRow[] = []
  lines.push(...projectIdentity(input, density))
  const body = input.screen.body
  if (body.kind === 'conversation') {
    lines.push(
      ...body.transcript.rows.map((item) => withRegion(item, 'transcript')),
    )
    if (body.transcript.active.visible) {
      const activeText = cleanLines(body.transcript.active.text)
      if (activeText.some(Boolean))
        activeText.forEach((part, index) =>
          lines.push(
            createQuietFrameRow(
              `quiet:active:text:${index}`,
              `${index === 0 ? 'praxis> ' : '        '}${part}`,
              'active',
              'body',
              `${index === 0 ? 'Praxis: ' : ''}${part}`,
            ),
          ),
        )
      const thinking = cleanLines(body.transcript.active.thinking)
      if (thinking.some(Boolean))
        thinking.forEach((part, index) =>
          lines.push(
            createQuietFrameRow(
              `quiet:active:thinking:${index}`,
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

  if (viewportRows !== undefined && lines.length > viewportRows) {
    const status = lines.at(-1) as QuietFrameRow
    const focusStart = lines.findIndex(
      (item) => item.region === 'focus' || item.region === 'composer',
    )
    const focusRows = focusStart >= 0 ? lines.slice(focusStart, -1) : []
    const budget = Math.max(0, viewportRows - focusRows.length - 1)
    const beforeFocus =
      focusStart >= 0 ? lines.slice(0, focusStart) : lines.slice(0, -1)
    const retained = beforeFocus.slice(-budget)
    const compact = [...retained, ...focusRows, status]
    lines.splice(0, lines.length, ...compact.slice(-viewportRows))
  }
  const composer = lines.find((item) => item.key === 'quiet:composer')
  const sourceCursor = Number.isFinite(input.composerCursor)
    ? Math.min(
        Math.max(0, Math.floor(input.composerCursor)),
        input.composerText.length,
      )
    : 0
  const composerPrefix = `${input.shellMode ? 'shell>' : 'you>'} `
  const cursorColumn = Array.from(
    `${composerPrefix}${clean(input.composerText.slice(0, sourceCursor))}`,
  ).length
  const cursor = composer
    ? {
        rowKey: composer.key,
        column: Math.min(cursorColumn, columns - 1),
      }
    : undefined
  return {
    columns,
    rows: (viewportRows ?? lines.length) || 1,
    density,
    lines,
    ...(cursor ? { cursor } : {}),
  }
}
