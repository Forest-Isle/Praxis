import { homedir } from 'node:os'
import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type {
  ModelToolCall,
  ModelToolDefinition,
  PermissionMode,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
  ToolSchedulingPolicy,
} from '../core/runtime.js'
import {
  analyzeBashStructure,
  normalizeBashWrapperArgv,
} from '../permissions/bash-ast.js'
import { validateBashPathSafety } from '../permissions/bash-path-safety.js'
import { shellInputIsReadOnly } from '../permissions/permission-updates.js'
import { isPathWithin } from '../platform/path-containment.js'

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash'])
const WRITE_TOOLS = new Set([...READ_ONLY_TOOLS, 'Write', 'Edit'])
const SAFE_GIT_COMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'grep',
  'blame',
])
const FORBIDDEN_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'shred'])
const PRIVILEGE_WRAPPERS = new Set([
  'sudo',
  'su',
  'doas',
  'pkexec',
  'runuser',
  'setpriv',
])
const DYNAMIC_COMMANDS = new Set(['eval', 'source', '.', 'xargs'])
const INLINE_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'python',
  'python3',
  'perl',
  'ruby',
  'node',
  'deno',
  'php',
  'pwsh',
  'powershell',
])

export interface TeamMemberToolRegistryOptions {
  readonly base: ToolRegistry
  readonly access: 'read-only' | 'write'
  readonly cwd: string
}

function deny(message: string): never {
  throw new Error(`Team tool denied: ${message}`)
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path)
    throw error
  }
}

