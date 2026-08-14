import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { PermissionUpdate } from '../core/runtime.js'
import {
  analyzeBashStructure,
  normalizeBashWrapperArgv,
  type BashStaticRedirect,
} from './bash-ast.js'

type FileOperation = 'read' | 'write' | 'create'
type RuleOutcome = 'allow' | 'deny' | null

export interface BashPathSafetyOptions {
  cwd: string
  homeDirectory: string
  readRoots: readonly string[]
  writeRoots: readonly string[]
  permissionMode:
    | 'acceptEdits'
    | 'auto'
    | 'bypassPermissions'
    | 'manual'
    | 'dontAsk'
    | 'plan'
    | 'default'
  fileRule?: (operation: FileOperation, absolutePath: string) => RuleOutcome
}

export type BashPathSafetyResult =
  | { safe: true }
  | {
      safe: false
      behavior: 'ask' | 'deny'
      reason: string
      path?: string
      operation?: FileOperation
      suggestions?: readonly PermissionUpdate[]
    }

type PathCommand =
  | 'cd'
  | 'ls'
  | 'find'
  | 'mkdir'
  | 'touch'
  | 'rm'
  | 'rmdir'
  | 'mv'
  | 'cp'
  | 'cat'
  | 'head'
  | 'tail'
  | 'sort'
  | 'uniq'
  | 'wc'
  | 'cut'
  | 'paste'
  | 'column'
  | 'tr'
  | 'file'
  | 'stat'
  | 'diff'
  | 'awk'
  | 'strings'
  | 'hexdump'
  | 'od'
  | 'base64'
  | 'nl'
  | 'grep'
  | 'rg'
  | 'sed'
  | 'git'
  | 'jq'
  | 'sha256sum'
  | 'sha1sum'
  | 'md5sum'

const OPERATIONS: Readonly<Record<PathCommand, FileOperation>> = {
  cd: 'read',
  ls: 'read',
  find: 'read',
  mkdir: 'create',
  touch: 'create',
  rm: 'write',
  rmdir: 'write',
  mv: 'write',
  cp: 'write',
  cat: 'read',
  head: 'read',
  tail: 'read',
  sort: 'read',
  uniq: 'read',
  wc: 'read',
  cut: 'read',
  paste: 'read',
  column: 'read',
  tr: 'read',
  file: 'read',
  stat: 'read',
  diff: 'read',
  awk: 'read',
  strings: 'read',
  hexdump: 'read',
  od: 'read',
  base64: 'read',
  nl: 'read',
  grep: 'read',
  rg: 'read',
  sed: 'write',
  git: 'read',
  jq: 'read',
  sha256sum: 'read',
  sha1sum: 'read',
  md5sum: 'read',
}

const PATH_COMMANDS = new Set<PathCommand>(
  Object.keys(OPERATIONS) as PathCommand[],
)
const SENSITIVE_FILES = new Set([
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.claude.json',
])
const SENSITIVE_DIRECTORIES = new Set(['.git', '.vscode', '.idea', '.claude'])
const GLOB = /[*?[\]{}]/u

function positionalArguments(args: readonly string[]): string[] {
  const result: string[] = []
  let optionsEnded = false
  for (const argument of args) {
    if (!optionsEnded && argument === '--') {
      optionsEnded = true
    } else if (optionsEnded || !argument.startsWith('-')) {
      result.push(argument)
    }
  }
  return result
}

function patternCommandPaths(
  args: readonly string[],
  flagsWithValues: ReadonlySet<string>,
  defaultPaths: readonly string[] = [],
): string[] {
  const paths: string[] = []
  let patternSeen = false
  let optionsEnded = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (!optionsEnded && argument === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && argument.startsWith('-')) {
      const flag = argument.split('=', 1)[0] ?? argument
      if (['-e', '--regexp', '-f', '--file'].includes(flag)) patternSeen = true
      if (flagsWithValues.has(flag) && !argument.includes('=')) index += 1
      continue
    }
    if (!patternSeen) patternSeen = true
    else paths.push(argument)
  }
  return paths.length > 0 ? paths : [...defaultPaths]
}

function sedPaths(args: readonly string[]): string[] {
  const paths: string[] = []
  let expressionSeen = false
  let optionsEnded = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (!optionsEnded && argument === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && argument.startsWith('-')) {
      if (argument === '-f' || argument === '--file') {
        if (args[index + 1]) paths.push(args[index + 1] ?? '')
        index += 1
        expressionSeen = true
      } else if (argument === '-e' || argument === '--expression') {
        index += 1
        expressionSeen = true
      } else if (/^-.*[ef]/u.test(argument)) {
        expressionSeen = true
      }
      continue
    }
    if (!expressionSeen) expressionSeen = true
    else paths.push(argument)
  }
  return paths
}

