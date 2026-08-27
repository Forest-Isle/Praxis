import { useEffect, useRef } from 'react'
import { useStdout } from 'ink'

import {
  AnsiFullscreenRenderer,
  type AnsiFrame,
} from './ansi-frame-renderer.js'
import type { TuiRow, TuiTextRole } from './tui-row-ir.js'
import type { TuiScreenModel } from './tui-screen-model.js'

export interface TuiAnsiSurfaceProps {
  screen: TuiScreenModel
  width: number
  rows: number | undefined
  input: string
  busy: boolean
  status: string
  screenReader?: boolean
  onError: (error: unknown) => void
}

// Keep line breaks long enough for active stream projection to split them;
// every emitted row is still guaranteed to contain no line breaks.
function isUnsafeControl(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  return (
    (codePoint >= 0 && codePoint <= 9) ||
    codePoint === 11 ||
    codePoint === 12 ||
    (codePoint >= 14 && codePoint <= 31) ||
    codePoint === 127
  )
}

function safeText(value: unknown): string {
  return typeof value === 'string'
    ? Array.from(value)
        .filter((character) => !isUnsafeControl(character))
        .join('')
    : ''
}

function row(key: string, text: string, role: TuiTextRole = 'body'): TuiRow {
  return {
    key,
    segments: [{ text: safeText(text) || ' ', role }],
    height: 1,
    source: key,
  }
}

function activeRows(
  key: string,
  text: string,
  role: TuiTextRole = 'body',
): TuiRow[] {
  return safeText(text)
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line, index) => row(`${key}:${index}`, line, role))
}

function summarize(value: unknown, depth = 0): string[] {
  if (depth > 1 || value === null || typeof value !== 'object') return []
  const result: string[] = []
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string' && item.length > 0) {
      result.push(`${key}: ${safeText(item).slice(0, 120)}`)
    } else if (Array.isArray(item)) {
      const strings = item.filter(
        (entry): entry is string => typeof entry === 'string',
      )
      if (strings.length > 0)
        result.push(`${key}: ${strings.slice(0, 4).map(safeText).join(', ')}`)
    } else if (typeof item === 'object' && item !== null) {
      result.push(...summarize(item, depth + 1).slice(0, 4))
    }
    if (result.length >= 8) break
  }
  return result.slice(0, 8)
}

function surfaceRows(screen: TuiScreenModel): TuiRow[] {
  const body = screen.body
  if (body.kind === 'session-picker') {
    return [
      row('ansi:session-picker', 'Sessions', 'heading'),
      ...summarize(body.surface).map((text, index) =>
        row(`ansi:session:${index}`, text, 'muted'),
      ),
    ]
  }
  if (body.foreground.kind !== 'compose') {
    const surface = body.foreground.surface
    return [
      row(
        `ansi:foreground:${body.foreground.kind}`,
        body.foreground.kind,
        'heading',
      ),
      ...summarize(surface).map((text, index) =>
        row(`ansi:foreground:${index}`, text, 'muted'),
      ),
    ]
  }
  return []
}

/** ANSI mode is intentionally limited to the plain conversation surface. */
export function supportsAnsiSurface(screen: TuiScreenModel): boolean {
  if (screen.body.kind !== 'conversation') return false
  return (
    screen.body.foreground.kind === 'compose' &&
    screen.body.foreground.overlays.length === 0
  )
}

export function projectAnsiSurfaceFrame(props: TuiAnsiSurfaceProps): AnsiFrame {
  const body = props.screen.body
  const lines: TuiRow[] = [...surfaceRows(props.screen)]
  if (body.kind === 'conversation') {
    lines.push(...body.transcript.rows)
    if (body.transcript.active.visible) {
      if (safeText(body.transcript.active.text))
        lines.push(
          ...activeRows('ansi:active:text', body.transcript.active.text),
        )
      if (safeText(body.transcript.active.thinking))
        lines.push(
          ...activeRows(
            'ansi:active:thinking',
            body.transcript.active.thinking,
            'muted',
          ),
        )
    }
  }
  lines.push(row('composer', `❯ ${props.input}`, 'input'))
  lines.push(
    row('status', `● ${props.status}${props.busy ? ' · busy' : ''}`, 'muted'),
  )

  const limit =
    props.rows === undefined ? lines.length : Math.max(2, props.rows)
  const chrome = lines.slice(-2)
  const content = lines.slice(0, -2).slice(-Math.max(0, limit - 2))
  return {
    columns: Math.max(1, Math.floor(props.width)),
    rows: limit,
    lines: [...content, ...chrome],
  }
}

export function TuiAnsiSurface(props: TuiAnsiSurfaceProps) {
  const { stdout } = useStdout()
  const rendererRef = useRef<AnsiFullscreenRenderer | null>(null)
  const failedRef = useRef(false)
  if (rendererRef.current === null) {
    rendererRef.current = new AnsiFullscreenRenderer({
      writer: { write: (chunk) => stdout.write(chunk) },
      synchronizedOutput:
        typeof (stdout as { writeSynchronized?: unknown }).writeSynchronized ===
        'function',
    })
  }
  useEffect(() => {
    const renderer = rendererRef.current
    if (renderer === null) return
    try {
      renderer.mount()
    } catch (error) {
      failedRef.current = true
      props.onError(error)
    }
    return () => {
      try {
        renderer.dispose()
      } catch (error) {
        props.onError(error)
      }
    }
  }, [])
  useEffect(() => {
    if (failedRef.current) return
    const renderer = rendererRef.current
    if (renderer === null) return
    try {
      renderer.draw(projectAnsiSurfaceFrame(props))
    } catch (error) {
      failedRef.current = true
      props.onError(error)
    }
  }, [props])
  return null
}
