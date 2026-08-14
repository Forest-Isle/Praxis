const SAFE_SHELL_ENVIRONMENT = new Set([
  'GOEXPERIMENT',
  'GOOS',
  'GOARCH',
  'CGO_ENABLED',
  'GO111MODULE',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG',
  'ANTHROPIC_API_KEY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'CHARSET',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'LS_COLORS',
  'LSCOLORS',
  'GREP_COLOR',
  'GREP_COLORS',
  'GCC_COLORS',
  'TIME_STYLE',
  'BLOCK_SIZE',
  'BLOCKSIZE',
])

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
    if (!name || !SAFE_SHELL_ENVIRONMENT.has(name)) return command
    commandIndex += 1
  }
  const executable = tokens[commandIndex]
  if (!executable || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(executable))
    return command
  const subcommand = tokens[commandIndex + 1]
  if (subcommand && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(subcommand)) {
    return `${executable} ${subcommand}:*`
  }
  return UNSAFE_BARE_SHELL_PREFIXES.has(executable)
    ? command
    : `${executable}:*`
}

export function claudeBashPermissionSuggestionContent(command: string): string {
  const trimmed = command.trim()
  if (trimmed.includes('\n')) {
    const firstLine = trimmed.split('\n', 1)[0]?.trim()
    return firstLine
      ? claudeBashPermissionSuggestionContent(firstLine)
      : trimmed
  }
  const tokens = trimmed.split(/\s+/u).filter(Boolean)
  let commandIndex = 0
  while (/^[A-Za-z_]\w*=/u.test(tokens[commandIndex] ?? '')) {
    const name = tokens[commandIndex]?.split('=', 1)[0]
    if (!name || !SAFE_SHELL_ENVIRONMENT.has(name)) return trimmed
    commandIndex += 1
  }
  const executable = tokens[commandIndex]
  const subcommand = tokens[commandIndex + 1]
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
    if (!assignment?.[1] || !SAFE_SHELL_ENVIRONMENT.has(assignment[1])) break
    remaining = remaining.slice(end).trimStart()
  }
  return remaining
}
