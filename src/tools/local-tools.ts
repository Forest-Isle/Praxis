import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import { commandShell } from '../platform/command-shell.js'

export interface LocalToolRegistryOptions {
  cwd: string
  sharedMemoryDirectory?: string
  maxOutputBytes?: number
  maxFileBytes?: number
  maxShellTimeoutMs?: number
}

interface ProcessResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
  truncated: boolean
}

const TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    name: 'Read',
    description: 'Read a UTF-8 text file inside the active workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1 },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'Write',
    description: 'Write a UTF-8 text file inside the active workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'Edit',
    description: 'Replace exact text in a file inside the active workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
  },
  {
    name: 'Grep',
    description: 'Search text with ripgrep inside the active workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'Bash',
    description: 'Run a shell command in the active workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer', minimum: 1 },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
]

function stringInput(
  input: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string {
  const value = input[name]
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be a${allowEmpty ? '' : ' non-empty'} string`)
  }
  return value
}

function optionalString(
  input: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function optionalPositiveInteger(
  input: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
  )
}

function truncateOutput(content: string, maxBytes: number): string {
  const encoded = Buffer.from(content)
  if (encoded.length <= maxBytes) return content
  return `${encoded.subarray(0, maxBytes).toString('utf8')}\n[output truncated]`
}

function joinedOutput(result: ProcessResult): string {
  if (!result.stdout) return result.stderr
  if (!result.stderr) return result.stdout
  return `${result.stdout}${result.stdout.endsWith('\n') ? '' : '\n'}${result.stderr}`
}

function abortError(): DOMException {
  return new DOMException('Tool execution aborted', 'AbortError')
}

export class LocalToolRegistry implements ToolRegistry {
  private readonly cwd: string
  private readonly sharedMemoryDirectory: string | undefined
  private readonly maxOutputBytes: number
  private readonly maxFileBytes: number
  private readonly maxShellTimeoutMs: number

  constructor(options: LocalToolRegistryOptions) {
    this.cwd = resolve(options.cwd)
    this.sharedMemoryDirectory = options.sharedMemoryDirectory
      ? resolve(options.sharedMemoryDirectory)
      : undefined
    this.maxOutputBytes = options.maxOutputBytes ?? 128 * 1024
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024
    this.maxShellTimeoutMs = options.maxShellTimeoutMs ?? 120_000
  }

  definitions(): readonly ModelToolDefinition[] {
    if (!this.sharedMemoryDirectory) return TOOL_DEFINITIONS
    return TOOL_DEFINITIONS.map((definition) =>
      ['Read', 'Write', 'Edit'].includes(definition.name)
        ? {
            ...definition,
            description: `${definition.description} Shared auto-memory files under ${this.sharedMemoryDirectory} are also allowed.`,
          }
        : definition,
    )
  }

  async prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    if (context.signal?.aborted) throw abortError()
    switch (call.name) {
      case 'Read':
        return {
          ...call,
          input: {
            file_path: await this.filePath(
              stringInput(call.input, 'file_path'),
              false,
            ),
            ...(optionalPositiveInteger(call.input, 'offset') === undefined
              ? {}
              : { offset: optionalPositiveInteger(call.input, 'offset') }),
            ...(optionalPositiveInteger(call.input, 'limit') === undefined
              ? {}
              : { limit: optionalPositiveInteger(call.input, 'limit') }),
          },
        }
      case 'Write':
        return {
          ...call,
          input: {
            file_path: await this.filePath(
              stringInput(call.input, 'file_path'),
              true,
            ),
            content: stringInput(call.input, 'content', true),
          },
        }
      case 'Edit': {
        const replaceAll = call.input.replace_all
        if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
          throw new Error('replace_all must be a boolean')
        }
        return {
          ...call,
          input: {
            file_path: await this.filePath(
              stringInput(call.input, 'file_path'),
              false,
            ),
            old_string: stringInput(call.input, 'old_string'),
            new_string: stringInput(call.input, 'new_string', true),
            replace_all: replaceAll ?? false,
          },
        }
      }
      case 'Grep': {
        const glob = optionalString(call.input, 'glob')
        return {
          ...call,
          input: {
            pattern: stringInput(call.input, 'pattern'),
            path: await this.workspacePath(
              optionalString(call.input, 'path') ?? '.',
              false,
            ),
            ...(glob === undefined ? {} : { glob }),
          },
        }
      }
      case 'Bash': {
        const requestedTimeout = optionalPositiveInteger(call.input, 'timeout')
        return {
          ...call,
          input: {
            command: stringInput(call.input, 'command'),
            timeout: Math.min(
              requestedTimeout ?? this.maxShellTimeoutMs,
              this.maxShellTimeoutMs,
            ),
          },
        }
      }
      default:
        throw new Error(`Unknown tool ${call.name}`)
    }
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (context.signal?.aborted) throw abortError()
    const prepared = await this.prepare(call, context)
    if (JSON.stringify(prepared.input) !== JSON.stringify(call.input)) {
      throw new Error('Tool input changed after permission approval')
    }
    switch (prepared.name) {
      case 'Read':
        return this.read(prepared)
      case 'Write':
        return this.write(prepared)
      case 'Edit':
        return this.edit(prepared)
      case 'Grep':
        return this.grep(prepared, context.signal)
      case 'Bash':
        return this.bash(prepared, context.signal)
      default:
        throw new Error(`Unknown tool ${prepared.name}`)
    }
  }

  private async workspacePath(
    requestedPath: string,
    allowMissing: boolean,
  ): Promise<string> {
    return this.resolvePath(requestedPath, allowMissing, false)
  }

  private async filePath(
    requestedPath: string,
    allowMissing: boolean,
  ): Promise<string> {
    return this.resolvePath(requestedPath, allowMissing, true)
  }

  private async resolvePath(
    requestedPath: string,
    allowMissing: boolean,
    includeSharedMemory: boolean,
  ): Promise<string> {
    const workspaceRoot = await realpath(this.cwd)
    const roots =
      includeSharedMemory && this.sharedMemoryDirectory
        ? [workspaceRoot, await realpath(this.sharedMemoryDirectory)]
        : [workspaceRoot]
    const candidate = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(workspaceRoot, requestedPath)

    try {
      const canonical = await realpath(candidate)
      if (!roots.some((root) => isWithin(root, canonical))) {
        throw new Error(`Path is outside workspace: ${requestedPath}`)
      }
      return canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) {
        throw error
      }
      const parent = await realpath(dirname(candidate))
      if (!roots.some((root) => isWithin(root, parent))) {
        throw new Error(`Path is outside workspace: ${requestedPath}`)
      }
      return join(parent, basename(candidate))
    }
  }

  private async assertStablePath(filePath: string): Promise<void> {
    if ((await realpath(filePath)) !== filePath) {
      throw new Error('Tool input changed after permission approval')
    }
  }

  private async read(call: ModelToolCall): Promise<ToolExecutionResult> {
    const filePath = stringInput(call.input, 'file_path')
    const handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    )
    try {
      await this.assertStablePath(filePath)
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new Error(`Not a file: ${filePath}`)
      if (metadata.size > this.maxFileBytes) {
        throw new Error(`File exceeds ${this.maxFileBytes} byte read limit`)
      }
      const source = await handle.readFile('utf8')
      const offset = optionalPositiveInteger(call.input, 'offset') ?? 1
      const limit = optionalPositiveInteger(call.input, 'limit')
      const lines = source.split('\n')
      const content = lines
        .slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit)
        .join('\n')
      return {
        content: truncateOutput(content, this.maxOutputBytes),
        isError: false,
        accessedPaths: [filePath],
      }
    } finally {
      await handle.close()
    }
  }

  private async write(call: ModelToolCall): Promise<ToolExecutionResult> {
    const filePath = stringInput(call.input, 'file_path')
    const content = stringInput(call.input, 'content', true)
    if (Buffer.byteLength(content) > this.maxFileBytes) {
      throw new Error(`Content exceeds ${this.maxFileBytes} byte write limit`)
    }
    const handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o666,
    )
    try {
      await this.assertStablePath(filePath)
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new Error(`Not a file: ${filePath}`)
      const encoded = Buffer.from(content)
      await handle.write(encoded, 0, encoded.length, 0)
      await handle.truncate(encoded.length)
      await handle.sync()
      return {
        content: `Wrote ${encoded.length} bytes`,
        isError: false,
      }
    } finally {
      await handle.close()
    }
  }

  private async edit(call: ModelToolCall): Promise<ToolExecutionResult> {
    const filePath = stringInput(call.input, 'file_path')
    const oldString = stringInput(call.input, 'old_string')
    const newString = stringInput(call.input, 'new_string', true)
    const handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      await this.assertStablePath(filePath)
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new Error(`Not a file: ${filePath}`)
      if (metadata.size > this.maxFileBytes) {
        throw new Error(`File exceeds ${this.maxFileBytes} byte edit limit`)
      }
      const source = await handle.readFile('utf8')
      const occurrences = source.split(oldString).length - 1
      if (occurrences === 0) throw new Error('old_string was not found')
      if (call.input.replace_all !== true && occurrences !== 1) {
        throw new Error(
          `old_string matched ${occurrences} times; set replace_all`,
        )
      }
      const replacementCount = call.input.replace_all === true ? occurrences : 1
      const outputBytes =
        Buffer.byteLength(source) +
        replacementCount *
          (Buffer.byteLength(newString) - Buffer.byteLength(oldString))
      if (outputBytes > this.maxFileBytes) {
        throw new Error(`Edited content exceeds ${this.maxFileBytes} bytes`)
      }
      const output =
        call.input.replace_all === true
          ? source.replaceAll(oldString, newString)
          : source.replace(oldString, newString)
      const encoded = Buffer.from(output)
      await handle.write(encoded, 0, encoded.length, 0)
      await handle.truncate(encoded.length)
      await handle.sync()
      return {
        content: `Replaced ${replacementCount} occurrence(s)`,
        isError: false,
      }
    } finally {
      await handle.close()
    }
  }

  private async grep(
    call: ModelToolCall,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const workspaceRoot = await realpath(this.cwd)
    const searchPath = stringInput(call.input, 'path')
    const relativeSearchPath = relative(workspaceRoot, searchPath) || '.'
    const args = [
      '--line-number',
      '--with-filename',
      '--color=never',
      '--',
      stringInput(call.input, 'pattern'),
      relativeSearchPath,
    ]
    const glob = optionalString(call.input, 'glob')
    if (glob) args.splice(3, 0, '--glob', glob)
    const result = await this.runProcess(
      'rg',
      args,
      this.maxShellTimeoutMs,
      signal,
    )
    if (result.timedOut) {
      return {
        content: `Search timed out after ${this.maxShellTimeoutMs}ms`,
        isError: true,
      }
    }
    const content = joinedOutput(result)
    if (result.code === 0 || result.code === 1) {
      return { content, isError: false }
    }
    return {
      content: content || `Search exited with code ${result.code}`,
      isError: true,
    }
  }

  private async bash(
    call: ModelToolCall,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const timeout = optionalPositiveInteger(call.input, 'timeout')
    if (timeout === undefined)
      throw new Error('Prepared Bash call has no timeout')
    const result = await this.runProcess(
      commandShell(),
      ['-lc', stringInput(call.input, 'command')],
      timeout,
      signal,
    )
    if (result.timedOut) {
      return {
        content: `Command timed out after ${timeout}ms`,
        isError: true,
      }
    }
    const content = joinedOutput(result)
    return {
      content:
        content ||
        (result.code === 0 ? '' : `Command exited with code ${result.code}`),
      isError: result.code !== 0,
    }
  }

  private runProcess(
    command: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    if (signal?.aborted) return Promise.reject(abortError())

    return new Promise((resolveProcess, reject) => {
      const child = spawn(command, args, {
        cwd: this.cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
      let retainedBytes = 0
      let truncated = false
      let timedOut = false

      const retain = (stream: keyof typeof chunks, chunk: Buffer) => {
        const remaining = this.maxOutputBytes - retainedBytes
        if (remaining <= 0) {
          truncated = true
          return
        }
        const retained = chunk.subarray(0, remaining)
        chunks[stream].push(retained)
        retainedBytes += retained.length
        if (retained.length < chunk.length) truncated = true
      }
      child.stdout.on('data', (chunk: Buffer) => retain('stdout', chunk))
      child.stderr.on('data', (chunk: Buffer) => retain('stderr', chunk))

      const kill = () => {
        if (child.pid === undefined) return
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') reject(error)
        }
      }
      const cancel = () => kill()
      signal?.addEventListener('abort', cancel, { once: true })
      const timeout = setTimeout(() => {
        timedOut = true
        kill()
      }, timeoutMs)

      child.once('error', (error) => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', cancel)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        signal?.removeEventListener('abort', cancel)
        if (signal?.aborted) {
          reject(abortError())
          return
        }
        const suffix = truncated ? '\n[output truncated]' : ''
        resolveProcess({
          stdout: `${Buffer.concat(chunks.stdout).toString('utf8')}${suffix}`,
          stderr: Buffer.concat(chunks.stderr).toString('utf8'),
          code: code ?? 1,
          timedOut,
          truncated,
        })
      })
    })
  }
}
