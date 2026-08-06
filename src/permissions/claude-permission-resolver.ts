import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import type {
  ModelToolCall,
  PermissionBehavior,
  PermissionDecision,
  PermissionResolver,
} from '../core/runtime.js'

interface PermissionRule {
  behavior: PermissionBehavior
  toolName: string
  pattern: string | null
}

export interface ClaudePermissionResolverOptions {
  cwd: string
  cwdProvider?: () => string
  homeDirectory?: string
  settings: readonly ClaudeJsonResource[]
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
  permissionMode?: ClaudePermissionMode
}

export type ClaudePermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan'
  | 'default'

const DEFAULT_BEHAVIOR: Readonly<Record<string, 'allow' | 'ask'>> = {
  Agent: 'allow',
  SendMessage: 'allow',
  TaskOutput: 'allow',
  TaskStop: 'allow',
  TaskCreate: 'allow',
  TaskGet: 'allow',
  TaskList: 'allow',
  TaskUpdate: 'allow',
  CronCreate: 'allow',
  CronDelete: 'allow',
  CronList: 'allow',
  ScheduleWakeup: 'allow',
  Read: 'allow',
  Grep: 'allow',
  Write: 'ask',
  Edit: 'ask',
  NotebookEdit: 'ask',
  Glob: 'allow',
  ListMcpResourcesTool: 'allow',
  ReadMcpResourceDirTool: 'allow',
  ReadMcpResourceTool: 'allow',
  WebFetch: 'ask',
  WebSearch: 'ask',
  Bash: 'ask',
  Workflow: 'ask',
  StructuredOutput: 'allow',
  EnterWorktree: 'allow',
  ExitWorktree: 'allow',
}

const FILE_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRuleStrings(
  value: unknown,
  behavior: PermissionBehavior,
): PermissionRule[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'string') return []
    const match = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/.exec(item)
    const toolName = match?.[1]
    if (!toolName) return []
    return [
      {
        behavior,
        toolName,
        pattern: match[2] ?? null,
      },
    ]
  })
}

function loadRules(settings: readonly ClaudeJsonResource[]): PermissionRule[] {
  return settings.flatMap((resource) => {
    if (!isRecord(resource.value)) return []
    const permissions = resource.value.permissions
    if (!isRecord(permissions)) return []
    return [
      ...readRuleStrings(permissions.deny, 'deny'),
      ...readRuleStrings(permissions.ask, 'ask'),
      ...readRuleStrings(permissions.allow, 'allow'),
    ]
  })
}

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character
}

function globExpression(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        source += '(?:.*/)?'
        index += 2
      } else {
        source += '.*'
        index += 1
      }
      continue
    }
    if (character === '*') {
      source += '.*'
      continue
    }
    if (character === '?') {
      source += '.'
      continue
    }
    source += escapeRegularExpression(character ?? '')
  }
  return new RegExp(`${source}$`)
}

function permissionTarget(call: ModelToolCall): string | null {
  if (call.name === 'Bash') {
    return typeof call.input.command === 'string' ? call.input.command : null
  }
  if (call.name === 'Agent') {
    return typeof call.input.subagent_type === 'string'
      ? call.input.subagent_type
      : null
  }
  if (call.name === 'Glob') {
    return typeof call.input.path === 'string' ? call.input.path : '.'
  }
  if (call.name === 'Grep') {
    return typeof call.input.path === 'string' ? call.input.path : null
  }
  if (call.name === 'NotebookEdit') {
    return typeof call.input.notebook_path === 'string'
      ? call.input.notebook_path
      : null
  }
  if (call.name === 'WebFetch') {
    return typeof call.input.url === 'string' ? call.input.url : null
  }
  if (call.name === 'WebSearch') {
    return typeof call.input.query === 'string' ? call.input.query : null
  }
  return typeof call.input.file_path === 'string' ? call.input.file_path : null
}

