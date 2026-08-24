import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

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
import type { ClaudeSessionCostSnapshot } from '../application/session-cost-tracker.js'
import type {
  ModelImage,
  ModelToolCall,
  ModelUsage,
  PermissionApproval,
  PermissionDecision,
  PermissionUpdate,
  RuntimeEvent,
  RuntimeEventSink,
} from '../core/runtime.js'
import { permissionRuleValueToString } from '../permissions/permission-updates.js'
import {
  resolveDataPlane,
  resolveDataPlaneRoot,
  type DataPlane,
} from '../persistence/data-plane.js'
import { AgentRunCancelledError } from '../core/runtime.js'
import type {
  CliElicitationRequest,
  CliElicitationResult,
  CliRuntimeInfo,
} from './protocol.js'
import type {
  ClaudeInteractiveToolCallbacks,
  ClaudePlanApprovalRequest,
  ClaudePlanApprovalResult,
  ClaudeQuestion,
  ClaudeQuestionResult,
} from '../tools/claude-interactive-tools.js'
import {
  claudePermissionActionKey,
  claudePermissionRuleMatches,
  type ClaudePermissionMode,
} from '../permissions/claude-permission-resolver.js'
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
  ModelMenu,
  SelectionMenu,
  SessionPicker,
  ThemePicker,
  CustomThemeEditor,
  SessionIdentity,
  Transcript,
  WelcomePanel,
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
import { loadClaudeReleaseNotes } from './tui/release-notes.js'
import {
  tuiInkRenderOptions,
  useTuiPresentationEnvironment,
} from './tui/presentation-environment.js'
import { StreamingFrameBuffer } from './tui/streaming-frame-buffer.js'
import { createClaudeStatusLineInput, StatusLine } from './tui/status-line.js'
import { createTuiAppendHistoryChange } from './tui/transcript-window-model.js'
import {
  createTuiHistoryChange,
  resolveTuiRenderer,
  type TuiHistoryChange,
} from './tui/tui-view-model.js'
import {
  projectTuiScreen,
  type TuiScreenInput,
  type TuiScreenModel,
} from './tui/tui-screen-model.js'
import {
  projectTuiHelpSurface,
  type TuiHelpSurfaceModel,
} from './tui/help-surface-model.js'
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
import {
  createRecentlyDeniedStore,
  type RecentlyDeniedAction,
  type RecentlyDeniedStore,
} from './tui/recently-denied.js'
import {
  agentColorMessage,
  parseAgentColorInput,
  type AgentColorSelection,
} from '../compatibility/claude/agent-color.js'
import type { AgentColorName } from '../compatibility/claude/agent-color.js'
import type { ClaudeResourceScope } from '../compatibility/claude/shared-resources.js'
import type { TuiHookConfiguration } from './tui/hook-settings.js'
import {
  filterTuiSlashCommands,
  mergeTuiSlashCommands,
  slashCommandQuery,
  type TuiSlashCommand,
} from './tui/slash-commands.js'
import {
  runDoctor,
  type DoctorProgressListener,
  type DoctorProgressReport,
  type DoctorReport,
} from '../maintenance/doctor.js'
import {
  canonicalClaudeCostModelName,
  formatCostSummary,
  type CostSummary,
} from './tui/cost-summary.js'
import {
  createComposerEditor,
  deleteComposerBackward,
  deleteComposerForward,
  insertComposerText,
  moveComposerCursor,
} from './tui/composer-editor.js'
import {
  routeComposerKey,
  type ComposerKeyProjection,
} from './tui/composer-key-router.js'
import {
  routeTuiInteraction,
  type TuiInteractionEffect,
  type TuiInteractionLayer,
  type TuiInteractionSnapshot,
  type TuiScrollIntent,
} from './tui/tui-interaction-router.js'
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
  insertComposerImageMarker,
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
  themeSettingsWithCustomTheme,
} from './tui/theme-settings.js'
import {
  DEFAULT_TUI_THEME_SETTINGS,
  TUI_THEMES,
  TuiThemeProvider,
  useTuiTheme,
  type TuiThemeSettings,
} from './tui/theme.js'
import {
  CUSTOM_THEME_TOKENS,
  createTuiCustomTheme,
  deleteTuiCustomTheme,
  loadTuiCustomThemes,
  updateTuiCustomTheme,
  type CustomThemeBase,
  type CustomThemeToken,
  type TuiCustomTheme,
} from './tui/custom-themes.js'
import {
  setupTuiTerminal,
  terminalSetupTuiSlashCommand,
} from './tui/terminal-setup.js'
import {
  commitElicitationText,
  createTuiElicitationForm,
  elicitationFormIsValid,
  elicitationTextValue,
  expandElicitationOptions,
  focusedElicitationField,
  McpElicitationForm,
  McpElicitationUrl,
  moveElicitationFocus,
  moveElicitationOption,
  selectElicitationOption,
  toggleElicitationBoolean,
  typeaheadElicitationOption,
  unsetElicitationField,
  validateTuiElicitationForm,
  type TuiElicitationFormState,
} from './tui/mcp-elicitation.js'
import { openTuiUrl } from './tui/open-url.js'
import { projectTuiToolPermission } from './tui/tool-permission.js'
import {
  projectTuiPermissionSurface,
  type TuiPermissionSurfaceModel,
} from './tui/permission-surface-model.js'
import { PermissionSurface } from './tui/permission-surface.js'
import {
  projectTuiDecisionSurface,
  type TuiDecisionSurfaceModel,
} from './tui/decision-surface-model.js'
import { DecisionSurface } from './tui/decision-surface.js'
import { ConfigDashboard, projectConfigRows } from './tui/config-dashboard.js'
import { DoctorDashboard } from './tui/doctor-dashboard.js'
import { SandboxDashboard, tuiSandboxTabs } from './tui/sandbox-dashboard.js'
import {
  createTuiSandboxStore,
  type TuiSandboxStore,
  type TuiSandboxTab,
} from './tui/sandbox-settings.js'
import {
  loadConfigSettings,
  saveConfigSetting,
  configSettingDefinition,
  resolveConfigSettingsLocation,
  type ConfigSettingsTarget,
} from './tui/config-settings.js'
import {
  projectRuntimeSettings,
  loadRuntimeSettings,
  type PraxisRuntimeSettings,
} from './tui/runtime-settings.js'
import {
  autoUpdateTarget,
  copyCandidates,
  externalEditorInitialContent,
  formatTurnDuration,
  questionTimeoutMilliseconds,
  sessionRecap,
  spinnerTip,
  shouldShowCopyPicker,
  type CopyCandidate,
} from './tui/runtime-interactions.js'
import {
  notifyTerminal,
  type TuiNotificationWriter,
} from './tui/terminal-notifications.js'
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
  runShell?(
    command: string,
    signal?: AbortSignal,
    sessionId?: string,
    name?: string,
  ): Promise<SessionRunResult>
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
  costSnapshot?(sessionId: string): Promise<ClaudeSessionCostSnapshot>
  compact?(
    sessionId: string,
    signal?: AbortSignal,
    selection?: ManualCompactSelection,
  ): Promise<ManualCompactResult>
  rewindFiles?(sessionId: string, userMessageId: string): Promise<void>
  rewindPoints?(sessionId: string): Promise<RewindPoint[]>
  changeCwd?(sessionId: string | undefined, cwd: string): Promise<string>
  notify?(
    sessionId: string | undefined,
    message: string,
    notificationType: string,
    title?: string,
  ): void
  recordCdUsage?(sessionId: string): Promise<void>
  approveRecentlyDenied?(sessionId: string, display: string): Promise<void>
  retryRecentlyDenied?(
    sessionId: string,
    display: string,
    signal?: AbortSignal,
  ): Promise<SessionRunResult>
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
  recordColorUsage?(
    sessionId: string | undefined,
    selection: AgentColorSelection,
    display: string,
    permissionMode?: ClaudePermissionMode,
  ): Promise<string>
  agentColor?(sessionId: string): Promise<AgentColorName | undefined>
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
  backgroundForegroundTask?(sessionId: string): void | Promise<void>
  mcpInspect?(): Promise<readonly ClaudeMcpServerStatus[]>
  mcpReconnect?(name: string): Promise<void>
  mcpAuthenticate?(name: string): Promise<void>
  mcpReload?(): Promise<void>
  mcpTools?(name: string): Promise<readonly ClaudeMcpToolInspection[]>
  hookConfiguration?(): Promise<TuiHookConfiguration>
  slashCommands?(): readonly TuiSlashCommand[]
  agentDefinitions?(): readonly TuiAgentEntry[]
  runtimeInfo?(): CliRuntimeInfo
  initialAgentPrompt?(): string | undefined
  setPermissionMode?(
    sessionId: string,
    mode: ClaudePermissionMode,
  ): Promise<void>
  nextScheduledPrompt?(
    signal?: AbortSignal,
  ): Promise<{ id: string; prompt: string } | null>
  transitionHookSession?(
    sessionId: string,
    reason: 'clear' | 'resume',
  ): Promise<void>
  close?(): Promise<void>
}

