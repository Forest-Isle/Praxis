export type ShellRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }

function prefixRule(value: string): string | undefined {
  const match = /^(.+):\*$/u.exec(value)
  return match?.[1]
}

function unescapedStars(value: string): readonly number[] {
  const indices: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '*') continue
    let slashes = 0
    for (
      let cursor = index - 1;
      cursor >= 0 && value[cursor] === '\\';
      cursor -= 1
    ) {
      slashes += 1
    }
    if (slashes % 2 === 0) indices.push(index)
  }
  return indices
}

export function parseShellRule(value: string): ShellRule {
  const prefix = prefixRule(value)
  if (prefix !== undefined) return { type: 'prefix', prefix }
  return unescapedStars(value).length > 0
    ? { type: 'wildcard', pattern: value }
    : { type: 'exact', command: value }
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&')
}

export function shellWildcardMatches(
  pattern: string,
  command: string,
  caseInsensitive = false,
): boolean {
  const value = pattern.trim()
  let expression = ''
  let wildcardCount = 0
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? ''
    if (character === '\\' && index + 1 < value.length) {
      const next = value[index + 1]
      if (next === '*' || next === '\\') {
        expression += escapeRegex(next)
        index += 1
        continue
      }
    }
    if (character === '*') {
      expression += '.*'
      wildcardCount += 1
    } else {
      expression += escapeRegex(character)
    }
  }
  if (wildcardCount === 1 && expression.endsWith(' .*')) {
    expression = `${expression.slice(0, -3)}(?: .*)?`
  }
  return new RegExp(`^${expression}$`, caseInsensitive ? 'isu' : 'su').test(
    command,
  )
}

function equal(left: string, right: string, caseInsensitive: boolean): boolean {
  return caseInsensitive
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right
}

export function shellRuleMatches(
  rule: ShellRule,
  command: string,
  caseInsensitive = false,
): boolean {
  if (rule.type === 'exact') {
    return equal(rule.command, command, caseInsensitive)
  }
  if (rule.type === 'wildcard') {
    return shellWildcardMatches(rule.pattern, command, caseInsensitive)
  }
  if (equal(rule.prefix, command, caseInsensitive)) return true
  const prefix = `${rule.prefix} `
  return caseInsensitive
    ? command.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    : command.startsWith(prefix)
}
