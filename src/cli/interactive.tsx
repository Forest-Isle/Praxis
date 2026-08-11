import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { useEffect, useMemo, useRef, useState } from 'react'

import { Box, Text, render, useApp, useInput } from 'ink'

import type {
  ForkResult,
  SessionRunResult,
  SessionSummary,
} from '../application/session-service.js'
import type {
  ModelImage,
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
  ExternalEditorWait,
  HelpMenu,
  ListDashboard,
  MentionPicker,
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
  removeTuiPermissionRule,
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
  deleteComposerToEnd,
  deleteComposerToStart,
  deleteComposerWordBackward,
  insertComposerText,
  moveComposerCursorByWord,
} from './tui/composer-editor.js'
import {
  applyMentionReference,
  fileReferenceAtCursor,
  filterTuiMentionEntries,
  loadTuiFileEntries,
  type TuiAgentEntry,
  type TuiFileEntry,
} from './tui/file-picker.js'
import {
  editTuiPrompt,
  openTuiEditorFile,
  type TuiEditorOptions,
  type TuiEditorResult,
} from './tui/external-editor.js'
import { suspendTuiProcess } from './tui/terminal-suspend.js'
import {
  readTuiClipboard,
  writeTuiClipboard,
  type TuiClipboardContent,
} from './tui/clipboard.js'
import {
  composerImageIds,
  deleteComposerImageBackward,
  deleteComposerImageForward,
  insertComposerImageMarker,
  moveComposerCursorAcrossImages,
} from './tui/composer-images.js'
import {
  defaultTuiKeybindings,
  ensureTuiKeybindingsFile,
  hasTuiKeybindingPrefix,
  loadTuiKeybindings,
  resolveTuiKeybinding,
  tuiKeyChord,
  type TuiKeybindingsFile,
} from './tui/keybindings.js'
import {
  completeTuiWorkspaceDirectory,
  resolveTuiWorkspaceDirectory,
} from './tui/workspace-directories.js'