export interface InteractiveServiceFactory {
  scheduledPrompts?: boolean
  createService(options: {
    eventSink: RuntimeEventSink
    requireProvider: boolean
    hooksOnly?: boolean
    approveRecovery?: (call: ModelToolCall) => boolean | Promise<boolean>
    approveTool?: (
      call: ModelToolCall,
      originalCall?: ModelToolCall,
      decision?: PermissionDecision,
    ) => PermissionApproval | Promise<PermissionApproval>
    onElicitation?: (
      request: CliElicitationRequest,
    ) => Promise<CliElicitationResult>
    askUser?: ClaudeInteractiveToolCallbacks['askUser']
    approvePlan?: ClaudeInteractiveToolCallbacks['approvePlan']
    agent?: string
    model?: string
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    permissionMode?: ClaudePermissionMode
    isSessionActionApproved?: (call: ModelToolCall) => boolean
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
  dataPlane?: DataPlane
  configRoot?: string
  statePath?: string
  factory: InteractiveServiceFactory
  initialSessions: readonly SessionSummary[]
  initialPrompt?: string
  initialHistory?: readonly TranscriptItem[]
  initialSessionColor?: AgentColorName
  signal?: AbortSignal
  onCancel?: () => void
  onTurnChange?: (turn: Promise<void> | null) => void
  onCleanup?: (closing: Promise<void>) => void
  onRendererChange?: (
    mode: PraxisRuntimeSettings['tui'],
    sessionId: string | null,
  ) => void
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
  doctorLoader?: (onProgress?: DoctorProgressListener) => Promise<DoctorReport>
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
  sandboxStore?: TuiSandboxStore
  recentlyDeniedStore?: RecentlyDeniedStore
  themeStore?: {
    load(): Promise<TuiThemeSettings>
    save(update: Partial<TuiThemeSettings>): Promise<TuiThemeSettings>
    loadCustomThemes?(): Promise<readonly TuiCustomTheme[]>
    createCustomTheme?(input: {
      name: string
      base: CustomThemeBase
    }): Promise<TuiCustomTheme>
    updateCustomTheme?(
      theme: TuiCustomTheme,
      token: CustomThemeToken,
      value: string | undefined,
    ): Promise<TuiCustomTheme>
    deleteCustomTheme?(theme: TuiCustomTheme): Promise<void>
  }
  terminalSetup?: () => Promise<string>
  initialThemeSettings?: TuiThemeSettings
  initialThemeLoadError?: string
  workspaceDirectoryResolver?: typeof resolveTuiWorkspaceDirectory
  workspaceDirectoryCompleter?: typeof completeTuiWorkspaceDirectory
  runtimeSettings?: PraxisRuntimeSettings
  runtimeSettingsTarget?: ConfigSettingsTarget
  notificationWriter?: TuiNotificationWriter
  notificationDelayMs?: number
  elicitationUrlOpener?: (url: string) => void | Promise<void>
  releaseNotesLoader?: (configRoot: string) => Promise<string>
  settingSources?: readonly ClaudeResourceScope[]
}

type PendingPermission = {
  kind: 'tool' | 'recovery'
  call: ModelToolCall
  decision?: PermissionDecision
  notificationTimer: ReturnType<typeof setTimeout> | null
  settled: boolean
  settle: (approval: PermissionApproval) => void
  resolve: (approval: PermissionApproval) => void
}

type PendingElicitation = {
  request: CliElicitationRequest
  resolve: (
    result: CliElicitationResult,
    options?: { keepUrlDialog?: boolean },
  ) => void
}

type PendingQuestion = {
  questions: readonly ClaudeQuestion[]
  index: number
  answers: Readonly<Record<string, string>>
  resolve: (result: ClaudeQuestionResult | null) => void
}

type PendingPlanApproval = {
  request: ClaudePlanApprovalRequest
  resolve: (approval: ClaudePlanApprovalResult) => void
}

const EMPTY_SLASH_COMMANDS: readonly TuiSlashCommand[] = []
const EMPTY_AGENTS: readonly TuiAgentEntry[] = []

const estimateFileTokens = async (path: string): Promise<number> => {
  try {
    const content = await readFile(path, 'utf8')
    if (!content.trim()) return 0
    return Math.max(1, Math.round(content.length / 4))
  } catch {
    return 0
  }
}

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
  | {
      kind: 'help'
      invocation: '?' | '/help'
      tabIndex: number
      selectedIndex: number
    }
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
      kind: 'sandbox'
      tab: TuiSandboxTab
      selectedIndex: number
      snapshot: Awaited<ReturnType<TuiSandboxStore['load']>>
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
  | {
      kind: 'custom-theme-create'
      base: CustomThemeBase
    }
  | {
      kind: 'custom-theme-editor'
      theme: TuiCustomTheme
      selectedIndex: number
      query: string
    }
  | {
      kind: 'custom-theme-token'
      theme: TuiCustomTheme
      token: CustomThemeToken
    }
  | {
      kind: 'custom-theme-delete'
      theme: TuiCustomTheme
      selectedIndex: number
    }
  | { kind: 'export'; selectedIndex: number }
  | {
      kind: 'copy'
      candidates: readonly CopyCandidate[]
      selectedIndex: number
      messageAge: number
    }
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
  | {
      kind: 'agents'
      agents: readonly TuiAgentEntry[]
      selectedIndex: number
    }
  | {
      kind: 'config'
      generation: number
      snapshot: Awaited<ReturnType<typeof loadConfigSettings>>
      tab: ConfigDashboardTab
      selectedIndex: number
      query: string
      searchFocused: boolean
      usage: CostSummary
    }
  | {
      kind: 'doctor'
      generation: number
      loading: boolean
      report: DoctorReport | DoctorProgressReport | null
      error: string | null
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

const ZERO_COST_SUMMARY: CostSummary = {
  totalCostUsd: 0,
  apiDurationMs: 0,
  wallDurationMs: 0,
  linesAdded: 0,
  linesRemoved: 0,
  hasUnknownModelCost: false,
  modelUsage: [],
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

function describeTool(
  call: ModelToolCall,
  sensitiveValues: readonly string[],
): string {
  const name = redactSensitiveText(call.name, sensitiveValues)
  return `${name} ${describeToolInput(call, sensitiveValues)}`
}

function describeRecentlyDeniedAction(
  call: ModelToolCall,
  sensitiveValues: readonly string[],
): string {
  const description = call.input.description
  return typeof description === 'string' && description.trim()
    ? redactSensitiveText(description.trim(), sensitiveValues)
    : describeTool(call, sensitiveValues)
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

const HIDDEN_TUI_SLASH_COMMANDS = new Set([
  'background',
  'new',
  'output-style',
  'reload-skills',
  'sessions',
  'skill',
  'terminal-setup',
  'update',
  'usage',
])

function RewindWarning() {
  const theme = useTuiTheme()
  return (
    <Text {...theme.text.warning}>
      ⚠ Rewinding does not affect files edited manually or via bash.
    </Text>
  )
}

function ExitWarning() {
  const theme = useTuiTheme()
  return <Text {...theme.text.warning}>Press Ctrl-C again to exit</Text>
}

function DecisionOption({
  selected,
  screenReader,
  children,
  selectedPrefix = '❯ ',
  unselectedPrefix = '  ',
}: {
  selected: boolean
  screenReader: boolean
  children: ReactNode
  selectedPrefix?: string
  unselectedPrefix?: string
}) {
  const theme = useTuiTheme()
  const accessible = screenReader || theme.noColor
  return (
    <Text {...(selected ? theme.text.selectedRow : {})}>
      {selected
        ? accessible
          ? 'Selected: '
          : selectedPrefix
        : accessible
          ? ''
          : unselectedPrefix}
      {children}
    </Text>
  )
}

export interface InteractiveHistoryState {
  readonly items: TranscriptItem[]
  readonly change: TuiHistoryChange
}

/** Advances the React-owned transcript plus its exact local mutation fact. */
export function advanceInteractiveHistoryState(
  current: InteractiveHistoryState,
  items: TranscriptItem[],
  changedFrom: number,
): InteractiveHistoryState {
  if (
    !Number.isInteger(changedFrom) ||
    changedFrom < 0 ||
    changedFrom > items.length
  )
    throw new RangeError('changedFrom must be a valid next-history index')
  const revision = current.change.revision + 1
  return {
    items,
    change:
      changedFrom === current.items.length && items.length > changedFrom
        ? createTuiAppendHistoryChange(revision, current.items, items)
        : createTuiHistoryChange(revision, changedFrom, items, current.items),
  }
}

export function InteractiveApp({
  dataPlane = resolveDataPlane(),
  configRoot: suppliedConfigRoot,
  statePath: suppliedStatePath,
  factory,
  initialSessions,
  initialPrompt,
  initialHistory = [],
  initialSessionColor,
  signal,
  onCancel,
  onTurnChange,
  onCleanup,
  onRendererChange,
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
  doctorLoader,
  fileLoader,
  externalEditor = editTuiPrompt,
  keybindingsConfigRoot,
  keybindingsFile = ensureTuiKeybindingsFile,
  keybindingsLoader = loadTuiKeybindings,
  keybindingsEditor = openTuiEditorFile,
  memoryFilesLoader,
  memoryEditor = openTuiEditorFile,
  memoryFolderOpener = openTuiMemoryFolder,
  suspendProcess = suspendTuiProcess,
  clipboardReader = readTuiClipboard,
  clipboardWriter = writeTuiClipboard,
  sideQuestionClipboardWriter = writeTuiOsc52Clipboard,
  exportWriter = writeConversationExport,
  permissionRuleStore,
  sandboxStore: suppliedSandboxStore,
  recentlyDeniedStore: suppliedRecentlyDeniedStore,
  terminalSetup: terminalSetupOverride,
  themeStore,
  initialThemeSettings,
  initialThemeLoadError,
  workspaceDirectoryResolver = resolveTuiWorkspaceDirectory,
  workspaceDirectoryCompleter = completeTuiWorkspaceDirectory,
  runtimeSettings: suppliedRuntimeSettings,
  runtimeSettingsTarget,
  notificationWriter,
  notificationDelayMs = 6_000,
  elicitationUrlOpener = openTuiUrl,
  releaseNotesLoader = (configRoot) => loadClaudeReleaseNotes({ configRoot }),
  settingSources,
}: InteractiveAppProps) {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp()
  const settingsDirectory = dataPlane === 'native' ? '.praxis' : '.claude'
  const keybindingsRoot = useMemo(
    () =>
      resolve(
        suppliedConfigRoot ??
          keybindingsConfigRoot ??
          resolveDataPlaneRoot({ dataPlane }),
      ),
    [dataPlane, keybindingsConfigRoot, suppliedConfigRoot],
  )
  const configTarget = useMemo(
    () =>
      runtimeSettingsTarget === undefined
        ? {
            configRoot: keybindingsRoot,
            statePath:
              suppliedStatePath ??
              (dataPlane === 'native'
                ? join(keybindingsRoot, 'state.json')
                : process.env.CLAUDE_CONFIG_DIR
                  ? join(keybindingsRoot, '.claude.json')
                  : resolve(homedir(), '.claude.json')),
          }
        : resolveConfigSettingsLocation(runtimeSettingsTarget),
    [dataPlane, keybindingsRoot, runtimeSettingsTarget, suppliedStatePath],
  )
  const loadMemoryFiles = useMemo(
    () =>
      memoryFilesLoader ??
      ((configRoot: string, cwd: string) =>
        loadTuiMemoryFiles({ configRoot, cwd, dataPlane })),
    [dataPlane, memoryFilesLoader],
  )
  const sensitiveValues = useMemo(
    () => sensitiveEnvironmentValues(process.env),
    [],
  )
  const [runtimeCwd, setRuntimeCwd] = useState(display.cwd)
  const runtimeCwdRef = useRef(display.cwd)
  const runtimeGitignoreRef = useRef(true)
  const loadDiffSnapshot = useMemo(
    () => diffLoader ?? (() => loadGitDiff(runtimeCwd)),
    [diffLoader, runtimeCwd],
  )
  const loadDoctorReport = useMemo(
    () =>
      doctorLoader ??
      (async (onProgress?: DoctorProgressListener) => {
        const runtimeSettings = await loadRuntimeSettings(configTarget)
        return runDoctor({
          dataPlane,
          version: display.version,
          executablePath: resolve(
            process.argv[1] ??
              fileURLToPath(new URL('../cli.js', import.meta.url)),
          ),
          nodeExecutablePath: process.execPath,
          nodeVersion: process.version,
          configRoot: configTarget.configRoot,
          claudeStatePath: configTarget.statePath,
          cwd: runtimeCwd,
          environment: process.env,
          autoUpdateChannel: runtimeSettings.autoUpdatesChannel,
          ...(process.argv[1] === undefined
            ? {}
            : { invokedBinaryPath: process.argv[1] }),
          ...(onProgress === undefined ? {} : { onProgress }),
        })
      }),
    [doctorLoader, runtimeCwd, display.version, configTarget, dataPlane],
  )
  const loadFiles = useMemo(
    () =>
      fileLoader ??
      (() =>
        loadTuiFileEntries(runtimeCwd, {
          respectGitignore: runtimeGitignoreRef.current,
        })),
    [fileLoader, runtimeCwd],
  )
  const permissionStore = useMemo(
    () =>
      permissionRuleStore ?? {
        load: () =>
          loadTuiPermissionRules(runtimeCwd, keybindingsRoot, dataPlane),
        add: (input: {
          behavior: TuiPermissionBehavior
          rule: string
          scope: ClaudeResourceScope
        }) =>
          addTuiPermissionRule({
            cwd: runtimeCwd,
            configRoot: keybindingsRoot,
            dataPlane,
            ...input,
          }),
        remove: removeTuiPermissionRule,
      },
    [dataPlane, keybindingsRoot, permissionRuleStore, runtimeCwd],
  )
  const recentDeniedStore = useMemo(
    () => suppliedRecentlyDeniedStore ?? createRecentlyDeniedStore(),
    [suppliedRecentlyDeniedStore],
  )
  const presentationThemeStore = useMemo(
    () =>
      themeStore ?? {
        load: () => loadTuiThemeSettings(keybindingsRoot),
        save: (update: Partial<TuiThemeSettings>) =>
          saveTuiThemeSettings(update, keybindingsRoot),
        loadCustomThemes: () => loadTuiCustomThemes(keybindingsRoot),
        createCustomTheme: (input: { name: string; base: CustomThemeBase }) =>
          createTuiCustomTheme({ ...input, configRoot: keybindingsRoot }),
        updateCustomTheme: (
          theme: TuiCustomTheme,
          token: CustomThemeToken,
          value: string | undefined,
        ) => updateTuiCustomTheme(theme, token, value, keybindingsRoot),
        deleteCustomTheme: (theme: TuiCustomTheme) =>
          deleteTuiCustomTheme(theme, keybindingsRoot),
      },
    [keybindingsRoot, themeStore],
  )
  const [customThemes, setCustomThemes] = useState<readonly TuiCustomTheme[]>(
    [],
  )
  const [themeSettings, setThemeSettings] = useState<TuiThemeSettings>(
    initialThemeSettings ?? DEFAULT_TUI_THEME_SETTINGS,
  )
  const [runtimeSettings, setRuntimeSettings] = useState<PraxisRuntimeSettings>(
    suppliedRuntimeSettings ??
      projectRuntimeSettings({ settings: {}, state: {} }),
  )
  const presentation = useTuiPresentationEnvironment({
    renderer: runtimeSettings.tui,
    screenReader: axScreenReader,
    ...(terminalWidth === undefined
      ? {}
      : { viewportOverride: { columns: terminalWidth } }),
  })
  const width = presentation.viewport.columns
  const rows = presentation.viewport.rows
  const fixedViewport = presentation.fixedViewport
  const runtimeSettingsRef = useRef(runtimeSettings)
  runtimeSettingsRef.current = runtimeSettings
  runtimeGitignoreRef.current = runtimeSettings.gitignore
  const [vimInsertMode, setVimInsertMode] = useState(true)
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
  const statusLineSessionId = useRef(resume?.sessionId ?? randomUUID())
  const sessionIdRef = useRef<string | null>(resume?.sessionId ?? null)
  sessionIdRef.current = sessionId
  const [sessionColor, setSessionColor] = useState<AgentColorName | undefined>(
    initialSessionColor,
  )
  const [sessionName, setSessionName] = useState<string | null>(null)
  const [activeSessionSummary, setActiveSessionSummary] = useState<
    SessionSummary | undefined
  >(() =>
    resume?.sessionId
      ? initialSessions.find(
          (session) => session.sessionId === resume.sessionId,
        )
      : undefined,
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
  const configOpenGenerationRef = useRef(0)
  const configUsageRequestRef = useRef(0)
  const configOperationRef = useRef<Promise<void> | null>(null)
  const doctorMenuGenerationRef = useRef(0)
  const doctorOperationRef = useRef<Promise<void> | null>(null)
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
  // One provider-neutral streaming frame buffer per mounted app. RuntimeEvent
  // text/thinking deltas accumulate here and are coalesced into bounded frames
  // instead of causing a React state update per delta. The React state is only
  // ever written through the buffer's publish callback so the buffer's committed
  // prefix and the displayed text stay in sync. Disposed on unmount.
  const streamingFrameRef = useRef<StreamingFrameBuffer | null>(null)
  if (streamingFrameRef.current === null) {
    streamingFrameRef.current = new StreamingFrameBuffer({
      publish: (frame) => {
        setActiveText(frame.text)
        setActiveThinking(frame.thinking)
      },
    })
  }
  const [thinkingExpanded, setThinkingExpanded] = useState(false)
  const [turnDuration, setTurnDuration] = useState<number | undefined>()
  const [usage, setUsage] = useState<ModelUsage | undefined>()
  const [costUsd, setCostUsd] = useState<number | undefined>()
  const [contextWindowTokens, setContextWindowTokens] = useState(
    display.contextWindowTokens,
  )
  const [historyState, setHistoryState] = useState(() => {
    const items = [...initialHistory]
    return {
      items,
      change: createTuiHistoryChange(0, 0, items),
    }
  })
  const history = historyState.items
  const setHistory = (
    update:
      TranscriptItem[] | ((current: TranscriptItem[]) => TranscriptItem[]),
    knownChangedFrom?:
      number | ((current: TranscriptItem[], next: TranscriptItem[]) => number),
  ) => {
    setHistoryState((current) => {
      const next = typeof update === 'function' ? update(current.items) : update
      let changedFrom =
        typeof knownChangedFrom === 'function'
          ? knownChangedFrom(current.items, next)
          : (knownChangedFrom ?? 0)
      if (knownChangedFrom === undefined) {
        const limit = Math.min(next.length, current.items.length)
        while (
          changedFrom < limit &&
          next[changedFrom] === current.items[changedFrom]
        )
          changedFrom += 1
      }
      return advanceInteractiveHistoryState(current, next, changedFrom)
    })
  }
  const activeAttemptThinkingItemsRef = useRef<TranscriptItem[]>([])
  const [transcriptScrollOffset, setTranscriptScrollOffsetState] = useState(0)
  const transcriptScrollOffsetRef = useRef(0)
  const setTranscriptScrollOffset = (offset: number) => {
    transcriptScrollOffsetRef.current = offset
    setTranscriptScrollOffsetState(offset)
  }
  const sessionLoadRef = useRef(0)
  const [turnDiffs, setTurnDiffs] = useState<
    readonly { label: string; snapshot: TuiDiffSnapshot }[]
  >([])
  const turnNumberRef = useRef(0)
  const turnMutatedFilesRef = useRef(false)
  const permissionCallsRef = useRef(new Map<string, ModelToolCall>())
  const approvedSessionActionsRef = useRef(new Map<string, Set<string>>())
  const [recentDenied, setRecentDenied] = useState<
    readonly RecentlyDeniedAction[]
  >([])
  const [retryingDeniedId, setRetryingDeniedId] = useState<string | null>(null)
  const recentDeniedRef = useRef<readonly RecentlyDeniedAction[]>([])
  recentDeniedRef.current = recentDenied
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
  const sandboxStore = useMemo(
    () =>
      suppliedSandboxStore ??
      createTuiSandboxStore({
        configRoot: keybindingsRoot,
        cwd: runtimeCwd,
        homeDirectory: homedir(),
        additionalDirectories: runtimePreferences.additionalDirectories,
        dataPlane,
      }),
    [
      keybindingsRoot,
      runtimeCwd,
      runtimePreferences.additionalDirectories,
      suppliedSandboxStore,
      dataPlane,
    ],
  )
  const runtimePreferencesRef = useRef(runtimePreferences)
  const [permission, setPermission] = useState<PendingPermission | null>(null)
  const permissionRef = useRef<PendingPermission | null>(null)
  const permissionQueueRef = useRef<PendingPermission[]>([])
  const [permissionSelection, setPermissionSelection] = useState(0)
  const [permissionFeedbackMode, setPermissionFeedbackMode] = useState(false)
  const [permissionRuleEditor, setPermissionRuleEditor] = useState<ReturnType<
    typeof createComposerEditor
  > | null>(null)
  const immediatePermissionRulesRef = useRef<string[]>([])
  const toolPermissionModel = useMemo(
    () =>
      permission?.kind === 'tool'
        ? projectTuiToolPermission(
            permission.call,
            runtimeCwd,
            sensitiveValues,
            permission.decision,
            dataPlane,
          )
        : null,
    [dataPlane, permission, runtimeCwd, sensitiveValues],
  )

  const activatePermission = (pending: PendingPermission) => {
    const projected =
      pending.kind === 'tool'
        ? projectTuiToolPermission(
            pending.call,
            runtimeCwdRef.current,
            sensitiveValues,
            pending.decision,
            dataPlane,
          )
        : null
    const editableRule = projected?.options.find(
      (option) => option.editableRule,
    )?.editableRule
    clearComposerInput()
    setPermissionSelection(0)
    setPermissionFeedbackMode(false)
    setPermissionRuleEditor(
      editableRule ? createComposerEditor(editableRule.initialValue) : null,
    )
    permissionRef.current = pending
    setPermission(pending)
    pending.notificationTimer = setTimeout(() => {
      if (pending.settled) return
      serviceRef.current?.notify?.(
        sessionIdRef.current ?? undefined,
        `Approval required for ${pending.call.name}`,
        'permission_prompt',
        'Praxis',
      )
    }, notificationDelayMs)
  }

  const resolvePermission = (
    pending: PendingPermission,
    approval: PermissionApproval,
  ) => {
    if (pending.settled) return
    pending.settled = true
    if (pending.notificationTimer) {
      clearTimeout(pending.notificationTimer)
      pending.notificationTimer = null
    }
    const queue = permissionQueueRef.current
    const index = queue.indexOf(pending)
    if (index >= 0) queue.splice(index, 1)
    if (permissionRef.current === pending) {
      permissionRef.current = null
      setPermission((current) => (current === pending ? null : current))
    }
    pending.settle(approval)
    const next = queue[0]
    if (next) activatePermission(next)
  }

  const drainPermissionQueue = () => {
    const queued = permissionQueueRef.current.splice(0)
    permissionRef.current = null
    setPermission(null)
    for (const pending of queued) {
      if (pending.settled) continue
      pending.settled = true
      if (pending.notificationTimer) {
        clearTimeout(pending.notificationTimer)
        pending.notificationTimer = null
      }
      pending.settle(false)
    }
  }
  const [elicitation, setElicitation] = useState<PendingElicitation | null>(
    null,
  )
  const elicitationRef = useRef<PendingElicitation | null>(null)
  const [elicitationForm, setElicitationForm] =
    useState<TuiElicitationFormState | null>(null)
  const [elicitationUrlWaiting, setElicitationUrlWaiting] = useState(false)
  const elicitationUrlWaitingRef = useRef<PendingElicitation | null>(null)
  const [question, setQuestion] = useState<PendingQuestion | null>(null)
  const questionRef = useRef<PendingQuestion | null>(null)
  const questionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recapShownRef = useRef(false)
  const [planApproval, setPlanApproval] = useState<PendingPlanApproval | null>(
    null,
  )
  const planApprovalRef = useRef<PendingPlanApproval | null>(null)
  const [planApprovalSelection, setPlanApprovalSelection] = useState(0)
  const [planApprovalFeedbackMode, setPlanApprovalFeedbackMode] =
    useState(false)
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
        ...availableSlashCommands.map((command) =>
          dataPlane === 'native' && command.name === 'agents'
            ? {
                ...command,
                description:
                  '(removed) Ask Praxis to create/manage subagents, or edit .praxis/agents/',
              }
            : command,
        ),
      ]),
    [availableSlashCommands, dataPlane, terminalSetupCommand],
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
  const commandArgumentHint = useMemo(() => {
    if (shellMode || !input.startsWith('/')) return undefined
    if (inputCursor !== input.length) return undefined
    const match = /^\/(\S+) $/u.exec(input)
    if (!match?.[1]) return undefined
    const command = allSlashCommands.find(
      (candidate) => candidate.name === match[1],
    )
    return command?.argumentHint
  }, [allSlashCommands, input, inputCursor, shellMode])
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
  const workspaceDirectories = useMemo(
    () =>
      [
        runtimeCwd,
        ...runtimePreferences.additionalDirectories.filter(
          (path) => path !== runtimeCwd,
        ),
      ].map((path) => ({ path, original: path === runtimeCwd })),
    [runtimeCwd, runtimePreferences.additionalDirectories],
  )
  const permissionPrioritySurface =
    useMemo<TuiPermissionSurfaceModel | null>(() => {
      if (!permission) return null
      if (permission.kind === 'tool' && toolPermissionModel) {
        return projectTuiPermissionSurface({
          kind: 'tool-request',
          model: toolPermissionModel,
          selection: permissionSelection,
          feedbackMode: permissionFeedbackMode,
          feedback: input,
          ruleEditor: permissionRuleEditor,
        })
      }
      return projectTuiPermissionSurface({
        kind: 'recovery-request',
        heading: `Retry interrupted ${permission.call.name}?`,
        display: describeTool(permission.call, sensitiveValues),
        selection: permissionSelection,
        feedbackMode: permissionFeedbackMode,
        feedback: input,
      })
    }, [
      input,
      permission,
      permissionFeedbackMode,
      permissionRuleEditor,
      permissionSelection,
      sensitiveValues,
      toolPermissionModel,
    ])
  const permissionManagementSurface =
    useMemo<TuiPermissionSurfaceModel | null>(() => {
      if (!menu) return null
      switch (menu.kind) {
        case 'permission-dashboard':
          return projectTuiPermissionSurface({
            kind: menu.kind,
            tabIndex: menu.tabIndex,
            selectedIndex: menu.selectedIndex,
            query: menu.query,
            rules: menu.rules,
            recentDenied,
            retryingDeniedId,
            workspaceDirectories,
          })
        case 'permission-rule-input':
          return projectTuiPermissionSurface({
            kind: menu.kind,
            behavior: menu.behavior,
            value: input,
          })
        case 'permission-scope':
          return projectTuiPermissionSurface({
            kind: menu.kind,
            behavior: menu.behavior,
            rule: menu.rule,
            selectedIndex: menu.selectedIndex,
            settingsDirectory,
          })
        case 'permission-delete':
          return projectTuiPermissionSurface({
            kind: menu.kind,
            rule: menu.rule,
            selectedIndex: menu.selectedIndex,
          })
        case 'workspace-directory-input':
          return projectTuiPermissionSurface({
            kind: menu.kind,
            value: input,
          })
        case 'workspace-directory-delete':
          return projectTuiPermissionSurface({
            kind: menu.kind,
            path: menu.path,
            selectedIndex: menu.selectedIndex,
          })
        default:
          return null
      }
    }, [
      input,
      menu,
      recentDenied,
      retryingDeniedId,
      settingsDirectory,
      workspaceDirectories,
    ])
  type InteractiveSecondarySurface =
    | TuiHelpSurfaceModel
    | TuiPermissionSurfaceModel
    | { readonly kind: 'legacy-secondary' }
  const legacySecondarySurface = useMemo(
    () => ({ kind: 'legacy-secondary' as const }),
    [],
  )
  const helpMenu = menu?.kind === 'help' ? menu : null
  const helpSurface = useMemo(
    () =>
      helpMenu === null
        ? null
        : projectTuiHelpSurface({
            invocation: helpMenu.invocation,
            tabIndex: helpMenu.tabIndex,
            selectedIndex: helpMenu.selectedIndex,
            builtinCommands: builtinSlashCommands,
            customCommands: customSlashCommands,
          }),
    [helpMenu, builtinSlashCommands, customSlashCommands],
  )
  const shortcutHelpSurface = useMemo(
    () =>
      projectTuiHelpSurface({
        invocation: '?',
        tabIndex: 0,
        selectedIndex: 0,
        builtinCommands: builtinSlashCommands,
        customCommands: customSlashCommands,
      }),
    [builtinSlashCommands, customSlashCommands],
  )
  const decisionElevatedMode = runtimeSettings.useAutoModeDuringPlan
    ? 'auto'
    : allowDangerouslySkipPermissions
      ? 'bypassPermissions'
      : 'acceptEdits'
  const planDecisionSurface = useMemo<TuiDecisionSurfaceModel | null>(
    () =>
      planApproval
        ? projectTuiDecisionSurface({
            kind: 'plan-approval',
            request: planApproval.request,
            selectedIndex: planApprovalSelection,
            feedbackMode: planApprovalFeedbackMode,
            feedback: input,
            elevatedMode: decisionElevatedMode,
          })
        : null,
    [
      planApproval,
      planApprovalFeedbackMode,
      planApprovalSelection,
      input,
      decisionElevatedMode,
    ],
  )
  const questionDecisionSurface = useMemo<TuiDecisionSurfaceModel | null>(
    () =>
      question
        ? projectTuiDecisionSurface({
            kind: 'question',
            questions: question.questions,
            questionIndex: question.index,
            answer: input,
          })
        : null,
    [question, input],
  )
  const secondarySurface: InteractiveSecondarySurface | undefined =
    menu === null
      ? undefined
      : menu.kind === 'help'
        ? (helpSurface ?? undefined)
        : (permissionManagementSurface ?? legacySecondarySurface)
  type InteractiveTuiScreenSurfaces = {
    readonly sessionPicker: { readonly kind: 'session-picker' }
    readonly priority:
      | { readonly kind: 'editor-wait' }
      | {
          readonly kind: 'permission'
          readonly surface: TuiPermissionSurfaceModel
        }
      | TuiDecisionSurfaceModel
      | { readonly kind: 'elicitation' }
    readonly overlay:
      | { readonly kind: 'command-palette' }
      | { readonly kind: 'file-picker' }
      | { readonly kind: 'exit-confirmation' }
    readonly secondary: InteractiveSecondarySurface
  }
  const screenSurfaces = useMemo<
    TuiScreenInput<InteractiveTuiScreenSurfaces>['surfaces']
  >(
    () => ({
      ...(selectingSession
        ? { sessionPicker: { kind: 'session-picker' } }
        : {}),
      ...(externalEditorRequest !== null ||
      keybindingsEditing ||
      memoryEditorRequest !== null
        ? { priority: { kind: 'editor-wait' } }
        : permission !== null && permissionPrioritySurface !== null
          ? {
              priority: {
                kind: 'permission',
                surface: permissionPrioritySurface,
              },
            }
          : planApproval !== null && planDecisionSurface !== null
            ? { priority: planDecisionSurface }
            : question !== null && questionDecisionSurface !== null
              ? { priority: questionDecisionSurface }
              : elicitation !== null
                ? { priority: { kind: 'elicitation' } }
                : {}),
      ...(secondarySurface === undefined
        ? {}
        : { secondary: secondarySurface }),
      overlays: [
        ...(commandPaletteVisible
          ? [{ kind: 'command-palette' as const }]
          : []),
        ...(filePickerVisible ? [{ kind: 'file-picker' as const }] : []),
        ...(exitConfirmation ? [{ kind: 'exit-confirmation' as const }] : []),
      ],
    }),
    [
      selectingSession,
      externalEditorRequest,
      keybindingsEditing,
      memoryEditorRequest,
      permission,
      permissionPrioritySurface,
      planApproval,
      question,
      planDecisionSurface,
      questionDecisionSurface,
      elicitation,
      secondarySurface,
      commandPaletteVisible,
      filePickerVisible,
      exitConfirmation,
    ],
  )
  const previousTuiScreenRef = useRef<
    TuiScreenModel<InteractiveTuiScreenSurfaces> | undefined
  >(undefined)
  const screen = useMemo(
    () =>
      projectTuiScreen<InteractiveTuiScreenSurfaces>(
        {
          presentation,
          conversation: {
            initialHistory,
            history,
            resumeRequested: resume !== undefined,
            scrollOffset: transcriptScrollOffset,
            detailed: thinkingExpanded || runtimeSettings.verbose,
            activeText,
            activeThinking,
            historyChange: historyState.change,
          },
          sessionId,
          surfaces: screenSurfaces,
        },
        previousTuiScreenRef.current,
      ),
    [
      presentation,
      initialHistory,
      history,
      resume,
      transcriptScrollOffset,
      thinkingExpanded,
      runtimeSettings.verbose,
      activeText,
      activeThinking,
      historyState.change,
      sessionId,
      screenSurfaces,
    ],
  )
  useEffect(() => {
    previousTuiScreenRef.current = screen
  }, [screen])
  const conversationScreen =
    screen.body.kind === 'conversation' ? screen.body : undefined
  const selectedPriority =
    conversationScreen?.foreground.kind === 'priority'
      ? conversationScreen.foreground.surface
      : undefined
  const selectedSecondarySurface =
    conversationScreen?.foreground.kind === 'secondary'
      ? (conversationScreen.foreground.surface ?? null)
      : null
  const selectedOverlays =
    conversationScreen?.foreground.kind === 'compose'
      ? conversationScreen.foreground.overlays
      : []
  const selectedCommandPalette = selectedOverlays.find(
    (overlay) => overlay.kind === 'command-palette',
  )
  const selectedFilePicker = selectedOverlays.find(
    (overlay) => overlay.kind === 'file-picker',
  )
  const selectedExitConfirmation = selectedOverlays.find(
    (overlay) => overlay.kind === 'exit-confirmation',
  )
  const transcriptPageRows = conversationScreen?.transcript.pageRows ?? 2
  const maxTranscriptScrollOffset =
    conversationScreen?.transcript.maxScrollOffset ?? 0
  const statusAuthSource = process.env.PRAXIS_API_KEY
    ? 'PRAXIS_API_KEY'
    : process.env.ANTHROPIC_API_KEY
      ? 'ANTHROPIC_API_KEY'
      : undefined
  const statusBaseUrl = process.env.PRAXIS_BASE_URL
  const statusProxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.ALL_PROXY ??
    process.env.HTTP_PROXY
  const statusSettingSources = (() => {
    const projectSettings =
      existsSync(
        join(
          runtimeCwd,
          dataPlane === 'native' ? '.praxis' : '.claude',
          'settings.json',
        ),
      ) || existsSync(join(runtimeCwd, 'settings.json'))
    return projectSettings ? 'User settings, Project settings' : 'User settings'
  })()
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
  const modelOptions = useMemo(() => {
    const current = runtimePreferences.model
    const options: {
      label: string
      description: string
      model?: string
      selected?: boolean
    }[] = [
      {
        label: 'Default (recommended)',
        description: `Use the invocation default (currently ${runtimeDisplay.model ?? 'provider default'})`,
        selected: current === undefined,
      },
    ]
    if ((process.env.PRAXIS_PROVIDER ?? 'openai') === 'anthropic') {
      options.push(
        {
          label: 'Opus',
          model: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? 'opus',
          description: 'Most capable for complex work',
        },
        {
          label: 'Sonnet',
          model: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'sonnet',
          description: 'Best for everyday tasks',
        },
        {
          label: 'Haiku',
          model: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? 'haiku',
          description: 'Fastest for quick answers',
        },
      )
    } else if (current) {
      options.push({
        label: current,
        model: current,
        description: 'Current provider model',
        selected: true,
      })
    }
    for (const option of options)
      option.selected = option.model === current || (!option.model && !current)
    options.push({
      label: 'Enter a model ID…',
      description:
        'Use any model identifier supported by the configured provider.',
    })
    return options
  }, [runtimeDisplay.model, runtimePreferences.model])

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
      drainPermissionQueue()
      elicitationRef.current?.resolve({ action: 'cancel' })
      questionRef.current?.resolve(null)
      planApprovalRef.current?.resolve({ behavior: 'deny' })
      exit()
    }
    if (signal.aborted) cancel()
    else signal.addEventListener('abort', cancel, { once: true })
    return () => signal.removeEventListener('abort', cancel)
  }, [exit, signal])

  useEffect(
    () => () => {
      componentMountedRef.current = false
      streamingFrameRef.current?.dispose()
      drainPermissionQueue()
      elicitationRef.current?.resolve({ action: 'cancel' })
      questionRef.current?.resolve(null)
      planApprovalRef.current?.resolve({ behavior: 'deny' })
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

  const append = (line: TranscriptItem) => {
    // Any unflushed streaming deltas must be published before the boundary
    // transcript state so the active stream never renders below a tool,
    // thinking, or completion entry that it textually precedes.
    streamingFrameRef.current?.flush()
    setTranscriptScrollOffset(0)
    setHistoryState((current) => {
      const items = [...current.items, line]
      return advanceInteractiveHistoryState(
        current,
        items,
        current.items.length,
      )
    })
  }

  useEffect(() => {
    if (initialThemeSettings !== undefined) {
      if (initialThemeLoadError)
        append({ kind: 'warning', text: initialThemeLoadError })
      return
    }
    let cancelled = false
    void presentationThemeStore.load().then(
      (loaded) => {
        if (!cancelled)
          setThemeSettings(themeSettingsWithCustomTheme(loaded, customThemes))
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
  }, [
    customThemes,
    initialThemeLoadError,
    initialThemeSettings,
    presentationThemeStore,
  ])

  useEffect(() => {
    let cancelled = false
    void Promise.resolve(
      presentationThemeStore.loadCustomThemes?.() ?? [],
    ).then(
      (themes) => {
        if (!cancelled && themes) setCustomThemes(themes)
      },
      (error: unknown) => {
        if (!cancelled)
          append({
            kind: 'warning',
            text: `Unable to load custom themes: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
      },
    )
    return () => {
      cancelled = true
    }
  }, [presentationThemeStore])

  useEffect(() => {
    if (suppliedRuntimeSettings !== undefined) return
    let cancelled = false
    void loadConfigSettings(configTarget).then(
      (snapshot) => {
        if (!cancelled) setRuntimeSettings(projectRuntimeSettings(snapshot))
      },
      (error: unknown) => {
        if (!cancelled)
          append({
            kind: 'warning',
            text: `Unable to load runtime settings: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
      },
    )
    return () => {
      cancelled = true
    }
  }, [configTarget, suppliedRuntimeSettings])

  useEffect(() => {
    if (
      runtimeSettings.recap &&
      resume?.sessionId &&
      initialHistory.length > 0
    ) {
      const recap = sessionRecap(initialHistory)
      if (recap && !recapShownRef.current) {
        recapShownRef.current = true
        append({ kind: 'notice', text: recap })
      }
    }
  }, [initialHistory, resume?.sessionId, runtimeSettings.recap])

  useEffect(() => {
    if (!runtimeSettings.defaultToAgentsView || availableAgents.length === 0)
      return
    if (selectingSession || menuRef.current !== null) return
    updateMenu({ kind: 'agents', agents: availableAgents, selectedIndex: 0 })
  }, [
    availableAgents.length,
    runtimeSettings.defaultToAgentsView,
    selectingSession,
  ])

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
          result = await externalEditor(
            externalEditorInitialContent(
              externalEditorRequest.prompt,
              history,
              runtimeSettingsRef.current.externalEditorContext,
            ),
            {
              cwd: runtimeCwdRef.current,
              ...(signal === undefined ? {} : { signal }),
            },
          )
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
  }, [externalEditorRequest, history])

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
    if (next === null && menuRef.current?.kind === 'config') {
      configOpenGenerationRef.current += 1
      configUsageRequestRef.current += 1
      const closingConfigOperation = configOperationRef.current
      configOperationRef.current = null
      if (closingConfigOperation) {
        setBusy(false)
        onTurnChange?.(null)
      }
    }
    if (next === null && menuRef.current?.kind === 'doctor') {
      doctorMenuGenerationRef.current += 1
      const closingDoctorOperation = doctorOperationRef.current
      doctorOperationRef.current = null
      if (closingDoctorOperation) {
        setBusy(false)
        onTurnChange?.(null)
      }
    }
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
        streamingFrameRef.current?.appendText(event.delta)
        break
      case 'thinking-start':
        streamingFrameRef.current?.resetThinking()
        if (event.block.type === 'thinking') {
          streamingFrameRef.current?.appendThinking(
            redactSensitiveText(event.block.thinking, sensitiveValues),
          )
        }
        break
      case 'thinking-delta':
        streamingFrameRef.current?.appendThinking(
          redactSensitiveText(event.delta, sensitiveValues),
        )
        break
      case 'thinking-signature-delta':
        // Signatures authenticate a thinking block for provider replay; they are
        // intentionally not part of the user-visible reasoning summary.
        break
      case 'thinking-stop': {
        // append flushes pending thinking deltas before the retained boundary
        // item, keeping streaming order correct; the effective thinking getter
        // already includes any deltas not yet published.
        const thinkingItem: TranscriptItem = {
          kind: 'thinking',
          text:
            event.block.type === 'thinking'
              ? redactSensitiveText(event.block.thinking, sensitiveValues)
              : (streamingFrameRef.current?.thinking ?? ''),
        }
        activeAttemptThinkingItemsRef.current.push(thinkingItem)
        append(thinkingItem)
        streamingFrameRef.current?.resetThinking()
        streamingFrameRef.current?.flush()
        break
      }
      case 'user-message':
        append({ kind: 'assistant', text: event.message })
        break
      case 'state':
        if (event.state === 'awaiting-model') {
          activeAttemptThinkingItemsRef.current = []
        }
        setStatus(event.state)
        break
      case 'usage':
        setUsage(event.usage)
        break
      case 'model-attempt-discarded':
        streamingFrameRef.current?.resetText()
        streamingFrameRef.current?.resetThinking()
        streamingFrameRef.current?.flush()
        setUsage({ inputTokens: 0, outputTokens: 0 })
        if (activeAttemptThinkingItemsRef.current.length > 0) {
          const discarded = new Set(activeAttemptThinkingItemsRef.current)
          setHistory((current) =>
            current.filter((item) => !discarded.has(item)),
          )
          activeAttemptThinkingItemsRef.current = []
        }
        break
      case 'tool-call':
        if (['Edit', 'Write', 'NotebookEdit'].includes(event.call.name))
          turnMutatedFilesRef.current = true
        permissionCallsRef.current.set(event.call.id, event.call)
        append({
          kind: 'tool',
          call: redactToolCall(event.call, sensitiveValues),
          detail: describeToolInput(event.call, sensitiveValues),
        })
        break
      case 'permission-decision':
        if (
          event.behavior === 'deny' &&
          event.source === 'auto-classifier' &&
          event.autoModeOutcome === 'blocked'
        ) {
          const denied = permissionCallsRef.current.get(event.callId)
          const deniedSessionId = sessionIdRef.current
          if (denied && deniedSessionId) {
            const action: RecentlyDeniedAction = {
              id: `${event.callId}:${randomUUID()}`,
              call: denied,
              display: describeRecentlyDeniedAction(denied, sensitiveValues),
              reason: event.reason ?? '',
              sessionId: deniedSessionId,
            }
            void recentDeniedStore.record(action).then(
              (entries) => setRecentDenied(entries),
              (error: unknown) => warn(error),
            )
          }
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
      case 'terminal':
        break
      case 'elicitation-complete':
        append({
          kind: 'notice',
          text: `MCP elicitation completed · ${event.mcpServerName}`,
        })
        serviceRef.current?.notify?.(
          sessionIdRef.current ?? undefined,
          `MCP elicitation completed · ${event.mcpServerName}`,
          'elicitation_complete',
          'Praxis',
        )
        if (
          elicitationUrlWaitingRef.current?.request.serverName ===
            event.mcpServerName &&
          elicitationUrlWaitingRef.current.request.elicitationId ===
            event.elicitationId
        ) {
          elicitationUrlWaitingRef.current = null
          setElicitationUrlWaiting(false)
          setElicitation(null)
          setElicitationForm(null)
          clearComposerInput()
        }
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
    decision?: PermissionDecision,
  ) =>
    new Promise<PermissionApproval>((resolveApproval) => {
      const pending: PendingPermission = {
        kind,
        call,
        ...(decision ? { decision } : {}),
        notificationTimer: null,
        settled: false,
        settle: resolveApproval,
        resolve: (approved) => resolvePermission(pending, approved),
      }
      permissionQueueRef.current.push(pending)
      if (permissionQueueRef.current.length === 1) activatePermission(pending)
    })
  const approveTool = (
    call: ModelToolCall,
    _originalCall?: ModelToolCall,
    decision?: PermissionDecision,
  ) => requestApproval(call, 'tool', decision)

  const requestElicitation = (request: CliElicitationRequest) =>
    new Promise<CliElicitationResult>((resolveResult) => {
      let settled = false
      const notificationTimer = setTimeout(() => {
        if (settled) return
        serviceRef.current?.notify?.(
          sessionIdRef.current ?? undefined,
          'Praxis needs your input',
          request.mode === 'url'
            ? 'elicitation_url_dialog'
            : 'elicitation_dialog',
          'Praxis',
        )
      }, notificationDelayMs)
      const pending: PendingElicitation = {
        request,
        resolve: (result, options) => {
          if (settled) return
          settled = true
          clearTimeout(notificationTimer)
          if (elicitationRef.current === pending) elicitationRef.current = null
          if (!options?.keepUrlDialog) {
            setElicitation((current) => (current === pending ? null : current))
            setElicitationForm(null)
            clearComposerInput()
          }
          resolveResult(result)
        },
      }
      const form = createTuiElicitationForm(request.requestedSchema)
      setElicitationForm(form)
      setElicitationUrlWaiting(false)
      elicitationUrlWaitingRef.current = null
      updateComposerInput(elicitationTextValue(form))
      elicitationRef.current = pending
      setElicitation(pending)
    })
  const approveRecovery = (call: ModelToolCall) =>
    resume?.retryInterruptedTools
      ? true
      : requestApproval(call, 'recovery').then(
          (approval) =>
            approval === true ||
            (typeof approval === 'object' && approval.behavior === 'allow'),
        )

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
          if (questionTimeoutRef.current) {
            clearTimeout(questionTimeoutRef.current)
            questionTimeoutRef.current = null
          }
          if (questionRef.current?.resolve === pending.resolve)
            questionRef.current = null
          setQuestion((current) =>
            current?.resolve === pending.resolve ? null : current,
          )
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
      const timeout = questionTimeoutMilliseconds(
        runtimeSettingsRef.current.askUserQuestionTimeout,
      )
      if (timeout !== undefined) {
        questionTimeoutRef.current = setTimeout(() => {
          questionTimeoutRef.current = null
          questionRef.current?.resolve(null)
        }, timeout)
      }
    })

  const approvePlan: ClaudeInteractiveToolCallbacks['approvePlan'] = (
    request,
    signal,
  ) =>
    new Promise<ClaudePlanApprovalResult>((resolveApproval) => {
      let settled = false
      const abort = () => pending.resolve({ behavior: 'deny' })
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
        pending.resolve({ behavior: 'deny' })
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      clearComposerInput()
      setPlanApprovalSelection(0)
      setPlanApprovalFeedbackMode(false)
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
    drainPermissionQueue()
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

  const isSessionActionApproved = (call: ModelToolCall): boolean => {
    if (
      immediatePermissionRulesRef.current.some((rule) =>
        claudePermissionRuleMatches(rule, call, runtimeCwdRef.current),
      )
    )
      return true
    const activeSessionId = sessionIdRef.current
    return activeSessionId
      ? (approvedSessionActionsRef.current
          .get(activeSessionId)
          ?.has(claudePermissionActionKey(call)) ?? false)
      : false
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
          isSessionActionApproved,
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

  const reloadRuntimeSettings = async (
    snapshot?: Awaited<ReturnType<typeof loadConfigSettings>>,
  ) => {
    const current = snapshot ?? (await loadConfigSettings(configTarget))
    const projected = projectRuntimeSettings(current)
    runtimeSettingsRef.current = projected
    setRuntimeSettings(projected)
    return projected
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
      isSessionActionApproved,
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
    sessionIdRef.current = nextSessionId
    setSessionId(nextSessionId)
    setActiveSessionSummary(
      nextSessionId === null
        ? undefined
        : initialSessions.find(
            (session) => session.sessionId === nextSessionId,
          ),
    )
    const loadId = sessionLoadRef.current + 1
    sessionLoadRef.current = loadId
    if (nextSessionId === null) {
      setHistory([])
      setSessionColor(undefined)
      return
    }
    const loading = (async () => {
      try {
        const commands = await service()
        const transcript = await commands.transcript?.(nextSessionId)
        const agentColor =
          commands.agentColor === undefined
            ? undefined
            : await commands.agentColor(nextSessionId)
        if (sessionLoadRef.current === loadId) {
          setHistory(transcript ? [...transcript] : [])
          setSessionColor(agentColor)
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

  const writeCopyCandidate = async (candidate: CopyCandidate) => {
    const directory = join(tmpdir(), 'claude')
    await mkdir(directory, { recursive: true })
    const path = join(directory, candidate.filename)
    await writeFile(path, candidate.text, 'utf8')
    return path
  }

  const copyCandidate = (candidate: CopyCandidate, savePreference = false) => {
    const copying = (async () => {
      try {
        if (savePreference) {
          const snapshot = await saveConfigSetting(
            'copyFullResponse',
            true,
            configTarget,
          )
          await reloadRuntimeSettings(snapshot)
        }
        await clipboardWriter(candidate.text)
        let result = `Copied to clipboard (${candidate.text.length} characters, ${candidate.text.split('\n').length} lines)`
        try {
          result += `\nAlso written to ${await writeCopyCandidate(candidate)}`
        } catch {
          // Clipboard success is authoritative; the temp file is a fallback.
        }
        if (savePreference)
          result += '\nPreference saved. Use /config to change copyFullResponse'
        append({ kind: 'local-result', text: result })
      } catch (error) {
        warn(error)
      }
    })()
    onTurnChange?.(copying)
    void copying.finally(() => onTurnChange?.(null))
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
    const candidates = copyCandidates(response.text)
    const full = candidates[0]
    if (!full) return
    if (
      runtimeSettingsRef.current.copyFullResponse ||
      !shouldShowCopyPicker(response.text)
    ) {
      copyCandidate(full)
      return
    }
    updateMenu({
      kind: 'copy',
      candidates,
      selectedIndex: 0,
      messageAge: position - 1,
    })
  }

  const loadCostUsage = async (
    sessionId: string | null,
  ): Promise<CostSummary> => {
    if (!sessionId) return ZERO_COST_SUMMARY
    return withLocalCommands(async (commands) => {
      if (!commands.costSnapshot) {
        throw new Error('This interactive service cannot report session cost.')
      }
      const snapshot = await commands.costSnapshot(sessionId)
      return {
        totalCostUsd: snapshot.totalCostUsd,
        apiDurationMs: snapshot.apiDurationMs,
        wallDurationMs: snapshot.wallDurationMs,
        linesAdded: snapshot.linesAdded,
        linesRemoved: snapshot.linesRemoved,
        hasUnknownModelCost: snapshot.hasUnknownModelCost,
        modelUsage: Object.entries(snapshot.modelUsage).map(
          ([model, usage]) => ({
            model,
            canonicalName: canonicalClaudeCostModelName(model),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadInputTokens,
            cacheCreationInputTokens: usage.cacheCreationInputTokens,
            webSearchRequests: usage.webSearchRequests,
            costUsd: usage.costUsd,
          }),
        ),
      }
    })
  }

  const showCostSummary = (sessionId: string | null) => {
    const loading = (async () => {
      setBusy(true)
      try {
        const summary = await loadCostUsage(sessionId)
        append({ kind: 'local-result', text: formatCostSummary(summary) })
      } catch (error) {
        warn(error)
      } finally {
        setBusy(false)
      }
    })()
    onTurnChange?.(loading)
    void loading.finally(() => onTurnChange?.(null))
  }

  const loadConfigMenuUsage = (
    generation: number,
    sessionId: string | null,
  ) => {
    const requestId = ++configUsageRequestRef.current
    const loading = (async () => {
      setBusy(true)
      try {
        const usage = await loadCostUsage(sessionId)
        const current = menuRef.current
        if (
          current?.kind === 'config' &&
          current.generation === generation &&
          current.tab === 'usage' &&
          sessionIdRef.current === sessionId &&
          configUsageRequestRef.current === requestId
        ) {
          updateMenu({ ...current, usage })
        }
      } catch (error) {
        const current = menuRef.current
        if (
          current?.kind === 'config' &&
          current.generation === generation &&
          current.tab === 'usage' &&
          sessionIdRef.current === sessionId &&
          configUsageRequestRef.current === requestId
        ) {
          warn(error)
        }
      }
    })()
    configOperationRef.current = loading
    onTurnChange?.(loading)
    void loading.finally(() => {
      if (configOperationRef.current === loading) {
        configOperationRef.current = null
        setBusy(false)
        onTurnChange?.(null)
      }
    })
  }

  const openSettings = (tab: ConfigDashboardTab) => {
    const generation = ++configOpenGenerationRef.current
    const sessionId = sessionIdRef.current
    const requestId = tab === 'usage' ? ++configUsageRequestRef.current : 0
    const initial: Extract<InteractiveMenu, { kind: 'config' }> = {
      kind: 'config',
      generation,
      snapshot: { settings: {}, state: {} },
      tab,
      selectedIndex: 0,
      query: '',
      searchFocused: tab === 'config',
      usage: ZERO_COST_SUMMARY,
    }
    updateMenu(initial)
    const loading = (async () => {
      setBusy(true)
      try {
        const [snapshot, usage] = await Promise.all([
          loadConfigSettings(configTarget),
          tab === 'usage'
            ? loadCostUsage(sessionId)
            : Promise.resolve(ZERO_COST_SUMMARY),
        ])
        const current = menuRef.current
        if (current?.kind === 'config' && current.generation === generation) {
          const next = { ...current, snapshot }
          if (
            current.tab === 'usage' &&
            sessionIdRef.current === sessionId &&
            configUsageRequestRef.current === requestId
          ) {
            next.usage = usage
          }
          updateMenu(next)
        }
      } catch (error) {
        const current = menuRef.current
        if (tab === 'usage') {
          if (
            current?.kind === 'config' &&
            current.generation === generation &&
            current.tab === 'usage' &&
            sessionIdRef.current === sessionId &&
            configUsageRequestRef.current === requestId
          ) {
            warn(error)
          }
        } else if (configOpenGenerationRef.current === generation) {
          warn(error)
        }
      }
    })()
    configOperationRef.current = loading
    onTurnChange?.(loading)
    void loading.finally(() => {
      if (configOperationRef.current === loading) {
        configOperationRef.current = null
        setBusy(false)
        onTurnChange?.(null)
      }
    })
  }

  const openDoctor = () => {
    const generation = ++doctorMenuGenerationRef.current
    updateMenu({
      kind: 'doctor',
      generation,
      loading: true,
      report: null,
      error: null,
    })
    const loading = (async () => {
      setBusy(true)
      try {
        const report = await loadDoctorReport((progress) => {
          const current = menuRef.current
          if (current?.kind === 'doctor' && current.generation === generation) {
            updateMenu({
              kind: 'doctor',
              generation,
              loading: false,
              report: progress,
              error: null,
            })
          }
        })
        const current = menuRef.current
        if (current?.kind === 'doctor' && current.generation === generation) {
          updateMenu({
            kind: 'doctor',
            generation,
            loading: false,
            report,
            error: null,
          })
        }
      } catch (error) {
        const current = menuRef.current
        if (current?.kind === 'doctor' && current.generation === generation) {
          updateMenu({
            kind: 'doctor',
            generation,
            loading: false,
            report: null,
            error: redactSensitiveText(
              error instanceof Error ? error.message : String(error),
              sensitiveValues,
            ),
          })
        }
      } finally {
        if (doctorMenuGenerationRef.current === generation) setBusy(false)
      }
    })()
    doctorOperationRef.current = loading
    onTurnChange?.(loading)
    void loading.finally(() => {
      if (doctorOperationRef.current === loading) {
        doctorOperationRef.current = null
        setBusy(false)
        onTurnChange?.(null)
      }
    })
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
        const management = new ClaudeMcpManagement({
          dataPlane,
          cwd: runtimeCwdRef.current,
          configRoot: keybindingsRoot,
          statePath: configTarget.statePath,
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

  const changeSessionColor = (
    display: string,
    selection: AgentColorSelection,
  ) => {
    appendPromptHistory(display)
    if (selection.kind === 'color') setSessionColor(selection.color)
    else if (selection.kind === 'reset') setSessionColor(undefined)
    const changing = (async () => {
      try {
        const activeSessionId = await withLocalCommands(async (commands) => {
          if (!commands.recordColorUsage) {
            throw new Error('Session color is unavailable.')
          }
          return commands.recordColorUsage(
            sessionId ?? undefined,
            selection,
            display,
            runtimePreferencesRef.current.permissionMode,
          )
        })
        if (activeSessionId) setSessionId(activeSessionId)
        append({ kind: 'user', text: display })
        append({ kind: 'local-result', text: agentColorMessage(selection) })
      } catch (error) {
        warn(error)
      }
    })()
    onTurnChange?.(changing)
    void changing.finally(() => onTurnChange?.(null))
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
        setSessionName(name)
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
    setTranscriptScrollOffset(0)
    const turnNumber = turnNumberRef.current + 1
    const turnStartedAt = Date.now()
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
    setTurnDuration(undefined)
    setCommandPaletteOpen(false)
    const submittedCommandName = /^\/([^\s]+)/u.exec(prompt)?.[1]?.toLowerCase()
    const commandProgressMessage = submittedCommandName
      ? allSlashCommands.find(
          (command) => command.name.toLowerCase() === submittedCommandName,
        )?.progressMessage
      : undefined
    setStatus(commandProgressMessage ?? 'assembling-context')
    streamingFrameRef.current?.resetText()
    streamingFrameRef.current?.resetThinking()
    streamingFrameRef.current?.flush()
    if (runtimeSettingsRef.current.tips && !commandProgressMessage) {
      setStatus(spinnerTip(runtimeSettingsRef.current) ?? 'assembling-context')
    }
    if (shellCommand === undefined) append({ kind: 'user', text: prompt })
    else turnMutatedFilesRef.current = true
    let commands: InteractiveSessionCommands | undefined
    try {
      commands = await service()
      let activeSessionId = sessionId
      const startedNewSession = activeSessionId === null
      if (activeSessionId === null) {
        activeSessionId = randomUUID()
        sessionIdRef.current = activeSessionId
        setSessionId(activeSessionId)
      }
      if (activeSessionId && pendingFork) {
        const fork = await commands.fork(activeSessionId, resume?.forkSessionId)
        activeSessionId = fork.sessionId
        setSessionId(activeSessionId)
        setPendingFork(false)
      }
      const result =
        shellCommand === undefined
          ? startedNewSession
            ? await commands.run(
                prompt,
                turnSignal,
                activeSessionId,
                undefined,
                images,
              )
            : await commands.resume(
                activeSessionId,
                prompt,
                turnSignal,
                undefined,
                images,
              )
          : startedNewSession
            ? commands.runShell
              ? await commands.runShell(
                  shellCommand,
                  turnSignal,
                  activeSessionId,
                )
              : (() => {
                  throw new Error('Interactive shell mode is unavailable')
                })()
            : commands.resumeShell
              ? await commands.resumeShell(
                  activeSessionId,
                  shellCommand,
                  turnSignal,
                )
              : (() => {
                  throw new Error('Interactive shell mode is unavailable')
                })()
      sessionIdRef.current = result.sessionId
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
      // The active stream and its committed final item must never render in the
      // same frame. Publish the cleared stream before appending the final
      // assistant entry; there is no await between these operations, and the
      // renderer's frame buffer prevents the identical text from being shown
      // twice during the transition.
      streamingFrameRef.current?.resetText()
      streamingFrameRef.current?.resetThinking()
      streamingFrameRef.current?.flush()
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
      streamingFrameRef.current?.resetText()
      streamingFrameRef.current?.resetThinking()
      streamingFrameRef.current?.flush()
      setStatus('ready')
      setTurnDuration(Date.now() - turnStartedAt)
      if (
        runtimeSettingsRef.current.notifChannel !== 'notifications_disabled'
      ) {
        notifyTerminal({
          channel: runtimeSettingsRef.current.notifChannel as Parameters<
            typeof notifyTerminal
          >[0]['channel'],
          title: 'Praxis',
          message: 'Turn complete',
          ...(notificationWriter === undefined
            ? {}
            : { write: notificationWriter }),
        })
      }
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
    const composerKey: ComposerKeyProjection = {
      value,
      left: key.leftArrow,
      right: key.rightArrow,
      backspace: key.backspace,
      delete: key.delete,
      ctrl: key.ctrl,
      meta: key.meta,
      escape: key.escape || value === '\u001B',
    }
    const editor = () =>
      createComposerEditor(inputRef.current, inputCursorRef.current)
    const editComposer = () => {
      const transition = routeComposerKey(editor(), composerKey)
      if (transition.kind === 'edit') {
        updateComposerEditor(transition.editor)
        return true
      }
      if (transition.kind === 'cancel') clearComposerInput()
      return transition.kind === 'cancel'
    }
    const interactionComposer = (): TuiInteractionSnapshot['composer'] => ({
      mode:
        runtimeSettingsRef.current.editor === 'vim'
          ? vimInsertMode
            ? 'vim-insert'
            : 'vim-normal'
          : 'readline',
      editor: editor(),
      lastCancelAtMs: lastEscapeAtRef.current,
    })

    const applyInteractionEffects = (
      effects: readonly TuiInteractionEffect[],
    ) => {
      for (const effect of effects) {
        if (effect.kind === 'request-process-suspension') {
          processSuspendRequestedRef.current = true
          setProcessSuspendRequested(true)
        } else if (effect.kind === 'set-transcript-scroll-offset') {
          setTranscriptScrollOffset(effect.offset)
        } else if (effect.kind === 'interrupt-turn') {
          turnControllerRef.current?.abort()
        } else if (effect.kind === 'arm-exit-confirmation') {
          setExitConfirmation(true)
          if (exitConfirmationTimerRef.current)
            clearTimeout(exitConfirmationTimerRef.current)
          exitConfirmationTimerRef.current = setTimeout(() => {
            exitConfirmationTimerRef.current = null
            setExitConfirmation(false)
          }, 1_500)
        } else if (effect.kind === 'dismiss-exit-confirmation') {
          dismissExitConfirmation()
        } else if (effect.kind === 'exit-application') {
          drainPermissionQueue()
          elicitationRef.current?.resolve({ action: 'cancel' })
          questionRef.current?.resolve(null)
          planApprovalRef.current?.resolve({ behavior: 'deny' })
          onCancel?.()
          exit()
        } else if (effect.kind === 'set-vim-insert-mode') {
          setVimInsertMode(effect.insert)
        } else if (effect.kind === 'set-composer-editor') {
          updateComposerEditor(effect.editor)
        } else if (effect.kind === 'clear-composer') {
          clearComposerInput()
        } else if (effect.kind === 'record-composer-cancel') {
          lastEscapeAtRef.current = effect.timestamp
        } else if (effect.kind === 'cancel-tui-layer') {
          switch (effect.target) {
            case 'permission':
              permissionRef.current?.resolve(false)
              break
            case 'plan-approval':
              planApprovalRef.current?.resolve({ behavior: 'deny' })
              break
            case 'question':
              questionRef.current?.resolve(null)
              break
            case 'elicitation-url-waiting':
              if (elicitationUrlWaitingRef.current) {
                elicitationUrlWaitingRef.current = null
                setElicitationUrlWaiting(false)
                setElicitation(null)
                setElicitationForm(null)
                clearComposerInput()
              }
              break
            case 'elicitation-options':
              setElicitationForm((current) =>
                current?.expandedField
                  ? { ...current, expandedField: undefined }
                  : current,
              )
              break
            case 'elicitation':
              elicitationRef.current?.resolve({ action: 'cancel' })
              break
            case 'file-picker':
              setFilePickerOpen(false)
              break
            case 'command-palette':
              setCommandPaletteOpen(false)
              break
            default: {
              const unhandledTarget: never = effect.target
              return unhandledTarget
            }
          }
        } else {
          const unhandledEffect: never = effect
          return unhandledEffect
        }
      }
    }

    if (controlKey('c') || controlKey('z')) {
      const globalInteraction = routeTuiInteraction(
        {
          suspensionPending: processSuspendRequestedRef.current,
          exitConfirmationArmed: exitConfirmation,
          layer: { kind: 'none' },
          busy,
          viewport: {
            enabled: false,
            offset: 0,
            maxOffset: 0,
            pageRows: 0,
          },
          composer: interactionComposer(),
        },
        {
          globalIntent: controlKey('c') ? 'exit' : 'suspend',
          scrollIntent: 'none',
          action: undefined,
          composerKey,
          timestamp: Date.now(),
          callerIntent: 'none',
        },
      )
      applyInteractionEffects(globalInteraction.effects)
      return
    }

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
            : busy
              ? ['Task', 'Chat']
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
    const scrollIntent: TuiScrollIntent = key.pageUp
      ? 'page-older'
      : key.pageDown
        ? 'page-newer'
        : controlKey('u') || controlKey('b')
          ? 'half-page-older'
          : controlKey('f') || controlKey('n')
            ? 'half-page-newer'
            : inputRef.current.length === 0 && key.upArrow
              ? 'line-older'
              : inputRef.current.length === 0 && key.downArrow
                ? 'line-newer'
                : 'none'
    const hasPendingPrefix =
      !keybindingAction &&
      inputChord !== null &&
      hasTuiKeybindingPrefix(keybindings, keybindingContexts, inputChord)
    if (hasPendingPrefix) {
      keySequenceRef.current = { chord: inputChord, at: Date.now() }
    }
    const layer: TuiInteractionLayer = hasPendingPrefix
      ? { kind: 'pending-prefix' }
      : permission
        ? { kind: 'cancelable', target: 'permission' }
        : planApproval
          ? { kind: 'cancelable', target: 'plan-approval' }
          : question
            ? { kind: 'cancelable', target: 'question' }
            : elicitation
              ? {
                  kind: 'cancelable',
                  target: elicitationUrlWaiting
                    ? 'elicitation-url-waiting'
                    : elicitationForm?.expandedField
                      ? 'elicitation-options'
                      : 'elicitation',
                }
              : selectingSession
                ? { kind: 'delegated', target: 'session-picker' }
                : menuRef.current
                  ? { kind: 'delegated', target: 'menu' }
                  : filePickerVisible
                    ? { kind: 'cancelable', target: 'file-picker' }
                    : commandPaletteVisible
                      ? { kind: 'cancelable', target: 'command-palette' }
                      : { kind: 'none' }
    const callerIntent =
      !busy && value === '?' && inputRef.current.length === 0
        ? 'toggle-shortcuts'
        : runtimeSettingsRef.current.leftArrowOpensAgents &&
            key.leftArrow &&
            inputRef.current.length === 0 &&
            availableAgents.length > 0
          ? 'open-agents'
          : key.return &&
              (key.shift || key.meta) &&
              keybindingAction === undefined
            ? 'implicit-newline'
            : 'none'
    const interaction = routeTuiInteraction(
      {
        suspensionPending: processSuspendRequestedRef.current,
        exitConfirmationArmed: exitConfirmation,
        layer,
        busy,
        viewport: {
          enabled: fixedViewport,
          offset: transcriptScrollOffsetRef.current,
          maxOffset: maxTranscriptScrollOffset,
          pageRows: transcriptPageRows,
        },
        composer: interactionComposer(),
      },
      {
        globalIntent: 'none',
        scrollIntent,
        action: keybindingAction,
        composerKey,
        timestamp: Date.now(),
        callerIntent,
      },
    )
    applyInteractionEffects(interaction.effects)
    if (interaction.disposition === 'handled') {
      return
    }
    const isKeybinding = (action: string) => keybindingAction === action
    if (hasPendingPrefix) return

    if (permission) {
      const options =
        permission.kind === 'tool' && toolPermissionModel
          ? toolPermissionModel.options
          : [
              { action: 'allow-once' as const, label: 'Yes' },
              { action: 'deny' as const, label: 'No' },
            ]
      const optionCount = options.length
      const resolvePermission = (selectedIndex: number) => {
        const feedback = inputRef.current.trim()
        clearComposerInput()
        setPermissionFeedbackMode(false)
        const selected = options[selectedIndex]
        if (!selected) return
        if (selected.action === 'allow-once') {
          permission.resolve(
            feedback ? { behavior: 'allow', feedback } : { behavior: 'allow' },
          )
          return
        }
        if (
          permission.kind === 'tool' &&
          selected.action === 'persist-rule' &&
          (selected.rule || selected.editableRule || selected.updates?.length)
        ) {
          const editedRule = permissionRuleEditor?.text.trim()
          const rule = selected.editableRule
            ? editedRule
              ? `${selected.editableRule.toolName}(${editedRule})`
              : undefined
            : selected.rule
          const updates: readonly PermissionUpdate[] = selected.editableRule
            ? rule
              ? [
                  {
                    type: 'addRules',
                    rules: [
                      {
                        toolName: selected.editableRule.toolName,
                        ruleContent: editedRule ?? '',
                      },
                    ],
                    behavior: 'allow',
                    destination: 'localSettings',
                  },
                ]
              : []
            : (selected.updates ??
              (rule
                ? [
                    {
                      type: 'addRules',
                      rules: [
                        /^([A-Za-z][\w-]*)(?:\((.*)\))?$/u.exec(rule),
                      ].flatMap((match) =>
                        match?.[1]
                          ? [
                              {
                                toolName: match[1],
                                ...(match[2] === undefined
                                  ? {}
                                  : { ruleContent: match[2] }),
                              },
                            ]
                          : [],
                      ),
                      behavior: 'allow',
                      destination: 'localSettings',
                    } as const,
                  ]
                : []))
          if (!rule && updates.length === 0) {
            permission.resolve({ behavior: 'allow' })
            return
          }
          const saving = (async () => {
            try {
              for (const update of updates) {
                if (
                  update.type !== 'addRules' ||
                  update.destination !== 'localSettings'
                ) {
                  continue
                }
                for (const value of update.rules) {
                  const savedRule = permissionRuleValueToString(value)
                  await permissionStore.add({
                    behavior: update.behavior,
                    rule: savedRule,
                    scope: 'local',
                  })
                  immediatePermissionRulesRef.current.push(savedRule)
                }
              }
              permission.resolve({
                behavior: 'allow',
                updatedPermissions: updates,
              })
            } catch (error) {
              warn(error)
            }
          })()
          onTurnChange?.(saving)
          void saving.finally(() => onTurnChange?.(null))
          return
        }
        if (
          permission.kind === 'tool' &&
          selected.action === 'allow-session-action' &&
          (selected.rule || selected.updates?.length)
        ) {
          if (selected.rule)
            immediatePermissionRulesRef.current.push(selected.rule)
          permission.resolve({
            behavior: 'allow',
            updatedPermissions: selected.updates ?? [],
          })
          return
        }
        if (
          permission.kind === 'tool' &&
          selected.action === 'allow-session-edits'
        ) {
          for (const rule of ['Write', 'Edit', 'NotebookEdit']) {
            if (!immediatePermissionRulesRef.current.includes(rule))
              immediatePermissionRulesRef.current.push(rule)
          }
          updateRuntimePreferences((current) => ({
            ...current,
            permissionMode: 'acceptEdits',
          }))
          permission.resolve({
            behavior: 'allow',
            updatedPermissions: selected.updates?.length
              ? selected.updates
              : [
                  {
                    type: 'setMode',
                    mode: 'acceptEdits',
                    destination: 'session',
                  },
                ],
          })
          const activeSessionId = sessionIdRef.current
          if (activeSessionId && serviceRef.current?.setPermissionMode) {
            const saving = serviceRef.current
              .setPermissionMode(activeSessionId, 'acceptEdits')
              .catch((error: unknown) => warn(error))
            onTurnChange?.(saving)
            void saving.finally(() => onTurnChange?.(null))
          }
          return
        }
        permission.resolve(
          feedback ? { behavior: 'deny', message: feedback } : false,
        )
      }
      if (permissionFeedbackMode) {
        if (key.tab) {
          clearComposerInput()
          setPermissionFeedbackMode(false)
        } else if (key.return) {
          resolvePermission(permissionSelection)
        } else {
          editComposer()
        }
      } else if (key.upArrow) {
        setPermissionSelection((current) =>
          current === 0 ? optionCount - 1 : current - 1,
        )
      } else if (key.downArrow) {
        setPermissionSelection((current) => (current + 1) % optionCount)
      } else if (
        key.tab &&
        (options[permissionSelection]?.action === 'allow-once' ||
          options[permissionSelection]?.action === 'deny')
      ) {
        clearComposerInput()
        setPermissionFeedbackMode(true)
      } else if (options[permissionSelection]?.editableRule && !key.return) {
        if (key.leftArrow) {
          setPermissionRuleEditor((current) =>
            moveComposerCursor(current ?? createComposerEditor(), -1),
          )
        } else if (key.rightArrow) {
          setPermissionRuleEditor((current) =>
            moveComposerCursor(current ?? createComposerEditor(), 1),
          )
        } else if (key.backspace) {
          setPermissionRuleEditor((current) =>
            deleteComposerBackward(current ?? createComposerEditor()),
          )
        } else if (key.delete) {
          setPermissionRuleEditor((current) =>
            deleteComposerForward(current ?? createComposerEditor()),
          )
        } else if (value && !key.ctrl && !key.meta) {
          setPermissionRuleEditor((current) =>
            insertComposerText(current ?? createComposerEditor(), value),
          )
        }
      } else if (lower === 'y') {
        resolvePermission(0)
      } else if (lower === 'n') {
        resolvePermission(optionCount - 1)
      } else if (/^[1-9]$/u.test(value)) {
        const selectedIndex = Number(value) - 1
        if (selectedIndex < optionCount) resolvePermission(selectedIndex)
      } else if (key.return) {
        resolvePermission(permissionSelection)
      }
      return
    }

    if (planApproval) {
      const elevatedMode: ClaudePermissionMode = runtimeSettingsRef.current
        .useAutoModeDuringPlan
        ? 'auto'
        : allowDangerouslySkipPermissions
          ? 'bypassPermissions'
          : 'acceptEdits'
      const resolvePlanApproval = (selectedIndex: number) => {
        const feedback = inputRef.current.trim() || undefined
        clearComposerInput()
        setPlanApprovalFeedbackMode(false)
        if (selectedIndex === 2) {
          planApproval.resolve({
            behavior: 'deny',
            ...(feedback ? { feedback } : {}),
          })
          return
        }
        planApproval.resolve({
          behavior: 'allow',
          permissionMode: selectedIndex === 0 ? elevatedMode : 'default',
          ...(feedback ? { feedback } : {}),
        })
      }
      if (planApprovalFeedbackMode) {
        if (key.tab) {
          clearComposerInput()
          setPlanApprovalFeedbackMode(false)
        } else if (key.return) {
          resolvePlanApproval(planApprovalSelection)
        } else {
          editComposer()
        }
      } else if (key.upArrow) {
        setPlanApprovalSelection((current) => (current === 0 ? 2 : current - 1))
      } else if (key.downArrow) {
        setPlanApprovalSelection((current) => (current + 1) % 3)
      } else if (key.tab) {
        clearComposerInput()
        setPlanApprovalFeedbackMode(true)
      } else if (lower === 'y') {
        resolvePlanApproval(0)
      } else if (lower === 'n') {
        resolvePlanApproval(2)
      } else if (/^[1-3]$/u.test(value)) {
        resolvePlanApproval(Number(value) - 1)
      } else if (key.return) {
        resolvePlanApproval(planApprovalSelection)
      }
      return
    }

    if (question) {
      if (key.return) {
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
      const form =
        elicitationForm ??
        createTuiElicitationForm(elicitation.request.requestedSchema)
      const currentField = focusedElicitationField(form)
      const textField =
        currentField &&
        ['text', 'number', 'integer'].includes(currentField.kind)
      const commitCurrent = () =>
        textField ? commitElicitationText(form, inputRef.current) : form
      const showForm = (next: TuiElicitationFormState) => {
        setElicitationForm(next)
        updateComposerInput(elicitationTextValue(next))
      }
      const move = (direction: -1 | 1) =>
        showForm(moveElicitationFocus(commitCurrent(), direction))

      if (elicitation.request.mode === 'url') {
        const openUrl = () => {
          void Promise.resolve()
            .then(() => elicitationUrlOpener(elicitation.request.url ?? ''))
            .catch(() => undefined)
        }
        const dismissUrlDialog = () => {
          elicitationUrlWaitingRef.current = null
          setElicitationUrlWaiting(false)
          setElicitation(null)
          setElicitationForm(null)
          clearComposerInput()
        }
        if (key.leftArrow || key.rightArrow) {
          setElicitationForm({
            ...form,
            focusIndex: form.focusIndex === 0 ? 1 : 0,
          })
        } else if (key.return && form.focusIndex === 0) {
          if (elicitationUrlWaiting) {
            openUrl()
          } else {
            openUrl()
            elicitationUrlWaitingRef.current = elicitation
            setElicitationUrlWaiting(true)
            elicitation.resolve({ action: 'accept' }, { keepUrlDialog: true })
          }
        } else if (key.return && form.focusIndex === 1) {
          if (elicitationUrlWaiting) dismissUrlDialog()
          else elicitation.resolve({ action: 'decline' })
        }
        return
      }

      if (form.expandedField && currentField) {
        if (key.leftArrow) {
          setElicitationForm({ ...form, expandedField: undefined })
        } else if (key.upArrow) {
          showForm(moveElicitationOption(form, -1))
        } else if (key.downArrow) {
          showForm(moveElicitationOption(form, 1))
        } else if (value === ' ') {
          setElicitationForm(
            selectElicitationOption(form, currentField.kind === 'enum'),
          )
        } else if (key.return) {
          showForm(
            moveElicitationFocus(selectElicitationOption(form, true, true), 1),
          )
        } else if (printable && value) {
          setElicitationForm(typeaheadElicitationOption(form, value))
        }
      } else if (key.upArrow) {
        move(-1)
      } else if (key.downArrow) {
        move(1)
      } else if (!currentField && (key.leftArrow || key.rightArrow)) {
        setElicitationForm({
          ...form,
          focusIndex:
            form.focusIndex === form.fields.length
              ? form.fields.length + 1
              : form.fields.length,
        })
      } else if (form.focusIndex === form.fields.length && key.return) {
        const validated = validateTuiElicitationForm(form)
        if (elicitationFormIsValid(validated)) {
          elicitation.resolve({
            action: 'accept',
            ...(Object.keys(validated.values).length > 0
              ? { content: { ...validated.values } }
              : {}),
          })
        } else {
          showForm(validated)
        }
      } else if (form.focusIndex === form.fields.length + 1 && key.return) {
        elicitation.resolve({ action: 'decline' })
      } else if (currentField?.kind === 'boolean') {
        if (value === ' ' || lower === 'y' || lower === 'n') {
          let next = toggleElicitationBoolean(form)
          if (lower === 'n' && next.values[currentField.name] === true)
            next = toggleElicitationBoolean(next)
          if (lower === 'y' && next.values[currentField.name] === false)
            next = toggleElicitationBoolean(next)
          setElicitationForm(next)
        } else if (key.backspace) {
          setElicitationForm(unsetElicitationField(form))
        } else if (key.return) {
          move(1)
        }
      } else if (
        currentField &&
        ['enum', 'multi-enum'].includes(currentField.kind)
      ) {
        if (key.rightArrow) {
          setElicitationForm(expandElicitationOptions(form))
        } else if (key.backspace) {
          setElicitationForm(unsetElicitationField(form))
        } else if (key.return) {
          move(1)
        } else if (printable && value) {
          setElicitationForm(typeaheadElicitationOption(form, value))
        }
      } else if (textField) {
        if (key.return) move(1)
        else editComposer()
      }
      return
    }

    if (selectingSession) {
      if (key.escape || value === '\u001B') {
        if (pickerIncludesNewSessionRef.current && allowNewSession) {
          setSelectingSession(false)
          const previousSessionId = sessionIdRef.current
          void (async () => {
            if (previousSessionId) {
              const commands = await service()
              await commands.transitionHookSession?.(previousSessionId, 'clear')
            }
            openSession(null)
            setPendingFork(false)
          })().catch(warn)
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
        setSelectingSession(false)
        const nextSessionId = selected?.sessionId ?? null
        const previousSessionId = sessionIdRef.current
        void (async () => {
          if (previousSessionId && previousSessionId !== nextSessionId) {
            const commands = await service()
            await commands.transitionHookSession?.(
              previousSessionId,
              nextSessionId === null ? 'clear' : 'resume',
            )
          }
          openSession(nextSessionId)
          if (!selected) setPendingFork(false)
        })().catch(warn)
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
    if (earlyMenu?.kind === 'agents') {
      if (key.escape || value === '\u001B') {
        updateMenu(null)
        return
      }
      if (key.upArrow || key.downArrow) {
        updateMenu({
          ...earlyMenu,
          selectedIndex: Math.max(
            0,
            Math.min(
              earlyMenu.agents.length - 1,
              earlyMenu.selectedIndex + (key.upArrow ? -1 : 1),
            ),
          ),
        })
      } else if (key.return) {
        const agent = earlyMenu.agents[earlyMenu.selectedIndex]
        if (agent) {
          updateComposerInput(`@${agent.name} `)
          updateMenu(null)
        }
      }
      return
    }
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
    if (earlyMenu?.kind === 'sandbox') {
      if (key.escape || value === '\u001B') {
        updateMenu(null)
        return
      }
      const tabs = tuiSandboxTabs(earlyMenu.snapshot)
      if (key.leftArrow || key.rightArrow || key.tab) {
        const index = tabs.indexOf(earlyMenu.tab)
        const direction = key.leftArrow || (key.tab && key.shift) ? -1 : 1
        const tab =
          tabs[Math.max(0, Math.min(tabs.length - 1, index + direction))] ??
          earlyMenu.tab
        updateMenu({ ...earlyMenu, tab, selectedIndex: 0 })
        return
      }
      const rowCount =
        earlyMenu.tab === 'mode'
          ? 3
          : earlyMenu.tab === 'overrides' && earlyMenu.snapshot.settings.enabled
            ? 2
            : 0
      if (rowCount > 0 && (key.upArrow || key.downArrow)) {
        updateMenu({
          ...earlyMenu,
          selectedIndex: Math.max(
            0,
            Math.min(
              rowCount - 1,
              earlyMenu.selectedIndex + (key.upArrow ? -1 : 1),
            ),
          ),
        })
        return
      }
      if (rowCount > 0 && key.return) {
        const saving = (async () => {
          setBusy(true)
          try {
            const snapshot =
              earlyMenu.tab === 'mode'
                ? await sandboxStore.setMode(
                    (['auto-allow', 'regular', 'disabled'] as const)[
                      earlyMenu.selectedIndex
                    ] ?? 'auto-allow',
                  )
                : await sandboxStore.setAllowUnsandboxedCommands(
                    earlyMenu.selectedIndex === 0,
                  )
            await retireService()
            const tabs = tuiSandboxTabs(snapshot)
            updateMenu({
              kind: 'sandbox',
              tab: tabs.includes(earlyMenu.tab)
                ? earlyMenu.tab
                : (tabs[0] ?? 'dependencies'),
              selectedIndex: earlyMenu.selectedIndex,
              snapshot,
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
          'status',
          'config',
          'usage',
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
        if (tab === 'usage')
          loadConfigMenuUsage(earlyMenu.generation, sessionIdRef.current)
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
              configTarget,
            )
            await reloadRuntimeSettings(snapshot)
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
        if (key.escape || value === '\u001B') {
          updateMenu(null)
          return
        }
        if (key.leftArrow || key.rightArrow) {
          updateMenu({
            kind: 'help',
            invocation: activeMenu.invocation,
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
        } else if (
          activeMenu.tabIndex === 0 &&
          activeMenu.selectedIndex >= 0 &&
          (key.return || value.toLowerCase() === 'r')
        ) {
          const action = recentDenied[activeMenu.selectedIndex]
          if (!action) return
          const operation = (async () => {
            setBusy(true)
            const approvals =
              approvedSessionActionsRef.current.get(action.sessionId) ??
              new Set<string>()
            const actionKey = claudePermissionActionKey(action.call)
            const wasApproved = approvals.has(actionKey)
            approvals.add(actionKey)
            approvedSessionActionsRef.current.set(action.sessionId, approvals)
            try {
              const commands = await service()
              if (value.toLowerCase() === 'r') {
                if (!commands.retryRecentlyDenied) {
                  throw new Error('Recently denied retry is unavailable.')
                }
                setRetryingDeniedId(action.id)
                const result = await commands.retryRecentlyDenied(
                  action.sessionId,
                  action.display,
                  signal,
                )
                sessionIdRef.current = result.sessionId
                setSessionId(result.sessionId)
                setUsage(result.usage)
                setCostUsd(result.costUsd)
                append({ kind: 'assistant', text: result.text })
                updateMenu(null)
              } else {
                if (!commands.approveRecentlyDenied) {
                  throw new Error('Recently denied approval is unavailable.')
                }
                await commands.approveRecentlyDenied(
                  action.sessionId,
                  action.display,
                )
                const entries = await recentDeniedStore.remove(action.id)
                setRecentDenied(entries)
                append({
                  kind: 'notice',
                  text: `Approved ${action.display}`,
                })
                updateMenu({
                  kind: 'permission-dashboard',
                  tabIndex: entries.length > 0 ? 0 : 1,
                  selectedIndex: entries.length > 0 ? 0 : -1,
                  query: '',
                  rules: activeMenu.rules,
                })
              }
            } catch (error) {
              if (!wasApproved) approvals.delete(actionKey)
              warn(error)
            } finally {
              setRetryingDeniedId(null)
              setBusy(false)
            }
          })()
          onTurnChange?.(operation)
          void operation.finally(() => onTurnChange?.(null))
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
            void saveConfigSetting('model', model, configTarget).then(
              () =>
                append({
                  kind: 'local-result',
                  text: `${model} set as default model for new sessions.`,
                }),
              (error: unknown) => warn(error),
            )
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

      if (activeMenu.kind === 'copy') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
        } else if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                activeMenu.candidates.length - 1,
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        } else if (/^[1-9]$/u.test(value)) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.min(
              activeMenu.candidates.length - 1,
              Number(value) - 1,
            ),
          })
        } else if (key.return || value.toLowerCase() === 'w') {
          const candidate = activeMenu.candidates[activeMenu.selectedIndex]
          if (!candidate) return
          updateMenu(null)
          if (value.toLowerCase() === 'w') {
            const writing = writeCopyCandidate(candidate).then(
              (path) =>
                append({ kind: 'local-result', text: `Written to ${path}` }),
              (error: unknown) => warn(error),
            )
            onTurnChange?.(writing)
            void writing.finally(() => onTurnChange?.(null))
          } else {
            copyCandidate(candidate, candidate.kind === 'always')
          }
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
        const themeOptionCount = TUI_THEMES.length + customThemes.length + 1
        const lastThemeOptionIndex = themeOptionCount - 1
        if (key.escape || value === '\u001B') {
          updateMenu(null)
        } else if (isKeybinding('theme:editCustom') || controlKey('e')) {
          const options = [
            ...TUI_THEMES,
            ...customThemes.map((theme) => `custom:${theme.slug}` as const),
          ]
          const selected = options[activeMenu.selectedIndex]
          const theme = selected?.startsWith('custom:')
            ? customThemes.find((entry) => `custom:${entry.slug}` === selected)
            : undefined
          if (!theme) {
            append({
              kind: 'warning',
              text: 'Only custom themes can be edited.',
            })
          } else {
            updateMenu({
              kind: 'custom-theme-editor',
              theme,
              selectedIndex: 0,
              query: '',
            })
          }
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
                lastThemeOptionIndex,
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        } else if (/^[1-9]$/u.test(value)) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.min(lastThemeOptionIndex, Number(value) - 1),
          })
        } else if (key.return) {
          const options = [
            ...TUI_THEMES,
            ...customThemes.map((theme) => `custom:${theme.slug}` as const),
            '__new__' as const,
          ]
          const selected = options[activeMenu.selectedIndex]
          if (!selected) return
          if (selected === '__new__') {
            const base = themeSettings.theme.startsWith('custom:')
              ? (themeSettings.customTheme?.base ?? 'dark')
              : themeSettings.theme === 'auto'
                ? 'dark'
                : (themeSettings.theme as CustomThemeBase)
            updateMenu({ kind: 'custom-theme-create', base })
            return
          }
          const saving = (async () => {
            setBusy(true)
            try {
              const customTheme = selected.startsWith('custom:')
                ? customThemes.find(
                    (theme) => `custom:${theme.slug}` === selected,
                  )
                : undefined
              const committed = await presentationThemeStore.save({
                theme: selected,
                ...(customTheme === undefined ? {} : { customTheme }),
              })
              setThemeSettings(committed)
              updateMenu(null)
              append({
                kind: 'local-result',
                text: `Theme set to ${customTheme?.name ?? selected}`,
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

      if (activeMenu.kind === 'custom-theme-create') {
        if (key.escape || value === '\u001B') {
          clearComposerInput()
          updateMenu(null)
        } else if (key.return) {
          const name = inputRef.current.trim() || 'my-theme'
          const creating = (async () => {
            setBusy(true)
            try {
              const create = presentationThemeStore.createCustomTheme
              if (!create)
                throw new Error('Custom theme controls are unavailable.')
              const theme = await create({ name, base: activeMenu.base })
              setCustomThemes((current) =>
                [...current, theme].sort((left, right) =>
                  left.name.localeCompare(right.name),
                ),
              )
              const committed = await presentationThemeStore.save({
                theme: `custom:${theme.slug}`,
                customTheme: theme,
              })
              setThemeSettings(committed)
              clearComposerInput()
              updateMenu(null)
              append({
                kind: 'local-result',
                text: `Using custom theme "${theme.name}"`,
              })
            } catch (error) {
              warn(error)
            } finally {
              setBusy(false)
            }
          })()
          onTurnChange?.(creating)
          void creating.finally(() => onTurnChange?.(null))
        } else {
          editComposer()
        }
        return
      }

      if (activeMenu.kind === 'custom-theme-editor') {
        const filteredTokens = CUSTOM_THEME_TOKENS.filter((token) =>
          token.toLowerCase().includes(activeMenu.query.toLowerCase()),
        )
        if (key.escape || value === '\u001B') {
          clearComposerInput()
          updateMenu(null)
        } else if (key.upArrow || key.downArrow) {
          updateMenu({
            ...activeMenu,
            selectedIndex: Math.max(
              0,
              Math.min(
                Math.max(0, filteredTokens.length - 1),
                activeMenu.selectedIndex + (key.upArrow ? -1 : 1),
              ),
            ),
          })
        } else if (key.return) {
          const token = filteredTokens[activeMenu.selectedIndex]
          if (token) {
            const current = activeMenu.theme.overrides[token] ?? ''
            clearComposerInput()
            updateMenu({
              kind: 'custom-theme-token',
              theme: activeMenu.theme,
              token,
            })
            updateComposerInput(current)
          }
        } else if (key.tab) {
          const token = filteredTokens[activeMenu.selectedIndex]
          if (token && activeMenu.theme.overrides[token] !== undefined) {
            const resetting = (async () => {
              setBusy(true)
              try {
                const update = presentationThemeStore.updateCustomTheme
                if (!update)
                  throw new Error('Custom theme controls are unavailable.')
                const next = await update(activeMenu.theme, token, undefined)
                setCustomThemes((current) =>
                  current.map((entry) =>
                    entry.slug === next.slug ? next : entry,
                  ),
                )
                setThemeSettings((current) => ({
                  ...current,
                  theme: `custom:${next.slug}`,
                  customTheme: next,
                }))
                updateMenu({ ...activeMenu, theme: next })
              } catch (error) {
                warn(error)
              } finally {
                setBusy(false)
              }
            })()
            onTurnChange?.(resetting)
            void resetting.finally(() => onTurnChange?.(null))
          }
        } else if (key.backspace || key.delete) {
          updateMenu({
            ...activeMenu,
            query: activeMenu.query.slice(0, -1),
            selectedIndex: 0,
          })
        } else if (!key.ctrl && !key.meta && value && printable) {
          updateMenu({
            ...activeMenu,
            query: activeMenu.query + value,
            selectedIndex: 0,
          })
        } else if (controlKey('d')) {
          updateMenu({
            kind: 'custom-theme-delete',
            theme: activeMenu.theme,
            selectedIndex: 0,
          })
        }
        return
      }

      if (activeMenu.kind === 'custom-theme-token') {
        if (key.escape || value === '\u001B') {
          clearComposerInput()
          updateMenu({
            kind: 'custom-theme-editor',
            theme: activeMenu.theme,
            selectedIndex: 0,
            query: '',
          })
        } else if (key.return) {
          const valueToSave = inputRef.current.trim()
          const saving = (async () => {
            setBusy(true)
            try {
              const update = presentationThemeStore.updateCustomTheme
              if (!update)
                throw new Error('Custom theme controls are unavailable.')
              const next = await update(
                activeMenu.theme,
                activeMenu.token,
                valueToSave,
              )
              setCustomThemes((current) =>
                current.map((entry) =>
                  entry.slug === next.slug ? next : entry,
                ),
              )
              setThemeSettings((current) => ({
                ...current,
                theme: `custom:${next.slug}`,
                customTheme: next,
              }))
              clearComposerInput()
              updateMenu({
                kind: 'custom-theme-editor',
                theme: next,
                selectedIndex: 0,
                query: '',
              })
            } catch (error) {
              warn(error)
            } finally {
              setBusy(false)
            }
          })()
          onTurnChange?.(saving)
          void saving.finally(() => onTurnChange?.(null))
        } else {
          editComposer()
        }
        return
      }

      if (activeMenu.kind === 'custom-theme-delete') {
        if (key.escape || value === '\u001B') {
          updateMenu(null)
        } else if (key.return || value.toLowerCase() === 'y') {
          const deleting = (async () => {
            setBusy(true)
            try {
              const remove = presentationThemeStore.deleteCustomTheme
              if (!remove)
                throw new Error('Custom theme controls are unavailable.')
              await remove(activeMenu.theme)
              setCustomThemes((current) =>
                current.filter((entry) => entry.slug !== activeMenu.theme.slug),
              )
              const committed = await presentationThemeStore.save({
                theme: activeMenu.theme.base,
              })
              setThemeSettings(committed)
              updateMenu(null)
              append({
                kind: 'local-result',
                text: `Deleted custom theme "${activeMenu.theme.name}"`,
              })
            } catch (error) {
              warn(error)
            } finally {
              setBusy(false)
            }
          })()
          onTurnChange?.(deleting)
          void deleting.finally(() => onTurnChange?.(null))
        }
        return
      }

      if (activeMenu.kind === 'compact-progress') {
        if (key.escape || value === '\u001B' || isKeybinding('chat:cancel')) {
          turnControllerRef.current?.abort()
        }
        return
      }

      if (activeMenu.kind === 'doctor') {
        if (key.escape || value === '\u001B' || key.return) {
          updateMenu(null)
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
      if (!key.return) return

      if (activeMenu.kind === 'model') {
        if (activeMenu.selectedIndex === modelOptions.length - 1) {
          clearComposerInput()
          updateMenu({ kind: 'model-input' })
          return
        }
        const model = modelOptions[activeMenu.selectedIndex]?.model
        updateMenu(null)
        if (activeMenu.selectedIndex === 0) {
          changeModel(undefined)
          void saveConfigSetting('model', 'default', configTarget).then(
            () =>
              append({
                kind: 'local-result',
                text: 'Default model set for new sessions.',
              }),
            (error: unknown) => warn(error),
          )
        } else if (model) {
          changeModel(model)
          void saveConfigSetting('model', model, configTarget).then(
            () =>
              append({
                kind: 'local-result',
                text: `${model} set as default model for new sessions.`,
              }),
            (error: unknown) => warn(error),
          )
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
      if (isKeybinding('task:background')) {
        const backgrounding = (async () => {
          try {
            const activeSessionId = sessionIdRef.current
            if (!activeSessionId) throw new Error('No active session')
            const commands = await service()
            if (!commands.backgroundForegroundTask) {
              throw new Error('Foreground Agent backgrounding is unavailable.')
            }
            await commands.backgroundForegroundTask(activeSessionId)
            append({
              kind: 'notice',
              text: 'Agent moved to background · continuing this turn',
            })
          } catch (error) {
            warn(error)
          }
        })()
        void backgrounding
        return
      }
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
    if (
      runtimeSettingsRef.current.leftArrowOpensAgents &&
      key.leftArrow &&
      inputRef.current.length === 0 &&
      availableAgents.length > 0
    ) {
      updateMenu({ kind: 'agents', agents: availableAgents, selectedIndex: 0 })
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
      const commandNameQuery = inputRef.current.slice(1).toLocaleLowerCase()
      const exactSelectedCommand =
        selectedCommand !== undefined &&
        commandNameQuery === selectedCommand.name.toLocaleLowerCase()
      const selectedCommandMatchesName =
        selectedCommand !== undefined &&
        selectedCommand.name.toLocaleLowerCase().startsWith(commandNameQuery)
      const exactHiddenCommand = HIDDEN_TUI_SLASH_COMMANDS.has(commandNameQuery)
      if (
        selectedCommand &&
        (key.tab ||
          (key.return &&
            !exactSelectedCommand &&
            !exactHiddenCommand &&
            selectedCommandMatchesName))
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
      const colorCommand = /^\/color(?:\s+([\s\S]+))?$/u.exec(prompt)
      const sandboxCommand = /^\/sandbox(?:\s+([\s\S]+))?$/u.exec(prompt)
      const tuiCommand = /^\/tui(?:\s+(default|fullscreen))?$/u.exec(prompt)
      const renameCommand = /^\/rename(?:\s+(.+))?$/u.exec(prompt)
      const cdCommand = /^\/cd(?:\s+(.+))?$/u.exec(prompt)
      const btwCommand = /^\/btw(?:\s+([\s\S]+))?$/u.exec(prompt)
      if (prompt === '/exit') {
        exit()
      } else if (prompt === '/help' || prompt === '?') {
        updateMenu({
          kind: 'help',
          invocation: prompt,
          tabIndex: 0,
          selectedIndex: 0,
        })
      } else if (prompt === '/new') {
        const previousSessionId = sessionIdRef.current
        void (async () => {
          if (previousSessionId) {
            const commands = await service()
            await commands.transitionHookSession?.(previousSessionId, 'clear')
          }
          statusLineSessionId.current = randomUUID()
          openSession(null)
          setPendingFork(false)
          append({ kind: 'notice', text: 'Started a new session.' })
        })().catch(warn)
      } else if (prompt === '/clear') {
        const previousSessionId = sessionIdRef.current
        void (async () => {
          if (previousSessionId) {
            const commands = await service()
            await commands.transitionHookSession?.(previousSessionId, 'clear')
          }
          statusLineSessionId.current = randomUUID()
          openSession(null)
          setPendingFork(false)
          setHistory([])
          setUsage(undefined)
          setCostUsd(undefined)
          streamingFrameRef.current?.resetText()
          streamingFrameRef.current?.resetThinking()
          streamingFrameRef.current?.flush()
          setThinkingExpanded(false)
          setStatus('ready')
          inputHistoryRef.current = []
          inputHistoryIndexRef.current = null
          inputHistoryDraftRef.current = ''
        })().catch(warn)
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
          selectedIndex: Math.max(
            0,
            themeSettings.theme.startsWith('custom:')
              ? TUI_THEMES.length +
                  customThemes.findIndex(
                    (theme) => `custom:${theme.slug}` === themeSettings.theme,
                  )
              : TUI_THEMES.indexOf(
                  themeSettings.theme as (typeof TUI_THEMES)[number],
                ),
          ),
        })
      } else if (prompt === '/vim') {
        const saving = (async () => {
          setBusy(true)
          try {
            const mode =
              runtimeSettingsRef.current.editor === 'vim' ? 'normal' : 'vim'
            const snapshot = await saveConfigSetting(
              'editor',
              mode,
              configTarget,
            )
            await reloadRuntimeSettings(snapshot)
            setVimInsertMode(true)
            append({
              kind: 'local-result',
              text: `Editor mode set to ${mode}. ${
                mode === 'vim'
                  ? 'Use Escape key to toggle between INSERT and NORMAL modes.'
                  : 'Using standard (readline) keyboard bindings.'
              }`,
            })
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(saving)
        void saving.finally(() => onTurnChange?.(null))
      } else if (prompt === '/output-style') {
        append({
          kind: 'local-result',
          text: '/output-style has been deprecated. Use /config to change your output style, or set it in your settings file. Changes take effect on the next session.',
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
            const files = await loadMemoryFiles(
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
      } else if (prompt === '/agents') {
        append({ kind: 'user', text: prompt })
        append({
          kind: 'local-result',
          text: `The /agents wizard has been removed.\n\nAsk Praxis to create or update subagents for you (e.g. "create a code-reviewer subagent that ..."),\nor edit the files directly:\n  • ${settingsDirectory}/agents/       (this project)\n  • ~/${settingsDirectory}/agents/     (all projects)`,
        })
      } else if (colorCommand) {
        changeSessionColor(prompt, parseAgentColorInput(colorCommand[1] ?? ''))
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
      } else if (sandboxCommand) {
        const operation = (async () => {
          setBusy(true)
          try {
            const args = sandboxCommand[1]?.trim()
            if (args) {
              const exclude = /^exclude(?:\s+([\s\S]+))?$/u.exec(args)
              if (!exclude) {
                throw new Error(
                  `Unknown subcommand "${args.split(/\s+/u)[0] ?? args}". Available subcommand: exclude`,
                )
              }
              if (!exclude[1]?.trim()) {
                throw new Error(
                  'Please provide a command pattern to exclude (e.g. /sandbox exclude "npm run test:*")',
                )
              }
              const result = await sandboxStore.exclude(exclude[1])
              await retireService()
              append({
                kind: 'local-result',
                text: `Added "${result.pattern}" to excluded commands in ${result.settingsPath}`,
              })
              return
            }
            const snapshot = await sandboxStore.load()
            if (!snapshot.supported) {
              throw new Error(
                'Sandboxing is currently only supported on macOS, Linux, and WSL2.',
              )
            }
            if (
              snapshot.unavailableReason?.includes(
                'not in sandbox.enabledPlatforms',
              )
            ) {
              throw new Error(snapshot.unavailableReason)
            }
            const tabs = tuiSandboxTabs(snapshot)
            updateMenu({
              kind: 'sandbox',
              tab: tabs[0] ?? 'dependencies',
              selectedIndex: 0,
              snapshot,
            })
          } catch (error) {
            warn(error)
          } finally {
            setBusy(false)
          }
        })()
        onTurnChange?.(operation)
        void operation.finally(() => onTurnChange?.(null))
      } else if (prompt === '/permissions') {
        const loading = (async () => {
          setBusy(true)
          try {
            const entries = await recentDeniedStore.load()
            setRecentDenied(entries)
            updateMenu({
              kind: 'permission-dashboard',
              tabIndex: entries.length > 0 ? 0 : 1,
              selectedIndex: entries.length > 0 ? 0 : -1,
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
        const contextEntry: Extract<TranscriptItem, { kind: 'context' }> = {
          kind: 'context',
          usedTokens: Math.max(measuredTokens, skillTokens),
          contextWindowTokens: runtimeDisplay.contextWindowTokens ?? 200_000,
          model: runtimeDisplay.model ?? 'provider default',
          skills,
          memoryFiles: [],
        }
        setHistory(
          (current) => [
            ...current,
            { kind: 'user', text: '/context' },
            contextEntry,
          ],
          (current) => current.length,
        )
        const loading = (async () => {
          try {
            const files = await loadMemoryFiles(
              keybindingsRoot,
              runtimeCwdRef.current,
            )
            const memoryFiles = await Promise.all(
              files.entries
                .filter((entry) => entry.kind === 'file')
                .map(async (entry) => ({
                  path: entry.displayPath,
                  tokens: await estimateFileTokens(entry.path),
                })),
            )
            setHistory(
              (current) => {
                const next = [...current]
                const last = next.at(-1)
                if (last && last.kind === 'context') {
                  next[next.length - 1] = { ...last, memoryFiles }
                }
                return next
              },
              (_current, next) => Math.max(0, next.length - 1),
            )
          } catch {
            // Leave the Memory files section empty if files cannot be read.
          }
        })()
        onTurnChange?.(loading)
        void loading.finally(() => onTurnChange?.(null))
      } else if (prompt === '/cost') {
        showCostSummary(sessionIdRef.current)
      } else if (prompt === '/doctor') {
        openDoctor()
      } else if (prompt === '/status') {
        openSettings('status')
      } else if (prompt === '/release-notes') {
        const loading = (async () => {
          setBusy(true)
          setStatus('loading release notes')
          try {
            append({
              kind: 'local-result',
              text: await releaseNotesLoader(keybindingsRoot),
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
      } else if (prompt === '/config') {
        openSettings('config')
      } else if (tuiCommand) {
        const mode = tuiCommand[1] as PraxisRuntimeSettings['tui'] | undefined
        if (!mode) {
          append({
            kind: 'local-result',
            text: `TUI renderer: ${runtimeSettingsRef.current.tui}. Usage: /tui default|fullscreen`,
          })
        } else {
          const saving = (async () => {
            setBusy(true)
            try {
              const snapshot = await saveConfigSetting(
                'tui',
                mode,
                configTarget,
              )
              await reloadRuntimeSettings(snapshot)
              onRendererChange?.(mode, sessionId)
              exit()
            } catch (error) {
              warn(error)
            } finally {
              setBusy(false)
            }
          })()
          onTurnChange?.(saving)
          void saving.finally(() => onTurnChange?.(null))
        }
      } else if (prompt === '/usage') {
        openSettings('usage')
      } else if (prompt === '/update') {
        append({
          kind: 'local-result',
          text: `Configured auto-update channel: ${autoUpdateTarget(runtimeSettingsRef.current.autoUpdatesChannel)}. Run praxis update to update now.`,
        })
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
          emptyText: `No skills found\nCreate skills in ${settingsDirectory}/skills/ or ~/${settingsDirectory}/skills/`,
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
    if (filePickerVisible || commandPaletteVisible) {
      editComposer()
      return
    }
  })

  return (
    <TuiThemeProvider settings={themeSettings} screenReader={axScreenReader}>
      <Box
        flexDirection="column"
        {...(!fixedViewport
          ? {}
          : { height: rows, overflowY: 'hidden' as const })}
      >
        {screen.body.kind === 'session-picker' ? (
          <SessionPicker
            sessions={filteredPickerChoices}
            selectedIndex={selectedIndex}
            screenReader={axScreenReader}
            query={sessionSearch}
          />
        ) : (
          <>
            {screen.body.intro === 'welcome' ? (
              <WelcomePanel
                display={runtimeDisplay}
                width={width}
                showTips={runtimeSettings.tips}
                dataPlane={dataPlane}
              />
            ) : null}
            {screen.body.sessionLabel ? (
              <Text dimColor>Session {screen.body.sessionLabel}</Text>
            ) : null}
            {screen.body.intro === 'identity' ? (
              <SessionIdentity display={runtimeDisplay} width={width} />
            ) : null}
            <Box
              {...(fixedViewport
                ? {
                    flexShrink: 1,
                    minHeight: 0,
                    overflowY: 'hidden' as const,
                  }
                : {})}
            >
              <Transcript
                entries={screen.body.transcript.entries}
                activeText={screen.body.transcript.active.text}
                activeThinking={screen.body.transcript.active.thinking}
                activeStreamVisible={screen.body.transcript.active.visible}
                thinkingExpanded={thinkingExpanded}
                detailedTranscript={
                  screen.body.transcript.readingMode !== 'normal'
                }
                screenReader={axScreenReader}
              />
            </Box>
            {selectedPriority?.kind === 'editor-wait' ? (
              <ExternalEditorWait screenReader={axScreenReader} />
            ) : selectedPriority?.kind === 'permission' ? (
              <PermissionSurface
                model={selectedPriority.surface}
                width={width}
                screenReader={axScreenReader}
              />
            ) : selectedPriority?.kind === 'plan-approval' ? (
              <DecisionSurface
                model={selectedPriority}
                width={width}
                screenReader={axScreenReader}
              />
            ) : selectedPriority?.kind === 'question' ? (
              <DecisionSurface
                model={selectedPriority}
                width={width}
                screenReader={axScreenReader}
              />
            ) : selectedPriority?.kind === 'elicitation' && elicitation ? (
              elicitation.request.mode === 'url' ? (
                <McpElicitationUrl
                  serverName={elicitation.request.serverName}
                  message={elicitation.request.message}
                  url={elicitation.request.url ?? ''}
                  waiting={elicitationUrlWaiting}
                  actionLabel={
                    elicitation.request.elicitationId
                      ? 'Skip confirmation'
                      : 'Continue without waiting'
                  }
                  selection={elicitationForm?.focusIndex ?? 0}
                  screenReader={axScreenReader}
                />
              ) : (
                <McpElicitationForm
                  serverName={elicitation.request.serverName}
                  message={elicitation.request.message}
                  state={
                    elicitationForm ??
                    createTuiElicitationForm(
                      elicitation.request.requestedSchema,
                    )
                  }
                  input={input}
                  screenReader={axScreenReader}
                />
              )
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
                              <DecisionOption
                                selected={menu.selectedIndex === index}
                                screenReader={axScreenReader}
                                selectedPrefix=" ❯ "
                                unselectedPrefix="   "
                              >
                                {point.prompt
                                  .replace(/\s+/gu, ' ')
                                  .slice(0, 72)}
                              </DecisionOption>
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
                <DecisionOption
                  selected={menu.selectedIndex === menu.points.length}
                  screenReader={axScreenReader}
                  selectedPrefix=" ❯ "
                  unselectedPrefix="   "
                >
                  (current)
                </DecisionOption>
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
                  <DecisionOption
                    key={option.action}
                    selected={menu.selectedIndex === index}
                    screenReader={axScreenReader}
                  >
                    {index + 1}. {option.label}
                  </DecisionOption>
                ))}
                <Text> </Text>
                <RewindWarning />
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
            ) : selectedSecondarySurface !== null && menu !== null ? (
              selectedSecondarySurface.kind === 'permission-dashboard' ||
              selectedSecondarySurface.kind === 'permission-rule-input' ||
              selectedSecondarySurface.kind === 'permission-scope' ||
              selectedSecondarySurface.kind === 'permission-delete' ||
              selectedSecondarySurface.kind === 'workspace-directory-input' ||
              selectedSecondarySurface.kind === 'workspace-directory-delete' ? (
                <PermissionSurface
                  model={selectedSecondarySurface}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : selectedSecondarySurface.kind === 'help' ? (
                <HelpMenu
                  model={selectedSecondarySurface}
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
              ) : menu.kind === 'sandbox' ? (
                <SandboxDashboard
                  snapshot={menu.snapshot}
                  tab={menu.tab}
                  selectedIndex={menu.selectedIndex}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'agents' ? (
                <ListDashboard
                  title="Agents"
                  rows={menu.agents.map((agent) => ({
                    label: agent.name,
                    description: agent.description,
                  }))}
                  emptyText="No agents configured"
                  selectedIndex={menu.selectedIndex}
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
                  status={{
                    version: runtimeDisplay.version,
                    ...(sessionName ? { sessionName } : {}),
                    sessionId: sessionId ?? 'new',
                    cwd: runtimeCwd,
                    ...(statusAuthSource
                      ? { authSource: statusAuthSource }
                      : {}),
                    ...(statusBaseUrl ? { baseUrl: statusBaseUrl } : {}),
                    ...(statusProxy ? { proxy: statusProxy } : {}),
                    model: runtimeDisplay.model ?? 'default',
                    settingSources: statusSettingSources.split(', '),
                  }}
                  usage={menu.usage}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'doctor' ? (
                <DoctorDashboard
                  loading={menu.loading}
                  report={menu.report}
                  error={menu.error}
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'mcp' ? (
                <McpPanel
                  model={menu.model}
                  state={menu.state}
                  width={width}
                  screenReader={axScreenReader}
                  dataPlane={dataPlane}
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
                  dataPlane={dataPlane}
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
                <ModelMenu
                  options={modelOptions}
                  effort={runtimePreferences.effort}
                  selectedIndex={menu.selectedIndex}
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
                  customThemes={customThemes}
                  syntaxHighlightingDisabled={
                    themeSettings.syntaxHighlightingDisabled
                  }
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : menu.kind === 'custom-theme-create' ? (
                <DialogFrame
                  title="New custom theme"
                  screenReader={axScreenReader}
                >
                  <Text>Name: {input || 'my-theme'}</Text>
                  <Text>
                    based on {menu.base} · saved to ~/{settingsDirectory}
                    /themes/theme.json
                  </Text>
                  <Text dimColor>Enter to create · Esc to cancel</Text>
                </DialogFrame>
              ) : menu.kind === 'custom-theme-editor' ? (
                <CustomThemeEditor
                  theme={menu.theme}
                  width={width}
                  screenReader={axScreenReader}
                  value={menu.query}
                  tokens={CUSTOM_THEME_TOKENS.filter((token) =>
                    token.toLowerCase().includes(menu.query.toLowerCase()),
                  )}
                  selectedIndex={menu.selectedIndex}
                  query={menu.query}
                />
              ) : menu.kind === 'custom-theme-token' ? (
                <CustomThemeEditor
                  theme={menu.theme}
                  token={menu.token}
                  width={width}
                  screenReader={axScreenReader}
                  value={input}
                />
              ) : menu.kind === 'custom-theme-delete' ? (
                <DialogFrame
                  title="Delete custom theme"
                  screenReader={axScreenReader}
                >
                  <Text>Delete {menu.theme.name} permanently?</Text>
                  <Text dimColor>Enter to confirm · Esc to cancel</Text>
                </DialogFrame>
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
              ) : menu.kind === 'copy' ? (
                <SelectionMenu
                  title="Copy"
                  description="Select content to copy:"
                  options={menu.candidates}
                  selectedIndex={menu.selectedIndex}
                  footer="Enter to copy · w to write to /tmp/claude · Esc to cancel"
                  width={width}
                  screenReader={axScreenReader}
                />
              ) : null
            ) : (
              <>
                {selectedCommandPalette !== undefined ? (
                  <CommandPalette
                    commands={matchingSlashCommands}
                    selectedIndex={selectedSlashCommandIndex}
                    width={width}
                    screenReader={axScreenReader}
                  />
                ) : null}
                {selectedFilePicker !== undefined ? (
                  <MentionPicker
                    entries={matchingMentionEntries}
                    selectedIndex={selectedFileIndex}
                    width={width}
                    screenReader={axScreenReader}
                  />
                ) : null}
                {selectedExitConfirmation !== undefined ? (
                  <ExitWarning />
                ) : null}
                {fixedViewport ? <Box flexGrow={1} /> : null}
                <Composer
                  input={shellMode ? input.slice(1) : input}
                  cursor={
                    shellMode ? Math.max(0, inputCursor - 1) : inputCursor
                  }
                  shellMode={shellMode}
                  {...(sessionColor === undefined ? {} : { sessionColor })}
                  {...(commandArgumentHint === undefined
                    ? {}
                    : { commandArgumentHint })}
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
                  reduceMotion={runtimeSettings.reduceMotion}
                  progressBar={runtimeSettings.progressBar}
                  {...(runtimeSettings.turnDuration
                    ? (() => {
                        const duration = formatTurnDuration(turnDuration)
                        return duration === undefined
                          ? {}
                          : { turnDuration: duration }
                      })()
                    : {})}
                  editorMode={runtimeSettings.editor}
                  {...(runtimeSettings.prStatus &&
                  activeSessionSummary?.prNumber
                    ? { prStatus: `PR #${activeSessionSummary.prNumber}` }
                    : {})}
                  shortcutsVisible={shortcutsVisible}
                  shortcutHelp={shortcutHelpSurface}
                  {...(editorFooterMessage === undefined
                    ? {}
                    : { footerMessage: editorFooterMessage })}
                />
                <StatusLine
                  configRoot={keybindingsRoot}
                  cwd={runtimeCwd}
                  dataPlane={dataPlane}
                  input={createClaudeStatusLineInput({
                    configRoot: keybindingsRoot,
                    cwd: runtimeCwd,
                    projectDir: display.cwd,
                    sessionId: sessionId ?? statusLineSessionId.current,
                    sessionName,
                    ...(runtimeDisplay.model === undefined
                      ? {}
                      : { model: runtimeDisplay.model }),
                    version: runtimeDisplay.version,
                    outputStyle: runtimeSettings.outputStyle,
                    permissionMode: runtimePreferences.permissionMode,
                    additionalDirectories:
                      runtimePreferences.additionalDirectories,
                    dataPlane,
                    ...(usage === undefined ? {} : { usage }),
                    ...(costUsd === undefined ? {} : { costUsd }),
                    ...(runtimeDisplay.contextWindowTokens === undefined
                      ? {}
                      : {
                          contextWindowTokens:
                            runtimeDisplay.contextWindowTokens,
                        }),
                    ...(runtimeSettings.editor === 'vim'
                      ? { vimMode: vimInsertMode ? 'INSERT' : 'NORMAL' }
                      : {}),
                  })}
                  refreshKey={[
                    history.length,
                    runtimePreferences.permissionMode,
                    runtimeDisplay.model,
                    runtimeSettings.outputStyle,
                    vimInsertMode,
                    sessionName,
                    usage?.inputTokens,
                    usage?.outputTokens,
                  ].join(':')}
                  width={width}
                  {...(settingSources === undefined ? {} : { settingSources })}
                />
              </>
            )}
          </>
        )}
      </Box>
    </TuiThemeProvider>
  )
}

/**
 * Whether the user explicitly saved a `tui` renderer value in configuration.
 * A fresh install leaves the setting unset, so the interactive TTY session can
 * default to the fullscreen renderer; once the user runs `/tui default` or
 * `/tui fullscreen`, the saved value is honored. If configuration cannot be
 * read, the loaded runtime setting is honored instead of guessing.
 */
async function tuiRendererExplicitlyConfigured(
  target?: Parameters<typeof loadConfigSettings>[0],
): Promise<boolean> {
  try {
    const snapshot = await loadConfigSettings(target)
    return snapshot.settings.tui !== undefined
  } catch {
    return true
  }
}

export async function runInteractive(options: {
  dataPlane?: DataPlane
  configRoot?: string
  statePath?: string
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
  runtimeSettings?: PraxisRuntimeSettings
  settingSources?: readonly ClaudeResourceScope[]
}): Promise<number> {
  const controller = new AbortController()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  let currentResume = options.resume
  let currentInitialPrompt = options.initialPrompt
  let initialAgentPromptResolved = false
  const dataPlane = options.dataPlane ?? resolveDataPlane()
  const configRoot = resolve(
    options.configRoot ?? resolveDataPlaneRoot({ dataPlane }),
  )
  const statePath =
    options.statePath ??
    (dataPlane === 'native'
      ? join(configRoot, 'state.json')
      : process.env.CLAUDE_CONFIG_DIR
        ? join(configRoot, '.claude.json')
        : resolve(homedir(), '.claude.json'))
  const runtimeSettingsTarget = { configRoot, statePath }
  let currentRuntimeSettings =
    options.runtimeSettings ??
    (await loadRuntimeSettings(runtimeSettingsTarget))
  // Fullscreen is the default interactive TTY renderer. Classic remains the
  // fallback for screen-reader and non-interactive execution, and an explicit
  // renderer saved in configuration is honored over the default.
  const rendererExplicitlyConfigured = await tuiRendererExplicitlyConfigured(
    runtimeSettingsTarget,
  )
  let currentRenderer = resolveTuiRenderer({
    configured: currentRuntimeSettings.tui,
    explicitlyConfigured: rendererExplicitlyConfigured,
    interactiveTty: process.stdin.isTTY === true,
    screenReader: options.axScreenReader ?? false,
  })
  if (currentRenderer !== currentRuntimeSettings.tui) {
    currentRuntimeSettings = { ...currentRuntimeSettings, tui: currentRenderer }
  }
  let rendererChange: {
    mode: PraxisRuntimeSettings['tui']
    sessionId: string | null
  } | null = null
  let rendererNotice: string | undefined
  const readRendererChange = () => rendererChange
  let initialThemeSettings = DEFAULT_TUI_THEME_SETTINGS
  let initialThemeLoadError: string | undefined
  try {
    initialThemeSettings = await loadTuiThemeSettings(configRoot)
  } catch (error) {
    initialThemeLoadError = `Unable to load theme settings: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
  while (true) {
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
      currentResume?.sessionId === undefined
        ? undefined
        : initialSessions.find(
            (session) =>
              session.sessionId.toLowerCase() ===
              currentResume?.sessionId?.toLowerCase(),
          )
    const resume = canonicalResumeSession
      ? { ...currentResume, sessionId: canonicalResumeSession.sessionId }
      : currentResume
    if (!initialAgentPromptResolved) {
      const agentInitialPrompt =
        resume === undefined ? listing.initialAgentPrompt?.() : undefined
      if (agentInitialPrompt) {
        currentInitialPrompt = currentInitialPrompt
          ? `${agentInitialPrompt}\n\n${currentInitialPrompt}`
          : agentInitialPrompt
      }
      initialAgentPromptResolved = true
    }
    let initialHistory: readonly TranscriptItem[] = []
    let initialSessionColor: AgentColorName | undefined
    try {
      initialHistory =
        resume?.sessionId === undefined || listing.transcript === undefined
          ? []
          : await listing.transcript(resume.sessionId)
      initialSessionColor =
        resume?.sessionId === undefined || listing.agentColor === undefined
          ? undefined
          : await listing.agentColor(resume.sessionId)
    } catch (error) {
      try {
        await listing.close?.()
      } catch {
        // Preserve the transcript-loading failure as the primary error.
      }
      throw error
    }
    await listing.close?.()
    if (signal.aborted) break
    const history =
      rendererNotice === undefined
        ? initialHistory
        : [
            ...initialHistory,
            { kind: 'local-result' as const, text: rendererNotice },
          ]
    rendererNotice = undefined
    let activeTurn: Promise<void> | null = null
    let cleanup: Promise<void> | null = null
    let backgrounded: InteractiveBackgroundResult | undefined
    rendererChange = null
    const instance = render(
      <InteractiveApp
        dataPlane={dataPlane}
        configRoot={configRoot}
        statePath={statePath}
        factory={options.factory}
        initialSessions={initialSessions}
        slashCommands={initialSlashCommands}
        agents={initialAgents}
        initialHistory={history}
        {...(initialSessionColor === undefined ? {} : { initialSessionColor })}
        runtimeSettings={currentRuntimeSettings}
        runtimeSettingsTarget={runtimeSettingsTarget}
        {...(options.settingSources === undefined
          ? {}
          : { settingSources: options.settingSources })}
        initialThemeSettings={initialThemeSettings}
        {...(initialThemeLoadError === undefined
          ? {}
          : { initialThemeLoadError })}
        {...(currentInitialPrompt === undefined
          ? {}
          : { initialPrompt: currentInitialPrompt })}
        signal={signal}
        onCancel={() => controller.abort()}
        onTurnChange={(turn) => {
          activeTurn = turn
        }}
        onCleanup={(closing) => {
          cleanup = closing
        }}
        onRendererChange={(mode, sessionId) => {
          rendererChange = { mode, sessionId }
          currentRenderer = mode
          currentRuntimeSettings = { ...currentRuntimeSettings, tui: mode }
        }}
        {...(options.onBackground === undefined
          ? {}
          : {
              onBackground: async (request: InteractiveBackgroundRequest) => {
                const result = await options.onBackground?.(request)
                if (!result)
                  throw new Error('Background launch returned no job')
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
        ...tuiInkRenderOptions(
          currentRenderer,
          options.axScreenReader === true,
        ),
        interactive: true,
      },
    )
    await instance.waitUntilExit()
    if (activeTurn) await activeTurn
    if (cleanup) await cleanup
    if (backgrounded) options.onBackgrounded?.(backgrounded)
    const change = readRendererChange()
    if (!change || signal.aborted) break
    currentInitialPrompt = undefined
    currentRenderer = change.mode
    rendererNotice =
      change.mode === 'fullscreen'
        ? 'Using flicker-free rendering'
        : 'Switched back to the classic renderer'
    currentResume = change.sessionId
      ? { sessionId: change.sessionId }
      : undefined
  }
  return signal.aborted ? 130 : 0
}
