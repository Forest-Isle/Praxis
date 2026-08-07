import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'

import type {
  ModelImageMediaType,
  ModelMessage,
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import {
  commandShell,
  commandShellArguments,
} from '../platform/command-shell.js'
import {
  BoundedProcessRunner,
  joinedProcessOutput,
} from '../platform/bounded-process-runner.js'
import { globFiles } from './glob.js'
import { editNotebook, formatNotebookForRead } from './notebook.js'

export interface LocalToolRegistryOptions {
  cwd: string
  cwdProvider?: () => string
  sharedMemoryDirectory?: string
  additionalDirectories?: readonly string[]
  additionalReadDirectories?: readonly string[]
  maxOutputBytes?: number
  maxFileBytes?: number
  maxShellTimeoutMs?: number
  enableReportFindings?: boolean
}

const REPORT_FINDINGS_DEFINITION: ModelToolDefinition = {
  name: 'ReportFindings',
  description:
    "Report code-review findings as a typed list so the host UI can render them. Use this only when the active code-review instructions tell you to report findings with this tool; otherwise follow whatever output format those instructions specify. When reporting a review's results, call it once with the verified findings ranked most-severe first (empty array if nothing survived verification) and do not also print the findings as text. When re-reporting after applying fixes (only if the apply instructions ask for it), set outcome on each finding to what actually happened.",
  inputSchema: {
    type: 'object',
    properties: {
      level: {
        description: 'Effort level the review ran at',
        type: 'string',
        enum: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      findings: {
        description:
          'Verified findings, most-severe first; empty if none survived',
        maxItems: 32,
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: {
              description: 'Repo-relative path of the file the finding is in',
              type: 'string',
            },
            line: {
              description: '1-indexed line the finding anchors to',
              type: 'integer',
              minimum: Number.MIN_SAFE_INTEGER,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            summary: {
              description: 'One-sentence statement of the defect',
              type: 'string',
            },
            failure_scenario: {
              description: 'Concrete inputs/state → wrong output/crash',
              type: 'string',
            },
            category: {
              description:
                'Short kebab-case slug of the finding type, e.g. "correctness", "simplification", "efficiency", "test-coverage"',
              type: 'string',
              maxLength: 40,
            },
            verdict: {
              description:
                'Set when a verify pass ran; absent on inline-only reviews',
              type: 'string',
              enum: ['CONFIRMED', 'PLAUSIBLE'],
            },
            outcome: {
              description:
                'Set ONLY when re-reporting after applying fixes: what happened to this finding',
              type: 'string',
              enum: ['fixed', 'skipped', 'no_change_needed'],
            },
          },
          required: ['file', 'summary', 'failure_scenario'],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
    $schema: 'https://json-schema.org/draft/2020-12/schema',
  },
}

const TOOL_DEFINITIONS: readonly ModelToolDefinition[] = [
  {
    name: 'Read',
    description:
      'Read a UTF-8 text file or supported PNG, JPEG, GIF, or WebP image inside the active workspace.',
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
    name: 'NotebookEdit',
    description:
      'Replace, insert, or delete one cell in a Jupyter notebook after reading it.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_path: { type: 'string' },
        cell_id: { type: 'string' },
        new_source: { type: 'string' },
        cell_type: { type: 'string', enum: ['code', 'markdown'] },
        edit_mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
        },
      },
      required: ['notebook_path', 'new_source'],
      additionalProperties: false,
    },
  },
  {
    name: 'Glob',
    description:
      '- Fast file pattern matching tool that works with any codebase size\n- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The glob pattern to match files against',
        },
        path: {
          type: 'string',
          description:
            'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
        },
      },
      required: ['pattern'],
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const REPORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const REPORT_VERDICTS = ['CONFIRMED', 'PLAUSIBLE'] as const
const REPORT_OUTCOMES = ['fixed', 'skipped', 'no_change_needed'] as const

function reportFindingsInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(input)) {
    if (key !== 'level' && key !== 'findings') {
      throw new Error(`Unknown ReportFindings input field ${key}`)
    }
  }
  const level = input.level
  if (
    level !== undefined &&
    (typeof level !== 'string' || !REPORT_LEVELS.includes(level as never))
  ) {
    throw new Error('level must be one of low, medium, high, xhigh, max')
  }
  const findings = input.findings
  if (!Array.isArray(findings)) {
    throw new Error('findings must be an array')
  }
  if (findings.length > 32)
    throw new Error('findings must contain at most 32 items')
  const normalized = findings.map((finding, index) => {
    if (!isRecord(finding))
      throw new Error(`finding ${index} must be an object`)
    const allowed = new Set([
      'file',
      'line',
      'summary',
      'failure_scenario',
      'category',
      'verdict',
      'outcome',
    ])
    for (const key of Object.keys(finding)) {
      if (!allowed.has(key)) {
        throw new Error(`Unknown ReportFindings finding field ${key}`)
      }
    }
    for (const key of ['file', 'summary', 'failure_scenario'] as const) {
      if (typeof finding[key] !== 'string') {
        throw new Error(`finding ${index}.${key} must be a string`)
      }
    }
    if (
      finding.line !== undefined &&
      (!Number.isSafeInteger(finding.line) || typeof finding.line !== 'number')
    ) {
      throw new Error(`finding ${index}.line must be an integer`)
    }
    if (
      finding.category !== undefined &&
      (typeof finding.category !== 'string' ||
        [...finding.category].length > 40)
    ) {
      throw new Error(`finding ${index}.category must be at most 40 characters`)
    }
    if (
      finding.verdict !== undefined &&
      (typeof finding.verdict !== 'string' ||
        !REPORT_VERDICTS.includes(finding.verdict as never))
    ) {
      throw new Error(`finding ${index}.verdict is invalid`)
    }
    if (
      finding.outcome !== undefined &&
      (typeof finding.outcome !== 'string' ||
        !REPORT_OUTCOMES.includes(finding.outcome as never))
    ) {
      throw new Error(`finding ${index}.outcome is invalid`)
    }
    return {
      file: finding.file,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      summary: finding.summary,
      failure_scenario: finding.failure_scenario,
      ...(finding.category === undefined ? {} : { category: finding.category }),
      ...(finding.verdict === undefined ? {} : { verdict: finding.verdict }),
      ...(finding.outcome === undefined ? {} : { outcome: finding.outcome }),
    }
  })
  return {
    ...(level === undefined ? {} : { level }),
    findings: normalized,
  }
}

