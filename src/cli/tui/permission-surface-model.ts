import type { ComposerEditorState } from './composer-editor.js'
import type {
  TuiPermissionBehavior,
  TuiPermissionRule,
} from './permission-settings.js'
import type { RecentlyDeniedAction } from './recently-denied.js'
import type {
  TuiToolPermissionModel,
  TuiToolPermissionOption,
} from './tool-permission.js'

export type TuiPermissionSurfaceInput =
  | {
      kind: 'tool-request'
      model: TuiToolPermissionModel
      selection: number
      feedbackMode: boolean
      feedback: string
      ruleEditor?: ComposerEditorState | null
    }
  | {
      kind: 'recovery-request'
      display: string
      heading?: string
      selection: number
      feedbackMode: boolean
      feedback: string
    }
  | {
      kind: 'permission-dashboard'
      tabIndex: number
      selectedIndex: number
      query: string
      rules: readonly TuiPermissionRule[]
      recentDenied: readonly RecentlyDeniedAction[]
      retryingDeniedId?: string | null
      workspaceDirectories: readonly {
        path: string
        original: boolean
      }[]
    }
  | {
      kind: 'permission-rule-input'
      behavior: TuiPermissionBehavior
      value: string
    }
  | {
      kind: 'permission-scope'
      behavior: TuiPermissionBehavior
      rule: string
      selectedIndex: number
      settingsDirectory: string
    }
  | {
      kind: 'permission-delete'
      rule: TuiPermissionRule
      selectedIndex: number
    }
  | {
      kind: 'workspace-directory-input'
      value: string
    }
  | {
      kind: 'workspace-directory-delete'
      path: string
      selectedIndex: number
    }

export interface TuiPermissionSurfaceAction {
  readonly label: string
  readonly key?: string
  readonly screenReaderLabel?: string
  readonly usesSelectionRange?: boolean
}

export interface TuiPermissionSurfaceOption {
  readonly index: number
  readonly label: string
  readonly description?: string
  readonly selected: boolean
  readonly value?: string
}

export interface TuiPermissionSurfaceRow {
  readonly index: number
  readonly label: string
  readonly description?: string
  readonly selected: boolean
  readonly id?: string
  readonly status?: 'denied' | 'retrying'
  readonly original?: boolean
}

export interface TuiPermissionDashboardModel {
  readonly kind: 'permission-dashboard'
  readonly heading: 'Permissions'
  readonly tabs: readonly {
    readonly index: number
    readonly label: string
    readonly current: boolean
  }[]
  readonly tabIndex: number
  readonly description: string
  readonly query: string
  readonly rows: readonly TuiPermissionSurfaceRow[]
  readonly emptyState?: string
  readonly originalWorkspace?: TuiPermissionSurfaceRow
  readonly range: { readonly min: number; readonly max: number }
  readonly actions: readonly TuiPermissionSurfaceAction[]
  readonly cancellation: string
}

export interface TuiPermissionToolRequestModel {
  readonly kind: 'tool-request'
  readonly heading: string
  readonly tool: TuiToolPermissionModel
  readonly options: readonly TuiToolPermissionOption[]
  readonly selectedIndex: number
  readonly range: { readonly min: number; readonly max: number }
  readonly feedbackMode: boolean
  readonly feedback: string
  readonly ruleEditor?: ComposerEditorState | null
  readonly actions: readonly TuiPermissionSurfaceAction[]
  readonly cancellation: string
}

export interface TuiPermissionRecoveryRequestModel {
  readonly kind: 'recovery-request'
  readonly heading: string
  readonly display: string
  readonly question: string
  readonly options: readonly TuiPermissionSurfaceOption[]
  readonly selectedIndex: number
  readonly range: { readonly min: number; readonly max: number }
  readonly feedbackMode: boolean
  readonly feedback: string
  readonly feedbackPlaceholder: string
  readonly actions: readonly TuiPermissionSurfaceAction[]
  readonly cancellation: string
}

export interface TuiPermissionRuleInputModel {
  readonly kind: 'permission-rule-input'
  readonly heading: string
  readonly behavior: TuiPermissionBehavior
  readonly value: string
  readonly description: string
  readonly placeholder: string
  readonly actions: readonly TuiPermissionSurfaceAction[]
  readonly cancellation: string
}

export interface TuiPermissionScopeModel {
  readonly kind: 'permission-scope'
  readonly heading: string
  readonly behavior: TuiPermissionBehavior
  readonly rule: string
  readonly description: string
  readonly options: readonly TuiPermissionSurfaceOption[]
  readonly selectedIndex: number
  readonly range: { readonly min: number; readonly max: number }
  readonly actions: readonly TuiPermissionSurfaceAction[]
  readonly cancellation: string
}

