import { constants } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  open,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { tmpdir } from 'node:os'

import sharp from 'sharp'

import type {
  ModelImage,
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
import { openPdf } from './pdf.js'

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
  environment?: Readonly<Record<string, string>>
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
      'Reads a file from the local filesystem. You can access any file directly by using this tool.\nAssume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The file_path parameter must be an absolute path, not a relative path\n- By default, it reads up to 2000 lines starting from the beginning of the file\n- You can optionally specify a line offset and limit (especially handy for long files), but it\'s recommended to read the whole file by not providing these parameters\n- Results are returned using cat -n format, with line numbers starting at 1\n- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.\n- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.\n- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.\n- This tool can only read files, not directories. To list files in a directory, use the registered shell tool.\n- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.\n- Do NOT re-read a file you just edited to verify — Edit/Write would have errored if the change failed, and the harness tracks file state for you.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        file_path: {
          description: 'The absolute path to the file to read',
          type: 'string',
        },
        offset: {
          description:
            'The line number to start reading from. Only provide if the file is too large to read at once',
          type: 'integer',
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        limit: {
          description:
            'The number of lines to read. Only provide if the file is too large to read at once.',
          type: 'integer',
          exclusiveMinimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        pages: {
          description:
            'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
          type: 'string',
        },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'Write',
    description:
      "Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.\n- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.\n- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        file_path: {
          description:
            'The absolute path to the file to write (must be absolute, not relative)',
          type: 'string',
        },
        content: {
          description: 'The content to write to the file',
          type: 'string',
        },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'Edit',
    description:
      'Performs exact string replacements in files.\n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.\n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.\n- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        file_path: {
          description: 'The absolute path to the file to modify',
          type: 'string',
        },
        old_string: { description: 'The text to replace', type: 'string' },
        new_string: {
          description:
            'The text to replace it with (must be different from old_string)',
          type: 'string',
        },
        replace_all: {
          description: 'Replace all occurrences of old_string (default false)',
          default: false,
          type: 'boolean',
        },
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
    description:
      "Executes a given bash command and returns its output.\n\nThe working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        command: { description: 'The command to execute', type: 'string' },
        timeout: {
          description: 'Optional timeout in milliseconds (max 600000)',
          type: 'number',
        },
        description: {
          description:
            'Clear, concise description of what this command does in active voice. Never use words like "complex" or "risk" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → "List files in current directory"\n- git status → "Show working tree status"\n- npm install → "Install package dependencies"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name "*.tmp" -exec rm {} \\; → "Find and delete all .tmp files recursively"\n- git reset --hard origin/main → "Discard all local changes and match remote main"\n- curl -s url | jq \'.data[]\' → "Fetch JSON from URL and extract data array elements"',
          type: 'string',
        },
        run_in_background: {
          description: 'Set to true to run this command in the background.',
          type: 'boolean',
        },
        dangerouslyDisableSandbox: {
          description:
            'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
          type: 'boolean',
        },
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