async function canonicalTarget(root: string, value: unknown): Promise<string> {
  if (typeof value !== 'string' || value.trim() === '') deny('path is required')
  const candidate = resolve(root, value)
  try {
    return await realpath(candidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let parent = dirname(candidate)
  while (parent !== dirname(parent)) {
    try {
      const parentCanonical = await realpath(parent)
      return resolve(parentCanonical, candidate.slice(parent.length + 1))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      parent = dirname(parent)
    }
  }
  return resolve(candidate)
}

function within(root: string, candidate: string): boolean {
  return isPathWithin(root, candidate)
}

function toolInputPaths(call: ModelToolCall): readonly unknown[] {
  if (call.name === 'Read' || call.name === 'Write' || call.name === 'Edit')
    return [call.input.file_path]
  if (call.name === 'Glob' || call.name === 'Grep')
    return call.input.path === undefined ? [] : [call.input.path]
  return []
}

export class TeamMemberToolRegistry implements ToolRegistry {
  private readonly allowed: ReadonlySet<string>
  private readonly canonicalCwdPromise: Promise<string>

  constructor(private readonly options: TeamMemberToolRegistryOptions) {
    this.allowed =
      options.access === 'read-only' ? READ_ONLY_TOOLS : WRITE_TOOLS
    this.canonicalCwdPromise = canonical(options.cwd)
  }

  definitions(): readonly ModelToolDefinition[] {
    return this.options.base
      .definitions()
      .filter((definition) => this.allowed.has(definition.name))
  }

  schedulingPolicy(call: ModelToolCall): ToolSchedulingPolicy {
    this.validateCallShape(call)
    const policy = this.options.base.schedulingPolicy?.(call)
    return policy ?? { concurrency: 'concurrent' }
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    await this.validate(call, context)
    const prepared = await this.options.base.prepare(call, {
      ...context,
      cwd: await this.canonicalCwdPromise,
    })
    await this.validate(prepared, {
      ...context,
      cwd: await this.canonicalCwdPromise,
    })
    return prepared
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    await this.validate(call, context)
    return this.options.base.execute(call, {
      ...context,
      cwd: await this.canonicalCwdPromise,
    })
  }

  private validateCallShape(call: ModelToolCall): void {
    if (!call || typeof call.name !== 'string' || !this.allowed.has(call.name))
      deny(`tool '${call?.name ?? ''}' is unavailable to this member`)
    if (
      !call.input ||
      typeof call.input !== 'object' ||
      Array.isArray(call.input)
    )
      deny('tool input must be an object')
  }

  private async validate(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<void> {
    this.validateCallShape(call)
    const root = await this.canonicalCwdPromise
    if ((await canonical(context.cwd)) !== root)
      deny('execution cwd is outside the assigned workspace')
    for (const value of toolInputPaths(call)) {
      const target = await canonicalTarget(root, value)
      if (!within(root, target)) deny('path is outside the assigned workspace')
    }
    if (call.name !== 'Bash') return
    if (typeof call.input.command !== 'string')
      deny('Bash command must be a string')
    if (call.input.dangerouslyDisableSandbox === true)
      deny('dangerouslyDisableSandbox is not allowed')
    const command = call.input.command
    if (this.options.access === 'read-only') {
      if (!shellInputIsReadOnly(command))
        deny('read-only members may only run read-only Bash')
      const safety = validateBashPathSafety(command, {
        cwd: root,
        homeDirectory: homedir(),
        readRoots: [root],
        writeRoots: [root],
        permissionMode: 'acceptEdits' satisfies PermissionMode,
      })
      if (!safety.safe) deny(safety.reason)
      return
    }
    const analysis = analyzeBashStructure(command)
    if (!analysis.parsed) deny(analysis.reason)
    for (const entry of analysis.commands) {
      const normalized = normalizeBashWrapperArgv(entry.argv)
      if (!normalized.ok) deny(normalized.reason)
      this.validateNormalizedCommand(normalized.argv)
    }
    const safety = validateBashPathSafety(command, {
      cwd: root,
      homeDirectory: homedir(),
      readRoots: [root],
      writeRoots: [root],
      permissionMode: 'acceptEdits' satisfies PermissionMode,
    })
    if (!safety.safe) deny(safety.reason)
  }

  private validateNormalizedCommand(argv: readonly string[]): void {
    let normalized = [...argv]
    if (normalized[0] === 'command') {
      let index = 1
      if (normalized[index] === '--') index += 1
      if (normalized[index] === '-v' || normalized[index] === '-V') return
      if ((normalized[index] ?? '').startsWith('-'))
        deny('command wrapper cannot be statically resolved')
      normalized = normalized.slice(index)
    }
    if (normalized[0] === 'env')
      deny('env wrapper has no statically resolvable command')
    const command = normalized[0]
    if (!command) deny('empty Bash command')
    const base =
      command === 'git' ? command : (command.split('/').pop() ?? command)
    if (PRIVILEGE_WRAPPERS.has(base) || DYNAMIC_COMMANDS.has(base))
      deny(`command wrapper '${base}' is unavailable`)
    if (
      base === 'find' &&
      argv.some((value) => /^-(?:exec|execdir|delete)$/u.test(value))
    )
      deny('find execution and deletion flags are unavailable')
    if (INLINE_INTERPRETERS.has(base) && this.hasInlineInterpreter(argv))
      deny(`inline interpreter '${base}' is unavailable`)
    if (FORBIDDEN_COMMANDS.has(base))
      deny(`destructive command '${base}' is unavailable`)
    if (base === 'git') {
      const subcommand = gitSubcommand(normalized)
      if (!subcommand || !SAFE_GIT_COMMANDS.has(subcommand))
        deny(`git operation '${subcommand ?? ''}' is unavailable`)
    }
  }

  private hasInlineInterpreter(argv: readonly string[]): boolean {
    return argv.some((value, index) => {
      if (index === 0) return false
      return [
        '-c',
        '-e',
        '--eval',
        '--execute',
        '-Command',
        '-EncodedCommand',
      ].includes(value)
    })
  }
}

function gitSubcommand(argv: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index] ?? ''
    if (value === '--') return argv[index + 1]
    if (value === '-C' || value === '-c' || value === '--config-env') {
      index += 1
      continue
    }
    if (
      value.startsWith('--git-dir=') ||
      value.startsWith('--work-tree=') ||
      value.startsWith('--namespace=')
    )
      continue
    if (value.startsWith('-')) continue
    return value
  }
  return undefined
}
