import { randomBytes, randomUUID } from 'node:crypto'

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import type {
  ModelToolCall,
  ModelToolDefinition,
  RuntimeEvent,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from '../core/runtime.js'
import {
  redactSensitiveText,
  sensitiveEnvironmentValues,
} from '../platform/sensitive-data.js'
import { LocalToolRegistry } from '../tools/local-tools.js'

const VERSION = '0.1.0'
const MAX_BACKGROUND_TASKS = 256

const AGENT_DEFINITION: ModelToolDefinition = {
  name: 'Agent',
  description:
    'Launch a Praxis agent to handle a complex, multi-step task. Agents run in the background by default.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      description: {
        description: 'A short description of the task',
        type: 'string',
      },
      prompt: { description: 'The task to perform', type: 'string' },
      subagent_type: {
        description: 'Shared agent definition name',
        type: 'string',
      },
      model: { description: 'Optional model override', type: 'string' },
      run_in_background: {
        description: 'Run asynchronously and return a task ID',
        default: true,
        type: 'boolean',
      },
      name: {
        description: 'Name for the spawned agent',
        type: 'string',
        pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
      },
      team_name: {
        description: 'Deprecated; ignored',
        type: 'string',
      },
      mode: {
        description: 'Permission mode for the spawned agent',
        type: 'string',
        enum: [
          'acceptEdits',
          'auto',
          'bypassPermissions',
          'default',
          'dontAsk',
          'plan',
        ],
      },
      isolation: {
        description: 'Optional worktree isolation',
        type: 'string',
        enum: ['worktree'],
      },
    },
    required: ['description', 'prompt'],
    additionalProperties: false,
  },
}

const TASK_OUTPUT_DEFINITION: ModelToolDefinition = {
  name: 'TaskOutput',
  description:
    'Retrieve output and status from a running or completed background agent.',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      task_id: { description: 'Background task ID', type: 'string' },
      block: {
        description: 'Wait for completion',
        default: true,
        type: 'boolean',
      },
      timeout: {
        description: 'Maximum wait in milliseconds',
        default: 30000,
        type: 'number',
        minimum: 0,
        maximum: 600000,
      },
    },
    required: ['task_id', 'block', 'timeout'],
    additionalProperties: false,
  },
}

export interface PraxisMcpAgentRunResult {
  sessionId: string
  text: string
}

export interface PraxisMcpAgentService {
  run(
    prompt: string,
    signal?: AbortSignal,
    sessionId?: string,
    name?: string,
  ): Promise<PraxisMcpAgentRunResult>
  close?(): Promise<void>
}

export interface PraxisMcpAgentServiceOptions {
  agent?: string
  model?: string
  permissionMode?:
    | 'acceptEdits'
    | 'auto'
    | 'bypassPermissions'
    | 'default'
    | 'dontAsk'
    | 'plan'
  worktree?: boolean
  eventSink: (event: RuntimeEvent) => void
}

export interface PraxisMcpToolRegistry extends ToolRegistry {
  close?(): Promise<void>
}

export interface PraxisMcpServerOptions {
  cwd: string
  createAgentService?: (
    options: PraxisMcpAgentServiceOptions,
  ) => Promise<PraxisMcpAgentService>
  createToolRegistry?: () => Promise<PraxisMcpToolRegistry | undefined>
  debug?: boolean
  verbose?: boolean
  signal?: AbortSignal
  writeError?: (message: string) => void
}

interface AgentInput {
  description: string
  prompt: string
  agent?: string
  model?: string
  name?: string
  permissionMode?: PraxisMcpAgentServiceOptions['permissionMode']
  worktree: boolean
  background: boolean
}

