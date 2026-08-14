import Parser, { type SyntaxNode } from 'tree-sitter'
import Bash from 'tree-sitter-bash'

const parser = new Parser()
parser.setLanguage(Bash)
export const MAX_BASH_PERMISSION_COMMANDS = 50

const SUBSTITUTION_PLACEHOLDER = '__PRAXIS_COMMAND_SUBSTITUTION__'
const BRACE_EXPANSION = /\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/u
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\x00-\x08\x0b-\x1f\x7f]/u
const UNICODE_WHITESPACE =
  /[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/u
const BACKSLASH_WHITESPACE = /\\[ \t]|[^ \t\n\\]\\\n/u
const PROC_ENVIRON = /\/proc\/.*\/environ/u
const NEWLINE_COMMENT = /\n[ \t]*#/u

const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'for',
  'in',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'select',
])

const ZSH_ESCAPE_BUILTINS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

const EVAL_LIKE_BUILTINS = new Set([
  'eval',
  'source',
  '.',
  'exec',
  'command',
  'builtin',
  'fc',
  'coproc',
  'noglob',
  'nocorrect',
  'trap',
  'enable',
  'mapfile',
  'readarray',
  'hash',
  'bind',
  'complete',
  'compgen',
  'alias',
  'let',
])

const SUBSCRIPT_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  test: new Set(['-v', '-R']),
  '[': new Set(['-v', '-R']),
  '[[': new Set(['-v', '-R']),
  printf: new Set(['-v']),
  read: new Set(['-a']),
  unset: new Set(['-v']),
  wait: new Set(['-p']),
}

const READ_VALUE_FLAGS = new Set(['-p', '-d', '-n', '-N', '-t', '-u', '-i'])

type StaticValue = { ok: true; value: string } | { ok: false; nodeType: string }

export type BashSemanticResult =
  { safe: true } | { safe: false; reason: string }

const EMPTY_VARIABLE_SCOPE: ReadonlyMap<string, string> = new Map()

