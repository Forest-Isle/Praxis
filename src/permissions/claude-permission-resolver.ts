import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'

import type { FsWriteRestrictionConfig } from '@anthropic-ai/sandbox-runtime'

import type { ClaudeJsonResource } from '../compatibility/claude/shared-resources.js'
import { sanitizeClaudeProjectPath } from '../compatibility/claude/paths.js'
import {
  annotateAutoModePermissionOutcome,
  annotatePermissionDecision,
} from '../core/runtime.js'
import type {
  ModelToolCall,
  PermissionBehavior,
  PermissionDecision,
  PermissionMode,
  PermissionResolutionContext,
  PermissionResolver,
  PermissionUpdateDestination,
} from '../core/runtime.js'
import {
  loadClaudeAutoModeConfig,
  type ClaudeAutoClassifier,
  type ClaudeAutoModeConfig,
} from './claude-auto-classifier.js'
import { analyzeBashCommands, validateBashSemantics } from './bash-ast.js'
import { shellPermissionMatchCandidates } from './bash-normalization.js'
import {
  pathIsInsideRoots,
  validateBashPathSafety,
} from './bash-path-safety.js'
import { validateSedSafety } from './sed-safety.js'
import { parseShellRule, shellRuleMatches } from './shell-rule-matching.js'
import {
  effectiveAdditionalDirectories,
  effectivePermissionMode,
  filePermissionSuggestions,
  permissionRuleValueFromString,
  permissionRuleValueToString,
  shellInputIsReadOnly,
  shellPermissionSuggestions,
  shellSubcommands,
  skillPermissionSuggestions,
} from './permission-updates.js'

interface PermissionRule {
  behavior: PermissionBehavior
  toolName: string
  pattern: string | null
  destination: PermissionUpdateDestination
  root?: string
}

export interface ClaudePermissionResolverOptions {
  cwd: string
  cwdProvider?: () => string
  configRoot?: string
  homeDirectory?: string
  settings: readonly ClaudeJsonResource[]
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
  permissionMode?: ClaudePermissionMode
  autoClassifier?: ClaudeAutoClassifier
  autoModeConfig?: ClaudeAutoModeConfig
  isSessionActionApproved?: (call: ModelToolCall) => boolean
  additionalDirectories?: readonly string[]
  additionalReadDirectories?: readonly string[]
  sandbox?: ClaudePermissionSandbox
}

export interface ClaudePermissionSandbox {
  autoAllowsBash(): boolean
  shouldUseSandbox(input: {
    command: string
    dangerouslyDisableSandbox?: boolean
  }): boolean
  getFsWriteConfig(): FsWriteRestrictionConfig | undefined
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
  SendUserMessage: 'allow',
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
  LSP: 'allow',
  ListMcpResourcesTool: 'allow',
  ReadMcpResourceDirTool: 'allow',
  ReadMcpResourceTool: 'allow',
  WebFetch: 'ask',
  WebSearch: 'ask',
  Bash: 'ask',
  PowerShell: 'ask',
  Skill: 'ask',
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

const ACCEPT_EDITS_BASH_COMMANDS = new Set([
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'sed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  )
}

export function claudePermissionActionKey(call: ModelToolCall): string {
  return JSON.stringify({ name: call.name, input: canonicalValue(call.input) })
}

function readRuleStrings(
  value: unknown,
  behavior: PermissionBehavior,
  root?: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionRule[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item !== 'string') return []
    const parsed = permissionRuleValueFromString(item)
    if (!/^[A-Za-z][\w-]*$/u.test(parsed.toolName)) return []
    return [
      {
        behavior,
        toolName: parsed.toolName,
        pattern: parsed.ruleContent ?? null,
        destination,
        ...(root ? { root } : {}),
      },
    ]
  })
}

function loadRules(settings: readonly ClaudeJsonResource[]): PermissionRule[] {
  return settings.flatMap((resource) => {
    if (!isRecord(resource.value)) return []
    const permissions = resource.value.permissions
    if (!isRecord(permissions)) return []
    const root =
      resource.scope === 'user'
        ? dirname(resource.path)
        : resolve(dirname(resource.path), '..')
    const destination =
      resource.scope === 'user'
        ? 'userSettings'
        : resource.scope === 'project'
          ? 'projectSettings'
          : 'localSettings'
    return [
      ...readRuleStrings(permissions.deny, 'deny', root, destination),
      ...readRuleStrings(permissions.ask, 'ask', root, destination),
      ...readRuleStrings(permissions.allow, 'allow', root, destination),
    ]
  })
}