export interface TuiPermissionDeleteModel {
  readonly kind: 'permission-delete'
  readonly heading: string
  readonly rule: string
  readonly description?: string
  readonly scope: string
  readonly question: string
  readonly options: readonly TuiPermissionSurfaceOption[]
  readonly selectedIndex: number
  readonly range: { readonly min: number; readonly max: number }
  readonly actions: readonly TuiPermissionSurfaceAction[]
  readonly cancellation: string
}

export interface TuiWorkspaceDirectoryInputModel {
  readonly kind: 'workspace-directory-input'
  readonly heading: string
  readonly description: string
  readonly value: string
  readonly placeholder: string
  readonly actions: readonly TuiPermissionSurfaceAction[]
  readonly cancellation: string
}

export interface TuiWorkspaceDirectoryDeleteModel {
  readonly kind: 'workspace-directory-delete'
  readonly heading: string
  readonly path: string
  readonly description: string
  readonly options: readonly TuiPermissionSurfaceOption[]
  readonly selectedIndex: number
  readonly range: { readonly min: number; readonly max: number }
  readonly actions: readonly TuiPermissionSurfaceAction[]
  readonly cancellation: string
}

export type TuiPermissionSurfaceModel =
  | TuiPermissionToolRequestModel
  | TuiPermissionRecoveryRequestModel
  | TuiPermissionDashboardModel
  | TuiPermissionRuleInputModel
  | TuiPermissionScopeModel
  | TuiPermissionDeleteModel
  | TuiWorkspaceDirectoryInputModel
  | TuiWorkspaceDirectoryDeleteModel

function integer(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback
  return Math.trunc(value)
}

function selectedIndex(value: number, count: number, empty = -1): number {
  if (count <= 0) return empty
  return Math.max(0, Math.min(count - 1, integer(value)))
}

function dashboardSelectedIndex(value: number, count: number): number {
  if (count <= 0) return -1
  const normalized = integer(value, -1)
  return normalized < 0 ? -1 : Math.min(count - 1, normalized)
}

function range(count: number): { min: number; max: number } {
  return { min: count > 0 ? 1 : 0, max: count }
}

function options(
  labels: readonly { label: string; description?: string; value?: string }[],
  selection: number,
): {
  options: readonly TuiPermissionSurfaceOption[]
  selectedIndex: number
  range: { min: number; max: number }
} {
  const selected = selectedIndex(selection, labels.length)
  return {
    options: labels.map((option, index) => ({
      ...option,
      index: index + 1,
      selected: index === selected,
    })),
    selectedIndex: selected,
    range: range(labels.length),
  }
}

function permissionRuleDescription(rule: string): string | undefined {
  const bashPrefix = /^Bash\((.*?)(?::\*| \*)\)$/u.exec(rule)?.[1]?.trim()
  return bashPrefix ? `Any Bash command starting with ${bashPrefix}` : undefined
}

function permissionScopeLabel(scope: TuiPermissionRule['scope']): string {
  return scope === 'local'
    ? 'From project local settings'
    : scope === 'project'
      ? 'From project settings'
      : 'From user settings'
}