function findPaths(args: readonly string[]): string[] {
  const paths: string[] = []
  const pathFlags = new Set([
    '-newer',
    '-anewer',
    '-cnewer',
    '-mnewer',
    '-samefile',
    '-path',
    '-wholename',
    '-ilname',
    '-lname',
    '-ipath',
    '-iwholename',
  ])
  let predicateSeen = false
  let optionsEnded = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (optionsEnded) {
      paths.push(argument)
    } else if (argument === '--') {
      optionsEnded = true
    } else if (argument.startsWith('-')) {
      if (!['-H', '-L', '-P'].includes(argument)) predicateSeen = true
      if (pathFlags.has(argument) || /^-newer[acmBt][acmtB]$/u.test(argument)) {
        if (args[index + 1]) paths.push(args[index + 1] ?? '')
        index += 1
      }
    } else if (!predicateSeen) {
      paths.push(argument)
    }
  }
  return paths.length > 0 ? paths : ['.']
}

function commandPaths(command: PathCommand, args: readonly string[]): string[] {
  if (command === 'cd') return args.length > 0 ? [args.join(' ')] : ['~']
  if (command === 'ls') {
    const paths = positionalArguments(args)
    return paths.length > 0 ? paths : ['.']
  }
  if (command === 'find') return findPaths(args)
  if (command === 'grep' || command === 'rg') {
    const flags = new Set([
      '-e',
      '--regexp',
      '-f',
      '--file',
      '-g',
      '--glob',
      '-m',
      '--max-count',
      '-A',
      '--after-context',
      '-B',
      '--before-context',
      '-C',
      '--context',
    ])
    return patternCommandPaths(args, flags, command === 'rg' ? ['.'] : [])
  }
  if (command === 'sed') return sedPaths(args)
  if (command === 'jq') {
    return patternCommandPaths(
      args,
      new Set([
        '-e',
        '--expression',
        '-f',
        '--from-file',
        '--arg',
        '--argjson',
        '--slurpfile',
        '--rawfile',
        '-L',
        '--library-path',
      ]),
    )
  }
  if (command === 'git') {
    if (args[0] === 'diff' && args.includes('--no-index')) {
      return positionalArguments(args.slice(1)).slice(0, 2)
    }
    return []
  }
  if (command === 'tr') {
    const positional = positionalArguments(args)
    const deletes = args.some(
      (arg) => /^-[^-]*d/u.test(arg) || arg === '--delete',
    )
    return positional.slice(deletes ? 1 : 2)
  }
  return positionalArguments(args)
}

function expandPath(path: string, options: BashPathSafetyOptions): string {
  if (path === '~' || path.startsWith('~/')) {
    return resolve(options.homeDirectory, path.slice(2))
  }
  return isAbsolute(path) ? resolve(path) : resolve(options.cwd, path)
}

function inside(candidate: string, root: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

function pathRepresentations(path: string): readonly string[] {
  const absolute = resolve(path)
  const representations = new Set([absolute])
  let existing = absolute
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return [...representations]
    existing = parent
  }
  try {
    const canonicalParent = realpathSync.native(existing)
    representations.add(resolve(canonicalParent, relative(existing, absolute)))
  } catch {
    // A disappearing path remains covered by its lexical representation.
  }
  return [...representations]
}

function insideRoots(candidate: string, roots: readonly string[]): boolean {
  const rootRepresentations = roots.flatMap(pathRepresentations)
  return pathRepresentations(candidate).every((path) =>
    rootRepresentations.some((root) => inside(path, root)),
  )
}

function sensitivePath(path: string): boolean {
  const segments = resolve(path)
    .split(sep)
    .filter(Boolean)
    .map((segment) => segment.toLocaleLowerCase())
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) {
    return true
  }
  return SENSITIVE_FILES.has(segments.at(-1) ?? '')
}

function dangerousRemoval(path: string, homeDirectory: string): boolean {
  const normalized = path.replace(/[\\/]+/gu, '/').replace(/\/$/u, '') || '/'
  if (normalized === '*' || normalized.endsWith('/*')) return true
  if (normalized === '/' || normalized === resolve(homeDirectory)) return true
  return dirname(normalized) === '/'
}