function permissionRuleToString(rule: PermissionRule): string {
  return permissionRuleValueToString({
    toolName: rule.toolName,
    ...(rule.pattern === null ? {} : { ruleContent: rule.pattern }),
  })
}

export function validateClaudePermissionSettings(
  settings: readonly ClaudeJsonResource[],
): void {
  for (const resource of settings) {
    if (!isRecord(resource.value)) continue
    const permissions = resource.value.permissions
    if (permissions === undefined) continue
    if (!isRecord(permissions)) {
      throw new Error(`permissions must be an object: ${resource.path}`)
    }
    for (const field of ['allow', 'ask', 'deny'] as const) {
      const rules = permissions[field]
      if (rules === undefined) continue
      if (
        !Array.isArray(rules) ||
        rules.some((rule) => typeof rule !== 'string')
      ) {
        throw new Error(
          `permissions.${field} must be an array of strings: ${resource.path}`,
        )
      }
      for (const rule of rules) {
        if (!/^([A-Za-z][\w-]*)(?:\(.*\))?$/.test(rule)) {
          throw new Error(
            `Invalid permission rule in ${resource.path}: ${rule}`,
          )
        }
      }
    }
  }
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
  if (call.name === 'Bash' || call.name === 'PowerShell') {
    return typeof call.input.command === 'string' ? call.input.command : null
  }
  if (call.name === 'Skill') {
    const skill = call.input.skill ?? call.input.name
    return typeof skill === 'string' ? skill : null
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
  const toolMatches =
    rule.toolName === call.name ||
    (rule.toolName === 'Edit' &&
      ['Edit', 'Write', 'NotebookEdit'].includes(call.name)) ||
    (rule.toolName === 'Read' && ['Read', 'Glob', 'Grep'].includes(call.name))
  if (!toolMatches) return false
  if (rule.pattern === null) return true
  let target = permissionTarget(call)
  if (target === null) return false
  if (call.name === 'Bash' || call.name === 'PowerShell') {
    const parsed = parseShellRule(rule.pattern)
    const candidates =
      call.name === 'Bash'
        ? shellPermissionMatchCandidates(target, rule.behavior !== 'allow')
        : [target]
    return candidates.some((candidate) => {
      if (rule.pattern === candidate) return true
      if (
        call.name === 'Bash' &&
        rule.behavior === 'allow' &&
        parsed.type !== 'exact'
      ) {
        const analysis = analyzeBashCommands(candidate)
        if (!analysis.parsed || analysis.commands.length > 1) return false
      }
      if (shellRuleMatches(parsed, candidate, call.name === 'PowerShell')) {
        return true
      }
      if (call.name === 'Bash' && parsed.type === 'prefix') {
        return shellRuleMatches(
          parsed,
          candidate.startsWith('xargs ') ? candidate.slice(6) : candidate,
        )
      }
      return false
    })
  }
  if (call.name === 'Skill' && rule.pattern.endsWith(':*')) {
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
    } else if (permissionPattern.startsWith('/')) {
      permissionPattern = resolve(rule.root ?? cwd, permissionPattern.slice(1))
    } else if (!isAbsolute(permissionPattern)) {
      permissionPattern = resolve(cwd, permissionPattern)
    }
    if (!isAbsolute(target)) target = resolve(cwd, target)
  }
  return globExpression(permissionPattern).test(target)
}

function matchesExactBashRule(
  rule: PermissionRule,
  call: ModelToolCall,
): boolean {
  if (call.name !== 'Bash' || rule.toolName !== 'Bash' || rule.pattern === null)
    return false
  const command = permissionTarget(call)
  if (command === null) return false
  const parsed = parseShellRule(rule.pattern)
  return shellPermissionMatchCandidates(command).some((candidate) => {
    if (parsed.type === 'exact') return parsed.command === candidate
    if (parsed.type === 'prefix') return parsed.prefix === candidate
    return false
  })
}

export function claudePermissionRuleMatches(
  rule: string,
  call: ModelToolCall,
  cwd: string,
  homeDirectory = homedir(),
): boolean {
  const parsed = readRuleStrings([rule], 'allow')[0]
  return parsed
    ? matchesRule(parsed, call, resolve(cwd), resolve(homeDirectory))
    : false
}

