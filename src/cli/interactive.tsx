import { useEffect, useMemo, useRef, useState } from 'react'

import { Box, Text, render, useApp, useInput } from 'ink'

import type {
  ForkResult,
  SessionRunResult,
  SessionSummary,
} from '../application/session-service.js'
import type {
  ModelToolCall,
  ModelUsage,
  RuntimeEvent,
  RuntimeEventSink,
} from '../core/runtime.js'
import type {
  CliElicitationRequest,
  CliElicitationResult,
  CliRuntimeInfo,
} from './protocol.js'
import type {
  ClaudeInteractiveToolCallbacks,
  ClaudePlanApprovalRequest,
  ClaudeQuestion,
  ClaudeQuestionResult,
} from '../tools/claude-interactive-tools.js'
import type { ClaudePermissionMode } from '../permissions/claude-permission-resolver.js'
import {
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import {
  CommandPalette,
  Composer,
  DiffDashboard,
  DialogFrame,
  FilePicker,
  HelpMenu,
  ListDashboard,
  PermissionDashboard,
  SelectionMenu,
  SessionPicker,
  StatusDashboard,
  Transcript,
  WelcomePanel,
  useTerminalWidth,
  type TranscriptItem,
  type TuiDisplayMetadata,
} from './tui/claude-style.js'
import {
  loadGitDiff,
  visiblePatchLines,
  type TuiDiffSnapshot,
} from './tui/git-diff.js'
import {
  addTuiPermissionRule,
  loadTuiPermissionRules,
  type TuiPermissionBehavior,
  type TuiPermissionRule,
} from './tui/permission-settings.js'
import type { ClaudeResourceScope } from '../compatibility/claude/shared-resources.js'
import {
  filterTuiSlashCommands,
  mergeTuiSlashCommands,
  slashCommandQuery,
  type TuiSlashCommand,
} from './tui/slash-commands.js'
import {
  createComposerEditor,
  deleteComposerBackward,
  deleteComposerForward,
  deleteComposerToEnd,
  deleteComposerToStart,
  deleteComposerWordBackward,
  insertComposerText,
  moveComposerCursor,
  moveComposerCursorByWord,
} from './tui/composer-editor.js'
import {
  applyFileReference,
  fileReferenceAtCursor,
  filterTuiFileEntries,
  loadTuiFileEntries,
  type TuiFileEntry,
} from './tui/file-picker.js'

interface InteractiveSessionCommands {
  run(prompt: string, signal?: AbortSignal): Promise<SessionRunResult>
  resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult>
  fork(sessionId: string, targetSessionId?: string): Promise<ForkResult>
  sessions(): Promise<SessionSummary[]>
  workflows?(): readonly Record<string, unknown>[]
  slashCommands?(): readonly TuiSlashCommand[]
  runtimeInfo?(): CliRuntimeInfo
  setPermissionMode?(
    sessionId: string,
    mode: ClaudePermissionMode,
  ): Promise<void>
  nextScheduledPrompt?(
    signal?: AbortSignal,
  ): Promise<{ id: string; prompt: string } | null>
  close?(): Promise<void>
}

export interface InteractiveServiceFactory {
  scheduledPrompts?: boolean
  createService(options: {
    eventSink: RuntimeEventSink
    requireProvider: boolean
    approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
    approveTool?: (call: ModelToolCall) => boolean | Promise<boolean>
    onElicitation?: (
      request: CliElicitationRequest,
    ) => Promise<CliElicitationResult>
    askUser?: ClaudeInteractiveToolCallbacks['askUser']
    approvePlan?: ClaudeInteractiveToolCallbacks['approvePlan']
    agent?: string
    model?: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    permissionMode?: ClaudePermissionMode
    signal?: AbortSignal
  }): Promise<InteractiveSessionCommands>
}

export interface InteractiveResumeOptions {
  sessionId?: string
  sessionSelector?: string
  requireSession?: boolean
  forkSession?: boolean
  forkSessionId?: string
  retryInterruptedTools?: boolean
}

interface InteractiveAppProps {
  factory: InteractiveServiceFactory
  initialSessions: readonly SessionSummary[]
  initialPrompt?: string
  signal?: AbortSignal
  onCancel?: () => void
  onTurnChange?: (turn: Promise<void> | null) => void
  onCleanup?: (closing: Promise<void>) => void
  axScreenReader?: boolean
  allowNewSession?: boolean
  resume?: InteractiveResumeOptions
  display?: TuiDisplayMetadata
  terminalWidth?: number
  slashCommands?: readonly TuiSlashCommand[]
  allowDangerouslySkipPermissions?: boolean
  diffLoader?: () => Promise<TuiDiffSnapshot>
  fileLoader?: () => Promise<readonly TuiFileEntry[]>
  permissionRuleStore?: {
    load(): Promise<readonly TuiPermissionRule[]>
    add(input: {
      behavior: TuiPermissionBehavior
      rule: string
      scope: ClaudeResourceScope
    }): Promise<void>
  }
}

type PendingPermission = {
  kind: 'tool' | 'recovery'
  call: ModelToolCall
  resolve: (approved: boolean) => void
}

type PendingElicitation = {
  request: CliElicitationRequest
  resolve: (result: CliElicitationResult) => void
}

type PendingQuestion = {
  questions: readonly ClaudeQuestion[]
  index: number
  answers: Readonly<Record<string, string>>
  resolve: (result: ClaudeQuestionResult | null) => void
}

type PendingPlanApproval = {
  request: ClaudePlanApprovalRequest
  resolve: (approved: boolean) => void
}

const EMPTY_SLASH_COMMANDS: readonly TuiSlashCommand[] = []

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const PERMISSION_OPTIONS: readonly {
  mode: ClaudePermissionMode
  label: string
  description: string
}[] = [
  {
    mode: 'default',
    label: 'Default',
    description: 'Ask before changes that need approval.',
  },
  {
    mode: 'acceptEdits',
    label: 'Accept edits',
    description: 'Allow file edits while keeping command approval.',
  },
  {
    mode: 'auto',
    label: 'Auto',
    description: 'Classify safe tool calls before asking.',
  },
  {
    mode: 'manual',
    label: 'Manual',
    description: 'Ask for every tool call that is not explicitly allowed.',
  },
  {
    mode: 'dontAsk',
    label: "Don't ask",
    description: 'Deny tool calls that require confirmation.',
  },
  {
    mode: 'plan',
    label: 'Plan mode',
    description: 'Restrict changes to the plan file until approval.',
  },
]

type InteractiveMenu =
  | { kind: 'help'; tabIndex: number; selectedIndex: number }
  | {
      kind: 'diff'
      snapshots: readonly { label: string; snapshot: TuiDiffSnapshot }[]
      sourceIndex: number
      selectedIndex: number
      viewingFile: boolean
      scrollOffset: number
    }
  | {
      kind: 'permission-dashboard'
      tabIndex: number
      selectedIndex: number
      query: string
      rules: readonly TuiPermissionRule[]
    }
  | { kind: 'permission-rule-input'; behavior: TuiPermissionBehavior }
  | {
      kind: 'permission-scope'
      behavior: TuiPermissionBehavior
      rule: string
      selectedIndex: number
    }
  | { kind: 'model'; selectedIndex: number }
  | { kind: 'model-input' }
  | { kind: 'effort'; selectedIndex: number }
  | { kind: 'status'; tabIndex: number }
  | {
      kind: 'list'
      title: string
      rows: readonly { label: string; description?: string }[]
      emptyText: string
      selectedIndex: number
    }

type RuntimePreferences = {
  model?: string
  effort: (typeof EFFORT_OPTIONS)[number]
  permissionMode: ClaudePermissionMode
}

function permissionMode(value: string | undefined): ClaudePermissionMode {
  return [
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'manual',
    'dontAsk',
    'plan',
  ].includes(value ?? '')
    ? (value as ClaudePermissionMode)
    : 'default'
}

function effort(value: string | undefined): RuntimePreferences['effort'] {
  return EFFORT_OPTIONS.includes(value as RuntimePreferences['effort'])
    ? (value as RuntimePreferences['effort'])
    : 'high'
}

function questionAnswer(question: ClaudeQuestion, input: string): string {
  const answer = input.trim()
  if (!answer) throw new Error('Enter an option number or text.')
  if (!question.multiSelect) {
    if (!/^\d+$/u.test(answer)) return answer
    const option = question.options[Number(answer) - 1]
    if (!option) throw new Error(`Unknown option ${answer}.`)
    return option.label
  }
  const values = input
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return values
    .map((value) => {
      if (!/^\d+$/u.test(value)) return value
      const option = question.options[Number(value) - 1]
      if (!option) throw new Error(`Unknown option ${value}.`)
      return option.label
    })
    .join(', ')
}

function describeTool(
  call: ModelToolCall,
  sensitiveValues: readonly string[],
): string {
  const name = redactSensitiveText(call.name, sensitiveValues)
  return `${name} ${describeToolInput(call, sensitiveValues)}`
}

function redactToolCall(
  call: ModelToolCall,
  sensitiveValues: readonly string[],
): ModelToolCall {
  return {
    ...call,
    name: redactSensitiveText(call.name, sensitiveValues),
    input: JSON.parse(
      redactSensitiveText(JSON.stringify(call.input), sensitiveValues),
    ) as Record<string, unknown>,
  }
}

function describeToolInput(
  call: ModelToolCall,
  sensitiveValues: readonly string[],
): string {
  const detail = redactSensitiveText(
    JSON.stringify(call.input),
    sensitiveValues,
  )
  return detail.length > 160 ? `${detail.slice(0, 157)}...` : detail
}

function filterSessionChoices(
  sessions: readonly (SessionSummary | null)[],
  search: string,
): readonly (SessionSummary | null)[] {
  const query = search.trim().toLowerCase()
  if (!query) return sessions
  return sessions.filter((session) => {
    if (!session) return false
    return [session.sessionId, session.name, session.lastPrompt].some((value) =>
      value?.toLowerCase().includes(query),
    )
  })
}

function estimatedCommandTokens(command: TuiSlashCommand): number {
  return Math.max(
    1,
    Math.ceil(`/${command.name} ${command.description}`.length / 4),
  )
}

function workflowRows(
  workflows: readonly Record<string, unknown>[],
): readonly { label: string; description?: string }[] {
  return workflows.map((workflow) => ({
    label:
      `${String(workflow.task_id ?? workflow.id ?? 'task')} [${String(workflow.status ?? 'unknown')}] ${String(workflow.summary ?? workflow.description ?? '')}`.trim(),
  }))
}

export function InteractiveApp({
  factory,
  initialSessions,
  initialPrompt,
  signal,
  onCancel,
  onTurnChange,
  onCleanup,
  axScreenReader = false,
  allowNewSession = true,
  resume,
  display = { version: 'dev', cwd: process.cwd() },
  terminalWidth,
  slashCommands = EMPTY_SLASH_COMMANDS,
  allowDangerouslySkipPermissions = false,
  diffLoader,
  fileLoader,
  permissionRuleStore,
}: InteractiveAppProps) {
  const { exit } = useApp()
  const width = useTerminalWidth(terminalWidth)
  const sensitiveValues = useMemo(
    () => sensitiveEnvironmentValues(process.env),
    [],
  )
  const loadDiffSnapshot = useMemo(
    () => diffLoader ?? (() => loadGitDiff(display.cwd)),
    [diffLoader, display.cwd],
  )
  const loadFiles = useMemo(
    () => fileLoader ?? (() => loadTuiFileEntries(display.cwd)),
    [fileLoader, display.cwd],
  )
  const permissionStore = useMemo(
    () =>
      permissionRuleStore ?? {
        load: () => loadTuiPermissionRules(display.cwd),
        add: (input: {
          behavior: TuiPermissionBehavior
          rule: string
          scope: ClaudeResourceScope
        }) => addTuiPermissionRule({ cwd: display.cwd, ...input }),
      },
    [permissionRuleStore, display.cwd],
  )
  const choices = useMemo(
    () =>
      allowNewSession ? ([null, ...initialSessions] as const) : initialSessions,
    [allowNewSession, initialSessions],
  )
  const [pickerIncludesNewSession, setPickerIncludesNewSession] =
    useState(allowNewSession)
  const pickerIncludesNewSessionRef = useRef(allowNewSession)
  const pickerChoices = pickerIncludesNewSession ? choices : initialSessions
  const [sessionSearch, setSessionSearch] = useState('')
  const sessionSearchRef = useRef('')
  const filteredPickerChoices = useMemo(
    () => filterSessionChoices(pickerChoices, sessionSearch),
    [pickerChoices, sessionSearch],
  )
  const [selectingSession, setSelectingSession] = useState(
    initialSessions.length > 0 &&
      resume?.sessionId === undefined &&
      (!allowNewSession || resume?.requireSession === true),
  )
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0)
  const [sessionId, setSessionId] = useState<string | null>(
    resume?.sessionId ?? null,
  )
  const [pendingFork, setPendingFork] = useState(resume?.forkSession === true)
  const [input, setInput] = useState('')
  const inputRef = useRef('')
  const [inputCursor, setInputCursor] = useState(0)
  const inputCursorRef = useRef(0)
  const inputHistoryRef = useRef<string[]>([])
  const inputHistoryIndexRef = useRef<number | null>(null)
  const inputHistoryDraftRef = useRef('')
  const undoStackRef = useRef<Array<ReturnType<typeof createComposerEditor>>>(
    [],
  )
  const stashedInputRef = useRef('')
  const lastEscapeAtRef = useRef(0)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandSelection, setCommandSelection] = useState(0)
  const [filePickerOpen, setFilePickerOpen] = useState(false)
  const [fileSelection, setFileSelection] = useState(0)
  const [fileEntries, setFileEntries] = useState<
    readonly TuiFileEntry[] | null
  >(null)
  const [shortcutsVisible, setShortcutsVisible] = useState(false)
  const [availableSlashCommands, setAvailableSlashCommands] =
    useState(slashCommands)
  const [menu, setMenu] = useState<InteractiveMenu | null>(null)
  const menuRef = useRef<InteractiveMenu | null>(null)
  const [busy, setBusy] = useState(false)
  const initialPromptRef = useRef(initialPrompt?.trim() ?? '')
  const [initialPromptPending, setInitialPromptPending] = useState(
    initialPromptRef.current.length > 0,
  )
  const [status, setStatus] = useState('ready')
  const [activeText, setActiveText] = useState('')
  const [activeThinking, setActiveThinking] = useState('')
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [usage, setUsage] = useState<ModelUsage | undefined>()
  const [costUsd, setCostUsd] = useState<number | undefined>()
  const [contextWindowTokens, setContextWindowTokens] = useState(
    display.contextWindowTokens,
  )
  const [history, setHistory] = useState<TranscriptItem[]>([])
  const [turnDiffs, setTurnDiffs] = useState<
    readonly { label: string; snapshot: TuiDiffSnapshot }[]
  >([])
  const turnNumberRef = useRef(0)
  const turnMutatedFilesRef = useRef(false)
  const permissionCallsRef = useRef(new Map<string, string>())
  const [recentDenied, setRecentDenied] = useState<readonly string[]>([])
  const [exitConfirmation, setExitConfirmation] = useState(false)
  const exitConfirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const [runtimePreferences, setRuntimePreferences] =
    useState<RuntimePreferences>(() => ({
      effort: effort(display.effort),
      permissionMode: permissionMode(display.permissionMode),
    }))
  const runtimePreferencesRef = useRef(runtimePreferences)
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const permissionRef = useRef<PendingPermission | null>(null)
  const [elicitation, setElicitation] = useState<PendingElicitation | null>(
    null,
  )
  const elicitationRef = useRef<PendingElicitation | null>(null)
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  const questionRef = useRef<PendingQuestion | null>(null)
  const [planApproval, setPlanApproval] = useState<PendingPlanApproval | null>(
    null,
  )
  const planApprovalRef = useRef<PendingPlanApproval | null>(null)
  const serviceRef = useRef<InteractiveSessionCommands | null>(null)
  const serviceCreationRef = useRef<
    Promise<InteractiveSessionCommands> | undefined
  >(undefined)
  const onCleanupRef = useRef(onCleanup)
  onCleanupRef.current = onCleanup
  const scheduledWaitRef = useRef<AbortController | null>(null)
  const turnControllerRef = useRef<AbortController | null>(null)
  const serviceRetirementRef = useRef<Promise<void> | null>(null)
  const serviceEpochRef = useRef(0)
  const serviceCreationEpochRef = useRef<number | null>(null)
  const allSlashCommands = useMemo(
    () => mergeTuiSlashCommands(availableSlashCommands),
    [availableSlashCommands],
  )
  const builtinSlashCommands = useMemo(
    () => allSlashCommands.filter((command) => command.source === 'builtin'),
    [allSlashCommands],
  )
  const customSlashCommands = useMemo(
    () => allSlashCommands.filter((command) => command.source !== 'builtin'),
    [allSlashCommands],
  )
  const commandQuery = commandPaletteOpen ? slashCommandQuery(input) : null
  const fileReference = filePickerOpen
    ? fileReferenceAtCursor(input, inputCursor)
    : null
  const matchingSlashCommands = useMemo(
    () =>
      commandQuery === null
        ? []
        : filterTuiSlashCommands(allSlashCommands, commandQuery),
    [allSlashCommands, commandQuery],
  )
  const commandPaletteVisible =
    !busy &&
    !permission &&
    !planApproval &&
    !question &&
    !elicitation &&
    !selectingSession &&
    commandQuery !== null
  const matchingFileEntries = useMemo(
    () =>
      fileEntries === null || fileReference === null
        ? []
        : filterTuiFileEntries(fileEntries, fileReference.query),
    [fileEntries, fileReference?.query],
  )
  const filePickerVisible =
    !busy &&
    !permission &&
    !planApproval &&
    !question &&
    !elicitation &&
    !selectingSession &&
    filePickerOpen &&
    fileReference !== null
  const selectedFileIndex = Math.min(
    fileSelection,
    Math.max(0, matchingFileEntries.length - 1),
  )
  const hasThinking =
    activeThinking.length > 0 ||
    history.some((item) => item.kind === 'thinking')
  const hasDetailedTranscript =
    hasThinking || history.some((item) => item.kind === 'tool')
  const selectedSlashCommandIndex = Math.min(
    commandSelection,
    Math.max(0, matchingSlashCommands.length - 1),
  )
  const runtimeDisplay: TuiDisplayMetadata = {
    ...display,
    ...(runtimePreferences.model === undefined
      ? {}
      : { model: runtimePreferences.model }),
    effort: runtimePreferences.effort,
    permissionMode: runtimePreferences.permissionMode,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  }
  const permissionOptions = useMemo(
    () => [
      ...PERMISSION_OPTIONS,
      ...(allowDangerouslySkipPermissions
        ? [
            {
              mode: 'bypassPermissions' as const,
              label: 'Bypass permissions',
              description:
                'Allow tool calls except explicit deny rules for this session.',
            },
          ]
        : []),
    ],
    [allowDangerouslySkipPermissions],
  )
  const modelOptions = useMemo(
    () => [
      {
        label: runtimeDisplay.model
          ? `Current: ${runtimeDisplay.model}`
          : 'Current: provider default',
        description: 'Keep the model selected for this interactive session.',
        selected: true,
      },
      {
        label: 'Use invocation default',
        description: 'Use the model supplied by the original CLI invocation.',
      },
      {
        label: 'Enter a model ID…',
        description:
          'Use any model identifier supported by the configured provider.',
      },
    ],
    [runtimeDisplay.model],
  )

  useEffect(() => {
    setAvailableSlashCommands(slashCommands)
  }, [slashCommands])

  useEffect(() => {
    if (!commandPaletteOpen) return
    const currentCommands = serviceRef.current?.slashCommands?.()
    if (currentCommands) setAvailableSlashCommands(currentCommands)
  }, [commandPaletteOpen])

  useEffect(() => {
    setFileEntries(null)
  }, [loadFiles])

  useEffect(() => {
    if (!filePickerVisible || fileEntries !== null) return
    let cancelled = false
    void loadFiles().then(
      (entries) => {
        if (!cancelled) setFileEntries(entries)
      },
      () => {
        if (!cancelled) setFileEntries([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [fileEntries, filePickerVisible, loadFiles])

  useEffect(() => {
    if (!signal) return
    const cancel = () => {
      permissionRef.current?.resolve(false)
      elicitationRef.current?.resolve({ action: 'cancel' })
      questionRef.current?.resolve(null)
      planApprovalRef.current?.resolve(false)
      exit()
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  }, [exit, signal])

  useEffect(
    () => () => {
      permissionRef.current?.resolve(false)
      elicitationRef.current?.resolve({ action: 'cancel' })
      questionRef.current?.resolve(null)
      planApprovalRef.current?.resolve(false)
      if (exitConfirmationTimerRef.current)
        clearTimeout(exitConfirmationTimerRef.current)
      scheduledWaitRef.current?.abort()
      turnControllerRef.current?.abort()
      const closing = serviceRef.current?.close?.() ?? Promise.resolve()
      if (onCleanupRef.current) onCleanupRef.current(closing)
      else void closing.catch(() => undefined)
    },
    [],
  )

  const append = (line: TranscriptItem) =>
    setHistory((current) => [...current, line])

  const updateComposerInput = (next: string, cursor?: number) => {
    const editor = createComposerEditor(next, cursor)
    inputRef.current = editor.text
    inputCursorRef.current = editor.cursor
    setInput(editor.text)
    setInputCursor(editor.cursor)
    setShortcutsVisible(false)
    setCommandPaletteOpen(slashCommandQuery(editor.text) !== null)
    setCommandSelection(0)
    setFilePickerOpen(
      fileReferenceAtCursor(editor.text, editor.cursor) !== null,
    )
    setFileSelection(0)
  }

  const updateComposerEditor = (
    editor: ReturnType<typeof createComposerEditor>,
    recordUndo = true,
  ) => {
    if (recordUndo && editor.text !== inputRef.current) {
      undoStackRef.current = [
        ...undoStackRef.current,
        createComposerEditor(inputRef.current, inputCursorRef.current),
      ].slice(-100)
    }
    updateComposerInput(editor.text, editor.cursor)
  }

  const clearComposerInput = () => updateComposerInput('')

  const updateMenu = (next: InteractiveMenu | null) => {
    menuRef.current = next
    setMenu(next)
  }

  const appendPromptHistory = (prompt: string) => {
    if (!prompt) return
    const history = inputHistoryRef.current.filter((item) => item !== prompt)
    inputHistoryRef.current = [prompt, ...history].slice(0, 100)
    inputHistoryIndexRef.current = null
    inputHistoryDraftRef.current = ''
  }

  const restorePromptHistory = (direction: 'previous' | 'next') => {
    const history = inputHistoryRef.current
    if (history.length === 0) return
    const currentIndex = inputHistoryIndexRef.current
    if (direction === 'previous') {
      if (currentIndex === null) inputHistoryDraftRef.current = inputRef.current
      const nextIndex = Math.min(history.length - 1, (currentIndex ?? -1) + 1)
      inputHistoryIndexRef.current = nextIndex
      updateComposerInput(history[nextIndex] ?? '')
      return
    }
    if (currentIndex === null) return
    const nextIndex = currentIndex - 1
    if (nextIndex < 0) {
      inputHistoryIndexRef.current = null
      updateComposerInput(inputHistoryDraftRef.current)
      return
    }
    inputHistoryIndexRef.current = nextIndex
    updateComposerInput(history[nextIndex] ?? '')
  }

  const dismissExitConfirmation = () => {
    if (!exitConfirmation) return
    if (exitConfirmationTimerRef.current)
      clearTimeout(exitConfirmationTimerRef.current)
    exitConfirmationTimerRef.current = null
    setExitConfirmation(false)
  }

  const armExitConfirmation = () => {
    if (exitConfirmation) {
      permissionRef.current?.resolve(false)
      elicitationRef.current?.resolve({ action: 'cancel' })
      questionRef.current?.resolve(null)
      planApprovalRef.current?.resolve(false)
      onCancel?.()
      exit()
      return
    }
    clearComposerInput()
    setExitConfirmation(true)
    if (exitConfirmationTimerRef.current)
      clearTimeout(exitConfirmationTimerRef.current)
    exitConfirmationTimerRef.current = setTimeout(() => {
      exitConfirmationTimerRef.current = null
      setExitConfirmation(false)
    }, 1_500)
  }

  useEffect(() => {
    setCommandSelection((current) =>
      Math.min(current, Math.max(0, matchingSlashCommands.length - 1)),
    )
  }, [matchingSlashCommands.length])

  useEffect(() => {
    setFileSelection((current) =>
      Math.min(current, Math.max(0, matchingFileEntries.length - 1)),
    )
  }, [matchingFileEntries.length])

  const handleEvent = (event: RuntimeEvent) => {
    switch (event.type) {
      case 'text-delta':
        setActiveText((current) => current + event.delta)
        break
      case 'thinking-start':
        setActiveThinking(
          event.block.type === 'thinking'
            ? redactSensitiveText(event.block.thinking, sensitiveValues)
            : '',
        )
        break
      case 'thinking-delta':
        setActiveThinking(
          (current) =>
            current + redactSensitiveText(event.delta, sensitiveValues),
        )
        break
      case 'thinking-signature-delta':
        // Signatures authenticate a thinking block for provider replay; they are
        // intentionally not part of the user-visible reasoning summary.
        break
      case 'thinking-stop':
        append({
          kind: 'thinking',
          text:
            event.block.type === 'thinking'
              ? redactSensitiveText(event.block.thinking, sensitiveValues)
              : activeThinking,
        })
        setActiveThinking('')
        break
      case 'user-message':
        append({ kind: 'assistant', text: event.message })
        break
      case 'state':
        setStatus(event.state)
        break
      case 'usage':
        setUsage(event.usage)
        break
      case 'tool-call':
        if (['Edit', 'Write', 'NotebookEdit'].includes(event.call.name))
          turnMutatedFilesRef.current = true
        permissionCallsRef.current.set(
          event.call.id,
          describeTool(event.call, sensitiveValues),
        )
        append({
          kind: 'tool',
          call: redactToolCall(event.call, sensitiveValues),
          detail: describeToolInput(event.call, sensitiveValues),
        })
        break
      case 'permission-decision':
        if (event.behavior === 'deny') {
          const denied =
            permissionCallsRef.current.get(event.callId) ?? event.callId
          setRecentDenied((current) =>
            [denied, ...current.filter((item) => item !== denied)].slice(0, 20),
          )
        }
        append({
          kind: event.behavior === 'deny' ? 'warning' : 'notice',
          text:
            event.behavior === 'ask'
              ? `Permission confirmation required · ${event.callId}`
              : `Permission ${event.behavior === 'allow' ? 'allowed' : 'denied'} · ${event.callId}`,
        })
        break
      case 'tool-result':
        append({
          kind: 'tool-result',
          callId: event.callId,
          text: redactSensitiveText(event.content, sensitiveValues),
          isError: event.isError,
        })
        break
      case 'tool-progress':
        setStatus(`${event.toolName} · ${event.elapsedTimeSeconds}s`)
        break
      case 'task-started':
        append({ kind: 'notice', text: `Task started · ${event.description}` })
        break
      case 'task-progress':
        setStatus(event.summary ?? event.description)
        break
      case 'task-notification':
        append({
          kind: event.status === 'failed' ? 'warning' : 'notice',
          text: `Task ${event.status} · ${event.summary}`,
        })
        break
      case 'compact-boundary':
        append({
          kind: 'notice',
          text: `Conversation compacted · ${event.preTokens} tokens`,
        })
        break
      case 'api-retry':
        append({
          kind: 'warning',
          text: `API retry ${event.attempt}/${event.maxRetries} · ${event.error}`,
        })
        break
      case 'elicitation-complete':
        append({
          kind: 'notice',
          text: `MCP elicitation completed · ${event.mcpServerName}`,
        })
        break
      case 'tool-use-summary':
        append({ kind: 'notice', text: event.summary })
        break
      case 'hook': {
        const { event: hook } = event
        const outcome = hook.outcome ? ` · ${hook.outcome}` : ''
        append({
          kind: hook.outcome === 'error' ? 'warning' : 'notice',
          text: `Hook ${hook.type} · ${hook.hookName}${outcome}`,
        })
        break
      }
      case 'session-state-changed':
        setStatus(event.state.replace('_', ' '))
        break
      case 'warning':
      case 'failed':
        append({
          kind: 'warning',
          text: redactSensitiveText(event.message, sensitiveValues),
        })
        break
      default: {
        const unreachable: never = event
        return unreachable
      }
    }
  }

  const requestApproval = (
    call: ModelToolCall,
    kind: PendingPermission['kind'],
  ) =>
    new Promise<boolean>((resolveApproval) => {
      let settled = false
      const pending: PendingPermission = {
        kind,
        call,
        resolve: (approved) => {
          if (settled) return
          settled = true
          if (permissionRef.current === pending) permissionRef.current = null
          setPermission((current) => (current === pending ? null : current))
          resolveApproval(approved)
        },
      }
      permissionRef.current = pending
      setPermission(pending)
    })
  const approveTool = (call: ModelToolCall) => requestApproval(call, 'tool')

  const requestElicitation = (request: CliElicitationRequest) =>
    new Promise<CliElicitationResult>((resolveResult) => {
      let settled = false
      const pending: PendingElicitation = {
        request,
        resolve: (result) => {
          if (settled) return
          settled = true
          if (elicitationRef.current === pending) elicitationRef.current = null
          setElicitation((current) => (current === pending ? null : current))
          resolveResult(result)
        },
      }
      elicitationRef.current = pending
      setElicitation(pending)
    })
  const approveRecovery = (call: ModelToolCall) =>
    resume?.retryInterruptedTools ? true : requestApproval(call, 'recovery')

  const askUser: ClaudeInteractiveToolCallbacks['askUser'] = (
    questions,
    signal,
  ) =>
    new Promise<ClaudeQuestionResult | null>((resolveResult) => {
      let settled = false
      const abort = () => pending.resolve(null)
      const pending: PendingQuestion = {
        questions,
        index: 0,
        answers: {},
        resolve: (result) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', abort)
          if (questionRef.current === pending) questionRef.current = null
          setQuestion((current) => (current === pending ? null : current))
          resolveResult(result)
        },
      }
      if (signal?.aborted) {
        pending.resolve(null)
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      clearComposerInput()
      questionRef.current = pending
      setQuestion(pending)
    })

  const approvePlan: ClaudeInteractiveToolCallbacks['approvePlan'] = (
    request,
    signal,
  ) =>
    new Promise<boolean>((resolveApproval) => {
      let settled = false
      const abort = () => pending.resolve(false)
      const pending: PendingPlanApproval = {
        request,
        resolve: (approved) => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', abort)
          if (planApprovalRef.current === pending)
            planApprovalRef.current = null
          setPlanApproval((current) => (current === pending ? null : current))
          resolveApproval(approved)
        },
      }
      if (signal?.aborted) {
        pending.resolve(false)
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      planApprovalRef.current = pending
      setPlanApproval(pending)
    })

  const warn = (error: unknown) =>
    append({
      kind: 'warning',
      text: redactSensitiveText(
        error instanceof Error ? error.message : String(error),
        sensitiveValues,
      ),
    })

  const retireService = (): Promise<void> => {
    serviceEpochRef.current += 1
    scheduledWaitRef.current?.abort()
    const current = serviceRef.current
    serviceRef.current = null
    if (!current?.close) return Promise.resolve()
    const closing = current.close().catch((error: unknown) => {
      warn(error)
    })
    serviceRetirementRef.current = closing
    void closing.finally(() => {
      if (serviceRetirementRef.current === closing)
        serviceRetirementRef.current = null
    })
    return closing
  }

  const updateRuntimePreferences = (
    update: (current: RuntimePreferences) => RuntimePreferences,
  ) => {
    const next = update(runtimePreferencesRef.current)
    runtimePreferencesRef.current = next
    setRuntimePreferences(next)
    return next
  }

  const service = async () => {
    if (serviceRef.current) return serviceRef.current
    let pending = serviceCreationRef.current
    let epoch = serviceCreationEpochRef.current
    if (!pending) {
      epoch = serviceEpochRef.current
      const preferences = runtimePreferencesRef.current
      pending = (async () => {
        await serviceRetirementRef.current
        return factory.createService({
          eventSink: handleEvent,
          requireProvider: true,
          approveRecovery,
          approveTool,
          onElicitation: requestElicitation,
          askUser,
          approvePlan,
          ...(preferences.model === undefined
            ? {}
            : { model: preferences.model }),
          effort: preferences.effort,
          permissionMode: preferences.permissionMode,
          ...(signal ? { signal } : {}),
        })
      })()
      serviceCreationRef.current = pending
      serviceCreationEpochRef.current = epoch
    }
    try {
      const created = await pending
      if (epoch !== serviceEpochRef.current) {
        try {
          await created.close?.()
        } catch (error) {
          warn(error)
        }
        if (serviceCreationRef.current === pending) {
          serviceCreationRef.current = undefined
          serviceCreationEpochRef.current = null
        }
        return service()
      }
      serviceRef.current = created
      setAvailableSlashCommands(created.slashCommands?.() ?? slashCommands)
      const runtimeInfo = created.runtimeInfo?.()
      if (runtimeInfo?.contextWindowTokens !== undefined)
        setContextWindowTokens(runtimeInfo.contextWindowTokens)
      return created
    } finally {
      if (serviceCreationRef.current === pending) {
        serviceCreationRef.current = undefined
        serviceCreationEpochRef.current = null
      }
    }
  }

  const changeModel = (model: string | undefined) => {
    updateRuntimePreferences((current) => {
      if (model !== undefined) return { ...current, model }
      const withoutModel = { ...current }
      delete withoutModel.model
      return withoutModel
    })
    void retireService()
    append({
      kind: 'notice',
      text: model
        ? `Model set to ${model} for this session.`
        : 'Model reset to the invocation default for this session.',
    })
  }

  const changeEffort = (nextEffort: RuntimePreferences['effort']) => {
    updateRuntimePreferences((current) => ({ ...current, effort: nextEffort }))
    void retireService()
    append({
      kind: 'notice',
      text: `Effort set to ${nextEffort} for this session.`,
    })
  }

  const changePermissionMode = (mode: ClaudePermissionMode) => {
    updateRuntimePreferences((current) => ({
      ...current,
      permissionMode: mode,
    }))
    const change = (async () => {
      setBusy(true)
      setStatus('updating permission mode')
      try {
        if (sessionId) {
          const commands = await service()
          if (!commands.setPermissionMode) {
            throw new Error(
              'This interactive service cannot persist permission mode changes.',
            )
          }
          await commands.setPermissionMode(sessionId, mode)
        }
        await retireService()
        append({
          kind: 'notice',
          text: `Permission mode set to ${mode} for this session.`,
        })
      } catch (error) {
        warn(error)
      } finally {
        setBusy(false)
        setStatus('ready')
      }
    })()
    onTurnChange?.(change)
    void change.finally(() => onTurnChange?.(null))
  }

  const openTasks = () => {
    const loading = (async () => {
      setBusy(true)
      setStatus('loading tasks')
      try {
        const rows = workflowRows((await service()).workflows?.() ?? [])
        updateMenu({
          kind: 'list',
          title: 'Background',
          rows,
          emptyText: 'No tasks currently running',
          selectedIndex: 0,
        })
      } catch (error) {
        warn(error)
      } finally {
        setBusy(false)
        setStatus('ready')
      }
    })()
    onTurnChange?.(loading)
    void loading.finally(() => onTurnChange?.(null))
  }

  const submit = async (prompt: string) => {
    const turnNumber = turnNumberRef.current + 1
    turnNumberRef.current = turnNumber
    turnMutatedFilesRef.current = false
    scheduledWaitRef.current?.abort()
    appendPromptHistory(prompt)
    const turnController = new AbortController()
    turnControllerRef.current?.abort()
    turnControllerRef.current = turnController
    const turnSignal = signal
      ? AbortSignal.any([signal, turnController.signal])
      : turnController.signal
    setBusy(true)
    setCommandPaletteOpen(false)
    setStatus('assembling-context')
    setActiveText('')
    setActiveThinking('')
    append({ kind: 'user', text: prompt })
    let commands: InteractiveSessionCommands | undefined
    try {
      commands = await service()
      let activeSessionId = sessionId
      const startedNewSession = activeSessionId === null
      if (activeSessionId && pendingFork) {
        const fork = await commands.fork(activeSessionId, resume?.forkSessionId)
        activeSessionId = fork.sessionId
        setSessionId(activeSessionId)
        setPendingFork(false)
      }
      const result = activeSessionId
        ? await commands.resume(activeSessionId, prompt, turnSignal)
        : await commands.run(prompt, turnSignal)
      setSessionId(result.sessionId)
      if (
        startedNewSession &&
        runtimePreferencesRef.current.permissionMode !== 'default'
      ) {
        try {
          await commands.setPermissionMode?.(
            result.sessionId,
            runtimePreferencesRef.current.permissionMode,
          )
        } catch (error) {
          warn(error)
        }
      }
      setUsage(result.usage)
      setCostUsd(result.costUsd)
      append({ kind: 'assistant', text: result.text })
      if (turnMutatedFilesRef.current) {
        try {
          const snapshot = await loadDiffSnapshot()
          setTurnDiffs((current) => [
            ...current.filter((source) => source.label !== `T${turnNumber}`),
            { label: `T${turnNumber}`, snapshot },
          ])
        } catch {
          // Diff snapshots are a local presentation aid and must not fail a turn.
        }
      }
      setActiveText('')
      setActiveThinking('')
      setStatus('ready')
    } catch (error) {
      if (turnController.signal.aborted && !signal?.aborted) {
        append({ kind: 'notice', text: 'Interrupted by user.' })
        setStatus('cancelled')
      } else {
        append({
          kind: 'warning',
          text: redactSensitiveText(
            error instanceof Error ? error.message : String(error),
            sensitiveValues,
          ),
        })
        setStatus('failed')
      }
    } finally {
      if (!factory.scheduledPrompts && commands) {
        try {
          await commands.close?.()
        } catch (error) {
          append({
            kind: 'warning',
            text: redactSensitiveText(
              error instanceof Error ? error.message : String(error),
              sensitiveValues,
            ),
          })
        } finally {
          if (serviceRef.current === commands) serviceRef.current = null
        }
      }
      if (turnControllerRef.current === turnController)
        turnControllerRef.current = null
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!initialPromptPending || selectingSession || busy) return
    const prompt = initialPromptRef.current
    if (!prompt) {
      setInitialPromptPending(false)
      return
    }
    initialPromptRef.current = ''
    const turn = submit(prompt)
    onTurnChange?.(turn)
    void turn.then(
      () => {
        setInitialPromptPending(false)
        onTurnChange?.(null)
      },
      () => {
        setInitialPromptPending(false)
        onTurnChange?.(null)
      },
    )
  }, [busy, initialPromptPending, selectingSession])

  useEffect(() => {
    if (
      !factory.scheduledPrompts ||
      initialPromptPending ||
      selectingSession ||
      busy ||
      permission
    ) {
      return
    }
    const controller = new AbortController()
    scheduledWaitRef.current?.abort()
    scheduledWaitRef.current = controller
    const waitSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    void service()
      .then((commands) => commands.nextScheduledPrompt?.(waitSignal) ?? null)
      .then((scheduled) => {
        if (!scheduled || waitSignal.aborted) return
        const turn = submit(scheduled.prompt)
        onTurnChange?.(turn)
        void turn.then(
          () => onTurnChange?.(null),
          () => onTurnChange?.(null),
        )
      })
      .catch((error: unknown) => {
        if (waitSignal.aborted) return
        append({
          kind: 'warning',
          text: redactSensitiveText(
            error instanceof Error ? error.message : String(error),
            sensitiveValues,
          ),
        })
      })
    return () => controller.abort()
  }, [busy, initialPromptPending, permission, selectingSession, sessionId])

  useInput((value, key) => {
    const lower = value.toLowerCase()
    const controlKey = (letter: string) =>
      (key.ctrl && lower === letter) ||
      value === String.fromCharCode(letter.charCodeAt(0) - 96)
    const printable = [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint >= 32 && codePoint !== 127
    })
    const editor = () =>
      createComposerEditor(inputRef.current, inputCursorRef.current)
    const editComposer = () => {
      if (key.leftArrow) {
        updateComposerEditor(
          key.meta
            ? moveComposerCursorByWord(editor(), 'backward')
            : moveComposerCursor(editor(), -1),
        )
        return true
      }
      if (key.rightArrow) {
        updateComposerEditor(
          key.meta
            ? moveComposerCursorByWord(editor(), 'forward')
            : moveComposerCursor(editor(), 1),
        )
        return true
      }
      if (controlKey('a')) {
        updateComposerEditor(createComposerEditor(inputRef.current, 0))
        return true
      }
      if (controlKey('e')) {
        updateComposerEditor(createComposerEditor(inputRef.current))
        return true
      }
      if (controlKey('b')) {
        updateComposerEditor(moveComposerCursor(editor(), -1))
        return true
      }
      if (controlKey('f')) {
        updateComposerEditor(moveComposerCursor(editor(), 1))
        return true
      }
      if (controlKey('w')) {
        updateComposerEditor(deleteComposerWordBackward(editor()))
        return true
      }
      if (controlKey('u')) {
        updateComposerEditor(deleteComposerToStart(editor()))
        return true
      }
      if (controlKey('k')) {
        updateComposerEditor(deleteComposerToEnd(editor()))
        return true
      }
      if (key.backspace) {
        updateComposerEditor(deleteComposerBackward(editor()))
        return true
      }
      if (key.delete) {
        updateComposerEditor(deleteComposerForward(editor()))
        return true
      }
      if (!key.ctrl && !key.meta && value && printable) {
        updateComposerEditor(insertComposerText(editor(), value))
        return true
      }
      return false
    }

    if (controlKey('c')) {
      armExitConfirmation()
      return
    }
    dismissExitConfirmation()

    if (permission) {
      if (lower === 'y' || value === '1') {
        permission.resolve(true)
      } else if (lower === 'n' || value === '2' || key.return || key.escape) {
        permission.resolve(false)
      }
      return
    }

    if (planApproval) {
      if (lower === 'y' || value === '1') {
        planApproval.resolve(true)
      } else if (lower === 'n' || value === '2' || key.return || key.escape) {
        planApproval.resolve(false)
      }
      return
    }

    if (question) {
      if (key.escape) {
        question.resolve(null)
      } else if (key.return) {
        try {
          const current = question.questions[question.index]
          if (!current) throw new Error('Question state is invalid.')
          const answer = questionAnswer(current, inputRef.current.trim())
          const answers = { ...question.answers, [current.question]: answer }
          clearComposerInput()
          if (question.index === question.questions.length - 1) {
            question.resolve({ answers })
          } else {
            const next = { ...question, index: question.index + 1, answers }
            questionRef.current = next
            setQuestion(next)
          }
        } catch (error) {
          append({
            kind: 'warning',
            text: error instanceof Error ? error.message : String(error),
          })
        }
      } else {
        editComposer()
      }
      return
    }

    if (elicitation) {
      if (key.escape) {
        elicitation.resolve({ action: 'cancel' })
      } else if (key.return) {
        const answer = inputRef.current.trim()
        clearComposerInput()
        if (!answer || answer.toLowerCase() === 'decline') {
          elicitation.resolve({ action: 'decline' })
        } else if (answer.toLowerCase() === 'cancel') {
          elicitation.resolve({ action: 'cancel' })
        } else if (answer.toLowerCase() === 'accept') {
          elicitation.resolve({ action: 'accept' })
        } else {
          try {
            const content: unknown = JSON.parse(answer)
            if (
              !content ||
              typeof content !== 'object' ||
              Array.isArray(content)
            )
              throw new Error('elicitation content must be a JSON object')
            elicitation.resolve({
              action: 'accept',
              content: content as Record<
                string,
                string | number | boolean | string[]
              >,
            })
          } catch {
            append({
              kind: 'warning',
              text: 'Elicitation response must be accept, decline, cancel, or a JSON object.',
            })
          }
        }
      } else {
        editComposer()
      }
      return
    }

    if (selectingSession) {
      if (key.escape || value === '\u001B') {
        if (pickerIncludesNewSessionRef.current && allowNewSession) {
          setSessionId(null)
          setPendingFork(false)
          setSelectingSession(false)
        } else if (allowNewSession) {
          setSelectingSession(false)
        } else {
          onCancel?.()
          exit()
        }
      } else if (key.upArrow) {
        selectedIndexRef.current = Math.max(0, selectedIndexRef.current - 1)
        setSelectedIndex(selectedIndexRef.current)
      } else if (key.downArrow) {
        selectedIndexRef.current = Math.min(
          Math.max(0, filteredPickerChoices.length - 1),
          selectedIndexRef.current + 1,
        )
        setSelectedIndex(selectedIndexRef.current)
      } else if (key.return) {
        const currentPickerChoices = pickerIncludesNewSessionRef.current
          ? choices
          : initialSessions
        const selected = filterSessionChoices(
          currentPickerChoices,
          sessionSearchRef.current,
        )[selectedIndexRef.current]
        if (selected === undefined) return
        setSessionId(selected?.sessionId ?? null)
        if (!selected) setPendingFork(false)
        setSelectingSession(false)
      } else if (key.backspace || key.delete) {
        sessionSearchRef.current = sessionSearchRef.current.slice(0, -1)
        setSessionSearch(sessionSearchRef.current)
        selectedIndexRef.current = 0
        setSelectedIndex(0)
      } else if (!key.ctrl && !key.meta && value && printable) {
        sessionSearchRef.current += value
        setSessionSearch(sessionSearchRef.current)
        selectedIndexRef.current = 0
        setSelectedIndex(0)
      }
      return
    }

    if (!busy && controlKey('t')) {
      openTasks()
      return
    }
    if (!busy && key.meta && lower === 'p') {
      updateMenu({ kind: 'model', selectedIndex: 0 })
      return
    }
    if (!busy && controlKey('s')) {
      if (inputRef.current.length > 0) {
        stashedInputRef.current = inputRef.current
        clearComposerInput()
      } else if (stashedInputRef.current.length > 0) {
        const stashed = stashedInputRef.current
        stashedInputRef.current = ''
        updateComposerInput(stashed)
      }
      return
    }

    const activeMenu = menuRef.current
    if (activeMenu) {
      if (activeMenu.kind === 'help') {
        if (key.escape) {
          updateMenu(null)
          return
        }
        if (key.leftArrow || key.rightArrow) {
          updateMenu({
            kind: 'help',
            tabIndex: Math.max(
              0,
              Math.min(2, activeMenu.tabIndex + (key.leftArrow ? -1 : 1)),
            ),
            selectedIndex: 0,
          })
          return
        }
        const commands =
          activeMenu.tabIndex === 1
            ? builtinSlashCommands
            : activeMenu.tabIndex === 2
              ? customSlashCommands
              : []
        if (key.upArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(0, activeMenu.selectedIndex - 1),
          })
        } else if (key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.min(
              Math.max(0, commands.length - 1),
              activeMenu.selectedIndex + 1,
            ),
          })
        }
        return
      }

      if (activeMenu.kind === 'diff') {
        const snapshot = activeMenu.snapshots[activeMenu.sourceIndex]?.snapshot
        const selectedFile = snapshot?.files[activeMenu.selectedIndex]
        if (key.escape || value === '\u001B') {
          updateMenu(
            activeMenu.viewingFile
              ? { ...activeMenu, viewingFile: false, scrollOffset: 0 }
              : null,
          )
          return
        }
        if (key.leftArrow || key.rightArrow) {
          updateMenu({
            ...activeMenu,
            sourceIndex: Math.max(
              0,
              Math.min(
                activeMenu.snapshots.length - 1,
                activeMenu.sourceIndex + (key.leftArrow ? -1 : 1),
              ),
            ),
            selectedIndex: 0,
            viewingFile: false,
            scrollOffset: 0,
          })
          return
        }
        if (activeMenu.viewingFile) {
          const maxOffset = Math.max(
            0,
            visiblePatchLines(selectedFile?.patch ?? '').length - 18,
          )
          if (key.upArrow || key.downArrow) {
            updateMenu({
              ...activeMenu,
              scrollOffset: Math.max(
                0,
                Math.min(
                  maxOffset,
                  activeMenu.scrollOffset + (key.upArrow ? -1 : 1),
                ),
              ),
            })
          }
          return
        }
        if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                Math.max(0, (snapshot?.files.length ?? 0) - 1),
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        } else if (key.return && selectedFile) {
          updateMenu({ ...activeMenu, viewingFile: true, scrollOffset: 0 })
        }
        return
      }

      if (activeMenu.kind === 'permission-rule-input') {
        if (key.escape || value === '\u001B') {
          clearComposerInput()
          updateMenu(null)
        } else if (key.return) {
          const rule = inputRef.current.trim()
          if (!rule) {
            append({
              kind: 'warning',
              text: 'Enter a permission rule or press Esc.',
            })
          } else {
            clearComposerInput()
            updateMenu({
              kind: 'permission-scope',
              behavior: activeMenu.behavior,
              rule,
              selectedIndex: 0,
            })
          }
        } else {
          editComposer()
        }
        return
      }

      if (activeMenu.kind === 'permission-scope') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
          return
        }
        if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(2, activeMenu.selectedIndex + (key.upArrow ? -1 : 1)),
            ),
          })
          return
        }
        if (key.return) {
          const scopes = ['local', 'project', 'user'] as const
          const scope = scopes[activeMenu.selectedIndex]
          if (!scope) return
          const addition = (async () => {
            setBusy(true)
            try {
              await permissionStore.add({
                behavior: activeMenu.behavior,
                rule: activeMenu.rule,
                scope,
              })
              await retireService()
              const rules = await permissionStore.load()
              updateMenu({
                kind: 'permission-dashboard',
                tabIndex:
                  ['allow', 'ask', 'deny'].indexOf(activeMenu.behavior) + 1,
                selectedIndex: 0,
                query: '',
                rules,
              })
            } catch (error) {
              warn(error)
            } finally {
              setBusy(false)
            }
          })()
          onTurnChange?.(addition)
          void addition.finally(() => onTurnChange?.(null))
        }
        return
      }

      if (activeMenu.kind === 'permission-dashboard') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
          return
        }
        if (key.leftArrow || key.rightArrow) {
          updateMenu({
            ...activeMenu,
            tabIndex: Math.max(
              0,
              Math.min(4, activeMenu.tabIndex + (key.leftArrow ? -1 : 1)),
            ),
            selectedIndex: 0,
            query: '',
          })
          return
        }
        const behavior = (['allow', 'ask', 'deny'] as const)[
          activeMenu.tabIndex - 1
        ]
        const query = activeMenu.query.toLowerCase()
        const matchingRules = behavior
          ? activeMenu.rules.filter(
              (rule) =>
                rule.behavior === behavior &&
                (!query ||
                  rule.rule.toLowerCase().includes(query) ||
                  rule.scope.includes(query)),
            )
          : []
        const rowCount =
          activeMenu.tabIndex === 0
            ? recentDenied.length
            : activeMenu.tabIndex === 4
              ? permissionOptions.length
              : matchingRules.length + 1
        if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                Math.max(0, rowCount - 1),
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        } else if (key.backspace || key.delete) {
          updateMenu({
            ...activeMenu,
            query: activeMenu.query.slice(0, -1),
            selectedIndex: 0,
          })
        } else if (behavior && !key.ctrl && !key.meta && value && printable) {
          updateMenu({
            ...activeMenu,
            query: activeMenu.query + value,
            selectedIndex: 0,
          })
        } else if (
          key.return &&
          behavior &&
          activeMenu.selectedIndex === matchingRules.length
        ) {
          clearComposerInput()
          updateMenu({ kind: 'permission-rule-input', behavior })
        } else if (key.return && activeMenu.tabIndex === 4) {
          const mode = permissionOptions[activeMenu.selectedIndex]?.mode
          if (mode) {
            updateMenu(null)
            changePermissionMode(mode)
          }
        }
        return
      }

      if (activeMenu.kind === 'status') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
        } else if (key.leftArrow || key.rightArrow || key.tab) {
          const direction = key.leftArrow || (key.tab && key.shift) ? -1 : 1
          updateMenu({
            kind: 'status',
            tabIndex: Math.max(0, Math.min(4, activeMenu.tabIndex + direction)),
          })
        }
        return
      }

      if (activeMenu.kind === 'list') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
        } else if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                Math.max(0, activeMenu.rows.length - 1),
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        }
        return
      }

      if (activeMenu.kind === 'model-input') {
        if (key.escape) {
          clearComposerInput()
          updateMenu(null)
        } else if (key.return) {
          const model = inputRef.current.trim()
          if (!model) {
            append({ kind: 'warning', text: 'Enter a model ID or press Esc.' })
          } else {
            clearComposerInput()
            updateMenu(null)
            changeModel(model)
          }
        } else {
          editComposer()
        }
        return
      }

      if (key.escape) {
        updateMenu(null)
        return
      }

      const optionCount =
        activeMenu.kind === 'model'
          ? modelOptions.length
          : EFFORT_OPTIONS.length
      const select = (selectedIndex: number) =>
        updateMenu({ ...activeMenu, selectedIndex })
      if (key.upArrow) {
        select(Math.max(0, activeMenu.selectedIndex - 1))
        return
      }
      if (key.downArrow) {
        select(Math.min(optionCount - 1, activeMenu.selectedIndex + 1))
        return
      }
      if (/^[1-9]$/u.test(value)) {
        select(Math.min(optionCount - 1, Number(value) - 1))
        return
      }
      if (activeMenu.kind === 'model' && (key.leftArrow || key.rightArrow)) {
        const currentEffort = runtimePreferencesRef.current.effort
        const currentIndex = EFFORT_OPTIONS.indexOf(currentEffort)
        const nextIndex = Math.max(
          0,
          Math.min(
            EFFORT_OPTIONS.length - 1,
            currentIndex + (key.leftArrow ? -1 : 1),
          ),
        )
        const nextEffort = EFFORT_OPTIONS[nextIndex]
        if (nextEffort && nextEffort !== currentEffort) changeEffort(nextEffort)
        return
      }
      if (!key.return && lower !== 's') return

      if (activeMenu.kind === 'model') {
        if (activeMenu.selectedIndex === 1) {
          updateMenu(null)
          changeModel(undefined)
        } else if (activeMenu.selectedIndex === 2) {
          clearComposerInput()
          updateMenu({ kind: 'model-input' })
        } else {
          updateMenu(null)
        }
      } else {
        const selectedEffort = EFFORT_OPTIONS[activeMenu.selectedIndex]
        if (selectedEffort) changeEffort(selectedEffort)
        updateMenu(null)
      }
      return
    }

    if (!busy && value === '?' && inputRef.current.length === 0) {
      setShortcutsVisible((current) => !current)
      return
    }
    if (controlKey('o') && hasDetailedTranscript) {
      setThinkingExpanded((current) => !current)
      return
    }
    if (busy) {
      if (key.escape || value === '\u001B') turnControllerRef.current?.abort()
      return
    }
    if (value === '\u001F' || (key.ctrl && value === '_')) {
      const previous = undoStackRef.current.at(-1)
      if (previous) {
        undoStackRef.current = undoStackRef.current.slice(0, -1)
        updateComposerEditor(previous, false)
      }
      return
    }
    if (filePickerVisible) {
      if (key.escape || value === '\u001B') {
        setFilePickerOpen(false)
        return
      }
      if (key.upArrow) {
        setFileSelection((current) => Math.max(0, current - 1))
        return
      }
      if (key.downArrow) {
        setFileSelection((current) =>
          Math.min(matchingFileEntries.length - 1, current + 1),
        )
        return
      }
      const selected = matchingFileEntries[selectedFileIndex]
      if (selected && (key.tab || key.return) && fileReference) {
        updateComposerEditor(
          applyFileReference(
            inputRef.current,
            inputCursorRef.current,
            fileReference,
            selected.path,
          ),
        )
        setFilePickerOpen(false)
        return
      }
      if (key.tab) return
    }
    if (key.escape || value === '\u001B') {
      const now = Date.now()
      if (now - lastEscapeAtRef.current <= 500) clearComposerInput()
      lastEscapeAtRef.current = now
      return
    }
    if (key.tab && key.shift) {
      const currentIndex = permissionOptions.findIndex(
        (option) => option.mode === runtimePreferences.permissionMode,
      )
      const next =
        permissionOptions[(currentIndex + 1) % permissionOptions.length]
      if (next) changePermissionMode(next.mode)
      return
    }
    if (commandPaletteVisible) {
      if (key.escape) {
        setCommandPaletteOpen(false)
        return
      }
      if (key.upArrow) {
        if (matchingSlashCommands.length > 0) {
          setCommandSelection((current) => Math.max(0, current - 1))
        }
        return
      }
      if (key.downArrow) {
        if (matchingSlashCommands.length > 0) {
          setCommandSelection((current) =>
            Math.min(matchingSlashCommands.length - 1, current + 1),
          )
        }
        return
      }
      const selectedCommand = matchingSlashCommands[selectedSlashCommandIndex]
      const exactSelectedCommand =
        selectedCommand !== undefined &&
        inputRef.current.toLocaleLowerCase() ===
          `/${selectedCommand.name}`.toLocaleLowerCase()
      if (
        selectedCommand &&
        (key.tab || (key.return && !exactSelectedCommand))
      ) {
        updateComposerInput(`/${selectedCommand.name} `)
        setCommandPaletteOpen(false)
        return
      }
    }
    if (key.return) {
      if (key.shift) {
        updateComposerEditor(insertComposerText(editor(), '\n'))
        return
      }
      if (inputRef.current.endsWith('\\')) {
        const withoutContinuation = createComposerEditor(
          inputRef.current.slice(0, -1),
        )
        updateComposerEditor(insertComposerText(withoutContinuation, '\n'))
        return
      }
      const prompt = inputRef.current.trim()
      clearComposerInput()
      undoStackRef.current = []
      if (!prompt) return
      if (prompt === '/exit') {
        exit()
      } else if (prompt === '/help' || prompt === '?') {
        updateMenu({ kind: 'help', tabIndex: 0, selectedIndex: 0 })
      } else if (prompt === '/new') {
        setSessionId(null)
        setPendingFork(false)
        append({ kind: 'notice', text: 'Started a new session.' })
      } else if (prompt === '/clear') {
        setSessionId(null)
        setPendingFork(false)
        setHistory([])
        setUsage(undefined)
        setCostUsd(undefined)
        setActiveText('')
        setActiveThinking('')
        setThinkingExpanded(false)
        setStatus('ready')
        inputHistoryRef.current = []
        inputHistoryIndexRef.current = null
        inputHistoryDraftRef.current = ''
      } else if (prompt === '/model') {
        updateMenu({ kind: 'model', selectedIndex: 0 })
      } else if (prompt === '/effort') {
        updateMenu({
          kind: 'effort',
          selectedIndex: EFFORT_OPTIONS.indexOf(runtimePreferences.effort),
        })
      } else if (prompt === '/permissions') {
        const loading = (async () => {
          setBusy(true)
          try {
            updateMenu({
              kind: 'permission-dashboard',
              tabIndex: 0,
              selectedIndex: 0,
              query: '',
              rules: await permissionStore.load(),
            })
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(loading)
        void loading.finally(() => onTurnChange?.(null))
      } else if (prompt === '/resume' || prompt === '/sessions') {
        pickerIncludesNewSessionRef.current = false
        setPickerIncludesNewSession(false)
        sessionSearchRef.current = ''
        setSessionSearch('')
        selectedIndexRef.current = 0
        setSelectedIndex(0)
        setSelectingSession(true)
      } else if (prompt === '/diff') {
        const inspection = (async () => {
          setBusy(true)
          setStatus('loading diff')
          try {
            const current = await loadDiffSnapshot()
            updateMenu({
              kind: 'diff',
              snapshots: [
                { label: 'Current', snapshot: current },
                ...turnDiffs,
              ],
              sourceIndex: 0,
              selectedIndex: 0,
              viewingFile: false,
              scrollOffset: 0,
            })
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
            setStatus('ready')
          }
        })()
        onTurnChange?.(inspection)
        void inspection.finally(() => onTurnChange?.(null))
      } else if (prompt === '/context') {
        const skills = allSlashCommands
          .filter((command) => command.source === 'skill')
          .map((command) => ({
            name: command.name,
            tokens: estimatedCommandTokens(command),
          }))
        const measuredTokens =
          (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
        const skillTokens = skills.reduce(
          (total, skill) => total + skill.tokens,
          0,
        )
        setHistory((current) => [
          ...current,
          { kind: 'user', text: '/context' },
          {
            kind: 'context',
            usedTokens: Math.max(measuredTokens, skillTokens),
            contextWindowTokens: runtimeDisplay.contextWindowTokens ?? 200_000,
            skills,
          },
        ])
      } else if (prompt === '/status') {
        updateMenu({ kind: 'status', tabIndex: 1 })
      } else if (prompt === '/skills') {
        updateMenu({
          kind: 'list',
          title: 'Skills',
          rows: allSlashCommands
            .filter((command) => command.source === 'skill')
            .map((command) => ({
              label: command.name,
              description: command.description,
            })),
          emptyText:
            'No skills found\nCreate skills in .claude/skills/ or ~/.claude/skills/',
          selectedIndex: 0,
        })
      } else if (prompt === '/tasks' || prompt === '/workflows') {
        openTasks()
      } else if (prompt === '/plan') {
        changePermissionMode('plan')
      } else {
        const turn = submit(prompt)
        onTurnChange?.(turn)
        void turn.then(
          () => onTurnChange?.(null),
          () => onTurnChange?.(null),
        )
      }
      return
    }
    if (key.upArrow) {
      restorePromptHistory('previous')
      return
    }
    if (key.downArrow) {
      restorePromptHistory('next')
      return
    }
    editComposer()
  })

  return (
    <Box flexDirection="column">
      {selectingSession ? (
        <SessionPicker
          sessions={filteredPickerChoices}
          selectedIndex={selectedIndex}
          screenReader={axScreenReader}
          query={sessionSearch}
        />
      ) : (
        <>
          {!axScreenReader && history.length === 0 && !sessionId ? (
            <WelcomePanel display={runtimeDisplay} width={width} />
          ) : null}
          {sessionId ? (
            <Text dimColor>Session {sessionId.slice(0, 8)}</Text>
          ) : null}
          <Transcript
            items={history}
            activeText={activeText}
            activeThinking={activeThinking}
            thinkingExpanded={thinkingExpanded}
            detailedTranscript={thinkingExpanded}
            screenReader={axScreenReader}
          />
          {permission ? (
            <DialogFrame
              title={
                permission.kind === 'recovery'
                  ? `Retry interrupted ${permission.call.name}?`
                  : `Allow ${permission.call.name}?`
              }
              screenReader={axScreenReader}
            >
              <Text bold>{describeTool(permission.call, sensitiveValues)}</Text>
              <Text>❯ 1. Yes</Text>
              <Text> 2. No</Text>
              <Text dimColor>Enter/Esc declines · y/n quick response</Text>
            </DialogFrame>
          ) : planApproval ? (
            <DialogFrame
              title="Approve this plan and begin implementation?"
              screenReader={axScreenReader}
            >
              <Text dimColor>{planApproval.request.planPath}</Text>
              {planApproval.request.plan ? (
                <Box marginY={1}>
                  <Text>{planApproval.request.plan}</Text>
                </Box>
              ) : null}
              <Text>❯ 1. Yes, implement the plan</Text>
              <Text> 2. No, keep planning</Text>
            </DialogFrame>
          ) : question ? (
            <DialogFrame
              title={`${question.questions[question.index]?.header}: ${question.questions[question.index]?.question}`}
              screenReader={axScreenReader}
            >
              {question.questions[question.index]?.options.map(
                (option, index) => (
                  <Box key={`${index}-${option.label}`} flexDirection="column">
                    <Text>
                      {index === 0 ? '❯ ' : '  '}
                      {index + 1}. {option.label} — {option.description}
                    </Text>
                    {option.preview ? (
                      <Text dimColor>{option.preview}</Text>
                    ) : null}
                  </Box>
                ),
              )}
              <Text>› {input}</Text>
              <Text dimColor>
                {question.questions[question.index]?.multiSelect
                  ? 'Enter comma-separated option numbers or custom text · Esc cancels'
                  : 'Enter one option number or custom text · Esc cancels'}
              </Text>
            </DialogFrame>
          ) : elicitation ? (
            <DialogFrame
              title={`MCP elicitation (${elicitation.request.serverName})`}
              screenReader={axScreenReader}
            >
              <Text>{elicitation.request.message}</Text>
              {elicitation.request.url ? (
                <Text>{elicitation.request.url}</Text>
              ) : null}
              {elicitation.request.requestedSchema ? (
                <Text dimColor>
                  {JSON.stringify(elicitation.request.requestedSchema)}
                </Text>
              ) : null}
              <Text>› {input}</Text>
              <Text dimColor>Enter JSON object to accept · Esc to cancel</Text>
            </DialogFrame>
          ) : menu?.kind === 'model-input' ? (
            <DialogFrame title="Enter model ID" screenReader={axScreenReader}>
              <Text dimColor>
                Enter a model ID supported by the configured provider.
              </Text>
              <Text>› {input}</Text>
              <Text dimColor>Enter confirms · Esc cancels</Text>
            </DialogFrame>
          ) : menu?.kind === 'permission-rule-input' ? (
            <DialogFrame
              title="Add a permission rule"
              screenReader={axScreenReader}
            >
              <Text dimColor>
                Examples: Bash(npm test:*), Read(./src/**),
                WebFetch(domain:example.com)
              </Text>
              <Text>› {input}</Text>
              <Text dimColor>Enter continues to scope · Esc cancels</Text>
            </DialogFrame>
          ) : menu ? (
            menu.kind === 'help' ? (
              <HelpMenu
                tabIndex={menu.tabIndex}
                selectedIndex={menu.selectedIndex}
                builtinCommands={builtinSlashCommands}
                customCommands={customSlashCommands}
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu.kind === 'diff' ? (
              <DiffDashboard
                snapshots={menu.snapshots}
                sourceIndex={menu.sourceIndex}
                selectedIndex={menu.selectedIndex}
                viewingFile={menu.viewingFile}
                scrollOffset={menu.scrollOffset}
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu.kind === 'permission-dashboard' ? (
              <PermissionDashboard
                tabIndex={menu.tabIndex}
                selectedIndex={menu.selectedIndex}
                query={menu.query}
                rules={menu.rules}
                recentDenied={recentDenied}
                workspaceModes={permissionOptions.map((option) => ({
                  label: option.label,
                  selected: option.mode === runtimePreferences.permissionMode,
                }))}
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu.kind === 'permission-scope' ? (
              <SelectionMenu
                title="Save permission rule"
                description={`${menu.behavior}: ${menu.rule}`}
                options={[
                  {
                    label: 'Local project',
                    description: 'Save to .claude/settings.local.json.',
                  },
                  {
                    label: 'Checked-in project',
                    description: 'Save to .claude/settings.json.',
                  },
                  {
                    label: 'User',
                    description:
                      'Save to the Claude config root settings.json.',
                  },
                ]}
                selectedIndex={menu.selectedIndex}
                footer="↑/↓ select · Enter saves · Esc cancels"
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu.kind === 'status' ? (
              <StatusDashboard
                tabIndex={menu.tabIndex}
                version={runtimeDisplay.version}
                sessionId={sessionId}
                display={runtimeDisplay}
                {...(usage === undefined ? {} : { usage })}
                {...(costUsd === undefined ? {} : { costUsd })}
                turnCount={turnNumberRef.current}
                toolCount={
                  history.filter((item) => item.kind === 'tool').length
                }
                commandCount={allSlashCommands.length}
                detailedTranscript={thinkingExpanded}
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu.kind === 'list' ? (
              <ListDashboard
                title={menu.title}
                rows={menu.rows}
                emptyText={menu.emptyText}
                selectedIndex={menu.selectedIndex}
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu.kind === 'model' ? (
              <SelectionMenu
                title="Select model"
                description={`Effort: ${runtimePreferences.effort}`}
                options={modelOptions}
                selectedIndex={menu.selectedIndex}
                footer="↑/↓ select · ←/→ effort · Enter applies to this session · Esc cancels"
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu.kind === 'effort' ? (
              <SelectionMenu
                title="Select effort"
                description="Controls how much reasoning effort the provider should use."
                options={EFFORT_OPTIONS.map((option) => ({
                  label: option,
                  description:
                    option === 'low'
                      ? 'Fastest and least deliberative.'
                      : option === 'max'
                        ? 'Highest available reasoning effort.'
                        : 'Use this effort for the next session turns.',
                  selected: option === runtimePreferences.effort,
                }))}
                selectedIndex={menu.selectedIndex}
                footer="↑/↓ select · Enter applies to this session · Esc cancels"
                width={width}
                screenReader={axScreenReader}
              />
            ) : null
          ) : (
            <>
              {commandPaletteVisible ? (
                <CommandPalette
                  commands={matchingSlashCommands}
                  selectedIndex={selectedSlashCommandIndex}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : null}
              {filePickerVisible ? (
                <FilePicker
                  entries={matchingFileEntries}
                  selectedIndex={selectedFileIndex}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : null}
              {exitConfirmation ? (
                <Text color="yellow">Press Ctrl-C again to exit</Text>
              ) : null}
              <Composer
                input={input}
                cursor={inputCursor}
                busy={busy}
                status={status}
                display={runtimeDisplay}
                {...(usage === undefined ? {} : { usage })}
                {...(costUsd === undefined ? {} : { costUsd })}
                width={width}
                screenReader={axScreenReader}
                hasThinking={hasDetailedTranscript}
                thinkingExpanded={thinkingExpanded}
                shortcutsVisible={shortcutsVisible}
              />
            </>
          )}
        </>
      )}
    </Box>
  )
}

export async function runInteractive(options: {
  factory: InteractiveServiceFactory
  initialPrompt?: string
  signal?: AbortSignal
  axScreenReader?: boolean
  allowDangerouslySkipPermissions?: boolean
  display?: TuiDisplayMetadata
  sessionFilter?: (session: SessionSummary) => boolean
  requireSession?: boolean
  missingSessionMessage?: string
  resume?: InteractiveResumeOptions
}): Promise<number> {
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  const listing = await options.factory.createService({
    eventSink: () => undefined,
    requireProvider: false,
    signal,
  })
  let initialSessions: SessionSummary[]
  let initialSlashCommands: readonly TuiSlashCommand[]
  try {
    const sessions = await listing.sessions()
    initialSessions = options.sessionFilter
      ? sessions.filter(options.sessionFilter)
      : sessions
    initialSlashCommands = listing.slashCommands?.() ?? []
    if (options.requireSession && initialSessions.length === 0) {
      throw new Error(
        options.missingSessionMessage ??
          'No conversation linked to a pull request in this project',
      )
    }
  } catch (error) {
    try {
      await listing.close?.()
    } catch {
      // Preserve the session-listing failure as the primary error.
    }
    throw error
  }
  await listing.close?.()
  const canonicalResumeSession =
    options.resume?.sessionId === undefined
      ? undefined
      : initialSessions.find(
          (session) =>
            session.sessionId.toLowerCase() ===
            options.resume?.sessionId?.toLowerCase(),
        )
  const resume = canonicalResumeSession
    ? { ...options.resume, sessionId: canonicalResumeSession.sessionId }
    : options.resume
  let activeTurn: Promise<void> | null = null
  let cleanup: Promise<void> | null = null
  const instance = render(
    <InteractiveApp
      factory={options.factory}
      initialSessions={initialSessions}
      slashCommands={initialSlashCommands}
      {...(options.initialPrompt === undefined
        ? {}
        : { initialPrompt: options.initialPrompt })}
      signal={signal}
      onCancel={() => controller.abort()}
      onTurnChange={(turn) => {
        activeTurn = turn
      }}
      onCleanup={(closing) => {
        cleanup = closing
      }}
      allowNewSession={!options.requireSession}
      {...(resume === undefined ? {} : { resume })}
      {...(options.display === undefined ? {} : { display: options.display })}
      {...(options.axScreenReader ? { axScreenReader: true } : {})}
      {...(options.allowDangerouslySkipPermissions
        ? { allowDangerouslySkipPermissions: true }
        : {})}
    />,
    {
      exitOnCtrlC: false,
      incrementalRendering: !options.axScreenReader,
      interactive: true,
    },
  )
  await instance.waitUntilExit()
  if (activeTurn) await activeTurn
  if (cleanup) await cleanup
  return signal.aborted ? 130 : 0
}
