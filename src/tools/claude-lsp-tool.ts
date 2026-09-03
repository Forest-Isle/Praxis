import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import { resolveToolSchedulingPolicy } from '../core/tool-scheduling-policy.js'
import type { ClaudePluginLspServer } from '../plugins/claude-plugin-runtime.js'
import {
  redactSensitiveText,
  sanitizeChildEnvironment,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import { formatClaudeLspResult } from './claude-lsp-formatters.js'
import {
  formatDiagnostics,
  parsePublishDiagnostics,
  type LspDiagnosticRecord,
} from './lsp-diagnostics.js'

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024
const MAX_RESULT_CHARS = 512 * 1024
const MAX_FILE_BYTES = 10_000_000
const REQUEST_TIMEOUT_MS = 15_000
const DIAGNOSTICS_TIMEOUT_MS = 1_000
const execFileAsync = promisify(execFile)
const NO_CALL_HIERARCHY = Symbol('no-call-hierarchy')

interface DiagnosticWaiter {
  uri: string
  afterGeneration: number
  resolve: (diagnostics: readonly LspDiagnosticRecord[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  abort?: () => void
}

function lspSensitiveValues(
  definition: ClaudePluginLspServer,
): readonly string[] {
  return [
    ...new Set([
      ...sensitiveEnvironmentValues(definition.env),
      ...(definition.sensitiveValues ?? []),
    ]),
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length)
}

const LSP_DEFINITION: ModelToolDefinition = {
  name: 'LSP',
  description: `Interact with Language Server Protocol (LSP) servers to get code intelligence features.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols matching a query across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position (functions/methods)
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

The workspaceSymbol operation also takes:
- query: The symbol name or partial name to search for. Always provide it — most language servers return no results for an empty query.

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`,
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      operation: {
        description: 'The LSP operation to perform',
        type: 'string',
        enum: [
          'goToDefinition',
          'findReferences',
          'hover',
          'documentSymbol',
          'workspaceSymbol',
          'goToImplementation',
          'prepareCallHierarchy',
          'incomingCalls',
          'outgoingCalls',
        ],
      },
      filePath: {
        description: 'The absolute or relative path to the file',
        type: 'string',
      },
      line: {
        description: 'The line number (1-based, as shown in editors)',
        type: 'integer',
        exclusiveMinimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      character: {
        description: 'The character offset (1-based, as shown in editors)',
        type: 'integer',
        exclusiveMinimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      query: {
        description:
          'The symbol name or partial name to search for (workspaceSymbol only). Most language servers return no results for an empty query, so always provide it when using workspaceSymbol.',
        type: 'string',
      },
    },
    required: ['operation', 'filePath', 'line', 'character'],
    additionalProperties: false,
  },
}

const OPERATIONS = new Set(
  (
    LSP_DEFINITION.inputSchema.properties as Record<string, unknown> & {
      operation: { enum: string[] }
    }
  ).operation.enum,
)

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  abort?: () => void
}

class LspResponseError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message)
  }
}

interface LspInput {
  operation: string
  filePath: string
  line: number
  character: number
  query?: string
}