export class ClaudePermissionResolver implements PermissionResolver {
  private readonly rules: readonly PermissionRule[]
  private readonly cwd: string
  private readonly cwdProvider: (() => string) | undefined
  private readonly configRoot: string | undefined
  private readonly homeDirectory: string
  private readonly permissionMode: ClaudePermissionMode
  private readonly autoClassifier: ClaudeAutoClassifier | undefined
  private readonly autoModeConfig: ClaudeAutoModeConfig
  private readonly isSessionActionApproved:
    ((call: ModelToolCall) => boolean) | undefined
  private readonly additionalDirectories: readonly string[]
  private readonly additionalReadDirectories: readonly string[]
  private readonly sandbox: ClaudePermissionSandbox | undefined

  constructor(options: ClaudePermissionResolverOptions) {
    this.cwd = resolve(options.cwd)
    this.cwdProvider = options.cwdProvider
    this.configRoot = options.configRoot
      ? resolve(options.configRoot)
      : undefined
    this.homeDirectory = resolve(options.homeDirectory ?? homedir())
    this.rules = [
      ...loadRules(options.settings),
      ...readRuleStrings(
        options.disallowedTools ?? [],
        'deny',
        undefined,
        'cliArg',
      ),
      ...readRuleStrings(
        options.allowedTools ?? [],
        'allow',
        undefined,
        'cliArg',
      ),
    ]
    this.permissionMode = options.permissionMode ?? 'default'
    this.autoModeConfig =
      options.autoModeConfig ?? loadClaudeAutoModeConfig(options.settings)
    this.autoClassifier = options.autoClassifier
    this.isSessionActionApproved = options.isSessionActionApproved
    this.additionalDirectories = (options.additionalDirectories ?? []).map(
      (directory) => resolve(directory),
    )
    this.additionalReadDirectories = (
      options.additionalReadDirectories ?? []
    ).map((directory) => resolve(directory))
    this.sandbox = options.sandbox
    if (this.permissionMode === 'auto') {
      if (!this.autoClassifier) {
        throw new Error('Permission mode auto requires a classifier')
      }
    }
  }