function isWithin(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
  )
}

function takeUtf8Prefix(
  content: string,
  maxBytes: number,
): { content: string; bytes: number; truncated: boolean } {
  const encodedBytes = Buffer.byteLength(content)
  if (encodedBytes <= maxBytes) {
    return { content, bytes: encodedBytes, truncated: false }
  }
  let prefix = ''
  let bytes = 0
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return { content: prefix, bytes, truncated: true }
}

function truncateOutput(content: string, maxBytes: number): string {
  const retained = takeUtf8Prefix(content, maxBytes)
  return retained.truncated
    ? `${retained.content}\n[output truncated]`
    : retained.content
}

function abortError(): DOMException {
  return new DOMException('Tool execution aborted', 'AbortError')
}

function imageMediaType(content: Buffer): ModelImageMediaType | null {
  if (
    content.length >= 8 &&
    content
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png'
  }
  if (
    content.length >= 3 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff
  ) {
    return 'image/jpeg'
  }
  const header = content.subarray(0, 6).toString('ascii')
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif'
  if (
    content.length >= 12 &&
    content.subarray(0, 4).toString('ascii') === 'RIFF' &&
    content.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

export class LocalToolRegistry implements ToolRegistry {
  private readonly cwd: string
  private readonly cwdProvider: (() => string) | undefined
  private readonly sharedMemoryDirectory: string | undefined
  private readonly additionalDirectories: readonly string[]
  private readonly additionalReadDirectories: readonly string[]
  private readonly maxOutputBytes: number
  private readonly maxFileBytes: number
  private readonly maxShellTimeoutMs: number
  private readonly processRunner: BoundedProcessRunner
  private readonly enableReportFindings: boolean

  constructor(options: LocalToolRegistryOptions) {
    this.cwd = resolve(options.cwd)
    this.cwdProvider = options.cwdProvider
    this.sharedMemoryDirectory = options.sharedMemoryDirectory
      ? resolve(options.sharedMemoryDirectory)
      : undefined
    this.additionalDirectories = (options.additionalDirectories ?? []).map(
      (directory) => resolve(directory),
    )
    this.additionalReadDirectories = (
      options.additionalReadDirectories ?? []
    ).map((directory) => resolve(directory))
    this.maxOutputBytes = options.maxOutputBytes ?? 128 * 1024
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024
    this.maxShellTimeoutMs = options.maxShellTimeoutMs ?? 120_000
    this.enableReportFindings = options.enableReportFindings ?? false
    this.processRunner = new BoundedProcessRunner({
      cwd: this.cwd,
      maxOutputBytes: this.maxOutputBytes,
    })
  }

  private currentCwd(context?: ToolExecutionContext): string {
    return resolve(context?.cwd || this.cwdProvider?.() || this.cwd)
  }

  definitions(): readonly ModelToolDefinition[] {
    const definitions = this.enableReportFindings
      ? [...TOOL_DEFINITIONS, REPORT_FINDINGS_DEFINITION]
      : TOOL_DEFINITIONS
    if (
      !this.sharedMemoryDirectory &&
      this.additionalDirectories.length === 0 &&
      this.additionalReadDirectories.length === 0
    ) {
      return definitions
    }
    return definitions.map((definition) =>
      ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'].includes(
        definition.name,
      )
        ? {
            ...definition,
            description: `${definition.description}${
              this.additionalDirectories.length === 0
                ? ''
                : ` Additional allowed directories: ${this.additionalDirectories.join(', ')}.`
            }${
              definition.name !== 'Read' ||
              this.additionalReadDirectories.length === 0
                ? ''
                : ` Additional read-only directories: ${this.additionalReadDirectories.join(', ')}.`
            }${
              !this.sharedMemoryDirectory ||
              definition.name === 'Glob' ||
              definition.name === 'Grep'
                ? ''
                : ` Shared auto-memory files under ${this.sharedMemoryDirectory} are also allowed.`
            }`,
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
              true,
              context,
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
              false,
              context,
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
              false,
              context,
            ),
            old_string: stringInput(call.input, 'old_string'),
            new_string: stringInput(call.input, 'new_string', true),
            replace_all: replaceAll ?? false,
          },
        }
      }
      case 'NotebookEdit': {
        const requestedPath = stringInput(call.input, 'notebook_path')
        if (!isAbsolute(requestedPath)) {
          throw new Error('notebook_path must be an absolute path')
        }
        const filePath = await this.filePath(
          requestedPath,
          false,
          false,
          context,
        )
        if (extname(filePath).toLowerCase() !== '.ipynb') {
          throw new Error('notebook_path must reference an .ipynb file')
        }
        if (
          !(await this.wasSuccessfullyRead(
            filePath,
            context.messages ?? [],
            context,
          ))
        ) {
          throw new Error(
            '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
          )
        }
        const cellId = optionalString(call.input, 'cell_id')
        const cellType = optionalString(call.input, 'cell_type')
        if (
          cellType !== undefined &&
          cellType !== 'code' &&
          cellType !== 'markdown'
        ) {
          throw new Error('cell_type must be code or markdown')
        }
        const editMode = optionalString(call.input, 'edit_mode') ?? 'replace'
        if (!['replace', 'insert', 'delete'].includes(editMode)) {
          throw new Error('edit_mode must be replace, insert, or delete')
        }
        if (editMode === 'insert' && cellType === undefined) {
          throw new Error('cell_type is required for insert')
        }
        if (editMode !== 'insert' && cellId === undefined) {
          throw new Error(`cell_id is required for ${editMode}`)
        }
        return {
          ...call,
          input: {
            notebook_path: filePath,
            ...(cellId === undefined ? {} : { cell_id: cellId }),
            new_source: stringInput(call.input, 'new_source', true),
            ...(cellType === undefined ? {} : { cell_type: cellType }),
            edit_mode: editMode,
          },
        }
      }
      case 'Glob': {
        const pathInput = call.input.path
        const requestedPath =
          pathInput === undefined ? '.' : stringInput(call.input, 'path')
        await this.globRoot(requestedPath, context)
        return {
          ...call,
          input: {
            pattern: stringInput(call.input, 'pattern', true),
            ...(pathInput === undefined ? {} : { path: requestedPath }),
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
              context,
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
      case 'ReportFindings':
        return { ...call, input: reportFindingsInput(call.input) }
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
      case 'NotebookEdit':
        return this.notebookEdit(prepared)
      case 'Glob':
        return this.glob(prepared, context)
      case 'Grep':
        return this.grep(prepared, context)
      case 'Bash':
        return this.bash(prepared, context)
      case 'ReportFindings':
        return {
          content: JSON.stringify({
            count: (prepared.input.findings as readonly unknown[]).length,
            ...(prepared.input.level === undefined
              ? {}
              : { level: prepared.input.level }),
            findings: prepared.input.findings,
          }),
          isError: false,
        }
      default:
        throw new Error(`Unknown tool ${prepared.name}`)
    }
  }

  private async workspacePath(
    requestedPath: string,
    allowMissing: boolean,
    context?: ToolExecutionContext,
  ): Promise<string> {
    return this.resolvePath(requestedPath, allowMissing, false, false, context)
  }

  private async filePath(
    requestedPath: string,
    allowMissing: boolean,
    includeReadOnly = false,
    context?: ToolExecutionContext,
  ): Promise<string> {
    return this.resolvePath(
      requestedPath,
      allowMissing,
      true,
      includeReadOnly,
      context,
    )
  }

  private async resolvePath(
    requestedPath: string,
    allowMissing: boolean,
    includeSharedMemory: boolean,
    includeReadOnly = false,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const workspaceRoot = await realpath(this.currentCwd(context))
    const workspaceRoots = [
      workspaceRoot,
      ...(await Promise.all(
        this.additionalDirectories.map((directory) => realpath(directory)),
      )),
    ]
    const writableRoots =
      includeSharedMemory && this.sharedMemoryDirectory
        ? [...workspaceRoots, await realpath(this.sharedMemoryDirectory)]
        : workspaceRoots
    const roots = includeReadOnly
      ? [
          ...writableRoots,
          ...(
            await Promise.all(
              this.additionalReadDirectories.map(async (directory) => {
                try {
                  return [await realpath(directory)]
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return []
                  }
                  throw error
                }
              }),
            )
          ).flat(),
        ]
      : writableRoots
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

  private async globRoot(
    requestedPath: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    const displayedPath = isAbsolute(requestedPath)
      ? resolve(requestedPath)
      : resolve(this.currentCwd(context), requestedPath)
    let root: string
    try {
      root = await this.workspacePath(requestedPath, false, context)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      throw new Error(
        `<tool_use_error>Directory does not exist: ${displayedPath}. Note: your current working directory is ${await realpath(this.currentCwd(context))}.</tool_use_error>`,
      )
    }
    if (!(await stat(root)).isDirectory()) {
      throw new Error(
        `<tool_use_error>Path is not a directory: ${displayedPath}</tool_use_error>`,
      )
    }
    return root
  }

  private async wasSuccessfullyRead(
    filePath: string,
    messages: readonly ModelMessage[],
    context?: ToolExecutionContext,
  ): Promise<boolean> {
    const successfulCalls = new Set(
      messages.flatMap((message) =>
        message.role === 'tool' && !message.isError ? [message.toolCallId] : [],
      ),
    )
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const call of message.toolCalls ?? []) {
        if (call.name !== 'Read' || !successfulCalls.has(call.id)) continue
        const requestedPath = call.input.file_path
        if (typeof requestedPath !== 'string') continue
        try {
          if (
            (await this.filePath(requestedPath, false, true, context)) ===
            filePath
          ) {
            return true
          }
        } catch {
          continue
        }
      }
    }
    return false
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
      const source = await handle.readFile()
      const requestedOffset = optionalPositiveInteger(call.input, 'offset')
      const offset = requestedOffset ?? 1
      const limit = optionalPositiveInteger(call.input, 'limit')
      const mediaType = imageMediaType(source)
      if (mediaType) {
        if (requestedOffset !== undefined || limit !== undefined) {
          throw new Error('offset and limit are not supported for images')
        }
        const base64 = source.toString('base64')
        return {
          content: '',
          images: [{ type: 'image', mediaType, data: base64 }],
          isError: false,
          accessedPaths: [filePath],
        }
      }
      const text = source.toString('utf8')
      const lines = (
        extname(filePath).toLowerCase() === '.ipynb'
          ? formatNotebookForRead(text)
          : text
      ).split('\n')
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

  private async notebookEdit(
    call: ModelToolCall,
  ): Promise<ToolExecutionResult> {
    const filePath = stringInput(call.input, 'notebook_path')
    const handle = await open(filePath, constants.O_RDWR | constants.O_NOFOLLOW)
    try {
      await this.assertStablePath(filePath)
      const metadata = await handle.stat()
      if (!metadata.isFile()) throw new Error(`Not a file: ${filePath}`)
      if (metadata.size > this.maxFileBytes) {
        throw new Error(`File exceeds ${this.maxFileBytes} byte edit limit`)
      }
      const result = editNotebook(await handle.readFile('utf8'), {
        ...(call.input.cell_id === undefined
          ? {}
          : { cellId: stringInput(call.input, 'cell_id') }),
        ...(call.input.cell_type === undefined
          ? {}
          : {
              cellType: stringInput(call.input, 'cell_type') as
                'code' | 'markdown',
            }),
        editMode: stringInput(call.input, 'edit_mode') as
          'replace' | 'insert' | 'delete',
        newSource: stringInput(call.input, 'new_source', true),
      })
      const encoded = Buffer.from(result.source)
      if (encoded.length > this.maxFileBytes) {
        throw new Error(`Content exceeds ${this.maxFileBytes} byte write limit`)
      }
      await handle.write(encoded, 0, encoded.length, 0)
      await handle.truncate(encoded.length)
      await handle.sync()
      return { content: result.content, isError: false }
    } finally {
      await handle.close()
    }
  }

  private async glob(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const requestedPath =
      call.input.path === undefined ? '.' : stringInput(call.input, 'path')
    const root = await this.globRoot(requestedPath, context)
    const timeoutSignal = AbortSignal.timeout(this.maxShellTimeoutMs)
    const searchSignal = context.signal
      ? AbortSignal.any([context.signal, timeoutSignal])
      : timeoutSignal
    try {
      const content = await globFiles({
        root,
        displayRoot: call.input.path === undefined ? '.' : requestedPath,
        absoluteRoot: isAbsolute(requestedPath)
          ? resolve(requestedPath)
          : resolve(this.currentCwd(context), requestedPath),
        pattern: stringInput(call.input, 'pattern', true),
        signal: searchSignal,
      })
      return {
        content: truncateOutput(content, this.maxOutputBytes),
        isError: false,
      }
    } catch (error) {
      if (context.signal?.aborted) throw abortError()
      if (timeoutSignal.aborted) {
        return {
          content: `Search timed out after ${this.maxShellTimeoutMs}ms`,
          isError: true,
        }
      }
      throw error
    }
  }

  private async grep(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const workspaceRoot = await realpath(this.currentCwd(context))
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
    const result = await this.processRunner.run({
      command: 'rg',
      args,
      timeoutMs: this.maxShellTimeoutMs,
      cwd: this.currentCwd(context),
      ...(context.signal ? { signal: context.signal } : {}),
    })
    if (result.timedOut) {
      return {
        content: `Search timed out after ${this.maxShellTimeoutMs}ms`,
        isError: true,
      }
    }
    const content = joinedProcessOutput(result)
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
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const timeout = optionalPositiveInteger(call.input, 'timeout')
    if (timeout === undefined)
      throw new Error('Prepared Bash call has no timeout')
    const result = await this.processRunner.run({
      command: commandShell(),
      args: commandShellArguments(stringInput(call.input, 'command')),
      timeoutMs: timeout,
      cwd: this.currentCwd(context),
      ...(context.signal ? { signal: context.signal } : {}),
    })
    if (result.timedOut) {
      return {
        content: `Command timed out after ${timeout}ms`,
        isError: true,
      }
    }
    const content = joinedProcessOutput(result)
    return {
      content:
        content ||
        (result.code === 0 ? '' : `Command exited with code ${result.code}`),
      isError: result.code !== 0,
    }
  }
}