function optionalNonNegativeInteger(
  input: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || typeof value !== 'number' || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
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

function isPdf(content: Buffer): boolean {
  return content.subarray(0, 5).toString('ascii') === '%PDF-'
}

function formatKilobytes(bytes: number): string {
  const value = bytes / 1024
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}KB`.replace(
    '.0KB',
    'KB',
  )
}

function parsePdfPages(value: string): { start: number; end: number } {
  const match = /^(\d+)(?:-(\d+))?$/u.exec(value)
  if (!match) throw new Error(`Invalid PDF page range: ${value}`)
  const start = Number(match[1])
  const end = Number(match[2] ?? match[1])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start
  ) {
    throw new Error(`Invalid PDF page range: ${value}`)
  }
  if (end - start + 1 > 20) {
    throw new Error('PDF page range cannot exceed 20 pages')
  }
  return { start, end }
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
  private readonly environment: Readonly<Record<string, string>> | undefined

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
    this.environment = options.environment
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
      case 'Read': {
        const offset = optionalNonNegativeInteger(call.input, 'offset')
        const limit = optionalPositiveInteger(call.input, 'limit')
        const pages = optionalString(call.input, 'pages')
        return {
          ...call,
          input: {
            file_path: await this.filePath(
              stringInput(call.input, 'file_path'),
              false,
              true,
              context,
            ),
            ...(offset === undefined ? {} : { offset }),
            ...(limit === undefined ? {} : { limit }),
            ...(pages === undefined ? {} : { pages }),
          },
        }
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
        return this.read(prepared, context)
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

  private async read(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
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
      const requestedOffset = optionalNonNegativeInteger(call.input, 'offset')
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
      if (isPdf(source)) {
        return this.readPdf(source, filePath, call.input.pages, context)
      }
      const text = source.toString('utf8')
      const notebook = extname(filePath).toLowerCase() === '.ipynb'
      const lines = (notebook ? formatNotebookForRead(text) : text).split('\n')
      const start = offset === 0 ? 0 : offset - 1
      const effectiveLimit = notebook ? limit : (limit ?? 2000)
      const selected = lines.slice(
        start,
        effectiveLimit === undefined ? undefined : start + effectiveLimit,
      )
      const rawContent = selected.join('\n')
      const content = notebook
        ? rawContent
        : selected
            .map(
              (line, index) =>
                `${(offset === 0 ? 0 : offset) + index}\t${line}`,
            )
            .join('\n')
      return {
        content: truncateOutput(content, this.maxOutputBytes),
        isError: false,
        accessedPaths: [filePath],
        ...(notebook
          ? {}
          : {
              nativeToolUseResult: {
                type: 'text',
                file: {
                  filePath,
                  content: rawContent,
                  numLines: selected.length,
                  startLine: offset,
                  totalLines: lines.length,
                },
              },
            }),
      }
    } finally {
      await handle.close()
    }
  }

  private async readPdf(
    source: Buffer,
    filePath: string,
    pagesInput: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const document = await openPdf(source)
    try {
      const pages =
        pagesInput === undefined
          ? undefined
          : parsePdfPages(stringInput({ pages: pagesInput }, 'pages'))
      if (pages === undefined) {
        if (document.length > 10) {
          throw new Error(
            'PDF has more than 10 pages; provide pages to read a maximum of 20 pages per request',
          )
        }
        return {
          content: `PDF file read: ${filePath} (${formatKilobytes(source.length)})`,
          documents: [
            {
              type: 'document',
              mediaType: 'application/pdf',
              data: source.toString('base64'),
            },
          ],
          isError: false,
          accessedPaths: [filePath],
          nativeToolUseResult: {
            type: 'pdf',
            file: {
              filePath,
              base64: source.toString('base64'),
              originalSize: source.length,
            },
          },
        }
      }
      if (pages.end > document.length) {
        throw new Error(
          `PDF page range ${pages.start}-${pages.end} exceeds document page count ${document.length}`,
        )
      }
      const images: ModelImage[] = []
      const outputDirectory = await this.createPdfOutputDirectory(context)
      for (
        let pageNumber = pages.start;
        pageNumber <= pages.end;
        pageNumber += 1
      ) {
        if (context.signal?.aborted) throw abortError()
        const png = await document.getPage(pageNumber)
        const jpeg = await sharp(png).jpeg({ quality: 90 }).toBuffer()
        if (jpeg.length > this.maxFileBytes) {
          throw new Error(
            `Rendered PDF page exceeds ${this.maxFileBytes} byte read limit`,
          )
        }
        const data = jpeg.toString('base64')
        images.push({ type: 'image', mediaType: 'image/jpeg', data })
        await writeFile(join(outputDirectory, `page-${pageNumber}.jpg`), jpeg)
      }
      return {
        content: `PDF pages extracted: ${images.length} page(s) from ${filePath} (${formatKilobytes(source.length)})`,
        images,
        isError: false,
        accessedPaths: [filePath],
        nativeToolUseResult: {
          type: 'parts',
          file: {
            filePath,
            originalSize: source.length,
            outputDir: outputDirectory,
            count: images.length,
          },
        },
      }
    } finally {
      await document.destroy()
    }
  }

  private async createPdfOutputDirectory(
    context: ToolExecutionContext,
  ): Promise<string> {
    const parent = context.toolResultDirectory
      ? resolve(context.toolResultDirectory)
      : tmpdir()
    await mkdir(parent, { recursive: true })
    return mkdtemp(join(parent, 'pdf-'))
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
      ...(this.environment ? { env: this.environment } : {}),
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
      ...(this.environment ? { env: this.environment } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    })
    if (result.timedOut) {
      return {
        content: `Command timed out after ${timeout}ms`,
        isError: true,
        processOutput: {
          stdout: result.stdout,
          stderr: result.stderr || `Command timed out after ${timeout}ms`,
          exitCode: result.code,
        },
      }
    }
    const content = joinedProcessOutput(result)
    return {
      content:
        content ||
        (result.code === 0 ? '' : `Command exited with code ${result.code}`),
      isError: result.code !== 0,
      processOutput: {
        stdout: result.stdout,
        stderr:
          result.stderr ||
          (result.code === 0 ? '' : `Command exited with code ${result.code}`),
        exitCode: result.code,
      },
    }
  }
}
