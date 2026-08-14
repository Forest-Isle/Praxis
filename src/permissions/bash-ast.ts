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

type StaticValue = { ok: true; value: string } | { ok: false; nodeType: string }

export type BashSemanticResult =
  { safe: true } | { safe: false; reason: string }

function staticNodeValue(
  node: SyntaxNode,
  substitutions: boolean,
): StaticValue {
  if (node.type === 'command_name') {
    const child = node.namedChild(0)
    return child
      ? staticNodeValue(child, substitutions)
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
  if (node.type === 'string') {
    let value = ''
    let cursor = node.startIndex + 1
    for (const child of node.namedChildren) {
      value += sourceSlice(node, cursor, child.startIndex)
      const part = staticNodeValue(child, substitutions)
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
      const part = staticNodeValue(child, substitutions)
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

function commandArgv(node: SyntaxNode): StaticValue & { argv?: string[] } {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return { ok: false, nodeType: node.type }
  const name = staticNodeValue(nameNode, false)
  if (!name.ok) return name
  const argv = [name.value]
  for (const argument of node.childrenForFieldName('argument')) {
    const value = staticNodeValue(argument, true)
    if (!value.ok) return value
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
  const subscriptFlag =
    command === 'printf'
      ? '-v'
      : ['test', '[', '[['].includes(command)
        ? '-v'
        : undefined
  if (subscriptFlag) {
    const index = normalized.argv.indexOf(subscriptFlag)
    if (index >= 0 && normalized.argv[index + 1]?.includes('[')) {
      return `${command} ${subscriptFlag} operand contains array subscript`
    }
  }
  if (
    (command === 'read' || command === 'unset') &&
    normalized.argv
      .slice(1)
      .some((arg) => !arg.startsWith('-') && arg.includes('['))
  ) {
    return `${command} operand contains array subscript`
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
    if (node.type === 'command') commands.push(permissionUnit(node))
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
    const parsed = commandArgv(node)
    if (!parsed.ok || !parsed.argv) {
      return {
        parsed: false,
        reason: !parsed.ok
          ? `Command contains dynamic ${parsed.nodeType}`
          : 'Command cannot be statically analyzed',
      }
    }
    commands.push({ text: node.text, argv: parsed.argv })
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
    const parsed = commandArgv(command)
    if (!parsed.ok || !parsed.argv) {
      return {
        safe: false,
        reason:
          command.childForFieldName('name') && !parsed.ok
            ? `Command name is runtime-determined (${parsed.nodeType})`
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
  const ranges = new Map<string, SyntaxNode>()
  for (const node of commandNodes(tree.rootNode)) {
    ranges.set(`${node.startIndex}:${node.endIndex}`, node)
  }
  const commands = [...ranges.values()]
    .sort(
      (left, right) =>
        left.startIndex - right.startIndex || right.endIndex - left.endIndex,
    )
    .map((node) => source.slice(node.startIndex, node.endIndex).trim())
    .filter(Boolean)
  if (commands.length > MAX_BASH_PERMISSION_COMMANDS) {
    return { commands: [trimmed], parsed: false }
  }
  return { commands: commands.length > 0 ? commands : [trimmed], parsed: true }
}