function matchesRule(
  rule: PermissionRule,
  call: ModelToolCall,
  cwd: string,
  homeDirectory: string,
): boolean {
  if (rule.toolName !== call.name) return false
  if (rule.pattern === null) return true
  let target = permissionTarget(call)
  if (target === null) return false
  if (
    call.name === 'Bash' &&
    rule.behavior === 'allow' &&
    rule.pattern.includes('*') &&
    /[\n\r;|&<>`]|\$\(/.test(target)
  ) {
    return false
  }
  if (call.name === 'Bash' && rule.pattern.endsWith(':*')) {
    const commandPrefix = rule.pattern.slice(0, -2)
    return target === commandPrefix || target.startsWith(`${commandPrefix} `)
  }
  if (call.name === 'WebFetch' && rule.pattern.startsWith('domain:')) {
    try {
      const hostname = new URL(target).hostname.toLowerCase().replace(/\.$/, '')
      const domainPattern = rule.pattern.slice('domain:'.length).toLowerCase()
      return globExpression(domainPattern).test(hostname)
    } catch {
      return false
    }
  }
  let permissionPattern = rule.pattern
  if (FILE_TOOLS.has(call.name)) {
    if (permissionPattern.startsWith('//')) {
      permissionPattern = permissionPattern.slice(1)
    } else if (permissionPattern === '~') {
      permissionPattern = homeDirectory
    } else if (permissionPattern.startsWith('~/')) {
      permissionPattern = resolve(homeDirectory, permissionPattern.slice(2))
    } else if (!isAbsolute(permissionPattern)) {
      permissionPattern = resolve(cwd, permissionPattern)
    }
    if (!isAbsolute(target)) target = resolve(cwd, target)
  }
  return globExpression(permissionPattern).test(target)
}

export class ClaudePermissionResolver implements PermissionResolver {
  private readonly rules: readonly PermissionRule[]
  private readonly cwd: string
  private readonly cwdProvider: (() => string) | undefined
  private readonly homeDirectory: string
  private readonly permissionMode: ClaudePermissionMode

  constructor(options: ClaudePermissionResolverOptions) {
    this.cwd = resolve(options.cwd)
    this.cwdProvider = options.cwdProvider
    this.homeDirectory = resolve(options.homeDirectory ?? homedir())
    this.rules = [
      ...loadRules(options.settings),
      ...readRuleStrings(options.disallowedTools ?? [], 'deny'),
      ...readRuleStrings(options.allowedTools ?? [], 'allow'),
    ]
    this.permissionMode = options.permissionMode ?? 'default'
    if (this.permissionMode === 'auto') {
      throw new Error(
        'Permission mode auto requires a classifier and is not implemented yet',
      )
    }
  }

  async resolve(call: ModelToolCall): Promise<PermissionDecision> {
    const matchingRule = (behavior: PermissionBehavior) =>
      this.rules.find(
        (candidate) =>
          candidate.behavior === behavior &&
          matchesRule(
            candidate,
            call,
            resolve(this.cwdProvider?.() ?? this.cwd),
            this.homeDirectory,
          ),
      )
    const denied = matchingRule('deny')
    if (denied) {
      const suffix = denied.pattern === null ? '' : `(${denied.pattern})`
      return {
        behavior: 'deny',
        reason: `Denied by Claude permission rule ${denied.toolName}${suffix}`,
      }
    }
    if (this.permissionMode === 'bypassPermissions') {
      return { behavior: 'allow' }
    }
    if (
      this.permissionMode === 'plan' &&
      (call.name === 'Write' ||
        call.name === 'Edit' ||
        call.name === 'NotebookEdit')
    ) {
      return {
        behavior: 'deny',
        reason: `Cannot use ${call.name} while in plan mode`,
      }
    }

    if (matchingRule('ask')) return this.askDecision(call)
    if (matchingRule('allow')) return { behavior: 'allow' }
    if (
      this.permissionMode === 'acceptEdits' &&
      (call.name === 'Write' ||
        call.name === 'Edit' ||
        call.name === 'NotebookEdit')
    ) {
      return { behavior: 'allow' }
    }

    const defaultBehavior = DEFAULT_BEHAVIOR[call.name]
    return defaultBehavior === 'ask'
      ? this.askDecision(call)
      : defaultBehavior
        ? { behavior: defaultBehavior }
        : { behavior: 'deny', reason: `Unknown tool ${call.name}` }
  }

  private askDecision(call: ModelToolCall): PermissionDecision {
    return this.permissionMode === 'dontAsk' || this.permissionMode === 'plan'
      ? {
          behavior: 'deny',
          reason: `Permission to use ${call.name} is disabled in ${this.permissionMode} mode`,
        }
      : {
          behavior: 'ask',
          ...(call.name === 'Workflow'
            ? { reason: 'Review dynamic workflow before running' }
            : {}),
        }
  }
}
