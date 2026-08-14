import { isClaudeSafeShellEnvironmentName } from './bash-normalization.js'

const UNSAFE_BARE_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  'env',
  'xargs',
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  'sudo',
  'doas',
  'pkexec',
])

export function claudeBashPermissionRuleContent(command: string): string {
  const tokens = command.trim().split(/\s+/u).filter(Boolean)
  let commandIndex = 0
  while (/^[A-Za-z_]\w*=/u.test(tokens[commandIndex] ?? '')) {
    const name = tokens[commandIndex]?.split('=', 1)[0]
    if (!name || !isClaudeSafeShellEnvironmentName(name)) return command
    commandIndex += 1
  }
  const executable = tokens[commandIndex]
  if (!executable || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(executable))
    return command
  if (UNSAFE_BARE_SHELL_PREFIXES.has(executable)) return command
  const subcommand = tokens[commandIndex + 1]
  if (subcommand && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(subcommand)) {
    return `${executable} ${subcommand}:*`
  }
  return `${executable}:*`
}

export function claudeBashPermissionSuggestionContent(command: string): string {
  const trimmed = command.trim()
  if (/[\n\r;|&<>`]|\$\(/u.test(trimmed)) return trimmed
  const tokens = trimmed.split(/\s+/u).filter(Boolean)
  let commandIndex = 0
  while (/^[A-Za-z_]\w*=/u.test(tokens[commandIndex] ?? '')) {
    const name = tokens[commandIndex]?.split('=', 1)[0]
    if (!name || !isClaudeSafeShellEnvironmentName(name)) return trimmed
    commandIndex += 1
  }
  const executable = tokens[commandIndex]
  const subcommand = tokens[commandIndex + 1]
  if (executable && UNSAFE_BARE_SHELL_PREFIXES.has(executable)) return trimmed
  if (
    executable &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(executable) &&
    subcommand &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(subcommand)
  ) {
    return `${executable} ${subcommand}:*`
  }
  return trimmed
}

function firstShellToken(value: string): { token: string; end: number } {
  let quote: "'" | '"' | null = null
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
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
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (/\s/u.test(character)) {
      return { token: value.slice(0, index), end: index }
    }
  }
  return { token: value, end: value.length }
}

export function stripClaudeSafeShellEnvironment(command: string): string {
  let remaining = command.trimStart()
  while (remaining) {
    const { token, end } = firstShellToken(remaining)
    const assignment = /^([A-Za-z_]\w*)=/u.exec(token)
    if (!assignment?.[1] || !isClaudeSafeShellEnvironmentName(assignment[1]))
      break
    remaining = remaining.slice(end).trimStart()
  }
  return remaining
}
