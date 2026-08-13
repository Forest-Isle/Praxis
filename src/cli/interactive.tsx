import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { useEffect, useMemo, useRef, useState } from 'react'

import { Box, Text, render, useApp, useInput } from 'ink'

import type {
  ForkResult,
  ManualCompactResult,
  ManualCompactSelection,
  RewindPoint,
  SessionForkCheckpoint,
  SessionRunResult,
  SessionSummary,
  SideQuestionForkResult,
  SideQuestionResult,
} from '../application/session-service.js'
import type {
  ModelImage,
  ModelToolCall,
  ModelUsage,
  RuntimeEvent,
  RuntimeEventSink,
} from '../core/runtime.js'
import { AgentRunCancelledError } from '../core/runtime.js'
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
  BtwPanel,
  Composer,
  DiffDashboard,
  DialogFrame,
  ExternalEditorWait,
  HelpMenu,
  HookDashboard,
  ListDashboard,
  MemoryDashboard,
  MentionPicker,
  PermissionDashboard,
  SelectionMenu,
  SessionPicker,
  StatusDashboard,
  ThemePicker,
  Transcript,
  WelcomePanel,
  useTerminalWidth,
  type TranscriptItem,
  type TuiBtwEntry,
  type TuiDisplayMetadata,
} from './tui/claude-style.js'
import {
  loadTuiMemoryFiles,
  openTuiMemoryFolder,
  type TuiMemoryFileEntry,
  type TuiMemoryFiles,
} from './tui/memory-files.js'
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
import type { TuiHookConfiguration } from './tui/hook-settings.js'
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
  writeTuiOsc52Clipboard,
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
import {
  conversationExportPath,
  conversationExportText,
  defaultConversationExportFilename,
  writeConversationExport,
} from './tui/conversation-export.js'
import {
  loadTuiThemeSettings,
  saveTuiThemeSettings,
} from './tui/theme-settings.js'
import {
  DEFAULT_TUI_THEME_SETTINGS,
  TUI_THEMES,
  TuiThemeProvider,
  tuiPalette,
  type TuiThemeSettings,
} from './tui/theme.js'
import {
  setupTuiTerminal,
  terminalSetupTuiSlashCommand,
} from './tui/terminal-setup.js'
import { ConfigDashboard, projectConfigRows } from './tui/config-dashboard.js'
import {
  loadConfigSettings,
  saveConfigSetting,
  configSettingDefinition,
} from './tui/config-settings.js'
import { McpPanel } from './tui/mcp-panel.js'
import {
  McpPanelController,
  mcpRuntimeFromSession,
} from './tui/mcp-panel-controller.js'
import {
  initialTuiMcpPanelState,
  type TuiMcpPanelModel,
  type TuiMcpPanelState,
} from './tui/mcp-panel-projector.js'
import type {
  ClaudeMcpServerStatus,
  ClaudeMcpToolInspection,
} from '../mcp/claude-mcp-tools.js'
import type { ConfigDashboardTab } from './tui/config-dashboard.js'
import type { ConfigValue } from './tui/config-settings.js'
import {
  TaskPanel,
  initialTuiTaskPanelState,
  projectTuiTasks,
  reconcileTuiTaskPanelState,
  updateTuiTaskPanelState,
  type TuiTaskEntry,
  type TuiTaskPanelState,
} from './tui/task-panel.js'
import type { BackgroundTaskSnapshot } from '../application/background-task-runtime.js'
import { ClaudeMcpManagement } from '../mcp/claude-mcp-management.js'

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
  fork(
    sessionId: string,
    targetSessionId?: string,
    resumeSessionAt?: string,
  ): Promise<ForkResult>
  sessions(): Promise<SessionSummary[]>
  transcript?(sessionId: string): Promise<TranscriptItem[]>
  compact?(
    sessionId: string,
    signal?: AbortSignal,
    selection?: ManualCompactSelection,
  ): Promise<ManualCompactResult>
  rewindFiles?(sessionId: string, userMessageId: string): Promise<void>
  rewindPoints?(sessionId: string): Promise<RewindPoint[]>
  changeCwd?(sessionId: string | undefined, cwd: string): Promise<string>
  recordCdUsage?(sessionId: string): Promise<void>
  answerSideQuestion?(
    sessionId: string | undefined,
    question: string,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
    permissionMode?: ClaudePermissionMode,
  ): Promise<SideQuestionResult>
  recordBtwUsage?(
    sessionId: string | undefined,
    permissionMode?: ClaudePermissionMode,
  ): Promise<string>
  recordBackgroundUsage?(
    sessionId: string | undefined,
    permissionMode?: ClaudePermissionMode,
  ): Promise<string>
  recordBackgroundLaunch?(sessionId: string): Promise<SessionForkCheckpoint>
  forkSideQuestion?(
    sessionId: string,
    question: string,
    signal?: AbortSignal,
  ): Promise<SideQuestionForkResult>
  rename?(sessionId: string, name: string): Promise<void>
  sessionNameSuggestion?(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null>
  workflows?(): readonly Record<string, unknown>[]
  taskSnapshots?(sessionId: string): Promise<BackgroundTaskSnapshot>
  stopTask?(sessionId: string, taskId: string): Promise<void>
  mcpInspect?(): Promise<readonly ClaudeMcpServerStatus[]>
  mcpReconnect?(name: string): Promise<void>
  mcpAuthenticate?(name: string): Promise<void>
  mcpReload?(): Promise<void>
  mcpTools?(name: string): Promise<readonly ClaudeMcpToolInspection[]>
  hookConfiguration?(): Promise<TuiHookConfiguration>
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
    hooksOnly?: boolean
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
    cwd?: string
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

export interface InteractiveBackgroundRequest {
  sourceSessionId: string
  sourceCheckpoint: SessionForkCheckpoint
  prompt: string
  detail: string
  cwd: string
}

export interface InteractiveBackgroundResult {
  id: string
  sessionId: string
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
  onBackground?: (
    request: InteractiveBackgroundRequest,
  ) => Promise<InteractiveBackgroundResult>
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
  memoryFilesLoader?: (
    configRoot: string,
    cwd: string,
  ) => Promise<TuiMemoryFiles>
  memoryEditor?: (
    path: string,
    options: TuiEditorOptions,
  ) => Promise<{ editorName: string }>
  memoryFolderOpener?: (path: string) => Promise<void>
  suspendProcess?: () => void | Promise<void>
  clipboardReader?: () => Promise<TuiClipboardContent>
  clipboardWriter?: (text: string) => Promise<void>
  sideQuestionClipboardWriter?: (text: string) => Promise<void>
  exportWriter?: (path: string, text: string) => Promise<void>
  permissionRuleStore?: {
    load(): Promise<readonly TuiPermissionRule[]>
    add(input: {
      behavior: TuiPermissionBehavior
      rule: string
      scope: ClaudeResourceScope
    }): Promise<void>
    remove?(rule: TuiPermissionRule): Promise<void>
  }
  themeStore?: {
    load(): Promise<TuiThemeSettings>
    save(update: Partial<TuiThemeSettings>): Promise<TuiThemeSettings>
  }
  terminalSetup?: () => Promise<string>
  initialThemeSettings?: TuiThemeSettings
  initialThemeLoadError?: string
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
  | { kind: 'theme'; selectedIndex: number }
  | { kind: 'export'; selectedIndex: number }
  | { kind: 'export-filename' }
  | { kind: 'compact-progress' }
  | { kind: 'btw'; selectedIndex: number; scrollOffset: number }
  | {
      kind: 'rewind'
      points: readonly RewindPoint[]
      selectedIndex: number
    }
  | {
      kind: 'rewind-confirm'
      points: readonly RewindPoint[]
      point: RewindPoint
      selectedIndex: number
    }
  | {
      kind: 'rewind-context'
      points: readonly RewindPoint[]
      point: RewindPoint
      direction: 'from' | 'to'
    }
  | { kind: 'status'; tabIndex: number }
  | {
      kind: 'config'
      snapshot: Awaited<ReturnType<typeof loadConfigSettings>>
      tab: 'settings' | 'status' | 'config' | 'usage' | 'stats'
      selectedIndex: number
      query: string
      searchFocused: boolean
    }
  | { kind: 'mcp'; model: TuiMcpPanelModel; state: TuiMcpPanelState }
  | { kind: 'tasks'; tasks: readonly TuiTaskEntry[]; state: TuiTaskPanelState }
  | {
      kind: 'memory'
      generation: number
      loading: boolean
      autoMemoryEnabled: boolean
      entries: TuiMemoryFiles['entries']
      selectedIndex: number
      openedIndex: number | null
    }
  | {
      kind: 'hooks'
      configuration: TuiHookConfiguration
      depth: 'events' | 'matchers' | 'hooks' | 'detail'
      eventIndex: number
      matcherIndex: number
      hookIndex: number
    }
  | {
      kind: 'list'
      title: string
      rows: readonly { label: string; description?: string }[]
      emptyText: string
      selectedIndex: number
    }

function selectionPrefix(selected: boolean, screenReader: boolean): string {
  if (selected) return screenReader ? 'Selected: ' : '❯ '
  return screenReader ? '' : '  '
}

type RuntimePreferences = {
  model?: string
  effort: (typeof EFFORT_OPTIONS)[number]
  permissionMode: ClaudePermissionMode
  additionalDirectories: readonly string[]
}

type RewindAction =
  | 'code-and-conversation'
  | 'conversation'
  | 'code'
  | 'summarize-from'
  | 'summarize-to'
  | 'cancel'

function rewindActions(point: RewindPoint): readonly {
  action: RewindAction
  label: string
}[] {
  const shared = [
    { action: 'summarize-from' as const, label: 'Summarize from here' },
    { action: 'summarize-to' as const, label: 'Summarize up to here' },
    { action: 'cancel' as const, label: 'Never mind' },
  ]
  return point.fileRestoreAvailable && point.fileChanges.length > 0
    ? [
        {
          action: 'code-and-conversation',
          label: 'Restore code and conversation',
        },
        { action: 'conversation', label: 'Restore conversation' },
        { action: 'code', label: 'Restore code' },
        ...shared,
      ]
    : [{ action: 'conversation', label: 'Restore conversation' }, ...shared]
}

function rewindPointWindow(
  points: readonly RewindPoint[],
  selectedIndex: number,
  size = 6,
): { start: number; end: number } {
  if (points.length <= size) return { start: 0, end: points.length }
  if (selectedIndex >= points.length) {
    return { start: points.length - size, end: points.length }
  }
  const start = Math.max(
    0,
    Math.min(points.length - size, selectedIndex - Math.floor(size / 2)),
  )
  return { start, end: start + size }
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
  onBackground,
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
  memoryFilesLoader = (configRoot, cwd) =>
    loadTuiMemoryFiles({ configRoot, cwd }),
  memoryEditor = openTuiEditorFile,
  memoryFolderOpener = openTuiMemoryFolder,
  suspendProcess = suspendTuiProcess,
  clipboardReader = readTuiClipboard,
  clipboardWriter = writeTuiClipboard,
  sideQuestionClipboardWriter = writeTuiOsc52Clipboard,
  exportWriter = writeConversationExport,
  permissionRuleStore,
  terminalSetup: terminalSetupOverride,
  themeStore,
  initialThemeSettings,
  initialThemeLoadError,
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
  const [runtimeCwd, setRuntimeCwd] = useState(display.cwd)
  const runtimeCwdRef = useRef(display.cwd)
  const loadDiffSnapshot = useMemo(
    () => diffLoader ?? (() => loadGitDiff(runtimeCwd)),
    [diffLoader, runtimeCwd],
  )
  const loadFiles = useMemo(
    () => fileLoader ?? (() => loadTuiFileEntries(runtimeCwd)),
    [fileLoader, runtimeCwd],
  )
  const permissionStore = useMemo(
    () =>
      permissionRuleStore ?? {
        load: () => loadTuiPermissionRules(runtimeCwd),
        add: (input: {
          behavior: TuiPermissionBehavior
          rule: string
          scope: ClaudeResourceScope
        }) => addTuiPermissionRule({ cwd: runtimeCwd, ...input }),
        remove: removeTuiPermissionRule,
      },
    [permissionRuleStore, runtimeCwd],
  )
  const presentationThemeStore = useMemo(
    () =>
      themeStore ?? {
        load: loadTuiThemeSettings,
        save: saveTuiThemeSettings,
      },
    [themeStore],
  )
  const [themeSettings, setThemeSettings] = useState<TuiThemeSettings>(
    initialThemeSettings ?? DEFAULT_TUI_THEME_SETTINGS,
  )
  const activePalette = tuiPalette(
    themeSettings.theme,
    themeSettings.syntaxHighlightingDisabled,
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
  const [memoryEditorRequest, setMemoryEditorRequest] =
    useState<TuiMemoryFileEntry | null>(null)
  const memoryEditorRequestRef = useRef<TuiMemoryFileEntry | null>(null)
  const memoryMenuGenerationRef = useRef(0)
  const memoryFolderOpeningRef = useRef<{
    generation: number
    index: number
  } | null>(null)
  const [keybindings, setKeybindings] = useState(defaultTuiKeybindings)
  const keySequenceRef = useRef<{ chord: string; at: number } | null>(null)
  const [processSuspendRequested, setProcessSuspendRequested] = useState(false)
  const processSuspendRequestedRef = useRef(false)
  const [editorFooterMessage, setEditorFooterMessage] = useState<{
    text: string
    isError: boolean
  }>()
  const terminalSetupCommand = useMemo(
    () => terminalSetupTuiSlashCommand(process.env, process.platform),
    [],
  )
  const [availableSlashCommands, setAvailableSlashCommands] =
    useState(slashCommands)
  const [availableAgents, setAvailableAgents] = useState(agents)
  const [btwHistory, setBtwHistory] = useState<TuiBtwEntry[]>([])
  const btwHistoryRef = useRef<TuiBtwEntry[]>([])
  const btwIdRef = useRef(0)
  const btwControllerRef = useRef<AbortController | null>(null)
  const [btwCopied, setBtwCopied] = useState(false)
  const btwCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [menu, setMenu] = useState<InteractiveMenu | null>(null)
  const menuRef = useRef<InteractiveMenu | null>(null)
  const [busy, setBusy] = useState(false)
  const taskEntriesRef = useRef<readonly TuiTaskEntry[]>([])
  const mcpControllerRef = useRef<McpPanelController | null>(null)
  const [compactProgress, setCompactProgress] = useState(0)
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
    () =>
      mergeTuiSlashCommands([
        ...(terminalSetupCommand === null ? [] : [terminalSetupCommand]),
        ...availableSlashCommands,
      ]),
    [availableSlashCommands, terminalSetupCommand],
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
    history.some(
      (item) =>
        item.kind === 'tool' ||
        item.kind === 'shell' ||
        item.kind === 'compact',
    )
  const selectedSlashCommandIndex = Math.min(
    commandSelection,
    Math.max(0, matchingSlashCommands.length - 1),
  )
  const runtimeDisplay: TuiDisplayMetadata = {
    ...display,
    cwd: runtimeCwd,
    ...(runtimePreferences.model === undefined
      ? {}
      : { model: runtimePreferences.model }),
    effort: runtimePreferences.effort,
    permissionMode: runtimePreferences.permissionMode,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  }
  const workspaceDirectories = [
    runtimeCwd,
    ...runtimePreferences.additionalDirectories.filter(
      (path) => path !== runtimeCwd,
    ),
  ].map((path) => ({ path, original: path === runtimeCwd }))
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
      if (btwCopiedTimerRef.current) clearTimeout(btwCopiedTimerRef.current)
      scheduledWaitRef.current?.abort()
      turnControllerRef.current?.abort()
      btwControllerRef.current?.abort()
      const closing = serviceRef.current?.close?.() ?? Promise.resolve()
      if (onCleanupRef.current) onCleanupRef.current(closing)
      else void closing.catch(() => undefined)
    },
    [],
  )

  const append = (line: TranscriptItem) =>
    setHistory((current) => [...current, line])

  useEffect(() => {
    if (initialThemeSettings !== undefined) {
      if (initialThemeLoadError)
        append({ kind: 'warning', text: initialThemeLoadError })
      return
    }
    let cancelled = false
    void presentationThemeStore.load().then(
      (loaded) => {
        if (!cancelled) setThemeSettings(loaded)
      },
      (error: unknown) => {
        if (!cancelled)
          append({
            kind: 'warning',
            text: `Unable to load theme settings: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
      },
    )
    return () => {
      cancelled = true
    }
  }, [initialThemeLoadError, initialThemeSettings, presentationThemeStore])

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
            cwd: runtimeCwdRef.current,
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
            cwd: runtimeCwdRef.current,
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
    if (memoryEditorRequest === null) return
    const editing = (async () => {
      try {
        await waitUntilRenderFlush()
        let editorName = 'your editor'
        await suspendTerminal(async () => {
          const editor = await memoryEditor(memoryEditorRequest.path, {
            cwd: runtimeCwdRef.current,
            ...(signal === undefined ? {} : { signal }),
          })
          editorName = editor.editorName
        })
        append({
          kind: 'local-result',
          text: `Opened memory file at ${memoryEditorRequest.displayPath}\n\n  ▎ Using ${editorName}. To change editor, set $EDITOR or $VISUAL environment variable.`,
        })
        await retireService()
      } catch (error) {
        warn(error)
      } finally {
        memoryEditorRequestRef.current = null
        setMemoryEditorRequest(null)
      }
    })()
    onTurnChange?.(editing)
    void editing.finally(() => onTurnChange?.(null))
  }, [memoryEditorRequest])

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

  const refreshTasks = async (
    existing?: Extract<InteractiveMenu, { kind: 'tasks' }>,
  ) => {
    const commands = await service()
    if (!sessionId || !commands.taskSnapshots) {
      const rows = workflowRows(commands.workflows?.() ?? [])
      updateMenu({
        kind: 'list',
        title: 'Background',
        rows,
        emptyText: 'No tasks currently running',
        selectedIndex: 0,
      })
      return
    }
    const snapshot = await commands.taskSnapshots(sessionId)
    const tasks = projectTuiTasks(snapshot)
    const state = existing
      ? reconcileTuiTaskPanelState(
          existing.state,
          taskEntriesRef.current,
          tasks,
        )
      : initialTuiTaskPanelState(tasks)
    taskEntriesRef.current = tasks
    updateMenu({ kind: 'tasks', tasks, state })
  }

  const updateBtwHistory = (
    updater: (entries: TuiBtwEntry[]) => TuiBtwEntry[],
  ) => {
    const next = updater(btwHistoryRef.current)
    btwHistoryRef.current = next
    setBtwHistory(next)
  }

  useEffect(() => {
    if (menu?.kind !== 'compact-progress') return
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setCompactProgress(
        Math.min(99, Math.max(1, Math.floor((Date.now() - startedAt) / 250))),
      )
    }, 250)
    return () => clearInterval(timer)
  }, [menu?.kind])

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
          cwd: runtimeCwdRef.current,
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

  const withLocalCommands = async <T,>(
    operation: (commands: InteractiveSessionCommands) => Promise<T>,
  ): Promise<T> => {
    if (serviceRef.current) return operation(serviceRef.current)
    const preferences = runtimePreferencesRef.current
    const commands = await factory.createService({
      eventSink: handleEvent,
      requireProvider: false,
      ...(preferences.model === undefined ? {} : { model: preferences.model }),
      effort: preferences.effort,
      permissionMode: preferences.permissionMode,
      additionalDirectories: preferences.additionalDirectories,
      cwd: runtimeCwdRef.current,
      ...(signal ? { signal } : {}),
    })
    try {
      return await operation(commands)
    } finally {
      await commands.close?.()
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
        await refreshTasks()
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

  const exportConversation = (method: 'clipboard' | 'file') => {
    if (method === 'file') {
      updateComposerInput(defaultConversationExportFilename())
      updateMenu({ kind: 'export-filename' })
      return
    }
    const text = conversationExportText(runtimeDisplay, history)
    const copying = clipboardWriter(text).then(
      () => {
        updateMenu(null)
        append({
          kind: 'local-result',
          text: 'Conversation copied to clipboard',
        })
      },
      (error: unknown) => warn(error),
    )
    onTurnChange?.(copying)
    void copying.finally(() => onTurnChange?.(null))
  }

  const saveConversation = (filename: string) => {
    let path: string
    try {
      path = conversationExportPath(runtimeCwdRef.current, filename)
    } catch (error) {
      warn(error)
      return
    }
    const text = conversationExportText(runtimeDisplay, history)
    const saving = exportWriter(path, text).then(
      () => {
        clearComposerInput()
        updateMenu(null)
        append({
          kind: 'local-result',
          text: `Conversation exported to: ${path}`,
        })
      },
      (error: unknown) => warn(error),
    )
    onTurnChange?.(saving)
    void saving.finally(() => onTurnChange?.(null))
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
        const commands = await service()
        if (!commands.mcpInspect || !commands.mcpTools) {
          const servers = commands.runtimeInfo?.().mcpServers ?? []
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
          return
        }
        const configRoot = process.env.CLAUDE_CONFIG_DIR
        const management = new ClaudeMcpManagement({
          cwd: runtimeCwdRef.current,
          ...(configRoot ? { configRoot } : {}),
        })
        const controller = new McpPanelController({
          cwd: runtimeCwdRef.current,
          management,
          runtime: mcpRuntimeFromSession({
            mcpInspect: commands.mcpInspect,
            mcpReconnect: commands.mcpReconnect ?? (async () => {}),
            mcpAuthenticate: commands.mcpAuthenticate ?? (async () => {}),
            mcpReload: commands.mcpReload ?? (async () => {}),
            mcpTools: commands.mcpTools,
          }),
        })
        mcpControllerRef.current = controller
        const model = await controller.open()
        updateMenu({
          kind: 'mcp',
          model,
          state: initialTuiMcpPanelState(model),
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

  const changeWorkingDirectory = (requestedCwd: string) => {
    const changing = (async () => {
      setBusy(true)
      setStatus('changing directory')
      try {
        const commands = await service()
        if (!commands.changeCwd) {
          throw new Error(
            'This interactive service cannot change working directories.',
          )
        }
        const cwd = await commands.changeCwd(
          sessionId ?? undefined,
          requestedCwd,
        )
        runtimeCwdRef.current = cwd
        setRuntimeCwd(cwd)
        await retireService()
        append({ kind: 'local-result', text: `Moved to ${cwd}` })
      } catch (error) {
        warn(error)
      } finally {
        setBusy(false)
        setStatus('ready')
      }
    })()
    onTurnChange?.(changing)
    void changing.finally(() => onTurnChange?.(null))
  }

  const showCdUsage = () => {
    const showing = (async () => {
      try {
        if (sessionId) await (await service()).recordCdUsage?.(sessionId)
        append({ kind: 'local-result', text: 'Usage: /cd <path>' })
      } catch (error) {
        warn(error)
      }
    })()
    onTurnChange?.(showing)
    void showing.finally(() => onTurnChange?.(null))
  }

  const showBtwUsage = () => {
    appendPromptHistory('/btw')
    const showing = (async () => {
      try {
        const activeSessionId = await (
          await service()
        ).recordBtwUsage?.(
          sessionId ?? undefined,
          runtimePreferencesRef.current.permissionMode,
        )
        if (activeSessionId) setSessionId(activeSessionId)
        append({ kind: 'user', text: '/btw' })
        append({ kind: 'local-result', text: 'Usage: /btw <your question>' })
      } catch (error) {
        warn(error)
      }
    })()
    onTurnChange?.(showing)
    void showing.finally(() => onTurnChange?.(null))
  }

  const backgroundSession = () => {
    appendPromptHistory('/background')
    const backgrounding = (async () => {
      setBusy(true)
      try {
        const hasModelTurn = history.some((item) => item.kind === 'assistant')
        if (!sessionId || !hasModelTurn) {
          const activeSessionId = await withLocalCommands(async (commands) => {
            if (!commands.recordBackgroundUsage) {
              throw new Error('Background sessions are unavailable.')
            }
            return commands.recordBackgroundUsage(
              sessionId ?? undefined,
              runtimePreferencesRef.current.permissionMode,
            )
          })
          setSessionId(activeSessionId)
          append({
            kind: 'local-result',
            text: 'Nothing to background yet — send a message first.',
          })
          return
        }
        if (!onBackground) {
          throw new Error('Background sessions are unavailable.')
        }
        const prompt = [...history]
          .reverse()
          .find((item) => item.kind === 'user')
        const detail = [...history]
          .reverse()
          .find((item) => item.kind === 'assistant' || item.kind === 'thinking')
        const sourceCheckpoint = await withLocalCommands(async (commands) => {
          if (!commands.recordBackgroundLaunch) {
            throw new Error('Background sessions are unavailable.')
          }
          return commands.recordBackgroundLaunch(sessionId)
        })
        setStatus('Backgrounding…')
        append({ kind: 'notice', text: 'Backgrounding…' })
        await waitUntilRenderFlush()
        await onBackground({
          sourceSessionId: sessionId,
          sourceCheckpoint,
          prompt:
            prompt && 'text' in prompt
              ? prompt.text
              : 'empty-background-command',
          detail: detail && 'text' in detail ? detail.text : '',
          cwd: runtimeCwdRef.current,
        })
        await retireService()
        exit()
      } catch (error) {
        warn(error)
      } finally {
        if (componentMountedRef.current) {
          setBusy(false)
          setStatus('ready')
        }
      }
    })()
    onTurnChange?.(backgrounding)
    void backgrounding.finally(() => onTurnChange?.(null))
  }

  const askSideQuestion = (question: string) => {
    const id = btwIdRef.current + 1
    btwIdRef.current = id
    appendPromptHistory(`/btw ${question}`)
    const entry: TuiBtwEntry = {
      id,
      question,
      answer: '',
      status: 'answering',
    }
    updateBtwHistory((entries) => [...entries, entry])
    updateMenu({
      kind: 'btw',
      selectedIndex: btwHistoryRef.current.length - 1,
      scrollOffset: 0,
    })
    setBtwCopied(false)
    const controller = new AbortController()
    btwControllerRef.current?.abort()
    btwControllerRef.current = controller
    const sideSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    const answering = (async () => {
      try {
        const commands = await service()
        if (!commands.answerSideQuestion) {
          throw new Error('Side questions are unavailable.')
        }
        const result = await commands.answerSideQuestion(
          sessionId ?? undefined,
          question,
          sideSignal,
          (delta) =>
            updateBtwHistory((entries) =>
              entries.map((item) =>
                item.id === id
                  ? { ...item, answer: item.answer + delta }
                  : item,
              ),
            ),
          runtimePreferencesRef.current.permissionMode,
        )
        if (result.sessionId) setSessionId(result.sessionId)
        updateBtwHistory((entries) =>
          entries.map((item) =>
            item.id === id ? { ...item, status: 'complete' } : item,
          ),
        )
        if (sideSignal.aborted) throw new AgentRunCancelledError()
        setUsage((current) => ({
          inputTokens: (current?.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens:
            (current?.outputTokens ?? 0) + result.usage.outputTokens,
          cacheReadInputTokens:
            (current?.cacheReadInputTokens ?? 0) +
            (result.usage.cacheReadInputTokens ?? 0),
          cacheCreationInputTokens:
            (current?.cacheCreationInputTokens ?? 0) +
            (result.usage.cacheCreationInputTokens ?? 0),
        }))
        if (result.costUsd !== undefined) {
          const sideCostUsd = result.costUsd
          setCostUsd((current) => (current ?? 0) + sideCostUsd)
        }
      } catch (error) {
        updateBtwHistory((entries) =>
          entries.map((item) =>
            item.id === id
              ? {
                  ...item,
                  status: 'error',
                  error: sideSignal.aborted
                    ? 'Cancelled'
                    : error instanceof Error
                      ? error.message
                      : String(error),
                }
              : item,
          ),
        )
      } finally {
        if (btwControllerRef.current === controller) {
          btwControllerRef.current = null
        }
      }
    })()
    onTurnChange?.(answering)
    void answering.finally(() => onTurnChange?.(null))
  }

  const forkSideQuestion = (entry: TuiBtwEntry) => {
    updateBtwHistory((entries) =>
      entries.map((item) =>
        item.id === entry.id ? { ...item, status: 'forking' } : item,
      ),
    )
    const forking = (async () => {
      try {
        if (!sessionId) {
          throw new Error(
            'Start a conversation before forking a side question.',
          )
        }
        const commands = await service()
        if (!commands.forkSideQuestion) {
          throw new Error('Side-question forking is unavailable.')
        }
        const result = await commands.forkSideQuestion(
          sessionId,
          entry.question,
        )
        updateMenu(null)
        append({
          kind: 'local-result',
          text: `⑂ forked ${result.name} (${result.agentId.slice(-4)})`,
        })
      } catch (error) {
        updateBtwHistory((entries) =>
          entries.map((item) =>
            item.id === entry.id
              ? {
                  ...item,
                  status: 'error',
                  error: error instanceof Error ? error.message : String(error),
                }
              : item,
          ),
        )
      }
    })()
    onTurnChange?.(forking)
    void forking.finally(() => onTurnChange?.(null))
  }

  const renameSession = (requestedName?: string) => {
    const renaming = (async () => {
      if (!sessionId) {
        append({ kind: 'warning', text: 'No active conversation to rename.' })
        return
      }
      setBusy(true)
      setStatus('renaming session')
      try {
        const commands = await service()
        if (!commands.rename) {
          throw new Error('This interactive service cannot rename sessions.')
        }
        const name =
          requestedName?.trim() ||
          (await commands.sessionNameSuggestion?.(sessionId, signal))
        if (!name) throw new Error('Could not generate a session name')
        await commands.rename(sessionId, name)
        append({ kind: 'local-result', text: `Session renamed to: ${name}` })
      } catch (error) {
        warn(error)
      } finally {
        setBusy(false)
        setStatus('ready')
      }
    })()
    onTurnChange?.(renaming)
    void renaming.finally(() => onTurnChange?.(null))
  }

  const branchSession = () => {
    const branching = (async () => {
      if (!sessionId) {
        append({ kind: 'warning', text: 'No active conversation to branch.' })
        return
      }
      setBusy(true)
      setStatus('branching conversation')
      try {
        const commands = await service()
        const originalSessionId = sessionId
        const source = (await commands.sessions()).find(
          (candidate) => candidate.sessionId === originalSessionId,
        )
        const fork = await commands.fork(originalSessionId)
        const branchName = source?.name ? `${source.name} (Branch)` : undefined
        if (branchName && commands.rename) {
          await commands.rename(fork.sessionId, branchName)
        }
        setSessionId(fork.sessionId)
        setPendingFork(false)
        append({
          kind: 'local-result',
          text: `Branched conversation. You are now in the new branch (session ${fork.sessionId}). Use /resume ${originalSessionId}${source?.name ? ` ("${source.name}")` : ''} to return to the original, or run praxis -r ${originalSessionId} in a new terminal.`,
        })
      } catch (error) {
        warn(error)
      } finally {
        setBusy(false)
        setStatus('ready')
      }
    })()
    onTurnChange?.(branching)
    void branching.finally(() => onTurnChange?.(null))
  }

  const compactSession = () => {
    const compacting = (async () => {
      if (!sessionId) {
        append({ kind: 'warning', text: 'No active conversation to compact.' })
        return
      }
      const controller = new AbortController()
      turnControllerRef.current?.abort()
      turnControllerRef.current = controller
      const compactSignal = signal
        ? AbortSignal.any([signal, controller.signal])
        : controller.signal
      setBusy(true)
      setStatus('compacting conversation')
      setCompactProgress(0)
      updateMenu({ kind: 'compact-progress' })
      try {
        const commands = await service()
        if (!commands.compact) {
          throw new Error('This interactive service cannot compact sessions.')
        }
        const result = await commands.compact(sessionId, compactSignal)
        const projected = await commands.transcript?.(sessionId)
        setHistory([
          ...(projected ?? [{ kind: 'compact', summary: result.summary }]),
          { kind: 'user', text: '/compact' },
          {
            kind: 'local-result',
            text: 'Compacted (ctrl+o to see full summary)',
          },
        ])
        setUsage((current) => ({
          inputTokens: (current?.inputTokens ?? 0) + result.usage.inputTokens,
          outputTokens:
            (current?.outputTokens ?? 0) + result.usage.outputTokens,
          cacheReadInputTokens:
            (current?.cacheReadInputTokens ?? 0) +
            (result.usage.cacheReadInputTokens ?? 0),
          cacheCreationInputTokens:
            (current?.cacheCreationInputTokens ?? 0) +
            (result.usage.cacheCreationInputTokens ?? 0),
        }))
      } catch (error) {
        warn(error)
      } finally {
        if (turnControllerRef.current === controller) {
          turnControllerRef.current = null
        }
        updateMenu(null)
        setBusy(false)
        setStatus('ready')
      }
    })()
    onTurnChange?.(compacting)
    void compacting.finally(() => onTurnChange?.(null))
  }

  const openRewind = () => {
    const loading = (async () => {
      if (!sessionId) {
        append({ kind: 'warning', text: 'No active conversation to rewind.' })
        return
      }
      setBusy(true)
      setStatus('loading rewind points')
      try {
        const commands = await service()
        if (!commands.rewindPoints) {
          throw new Error(
            'This interactive service cannot inspect rewind points.',
          )
        }
        const points = await commands.rewindPoints(sessionId)
        if (points.length === 0) {
          append({
            kind: 'warning',
            text: 'No conversation checkpoints found.',
          })
          return
        }
        updateMenu({
          kind: 'rewind',
          points,
          selectedIndex: points.length,
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

  const applyRewind = (
    point: RewindPoint,
    action: RewindAction,
    summarizationContext?: string,
  ) => {
    if (action === 'cancel') {
      updateMenu(null)
      return
    }
    const restoring = (async () => {
      if (!sessionId) return
      setBusy(true)
      setStatus(action.startsWith('summarize') ? 'summarizing' : 'rewinding')
      try {
        const commands = await service()
        if (action === 'summarize-from' || action === 'summarize-to') {
          if (!commands.compact) {
            throw new Error(
              'This interactive service cannot summarize sessions.',
            )
          }
          const direction = action === 'summarize-from' ? 'from' : 'to'
          const controller = new AbortController()
          turnControllerRef.current?.abort()
          turnControllerRef.current = controller
          const compactSignal = signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal
          setCompactProgress(0)
          updateMenu({ kind: 'compact-progress' })
          const result = await commands
            .compact(sessionId, compactSignal, {
              messageId: point.messageId,
              direction,
              ...(summarizationContext?.trim()
                ? { context: summarizationContext.trim() }
                : {}),
            })
            .finally(() => {
              if (turnControllerRef.current === controller) {
                turnControllerRef.current = null
              }
            })
          const projected = await commands.transcript?.(sessionId)
          setHistory(
            projected ?? [{ kind: 'compact', summary: result.summary }],
          )
          if (action === 'summarize-from') updateComposerInput(point.prompt)
          append({ kind: 'assistant', text: 'Summarized conversation' })
          append({
            kind: 'local-result',
            text: `Summarized ${result.messagesSummarized ?? 0} messages ${action === 'summarize-from' ? 'from' : 'up to'} this point\n  (ctrl+o to expand history)`,
          })
          setUsage((current) => ({
            inputTokens: (current?.inputTokens ?? 0) + result.usage.inputTokens,
            outputTokens:
              (current?.outputTokens ?? 0) + result.usage.outputTokens,
            cacheReadInputTokens:
              (current?.cacheReadInputTokens ?? 0) +
              (result.usage.cacheReadInputTokens ?? 0),
            cacheCreationInputTokens:
              (current?.cacheCreationInputTokens ?? 0) +
              (result.usage.cacheCreationInputTokens ?? 0),
          }))
          return
        }

        const restoreFiles =
          action === 'code' || action === 'code-and-conversation'
        const restoreConversation =
          action === 'conversation' || action === 'code-and-conversation'
        let restoredConversation:
          { sessionId: string; history: TranscriptItem[] } | undefined
        if (restoreConversation) {
          if (point.branchMessageId) {
            const originalSessionId = sessionId
            const source = (await commands.sessions()).find(
              (candidate) => candidate.sessionId === originalSessionId,
            )
            const fork = await commands.fork(
              originalSessionId,
              undefined,
              point.branchMessageId,
            )
            if (source?.name && commands.rename) {
              await commands.rename(fork.sessionId, `${source.name} (Branch)`)
            }
            restoredConversation = {
              sessionId: fork.sessionId,
              history: (await commands.transcript?.(fork.sessionId)) ?? [],
            }
          } else {
            restoredConversation = { sessionId: '', history: [] }
          }
        }
        if (restoreFiles) {
          if (!commands.rewindFiles) {
            throw new Error('File rewinding is not enabled.')
          }
          await commands.rewindFiles(sessionId, point.messageId)
        }
        if (restoredConversation) {
          setSessionId(restoredConversation.sessionId || null)
          setPendingFork(false)
          setHistory(restoredConversation.history)
          updateComposerInput(point.prompt)
        }
        append({
          kind: 'local-result',
          text:
            action === 'code'
              ? 'Code restored. The conversation was unchanged.'
              : restoreFiles
                ? 'Code and conversation restored. Edit the message and submit to continue.'
                : 'Conversation restored. Edit the message and submit to continue.',
        })
      } catch (error) {
        warn(error)
      } finally {
        updateMenu(null)
        setBusy(false)
        setStatus('ready')
      }
    })()
    onTurnChange?.(restoring)
    void restoring.finally(() => onTurnChange?.(null))
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
            : menuRef.current.kind === 'theme'
              ? ['ThemePicker', 'Select']
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

    const earlyMenu = menuRef.current
    if (earlyMenu?.kind === 'tasks') {
      if (key.escape || value === '\u001B') {
        updateMenu(null)
        return
      }
      const selected = earlyMenu.tasks[earlyMenu.state.selectedIndex]
      if (
        (value.toLowerCase() === 'x' || value === 'X') &&
        selected?.status === 'running'
      ) {
        const stopping = (async () => {
          setBusy(true)
          try {
            const commands = await service()
            if (!sessionId || !commands.stopTask)
              throw new Error('Task controls are unavailable.')
            await commands.stopTask(sessionId, selected.id)
            await refreshTasks(earlyMenu)
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(stopping)
        void stopping.finally(() => onTurnChange?.(null))
        return
      }
      if (
        key.upArrow ||
        key.downArrow ||
        key.return ||
        key.leftArrow ||
        key.rightArrow
      ) {
        const action = key.upArrow
          ? { type: 'move' as const, delta: -1 as const }
          : key.downArrow
            ? { type: 'move' as const, delta: 1 as const }
            : key.return
              ? { type: 'open' as const }
              : { type: 'back' as const }
        const state = updateTuiTaskPanelState(
          earlyMenu.state,
          earlyMenu.tasks,
          action,
        )
        updateMenu({ ...earlyMenu, state })
      }
      return
    }
    if (earlyMenu?.kind === 'mcp') {
      if (key.escape || value === '\u001B') {
        const transition = mcpControllerRef.current
          ? { state: earlyMenu.state, command: { type: 'close' as const } }
          : undefined
        if (transition?.command?.type === 'close') updateMenu(null)
        return
      }
      const input = key.upArrow
        ? { type: 'up' as const }
        : key.downArrow
          ? { type: 'down' as const }
          : key.return
            ? { type: 'confirm' as const }
            : key.leftArrow
              ? { type: 'back' as const }
              : null
      if (input && mcpControllerRef.current) {
        const dispatch = mcpControllerRef.current.dispatch(
          earlyMenu.model,
          earlyMenu.state,
          input,
        )
        const operation = (async () => {
          setBusy(true)
          try {
            const result = await dispatch
            if (result.closed) updateMenu(null)
            else
              updateMenu({
                kind: 'mcp',
                model: result.model,
                state: result.state,
              })
            if (result.error) warn(result.error)
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(operation)
        void operation.finally(() => onTurnChange?.(null))
      }
      return
    }
    if (earlyMenu?.kind === 'config') {
      if (key.escape || value === '\u001B') {
        if (earlyMenu.searchFocused && earlyMenu.query) {
          updateMenu({ ...earlyMenu, query: '' })
        } else {
          updateMenu(null)
        }
        return
      }
      const rows = projectConfigRows(earlyMenu.snapshot, earlyMenu.query)
      if (key.leftArrow || key.rightArrow || key.tab) {
        const tabs: readonly ConfigDashboardTab[] = [
          'settings',
          'status',
          'config',
          'usage',
          'stats',
        ]
        const index = tabs.indexOf(earlyMenu.tab)
        const direction = key.leftArrow || (key.tab && key.shift) ? -1 : 1
        const tab =
          tabs[Math.max(0, Math.min(tabs.length - 1, index + direction))] ??
          'config'
        updateMenu({
          ...earlyMenu,
          tab,
          selectedIndex: 0,
          searchFocused: tab === 'config',
        })
        return
      }
      if (earlyMenu.tab !== 'config') return
      if (key.upArrow || key.downArrow) {
        updateMenu({
          ...earlyMenu,
          searchFocused: false,
          selectedIndex: Math.max(
            0,
            Math.min(
              Math.max(0, rows.length - 1),
              earlyMenu.selectedIndex + (key.upArrow ? -1 : 1),
            ),
          ),
        })
        return
      }
      if (value === '/' && !earlyMenu.searchFocused) {
        updateMenu({ ...earlyMenu, searchFocused: true })
        return
      }
      if (earlyMenu.searchFocused && key.backspace) {
        updateMenu({ ...earlyMenu, query: earlyMenu.query.slice(0, -1) })
        return
      }
      if (
        earlyMenu.searchFocused &&
        !key.ctrl &&
        !key.meta &&
        value &&
        printable
      ) {
        updateMenu({
          ...earlyMenu,
          query: earlyMenu.query + value,
          selectedIndex: 0,
        })
        return
      }
      if (key.return || value === ' ') {
        const row = rows[earlyMenu.selectedIndex]
        if (!row) return
        const definition = configSettingDefinition(row.definition.id)
        if (!definition || definition.values === 'language') {
          append({
            kind: 'warning',
            text: 'This setting requires a typed value and is not yet editable in the panel.',
          })
          return
        }
        const values = definition.values
        const currentIndex = values.indexOf(row.value)
        const value = values[(currentIndex + 1) % values.length]
        if (value === undefined) return
        const saving = (async () => {
          setBusy(true)
          try {
            const snapshot = await saveConfigSetting(
              definition.id,
              value as ConfigValue,
            )
            await retireService()
            updateMenu({ ...earlyMenu, snapshot })
            append({
              kind: 'local-result',
              text: `${definition.label} set to ${String(value)}`,
            })
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(saving)
        void saving.finally(() => onTurnChange?.(null))
      }
      return
    }
    if (earlyMenu?.kind === 'memory') {
      if (key.escape || value === '\u001B') {
        updateMenu(null)
        append({ kind: 'local-result', text: 'Cancelled memory editing' })
        return
      }
      if (earlyMenu.loading) return
      if (key.upArrow || key.downArrow) {
        updateMenu({
          ...earlyMenu,
          selectedIndex: Math.max(
            0,
            Math.min(
              Math.max(0, earlyMenu.entries.length - 1),
              earlyMenu.selectedIndex + (key.upArrow ? -1 : 1),
            ),
          ),
        })
        return
      }
      const numericIndex = /^[1-9]$/u.test(value) ? Number(value) - 1 : null
      if (!key.return && numericIndex === null) return
      const selectedIndex = numericIndex ?? earlyMenu.selectedIndex
      const entry = earlyMenu.entries[selectedIndex]
      if (!entry) return
      if (entry.kind === 'folder') {
        const generation = earlyMenu.generation
        if (memoryFolderOpeningRef.current?.generation === generation) return
        memoryFolderOpeningRef.current = { generation, index: selectedIndex }
        const opening = memoryFolderOpener(entry.path).then(() => {
          if (
            menuRef.current?.kind === 'memory' &&
            menuRef.current.generation === generation
          ) {
            updateMenu({
              ...menuRef.current,
              selectedIndex,
              openedIndex: selectedIndex,
            })
          }
        })
        onTurnChange?.(opening)
        void opening.catch(warn).finally(() => {
          if (
            memoryFolderOpeningRef.current?.generation === generation &&
            memoryFolderOpeningRef.current.index === selectedIndex
          ) {
            memoryFolderOpeningRef.current = null
            onTurnChange?.(null)
          }
        })
      } else {
        updateMenu(null)
        memoryEditorRequestRef.current = entry
        setMemoryEditorRequest(entry)
      }
      return
    }

    if (
      externalEditorRequest !== null ||
      keybindingsEditing ||
      memoryEditorRequestRef.current !== null
    )
      return

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
      if (activeMenu.kind === 'btw') {
        const selected = btwHistoryRef.current[activeMenu.selectedIndex]
        if (key.escape || value === '\u001B') {
          btwControllerRef.current?.abort()
          btwControllerRef.current = null
          updateMenu(null)
          return
        }
        if (key.leftArrow || key.rightArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                btwHistoryRef.current.length - 1,
                activeMenu.selectedIndex + (key.leftArrow ? -1 : 1),
              ),
            ),
            scrollOffset: 0,
          })
          setBtwCopied(false)
          return
        }
        if (key.upArrow || key.downArrow) {
          const maxOffset = Math.max(
            0,
            (selected?.answer.split('\n').length ?? 0) - 16,
          )
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
          return
        }
        if (lower === 'x' && btwHistoryRef.current.length > 1 && selected) {
          updateBtwHistory(() => [selected])
          updateMenu({ kind: 'btw', selectedIndex: 0, scrollOffset: 0 })
          setBtwCopied(false)
          return
        }
        if (lower === 'c' && selected?.status === 'complete') {
          const copying = sideQuestionClipboardWriter(selected.answer).then(
            () => {
              if (!componentMountedRef.current) return
              setBtwCopied(true)
              if (btwCopiedTimerRef.current) {
                clearTimeout(btwCopiedTimerRef.current)
              }
              btwCopiedTimerRef.current = setTimeout(() => {
                if (componentMountedRef.current) setBtwCopied(false)
                btwCopiedTimerRef.current = null
              }, 1500)
              btwCopiedTimerRef.current.unref?.()
            },
            (error: unknown) =>
              updateBtwHistory((entries) =>
                entries.map((item) =>
                  item.id === selected.id
                    ? {
                        ...item,
                        status: 'error',
                        error:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      }
                    : item,
                ),
              ),
          )
          onTurnChange?.(copying)
          void copying.finally(() => onTurnChange?.(null))
          return
        }
        if (lower === 'f' && selected?.status === 'complete') {
          forkSideQuestion(selected)
        }
        return
      }

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
                  runtimeCwdRef.current,
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
                runtimeCwdRef.current,
              )
              clearComposerInput()
              if (path !== runtimeCwdRef.current) {
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

      if (activeMenu.kind === 'hooks') {
        const event = activeMenu.configuration.events[activeMenu.eventIndex]
        const matcher = event?.matchers[activeMenu.matcherIndex]
        const length =
          activeMenu.depth === 'events'
            ? activeMenu.configuration.events.length
            : activeMenu.depth === 'matchers'
              ? (event?.matchers.length ?? 0)
              : activeMenu.depth === 'hooks'
                ? (matcher?.hooks.length ?? 0)
                : 0
        if (key.escape || value === '\u001B') {
          updateMenu(
            activeMenu.depth === 'detail'
              ? { ...activeMenu, depth: 'hooks' }
              : activeMenu.depth === 'hooks'
                ? { ...activeMenu, depth: 'matchers', hookIndex: 0 }
                : activeMenu.depth === 'matchers'
                  ? {
                      ...activeMenu,
                      depth: 'events',
                      matcherIndex: 0,
                      hookIndex: 0,
                    }
                  : null,
          )
          return
        }
        const numericIndex = /^[1-9]$/u.test(value) ? Number(value) - 1 : null
        if (numericIndex !== null) {
          if (numericIndex >= length) return
          if (activeMenu.depth === 'events') {
            updateMenu({
              ...activeMenu,
              eventIndex: numericIndex,
              matcherIndex: 0,
              hookIndex: 0,
            })
          } else if (activeMenu.depth === 'matchers') {
            updateMenu({
              ...activeMenu,
              matcherIndex: numericIndex,
              hookIndex: 0,
            })
          } else if (activeMenu.depth === 'hooks') {
            updateMenu({ ...activeMenu, hookIndex: numericIndex })
          }
          return
        }
        if (key.upArrow || key.downArrow) {
          if (length === 0) return
          const delta = key.upArrow ? -1 : 1
          if (activeMenu.depth === 'events') {
            updateMenu({
              ...activeMenu,
              eventIndex: Math.max(
                0,
                Math.min(length - 1, activeMenu.eventIndex + delta),
              ),
              matcherIndex: 0,
              hookIndex: 0,
            })
          } else if (activeMenu.depth === 'matchers') {
            updateMenu({
              ...activeMenu,
              matcherIndex: Math.max(
                0,
                Math.min(length - 1, activeMenu.matcherIndex + delta),
              ),
              hookIndex: 0,
            })
          } else if (activeMenu.depth === 'hooks') {
            updateMenu({
              ...activeMenu,
              hookIndex: Math.max(
                0,
                Math.min(length - 1, activeMenu.hookIndex + delta),
              ),
            })
          }
          return
        }
        if (key.return) {
          if (activeMenu.depth === 'events') {
            updateMenu({
              ...activeMenu,
              depth: 'matchers',
              matcherIndex: 0,
              hookIndex: 0,
            })
          } else if (activeMenu.depth === 'matchers' && matcher) {
            updateMenu({ ...activeMenu, depth: 'hooks', hookIndex: 0 })
          } else if (
            activeMenu.depth === 'hooks' &&
            matcher?.hooks[activeMenu.hookIndex]
          ) {
            updateMenu({ ...activeMenu, depth: 'detail' })
          }
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

      if (activeMenu.kind === 'rewind') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
        } else if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                activeMenu.points.length,
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        } else if (key.return) {
          const point = activeMenu.points[activeMenu.selectedIndex]
          if (!point) {
            updateMenu(null)
          } else {
            updateMenu({
              kind: 'rewind-confirm',
              points: activeMenu.points,
              point,
              selectedIndex: 0,
            })
          }
        }
        return
      }

      if (activeMenu.kind === 'rewind-confirm') {
        const actions = rewindActions(activeMenu.point)
        if (key.escape || value === '\u001B') {
          updateMenu({
            kind: 'rewind',
            points: activeMenu.points,
            selectedIndex: Math.max(
              0,
              activeMenu.points.findIndex(
                (point) => point.messageId === activeMenu.point.messageId,
              ),
            ),
          })
        } else if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                actions.length - 1,
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        } else if (key.return) {
          const selected = actions[activeMenu.selectedIndex]
          if (
            selected?.action === 'summarize-from' ||
            selected?.action === 'summarize-to'
          ) {
            clearComposerInput()
            updateMenu({
              kind: 'rewind-context',
              points: activeMenu.points,
              point: activeMenu.point,
              direction: selected.action === 'summarize-from' ? 'from' : 'to',
            })
          } else if (selected) {
            applyRewind(activeMenu.point, selected.action)
          }
        }
        return
      }

      if (activeMenu.kind === 'rewind-context') {
        if (key.escape || value === '\u001B') {
          clearComposerInput()
          updateMenu({
            kind: 'rewind-confirm',
            points: activeMenu.points,
            point: activeMenu.point,
            selectedIndex:
              activeMenu.direction === 'from'
                ? rewindActions(activeMenu.point).findIndex(
                    (option) => option.action === 'summarize-from',
                  )
                : rewindActions(activeMenu.point).findIndex(
                    (option) => option.action === 'summarize-to',
                  ),
          })
        } else if (key.return) {
          const context = inputRef.current
          clearComposerInput()
          applyRewind(
            activeMenu.point,
            activeMenu.direction === 'from' ? 'summarize-from' : 'summarize-to',
            context,
          )
        } else {
          editComposer()
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

      if (activeMenu.kind === 'export-filename') {
        if (key.escape || value === '\u001B') {
          clearComposerInput()
          updateMenu({ kind: 'export', selectedIndex: 1 })
        } else if (key.return) {
          const filename = inputRef.current.trim()
          if (!filename) {
            append({ kind: 'warning', text: 'Enter a filename or press Esc.' })
          } else {
            saveConversation(filename)
          }
        } else {
          editComposer()
        }
        return
      }

      if (activeMenu.kind === 'export') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
        } else if (key.upArrow || key.downArrow) {
          updateMenu({ ...activeMenu, selectedIndex: key.upArrow ? 0 : 1 })
        } else if (value === '1' || value === '2') {
          updateMenu({ ...activeMenu, selectedIndex: Number(value) - 1 })
        } else if (key.return) {
          exportConversation(
            activeMenu.selectedIndex === 0 ? 'clipboard' : 'file',
          )
        }
        return
      }

      if (activeMenu.kind === 'theme') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
        } else if (isKeybinding('theme:toggleSyntaxHighlighting')) {
          const syntaxHighlightingDisabled =
            !themeSettings.syntaxHighlightingDisabled
          const saving = (async () => {
            setBusy(true)
            try {
              const committed = await presentationThemeStore.save({
                syntaxHighlightingDisabled,
              })
              setThemeSettings(committed)
            } catch (error) {
              warn(error)
            } finally {
              setBusy(false)
            }
          })()
          onTurnChange?.(saving)
          void saving.finally(() => onTurnChange?.(null))
        } else if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                TUI_THEMES.length - 1,
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        } else if (/^[1-7]$/u.test(value)) {
          updateMenu({ ...activeMenu, selectedIndex: Number(value) - 1 })
        } else if (key.return) {
          const selected = TUI_THEMES[activeMenu.selectedIndex]
          if (!selected) return
          const saving = (async () => {
            setBusy(true)
            try {
              const committed = await presentationThemeStore.save({
                theme: selected,
              })
              setThemeSettings(committed)
              updateMenu(null)
              append({ kind: 'local-result', text: `Theme set to ${selected}` })
            } catch (error) {
              warn(error)
            } finally {
              setBusy(false)
            }
          })()
          onTurnChange?.(saving)
          void saving.finally(() => onTurnChange?.(null))
        }
        return
      }

      if (activeMenu.kind === 'compact-progress') {
        if (key.escape || value === '\u001B' || isKeybinding('chat:cancel')) {
          turnControllerRef.current?.abort()
        }
        return
      }

      if (key.escape) {
        updateMenu(null)
        return
      }

      if (
        activeMenu.kind === 'mcp' ||
        activeMenu.kind === 'tasks' ||
        activeMenu.kind === 'config'
      ) {
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
      key.return && (key.shift || key.meta) && keybindingAction === undefined
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
      const renameCommand = /^\/rename(?:\s+(.+))?$/u.exec(prompt)
      const cdCommand = /^\/cd(?:\s+(.+))?$/u.exec(prompt)
      const btwCommand = /^\/btw(?:\s+([\s\S]+))?$/u.exec(prompt)
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
      } else if (prompt === '/theme') {
        updateMenu({
          kind: 'theme',
          selectedIndex: Math.max(0, TUI_THEMES.indexOf(themeSettings.theme)),
        })
      } else if (prompt === '/terminal-setup') {
        const setup = (async () => {
          setBusy(true)
          setStatus('configuring terminal')
          try {
            const result = await (terminalSetupOverride ?? setupTuiTerminal)()
            append({ kind: 'local-result', text: result })
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
            setStatus('ready')
          }
        })()
        onTurnChange?.(setup)
        void setup.finally(() => onTurnChange?.(null))
      } else if (prompt === '/keybindings') {
        setKeybindingsEditing(true)
      } else if (prompt === '/memory') {
        append({ kind: 'user', text: prompt })
        const generation = ++memoryMenuGenerationRef.current
        updateMenu({
          kind: 'memory',
          generation,
          loading: true,
          autoMemoryEnabled: true,
          entries: [],
          selectedIndex: 0,
          openedIndex: null,
        })
        const loading = (async () => {
          setBusy(true)
          try {
            const files = await memoryFilesLoader(
              keybindingsRoot,
              runtimeCwdRef.current,
            )
            if (
              menuRef.current?.kind === 'memory' &&
              menuRef.current.generation === generation
            ) {
              updateMenu({
                kind: 'memory',
                generation,
                loading: false,
                autoMemoryEnabled: files.autoMemoryEnabled,
                entries: files.entries,
                selectedIndex: 0,
                openedIndex: null,
              })
            }
          } catch (error) {
            if (
              menuRef.current?.kind === 'memory' &&
              menuRef.current.generation === generation
            ) {
              updateMenu(null)
              warn(error)
            }
          } finally {
            if (memoryMenuGenerationRef.current === generation) setBusy(false)
          }
        })()
        onTurnChange?.(loading)
        void loading.finally(() => onTurnChange?.(null))
      } else if (prompt === '/add-dir') {
        openWorkspaceDirectoryInput()
      } else if (btwCommand) {
        const sideQuestion = btwCommand[1]?.trim()
        if (sideQuestion) askSideQuestion(sideQuestion)
        else showBtwUsage()
      } else if (prompt === '/background') {
        backgroundSession()
      } else if (cdCommand) {
        append({ kind: 'user', text: prompt })
        const requestedCwd = cdCommand[1]?.trim()
        if (!requestedCwd) {
          showCdUsage()
        } else {
          changeWorkingDirectory(requestedCwd)
        }
      } else if (prompt === '/branch') {
        append({ kind: 'user', text: prompt })
        branchSession()
      } else if (prompt === '/compact') {
        compactSession()
      } else if (prompt === '/rewind') {
        openRewind()
      } else if (prompt === '/export') {
        append({ kind: 'user', text: prompt })
        updateMenu({ kind: 'export', selectedIndex: 0 })
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
      } else if (prompt === '/hooks') {
        const loading = (async () => {
          setBusy(true)
          setStatus('loading hooks')
          let localService: InteractiveSessionCommands | undefined
          try {
            const preferences = runtimePreferencesRef.current
            localService = await factory.createService({
              eventSink: handleEvent,
              requireProvider: false,
              hooksOnly: true,
              ...(preferences.model === undefined
                ? {}
                : { model: preferences.model }),
              effort: preferences.effort,
              permissionMode: preferences.permissionMode,
              additionalDirectories: preferences.additionalDirectories,
              cwd: runtimeCwdRef.current,
              ...(signal ? { signal } : {}),
            })
            if (!localService.hookConfiguration)
              throw new Error('Hook configuration is unavailable.')
            const configuration = await localService.hookConfiguration()
            updateMenu({
              kind: 'hooks',
              configuration,
              depth: 'events',
              eventIndex: 0,
              matcherIndex: 0,
              hookIndex: 0,
            })
          } catch (error) {
            warn(error)
          } finally {
            try {
              await localService?.close?.()
            } catch (error) {
              warn(error)
            }
            setBusy(false)
            setStatus('ready')
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
        const initial: Extract<InteractiveMenu, { kind: 'config' }> = {
          kind: 'config',
          snapshot: { settings: {}, state: {} },
          tab: 'config',
          selectedIndex: 0,
          query: '',
          searchFocused: true,
        }
        updateMenu(initial)
        const loading = (async () => {
          setBusy(true)
          try {
            const snapshot = await loadConfigSettings()
            if (menuRef.current?.kind === 'config')
              updateMenu({ ...menuRef.current, snapshot })
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(loading)
        void loading.finally(() => onTurnChange?.(null))
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
        append({ kind: 'user', text: prompt })
        const ordinal = Number(copyCommand[1] ?? 1)
        if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
          append({ kind: 'warning', text: 'Usage: /copy [positive number]' })
        } else {
          copyResponse(ordinal)
        }
      } else if (renameCommand) {
        append({ kind: 'user', text: prompt })
        renameSession(renameCommand[1])
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
    <TuiThemeProvider settings={themeSettings}>
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
            {externalEditorRequest !== null ||
            keybindingsEditing ||
            memoryEditorRequest !== null ? (
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
                <Text bold>
                  {describeTool(permission.call, sensitiveValues)}
                </Text>
                <Text>{selectionPrefix(true, axScreenReader)}1. Yes</Text>
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
                <Text>
                  {selectionPrefix(true, axScreenReader)}1. Yes, implement the
                  plan
                </Text>
                <Text> 2. No, keep planning</Text>
              </DialogFrame>
            ) : question ? (
              <DialogFrame
                title={`${question.questions[question.index]?.header}: ${question.questions[question.index]?.question}`}
                screenReader={axScreenReader}
              >
                {question.questions[question.index]?.options.map(
                  (option, index) => (
                    <Box
                      key={`${index}-${option.label}`}
                      flexDirection="column"
                    >
                      <Text>
                        {index + 1}. {option.label} — {option.description}
                      </Text>
                      {option.preview ? (
                        <Text dimColor>{option.preview}</Text>
                      ) : null}
                    </Box>
                  ),
                )}
                <Text>
                  {axScreenReader ? 'Current answer: ' : '› '}
                  {input || (axScreenReader ? '(empty)' : '')}
                </Text>
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
                <Text dimColor>
                  Enter JSON object to accept · Esc to cancel
                </Text>
              </DialogFrame>
            ) : menu?.kind === 'model-input' ? (
              <DialogFrame title="Enter model ID" screenReader={axScreenReader}>
                <Text dimColor>
                  Enter a model ID supported by the configured provider.
                </Text>
                <Text>› {input}</Text>
                <Text dimColor>Enter confirms · Esc cancels</Text>
              </DialogFrame>
            ) : menu?.kind === 'export-filename' ? (
              <DialogFrame
                title="Enter filename:"
                screenReader={axScreenReader}
              >
                <Text>&gt; {input}</Text>
                <Text dimColor>Enter to save · Esc to go back</Text>
              </DialogFrame>
            ) : menu?.kind === 'compact-progress' ? (
              <Box flexDirection="column">
                <Text>✻ Compacting conversation…</Text>
                <Text>
                  {'▰'.repeat(Math.floor(compactProgress / 2))}
                  {'▱'.repeat(50 - Math.floor(compactProgress / 2))}{' '}
                  {compactProgress}%
                </Text>
              </Box>
            ) : menu?.kind === 'btw' ? (
              <BtwPanel
                entries={btwHistory}
                selectedIndex={menu.selectedIndex}
                scrollOffset={menu.scrollOffset}
                copied={btwCopied}
                width={width}
                screenReader={axScreenReader}
              />
            ) : menu?.kind === 'rewind' ? (
              <Box flexDirection="column">
                <Text bold> Rewind</Text>
                <Text> </Text>
                <Text>
                  {' '}
                  Restore the code and/or conversation to the point before…
                </Text>
                <Text> </Text>
                {(() => {
                  const window = rewindPointWindow(
                    menu.points,
                    menu.selectedIndex,
                  )
                  return (
                    <>
                      {window.start > 0 ? (
                        <Text dimColor> ↑ {window.start} more above</Text>
                      ) : null}
                      {menu.points
                        .slice(window.start, window.end)
                        .map((point, offset) => {
                          const index = window.start + offset
                          return (
                            <Box
                              key={point.messageId}
                              flexDirection="column"
                              marginBottom={1}
                            >
                              <Text inverse={menu.selectedIndex === index}>
                                {menu.selectedIndex === index ? ' ❯ ' : '   '}
                                {point.prompt
                                  .replace(/\s+/gu, ' ')
                                  .slice(0, 72)}
                              </Text>
                              <Text dimColor>
                                {'     '}
                                {point.fileChanges.length > 0
                                  ? point.fileChanges
                                      .map((path) =>
                                        path.startsWith(`${runtimeCwd}/`)
                                          ? path.slice(runtimeCwd.length + 1)
                                          : path,
                                      )
                                      .join(', ')
                                  : point.fileRestoreAvailable
                                    ? 'No code changes'
                                    : '⚠ No code restore'}
                              </Text>
                            </Box>
                          )
                        })}
                      {window.end < menu.points.length ? (
                        <Text dimColor>
                          {' '}
                          ↓ {menu.points.length - window.end} more below
                        </Text>
                      ) : null}
                    </>
                  )
                })()}
                <Text inverse={menu.selectedIndex === menu.points.length}>
                  {menu.selectedIndex === menu.points.length ? ' ❯ ' : '   '}
                  (current)
                </Text>
                <Text> </Text>
                <Text dimColor> Enter to continue · Esc to cancel</Text>
              </Box>
            ) : menu?.kind === 'rewind-confirm' ? (
              <DialogFrame
                title="Confirm restore point"
                screenReader={axScreenReader}
              >
                <Text>│ {menu.point.prompt}</Text>
                <Text> </Text>
                <Text>The conversation will be forked.</Text>
                <Text>
                  The code will{' '}
                  {menu.point.fileChanges.length > 0
                    ? `restore ${menu.point.fileChanges.join(', ')}.`
                    : 'be unchanged.'}
                </Text>
                <Text> </Text>
                {rewindActions(menu.point).map((option, index) => (
                  <Text
                    key={option.action}
                    inverse={menu.selectedIndex === index}
                  >
                    {menu.selectedIndex === index ? '❯ ' : '  '}
                    {index + 1}. {option.label}
                  </Text>
                ))}
                <Text> </Text>
                <Text color={activePalette.warning}>
                  ⚠ Rewinding does not affect files edited manually or via bash.
                </Text>
              </DialogFrame>
            ) : menu?.kind === 'rewind-context' ? (
              <DialogFrame
                title={`Summarize ${menu.direction === 'from' ? 'from' : 'up to'} here`}
                screenReader={axScreenReader}
              >
                <Text>
                  {menu.direction === 'from'
                    ? 'Messages after this point will be summarized.'
                    : 'Messages up to this point will be summarized.'}
                </Text>
                <Text> </Text>
                <Text>add context (optional): {input}</Text>
                <Text dimColor>Enter to summarize · Esc to go back</Text>
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
                <Text>
                  Are you sure you want to delete this permission rule?
                </Text>
                <Text> </Text>
                <Text inverse={!axScreenReader && menu.selectedIndex === 0}>
                  {selectionPrefix(menu.selectedIndex === 0, axScreenReader)}
                  1. Yes
                </Text>
                <Text inverse={!axScreenReader && menu.selectedIndex === 1}>
                  {selectionPrefix(menu.selectedIndex === 1, axScreenReader)}
                  2. No
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
                <Text inverse={!axScreenReader && menu.selectedIndex === 0}>
                  {selectionPrefix(menu.selectedIndex === 0, axScreenReader)}
                  1. Yes
                </Text>
                <Text inverse={!axScreenReader && menu.selectedIndex === 1}>
                  {selectionPrefix(menu.selectedIndex === 1, axScreenReader)}
                  2. No
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
              ) : menu.kind === 'config' ? (
                <ConfigDashboard
                  tab={menu.tab}
                  snapshot={menu.snapshot}
                  query={menu.query}
                  selectedIndex={menu.selectedIndex}
                  searchFocused={menu.searchFocused}
                  settings={[
                    {
                      label: 'Provider',
                      value: runtimeDisplay.model ?? 'default',
                    },
                    {
                      label: 'Permission mode',
                      value: runtimeDisplay.permissionMode ?? 'default',
                    },
                  ]}
                  status={{
                    version: runtimeDisplay.version,
                    sessionId: sessionId ?? 'new',
                    cwd: runtimeCwd,
                    model: runtimeDisplay.model ?? 'default',
                    settingSources: ['user', 'project', 'local'],
                  }}
                  usage={{
                    costUsd: costUsd ?? 0,
                    apiDurationMs: 0,
                    wallDurationMs: 0,
                    linesAdded: 0,
                    linesRemoved: 0,
                    usage: usage ?? { inputTokens: 0, outputTokens: 0 },
                  }}
                  stats={[]}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'mcp' ? (
                <McpPanel
                  model={menu.model}
                  state={menu.state}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'tasks' ? (
                <TaskPanel
                  tasks={menu.tasks}
                  state={menu.state}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'memory' ? (
                <MemoryDashboard
                  autoMemoryEnabled={menu.autoMemoryEnabled}
                  entries={menu.entries}
                  selectedIndex={menu.selectedIndex}
                  openedIndex={menu.openedIndex}
                  loading={menu.loading}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'hooks' ? (
                <HookDashboard
                  configuration={menu.configuration}
                  depth={menu.depth}
                  eventIndex={menu.eventIndex}
                  matcherIndex={menu.matcherIndex}
                  hookIndex={menu.hookIndex}
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
              ) : menu.kind === 'theme' ? (
                <ThemePicker
                  currentTheme={themeSettings.theme}
                  selectedIndex={menu.selectedIndex}
                  syntaxHighlightingDisabled={
                    themeSettings.syntaxHighlightingDisabled
                  }
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'export' ? (
                <SelectionMenu
                  title="Export conversation"
                  description="Select export method"
                  options={[
                    {
                      label: 'Copy to clipboard',
                      description:
                        'Copy the conversation to your system clipboard',
                    },
                    {
                      label: 'Save to file',
                      description:
                        'Save the conversation to a file in the current directory',
                    },
                  ]}
                  selectedIndex={menu.selectedIndex}
                  footer="Esc to cancel"
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
                  <Text color={activePalette.warning}>
                    Press Ctrl-C again to exit
                  </Text>
                ) : null}
                <Composer
                  input={shellMode ? input.slice(1) : input}
                  cursor={
                    shellMode ? Math.max(0, inputCursor - 1) : inputCursor
                  }
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
    </TuiThemeProvider>
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
  onBackground?: (
    request: InteractiveBackgroundRequest,
  ) => Promise<InteractiveBackgroundResult>
  onBackgrounded?: (result: InteractiveBackgroundResult) => void
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
  let initialThemeSettings = DEFAULT_TUI_THEME_SETTINGS
  let initialThemeLoadError: string | undefined
  try {
    initialThemeSettings = await loadTuiThemeSettings()
  } catch (error) {
    initialThemeLoadError = `Unable to load theme settings: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
  let activeTurn: Promise<void> | null = null
  let cleanup: Promise<void> | null = null
  let backgrounded: InteractiveBackgroundResult | undefined
  const instance = render(
    <InteractiveApp
      factory={options.factory}
      initialSessions={initialSessions}
      slashCommands={initialSlashCommands}
      agents={initialAgents}
      initialHistory={initialHistory}
      initialThemeSettings={initialThemeSettings}
      {...(initialThemeLoadError === undefined
        ? {}
        : { initialThemeLoadError })}
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
      {...(options.onBackground === undefined
        ? {}
        : {
            onBackground: async (request: InteractiveBackgroundRequest) => {
              const result = await options.onBackground?.(request)
              if (!result) throw new Error('Background launch returned no job')
              backgrounded = result
              return result
            },
          })}
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
  if (backgrounded) options.onBackgrounded?.(backgrounded)
  return signal.aborted ? 130 : 0
}
