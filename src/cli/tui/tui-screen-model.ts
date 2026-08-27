import type { TranscriptItem } from './transcript-presentation.js'
import {
  type TranscriptPresentationEntry,
  type TranscriptPresentationMode,
} from './transcript-presentation.js'
import { FULLSCREEN_TRANSCRIPT_RESERVED_ROWS } from './transcript-viewport.js'
import {
  appendTuiHistory,
  createTuiHistoryChange,
  projectTranscriptWindow,
  type TuiHistoryChange,
} from './transcript-window-model.js'
import type { TuiPresentationEnvironment } from './presentation-environment.js'
import { projectTuiRows, type TuiRow } from './tui-row-ir.js'

export { appendTuiHistory, createTuiHistoryChange }
export type { TuiHistoryChange }

export type TuiRendererMode = 'default' | 'fullscreen'

/**
 * Inputs for the pure TUI view projection. `history` is the live transcript
 * that grows while the session runs; `initialHistory` is the transcript loaded
 * before rendering and decides the resumed/fresh identity. `resume` is true
 * only when the session was opened through a resume option.
 */
export interface TuiViewInput {
  readonly initialHistory: readonly TranscriptItem[]
  readonly history: readonly TranscriptItem[]
  readonly resume: boolean
  readonly fixedViewport: boolean
  readonly screenReader: boolean
  readonly rows: number | undefined
  readonly width: number
  readonly scrollOffset: number
  readonly detailedTranscript: boolean
  readonly historyChange?: TuiHistoryChange
}

export interface TuiViewModel {
  readonly transcriptEntries: readonly TranscriptPresentationEntry[]
  readonly transcriptPageRows: number
  readonly maxTranscriptScrollOffset: number
  readonly resumed: boolean
  readonly freshSession: boolean
  readonly hasConversationHistory: boolean
}

/**
 * Pure, deterministic TUI projection. It classifies the session identity
 * (fresh/resumed/started) and projects the rendered transcript exactly as the
 * fullscreen renderer needs it, preserving TranscriptItem identity and order
 * and the fullscreen suffix/window behavior. It never writes to transcripts or
 * alters runtime events.
 */
const transcriptState = Symbol('transcript-window-state')
const classificationState = Symbol('tui-classification-state')
const selectionState = Symbol('tui-selection-state')
type RetainedTuiViewModel = TuiViewModel & {
  readonly [transcriptState]?: ReturnType<
    typeof projectTranscriptWindow
  >['state']
  readonly [classificationState]?: {
    readonly initialHistory: readonly TranscriptItem[]
    readonly resume: boolean
    readonly history: readonly TranscriptItem[]
    readonly revision: number
    readonly resumed: boolean
    readonly hasConversationHistory: boolean
  }
  readonly [selectionState]?: {
    readonly offset: number
    readonly width: number
    readonly mode: TranscriptPresentationMode
    readonly fixedViewport: boolean
    readonly screenReader: boolean
    readonly pageRows: number
    readonly entries: readonly TranscriptPresentationEntry[]
  }
}

