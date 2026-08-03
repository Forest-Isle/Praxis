import { isAbsolute, resolve } from 'node:path'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import type {
  ModelToolCall,
  PermissionBehavior,
  PermissionDecision,
  PermissionResolver,
} from '../core/runtime.js'

interface PermissionRule {
  behavior: PermissionBehavior
  source: string
  toolName: string
  pattern: string | null
}

export interface ClaudePermissionResolverOptions {
  cwd: string
  settings: readonly ClaudeJsonResource[]
}

const DEFAULT_BEHAVIOR: Readonly<Record<string, 'allow' | 'ask'>> = {
  Read: 'allow',
  Grep: 'allow',
  Write: 'ask',
  Edit: 'ask',
  Bash: 'ask',
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'Grep'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRuleStrings(
  value: unknown,
  behavior: PermissionBehavior,
  source: string,
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
        source,
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
      ...readRuleStrings(permissions.deny, 'deny', resource.path),
      ...readRuleStrings(permissions.ask, 'ask', resource.path),
      ...readRuleStrings(permissions.allow, 'allow', resource.path),
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
  if (call.name === 'Grep') {
    return typeof call.input.path === 'string' ? call.input.path : null
  }
  return typeof call.input.file_path === 'string' ? call.input.file_path : null
}

function matchesRule(
  rule: PermissionRule,
  call: ModelToolCall,
  cwd: string,
): boolean {
  if (rule.toolName !== call.name) return false
  if (rule.pattern === null) return true
  const target = permissionTarget(call)
  if (target === null) return false
  if (call.name === 'Bash' && rule.pattern.endsWith(':*')) {
    const commandPrefix = rule.pattern.slice(0, -2)
    return target === commandPrefix || target.startsWith(`${commandPrefix} `)
  }
  const pattern =
    FILE_TOOLS.has(call.name) && !isAbsolute(rule.pattern)
      ? resolve(cwd, rule.pattern)
      : rule.pattern
  return globExpression(pattern).test(target)
}

export class ClaudePermissionResolver implements PermissionResolver {
  private readonly rules: readonly PermissionRule[]
  private readonly cwd: string

  constructor(options: ClaudePermissionResolverOptions) {
    this.cwd = resolve(options.cwd)
    this.rules = loadRules(options.settings)
  }

  async resolve(call: ModelToolCall): Promise<PermissionDecision> {
    for (const behavior of ['deny', 'ask', 'allow'] as const) {
      const rule = this.rules.find(
        (candidate) =>
          candidate.behavior === behavior &&
          matchesRule(candidate, call, this.cwd),
      )
      if (!rule) continue
      if (behavior === 'deny') {
        const suffix = rule.pattern === null ? '' : `(${rule.pattern})`
        return {
          behavior,
          reason: `Denied by Claude permission rule ${rule.toolName}${suffix}`,
        }
      }
      return { behavior }
    }

    const defaultBehavior = DEFAULT_BEHAVIOR[call.name]
    return defaultBehavior
      ? { behavior: defaultBehavior }
      : { behavior: 'deny', reason: `Unknown tool ${call.name}` }
  }
}