export function projectTuiPermissionSurface(
  input: TuiPermissionSurfaceInput,
): TuiPermissionSurfaceModel {
  switch (input.kind) {
    case 'tool-request': {
      const selected = selectedIndex(
        input.selection,
        input.model.options.length,
      )
      return {
        kind: input.kind,
        heading: input.model.title,
        tool: input.model,
        options: input.model.options,
        selectedIndex: selected,
        range: range(input.model.options.length),
        feedbackMode: input.feedbackMode,
        feedback: input.feedback,
        ...(input.ruleEditor === undefined
          ? {}
          : { ruleEditor: input.ruleEditor }),
        actions: [
          {
            label: input.feedbackMode ? 'Enter to submit' : 'Enter to select',
            key: 'Enter',
            usesSelectionRange: !input.feedbackMode,
          },
          { label: 'Tab to amend', key: 'Tab' },
        ],
        cancellation: 'Escape to cancel',
      }
    }
    case 'recovery-request': {
      const projected = options(
        [{ label: 'Yes' }, { label: 'No' }],
        input.selection,
      )
      return {
        kind: input.kind,
        heading: input.heading ?? 'Retry interrupted tool?',
        display: input.display,
        question: 'Do you want to proceed?',
        ...projected,
        feedbackMode: input.feedbackMode,
        feedback: input.feedback,
        feedbackPlaceholder:
          projected.selectedIndex === 0
            ? 'tell Praxis what to do next'
            : 'tell Praxis what to do differently',
        actions: [
          {
            label: input.feedbackMode ? 'Enter to submit' : 'Enter to confirm',
            key: 'Enter',
            usesSelectionRange: !input.feedbackMode,
          },
          {
            label: input.feedbackMode
              ? 'Tab to collapse'
              : 'Tab to add feedback',
            key: 'Tab',
          },
        ],
        cancellation: 'Escape to cancel',
      }
    }
    case 'permission-dashboard': {
      const tabs = [
        'Recently denied',
        'Allow',
        'Ask',
        'Deny',
        'Workspace',
      ] as const
      const tabIndex = selectedIndex(input.tabIndex, tabs.length)
      const behavior = (['allow', 'ask', 'deny'] as const)[tabIndex - 1]
      const normalizedQuery = input.query.trim().toLowerCase()
      const matchingRules = behavior
        ? input.rules.filter(
            (rule) =>
              rule.behavior === behavior &&
              (!normalizedQuery ||
                rule.rule.toLowerCase().includes(normalizedQuery) ||
                rule.scope.includes(normalizedQuery)),
          )
        : []
      const originalWorkspace = input.workspaceDirectories.find(
        (directory) => directory.original,
      )
      const additionalWorkspaces = input.workspaceDirectories.filter(
        (directory) => !directory.original,
      )
      let rows: TuiPermissionSurfaceRow[]
      let rowCount: number
      if (tabIndex === 0) {
        rows = input.recentDenied.map((action, index) => ({
          index: index + 1,
          label: action.display,
          description: action.reason,
          selected:
            index ===
            dashboardSelectedIndex(
              input.selectedIndex,
              input.recentDenied.length,
            ),
          id: action.id,
          status: action.id === input.retryingDeniedId ? 'retrying' : 'denied',
        }))
        rowCount = rows.length
      } else if (tabIndex === 4) {
        rows = additionalWorkspaces.map((directory, index) => ({
          index: index + 1,
          label: directory.path,
          selected:
            index ===
            dashboardSelectedIndex(
              input.selectedIndex,
              additionalWorkspaces.length + 1,
            ),
          original: false,
        }))
        rowCount = additionalWorkspaces.length + 1
        rows.push({
          index: rowCount,
          label: 'Add directory…',
          selected:
            dashboardSelectedIndex(input.selectedIndex, rowCount) ===
            rowCount - 1,
        })
      } else {
        rows = matchingRules.map((rule, index) => ({
          index: index + 2,
          label: rule.rule,
          description: permissionScopeLabel(rule.scope),
          selected:
            index + 1 ===
            dashboardSelectedIndex(
              input.selectedIndex,
              matchingRules.length + 1,
            ),
        }))
        rows.unshift({
          index: 1,
          label: 'Add a new rule…',
          selected:
            dashboardSelectedIndex(
              input.selectedIndex,
              matchingRules.length + 1,
            ) === 0,
        })
        rowCount = rows.length
      }
      const normalizedSelected = dashboardSelectedIndex(
        input.selectedIndex,
        rowCount,
      )
      rows = rows.map((row, index) => ({
        ...row,
        selected: index === normalizedSelected,
      }))
      const description =
        tabIndex === 0
          ? input.recentDenied.length === 0
            ? 'Commands denied by the auto mode classifier will appear here.'
            : 'Commands recently denied by the auto mode classifier.'
          : tabIndex === 1
            ? "Praxis Code won't ask before using allowed tools."
            : tabIndex === 2
              ? 'Praxis Code will always ask for confirmation before using these tools.'
              : tabIndex === 3
                ? 'Praxis Code will reject requests to use denied tools.'
                : 'Praxis Code can read files in the workspace, and make edits when auto-accept edits is on.'
      const emptyState =
        tabIndex === 0 && input.recentDenied.length === 0
          ? 'No recent denials.'
          : tabIndex >= 1 && tabIndex <= 3 && matchingRules.length === 0
            ? 'No matching permission rules.'
            : undefined
      return {
        kind: input.kind,
        heading: 'Permissions',
        tabs: tabs.map((label, index) => ({
          index,
          label,
          current: index === tabIndex,
        })),
        tabIndex,
        description,
        query: input.query,
        rows,
        ...(emptyState ? { emptyState } : {}),
        ...(tabIndex === 4 && originalWorkspace
          ? {
              originalWorkspace: {
                index: 0,
                label: originalWorkspace.path,
                description: 'Original working directory',
                selected: false,
                original: true,
              },
            }
          : {}),
        range: range(rowCount),
        actions:
          tabIndex === 0
            ? input.recentDenied.length === 0
              ? [
                  {
                    label: '←/→ to switch',
                    screenReaderLabel: 'Use left/right arrows to switch tabs',
                  },
                ]
              : [
                  {
                    label: 'Enter to approve',
                    key: 'Enter',
                    usesSelectionRange: true,
                  },
                  { label: 'r to retry', key: 'r' },
                  {
                    label: '↑/↓ to navigate',
                    screenReaderLabel: 'Use up/down arrows to navigate',
                  },
                ]
            : normalizedSelected >= 0
              ? [
                  {
                    label: '↑/↓ navigate',
                    screenReaderLabel: 'Use up/down arrows to navigate',
                  },
                  {
                    label: 'Enter to select',
                    key: 'Enter',
                    usesSelectionRange: true,
                  },
                  {
                    label: '←/→ to switch',
                    screenReaderLabel: 'Use left/right arrows to switch tabs',
                  },
                ]
              : [
                  {
                    label: '←/→ to switch',
                    screenReaderLabel: 'Use left/right arrows to switch tabs',
                  },
                  {
                    label: '↓ to select',
                    screenReaderLabel: 'Use down arrow to select',
                  },
                ],
        cancellation: 'Escape to cancel',
      }
    }
    case 'permission-rule-input':
      return {
        kind: input.kind,
        heading: `Add ${input.behavior} permission rule`,
        behavior: input.behavior,
        value: input.value,
        description:
          'Permission rules are a tool name, optionally followed by a specifier in parentheses.\ne.g., WebFetch or Bash(ls *)',
        placeholder: 'Enter permission rule…',
        actions: [{ label: 'Enter to submit', key: 'Enter' }],
        cancellation: 'Escape to cancel',
      }
    case 'permission-scope': {
      const projected = options(
        [
          {
            label: 'Project settings (local)',
            description: `Saved in ${input.settingsDirectory}/settings.local.json`,
            value: 'local',
          },
          {
            label: 'Project settings',
            description: `Checked in at ${input.settingsDirectory}/settings.json`,
            value: 'project',
          },
          {
            label: 'User settings',
            description: `Saved in ~/${input.settingsDirectory}/settings.json`,
            value: 'user',
          },
        ],
        input.selectedIndex,
      )
      return {
        kind: input.kind,
        heading: 'Where should this rule be saved?',
        behavior: input.behavior,
        rule: input.rule,
        description: permissionRuleDescription(input.rule)
          ? `${input.rule} · ${permissionRuleDescription(input.rule)}`
          : input.rule,
        ...projected,
        actions: [
          {
            label: 'Enter to select',
            key: 'Enter',
            usesSelectionRange: true,
          },
        ],
        cancellation: 'Escape to cancel',
      }
    }
    case 'permission-delete': {
      const projected = options(
        [{ label: 'Yes' }, { label: 'No' }],
        input.selectedIndex,
      )
      const ruleDescription = permissionRuleDescription(input.rule.rule)
      return {
        kind: input.kind,
        heading: `Delete ${input.rule.behavior === 'allow' ? 'allowed' : input.rule.behavior === 'deny' ? 'denied' : 'ask'} tool?`,
        rule: input.rule.rule,
        ...(ruleDescription ? { description: ruleDescription } : {}),
        scope: permissionScopeLabel(input.rule.scope),
        question: 'Are you sure you want to delete this permission rule?',
        ...projected,
        actions: [
          {
            label: 'Enter to select',
            key: 'Enter',
            usesSelectionRange: true,
          },
        ],
        cancellation: 'Escape to cancel',
      }
    }
    case 'workspace-directory-input':
      return {
        kind: input.kind,
        heading: 'Add directory to workspace',
        description:
          'Praxis Code will be able to read files in this directory and make edits when auto-accept edits is on.\n\nEnter the path to the directory:',
        value: input.value,
        placeholder: 'Directory path…',
        actions: [
          { label: 'Tab to complete', key: 'Tab' },
          { label: 'Enter to add', key: 'Enter' },
        ],
        cancellation: 'Escape to cancel',
      }
    case 'workspace-directory-delete': {
      const projected = options(
        [{ label: 'Yes' }, { label: 'No' }],
        input.selectedIndex,
      )
      return {
        kind: input.kind,
        heading: 'Remove directory from workspace?',
        path: input.path,
        description:
          'Praxis Code will no longer have access to files in this directory.',
        ...projected,
        actions: [
          {
            label: 'Enter to confirm',
            key: 'Enter',
            usesSelectionRange: true,
          },
        ],
        cancellation: 'Escape to cancel',
      }
    }
  }
}