  async resolve(
    call: ModelToolCall,
    context?: PermissionResolutionContext,
  ): Promise<PermissionDecision> {
    const cwd = resolve(context?.cwd || this.cwdProvider?.() || this.cwd)
    const projectInternalRoot = this.configRoot
      ? resolve(this.configRoot, 'projects', sanitizeClaudeProjectPath(cwd))
      : undefined
    const internalEditableRoots = projectInternalRoot
      ? [resolve(projectInternalRoot, 'memory')]
      : []
    const internalReadableRoots = [
      ...(projectInternalRoot ? [projectInternalRoot] : []),
      ...(this.configRoot ? [resolve(this.configRoot, 'tasks')] : []),
      ...(context?.toolResultDirectory
        ? [resolve(context.toolResultDirectory)]
        : []),
    ]
    const updates = context?.permissionUpdates ?? []
    const permissionMode =
      (effectivePermissionMode(updates) as ClaudePermissionMode | undefined) ??
      this.permissionMode
    const effectiveRules = (behavior: PermissionBehavior) => {
      let rules = this.rules.filter((rule) => rule.behavior === behavior)
      for (const update of updates) {
        if (
          (update.type !== 'addRules' &&
            update.type !== 'replaceRules' &&
            update.type !== 'removeRules') ||
          update.behavior !== behavior
        ) {
          continue
        }
        const root =
          rules.find((rule) => rule.destination === update.destination)?.root ??
          cwd
        const changed = readRuleStrings(
          update.rules.map(permissionRuleValueToString),
          behavior,
          root,
          update.destination,
        )
        if (update.type === 'replaceRules') {
          rules = [
            ...rules.filter((rule) => rule.destination !== update.destination),
            ...changed,
          ]
        } else if (update.type === 'removeRules') {
          const removed = new Set(changed.map(permissionRuleToString))
          rules = rules.filter(
            (rule) =>
              rule.destination !== update.destination ||
              !removed.has(permissionRuleToString(rule)),
          )
        } else {
          rules = [...rules, ...changed]
        }
      }
      return rules
    }
    const matchingRule = (
      behavior: PermissionBehavior,
      candidateCall: ModelToolCall = call,
    ) =>
      effectiveRules(behavior).find((candidate) =>
        matchesRule(candidate, candidateCall, cwd, this.homeDirectory),
      )
    const command =
      (call.name === 'Bash' || call.name === 'PowerShell') &&
      typeof call.input.command === 'string'
        ? call.input.command
        : undefined
    const subcommands = command
      ? shellSubcommands(
          command,
          call.name === 'PowerShell' ? 'powershell' : 'bash',
        )
      : []
    const subcommandCall = (subcommand: string): ModelToolCall => ({
      ...call,
      input: { ...call.input, command: subcommand },
    })
    const denied =
      matchingRule('deny') ??
      subcommands
        .map((subcommand) => matchingRule('deny', subcommandCall(subcommand)))
        .find((rule) => rule !== undefined)
    if (denied) {
      const suffix = denied.pattern === null ? '' : `(${denied.pattern})`
      return annotatePermissionDecision(
        {
          behavior: 'deny',
          reason: `Denied by Claude permission rule ${denied.toolName}${suffix}`,
        },
        'rule',
      )
    }
    if (
      permissionMode === 'plan' &&
      (call.name === 'Write' ||
        call.name === 'Edit' ||
        call.name === 'NotebookEdit')
    ) {
      return annotatePermissionDecision(
        {
          behavior: 'deny',
          reason: `Cannot use ${call.name} while in plan mode`,
        },
        'mode',
      )
    }
    if (this.isSessionActionApproved?.(call)) {
      return annotatePermissionDecision({ behavior: 'allow' }, 'mode')
    }
    if (command && call.name === 'Bash') {
      const semantics = validateBashSemantics(command)
      const explicitlyAllowed = effectiveRules('allow').some((rule) =>
        matchesExactBashRule(rule, call),
      )
      const explicitlyAsked = effectiveRules('ask').some((rule) =>
        matchesExactBashRule(rule, call),
      )
      if (!semantics.safe) {
        return explicitlyAllowed && !explicitlyAsked
          ? annotatePermissionDecision({ behavior: 'allow' }, 'rule')
          : annotatePermissionDecision(
              {
                behavior: 'ask',
                reason: semantics.reason,
                suggestions: [],
              },
              'default',
            )
      }
    }
    const asked =
      matchingRule('ask') ??
      subcommands
        .map((subcommand) => matchingRule('ask', subcommandCall(subcommand)))
        .find((rule) => rule !== undefined)
    if (asked)
      return this.askDecision(
        call,
        cwd,
        permissionMode,
        context,
        'rule',
        undefined,
        true,
      )
    if (
      command &&
      call.name === 'Bash' &&
      this.sandbox?.autoAllowsBash() &&
      this.sandbox.shouldUseSandbox({
        command,
        ...(call.input.dangerouslyDisableSandbox === true
          ? { dangerouslyDisableSandbox: true }
          : {}),
      })
    ) {
      return annotatePermissionDecision({ behavior: 'allow' }, 'default')
    }
    if (command && call.name === 'Bash') {
      const sandboxWriteConfig = this.sandbox?.getFsWriteConfig()
      const writeRoots = [
        cwd,
        ...effectiveAdditionalDirectories(
          updates,
          this.additionalDirectories,
        ).map((directory) => resolve(cwd, directory)),
      ]
      const pathSafety =
        permissionMode === 'auto'
          ? ({ safe: true } as const)
          : validateBashPathSafety(command, {
              cwd,
              homeDirectory: this.homeDirectory,
              writeRoots,
              readRoots: [...writeRoots, ...this.additionalReadDirectories],
              internalEditableRoots,
              internalReadableRoots,
              ...(sandboxWriteConfig ? { sandboxWriteConfig } : {}),
              permissionMode,
              fileRule: (operation, absolutePath) => {
                const candidate: ModelToolCall = {
                  id: call.id,
                  name: operation === 'read' ? 'Read' : 'Edit',
                  input: { file_path: absolutePath },
                }
                if (matchingRule('deny', candidate)) return 'deny'
                if (matchingRule('allow', candidate)) return 'allow'
                return null
              },
            })
      if (!pathSafety.safe) {
        if (pathSafety.behavior === 'deny') {
          return annotatePermissionDecision(
            { behavior: 'deny', reason: pathSafety.reason },
            'rule',
          )
        }
        return annotatePermissionDecision(
          {
            behavior: 'ask',
            reason: pathSafety.reason,
            ...(pathSafety.suggestions
              ? { suggestions: pathSafety.suggestions }
              : pathSafety.path
                ? {
                    suggestions: filePermissionSuggestions(
                      pathSafety.path,
                      cwd,
                      pathSafety.operation === 'read' ? 'read' : 'write',
                      permissionMode as PermissionMode,
                      true,
                    ),
                  }
                : {}),
          },
          'default',
        )
      }
    }
    if (
      matchingRule('allow') &&
      (permissionMode !== 'auto' || !this.shouldClassify(call))
    ) {
      return annotatePermissionDecision({ behavior: 'allow' }, 'rule')
    }
    if (command && call.name === 'Bash') {
      for (const subcommand of subcommands) {
        if (matchingRule('allow', subcommandCall(subcommand))) continue
        const sedSafety = validateSedSafety(
          subcommand,
          permissionMode === 'acceptEdits',
        )
        if (!sedSafety.safe) {
          return annotatePermissionDecision(
            {
              behavior: 'ask',
              reason: sedSafety.reason,
              suggestions: [],
            },
            'default',
          )
        }
      }
    }
    if (permissionMode === 'bypassPermissions') {
      return annotatePermissionDecision({ behavior: 'allow' }, 'mode')
    }
    if (
      permissionMode === 'acceptEdits' &&
      call.name === 'Bash' &&
      subcommands.some((subcommand) => {
        const base = subcommand.trim().split(/\s+/u)[0]
        return base !== undefined && ACCEPT_EDITS_BASH_COMMANDS.has(base)
      })
    ) {
      return annotatePermissionDecision({ behavior: 'allow' }, 'mode')
    }
    if (
      command &&
      (permissionMode !== 'auto' || !this.shouldClassify(call)) &&
      subcommands.length > 0 &&
      (shellInputIsReadOnly(command) ||
        subcommands.every(
          (subcommand) =>
            matchingRule('allow', subcommandCall(subcommand)) !== undefined,
        ))
    ) {
      return annotatePermissionDecision({ behavior: 'allow' }, 'rule')
    }
    const filePath = FILE_TOOLS.has(call.name) ? permissionTarget(call) : null
    if (filePath) {
      let absolutePath = resolve(cwd, filePath)
      if (call.name === 'Glob') {
        try {
          absolutePath = await realpath(absolutePath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      const originalPath = context?.originalCall
        ? permissionTarget(context.originalCall)
        : null
      const pathsToCheck = [
        ...new Set([
          ...(originalPath ? [resolve(cwd, originalPath)] : []),
          absolutePath,
        ]),
      ]
      const write = ['Write', 'Edit', 'NotebookEdit'].includes(call.name)
      const internalRoots = write
        ? internalEditableRoots
        : internalReadableRoots
      if (pathIsInsideRoots(absolutePath, internalRoots)) {
        return annotatePermissionDecision({ behavior: 'allow' }, 'default')
      }
      const roots = [
        cwd,
        ...effectiveAdditionalDirectories(
          updates,
          this.additionalDirectories,
        ).map((directory) => resolve(cwd, directory)),
        ...(write ? [] : this.additionalReadDirectories),
      ]
      const outside = pathsToCheck.some(
        (candidate) =>
          !roots.some((root) => {
            const child = relative(root, candidate)
            return (
              child === '' || (!child.startsWith('..') && !isAbsolute(child))
            )
          }),
      )
      if (outside) {
        return annotatePermissionDecision(
          {
            behavior: 'ask',
            reason: 'Path is outside allowed working directories',
            suggestions: filePermissionSuggestions(
              absolutePath,
              cwd,
              write ? 'write' : 'read',
              permissionMode as PermissionMode,
              true,
              pathsToCheck,
              call.name === 'Glob' || call.name === 'Grep',
            ),
          },
          'default',
        )
      }
    }
    if (
      permissionMode === 'acceptEdits' &&
      (call.name === 'Write' ||
        call.name === 'Edit' ||
        call.name === 'NotebookEdit')
    ) {
      return annotatePermissionDecision({ behavior: 'allow' }, 'mode')
    }

    if (
      permissionMode === 'auto' &&
      this.shouldClassify(call) &&
      this.autoClassifier
    ) {
      try {
        const decision = await this.autoClassifier({
          call,
          cwd,
          messages: context?.messages ?? [],
          config: this.autoModeConfig,
        })
        const annotated = annotatePermissionDecision(
          decision,
          'auto-classifier',
        )
        return decision.behavior === 'deny'
          ? annotateAutoModePermissionOutcome(annotated, 'blocked')
          : annotated
      } catch (error) {
        return annotateAutoModePermissionOutcome(
          annotatePermissionDecision(
            {
              behavior: 'deny',
              reason: `Auto mode classifier failed: ${error instanceof Error ? error.message : String(error)}`,
            },
            'auto-classifier',
          ),
          'unavailable',
        )
      }
    }

    if (permissionMode === 'auto' && call.name === 'Bash') {
      return annotatePermissionDecision({ behavior: 'allow' }, 'default')
    }

    const defaultBehavior = DEFAULT_BEHAVIOR[call.name]
    return defaultBehavior === 'ask'
      ? this.askDecision(
          call,
          cwd,
          permissionMode,
          context,
          'default',
          command
            ? (subcommand) =>
                matchingRule('allow', subcommandCall(subcommand)) === undefined
            : undefined,
        )
      : defaultBehavior
        ? annotatePermissionDecision({ behavior: defaultBehavior }, 'default')
        : annotatePermissionDecision(
            { behavior: 'deny', reason: `Unknown tool ${call.name}` },
            'default',
          )
  }

  private askDecision(
    call: ModelToolCall,
    cwd: string,
    permissionMode: ClaudePermissionMode,
    context?: PermissionResolutionContext,
    source: 'rule' | 'mode' | 'default' = 'mode',
    shellSuggestionFilter?: (subcommand: string) => boolean,
    suppressSuggestions = false,
  ): PermissionDecision {
    return permissionMode === 'dontAsk' || permissionMode === 'plan'
      ? annotatePermissionDecision(
          {
            behavior: 'deny',
            reason: `Permission to use ${call.name} is disabled in ${permissionMode} mode`,
          },
          'mode',
        )
      : annotatePermissionDecision(
          {
            behavior: 'ask',
            ...(call.name === 'Workflow'
              ? { reason: 'Review dynamic workflow before running' }
              : {}),
            ...(!suppressSuggestions &&
            (call.name === 'Bash' || call.name === 'PowerShell') &&
            typeof call.input.command === 'string'
              ? {
                  suggestions: shellPermissionSuggestions(
                    call.name,
                    call.input.command,
                    shellSuggestionFilter,
                  ),
                }
              : !suppressSuggestions &&
                  call.name === 'Skill' &&
                  typeof call.input.skill === 'string'
                ? {
                    suggestions: skillPermissionSuggestions(call.input.skill),
                  }
                : !suppressSuggestions &&
                    FILE_TOOLS.has(call.name) &&
                    permissionTarget(call)
                  ? {
                      suggestions: filePermissionSuggestions(
                        permissionTarget(call) ?? cwd,
                        cwd,
                        ['Write', 'Edit', 'NotebookEdit'].includes(call.name)
                          ? 'write'
                          : 'read',
                        (effectivePermissionMode(context?.permissionUpdates) ??
                          permissionMode) as PermissionMode,
                        false,
                      ),
                    }
                  : {}),
          },
          source,
        )
  }

  private shouldClassify(call: ModelToolCall): boolean {
    if (call.name === 'Agent') return true
    if (
      call.name === 'Write' ||
      call.name === 'Edit' ||
      call.name === 'NotebookEdit' ||
      call.name === 'WebFetch' ||
      call.name === 'WebSearch' ||
      call.name === 'Workflow'
    ) {
      return true
    }
    if (call.name !== 'Bash') return false
    if (this.autoModeConfig.classifyAllShell) return true
    const command =
      typeof call.input.command === 'string' ? call.input.command : ''
    return /\b(node|deno|bun|python(?:3)?|ruby|perl)\s+-[ec]\b|\beval\s|\b(curl|wget)\b.*\|\s*(sh|bash)\b|\b(rm|sudo|chmod|chown|docker|kubectl)\b|\bgit\s+(push|reset|clean)\b|[<>]\s*[^=]/u.test(
      command,
    )
  }
}