interface BackgroundTask {
  id: string
  controller: AbortController
  startedAt: number
  promise: Promise<PraxisMcpAgentRunResult>
  result?: PraxisMcpAgentRunResult
  error?: Error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(input: Record<string, unknown>, name: string): string {
  const value = input[name]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function optionalString(
  input: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = input[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
}

function parseAgentInput(input: Record<string, unknown>): AgentInput {
  const allowed = new Set([
    'description',
    'prompt',
    'subagent_type',
    'model',
    'run_in_background',
    'name',
    'team_name',
    'mode',
    'isolation',
  ])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unknown Agent input field ${key}`)
  }
  const background = input.run_in_background
  if (background !== undefined && typeof background !== 'boolean') {
    throw new Error('run_in_background must be a boolean')
  }
  const agent = optionalString(input, 'subagent_type')
  const model = optionalString(input, 'model')
  const name = optionalString(input, 'name')
  if (name && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(name)) {
    throw new Error('name must be a valid agent name')
  }
  if (input.team_name !== undefined && typeof input.team_name !== 'string') {
    throw new Error('team_name must be a string')
  }
  const permissionMode = optionalString(input, 'mode')
  if (
    permissionMode &&
    ![
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
    ].includes(permissionMode)
  ) {
    throw new Error('mode is not a supported permission mode')
  }
  const isolation = optionalString(input, 'isolation')
  if (isolation && isolation !== 'worktree') {
    throw new Error(`Praxis does not support Agent isolation ${isolation}`)
  }
  return {
    description: requiredString(input, 'description'),
    prompt: requiredString(input, 'prompt'),
    ...(agent && agent !== 'general-purpose' ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(name ? { name } : {}),
    ...(permissionMode
      ? {
          permissionMode:
            permissionMode as PraxisMcpAgentServiceOptions['permissionMode'],
        }
      : {}),
    worktree: isolation === 'worktree',
    background: background !== false,
  }
}

function taskOutputInput(input: Record<string, unknown>): {
  id: string
  block: boolean
  timeout: number
} {
  const block = input.block
  if (block !== undefined && typeof block !== 'boolean') {
    throw new Error('block must be a boolean')
  }
  const timeout = input.timeout ?? 30_000
  if (
    typeof timeout !== 'number' ||
    !Number.isFinite(timeout) ||
    timeout < 0 ||
    timeout > 600_000
  ) {
    throw new Error('timeout must be between 0 and 600000 milliseconds')
  }
  return {
    id: requiredString(input, 'task_id'),
    block: block !== false,
    timeout,
  }
}

function mcpContent(result: ToolExecutionResult) {
  const content: (
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  )[] = []
  const nativeType = result.nativeToolUseResult?.type
  if (nativeType === 'text' || nativeType === 'pdf' || nativeType === 'parts') {
    return [
      {
        type: 'text',
        text: JSON.stringify(result.nativeToolUseResult),
      },
    ]
  }
  if (result.content.length > 0 || !result.images?.length) {
    content.push({ type: 'text', text: result.content })
  }
  for (const image of result.images ?? []) {
    content.push({
      type: 'image',
      data: image.data,
      mimeType: image.mediaType,
    })
  }
  return content
}

function hostedAgentDefinition(
  definition: ModelToolDefinition,
): ModelToolDefinition {
  if (definition.name !== 'Agent') return definition
  const schema = definition.inputSchema
  const properties = isRecord(schema.properties) ? schema.properties : {}
  return {
    ...definition,
    inputSchema: {
      ...schema,
      properties: {
        ...properties,
        name: {
          description:
            'Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.',
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$',
        },
        team_name: {
          description:
            'Deprecated; ignored. The session has a single implicit team.',
          type: 'string',
        },
        mode: {
          description:
            'Permission mode for spawned teammate (e.g., "plan" to require plan approval).',
          type: 'string',
          enum: [
            'acceptEdits',
            'auto',
            'bypassPermissions',
            'default',
            'dontAsk',
            'plan',
          ],
        },
      },
    },
  }
}

class PraxisMcpRuntime {
  readonly localTools: LocalToolRegistry
  private readonly tasks = new Map<string, BackgroundTask>()
  private readonly sensitiveValues = sensitiveEnvironmentValues(process.env)
  private readonly toolRegistryPromise: Promise<
    PraxisMcpToolRegistry | undefined
  >
  private closed = false

  constructor(private readonly options: PraxisMcpServerOptions) {
    this.localTools = new LocalToolRegistry({
      cwd: options.cwd,
      enableReportFindings: true,
    })
    this.toolRegistryPromise =
      options.createToolRegistry?.() ?? Promise.resolve(undefined)
  }

  async definitions(): Promise<readonly ModelToolDefinition[]> {
    const preferredOrder = [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'NotebookEdit',
      'Glob',
      'Grep',
    ]
    const registry = await this.toolRegistryPromise
    const shared = (
      registry
        ? [...registry.definitions()]
        : [...this.localTools.definitions()].sort((left, right) => {
            const leftIndex = preferredOrder.indexOf(left.name)
            const rightIndex = preferredOrder.indexOf(right.name)
            return (
              (leftIndex < 0 ? preferredOrder.length : leftIndex) -
              (rightIndex < 0 ? preferredOrder.length : rightIndex)
            )
          })
    ).map(hostedAgentDefinition)
    if (!this.options.createAgentService) return shared
    const sharedNames = new Set(shared.map((definition) => definition.name))
    return [
      ...(sharedNames.has(AGENT_DEFINITION.name) ? [] : [AGENT_DEFINITION]),
      ...(sharedNames.has(TASK_OUTPUT_DEFINITION.name)
        ? []
        : [TASK_OUTPUT_DEFINITION]),
      ...shared,
    ]
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (this.closed) throw new Error('Praxis MCP server is closed')
    const registry = (await this.toolRegistryPromise) ?? this.localTools
    const sharedNames = new Set(
      registry.definitions().map((definition) => definition.name),
    )
    if (
      name === 'Agent' &&
      this.options.createAgentService &&
      !sharedNames.has(name)
    ) {
      return this.executeAgent(input, signal)
    }
    if (
      name === 'TaskOutput' &&
      this.options.createAgentService &&
      !sharedNames.has(name)
    ) {
      return this.taskOutput(input)
    }
    if (!sharedNames.has(name)) {
      throw new Error(`Unknown tool: ${name}`)
    }
    const call: ModelToolCall = { id: randomUUID(), name, input }
    const context: ToolExecutionContext = {
      cwd: this.options.cwd,
      ...(signal ? { signal } : {}),
    }
    const prepared = await registry.prepare(call, context)
    return registry.execute(prepared, context)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const task of this.tasks.values()) task.controller.abort()
    await Promise.allSettled(
      [...this.tasks.values()].map((task) => task.promise),
    )
    await (await this.toolRegistryPromise)?.close?.()
  }

  log(message: string): void {
    if (!this.options.debug && !this.options.verbose) return
    this.options.writeError?.(
      `${redactSensitiveText(message, this.sensitiveValues)}\n`,
    )
  }

  private safeText(text: string): string {
    return redactSensitiveText(text, this.sensitiveValues)
  }

  private safeError(error: unknown): Error {
    return new Error(
      this.safeText(error instanceof Error ? error.message : String(error)),
    )
  }

  private async executeAgent(
    value: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> {
    if (!this.options.createAgentService) {
      throw new Error('Agent service is unavailable')
    }
    const input = parseAgentInput(value)
    if (!input.background) {
      const result = await this.runAgent(input, signal)
      return {
        content: `${result.text}\n\nsessionId: ${result.sessionId}`,
        isError: false,
      }
    }
    this.pruneTasks()
    const id = `agent-${randomBytes(8).toString('hex')}`
    const controller = new AbortController()
    const task: BackgroundTask = {
      id,
      controller,
      startedAt: Date.now(),
      promise: Promise.resolve({ sessionId: '', text: '' }),
    }
    task.promise = this.runAgent(input, controller.signal).then(
      (result) => {
        task.result = result
        return result
      },
      (error: unknown) => {
        task.error = this.safeError(error)
        throw task.error
      },
    )
    void task.promise.catch(() => undefined)
    this.tasks.set(id, task)
    return {
      content: `Agent launched in background. task_id: ${id}`,
      isError: false,
      nativeToolUseResult: { task_id: id, status: 'running' },
    }
  }

  private async runAgent(
    input: AgentInput,
    signal?: AbortSignal,
  ): Promise<PraxisMcpAgentRunResult> {
    const createService = this.options.createAgentService
    if (!createService) throw new Error('Agent service is unavailable')
    const service = await createService({
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      ...(input.worktree ? { worktree: true } : {}),
      eventSink: (event) => {
        if (event.type === 'warning' || event.type === 'failed') {
          this.log(`Agent ${event.type}: ${event.message}`)
        }
      },
    })
    try {
      const result = await service.run(
        input.prompt,
        signal,
        undefined,
        input.name ?? input.description,
      )
      return { ...result, text: this.safeText(result.text) }
    } finally {
      await service.close?.()
    }
  }

  private async taskOutput(
    value: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const input = taskOutputInput(value)
    const task = this.tasks.get(input.id)
    if (!task) throw new Error(`Background task not found: ${input.id}`)
    if (!task.result && !task.error && input.block) {
      let timeout: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          task.promise.catch(() => undefined),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, input.timeout)
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }
    if (task.error) {
      return {
        content: `Task ${task.id} failed: ${this.safeText(task.error.message)}`,
        isError: true,
      }
    }
    if (task.result) {
      return {
        content: `${this.safeText(task.result.text)}\n\nsessionId: ${task.result.sessionId}`,
        isError: false,
        nativeToolUseResult: { task_id: task.id, status: 'completed' },
      }
    }
    return {
      content: `Task ${task.id} is still running.`,
      isError: false,
      nativeToolUseResult: { task_id: task.id, status: 'running' },
    }
  }

  private pruneTasks(): void {
    if (this.tasks.size < MAX_BACKGROUND_TASKS) return
    const completed = [...this.tasks.values()]
      .filter((task) => task.result || task.error)
      .sort((left, right) => left.startedAt - right.startedAt)
    for (const task of completed) {
      this.tasks.delete(task.id)
      if (this.tasks.size < MAX_BACKGROUND_TASKS) return
    }
    if (this.tasks.size >= MAX_BACKGROUND_TASKS) {
      throw new Error(
        `Background Agent limit reached (${MAX_BACKGROUND_TASKS})`,
      )
    }
  }
}

export function createPraxisMcpServer(options: PraxisMcpServerOptions): {
  server: Server
  close: () => Promise<void>
} {
  const runtime = new PraxisMcpRuntime(options)
  const server = new Server(
    { name: 'praxis-agent', version: VERSION },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (await runtime.definitions()).map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    runtime.log(`MCP tool call: ${name}`)
    try {
      const input = isRecord(request.params.arguments)
        ? request.params.arguments
        : {}
      const result = await runtime.execute(name, input, extra.signal)
      return { content: mcpContent(result), isError: result.isError }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      runtime.log(`MCP tool error (${name}): ${message}`)
      return {
        content: [
          {
            type: 'text' as const,
            text: redactSensitiveText(
              message,
              sensitiveEnvironmentValues(process.env),
            ),
          },
        ],
        isError: true,
      }
    }
  })
  let closed = false
  return {
    server,
    close: async () => {
      if (closed) return
      closed = true
      await runtime.close()
      await server.close()
    },
  }
}

export async function servePraxisMcpStdio(
  options: PraxisMcpServerOptions,
): Promise<void> {
  const hosted = createPraxisMcpServer(options)
  const sensitiveValues = sensitiveEnvironmentValues(process.env)
  const transport = new StdioServerTransport()
  let resolveClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  hosted.server.onclose = resolveClosed
  hosted.server.onerror = (error) => {
    options.writeError?.(
      `MCP server error: ${redactSensitiveText(error.message, sensitiveValues)}\n`,
    )
  }
  const abort = () => void hosted.close()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    await hosted.server.connect(transport)
    if (options.signal?.aborted) await hosted.close()
    await closed
  } finally {
    options.signal?.removeEventListener('abort', abort)
    await hosted.close()
  }
}
