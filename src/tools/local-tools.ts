import { spawn } from 'node:child_process'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'

export interface LocalToolRegistryOptions {
  cwd: string
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
  private readonly maxOutputBytes: number
  private readonly maxFileBytes: number
  private readonly maxShellTimeoutMs: number

  constructor(options: LocalToolRegistryOptions) {
    this.cwd = resolve(options.cwd)
    this.maxOutputBytes = options.maxOutputBytes ?? 128 * 1024
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024
    this.maxShellTimeoutMs = options.maxShellTimeoutMs ?? 120_000
  }

  definitions(): readonly ModelToolDefinition[] {
    return TOOL_DEFINITIONS
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
            file_path: await this.workspacePath(
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
            file_path: await this.workspacePath(
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
            file_path: await this.workspacePath(
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
    const root = await realpath(this.cwd)
    const candidate = resolve(root, requestedPath)
    if (!isWithin(root, candidate)) {
      throw new Error(`Path is outside workspace: ${requestedPath}`)
    }

    try {
      const canonical = await realpath(candidate)
      if (!isWithin(root, canonical)) {
        throw new Error(`Path is outside workspace: ${requestedPath}`)
      }
      return canonical
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowMissing) {
        throw error
      }
      const separator = candidate.lastIndexOf('/')
      const parent = await realpath(candidate.slice(0, separator))
      if (!isWithin(root, parent)) {
        throw new Error(`Path is outside workspace: ${requestedPath}`)
      }
      return candidate
    }
  }

  private async read(call: ModelToolCall): Promise<ToolExecutionResult> {
    const filePath = stringInput(call.input, 'file_path')
    const metadata = await stat(filePath)
    if (!metadata.isFile()) throw new Error(`Not a file: ${filePath}`)
    if (metadata.size > this.maxFileBytes) {
      throw new Error(`File exceeds ${this.maxFileBytes} byte read limit`)
    }
    const source = await readFile(filePath, 'utf8')
    const offset = optionalPositiveInteger(call.input, 'offset') ?? 1
    const limit = optionalPositiveInteger(call.input, 'limit')
    const lines = source.split('\n')
    const content = lines
      .slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit)
      .join('\n')
    return {
      content: truncateOutput(content, this.maxOutputBytes),
      isError: false,
    }
  }

  private async write(call: ModelToolCall): Promise<ToolExecutionResult> {
    const filePath = stringInput(call.input, 'file_path')
    const content = stringInput(call.input, 'content', true)
    if (Buffer.byteLength(content) > this.maxFileBytes) {
      throw new Error(`Content exceeds ${this.maxFileBytes} byte write limit`)
    }
    await writeFile(filePath, content)
    return {
      content: `Wrote ${Buffer.byteLength(content)} bytes`,
      isError: false,
    }
  }

  private async edit(call: ModelToolCall): Promise<ToolExecutionResult> {
    const filePath = stringInput(call.input, 'file_path')
    const oldString = stringInput(call.input, 'old_string')
    const newString = stringInput(call.input, 'new_string', true)
    const source = await readFile(filePath, 'utf8')
    if (Buffer.byteLength(source) > this.maxFileBytes) {
      throw new Error(`File exceeds ${this.maxFileBytes} byte edit limit`)
    }
    const occurrences = source.split(oldString).length - 1
    if (occurrences === 0) throw new Error('old_string was not found')
    if (call.input.replace_all !== true && occurrences !== 1) {
      throw new Error(
        `old_string matched ${occurrences} times; set replace_all`,
      )
    }
    const output =
      call.input.replace_all === true
        ? source.replaceAll(oldString, newString)
        : source.replace(oldString, newString)
    await writeFile(filePath, output)
    return {
      content: `Replaced ${call.input.replace_all === true ? occurrences : 1} occurrence(s)`,
      isError: false,
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
      '/bin/zsh',
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