interface InteractiveSessionCommands {
  run(
    prompt: string,
    signal?: AbortSignal,
    sessionId?: string,
    name?: string,
    images?: readonly ModelImage[],
  ): Promise<SessionRunResult>
  resume(
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
    name?: string,
    images?: readonly ModelImage[],
  ): Promise<SessionRunResult>
  runShell?(command: string, signal?: AbortSignal): Promise<SessionRunResult>
  resumeShell?(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult>
  fork(sessionId: string, targetSessionId?: string): Promise<ForkResult>
  sessions(): Promise<SessionSummary[]>
  transcript?(sessionId: string): Promise<TranscriptItem[]>
  workflows?(): readonly Record<string, unknown>[]
  slashCommands?(): readonly TuiSlashCommand[]
  agentDefinitions?(): readonly TuiAgentEntry[]
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
    additionalDirectories?: readonly string[]
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
  initialHistory?: readonly TranscriptItem[]
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
  agents?: readonly TuiAgentEntry[]
  allowDangerouslySkipPermissions?: boolean
  additionalDirectories?: readonly string[]
  diffLoader?: () => Promise<TuiDiffSnapshot>
  fileLoader?: () => Promise<readonly TuiFileEntry[]>
  externalEditor?: (
    prompt: string,
    options: TuiEditorOptions,
  ) => Promise<TuiEditorResult>
  keybindingsConfigRoot?: string
  keybindingsFile?: (configRoot: string) => Promise<TuiKeybindingsFile>
  keybindingsLoader?: typeof loadTuiKeybindings
  keybindingsEditor?: (
    path: string,
    options: TuiEditorOptions,
  ) => Promise<{ editorName: string }>
  suspendProcess?: () => void | Promise<void>
  clipboardReader?: () => Promise<TuiClipboardContent>
  clipboardWriter?: (text: string) => Promise<void>
  permissionRuleStore?: {
    load(): Promise<readonly TuiPermissionRule[]>
    add(input: {
      behavior: TuiPermissionBehavior
      rule: string
      scope: ClaudeResourceScope
    }): Promise<void>
    remove?(rule: TuiPermissionRule): Promise<void>
  }
  workspaceDirectoryResolver?: typeof resolveTuiWorkspaceDirectory
  workspaceDirectoryCompleter?: typeof completeTuiWorkspaceDirectory
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
const EMPTY_AGENTS: readonly TuiAgentEntry[] = []

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
  | {
      kind: 'permission-rule-input'
      behavior: TuiPermissionBehavior
      rules: readonly TuiPermissionRule[]
    }
  | {
      kind: 'permission-delete'
      rule: TuiPermissionRule
      rules: readonly TuiPermissionRule[]
      selectedIndex: number
    }
  | {
      kind: 'permission-scope'
      behavior: TuiPermissionBehavior
      rule: string
      rules: readonly TuiPermissionRule[]
      selectedIndex: number
    }
  | {
      kind: 'workspace-directory-input'
      rules: readonly TuiPermissionRule[]
      returnToPermissions?: boolean
    }
  | {
      kind: 'workspace-directory-delete'
      path: string
      rules: readonly TuiPermissionRule[]
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
  additionalDirectories: readonly string[]
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

function permissionDeleteTitle(behavior: TuiPermissionBehavior): string {
  return `Delete ${
    behavior === 'allow' ? 'allowed' : behavior === 'deny' ? 'denied' : 'ask'
  } tool?`
}

function permissionScopeLabel(scope: ClaudeResourceScope): string {
  return scope === 'local'
    ? 'From project local settings'
    : scope === 'project'
      ? 'From project settings'
      : 'From user settings'
}

function permissionRuleDescription(rule: string): string | undefined {
  const bashPrefix = /^Bash\((.*?)(?::\*| \*)\)$/u.exec(rule)?.[1]?.trim()
  return bashPrefix ? `Any Bash command starting with ${bashPrefix}` : undefined
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

function ordinal(value: number): string {
  const remainder100 = value % 100
  if (remainder100 >= 11 && remainder100 <= 13) return `${value}th`
  switch (value % 10) {
    case 1:
      return `${value}st`
    case 2:
      return `${value}nd`
    case 3:
      return `${value}rd`
    default:
      return `${value}th`
  }
}

export function InteractiveApp({
  factory,
  initialSessions,
  initialPrompt,
  initialHistory = [],
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
  agents = EMPTY_AGENTS,
  allowDangerouslySkipPermissions = false,
  additionalDirectories = [],
  diffLoader,
  fileLoader,
  externalEditor = editTuiPrompt,
  keybindingsConfigRoot,
  keybindingsFile = ensureTuiKeybindingsFile,
  keybindingsLoader = loadTuiKeybindings,
  keybindingsEditor = openTuiEditorFile,
  suspendProcess = suspendTuiProcess,
  clipboardReader = readTuiClipboard,
  clipboardWriter = writeTuiClipboard,
  permissionRuleStore,
  workspaceDirectoryResolver = resolveTuiWorkspaceDirectory,
  workspaceDirectoryCompleter = completeTuiWorkspaceDirectory,
}: InteractiveAppProps) {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp()
  const width = useTerminalWidth(terminalWidth)
  const keybindingsRoot = useMemo(
    () =>
      resolve(
        keybindingsConfigRoot ??
          process.env.CLAUDE_CONFIG_DIR ??
          resolve(homedir(), '.claude'),
      ),
    [keybindingsConfigRoot],
  )
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
        remove: removeTuiPermissionRule,
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
  const composerImagesRef = useRef(new Map<number, ModelImage>())
  const nextImageIdRef = useRef(1)
  const clipboardQueueRef = useRef(Promise.resolve())
  const clipboardPendingRef = useRef(0)
  const componentMountedRef = useRef(true)
  const [clipboardBusy, setClipboardBusy] = useState(false)
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
  const [externalEditorRequest, setExternalEditorRequest] = useState<{
    prompt: string
  } | null>(null)
  const [keybindingsEditing, setKeybindingsEditing] = useState(false)
  const [keybindings, setKeybindings] = useState(defaultTuiKeybindings)
  const keySequenceRef = useRef<{ chord: string; at: number } | null>(null)
  const [processSuspendRequested, setProcessSuspendRequested] = useState(false)
  const processSuspendRequestedRef = useRef(false)
  const [editorFooterMessage, setEditorFooterMessage] = useState<{
    text: string
    isError: boolean
  }>()
  const [availableSlashCommands, setAvailableSlashCommands] =
    useState(slashCommands)
  const [availableAgents, setAvailableAgents] = useState(agents)
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
  const [history, setHistory] = useState<TranscriptItem[]>([...initialHistory])
  const sessionLoadRef = useRef(0)
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
      additionalDirectories: [...new Set(additionalDirectories)],
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
  const shellMode = input.startsWith('!')
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
  const matchingMentionEntries = useMemo(
    () =>
      fileEntries === null || fileReference === null
        ? []
        : filterTuiMentionEntries(
            fileEntries,
            availableAgents,
            fileReference.query,
          ),
    [availableAgents, fileEntries, fileReference?.query],
  )
  const filePickerVisible =
    !busy &&
    !permission &&
    !planApproval &&
    !question &&
    !elicitation &&
    !selectingSession &&
    filePickerOpen &&
    !shellMode &&
    fileReference !== null
  const selectedFileIndex = Math.min(
    fileSelection,
    Math.max(0, matchingMentionEntries.length - 1),
  )
  const hasThinking =
    activeThinking.length > 0 ||
    history.some((item) => item.kind === 'thinking')
  const hasDetailedTranscript =
    hasThinking ||
    history.some((item) => item.kind === 'tool' || item.kind === 'shell')
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
  const workspaceDirectories = [
    display.cwd,
    ...runtimePreferences.additionalDirectories.filter(
      (path) => path !== display.cwd,
    ),
  ].map((path) => ({ path, original: path === display.cwd }))
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
    setAvailableAgents(agents)
  }, [agents])

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
      componentMountedRef.current = false
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

  useEffect(() => {
    let cancelled = false
    void keybindingsLoader(keybindingsRoot).then(
      (loaded) => {
        if (!cancelled) setKeybindings(loaded)
      },
      (error: unknown) => {
        if (!cancelled)
          append({
            kind: 'warning',
            text: error instanceof Error ? error.message : String(error),
          })
      },
    )
    return () => {
      cancelled = true
    }
  }, [keybindingsRoot, keybindingsLoader])

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

  const promptImages = (prompt: string): readonly ModelImage[] => {
    const seen = new Set<number>()
    return composerImageIds(prompt).flatMap((id) => {
      if (seen.has(id)) return []
      seen.add(id)
      const image = composerImagesRef.current.get(id)
      return image ? [image] : []
    })
  }

  const pasteClipboard = () => {
    clipboardPendingRef.current += 1
    setClipboardBusy(true)
    const paste = clipboardQueueRef.current.then(async () => {
      if (!componentMountedRef.current) return
      const content = await clipboardReader()
      if (!componentMountedRef.current) return
      if (content.kind === 'text') {
        updateComposerEditor(
          insertComposerText(
            createComposerEditor(inputRef.current, inputCursorRef.current),
            content.text,
          ),
        )
      } else if (content.kind === 'image') {
        const id = nextImageIdRef.current
        nextImageIdRef.current += 1
        composerImagesRef.current.set(id, content.image)
        updateComposerEditor(
          insertComposerImageMarker(
            createComposerEditor(inputRef.current, inputCursorRef.current),
            id,
          ),
        )
      }
    })
    clipboardQueueRef.current = paste.catch(() => undefined)
    void paste
      .catch((error: unknown) => {
        if (!componentMountedRef.current) return
        setEditorFooterMessage({
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        })
      })
      .finally(() => {
        clipboardPendingRef.current -= 1
        if (componentMountedRef.current && clipboardPendingRef.current === 0)
          setClipboardBusy(false)
      })
  }

  useEffect(() => {
    if (externalEditorRequest === null) return
    const editing = (async () => {
      try {
        await waitUntilRenderFlush()
        let result: TuiEditorResult | undefined
        await suspendTerminal(async () => {
          result = await externalEditor(externalEditorRequest.prompt, {
            cwd: display.cwd,
            ...(signal === undefined ? {} : { signal }),
          })
        })
        if (!result) throw new Error('External editor returned no content')
        updateComposerEditor(createComposerEditor(result.content))
        setEditorFooterMessage({
          text: `ctrl+g to edit in ${result.editorName}`,
          isError: false,
        })
      } catch (error) {
        setEditorFooterMessage({
          text: error instanceof Error ? error.message : String(error),
          isError: true,
        })
      } finally {
        setExternalEditorRequest(null)
      }
    })()
    onTurnChange?.(editing)
    void editing.finally(() => onTurnChange?.(null))
  }, [externalEditorRequest])

  useEffect(() => {
    if (!keybindingsEditing) return
    const editing = (async () => {
      try {
        const file = await keybindingsFile(keybindingsRoot)
        await waitUntilRenderFlush()
        await suspendTerminal(async () => {
          await keybindingsEditor(file.path, {
            cwd: display.cwd,
            ...(signal === undefined ? {} : { signal }),
          })
        })
        append({
          kind: 'local-result',
          text: file.created
            ? `Created ${file.path} with template. Opened in your editor.`
            : `Opened ${file.path} in your editor.`,
        })
        try {
          setKeybindings(await keybindingsLoader(keybindingsRoot))
        } catch (error) {
          append({
            kind: 'warning',
            text: error instanceof Error ? error.message : String(error),
          })
        }
      } catch (error) {
        append({
          kind: 'warning',
          text: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setKeybindingsEditing(false)
      }
    })()
    onTurnChange?.(editing)
    void editing.finally(() => onTurnChange?.(null))
  }, [keybindingsEditing])

  useEffect(() => {
    if (!processSuspendRequested) return
    void (async () => {
      try {
        await waitUntilRenderFlush()
        await suspendTerminal(suspendProcess)
      } catch (error) {
        append({
          kind: 'warning',
          text: error instanceof Error ? error.message : String(error),
        })
      } finally {
        processSuspendRequestedRef.current = false
        setProcessSuspendRequested(false)
      }
    })()
  }, [processSuspendRequested])

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
      Math.min(current, Math.max(0, matchingMentionEntries.length - 1)),
    )
  }, [matchingMentionEntries.length])

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
      case 'shell-command':
        append({
          kind: 'shell',
          callId: event.callId,
          command: redactSensitiveText(event.command, sensitiveValues),
        })
        break
      case 'shell-result':
        append({
          kind: 'shell-result',
          callId: event.callId,
          stdout: redactSensitiveText(event.stdout, sensitiveValues),
          stderr: redactSensitiveText(event.stderr, sensitiveValues),
          isError: event.isError,
        })
        break
      case 'shell-cancelled':
        setHistory((current) =>
          current.filter(
            (item) =>
              !(
                (item.kind === 'shell' || item.kind === 'shell-result') &&
                item.callId === event.callId
              ),
          ),
        )
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
          additionalDirectories: preferences.additionalDirectories,
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
      setAvailableAgents(created.agentDefinitions?.() ?? agents)
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

  const openSession = (nextSessionId: string | null) => {
    setSessionId(nextSessionId)
    const loadId = sessionLoadRef.current + 1
    sessionLoadRef.current = loadId
    if (nextSessionId === null) {
      setHistory([])
      return
    }
    const loading = (async () => {
      try {
        const commands = await service()
        const transcript = await commands.transcript?.(nextSessionId)
        if (sessionLoadRef.current === loadId) {
          setHistory(transcript ? [...transcript] : [])
        }
      } catch (error) {
        if (sessionLoadRef.current === loadId) warn(error)
      }
    })()
    onTurnChange?.(loading)
    void loading.finally(() => onTurnChange?.(null))
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

  const openWorkspaceDirectoryInput = () => {
    const loading = (async () => {
      setBusy(true)
      try {
        updateMenu({
          kind: 'workspace-directory-input',
          rules: await permissionStore.load(),
          returnToPermissions: false,
        })
      } catch (error) {
        warn(error)
      } finally {
        setBusy(false)
      }
    })()
    onTurnChange?.(loading)
    void loading.finally(() => onTurnChange?.(null))
  }

  const copyResponse = (position: number) => {
    const response = [...history]
      .reverse()
      .filter(
        (item): item is TranscriptItem & { kind: 'assistant'; text: string } =>
          item.kind === 'assistant',
      )[position - 1]
    if (!response) {
      append({
        kind: 'warning',
        text: `No ${position === 1 ? '' : `${ordinal(position)}-latest `}response to copy.`,
      })
      return
    }
    const copying = clipboardWriter(response.text).then(
      () =>
        append({
          kind: 'local-result',
          text: `Copied ${position === 1 ? 'last' : `${ordinal(position)}-latest`} response to clipboard.`,
        }),
      (error: unknown) => warn(error),
    )
    onTurnChange?.(copying)
    void copying.finally(() => onTurnChange?.(null))
  }

  const reloadExtensions = (kind: 'plugins' | 'skills') => {
    const loading = (async () => {
      setBusy(true)
      setStatus(`reloading ${kind}`)
      try {
        await retireService()
        await service()
        append({
          kind: 'local-result',
          text: `${kind === 'plugins' ? 'Plugin changes activated' : 'Skills reloaded'} for this session.`,
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

  const openMcpServers = () => {
    const loading = (async () => {
      setBusy(true)
      setStatus('loading MCP servers')
      try {
        const servers = (await service()).runtimeInfo?.().mcpServers ?? []
        updateMenu({
          kind: 'list',
          title: 'MCP servers',
          rows: servers.map((server) => ({
            label: server.name,
            description: server.status,
          })),
          emptyText: 'No MCP servers configured',
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

  const submit = async (
    prompt: string,
    shellCommand?: string,
    images: readonly ModelImage[] = [],
  ) => {
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
    if (shellCommand === undefined) append({ kind: 'user', text: prompt })
    else turnMutatedFilesRef.current = true
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
      const result =
        shellCommand === undefined
          ? activeSessionId
            ? await commands.resume(
                activeSessionId,
                prompt,
                turnSignal,
                undefined,
                images,
              )
            : await commands.run(
                prompt,
                turnSignal,
                undefined,
                undefined,
                images,
              )
          : activeSessionId
            ? commands.resumeShell
              ? await commands.resumeShell(
                  activeSessionId,
                  shellCommand,
                  turnSignal,
                )
              : (() => {
                  throw new Error('Interactive shell mode is unavailable')
                })()
            : commands.runShell
              ? await commands.runShell(shellCommand, turnSignal)
              : (() => {
                  throw new Error('Interactive shell mode is unavailable')
                })()
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
        if (shellCommand !== undefined) updateComposerInput(`!${shellCommand}`)
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
            : moveComposerCursorAcrossImages(editor(), -1),
        )
        return true
      }
      if (key.rightArrow) {
        updateComposerEditor(
          key.meta
            ? moveComposerCursorByWord(editor(), 'forward')
            : moveComposerCursorAcrossImages(editor(), 1),
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
        updateComposerEditor(moveComposerCursorAcrossImages(editor(), -1))
        return true
      }
      if (controlKey('f')) {
        updateComposerEditor(moveComposerCursorAcrossImages(editor(), 1))
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
        updateComposerEditor(deleteComposerImageBackward(editor()))
        return true
      }
      if (key.delete) {
        updateComposerEditor(deleteComposerImageForward(editor()))
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
    if (controlKey('z')) {
      if (!processSuspendRequestedRef.current) {
        processSuspendRequestedRef.current = true
        setProcessSuspendRequested(true)
      }
      return
    }
    dismissExitConfirmation()

    const keybindingContexts = menuRef.current
      ? menuRef.current.kind === 'diff'
        ? ['DiffDialog']
        : menuRef.current.kind === 'help'
          ? ['Help', 'Tabs']
          : menuRef.current.kind === 'permission-dashboard'
            ? ['Settings', 'Tabs']
            : menuRef.current.kind === 'model'
              ? ['ModelPicker', 'Select']
              : ['Select']
      : commandPaletteVisible || filePickerVisible
        ? ['Autocomplete', 'Chat']
        : permission || planApproval
          ? ['Confirmation']
          : selectingSession
            ? ['Select']
            : ['Chat']
    const inputChord = tuiKeyChord(value, key)
    const pendingSequence = keySequenceRef.current
    let keybindingAction: string | undefined
    if (
      inputChord &&
      pendingSequence &&
      Date.now() - pendingSequence.at <= 1_000
    ) {
      keybindingAction = resolveTuiKeybinding(
        keybindings,
        keybindingContexts,
        `${pendingSequence.chord} ${inputChord}`,
      )
      keySequenceRef.current = null
    } else {
      keySequenceRef.current = null
    }
    if (!keybindingAction) {
      keybindingAction = resolveTuiKeybinding(
        keybindings,
        keybindingContexts,
        inputChord,
      )
    }
    if (
      !keybindingAction &&
      inputChord &&
      hasTuiKeybindingPrefix(keybindings, keybindingContexts, inputChord)
    ) {
      keySequenceRef.current = { chord: inputChord, at: Date.now() }
      return
    }
    const isKeybinding = (action: string) => keybindingAction === action

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
        openSession(selected?.sessionId ?? null)
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

    if (externalEditorRequest !== null || keybindingsEditing) return

    if (clipboardPendingRef.current > 0) {
      if (isKeybinding('chat:imagePaste')) pasteClipboard()
      return
    }

    if (
      !busy &&
      !permission &&
      !planApproval &&
      !question &&
      !elicitation &&
      !menuRef.current &&
      isKeybinding('chat:externalEditor')
    ) {
      setCommandPaletteOpen(false)
      setFilePickerOpen(false)
      setShortcutsVisible(false)
      setExternalEditorRequest({ prompt: inputRef.current })
      return
    }

    if (!busy && isKeybinding('app:toggleTodos')) {
      openTasks()
      return
    }
    if (!busy && isKeybinding('chat:modelPicker')) {
      updateMenu({ kind: 'model', selectedIndex: 0 })
      return
    }
    if (!busy && isKeybinding('chat:stash')) {
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
          updateMenu({
            kind: 'permission-dashboard',
            tabIndex: 1,
            selectedIndex: -1,
            query: '',
            rules: activeMenu.rules,
          })
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
              rules: activeMenu.rules,
              selectedIndex: 0,
            })
          }
        } else {
          editComposer()
        }
        return
      }

      if (activeMenu.kind === 'workspace-directory-input') {
        if (key.escape || value === '\u001B') {
          clearComposerInput()
          if (activeMenu.returnToPermissions === false) {
            updateMenu(null)
            append({
              kind: 'local-result',
              text: 'Did not add a working directory.',
            })
          } else {
            updateMenu({
              kind: 'permission-dashboard',
              tabIndex: 1,
              selectedIndex: -1,
              query: '',
              rules: activeMenu.rules,
            })
          }
        } else if (key.tab) {
          const completion = (async () => {
            try {
              updateComposerInput(
                await workspaceDirectoryCompleter(
                  inputRef.current,
                  display.cwd,
                ),
              )
            } catch (error) {
              warn(error)
            }
          })()
          onTurnChange?.(completion)
          void completion.finally(() => onTurnChange?.(null))
        } else if (key.return) {
          const addition = (async () => {
            setBusy(true)
            try {
              const path = await workspaceDirectoryResolver(
                inputRef.current,
                display.cwd,
              )
              clearComposerInput()
              if (path !== display.cwd) {
                updateRuntimePreferences((current) => ({
                  ...current,
                  additionalDirectories: [
                    ...new Set([...current.additionalDirectories, path]),
                  ],
                }))
                await retireService()
              }
              const rules = await permissionStore.load()
              if (activeMenu.returnToPermissions === false) {
                updateMenu(null)
                append({
                  kind: 'local-result',
                  text: `Added ${path} as a working directory.`,
                })
              } else {
                updateMenu({
                  kind: 'permission-dashboard',
                  tabIndex: 1,
                  selectedIndex: -1,
                  query: '',
                  rules,
                })
              }
            } catch (error) {
              warn(error)
            } finally {
              setBusy(false)
            }
          })()
          onTurnChange?.(addition)
          void addition.finally(() => onTurnChange?.(null))
        } else {
          editComposer()
        }
        return
      }

      if (activeMenu.kind === 'workspace-directory-delete') {
        if (key.escape || value === '\u001B') {
          updateMenu({
            kind: 'permission-dashboard',
            tabIndex: 1,
            selectedIndex: -1,
            query: '',
            rules: activeMenu.rules,
          })
          return
        }
        if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: key.upArrow ? 0 : 1,
          })
          return
        }
        const confirmed =
          (key.return && activeMenu.selectedIndex === 0) ||
          value.toLowerCase() === 'y' ||
          value === '1'
        const declined =
          (key.return && activeMenu.selectedIndex === 1) ||
          value.toLowerCase() === 'n' ||
          value === '2'
        if (!confirmed && !declined) return
        if (confirmed) {
          updateRuntimePreferences((current) => ({
            ...current,
            additionalDirectories: current.additionalDirectories.filter(
              (path) => path !== activeMenu.path,
            ),
          }))
          void retireService()
        }
        updateMenu({
          kind: 'permission-dashboard',
          tabIndex: 1,
          selectedIndex: -1,
          query: '',
          rules: activeMenu.rules,
        })
        return
      }

      if (activeMenu.kind === 'permission-delete') {
        if (key.escape || value === '\u001B') {
          updateMenu({
            kind: 'permission-dashboard',
            tabIndex: 1,
            selectedIndex: -1,
            query: '',
            rules: activeMenu.rules,
          })
          return
        }
        if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: key.upArrow ? 0 : 1,
          })
          return
        }
        const confirmed =
          (key.return && activeMenu.selectedIndex === 0) ||
          value.toLowerCase() === 'y' ||
          value === '1'
        const declined =
          (key.return && activeMenu.selectedIndex === 1) ||
          value.toLowerCase() === 'n' ||
          value === '2'
        if (!confirmed && !declined) return
        if (declined) {
          updateMenu({
            kind: 'permission-dashboard',
            tabIndex: 1,
            selectedIndex: -1,
            query: '',
            rules: activeMenu.rules,
          })
          return
        }
        const removal = (async () => {
          setBusy(true)
          try {
            if (!permissionStore.remove)
              throw new Error('Permission rule removal is unavailable.')
            await permissionStore.remove(activeMenu.rule)
            await retireService()
            const rules = await permissionStore.load()
            updateMenu({
              kind: 'permission-dashboard',
              tabIndex: 1,
              selectedIndex: -1,
              query: '',
              rules,
            })
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(removal)
        void removal.finally(() => onTurnChange?.(null))
        return
      }

      if (activeMenu.kind === 'permission-scope') {
        if (key.escape || value === '\u001B') {
          updateMenu({
            kind: 'permission-dashboard',
            tabIndex: 1,
            selectedIndex: -1,
            query: '',
            rules: activeMenu.rules,
          })
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
                tabIndex: 1,
                selectedIndex: -1,
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
            selectedIndex: -1,
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
              ? runtimePreferences.additionalDirectories.length + 1
              : matchingRules.length + 1
        if (key.upArrow || key.downArrow) {
          if (rowCount === 0) return
          const nextIndex =
            activeMenu.selectedIndex < 0
              ? key.downArrow
                ? 0
                : -1
              : activeMenu.selectedIndex + (key.upArrow ? -1 : 1)
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              -1,
              Math.min(Math.max(0, rowCount - 1), nextIndex),
            ),
          })
        } else if (key.backspace || key.delete) {
          updateMenu({
            ...activeMenu,
            query: activeMenu.query.slice(0, -1),
            selectedIndex: -1,
          })
        } else if (behavior && !key.ctrl && !key.meta && value && printable) {
          updateMenu({
            ...activeMenu,
            query: activeMenu.query + value,
            selectedIndex: -1,
          })
        } else if (key.return && behavior && activeMenu.selectedIndex === 0) {
          clearComposerInput()
          updateMenu({
            kind: 'permission-rule-input',
            behavior,
            rules: activeMenu.rules,
          })
        } else if (key.return && behavior && activeMenu.selectedIndex > 0) {
          const rule = matchingRules[activeMenu.selectedIndex - 1]
          if (rule)
            updateMenu({
              kind: 'permission-delete',
              rule,
              rules: activeMenu.rules,
              selectedIndex: 0,
            })
        } else if (
          key.return &&
          activeMenu.tabIndex === 4 &&
          activeMenu.selectedIndex >= 0
        ) {
          const path =
            runtimePreferences.additionalDirectories[activeMenu.selectedIndex]
          if (path) {
            updateMenu({
              kind: 'workspace-directory-delete',
              path,
              rules: activeMenu.rules,
              selectedIndex: 0,
            })
          } else if (
            activeMenu.selectedIndex ===
            runtimePreferences.additionalDirectories.length
          ) {
            clearComposerInput()
            updateMenu({
              kind: 'workspace-directory-input',
              rules: activeMenu.rules,
            })
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
    if (isKeybinding('app:toggleTranscript') && hasDetailedTranscript) {
      setThinkingExpanded((current) => !current)
      return
    }
    if (busy) {
      if (isKeybinding('chat:cancel')) turnControllerRef.current?.abort()
      return
    }
    if (isKeybinding('chat:imagePaste')) {
      pasteClipboard()
      return
    }
    if (isKeybinding('chat:undo')) {
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
          Math.min(matchingMentionEntries.length - 1, current + 1),
        )
        return
      }
      const selected = matchingMentionEntries[selectedFileIndex]
      if (selected && (key.tab || key.return) && fileReference) {
        updateComposerEditor(
          applyMentionReference(
            inputRef.current,
            inputCursorRef.current,
            fileReference,
            selected,
          ),
        )
        setFilePickerOpen(false)
        return
      }
      if (key.tab) return
    }
    if (isKeybinding('chat:cancel')) {
      const now = Date.now()
      if (now - lastEscapeAtRef.current <= 500) clearComposerInput()
      lastEscapeAtRef.current = now
      return
    }
    if (isKeybinding('chat:cycleMode')) {
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
    const implicitShiftNewline =
      key.return && key.shift && keybindingAction === undefined
    if (
      isKeybinding('chat:submit') ||
      isKeybinding('chat:newline') ||
      implicitShiftNewline
    ) {
      if (isKeybinding('chat:newline') || implicitShiftNewline) {
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
      const images = promptImages(prompt)
      clearComposerInput()
      undoStackRef.current = []
      composerImagesRef.current.clear()
      if (!prompt || prompt === '!') return
      const copyCommand = /^\/copy(?:\s+(\d+))?$/u.exec(prompt)
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
      } else if (prompt === '/keybindings') {
        setKeybindingsEditing(true)
      } else if (prompt === '/add-dir') {
        openWorkspaceDirectoryInput()
      } else if (prompt === '/permissions') {
        const loading = (async () => {
          setBusy(true)
          try {
            updateMenu({
              kind: 'permission-dashboard',
              tabIndex: 1,
              selectedIndex: -1,
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
      } else if (prompt === '/config') {
        updateMenu({ kind: 'status', tabIndex: 2 })
      } else if (prompt === '/usage') {
        updateMenu({ kind: 'status', tabIndex: 3 })
      } else if (prompt === '/skills' || prompt === '/skill') {
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
      } else if (prompt === '/mcp') {
        openMcpServers()
      } else if (prompt === '/reload-plugins') {
        reloadExtensions('plugins')
      } else if (prompt === '/reload-skills') {
        reloadExtensions('skills')
      } else if (copyCommand) {
        const ordinal = Number(copyCommand[1] ?? 1)
        if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
          append({ kind: 'warning', text: 'Usage: /copy [positive number]' })
        } else {
          copyResponse(ordinal)
        }
      } else if (prompt === '/plan') {
        changePermissionMode('plan')
      } else if (prompt.startsWith('!')) {
        const command = prompt.slice(1).trim()
        const turn = submit(`! ${command}`, command)
        onTurnChange?.(turn)
        void turn.then(
          () => onTurnChange?.(null),
          () => onTurnChange?.(null),
        )
      } else {
        const turn = submit(prompt, undefined, images)
        onTurnChange?.(turn)
        void turn.then(
          () => onTurnChange?.(null),
          () => onTurnChange?.(null),
        )
      }
      return
    }
    if (isKeybinding('history:previous')) {
      restorePromptHistory('previous')
      return
    }
    if (isKeybinding('history:next')) {
      restorePromptHistory('next')
      return
    }
    if (isKeybinding('chat:clearInput')) {
      clearComposerInput()
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
          {externalEditorRequest !== null || keybindingsEditing ? (
            <ExternalEditorWait screenReader={axScreenReader} />
          ) : permission ? (
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
            <Box flexDirection="column">
              <Text bold>Add {menu.behavior} permission rule</Text>
              <Text>
                Permission rules are a tool name, optionally followed by a
                specifier in parentheses.
              </Text>
              <Text>e.g., WebFetch or Bash(ls *)</Text>
              <Text> </Text>
              <Box
                borderStyle={axScreenReader ? undefined : 'round'}
                paddingX={axScreenReader ? 0 : 1}
              >
                <Text {...(input ? {} : { dimColor: true })}>
                  {input || 'Enter permission rule…'}
                </Text>
              </Box>
              <Text dimColor>Enter to submit · Esc to cancel</Text>
            </Box>
          ) : menu?.kind === 'workspace-directory-input' ? (
            <Box flexDirection="column">
              <Text bold>Add directory to workspace</Text>
              <Text>
                Praxis Code will be able to read files in this directory and
                make edits when auto-accept edits is on.
              </Text>
              <Text> </Text>
              <Text>Enter the path to the directory:</Text>
              <Box
                borderStyle={axScreenReader ? undefined : 'round'}
                paddingX={axScreenReader ? 0 : 1}
              >
                <Text {...(input ? {} : { dimColor: true })}>
                  {input || 'Directory path…'}
                </Text>
              </Box>
              <Text dimColor>
                Tab to complete · Enter to add · Esc to cancel
              </Text>
            </Box>
          ) : menu?.kind === 'permission-delete' ? (
            <DialogFrame
              title={permissionDeleteTitle(menu.rule.behavior)}
              screenReader={axScreenReader}
            >
              <Text>{menu.rule.rule}</Text>
              {permissionRuleDescription(menu.rule.rule) ? (
                <Text dimColor>
                  {permissionRuleDescription(menu.rule.rule)}
                </Text>
              ) : null}
              <Text dimColor>{permissionScopeLabel(menu.rule.scope)}</Text>
              <Text> </Text>
              <Text>Are you sure you want to delete this permission rule?</Text>
              <Text> </Text>
              <Text inverse={menu.selectedIndex === 0}>
                {menu.selectedIndex === 0 ? '❯ ' : '  '}1. Yes
              </Text>
              <Text inverse={menu.selectedIndex === 1}>
                {menu.selectedIndex === 1 ? '❯ ' : '  '}2. No
              </Text>
              <Text dimColor>Esc to cancel</Text>
            </DialogFrame>
          ) : menu?.kind === 'workspace-directory-delete' ? (
            <Box flexDirection="column">
              <Text bold>Remove directory from workspace?</Text>
              <Text> {menu.path}</Text>
              <Text> </Text>
              <Text>
                Praxis Code will no longer have access to files in this
                directory.
              </Text>
              <Text> </Text>
              <Text inverse={menu.selectedIndex === 0}>
                {menu.selectedIndex === 0 ? '❯ ' : '  '}1. Yes
              </Text>
              <Text inverse={menu.selectedIndex === 1}>
                {menu.selectedIndex === 1 ? '❯ ' : '  '}2. No
              </Text>
              <Text dimColor>Enter to confirm · Esc to cancel</Text>
            </Box>
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
                workspaceDirectories={workspaceDirectories}
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu.kind === 'permission-scope' ? (
              <SelectionMenu
                title="Where should this rule be saved?"
                description={`${menu.rule}${
                  permissionRuleDescription(menu.rule)
                    ? ` · ${permissionRuleDescription(menu.rule)}`
                    : ''
                }`}
                options={[
                  {
                    label: 'Project settings (local)',
                    description: 'Saved in .claude/settings.local.json',
                  },
                  {
                    label: 'Project settings',
                    description: 'Checked in at .claude/settings.json',
                  },
                  {
                    label: 'User settings',
                    description: 'Saved in at ~/.claude/settings.json',
                  },
                ]}
                selectedIndex={menu.selectedIndex}
                footer="Enter to confirm · Esc to cancel"
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
                <MentionPicker
                  entries={matchingMentionEntries}
                  selectedIndex={selectedFileIndex}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : null}
              {exitConfirmation ? (
                <Text color="yellow">Press Ctrl-C again to exit</Text>
              ) : null}
              <Composer
                input={shellMode ? input.slice(1) : input}
                cursor={shellMode ? Math.max(0, inputCursor - 1) : inputCursor}
                shellMode={shellMode}
                busy={busy}
                clipboardBusy={clipboardBusy}
                status={status}
                display={runtimeDisplay}
                {...(usage === undefined ? {} : { usage })}
                {...(costUsd === undefined ? {} : { costUsd })}
                width={width}
                screenReader={axScreenReader}
                hasThinking={hasDetailedTranscript}
                thinkingExpanded={thinkingExpanded}
                shortcutsVisible={shortcutsVisible}
                {...(editorFooterMessage === undefined
                  ? {}
                  : { footerMessage: editorFooterMessage })}
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
  additionalDirectories?: readonly string[]
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
  let initialAgents: readonly TuiAgentEntry[]
  try {
    const sessions = await listing.sessions()
    initialSessions = options.sessionFilter
      ? sessions.filter(options.sessionFilter)
      : sessions
    initialSlashCommands = listing.slashCommands?.() ?? []
    initialAgents = listing.agentDefinitions?.() ?? []
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
  let initialHistory: readonly TranscriptItem[] = []
  try {
    initialHistory =
      resume?.sessionId === undefined || listing.transcript === undefined
        ? []
        : await listing.transcript(resume.sessionId)
  } catch (error) {
    try {
      await listing.close?.()
    } catch {
      // Preserve the transcript-loading failure as the primary error.
    }
    throw error
  }
  await listing.close?.()
  let activeTurn: Promise<void> | null = null
  let cleanup: Promise<void> | null = null
  const instance = render(
    <InteractiveApp
      factory={options.factory}
      initialSessions={initialSessions}
      slashCommands={initialSlashCommands}
      agents={initialAgents}
      initialHistory={initialHistory}
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
      {...(options.additionalDirectories === undefined
        ? {}
        : { additionalDirectories: options.additionalDirectories })}
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