function pathFailure(
  rawPath: string,
  operation: FileOperation,
  options: BashPathSafetyOptions,
  dangerous = false,
): BashPathSafetyResult {
  if (
    rawPath.includes('__PRAXIS_COMMAND_SUBSTITUTION__') ||
    rawPath.includes('$') ||
    rawPath.includes('%') ||
    rawPath.startsWith('=')
  ) {
    return {
      safe: false,
      behavior: 'ask',
      reason: 'Shell expansion syntax in paths requires manual approval',
    }
  }
  if (rawPath.startsWith('~') && rawPath !== '~' && !rawPath.startsWith('~/')) {
    return {
      safe: false,
      behavior: 'ask',
      reason: 'Tilde expansion variants in paths require manual approval',
    }
  }
  if (GLOB.test(rawPath) && operation !== 'read') {
    return {
      safe: false,
      behavior: 'ask',
      reason: 'Glob patterns are not allowed in write operations',
    }
  }
  const absolutePath = expandPath(rawPath, options)
  const pathsToCheck = pathRepresentations(absolutePath)
  const rules = pathsToCheck.map(
    (path) => options.fileRule?.(operation, path) ?? null,
  )
  if (rules.includes('deny')) {
    return {
      safe: false,
      behavior: 'deny',
      reason: `Path '${absolutePath}' is denied by a file permission rule`,
      path: absolutePath,
      operation,
    }
  }
  if (
    dangerous &&
    pathsToCheck.some((path) => dangerousRemoval(path, options.homeDirectory))
  ) {
    return {
      safe: false,
      behavior: 'ask',
      reason: `Dangerous removal operation on critical path: ${absolutePath}`,
      path: absolutePath,
      operation,
      suggestions: [],
    }
  }
  if (
    operation !== 'read' &&
    pathsToCheck.some((path) => sensitivePath(path))
  ) {
    return {
      safe: false,
      behavior: 'ask',
      reason: `Write to sensitive file '${absolutePath}' requires explicit approval`,
      path: absolutePath,
      operation,
    }
  }
  if (rules.length > 0 && rules.every((rule) => rule === 'allow')) {
    return { safe: true }
  }
  const roots = operation === 'read' ? options.readRoots : options.writeRoots
  const inRoot = insideRoots(absolutePath, roots)
  if (
    inRoot &&
    (operation === 'read' || options.permissionMode === 'acceptEdits')
  ) {
    return { safe: true }
  }
  return {
    safe: false,
    behavior: 'ask',
    reason:
      operation === 'read'
        ? `Path '${absolutePath}' is outside allowed working directories`
        : `Write to '${absolutePath}' requires explicit approval`,
    path: absolutePath,
    operation,
  }
}

function outputRedirect(
  redirect: BashStaticRedirect,
): redirect is BashStaticRedirect & {
  operator: '>' | '>>' | '>|' | '&>' | '&>>' | '>&'
} {
  return ['>', '>>', '>|', '&>', '&>>', '>&'].includes(redirect.operator)
}

export function validateBashPathSafety(
  source: string,
  options: BashPathSafetyOptions,
): BashPathSafetyResult {
  const analysis = analyzeBashStructure(source)
  if (!analysis.parsed) {
    return { safe: false, behavior: 'ask', reason: analysis.reason }
  }
  const normalized = analysis.commands.map((command) => ({
    ...command,
    wrapper: normalizeBashWrapperArgv(command.argv),
  }))
  const hasCd = normalized.some(
    ({ wrapper }) => wrapper.ok && wrapper.argv[0] === 'cd',
  )
  if (
    hasCd &&
    normalized.filter(({ wrapper }) => wrapper.ok && wrapper.argv[0] === 'cd')
      .length > 1
  ) {
    return {
      safe: false,
      behavior: 'ask',
      reason: 'Multiple directory changes require explicit approval',
    }
  }

  for (const redirect of analysis.redirects) {
    if (!outputRedirect(redirect)) continue
    if (redirect.operator === '>&' && /^\d+$/u.test(redirect.target)) continue
    if (redirect.target === '/dev/null') continue
    if (hasCd) {
      return {
        safe: false,
        behavior: 'ask',
        reason:
          'Commands with directory changes and output redirection require explicit approval',
      }
    }
    const result = pathFailure(redirect.target, 'create', options)
    if (!result.safe) return result
  }

  for (const { wrapper } of normalized) {
    if (!wrapper.ok) {
      return { safe: false, behavior: 'ask', reason: wrapper.reason }
    }
    const [base, ...args] = wrapper.argv
    if (!base || !PATH_COMMANDS.has(base as PathCommand)) continue
    const command = base as PathCommand
    if (
      (command === 'mv' || command === 'cp') &&
      args.some((arg) => arg.startsWith('-'))
    ) {
      return {
        safe: false,
        behavior: 'ask',
        reason: `${command} command with flags requires manual approval`,
      }
    }
    const operation =
      command === 'sed' &&
      /^sed\s+(?:-[nErz]+\s+)*['"]?(?:\d+|\d+,\d+)?p/u.test(
        wrapper.argv.join(' '),
      )
        ? 'read'
        : OPERATIONS[command]
    if (hasCd && operation !== 'read') {
      return {
        safe: false,
        behavior: 'ask',
        reason:
          'Commands with directory changes and write operations require explicit approval',
      }
    }
    for (const path of commandPaths(command, args)) {
      const result = pathFailure(
        path,
        operation,
        options,
        command === 'rm' || command === 'rmdir',
      )
      if (!result.safe) return result
    }
  }
  return { safe: true }
}
