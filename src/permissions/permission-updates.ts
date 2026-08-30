import { dirname, isAbsolute, resolve } from 'node:path'

import type {
  PermissionBehavior,
  PermissionMode,
  PermissionRuleValue,
  PermissionUpdate,
  PermissionUpdateMode,
} from '../core/runtime.js'
import { claudeBashPermissionSuggestionContent } from './claude-shell-permission.js'
import { analyzeBashCommands } from './bash-ast.js'

export function permissionRuleValueToString(rule: PermissionRuleValue): string {
  if (!rule.ruleContent) return rule.toolName
  const content = rule.ruleContent
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)')
  return `${rule.toolName}(${content})`
}

export function permissionRuleStringIsValid(value: string): boolean {
  return /^([A-Za-z][\w-]*)(?:\(.*\))?$/su.test(value)
}

function unescapedIndex(
  value: string,
  character: '(' | ')',
  fromEnd = false,
): number {
  const start = fromEnd ? value.length - 1 : 0
  const end = fromEnd ? -1 : value.length
  const step = fromEnd ? -1 : 1
  for (let index = start; index !== end; index += step) {
    if (value[index] !== character) continue
    let escapes = 0
    for (
      let cursor = index - 1;
      cursor >= 0 && value[cursor] === '\\';
      cursor -= 1
    ) {
      escapes += 1
    }
    if (escapes % 2 === 0) return index
  }
  return -1
}