export function projectTuiView(
  input: TuiViewInput,
  previous?: TuiViewModel,
): TuiViewModel {
  // Startup diagnostics are useful before the first prompt, but they are not
  // conversation history and must not suppress the new-session welcome panel.
  // Only real user/assistant transcript entries start a conversation; every
  // other kind (thinking, context, tool, shell, notices, results, and so on)
  // is operational bookkeeping that must not hide the fresh-session welcome.
  const isRealConversation = (item: TranscriptItem) =>
    item.kind === 'user' || item.kind === 'assistant'
  const priorState = (previous as RetainedTuiViewModel | undefined)?.[
    transcriptState
  ]
  const priorClassification = (previous as RetainedTuiViewModel | undefined)?.[
    classificationState
  ]
  // Fullscreen projects only the newest transcript tail that fits the fixed
  // viewport, leaving the composer/status chrome intact and keeping the active
  // stream visible. Classic and screen-reader modes always render the full
  // history exactly as before.
  const mode: TranscriptPresentationMode = input.screenReader
    ? 'screen-reader'
    : input.detailedTranscript
      ? 'audit'
      : 'normal'
  const transcriptPageRows = Math.max(
    2,
    (input.rows ?? 0) - FULLSCREEN_TRANSCRIPT_RESERVED_ROWS,
  )
  const retained = projectTranscriptWindow(
    {
      history: input.history,
      mode,
      width: input.width,
      pageRows: transcriptPageRows,
      scrollOffset: input.scrollOffset,
      revision: input.historyChange?.revision ?? 0,
      bounded: input.fixedViewport && !input.screenReader,
    },
    priorState,
    input.historyChange,
  )
  const classificationCompatible =
    previous !== undefined &&
    priorClassification !== undefined &&
    priorState !== undefined &&
    priorClassification.history === priorState.history &&
    priorClassification.revision === priorState.revision &&
    priorClassification.initialHistory === input.initialHistory &&
    priorClassification.resume === input.resume
  const sameClassification =
    classificationCompatible && retained.transition === 'same'
  const appendedClassification =
    classificationCompatible && retained.transition === 'append'
  // The original loaded transcript decides whether the session was resumed,
  // separately from the live history that grows while the session runs.
  const resumed =
    sameClassification || appendedClassification
      ? priorClassification.resumed
      : input.resume && input.initialHistory.some(isRealConversation)
  const hasConversationHistory = sameClassification
    ? priorClassification.hasConversationHistory
    : appendedClassification
      ? priorClassification.hasConversationHistory ||
        input.history.slice(priorState.history.length).some(isRealConversation)
      : input.history.some(isRealConversation)
  // A session is resumed only when it was opened through `resume` and the
  // original transcript already contained real conversation content. Supplying
  // a session ID alone with an empty transcript keeps the session fresh, so the
  // full welcome panel renders and the compact identity stays hidden until real
  // conversation content appears.
  const freshSession = !resumed && !hasConversationHistory
  const fullEntries = retained.allEntries
  const maxTranscriptScrollOffset = retained.maxOffset
  const projectedEntries =
    input.fixedViewport && !input.screenReader ? retained.entries : fullEntries
  const priorSelection = (previous as RetainedTuiViewModel | undefined)?.[
    selectionState
  ]
  const transcriptEntries =
    priorSelection &&
    priorSelection.offset === input.scrollOffset &&
    priorSelection.width === input.width &&
    priorSelection.mode === mode &&
    priorSelection.fixedViewport === input.fixedViewport &&
    priorSelection.screenReader === input.screenReader &&
    priorSelection.pageRows === transcriptPageRows &&
    priorState === retained.state
      ? priorSelection.entries
      : projectedEntries
  const result: RetainedTuiViewModel = {
    transcriptEntries,
    transcriptPageRows,
    maxTranscriptScrollOffset,
    resumed,
    freshSession,
    hasConversationHistory,
  }
  Object.defineProperty(result, transcriptState, {
    value: retained.state,
    enumerable: false,
  })
  Object.defineProperty(result, classificationState, {
    value: {
      initialHistory: input.initialHistory,
      resume: input.resume,
      history: input.history,
      revision: retained.state.revision,
      resumed,
      hasConversationHistory,
    },
    enumerable: false,
  })
  Object.defineProperty(result, selectionState, {
    value: {
      offset: input.scrollOffset,
      width: input.width,
      mode,
      fixedViewport: input.fixedViewport,
      screenReader: input.screenReader,
      pageRows: transcriptPageRows,
      entries: transcriptEntries,
    },
    enumerable: false,
  })
  return result
}

export interface TuiScreenSurfaceModels {
  readonly sessionPicker: unknown
  readonly priority: unknown
  readonly secondary: unknown
  readonly overlay: unknown
}

export interface TuiScreenInput<
  Surfaces extends TuiScreenSurfaceModels = TuiScreenSurfaceModels,
> {
  readonly presentation: TuiPresentationEnvironment
  readonly conversation: {
    readonly initialHistory: readonly TranscriptItem[]
    readonly history: readonly TranscriptItem[]
    readonly historyChange?: TuiHistoryChange
    readonly resumeRequested: boolean
    readonly scrollOffset: number
    readonly detailed: boolean
    readonly activeText: string
    readonly activeThinking: string
  }
  readonly sessionId: string | null
  readonly surfaces: {
    readonly sessionPicker?: Surfaces['sessionPicker']
    readonly priority?: Surfaces['priority']
    readonly secondary?: Surfaces['secondary']
    readonly overlays: readonly Surfaces['overlay'][]
  }
}

export interface TuiTranscriptScreenModel {
  readonly entries: readonly TranscriptPresentationEntry[]
  readonly rows: readonly TuiRow[]
  readonly pageRows: number
  readonly maxScrollOffset: number
  readonly scrollOffset: number
  readonly readingMode: 'normal' | 'audit' | 'screen-reader'
  readonly active: {
    readonly text: string
    readonly thinking: string
    readonly visible: boolean
  }
}

