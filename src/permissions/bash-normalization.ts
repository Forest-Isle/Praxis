const SAFE_ENVIRONMENT_NAMES = new Set([
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

export function isClaudeSafeShellEnvironmentName(name: string): boolean {
  return SAFE_ENVIRONMENT_NAMES.has(name)
}

const SAFE_VALUE = '[A-Za-z0-9_./:-]+'
const SAFE_ASSIGNMENT = new RegExp(
  `^([A-Za-z_][A-Za-z0-9_]*)=${SAFE_VALUE}[ \\t]+`,
  'u',
)
const SAFE_OPTION_VALUE = /^[A-Za-z0-9_.+-]+$/u
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/u
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=[^\s$`;|&()<>\\'"]+$/u

function stripFullLineComments(command: string): string {
  const remaining = command
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
  return remaining.length > 0 ? remaining.join('\n') : command
}

function horizontalTokens(
  command: string,
): readonly { value: string; start: number; end: number }[] {
  if (/[\r\n]/u.test(command)) return []
  return [...command.matchAll(/[^ \t]+/gu)].map((match) => ({
    value: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function remainderAfter(
  command: string,
  tokens: readonly { value: string; start: number; end: number }[],
  index: number,
): string | undefined {
  const token = tokens[index]
  return token ? command.slice(token.start) : undefined
}

function stripTimeout(command: string): string | undefined {
  const tokens = horizontalTokens(command)
  if (tokens[0]?.value !== 'timeout') return undefined
  let index = 1
  while (index < tokens.length) {
    const value = tokens[index]?.value ?? ''
    const next = tokens[index + 1]?.value
    if (
      value === '--foreground' ||
      value === '--preserve-status' ||
      value === '--verbose' ||
      value === '-v'
    ) {
      index += 1
    } else if (/^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/u.test(value)) {
      index += 1
    } else if (
      (value === '--kill-after' ||
        value === '--signal' ||
        value === '-k' ||
        value === '-s') &&
      next &&
      SAFE_OPTION_VALUE.test(next)
    ) {
      index += 2
    } else if (/^-[ks][A-Za-z0-9_.+-]+$/u.test(value)) {
      index += 1
    } else if (value === '--') {
      index += 1
      break
    } else if (value.startsWith('-')) {
      return undefined
    } else {
      break
    }
  }
  if (!TIMEOUT_DURATION.test(tokens[index]?.value ?? '')) return undefined
  return remainderAfter(command, tokens, index + 1)
}

function stripNice(command: string): string | undefined {
  const tokens = horizontalTokens(command)
  if (tokens[0]?.value !== 'nice') return undefined
  let index = 1
  if (tokens[index]?.value === '-n') {
    if (!/^-?\d+$/u.test(tokens[index + 1]?.value ?? '')) return undefined
    index += 2
  } else if (/^-\d+$/u.test(tokens[index]?.value ?? '')) {
    index += 1
  } else if ((tokens[index]?.value ?? '').startsWith('-')) {
    return undefined
  }
  if (tokens[index]?.value === '--') index += 1
  return remainderAfter(command, tokens, index)
}

function stripStdbuf(command: string): string | undefined {
  const tokens = horizontalTokens(command)
  if (tokens[0]?.value !== 'stdbuf') return undefined
  let index = 1
  let options = 0
  while (index < tokens.length) {
    const value = tokens[index]?.value ?? ''
    if (/^-[ioe][LN0-9]+$/u.test(value)) {
      index += 1
      options += 1
    } else if (/^-[ioe]$/u.test(value) && tokens[index + 1]) {
      index += 2
      options += 1
    } else if (/^--(?:input|output|error)=[LN0-9]+$/u.test(value)) {
      index += 1
      options += 1
    } else if (value === '--') {
      index += 1
      break
    } else if (value.startsWith('-')) {
      return undefined
    } else {
      break
    }
  }
  return options > 0 ? remainderAfter(command, tokens, index) : undefined
}

function stripEnv(command: string): string | undefined {
  const tokens = horizontalTokens(command)
  if (tokens[0]?.value !== 'env') return undefined
  let index = 1
  while (index < tokens.length) {
    const value = tokens[index]?.value ?? ''
    if (ENV_ASSIGNMENT.test(value) || ['-i', '-0', '-v'].includes(value)) {
      index += 1
    } else if (
      value === '-u' &&
      ENV_NAME.test(tokens[index + 1]?.value ?? '')
    ) {
      index += 2
    } else if (value.startsWith('-')) {
      return undefined
    } else {
      break
    }
  }
  return remainderAfter(command, tokens, index)
}

function stripOneWrapper(command: string): string | undefined {
  if (/^(?:time|nohup)[ \t]+/u.test(command)) {
    return command.replace(/^(?:time|nohup)[ \t]+(?:--[ \t]+)?/u, '')
  }
  return (
    stripTimeout(command) ??
    stripNice(command) ??
    stripStdbuf(command) ??
    stripEnv(command)
  )
}

export function stripSafeShellWrappers(command: string): string {
  let normalized = command.trim()
  let previous = ''
  while (normalized !== previous) {
    previous = normalized
    normalized = stripFullLineComments(normalized)
    const assignment = SAFE_ASSIGNMENT.exec(normalized)
    if (assignment?.[1] && isClaudeSafeShellEnvironmentName(assignment[1])) {
      normalized = normalized.slice(assignment[0].length)
    }
  }

  previous = ''
  while (normalized !== previous) {
    previous = normalized
    normalized = stripFullLineComments(normalized)
    normalized = stripOneWrapper(normalized)?.trim() ?? normalized
  }
  return normalized.trim()
}

export function stripAllLeadingShellEnvironment(command: string): string {
  const assignment =
    /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\'"])*[ \t]+/u
  let normalized = command.trim()
  let previous = ''
  while (normalized !== previous) {
    previous = normalized
    normalized = stripFullLineComments(normalized)
    const match = assignment.exec(normalized)
    if (match) normalized = normalized.slice(match[0].length)
  }
  return normalized.trim()
}

export function shellPermissionMatchCandidates(
  command: string,
  stripAllEnvironment = false,
): readonly string[] {
  const candidates = [command.trim()]
  const seen = new Set(candidates)
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] ?? ''
    const normalized = [stripSafeShellWrappers(candidate)]
    if (stripAllEnvironment) {
      normalized.push(stripAllLeadingShellEnvironment(candidate))
    }
    for (const value of normalized) {
      if (value && !seen.has(value)) {
        seen.add(value)
        candidates.push(value)
      }
    }
  }
  return candidates
}