function staticNodeValue(
  node: SyntaxNode,
  substitutions: boolean,
  scope: ReadonlyMap<string, string> = EMPTY_VARIABLE_SCOPE,
): StaticValue {
  if (node.type === 'command_name') {
    const child = node.namedChild(0)
    return child
      ? staticNodeValue(child, substitutions, scope)
      : { ok: false, nodeType: node.type }
  }
  if (
    node.type === 'word' ||
    node.type === 'number' ||
    node.type === 'string_content' ||
    node.type === 'test_operator'
  ) {
    return {
      ok: true,
      value: node.text.replace(/\\\n/gu, '').replace(/\\(.)/gu, '$1'),
    }
  }
  if (node.type === 'raw_string') {
    return { ok: true, value: node.text.slice(1, -1) }
  }
  if (node.type === 'command_substitution' && substitutions) {
    return { ok: true, value: SUBSTITUTION_PLACEHOLDER }
  }
  if (node.type === 'simple_expansion') {
    const name = node.namedChildren.find(
      (child) => child.type === 'variable_name',
    )?.text
    const value = name ? scope.get(name) : undefined
    return value === undefined
      ? { ok: false, nodeType: node.type }
      : { ok: true, value }
  }
  if (node.type === 'string') {
    let value = ''
    let cursor = node.startIndex + 1
    for (const child of node.namedChildren) {
      value += sourceSlice(node, cursor, child.startIndex)
      const part = staticNodeValue(child, substitutions, scope)
      if (!part.ok) return part
      value += part.value
      cursor = child.endIndex
    }
    value += sourceSlice(node, cursor, node.endIndex - 1)
    return {
      ok: true,
      value: value.replace(/\\([$`"\\\n])/gu, '$1'),
    }
  }
  if (node.type === 'concatenation') {
    let value = ''
    for (const child of node.namedChildren) {
      const part = staticNodeValue(child, substitutions, scope)
      if (!part.ok) return part
      value += part.value
    }
    return { ok: true, value }
  }
  return { ok: false, nodeType: node.type }
}

function sourceSlice(node: SyntaxNode, start: number, end: number): string {
  const relativeStart = Math.max(0, start - node.startIndex)
  const relativeEnd = Math.max(relativeStart, end - node.startIndex)
  return node.text.slice(relativeStart, relativeEnd)
}

function commandArgv(
  node: SyntaxNode,
  scope: ReadonlyMap<string, string> = EMPTY_VARIABLE_SCOPE,
): StaticValue & { argv?: string[] } {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return { ok: false, nodeType: node.type }
  const name = staticNodeValue(nameNode, false, scope)
  if (!name.ok) return name
  if (/[ \t\n*?[\]]/u.test(name.value)) {
    return { ok: false, nodeType: 'simple_expansion' }
  }
  const argv = [name.value]
  for (const argument of node.childrenForFieldName('argument')) {
    const value = staticNodeValue(
      argument,
      argument.type === 'string' || argument.type === 'concatenation',
      scope,
    )
    if (!value.ok) return value
    if (
      argument.type === 'simple_expansion' &&
      /[ \t\n*?[\]]/u.test(value.value)
    ) {
      return { ok: false, nodeType: 'simple_expansion' }
    }
    argv.push(value.value)
  }
  return { ok: true, value: name.value, argv }
}

export type BashWrapperResult =
  { ok: true; argv: string[] } | { ok: false; reason: string }

export function normalizeBashWrapperArgv(
  input: readonly string[],
): BashWrapperResult {
  let argv = [...input]
  for (;;) {
    const wrapper = argv[0]
    if (wrapper === 'time' || wrapper === 'nohup') {
      argv = argv.slice(1)
      continue
    }
    if (wrapper === 'timeout') {
      let index = 1
      while (index < argv.length) {
        const value = argv[index] ?? ''
        const next = argv[index + 1]
        if (
          value === '--foreground' ||
          value === '--preserve-status' ||
          value === '--verbose' ||
          value === '-v' ||
          /^--(?:kill-after|signal)=[A-Za-z0-9_.+-]+$/u.test(value) ||
          /^-[ks][A-Za-z0-9_.+-]+$/u.test(value)
        ) {
          index += 1
        } else if (
          ['--kill-after', '--signal', '-k', '-s'].includes(value) &&
          next &&
          /^[A-Za-z0-9_.+-]+$/u.test(next)
        ) {
          index += 2
        } else if (value.startsWith('-')) {
          return {
            ok: false,
            reason: `timeout with ${value} flag cannot be statically analyzed`,
          }
        } else {
          break
        }
      }
      const duration = argv[index]
      if (duration === undefined) return { ok: true, argv }
      if (!/^\d+(?:\.\d+)?[smhd]?$/u.test(duration)) {
        return {
          ok: false,
          reason: `timeout duration '${duration}' cannot be statically analyzed`,
        }
      }
      argv = argv.slice(index + 1)
      continue
    }
    if (wrapper === 'nice') {
      if (argv[1] === '-n') {
        if (!/^-?\d+$/u.test(argv[2] ?? '')) {
          return {
            ok: false,
            reason: 'nice priority cannot be statically analyzed',
          }
        }
        argv = argv.slice(3)
      } else if (/^-\d+$/u.test(argv[1] ?? '')) {
        argv = argv.slice(2)
      } else if (/[$(`]/u.test(argv[1] ?? '')) {
        return {
          ok: false,
          reason:
            'nice argument contains expansion and cannot be statically analyzed',
        }
      } else {
        argv = argv.slice(1)
      }
      continue
    }
    if (wrapper === 'env') {
      let index = 1
      while (index < argv.length) {
        const value = argv[index] ?? ''
        if (
          (value.includes('=') && !value.startsWith('-')) ||
          value === '-i' ||
          value === '-0' ||
          value === '-v'
        ) {
          index += 1
        } else if (value === '-u' && argv[index + 1]) {
          index += 2
        } else if (value.startsWith('-')) {
          return {
            ok: false,
            reason: `env with ${value} flag cannot be statically analyzed`,
          }
        } else {
          break
        }
      }
      if (index === argv.length) return { ok: true, argv }
      argv = argv.slice(index)
      continue
    }
    if (wrapper === 'stdbuf') {
      let index = 1
      while (index < argv.length) {
        const value = argv[index] ?? ''
        if (
          /^-[ioe].+/u.test(value) ||
          /^--(?:input|output|error)=/u.test(value)
        ) {
          index += 1
        } else if (/^-[ioe]$/u.test(value) && argv[index + 1]) {
          index += 2
        } else if (value.startsWith('-')) {
          return {
            ok: false,
            reason: `stdbuf with ${value} flag cannot be statically analyzed`,
          }
        } else {
          break
        }
      }
      if (index === 1 || index === argv.length) return { ok: true, argv }
      argv = argv.slice(index)
      continue
    }
    return { ok: true, argv }
  }
}

function firstSemanticFailure(argv: readonly string[]): string | undefined {
  const normalized = normalizeBashWrapperArgv(argv)
  if (!normalized.ok) return normalized.reason
  const command = normalized.argv[0]
  if (command === undefined) return undefined
  if (command === '' || command.includes(SUBSTITUTION_PLACEHOLDER)) {
    return 'Command name is runtime-determined'
  }
  if (/^[-|&]/u.test(command)) return 'Command appears to be incomplete'
  if (SHELL_KEYWORDS.has(command))
    return `Shell keyword '${command}' was parsed as a command`
  if (ZSH_ESCAPE_BUILTINS.has(command)) {
    return `Zsh builtin '${command}' can bypass security checks`
  }
  if (EVAL_LIKE_BUILTINS.has(command)) {
    const args = normalized.argv.slice(1)
    const safeCommandLookup =
      command === 'command' && (args[0] === '-v' || args[0] === '-V')
    const safeHistoryList =
      command === 'fc' && !args.some((arg) => /^-[^-]*[es]/u.test(arg))
    const safeCompletionList =
      command === 'compgen' && !args.some((arg) => /^-[^-]*[CFW]/u.test(arg))
    if (!safeCommandLookup && !safeHistoryList && !safeCompletionList) {
      return `'${command}' evaluates arguments as shell code`
    }
  }
  if (command === 'jq') {
    if (normalized.argv.some((arg) => /\bsystem\s*\(/u.test(arg))) {
      return 'jq system() executes arbitrary commands'
    }
    if (
      normalized.argv.some((arg) =>
        /^(?:-[fL](?:$|[^A-Za-z])|--(?:from-file|rawfile|slurpfile|library-path)(?:$|=))/u.test(
          arg,
        ),
      )
    ) {
      return 'jq file-loading flags cannot be automatically approved'
    }
  }
  const subscriptFlags = SUBSCRIPT_FLAGS[command]
  if (subscriptFlags) {
    for (let index = 1; index < normalized.argv.length; index += 1) {
      const argument = normalized.argv[index] ?? ''
      for (const flag of subscriptFlags) {
        if (argument === flag && normalized.argv[index + 1]?.includes('[')) {
          return `${command} ${flag} operand contains array subscript`
        }
        if (
          flag.length === 2 &&
          argument.startsWith(flag) &&
          argument.length > 2 &&
          argument.includes('[')
        ) {
          return `${command} ${flag} fused operand contains array subscript`
        }
        if (
          argument.length > 2 &&
          argument.startsWith('-') &&
          !argument.startsWith('--') &&
          argument.includes(flag.slice(1)) &&
          normalized.argv[index + 1]?.includes('[')
        ) {
          return `${command} combined ${flag} operand contains array subscript`
        }
      }
    }
  }
  if (command === 'read' || command === 'unset') {
    let skipNext = false
    for (const argument of normalized.argv.slice(1)) {
      if (skipNext) {
        skipNext = false
        continue
      }
      if (argument.startsWith('-')) {
        if (command === 'read' && READ_VALUE_FLAGS.has(argument)) {
          skipNext = true
        }
        continue
      }
      if (argument.includes('[')) {
        return `${command} positional operand contains array subscript`
      }
    }
  }
  for (const argument of normalized.argv) {
    if (PROC_ENVIRON.test(argument)) return 'Accesses /proc/*/environ'
    if (NEWLINE_COMMENT.test(argument)) {
      return 'Newline followed by # can hide arguments from validation'
    }
  }
  return undefined
}

function permissionUnit(node: SyntaxNode): SyntaxNode {
  const parent = node.parent
  return parent?.type === 'redirected_statement' ? parent : node
}

function commandNodes(root: SyntaxNode): readonly SyntaxNode[] {
  const commands: SyntaxNode[] = []
  const visit = (node: SyntaxNode) => {
    if (
      node.type === 'command' ||
      node.type === 'declaration_command' ||
      node.type === 'test_command' ||
      node.type === 'unset_command'
    ) {
      commands.push(permissionUnit(node))
    }
    for (const child of node.namedChildren) visit(child)
  }
  visit(root)
  return commands
}

function rawCommandNodes(root: SyntaxNode): readonly SyntaxNode[] {
  const commands: SyntaxNode[] = []
  const visit = (node: SyntaxNode) => {
    if (node.type === 'command') commands.push(node)
    for (const child of node.namedChildren) visit(child)
  }
  visit(root)
  return commands
}

function nearestControlNode(node: SyntaxNode): SyntaxNode | null {
  let parent = node.parent
  while (parent) {
    if (
      [
        'if_statement',
        'while_statement',
        'for_statement',
        'subshell',
        'command_substitution',
      ].includes(parent.type)
    ) {
      return parent
    }
    parent = parent.parent
  }
  return null
}

function scopeBarrier(source: string): boolean {
  return (
    /\|\||(^|[^|])\|([^|]|$)|(^|[^&])&([^&]|$)/u.test(source) ||
    /\b(?:else|elif|fi|done)\b/u.test(source)
  )
}

function standaloneAssignments(root: SyntaxNode): readonly SyntaxNode[] {
  const assignments: SyntaxNode[] = []
  const visit = (node: SyntaxNode) => {
    if (
      node.type === 'variable_assignment' &&
      node.parent?.type !== 'command'
    ) {
      assignments.push(node)
      return
    }
    for (const child of node.namedChildren) visit(child)
  }
  visit(root)
  return assignments.sort((left, right) => left.startIndex - right.startIndex)
}

function variableScopeForCommand(
  root: SyntaxNode,
  command: SyntaxNode,
  source: string,
): ReadonlyMap<string, string> {
  const scope = new Map<string, string>()
  const commandControl = nearestControlNode(command)
  for (const assignment of standaloneAssignments(root)) {
    if (assignment.endIndex > command.startIndex) break
    const assignmentControl = nearestControlNode(assignment)
    if (assignmentControl && assignmentControl !== commandControl) continue
    const between = source.slice(assignment.endIndex, command.startIndex)
    if (scopeBarrier(between)) continue
    const name = assignment.childForFieldName('name')?.text
    if (!name || new RegExp(`\\bunset[ \\t]+${name}\\b`, 'u').test(between)) {
      if (name) scope.delete(name)
      continue
    }
    const valueNode = assignment.childForFieldName('value')
    if (!valueNode) {
      scope.set(name, '')
      continue
    }
    const value = staticNodeValue(valueNode, true, scope)
    if (value.ok) scope.set(name, value.value)
  }
  return scope
}

function shellQuoted(argument: string): string {
  if (argument !== '' && !/["'\\ \t\n$`;|&<>(){}*?[\]~#]/u.test(argument)) {
    return argument
  }
  return `'${argument.replace(/'/gu, `'\\''`)}'`
}

function resolvedCommandText(
  node: SyntaxNode,
  argv: readonly string[],
): string {
  return /\$[A-Za-z_]/u.test(node.text)
    ? argv.map(shellQuoted).join(' ')
    : node.text
}

export interface BashStaticCommand {
  text: string
  argv: readonly string[]
}

export interface BashStaticRedirect {
  operator: '>' | '>>' | '<' | '>&' | '<&' | '>|' | '&>' | '&>>' | '<<<'
  target: string
}

export type BashStaticAnalysis =
  | {
      parsed: true
      commands: readonly BashStaticCommand[]
      redirects: readonly BashStaticRedirect[]
    }
  | { parsed: false; reason: string }

const REDIRECT_OPERATORS = new Set<BashStaticRedirect['operator']>([
  '>',
  '>>',
  '<',
  '>&',
  '<&',
  '>|',
  '&>',
  '&>>',
  '<<<',
])

export function analyzeBashStructure(source: string): BashStaticAnalysis {
  const tree = parser.parse(source)
  if (tree.rootNode.hasError) {
    return { parsed: false, reason: 'Command syntax could not be parsed' }
  }
  const nodes = rawCommandNodes(tree.rootNode)
  if (nodes.length > MAX_BASH_PERMISSION_COMMANDS) {
    return {
      parsed: false,
      reason: `Command contains more than ${MAX_BASH_PERMISSION_COMMANDS} permission units`,
    }
  }
  const commands: BashStaticCommand[] = []
  for (const node of nodes) {
    const parsed = commandArgv(
      node,
      variableScopeForCommand(tree.rootNode, node, source),
    )
    if (!parsed.ok || !parsed.argv) {
      return {
        parsed: false,
        reason: !parsed.ok
          ? `Command contains dynamic ${parsed.nodeType}`
          : 'Command cannot be statically analyzed',
      }
    }
    commands.push({
      text: resolvedCommandText(node, parsed.argv),
      argv: parsed.argv,
    })
  }

  const redirects: BashStaticRedirect[] = []
  let failure: string | undefined
  const visit = (node: SyntaxNode) => {
    if (failure) return
    if (node.type === 'file_redirect') {
      const destination = node.childForFieldName('destination')
      const operator = node.children.find(
        (child) =>
          !child.isNamed &&
          REDIRECT_OPERATORS.has(child.type as BashStaticRedirect['operator']),
      )?.type as BashStaticRedirect['operator'] | undefined
      if (destination && operator) {
        const target = staticNodeValue(destination, false)
        if (!target.ok) {
          failure = `Redirect target contains dynamic ${target.nodeType}`
          return
        }
        redirects.push({ operator, target: target.value })
      }
    }
    for (const child of node.namedChildren) visit(child)
  }
  visit(tree.rootNode)
  return failure
    ? { parsed: false, reason: failure }
    : { parsed: true, commands, redirects }
}

export function validateBashSemantics(source: string): BashSemanticResult {
  if (CONTROL_CHARACTER.test(source)) {
    return { safe: false, reason: 'Command contains control characters' }
  }
  if (UNICODE_WHITESPACE.test(source)) {
    return { safe: false, reason: 'Command contains Unicode whitespace' }
  }
  if (BACKSLASH_WHITESPACE.test(source)) {
    return {
      safe: false,
      reason: 'Backslash-escaped whitespace cannot be statically analyzed',
    }
  }
  if (/~\[/u.test(source)) {
    return {
      safe: false,
      reason: 'Command contains zsh dynamic directory syntax',
    }
  }
  if (/(?:^|[\s;&|])=[A-Za-z_]/u.test(source)) {
    return { safe: false, reason: 'Command contains zsh equals expansion' }
  }

  const tree = parser.parse(source)
  if (tree.rootNode.hasError) {
    return { safe: false, reason: 'Command syntax could not be parsed' }
  }
  const commands = rawCommandNodes(tree.rootNode)
  if (commands.length > MAX_BASH_PERMISSION_COMMANDS) {
    return {
      safe: false,
      reason: `Command contains more than ${MAX_BASH_PERMISSION_COMMANDS} permission units`,
    }
  }

  let structuralFailure: string | undefined
  const inspect = (node: SyntaxNode) => {
    if (structuralFailure) return
    if (
      (node.type === 'word' || node.type === 'concatenation') &&
      BRACE_EXPANSION.test(node.text)
    ) {
      structuralFailure = 'Command contains brace expansion'
      return
    }
    if (node.type === 'function_definition' || node.type === 'case_statement') {
      structuralFailure = `${node.type === 'function_definition' ? 'Shell function definition' : 'Case statement'} cannot be statically analyzed`
      return
    }
    if (node.type === 'heredoc_redirect') {
      const start = node.namedChildren.find(
        (child) => child.type === 'heredoc_start',
      )?.text
      const quoted =
        start !== undefined &&
        ((start.startsWith("'") && start.endsWith("'")) ||
          (start.startsWith('"') && start.endsWith('"')) ||
          start.startsWith('\\'))
      if (!quoted) {
        structuralFailure =
          'Heredoc with unquoted delimiter undergoes shell expansion'
        return
      }
    }
    if (node.type === 'declaration_command') {
      if (/^(?:declare|typeset|local)\s+-[A-Za-z]*[niaA]/u.test(node.text)) {
        structuralFailure =
          'Declaration flag changes assignment semantics and cannot be statically analyzed'
        return
      }
      if (
        /^(?:declare|typeset|local)\b/u.test(node.text) &&
        /(?:^|\s)["']?[^=\s"']*\[/u.test(node.text)
      ) {
        structuralFailure =
          'Declaration operand contains array subscript evaluation'
        return
      }
    }
    if (node.type === 'test_command') {
      const text = node.text
      if (
        /(?:-v|-R)\s+["']?[^\s"']*\[/u.test(text) ||
        /["']?[^\s"']*\[[^\s]*\s+(?:-eq|-ne|-lt|-le|-gt|-ge)\b/u.test(text) ||
        /\b(?:-eq|-ne|-lt|-le|-gt|-ge)\s+["']?[^\s"']*\[/u.test(text)
      ) {
        structuralFailure = 'Test operand contains array subscript evaluation'
        return
      }
    }
    if (node.type === 'file_redirect') {
      const destination = node.childForFieldName('destination')
      if (destination) {
        const target = staticNodeValue(destination, false)
        if (!target.ok) {
          structuralFailure = `Redirect target contains dynamic ${target.nodeType}`
          return
        }
        if (PROC_ENVIRON.test(target.value)) {
          structuralFailure = 'Accesses /proc/*/environ'
          return
        }
        if (NEWLINE_COMMENT.test(target.value)) {
          structuralFailure =
            'Newline followed by # can hide arguments from validation'
          return
        }
      }
    }
    for (const child of node.namedChildren) inspect(child)
  }
  inspect(tree.rootNode)
  if (structuralFailure) return { safe: false, reason: structuralFailure }

  for (const command of commands) {
    const scope = variableScopeForCommand(tree.rootNode, command, source)
    const parsed = commandArgv(command, scope)
    if (!parsed.ok || !parsed.argv) {
      const nameNode = command.childForFieldName('name')
      const parsedName = nameNode
        ? staticNodeValue(nameNode, false, scope)
        : undefined
      const failureNode = !parsed.ok ? parsed.nodeType : command.type
      return {
        safe: false,
        reason:
          parsedName && !parsedName.ok
            ? `Command name is runtime-determined (${failureNode})`
            : failureNode === 'command_substitution'
              ? 'Command contains bare command substitution that cannot be statically analyzed'
              : 'Command cannot be statically analyzed',
      }
    }
    const failure = firstSemanticFailure(parsed.argv)
    if (failure) return { safe: false, reason: failure }
  }
  return { safe: true }
}

export interface BashCommandAnalysis {
  commands: readonly string[]
  parsed: boolean
}

export function analyzeBashCommands(source: string): BashCommandAnalysis {
  const trimmed = source.trim()
  if (!trimmed) return { commands: [], parsed: true }
  const tree = parser.parse(source)
  if (tree.rootNode.hasError) {
    return { commands: [trimmed], parsed: false }
  }
  const staticAnalysis = analyzeBashStructure(source)
  const resolvedByCommand = new Map<string, string>()
  if (staticAnalysis.parsed) {
    rawCommandNodes(tree.rootNode).forEach((node, index) => {
      const resolved = staticAnalysis.commands[index]
      if (resolved && resolved.text !== node.text) {
        resolvedByCommand.set(
          `${node.startIndex}:${node.endIndex}`,
          resolved.text,
        )
      }
    })
  }
  const ranges = new Map<string, SyntaxNode>()
  for (const node of commandNodes(tree.rootNode)) {
    ranges.set(`${node.startIndex}:${node.endIndex}`, node)
  }
  const commands = [...ranges.values()]
    .sort(
      (left, right) =>
        left.startIndex - right.startIndex || right.endIndex - left.endIndex,
    )
    .map((node) => {
      const command =
        node.type === 'command'
          ? node
          : rawCommandNodes(node).find(
              (candidate) => candidate.startIndex >= node.startIndex,
            )
      return (
        (command
          ? resolvedByCommand.get(`${command.startIndex}:${command.endIndex}`)
          : undefined) ?? source.slice(node.startIndex, node.endIndex)
      ).trim()
    })
    .filter(Boolean)
  if (commands.length > MAX_BASH_PERMISSION_COMMANDS) {
    return { commands: [trimmed], parsed: false }
  }
  return { commands: commands.length > 0 ? commands : [trimmed], parsed: true }
}
