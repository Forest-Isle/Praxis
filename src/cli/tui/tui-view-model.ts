import type { TranscriptItem } from './claude-style.js'
import {
  FULLSCREEN_TRANSCRIPT_RESERVED_ROWS,
  projectTranscriptTail,
  projectTranscriptWindow,
} from './transcript-viewport.js'

export type TuiRendererMode = 'default' | 'fullscreen'

/**
 * Inputs for the pure TUI view projection. `history` is the live transcript
 * that grows while the session runs; `initialHistory` is the transcript loaded
 * before rendering and decides the resumed/fresh identity. `resume` is true
 * only when the session was opened through a resume option.
 */
export interface TuiViewInput {
  initialHistory: readonly TranscriptItem[]
  history: readonly TranscriptItem[]
  resume: boolean
  fixedViewport: boolean
  screenReader: boolean
  rows: number | undefined
  width: number
  scrollOffset: number
}

export interface TuiViewModel {
  projectedHistory: readonly TranscriptItem[]
  resumed: boolean
  freshSession: boolean
  hasConversationHistory: boolean
}

/**
 * Pure, deterministic TUI projection. It classifies the session identity
 * (fresh/resumed/started) and projects the rendered transcript exactly as the
 * fullscreen renderer needs it, preserving TranscriptItem identity and order
 * and the fullscreen suffix/window behavior. It never writes to transcripts or
 * alters runtime events.
 */
export function projectTuiView(input: TuiViewInput): TuiViewModel {
  // Startup diagnostics are useful before the first prompt, but they are not
  // conversation history and must not suppress the new-session welcome panel.
  // Only real user/assistant transcript entries start a conversation; every
  // other kind (thinking, context, tool, shell, notices, results, and so on)
  // is operational bookkeeping that must not hide the fresh-session welcome.
  const isRealConversation = (item: TranscriptItem) =>
    item.kind === 'user' || item.kind === 'assistant'
  // The original loaded transcript decides whether the session was resumed,
  // separately from the live history that grows while the session runs.
  const resumed = input.resume && input.initialHistory.some(isRealConversation)
  const hasConversationHistory = input.history.some(isRealConversation)
  // A session is resumed only when it was opened through `resume` and the
  // original transcript already contained real conversation content. Supplying
  // a session ID alone with an empty transcript keeps the session fresh, so the
  // full welcome panel renders and the compact identity stays hidden until real
  // conversation content appears.
  const freshSession = !resumed && !hasConversationHistory
  // Fullscreen projects only the newest transcript tail that fits the fixed
  // viewport, leaving the composer/status chrome intact and keeping the active
  // stream visible. Classic and screen-reader modes always render the full
  // history exactly as before.
  const projectedHistory =
    input.fixedViewport && !input.screenReader
      ? input.scrollOffset > 0
        ? projectTranscriptWindow(
            input.history,
            Math.max(
              1,
              (input.rows ?? 0) - FULLSCREEN_TRANSCRIPT_RESERVED_ROWS,
            ),
            input.width,
            input.scrollOffset,
          )
        : projectTranscriptTail(
            input.history,
            Math.max(
              1,
              (input.rows ?? 0) - FULLSCREEN_TRANSCRIPT_RESERVED_ROWS,
            ),
            input.width,
          )
      : input.history
  return { projectedHistory, resumed, freshSession, hasConversationHistory }
}

export interface TuiRendererInput {
  configured: TuiRendererMode
  explicitlyConfigured: boolean
  interactiveTty: boolean
  screenReader: boolean
}

/**
 * Resolves the renderer for an interactive session. Fullscreen is the default
 * for interactive TTY execution; classic remains the fallback for screen-reader
 * and non-interactive paths, and an explicit renderer configuration is always
 * honored over the default.
 */
export function resolveTuiRenderer(input: TuiRendererInput): TuiRendererMode {
  if (input.screenReader) return 'default'
  if (!input.interactiveTty) return 'default'
  if (input.explicitlyConfigured) return input.configured
  return 'fullscreen'
}
