import { useEffect, useMemo, useRef } from 'react'
import { useStdout } from 'ink'

import {
  AnsiFullscreenRenderer,
  type AnsiFrame,
} from './ansi-frame-renderer.js'
import { resolveAnsiTextStyles } from './ansi-theme.js'
import { useTuiTheme } from './theme.js'
import type { QuietFrame } from './quiet-frame.js'

export interface TuiAnsiSurfaceFrameProps {
  readonly frame: QuietFrame
  readonly onError: (error: unknown) => void
}

export type TuiAnsiSurfaceProps = TuiAnsiSurfaceFrameProps

export function projectAnsiQuietFrame(frame: QuietFrame): AnsiFrame {
  return {
    columns: frame.columns,
    rows: frame.rows,
    lines: frame.lines,
    ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
  }
}

export function TuiAnsiSurface(props: TuiAnsiSurfaceProps) {
  const { stdout } = useStdout()
  const theme = useTuiTheme()
  const styles = useMemo(() => resolveAnsiTextStyles(theme), [theme])
  const rendererRef = useRef<AnsiFullscreenRenderer | null>(null)
  const failedRef = useRef(false)
  if (rendererRef.current === null) {
    rendererRef.current = new AnsiFullscreenRenderer({
      writer: { write: (chunk) => stdout.write(chunk) },
      synchronizedOutput:
        typeof (stdout as { writeSynchronized?: unknown }).writeSynchronized ===
        'function',
      styles,
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
    rendererRef.current?.setStyles(styles)
  }, [styles])
  useEffect(() => {
    if (failedRef.current) return
    const renderer = rendererRef.current
    if (renderer === null) return
    try {
      renderer.draw(projectAnsiQuietFrame(props.frame))
    } catch (error) {
      failedRef.current = true
      props.onError(error)
    }
  }, [props])
  return null
}
