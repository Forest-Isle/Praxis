import type { ClaudeJsonResource } from '../../compatibility/claude/shared-resources.js'
import {
  HOOK_EVENTS,
  type ClaudeHookEventName,
} from '../../hooks/claude-hooks.js'

export interface TuiHookEventDefinition {
  name: string
  description: string
  detail: readonly string[]
}

export interface TuiHookEntry {
  type: string
  label: string
  scopeLabel: string
  path: string
}

export interface TuiHookMatcher {
  matcher: string
  scope: string
  scopeLabel: string
  hooks: readonly TuiHookEntry[]
}

export interface TuiHookEvent extends TuiHookEventDefinition {
  matchers: readonly TuiHookMatcher[]
}

export interface TuiHookConfiguration {
  events: readonly TuiHookEvent[]
  hookCount: number
}

export const TUI_HOOK_MENU = {
  title: 'Hooks',
  readOnlyNotice:
    'This menu is read-only. To add or modify hooks, edit settings.json directly or ask Claude.',
  visibleRows: 5,
} as const

const TUI_HOOK_EVENT_DEFINITIONS: readonly TuiHookEventDefinition[] = [
  {
    name: 'PreToolUse',
    description: 'Before tool execution',
    detail: [
      'Input to command is JSON of tool call arguments.',
      'Exit code 0 - stdout/stderr not shown',
      'Exit code 2 - show stderr to model and block tool call',
      'Other exit codes - show stderr to user only but continue with tool call',
    ],
  },
  {
    name: 'PostToolUse',
    description: 'After tool execution',
    detail: [
      'Input to command is JSON with fields "inputs" (tool call arguments) and "response" (tool call response).',
      'Exit code 0 - stdout shown in transcript mode (ctrl+o)',
      'Exit code 2 - show stderr to model immediately',
      'Other exit code - show stderr to user only',
    ],
  },
  {
    name: 'PostToolUseFailure',
    description: 'After tool execution fails',
    detail: [],
  },
  {
    name: 'PostToolBatch',
    description: 'After a batch of tool calls resolves',
    detail: [],
  },
  {
    name: 'PermissionDenied',
    description: 'After auto mode classifier denies a tool call',
    detail: [],
  },
  {
    name: 'Notification',
    description: 'When notifications are sent',
    detail: [
      'Input to command is JSON with notification message and type.',
      'Exit code 0 - stdout/stderr not shown',
      'Other exit codes - show stderr to user only',
    ],
  },
  {
    name: 'UserPromptSubmit',
    description: 'When the user submits a prompt',
    detail: [
      'Input to command is JSON with original user prompt text.',
      'Exit code 0 - stdout shown to Claude',
      'Exit code 2 - block processing, erase original prompt, and show stderr to user only',
      'Other exit codes - show stderr to user only',
    ],
  },
  {
    name: 'UserPromptExpansion',
    description: 'After a user-typed slash command expands into a prompt',
    detail: [],
  },
  {
    name: 'SessionStart',
    description: 'When a new session is started',
    detail: [],
  },
  {
    name: 'Stop',
    description: 'Right before Claude concludes its response',
    detail: [],
  },
  {
    name: 'StopFailure',
    description: 'When the turn ends due to an API error',
    detail: [],
  },
  {
    name: 'SubagentStart',
    description: 'When a subagent (Agent tool call) is started',
    detail: [],
  },
  {
    name: 'SubagentStop',
    description:
      'Right before a subagent (Agent tool call) concludes its response',
    detail: [],
  },
  {
    name: 'PreCompact',
    description: 'Before conversation compaction',
    detail: [],
  },
  {
    name: 'PostCompact',
    description: 'After conversation compaction',
    detail: [],
  },
  {
    name: 'SessionEnd',
    description: 'When a session is ending',
    detail: [],
  },
  {
    name: 'PermissionRequest',
    description: 'When a permission dialog is displayed',
    detail: [],
  },
]

const OBSERVED_TUI_EVENTS_2_1_208 = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
  'PermissionRequest',
])

export const TUI_HOOK_EVENTS: readonly TuiHookEventDefinition[] =
  TUI_HOOK_EVENT_DEFINITIONS.filter(
    (definition) =>
      OBSERVED_TUI_EVENTS_2_1_208.has(definition.name) &&
      HOOK_EVENTS.includes(definition.name as ClaudeHookEventName),
  )

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scope(resource: ClaudeJsonResource): {
  short: string
  long: string
} {
  if (resource.plugin)
    return {
      short: 'Plugin',
      long: `Plugin Hooks (${resource.pluginSource ?? resource.pluginName ?? 'plugin'})`,
    }
  if (resource.scope === 'project')
    return { short: 'Project', long: 'Project Settings' }
  if (resource.scope === 'local')
    return { short: 'Local', long: 'Local Settings' }
  return { short: 'User', long: 'User Settings' }
}

function hookLabel(hook: Record<string, unknown>, type: string): string {
  const statusMessage = hook.statusMessage
  if (typeof statusMessage === 'string' && statusMessage.length > 0)
    return statusMessage
  const field =
    type === 'command' ? 'command' : type === 'http' ? 'url' : 'prompt'
  const label = hook[field]
  if (typeof label === 'string' && label.length > 0) return label
  return type
}

const HOOK_SCOPE_ORDER: Record<string, number> = {
  Local: 0,
  Project: 1,
  User: 2,
  Plugin: 3,
}

export function projectTuiHooks(
  settings: readonly ClaudeJsonResource[],
): TuiHookConfiguration {
  let hookCount = 0
  const events = TUI_HOOK_EVENTS.map((definition): TuiHookEvent => {
    const matchers: TuiHookMatcher[] = []
    for (const resource of settings) {
      if (!isRecord(resource.value) || !isRecord(resource.value.hooks)) continue
      const configured = resource.value.hooks[definition.name]
      if (!Array.isArray(configured)) continue
      for (const group of configured) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue
        const labels = scope(resource)
        const hooks = group.hooks.flatMap((hook): TuiHookEntry[] => {
          if (!isRecord(hook)) return []
          const type =
            typeof hook.type === 'string' && hook.type.length > 0
              ? hook.type
              : 'command'
          hookCount += 1
          return [
            {
              type,
              label: hookLabel(hook, type),
              scopeLabel: labels.long,
              path: resource.path,
            },
          ]
        })
        if (hooks.length === 0) continue
        matchers.push({
          matcher:
            typeof group.matcher === 'string' && group.matcher.length > 0
              ? group.matcher
              : '(all)',
          scope: labels.short,
          scopeLabel: labels.long,
          hooks,
        })
      }
    }
    matchers.sort((left, right) => {
      const scopeOrder =
        (HOOK_SCOPE_ORDER[left.scope] ?? Number.MAX_SAFE_INTEGER) -
        (HOOK_SCOPE_ORDER[right.scope] ?? Number.MAX_SAFE_INTEGER)
      if (scopeOrder !== 0) return scopeOrder
      if (left.matcher === '(all)' && right.matcher !== '(all)') return -1
      if (right.matcher === '(all)' && left.matcher !== '(all)') return 1
      return left.matcher.localeCompare(right.matcher)
    })
    return { ...definition, matchers }
  })
  return { events, hookCount }
}
