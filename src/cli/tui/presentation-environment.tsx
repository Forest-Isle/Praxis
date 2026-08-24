import { useEffect, useRef, useState } from 'react'
import { useStdout } from 'ink'

import type { TuiRendererMode } from './tui-view-model.js'

export type TuiPresentationKind = 'fullscreen' | 'classic' | 'screen-reader'

export interface TuiTerminalViewport {
  readonly columns: number
  readonly rows: number | undefined
  readonly revision: number
  readonly source: 'terminal' | 'override' | 'fallback'
}

export interface TuiPresentationEnvironment {
  readonly kind: TuiPresentationKind
  readonly viewport: TuiTerminalViewport
  readonly fixedViewport: boolean
  readonly screenReader: boolean
}

export interface TuiPresentationEnvironmentInput {
  readonly renderer: TuiRendererMode
  readonly screenReader: boolean
  readonly viewportOverride?: Readonly<{ columns?: number; rows?: number }>
}

export interface TuiInkRenderOptions {
  readonly incrementalRendering: boolean
  readonly alternateScreen: boolean
  readonly isScreenReaderEnabled: boolean
  readonly maxFps: number
  readonly concurrent: false
}

function normalizeDimension(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    return undefined
  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : undefined
}

function initialViewport(
  stdout: NodeJS.WriteStream,
  override: TuiPresentationEnvironmentInput['viewportOverride'],
): TuiTerminalViewport {
  const overrideColumns = normalizeDimension(override?.columns)
  const overrideRows = normalizeDimension(override?.rows)
  if (override !== undefined) {
    return {
      columns: overrideColumns ?? 80,
      rows: overrideRows,
      revision: 0,
      source: 'override',
    }
  }

  const columns = normalizeDimension(stdout.columns)
  return {
    columns: columns ?? 80,
    rows: normalizeDimension(stdout.rows),
    revision: 0,
    source: columns === undefined ? 'fallback' : 'terminal',
  }
}

function sameViewport(
  left: TuiTerminalViewport,
  right: Pick<TuiTerminalViewport, 'columns' | 'rows' | 'source'>,
): boolean {
  return (
    left.columns === right.columns &&
    left.rows === right.rows &&
    left.source === right.source
  )
}

function publishViewport(
  current: TuiTerminalViewport,
  next: Pick<TuiTerminalViewport, 'columns' | 'rows' | 'source'>,
): TuiTerminalViewport {
  if (sameViewport(current, next)) return current
  return { ...next, revision: current.revision + 1 }
}

function resolveTuiPresentationKind(
  renderer: TuiRendererMode,
  screenReader: boolean,
): TuiPresentationKind {
  if (screenReader) return 'screen-reader'
  return renderer === 'fullscreen' ? 'fullscreen' : 'classic'
}

export function useTuiPresentationEnvironment(
  input: TuiPresentationEnvironmentInput,
): TuiPresentationEnvironment {
  const { stdout } = useStdout()
  const overrideColumns = input.viewportOverride?.columns
  const overrideRows = input.viewportOverride?.rows
  const hasOverride = input.viewportOverride !== undefined
  const [viewport, setViewport] = useState<TuiTerminalViewport>(() =>
    initialViewport(stdout, input.viewportOverride),
  )
  const publishedViewport = useRef<TuiTerminalViewport>(viewport)
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  )
  const pendingViewport = useRef<
    Pick<TuiTerminalViewport, 'columns' | 'rows' | 'source'> | undefined
  >(undefined)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const normalizedOverrideColumns = normalizeDimension(overrideColumns)
    const normalizedOverrideRows = normalizeDimension(overrideRows)

    if (hasOverride) {
      pendingViewport.current = undefined
      setViewport((current) => {
        const next = publishViewport(current, {
          columns: normalizedOverrideColumns ?? 80,
          rows: normalizedOverrideRows,
          source: 'override',
        })
        publishedViewport.current = next
        return next
      })
      return () => {
        mounted.current = false
        if (resizeTimer.current !== undefined) {
          clearTimeout(resizeTimer.current)
          resizeTimer.current = undefined
        }
        pendingViewport.current = undefined
      }
    }

    const resize = () => {
      const columns = normalizeDimension(stdout.columns)
      const rows = normalizeDimension(stdout.rows)
      const lastPublished = publishedViewport.current
      pendingViewport.current = {
        columns: columns ?? lastPublished.columns,
        rows: rows ?? lastPublished.rows,
        source: 'terminal',
      }
      if (resizeTimer.current !== undefined) return
      resizeTimer.current = setTimeout(() => {
        resizeTimer.current = undefined
        const pending = pendingViewport.current
        pendingViewport.current = undefined
        if (!mounted.current || pending === undefined) return
        setViewport((current) => {
          const next = publishViewport(current, pending)
          publishedViewport.current = next
          return next
        })
      }, 33)
    }

    stdout.on('resize', resize)
    return () => {
      mounted.current = false
      stdout.off('resize', resize)
      if (resizeTimer.current !== undefined) {
        clearTimeout(resizeTimer.current)
        resizeTimer.current = undefined
      }
      pendingViewport.current = undefined
    }
  }, [hasOverride, overrideColumns, overrideRows, stdout])

  const screenReader = input.screenReader
  const kind = resolveTuiPresentationKind(input.renderer, screenReader)

  return {
    kind,
    viewport,
    fixedViewport: kind === 'fullscreen' && viewport.rows !== undefined,
    screenReader,
  }
}

export function tuiInkRenderOptions(
  renderer: TuiRendererMode,
  screenReader: boolean,
): TuiInkRenderOptions {
  const kind = resolveTuiPresentationKind(renderer, screenReader)
  if (kind === 'screen-reader') {
    return {
      incrementalRendering: false,
      alternateScreen: false,
      isScreenReaderEnabled: true,
      maxFps: 30,
      concurrent: false,
    }
  }
  if (kind === 'fullscreen') {
    return {
      incrementalRendering: false,
      alternateScreen: true,
      isScreenReaderEnabled: false,
      maxFps: 30,
      concurrent: false,
    }
  }
  return {
    incrementalRendering: true,
    alternateScreen: false,
    isScreenReaderEnabled: false,
    maxFps: 30,
    concurrent: false,
  }
}