function inputFrom(value: Record<string, unknown>): LspInput {
  const allowed = new Set([
    'operation',
    'filePath',
    'line',
    'character',
    'query',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unknown LSP input field ${key}`)
  }
  if (typeof value.operation !== 'string' || !OPERATIONS.has(value.operation)) {
    throw new Error('LSP operation is invalid')
  }
  if (
    typeof value.filePath !== 'string' ||
    value.filePath.trim().length === 0
  ) {
    throw new Error('LSP filePath must be a non-empty string')
  }
  for (const key of ['line', 'character'] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0) {
      throw new Error(`LSP ${key} must be a positive integer`)
    }
  }
  if (
    value.operation === 'workspaceSymbol' &&
    (typeof value.query !== 'string' || value.query.trim().length === 0)
  ) {
    throw new Error('LSP workspaceSymbol requires a non-empty query')
  }
  if (value.query !== undefined && typeof value.query !== 'string') {
    throw new Error('LSP query must be a string')
  }
  return {
    operation: value.operation,
    filePath: value.filePath.trim(),
    line: Number(value.line),
    character: Number(value.character),
    ...(value.query === undefined ? {} : { query: value.query }),
  }
}

function framed(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ])
}

function resultUri(operation: string, value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const item = value as Record<string, unknown>
  if (operation === 'workspaceSymbol') {
    const location = item.location
    return location && typeof location === 'object'
      ? ((location as Record<string, unknown>).uri as string | undefined)
      : undefined
  }
  if (typeof item.targetUri === 'string') return item.targetUri
  return typeof item.uri === 'string' ? item.uri : undefined
}

function uriPath(uri: string): string {
  let path = uri.replace(/^file:\/\//u, '')
  if (/^\/[A-Za-z]:/u.test(path)) path = path.slice(1)
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

async function gitIgnoredPaths(
  paths: readonly string[],
  cwd: string,
): Promise<Set<string>> {
  const ignored = new Set<string>()
  for (let index = 0; index < paths.length; index += 50) {
    const batch = paths.slice(index, index + 50)
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['check-ignore', ...batch],
        { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 },
      )
      for (const line of stdout.split('\n')) {
        if (line.trim()) ignored.add(line.trim())
      }
    } catch (error) {
      const result = error as { stdout?: string }
      for (const line of (result.stdout ?? '').split('\n')) {
        if (line.trim()) ignored.add(line.trim())
      }
    }
  }
  return ignored
}

async function filterGitIgnoredResult(
  operation: string,
  result: unknown,
  cwd: string,
): Promise<unknown> {
  if (
    !Array.isArray(result) ||
    ![
      'findReferences',
      'goToDefinition',
      'goToImplementation',
      'workspaceSymbol',
    ].includes(operation)
  ) {
    return result
  }
  const pathsByUri = new Map<string, string>()
  for (const value of result) {
    const uri = resultUri(operation, value)
    if (uri && !pathsByUri.has(uri)) pathsByUri.set(uri, uriPath(uri))
  }
  const ignored = await gitIgnoredPaths([...new Set(pathsByUri.values())], cwd)
  if (ignored.size === 0) return result
  return result.filter((value) => {
    const uri = resultUri(operation, value)
    const path = uri ? pathsByUri.get(uri) : undefined
    return !path || !ignored.has(path)
  })
}

class LspConnection {
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<number, PendingRequest>()
  private readonly documents = new Map<
    string,
    { text: string; version: number; uri: string }
  >()
  private readonly diagnosticSnapshots = new Map<
    string,
    { generation: number; diagnostics: readonly LspDiagnosticRecord[] }
  >()
  private readonly diagnosticWaiters = new Set<DiagnosticWaiter>()
  private diagnosticGeneration = 0
  private stderr = ''
  private exited = false
  private initialized = false

  constructor(
    private readonly definition: ClaudePluginLspServer,
    private readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    child.stdin.on('error', (error) => this.fail(error))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-64 * 1024)
    })
    child.once('error', (error) => this.fail(error))
    child.once('close', (code, signal) => {
      this.exited = true
      this.fail(
        new Error(
          `LSP server ${definition.name} exited${signal ? ` with ${signal}` : ` with code ${code ?? 'unknown'}`}${this.stderr ? `: ${this.redactedStderr()}` : ''}`,
        ),
      )
    })
  }

  private redactedStderr(): string {
    return redactSensitiveText(this.stderr, lspSensitiveValues(this.definition))
  }

  isRunning(): boolean {
    return !this.exited
  }

  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.cleanupPending(id, pending)
      pending.reject(error)
    }
    for (const waiter of [...this.diagnosticWaiters])
      this.settleDiagnosticWaiter(waiter, undefined, error)
    this.diagnosticSnapshots.clear()
  }

  private settleDiagnosticWaiter(
    waiter: DiagnosticWaiter,
    diagnostics?: readonly LspDiagnosticRecord[],
    error?: Error,
  ): void {
    if (!this.diagnosticWaiters.delete(waiter)) return
    clearTimeout(waiter.timer)
    if (waiter.signal && waiter.abort)
      waiter.signal.removeEventListener('abort', waiter.abort)
    if (error) waiter.reject(error)
    else waiter.resolve(diagnostics ?? [])
  }

  private cleanupPending(id: number, pending: PendingRequest): void {
    clearTimeout(pending.timer)
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener('abort', pending.abort)
    }
    this.pending.delete(id)
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_MESSAGE_BYTES) {
      this.fail(
        new Error(`LSP server ${this.definition.name} output exceeded 8 MiB`),
      )
      this.child.kill('SIGTERM')
      return
    }
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header)?.[1]
      if (!length) {
        this.fail(
          new Error(`LSP server ${this.definition.name} sent invalid headers`),
        )
        this.child.kill('SIGTERM')
        return
      }
      const bytes = Number(length)
      if (!Number.isSafeInteger(bytes) || bytes > MAX_MESSAGE_BYTES) {
        this.fail(
          new Error(`LSP server ${this.definition.name} message is too large`),
        )
        this.child.kill('SIGTERM')
        return
      }
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + bytes) return
      const body = this.buffer.subarray(bodyStart, bodyStart + bytes)
      this.buffer = this.buffer.subarray(bodyStart + bytes)
      let message: unknown
      try {
        message = JSON.parse(body.toString('utf8'))
      } catch {
        this.fail(
          new Error(`LSP server ${this.definition.name} sent invalid JSON`),
        )
        this.child.kill('SIGTERM')
        return
      }
      this.onMessage(message)
    }
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return
    const value = message as Record<string, unknown>
    const publication = parsePublishDiagnostics(message)
    if (publication) {
      const document = [...this.documents.values()].find(
        (candidate) => candidate.uri === publication.uri,
      )
      if (!document) return
      if (
        publication.version !== undefined &&
        publication.version !== document.version
      )
        return
      const generation = ++this.diagnosticGeneration
      this.diagnosticSnapshots.set(publication.uri, {
        generation,
        diagnostics: publication.diagnostics,
      })
      const snapshot = this.diagnosticSnapshots.get(publication.uri)
      for (const waiter of [...this.diagnosticWaiters]) {
        if (
          waiter.uri !== publication.uri ||
          !snapshot ||
          snapshot.generation <= waiter.afterGeneration
        )
          continue
        this.settleDiagnosticWaiter(waiter, snapshot.diagnostics)
      }
      return
    }
    if (value.id !== undefined && typeof value.method === 'string') {
      const result =
        value.method === 'workspace/configuration' &&
        value.params &&
        typeof value.params === 'object' &&
        Array.isArray((value.params as { items?: unknown }).items)
          ? (value.params as { items: unknown[] }).items.map(() => null)
          : null
      this.send({ jsonrpc: '2.0', id: value.id, result })
      return
    }
    if (typeof value.id === 'number' && this.pending.has(value.id)) {
      const pending = this.pending.get(value.id)
      if (!pending) return
      this.cleanupPending(value.id, pending)
      if (value.error && typeof value.error === 'object') {
        const error = value.error as Record<string, unknown>
        pending.reject(
          new LspResponseError(
            typeof error.code === 'number' ? error.code : undefined,
            `LSP ${this.definition.name} error ${String(error.code ?? '')}: ${String(error.message ?? 'unknown error')}`,
          ),
        )
      } else pending.resolve(value.result)
      return
    }
  }

  private send(value: unknown): void {
    if (this.exited || !this.child.stdin.writable) {
      throw new Error(`LSP server ${this.definition.name} is not running`)
    }
    this.child.stdin.write(framed(value))
  }

  private request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (signal?.aborted)
      return Promise.reject(new Error('LSP request cancelled'))
    const id = this.nextId++
    return new Promise((resolveRequest, rejectRequest) => {
      const pending: PendingRequest = {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer: setTimeout(() => {
          this.cleanupPending(id, pending)
          try {
            this.send({
              jsonrpc: '2.0',
              method: '$/cancelRequest',
              params: { id },
            })
          } catch {
            // Timeout remains the terminal result if the server also exited.
          }
          rejectRequest(
            new Error(`LSP ${method} timed out after ${timeoutMs}ms`),
          )
        }, timeoutMs),
        ...(signal ? { signal } : {}),
      }
      if (signal) {
        pending.abort = () => {
          this.cleanupPending(id, pending)
          try {
            this.send({
              jsonrpc: '2.0',
              method: '$/cancelRequest',
              params: { id },
            })
          } catch {
            // Process exit already provides the terminal outcome.
          }
          rejectRequest(new Error('LSP request cancelled'))
        }
        signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.pending.set(id, pending)
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.cleanupPending(id, pending)
        rejectRequest(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private async operationRequest(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request(method, params, signal)
      } catch (error) {
        if (
          !(error instanceof LspResponseError) ||
          error.code !== -32801 ||
          attempt >= 3
        ) {
          throw error
        }
        await new Promise<void>((resolveDelay, rejectDelay) => {
          const finish = () => {
            signal?.removeEventListener('abort', abort)
            resolveDelay()
          }
          const timer = setTimeout(finish, 500 * 2 ** attempt)
          const abort = () => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', abort)
            rejectDelay(new Error('LSP request cancelled'))
          }
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      }
    }
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return
    const rootUri = pathToFileURL(this.cwd).href
    await this.request(
      'initialize',
      {
        processId: process.pid,
        rootPath: this.cwd,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: this.cwd.split(sep).at(-1) }],
        capabilities: {
          workspace: {
            configuration: false,
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
              versionSupport: true,
              codeDescriptionSupport: true,
              dataSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: { dynamicRegistration: false },
          },
          general: { positionEncodings: ['utf-16'] },
        },
        initializationOptions: this.definition.initializationOptions ?? {},
      },
      signal,
      this.definition.startupTimeout ?? REQUEST_TIMEOUT_MS,
    )
    this.notify('initialized', {})
    if (this.definition.settings !== undefined) {
      this.notify('workspace/didChangeConfiguration', {
        settings: this.definition.settings,
      })
    }
    this.initialized = true
  }

  private synchronizeDocument(
    filePath: string,
    languageId: string,
    text: string,
  ): boolean {
    const current = this.documents.get(filePath)
    const uri = pathToFileURL(filePath).href
    if (current?.text === text) return false
    if (!current) {
      this.documents.set(filePath, { text, version: 1, uri })
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId, version: 1, text },
      })
    } else {
      const version = current.version + 1
      this.documents.set(filePath, { text, version, uri })
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      })
    }
    return true
  }

  async openDocument(filePath: string, languageId: string): Promise<void> {
    const text = await readFile(filePath, 'utf8')
    this.synchronizeDocument(filePath, languageId, text)
  }

  async refreshDiagnostics(
    filePath: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<readonly LspDiagnosticRecord[]> {
    if (signal?.aborted) return []
    const text = await readFile(filePath, 'utf8')
    if (signal?.aborted) return []
    const uri = pathToFileURL(filePath).href
    const current = this.documents.get(filePath)
    if (current && current.text === text) return []
    const afterGeneration = this.diagnosticSnapshots.get(uri)?.generation ?? 0
    let waiter: DiagnosticWaiter | undefined
    const result = new Promise<readonly LspDiagnosticRecord[]>(
      (resolveResult, rejectResult) => {
        const entry: DiagnosticWaiter = {
          uri,
          afterGeneration,
          resolve: resolveResult,
          reject: rejectResult,
          timer: setTimeout(() => {
            this.settleDiagnosticWaiter(entry)
          }, 1_000),
          ...(signal ? { signal } : {}),
        }
        waiter = entry
        if (signal) {
          entry.abort = () => {
            this.settleDiagnosticWaiter(
              entry,
              undefined,
              new Error('LSP diagnostics refresh cancelled'),
            )
          }
          if (signal.aborted) {
            clearTimeout(entry.timer)
            resolveResult([])
            return
          }
          signal.addEventListener('abort', entry.abort, { once: true })
        }
        this.diagnosticWaiters.add(entry)
      },
    )
    if (signal?.aborted) return result
    try {
      this.synchronizeDocument(filePath, languageId, text)
    } catch (error) {
      if (waiter) {
        // The method throws the send failure directly. Resolve the detached
        // waiter while cleaning it so it cannot become an unhandled rejection.
        this.settleDiagnosticWaiter(waiter)
      }
      throw error
    }
    return result.catch(() => [])
  }

  async execute(input: LspInput, filePath: string, signal?: AbortSignal) {
    const uri = pathToFileURL(filePath).href
    const position = { line: input.line - 1, character: input.character - 1 }
    const textDocument = { uri }
    const positional = { textDocument, position }
    switch (input.operation) {
      case 'goToDefinition':
        return this.operationRequest(
          'textDocument/definition',
          positional,
          signal,
        )
      case 'findReferences':
        return this.operationRequest(
          'textDocument/references',
          { ...positional, context: { includeDeclaration: true } },
          signal,
        )
      case 'hover':
        return this.operationRequest('textDocument/hover', positional, signal)
      case 'documentSymbol':
        return this.operationRequest(
          'textDocument/documentSymbol',
          { textDocument },
          signal,
        )
      case 'workspaceSymbol':
        return this.operationRequest(
          'workspace/symbol',
          { query: input.query },
          signal,
        )
      case 'goToImplementation':
        return this.operationRequest(
          'textDocument/implementation',
          positional,
          signal,
        )
      case 'prepareCallHierarchy':
        return this.operationRequest(
          'textDocument/prepareCallHierarchy',
          positional,
          signal,
        )
      case 'incomingCalls':
      case 'outgoingCalls': {
        const prepared = await this.operationRequest(
          'textDocument/prepareCallHierarchy',
          positional,
          signal,
        )
        if (!Array.isArray(prepared) || prepared.length === 0)
          return NO_CALL_HIERARCHY
        const method = `callHierarchy/${input.operation}`
        return this.operationRequest(method, { item: prepared[0] }, signal)
      }
      default:
        throw new Error(`Unsupported LSP operation ${input.operation}`)
    }
  }

  async close(): Promise<void> {
    if (this.exited) return
    this.fail(new Error(`LSP server ${this.definition.name} is closing`))
    const exited = new Promise<void>((resolveExit) => {
      this.child.once('close', () => resolveExit())
    })
    try {
      if (this.initialized)
        await this.request('shutdown', null, undefined, 1_000)
      this.notify('exit', null)
    } catch {
      // Forced termination below is the bounded fallback.
    }
    const voluntary = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolveTimeout) =>
        setTimeout(() => resolveTimeout(false), 100),
      ),
    ])
    if (voluntary) return
    if (!this.exited) this.child.kill('SIGTERM')
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolveTimeout) =>
        setTimeout(() => resolveTimeout(false), 500),
      ),
    ])
    if (!graceful && !this.exited) {
      this.child.kill('SIGKILL')
      await exited
    }
  }
}

export class ClaudeLspToolManager {
  private readonly connections = new Map<string, LspConnection>()
  private readonly initializing = new Map<string, Promise<LspConnection>>()
  private readonly restartCounts = new Map<string, number>()

  constructor(
    private readonly options: {
      servers: readonly ClaudePluginLspServer[]
      cwdProvider(): string
      roots(): readonly string[]
      environment?: Readonly<Record<string, string | undefined>>
    },
  ) {}

  registry(base: ToolRegistry): ToolRegistry {
    return new ClaudeLspToolRegistry(base, this)
  }

  private async discardConnectionsOutside(runtimeCwd?: string): Promise<void> {
    const prefix = runtimeCwd === undefined ? undefined : `${runtimeCwd}\0`
    const staleKeys = new Set(
      [
        ...this.connections.keys(),
        ...this.initializing.keys(),
        ...this.restartCounts.keys(),
      ].filter((key) => prefix === undefined || !key.startsWith(prefix)),
    )
    const staleConnections: LspConnection[] = []
    for (const key of staleKeys) {
      const connection = this.connections.get(key)
      if (connection) staleConnections.push(connection)
      this.connections.delete(key)
      this.initializing.delete(key)
      this.restartCounts.delete(key)
    }
    await Promise.allSettled(
      staleConnections.map((connection) => connection.close()),
    )
  }

  private async runtimeCwd(): Promise<string> {
    try {
      return await realpath(this.options.cwdProvider())
    } catch (error) {
      await this.discardConnectionsOutside()
      throw error
    }
  }

  private async validatedFile(
    inputPath: string,
  ): Promise<{ filePath: string; canonicalPath: string; size: number }> {
    const cwd = this.options.cwdProvider()
    const expanded =
      inputPath === '~'
        ? homedir()
        : inputPath.startsWith('~/')
          ? resolve(homedir(), inputPath.slice(2))
          : inputPath
    const filePath = resolve(cwd, expanded)
    const canonicalPath = await realpath(filePath)
    const roots = await Promise.all(
      this.options.roots().map(async (root) => {
        try {
          return await realpath(resolve(root))
        } catch {
          return resolve(root)
        }
      }),
    )
    if (
      !roots.some(
        (root) =>
          canonicalPath === root || canonicalPath.startsWith(`${root}${sep}`),
      )
    ) {
      throw new Error(`LSP path is outside allowed roots: ${inputPath}`)
    }
    const info = await stat(canonicalPath)
    if (!info.isFile()) {
      throw new Error(`LSP path is not a file: ${inputPath}`)
    }
    return { filePath, canonicalPath, size: info.size }
  }

  private candidates(filePath: string): ClaudePluginLspServer[] {
    const extension = extname(filePath).toLowerCase()
    return this.options.servers.filter((server) =>
      Object.keys(server.extensionToLanguage).some(
        (candidate) => candidate.toLowerCase() === extension,
      ),
    )
  }

  private languageId(
    definition: ClaudePluginLspServer,
    filePath: string,
  ): string {
    const extension = extname(filePath).toLowerCase()
    return (
      Object.entries(definition.extensionToLanguage).find(
        ([candidate]) => candidate.toLowerCase() === extension,
      )?.[1] ?? ''
    )
  }

  private async connection(
    definition: ClaudePluginLspServer,
    signal?: AbortSignal,
    expectedCwd?: string,
  ): Promise<LspConnection> {
    const runtimeCwd = await this.runtimeCwd()
    if (expectedCwd !== undefined && runtimeCwd !== expectedCwd) {
      await this.discardConnectionsOutside(runtimeCwd)
      throw new Error('LSP diagnostics cwd changed during collection')
    }
    if (signal?.aborted) throw new Error('LSP connection cancelled')
    const serverCwd = await realpath(definition.workspaceFolder ?? runtimeCwd)
    const key = `${runtimeCwd}\0${definition.pluginName}\0${definition.name}`
    await this.discardConnectionsOutside(runtimeCwd)
    if (signal?.aborted) throw new Error('LSP connection cancelled')
    const confirmedCwd = await this.runtimeCwd()
    if (expectedCwd !== undefined && confirmedCwd !== expectedCwd) {
      await this.discardConnectionsOutside(confirmedCwd)
      throw new Error('LSP diagnostics cwd changed during collection')
    }
    const initializing = this.initializing.get(key)
    if (initializing) return initializing
    const connection = this.connections.get(key)
    if (connection?.isRunning()) return connection
    this.connections.delete(key)
    const previousStarts = this.restartCounts.get(key)
    const restartCount = previousStarts === undefined ? 0 : previousStarts + 1
    const maxRestarts = definition.maxRestarts ?? 3
    if (restartCount > maxRestarts) {
      throw new Error(
        `LSP server '${definition.pluginName}:${definition.name}' exceeded max crash recovery attempts (${maxRestarts})`,
      )
    }
    this.restartCounts.set(key, restartCount)
    const starting = (async () => {
      const child = spawn(definition.command, [...definition.args], {
        cwd: serverCwd,
        env: sanitizeChildEnvironment(
          definition.env,
          this.options.environment ?? process.env,
        ),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const created = new LspConnection(definition, serverCwd, child)
      this.connections.set(key, created)
      try {
        await created.initialize(signal)
        return created
      } catch (error) {
        if (this.connections.get(key) === created) this.connections.delete(key)
        await created.close()
        throw error
      }
    })()
    this.initializing.set(key, starting)
    try {
      return await starting
    } finally {
      if (this.initializing.get(key) === starting) this.initializing.delete(key)
    }
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    try {
      const input = inputFrom(call.input)
      const cwd = await this.runtimeCwd()
      const { filePath, canonicalPath, size } = await this.validatedFile(
        input.filePath,
      )
      if (size > MAX_FILE_BYTES) {
        return {
          content: `File too large for LSP analysis (${Math.ceil(size / 1_000_000)}MB exceeds 10MB limit)`,
          isError: false,
          accessedPaths: [canonicalPath],
        }
      }
      const candidates = this.candidates(filePath)
      if (candidates.length === 0) {
        return {
          content: `No LSP server available for file type: ${extname(filePath)}`,
          isError: false,
          accessedPaths: [canonicalPath],
        }
      }
      const failures: string[] = []
      for (const definition of candidates) {
        try {
          const connection = await this.connection(definition, context.signal)
          await connection.openDocument(
            filePath,
            this.languageId(definition, filePath),
          )
          const result = await connection.execute(
            input,
            filePath,
            context.signal,
          )
          const filtered = await filterGitIgnoredResult(
            input.operation,
            result,
            cwd,
          )
          const content = redactSensitiveText(
            filtered === NO_CALL_HIERARCHY
              ? 'No call hierarchy item found at this position'
              : formatClaudeLspResult(input.operation, filtered, cwd),
            lspSensitiveValues(definition),
          )
          return {
            content:
              content.length <= MAX_RESULT_CHARS
                ? content
                : `${content.slice(0, MAX_RESULT_CHARS)}\n… LSP result truncated`,
            isError: false,
            accessedPaths: [canonicalPath],
          }
        } catch (error) {
          const message = redactSensitiveText(
            error instanceof Error ? error.message : String(error),
            lspSensitiveValues(definition),
          )
          failures.push(
            `${definition.pluginName}:${definition.name}: ${message}`,
          )
        }
      }
      return {
        content: `Error performing ${input.operation}: ${failures.join('; ')}`,
        isError: false,
        accessedPaths: [canonicalPath],
      }
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  }

  async enrichMutationResult(
    call: ModelToolCall,
    context: ToolExecutionContext,
    result: ToolExecutionResult,
  ): Promise<ToolExecutionResult> {
    if (result.isError || (call.name !== 'Edit' && call.name !== 'ApplyPatch'))
      return result
    if (context.signal?.aborted) return result
    const deadline = new AbortController()
    let resolveInterrupted: ((value: ToolExecutionResult) => void) | undefined
    const interrupted = new Promise<ToolExecutionResult>((resolveResult) => {
      resolveInterrupted = resolveResult
    })
    const abort = () => {
      deadline.abort()
      resolveInterrupted?.(result)
    }
    context.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => abort(), DIAGNOSTICS_TIMEOUT_MS)
    const attempt = (async (): Promise<ToolExecutionResult> => {
      const cwd = await this.runtimeCwd()
      await this.discardConnectionsOutside(cwd)
      const sameCwd = async (): Promise<boolean> => {
        try {
          const runtimeCwd = await this.runtimeCwd()
          if (runtimeCwd === cwd) return true
          await this.discardConnectionsOutside(runtimeCwd)
        } catch {
          // runtimeCwd() already discarded connection-local state.
        }
        return false
      }
      if (deadline.signal.aborted || !(await sameCwd())) return result
      const requested =
        call.name === 'Edit'
          ? [call.input.file_path]
          : Array.isArray(call.input.edits)
            ? call.input.edits.map((edit) => edit?.file_path)
            : []
      const targets = new Set<string>()
      for (const value of requested) {
        if (typeof value !== 'string' || deadline.signal.aborted) continue
        try {
          const canonical = await realpath(resolve(cwd, value))
          if (deadline.signal.aborted || !(await sameCwd())) continue
          const relativePath = relative(cwd, canonical)
          if (
            relativePath === '..' ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath) ||
            !(await stat(canonical)).isFile()
          )
            continue
          targets.add(canonical)
        } catch {
          // Successful mutations must remain successful when enrichment cannot inspect a target.
        }
      }
      const records: LspDiagnosticRecord[] = []
      await Promise.all(
        [...targets].flatMap((filePath) =>
          this.candidates(filePath).map(async (definition) => {
            if (deadline.signal.aborted) return
            try {
              const connection = await this.connection(
                definition,
                deadline.signal,
                cwd,
              )
              if (deadline.signal.aborted || !(await sameCwd())) return
              const current = await connection.refreshDiagnostics(
                filePath,
                this.languageId(definition, filePath),
                deadline.signal,
              )
              if (deadline.signal.aborted || !(await sameCwd())) return
              records.push(...current)
            } catch {
              // Diagnostics are best effort and never change mutation semantics.
            }
          }),
        ),
      )
      if (records.length === 0 || deadline.signal.aborted || !(await sameCwd()))
        return result
      const block = formatDiagnostics(
        records,
        cwd,
        this.options.servers.flatMap((definition) =>
          lspSensitiveValues(definition),
        ),
      )
      return block
        ? { ...result, content: `${result.content}\n${block}` }
        : result
    })().catch(() => result)
    try {
      return await Promise.race([attempt, interrupted])
    } finally {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', abort)
    }
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()]
    this.connections.clear()
    this.initializing.clear()
    this.restartCounts.clear()
    const results = await Promise.allSettled(
      connections.map((connection) => connection.close()),
    )
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (failure) throw failure.reason
  }
}

class ClaudeLspToolRegistry implements ToolRegistry {
  constructor(
    private readonly base: ToolRegistry,
    private readonly manager: ClaudeLspToolManager,
  ) {}

  definitions(): readonly ModelToolDefinition[] {
    return [...this.base.definitions(), LSP_DEFINITION]
  }

  schedulingPolicy(call: ModelToolCall) {
    if (call.name === 'LSP') {
      return { concurrency: 'exclusive' as const, cancelOnInterrupt: true }
    }
    return resolveToolSchedulingPolicy(this.base, call)
  }

  prepare(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ModelToolCall> {
    return call.name === 'LSP'
      ? Promise.resolve(call)
      : this.base.prepare(call, context)
  }

  async execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (call.name === 'LSP') return this.manager.execute(call, context)
    const result = await this.base.execute(call, context)
    return this.manager.enrichMutationResult(call, context, result)
  }
}
