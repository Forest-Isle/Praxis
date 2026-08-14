import { analyzeBashStructure, normalizeBashWrapperArgv } from './bash-ast.js'

export type SedSafetyResult = { safe: true } | { safe: false; reason: string }

interface SedInvocation {
  expressions: string[]
  files: string[]
  flags: string[]
  unsupported: boolean
}

function parseSedInvocation(args: readonly string[]): SedInvocation {
  const expressions: string[] = []
  const files: string[] = []
  const flags: string[] = []
  let standaloneExpression = false
  let optionsEnded = false
  let unsupported = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (!optionsEnded && argument === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && (argument === '-e' || argument === '--expression')) {
      flags.push(argument)
      const expression = args[index + 1]
      if (expression === undefined) unsupported = true
      else expressions.push(expression)
      index += 1
      continue
    }
    if (!optionsEnded && argument.startsWith('--expression=')) {
      flags.push('--expression')
      expressions.push(argument.slice('--expression='.length))
      continue
    }
    if (!optionsEnded && (argument === '-f' || argument === '--file')) {
      unsupported = true
      index += 1
      continue
    }
    if (!optionsEnded && argument.startsWith('-')) {
      flags.push(argument)
      continue
    }
    if (expressions.length === 0 && !standaloneExpression) {
      expressions.push(argument)
      standaloneExpression = true
    } else {
      files.push(argument)
    }
  }
  return { expressions, files, flags, unsupported }
}

function shortFlagsAllowed(
  flag: string,
  allowed: ReadonlySet<string>,
): boolean {
  if (!flag.startsWith('-') || flag.startsWith('--')) return false
  return [...flag.slice(1)].every((character) => allowed.has(character))
}

function linePrintIsSafe(invocation: SedInvocation): boolean {
  const short = new Set(['n', 'E', 'r', 'z'])
  const long = new Set([
    '--quiet',
    '--silent',
    '--regexp-extended',
    '--zero-terminated',
    '--posix',
    '-e',
    '--expression',
  ])
  if (
    invocation.flags.some(
      (flag) => !long.has(flag) && !shortFlagsAllowed(flag, short),
    )
  ) {
    return false
  }
  const hasQuiet = invocation.flags.some(
    (flag) =>
      flag === '--quiet' ||
      flag === '--silent' ||
      (!flag.startsWith('--') && flag.slice(1).includes('n')),
  )
  return (
    hasQuiet &&
    invocation.expressions.length > 0 &&
    invocation.expressions.every((expression) =>
      expression
        .split(';')
        .every((part) => /^(?:\d+|\d+,\d+)?p$/u.test(part.trim())),
    )
  )
}

function substitutionFlags(expression: string): string | undefined {
  if (!expression.startsWith('s/')) return undefined
  const delimiters: number[] = []
  let escaped = false
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index] ?? ''
    if (escaped) {
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '/') {
      delimiters.push(index)
    }
  }
  if (delimiters.length !== 3 || delimiters[0] !== 1) return undefined
  const lastDelimiter = delimiters.at(-1)
  return lastDelimiter === undefined
    ? undefined
    : expression.slice(lastDelimiter + 1)
}

function substitutionIsSafe(
  invocation: SedInvocation,
  allowFileWrites: boolean,
): boolean {
  const short = new Set(['E', 'r', ...(allowFileWrites ? ['i'] : [])])
  const long = new Set([
    '--regexp-extended',
    '--posix',
    '-e',
    '--expression',
    ...(allowFileWrites ? ['--in-place'] : []),
  ])
  if (
    invocation.flags.some(
      (flag) => !long.has(flag) && !shortFlagsAllowed(flag, short),
    )
  ) {
    return false
  }
  if (!allowFileWrites && invocation.files.length > 0) return false
  if (invocation.expressions.length !== 1) return false
  const expression = invocation.expressions[0] ?? ''
  if (
    expression.includes(';') ||
    [...expression].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 1 || codePoint > 127
    })
  )
    return false
  const flags = substitutionFlags(expression)
  return flags !== undefined && /^[gpimIM]*[1-9]?[gpimIM]*$/u.test(flags)
}

export function validateSedSafety(
  source: string,
  allowFileWrites: boolean,
): SedSafetyResult {
  const analysis = analyzeBashStructure(source)
  if (!analysis.parsed) return { safe: false, reason: analysis.reason }
  for (const command of analysis.commands) {
    const normalized = normalizeBashWrapperArgv(command.argv)
    if (!normalized.ok) return { safe: false, reason: normalized.reason }
    if (normalized.argv[0] !== 'sed') continue
    const invocation = parseSedInvocation(normalized.argv.slice(1))
    if (
      invocation.unsupported ||
      (!linePrintIsSafe(invocation) &&
        !substitutionIsSafe(invocation, allowFileWrites))
    ) {
      return {
        safe: false,
        reason:
          'sed command requires explicit approval for potentially dangerous operations',
      }
    }
  }
  return { safe: true }
}
