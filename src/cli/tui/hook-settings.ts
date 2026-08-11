import type { ClaudeJsonResource } from '../../compatibility/claude/shared-resources.js'

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

const COMMAND_EXIT_HELP = [
  'Exit code 0 - stdout/stderr not shown',
  'Exit code 2 - show stderr to model and block the action',
  'Other exit codes - show stderr to user only but continue',
] as const

export const TUI_HOOK_EVENTS: readonly TuiHookEventDefinition[] = [
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
      'Input includes the tool input and successful result.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'PostToolUseFailure',
    description: 'After tool execution fails',
    detail: [
      'Input includes the tool input and failure details.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'PostToolBatch',
    description: 'After a batch of tool calls resolves',
    detail: [
      'Input includes the completed batch of tool calls.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'PermissionDenied',
    description: 'After auto mode classifier denies a tool call',
    detail: [
      'Input includes the denied tool call and classifier decision.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'Notification',
    description: 'When notifications are sent',
    detail: [
      'Input includes the notification type and message.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'UserPromptSubmit',
    description: 'When the user submits a prompt',
    detail: ['Input includes the submitted prompt.', ...COMMAND_EXIT_HELP],
  },
  {
    name: 'UserPromptExpansion',
    description: 'After a user-typed slash command expands into a prompt',
    detail: [
      'Input includes the typed command and expanded prompt.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'SessionStart',
    description: 'When a new session is started',
    detail: [
      'Matchers select startup, resume, clear, or compact sources.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'Stop',
    description: 'Right before Claude concludes its response',
    detail: [
      'Input includes the final response and stop-hook state.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'StopFailure',
    description: 'When the turn ends due to an API error',
    detail: [
      'Input includes the failed turn and API error.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'SubagentStart',
    description: 'When a subagent (Agent tool call) is started',
    detail: [
      'Input includes the subagent type and invocation.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'SubagentStop',
    description:
      'Right before a subagent (Agent tool call) concludes its response',
    detail: [
      'Input includes the completed subagent response.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'PreCompact',
    description: 'Before conversation compaction',
    detail: [
      'Matchers select manual or automatic compaction.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'PostCompact',
    description: 'After conversation compaction',
    detail: [
      'Input includes the compacted session state.',
      ...COMMAND_EXIT_HELP,
    ],
  },
  {
    name: 'SessionEnd',
    description: 'When a session is ending',
    detail: ['Matchers select the session end reason.', ...COMMAND_EXIT_HELP],
  },
  {
    name: 'PermissionRequest',
    description: 'When a permission dialog is displayed',
    detail: [
      'Input includes the requested tool call and permission context.',
      ...COMMAND_EXIT_HELP,
    ],
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function scope(resource: ClaudeJsonResource): {
  short: string
  long: string
} {
  if (resource.plugin) return { short: 'Plugin', long: 'Plugin Settings' }
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
      if (left.matcher === '(all)' && right.matcher !== '(all)') return -1
      if (right.matcher === '(all)' && left.matcher !== '(all)') return 1
      return left.matcher.localeCompare(right.matcher)
    })
    return { ...definition, matchers }
  })
  return { events, hookCount }
}