export function permissionRuleValueFromString(
  value: string,
): PermissionRuleValue {
  const opening = unescapedIndex(value, '(')
  if (opening < 1) return { toolName: value }
  const closing = unescapedIndex(value, ')', true)
  if (closing !== value.length - 1 || closing <= opening) {
    return { toolName: value }
  }
  const toolName = value.slice(0, opening)
  const raw = value.slice(opening + 1, closing)
  if (!raw || raw === '*') return { toolName }
  return {
    toolName,
    ruleContent: raw
      .replaceAll('\\(', '(')
      .replaceAll('\\)', ')')
      .replaceAll('\\\\', '\\'),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePermissionUpdates(
  value: unknown,
): readonly PermissionUpdate[] | undefined {
  if (!Array.isArray(value)) return undefined
  const updates: PermissionUpdate[] = []
  for (const item of value) {
    if (!isRecord(item) || typeof item.destination !== 'string')
      return undefined
    if (
      ![
        'userSettings',
        'projectSettings',
        'localSettings',
        'session',
        'cliArg',
      ].includes(item.destination)
    ) {
      return undefined
    }
    const destination = item.destination as PermissionUpdate['destination']
    if (
      item.type === 'addRules' ||
      item.type === 'replaceRules' ||
      item.type === 'removeRules'
    ) {
      if (
        !['allow', 'ask', 'deny'].includes(String(item.behavior)) ||
        !Array.isArray(item.rules)
      ) {
        return undefined
      }
      const rules: PermissionRuleValue[] = []
      for (const rule of item.rules) {
        if (
          !isRecord(rule) ||
          typeof rule.toolName !== 'string' ||
          (rule.ruleContent !== undefined &&
            typeof rule.ruleContent !== 'string')
        ) {
          return undefined
        }
        rules.push({
          toolName: rule.toolName,
          ...(typeof rule.ruleContent === 'string'
            ? { ruleContent: rule.ruleContent }
            : {}),
        })
      }
      updates.push({
        type: item.type,
        rules,
        behavior: item.behavior as PermissionBehavior,
        destination,
      })
      continue
    }
    if (item.type === 'setMode') {
      if (
        ![
          'acceptEdits',
          'bypassPermissions',
          'dontAsk',
          'plan',
          'default',
        ].includes(String(item.mode))
      ) {
        return undefined
      }
      updates.push({
        type: 'setMode',
        mode: item.mode as PermissionUpdateMode,
        destination,
      })
      continue
    }
    if (item.type === 'addDirectories' || item.type === 'removeDirectories') {
      if (
        !Array.isArray(item.directories) ||
        item.directories.some((directory) => typeof directory !== 'string')
      ) {
        return undefined
      }
      updates.push({
        type: item.type,
        directories: item.directories as string[],
        destination,
      })
      continue
    }
    return undefined
  }
  return updates
}

export function extractPermissionRules(
  updates: readonly PermissionUpdate[] | undefined,
): readonly PermissionRuleValue[] {
  return (updates ?? []).flatMap((update) =>
    update.type === 'addRules' ? [...update.rules] : [],
  )
}

export function effectivePermissionMode(
  updates: readonly PermissionUpdate[] | undefined,
): PermissionMode | undefined {
  return (updates ?? []).findLast(
    (update): update is Extract<PermissionUpdate, { type: 'setMode' }> =>
      update.type === 'setMode',
  )?.mode
}

export function effectiveAdditionalDirectories(
  updates: readonly PermissionUpdate[] | undefined,
  initial: readonly string[] = [],
): readonly string[] {
  const directories = new Set(initial)
  for (const update of updates ?? []) {
    if (update.type === 'addDirectories') {
      for (const directory of update.directories) directories.add(directory)
    } else if (update.type === 'removeDirectories') {
      for (const directory of update.directories) directories.delete(directory)
    }
  }
  return [...directories]
}

export function readDirectoryPermissionUpdate(
  path: string,
  cwd: string,
  targetIsDirectory = false,
): Extract<PermissionUpdate, { type: 'addRules' }> | undefined {
  const absolute = resolve(cwd, path)
  const directory = targetIsDirectory ? absolute : dirname(absolute)
  if (directory === dirname(directory)) return undefined
  const normalized = directory.replaceAll('\\', '/')
  return {
    type: 'addRules',
    rules: [
      {
        toolName: 'Read',
        ruleContent: isAbsolute(normalized)
          ? `/${normalized}/**`
          : `${normalized}/**`,
      },
    ],
    behavior: 'allow',
    destination: 'session',
  }
}

export function filePermissionSuggestions(
  path: string,
  cwd: string,
  operation: 'read' | 'write',
  mode: PermissionMode,
  outsideWorkingDirectory: boolean,
  pathsToCheck: readonly string[] = [path],
  targetIsDirectory = false,
): readonly PermissionUpdate[] {
  if (operation === 'read' && outsideWorkingDirectory) {
    const updates = pathsToCheck.flatMap((candidate) => {
      const update = readDirectoryPermissionUpdate(
        candidate,
        cwd,
        targetIsDirectory,
      )
      return update ? [update] : []
    })
    const seen = new Set<string>()
    return updates.filter((update) => {
      const rule = update.rules[0]
      if (!rule) return false
      const key = permissionRuleValueToString(rule)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  const updates: PermissionUpdate[] = []
  if (mode === 'default' || mode === 'plan') {
    updates.push({
      type: 'setMode',
      mode: 'acceptEdits',
      destination: 'session',
    })
  }
  if (operation === 'write' && outsideWorkingDirectory) {
    const directories = [
      ...new Set(
        pathsToCheck.map((candidate) => dirname(resolve(cwd, candidate))),
      ),
    ]
    updates.push({
      type: 'addDirectories',
      directories,
      destination: 'session',
    })
  }
  return updates
}

function legacyShellSubcommands(command: string): readonly string[] {
  const commands: string[] = []
  let start = 0
  let quote: "'" | '"' | '`' | null = null
  let escaped = false
  let depth = 0
  const push = (end: number, width: number) => {
    const part = command.slice(start, end).trim()
    if (part) commands.push(part)
    start = end + width
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      continue
    }
    if (character === '(' || character === '{' || character === '[') {
      depth += 1
      continue
    }
    if (character === ')' || character === '}' || character === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth > 0) continue
    const pair = command.slice(index, index + 2)
    if (pair === '&&' || pair === '||') {
      push(index, 2)
      index += 1
    } else if (character === ';' || character === '|' || character === '\n') {
      push(index, 1)
    }
  }
  push(command.length, 0)
  return commands
}

export function shellSubcommands(
  command: string,
  shell: 'bash' | 'powershell' = 'bash',
): readonly string[] {
  return shell === 'bash'
    ? analyzeBashCommands(command).commands
    : legacyShellSubcommands(command)
}

const READ_ONLY_SHELL_COMMANDS = new Set([
  'cd',
  'echo',
  'head',
  'ls',
  'pwd',
  'printf',
  'tail',
  'test',
  'true',
  'wc',
  'which',
])

function commandName(command: string): string {
  return command.trim().split(/\s+/u)[0] ?? ''
}

const AMBIGUOUS_SHELL_SYNTAX = /[<>`$*?[\]{}~]/u

export function shellCommandIsReadOnly(command: string): boolean {
  if (AMBIGUOUS_SHELL_SYNTAX.test(command) || /[&;|\n\r]/u.test(command)) {
    return false
  }
  return READ_ONLY_SHELL_COMMANDS.has(commandName(command))
}

export function shellInputIsReadOnly(command: string): boolean {
  if (
    AMBIGUOUS_SHELL_SYNTAX.test(command) ||
    /(^|[^&])&($|[^&])/u.test(command)
  ) {
    return false
  }
  const analysis = analyzeBashCommands(command)
  return (
    analysis.parsed &&
    analysis.commands.length > 0 &&
    analysis.commands.every(shellCommandIsReadOnly)
  )
}

export function shellPermissionSuggestions(
  toolName: 'Bash' | 'PowerShell',
  command: string,
  include: (subcommand: string) => boolean = () => true,
): readonly PermissionUpdate[] {
  const parts = shellSubcommands(
    command,
    toolName === 'Bash' ? 'bash' : 'powershell',
  )
  const candidates = (parts.length > 0 ? parts : [command]).filter(
    (part) => !shellCommandIsReadOnly(part) && include(part),
  )
  const values = candidates
    .map((part) =>
      toolName === 'Bash'
        ? claudeBashPermissionSuggestionContent(part)
        : part.trim(),
    )
    .filter(Boolean)
  const unique = [...new Set(values)].slice(0, 5)
  return unique.length === 0
    ? []
    : [
        {
          type: 'addRules',
          rules: unique.map((ruleContent) => ({ toolName, ruleContent })),
          behavior: 'allow',
          destination: 'localSettings',
        },
      ]
}

export function skillPermissionSuggestions(
  skill: string,
): readonly PermissionUpdate[] {
  const normalized = skill.trim().replace(/^\//u, '')
  if (!normalized) return []
  return [normalized, `${normalized}:*`].map((ruleContent) => ({
    type: 'addRules' as const,
    rules: [{ toolName: 'Skill', ruleContent }],
    behavior: 'allow' as const,
    destination: 'localSettings' as const,
  }))
}