export type TuiScreenForeground<Surfaces extends TuiScreenSurfaceModels> =
  | { readonly kind: 'priority'; readonly surface: Surfaces['priority'] }
  | { readonly kind: 'secondary'; readonly surface: Surfaces['secondary'] }
  | {
      readonly kind: 'compose'
      readonly overlays: readonly Surfaces['overlay'][]
    }

export type TuiScreenBody<Surfaces extends TuiScreenSurfaceModels> =
  | {
      readonly kind: 'session-picker'
      readonly surface: Surfaces['sessionPicker']
    }
  | {
      readonly kind: 'conversation'
      readonly intro: 'welcome' | 'identity' | 'none'
      readonly sessionLabel?: string
      readonly resumed: boolean
      readonly freshSession: boolean
      readonly hasConversationHistory: boolean
      readonly transcript: TuiTranscriptScreenModel
      readonly foreground: TuiScreenForeground<Surfaces>
    }

export interface TuiScreenModel<
  Surfaces extends TuiScreenSurfaceModels = TuiScreenSurfaceModels,
> {
  readonly presentation: TuiPresentationEnvironment
  readonly body: TuiScreenBody<Surfaces>
}

const screenViewState = Symbol('tui-screen-view-state')
type RetainedScreenModel = TuiScreenModel & {
  readonly [screenViewState]?: TuiViewModel
}

export function projectTuiScreen<Surfaces extends TuiScreenSurfaceModels>(
  input: TuiScreenInput<Surfaces>,
  previous?: TuiScreenModel<Surfaces>,
): TuiScreenModel<Surfaces> {
  const conversation = input.conversation
  const priorView = (previous as RetainedScreenModel | undefined)?.[
    screenViewState
  ]
  const view = projectTuiView(
    {
      initialHistory: conversation.initialHistory,
      history: conversation.history,
      resume: conversation.resumeRequested,
      fixedViewport: input.presentation.fixedViewport,
      screenReader: input.presentation.screenReader,
      rows: input.presentation.viewport.rows,
      width: input.presentation.viewport.columns,
      scrollOffset: conversation.scrollOffset,
      detailedTranscript: conversation.detailed,
      ...(conversation.historyChange === undefined
        ? {}
        : { historyChange: conversation.historyChange }),
    },
    priorView,
  )
  const readingMode = input.presentation.screenReader
    ? 'screen-reader'
    : conversation.detailed
      ? 'audit'
      : 'normal'
  const scrollOffset = Math.min(
    Math.max(0, conversation.scrollOffset),
    view.maxTranscriptScrollOffset,
  )
  const transcript: TuiTranscriptScreenModel = {
    entries: view.transcriptEntries,
    rows: projectTuiRows({
      entries: view.transcriptEntries,
      width: input.presentation.viewport.columns,
      mode: readingMode,
    }),
    pageRows: view.transcriptPageRows,
    maxScrollOffset: view.maxTranscriptScrollOffset,
    scrollOffset,
    readingMode,
    active: {
      text: conversation.activeText,
      thinking: conversation.activeThinking,
      visible: scrollOffset === 0,
    },
  }
  let body: TuiScreenBody<Surfaces>
  if (input.surfaces.sessionPicker !== undefined) {
    body = { kind: 'session-picker', surface: input.surfaces.sessionPicker }
  } else {
    const intro = input.presentation.screenReader
      ? 'none'
      : view.freshSession
        ? 'welcome'
        : !view.resumed && view.hasConversationHistory
          ? 'identity'
          : 'none'
    const foreground: TuiScreenForeground<Surfaces> =
      input.surfaces.priority !== undefined
        ? { kind: 'priority', surface: input.surfaces.priority }
        : input.surfaces.secondary !== undefined
          ? { kind: 'secondary', surface: input.surfaces.secondary }
          : { kind: 'compose', overlays: input.surfaces.overlays }
    body = {
      kind: 'conversation',
      intro,
      ...(input.sessionId === null
        ? {}
        : { sessionLabel: input.sessionId.slice(0, 8) }),
      resumed: view.resumed,
      freshSession: view.freshSession,
      hasConversationHistory: view.hasConversationHistory,
      transcript,
      foreground,
    }
  }
  const result = {
    presentation: input.presentation,
    body,
  } as RetainedScreenModel
  Object.defineProperty(result, screenViewState, {
    value: view,
    enumerable: false,
  })
  return result as TuiScreenModel<Surfaces>
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
