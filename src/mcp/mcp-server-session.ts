import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  CallToolRequest,
  GetPromptRequest,
  ReadResourceRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { PromptListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'

export const DEFAULT_MCP_CONNECTION_TIMEOUT_MS = 10_000
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 60_000

export function parseMcpSessionTimeouts(environment: NodeJS.ProcessEnv): {
  connectionTimeoutMs: number
  toolTimeoutMs: number
} {
  const parse = (name: string, fallback: number): number => {
    const raw = environment[name]
    if (raw === undefined) return fallback
    if (!/^\d+$/u.test(raw)) {
      throw new Error(`${name} must be a positive safe integer`)
    }
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`)
    }
    return value
  }
  return {
    connectionTimeoutMs: parse(
      'MCP_TIMEOUT',
      DEFAULT_MCP_CONNECTION_TIMEOUT_MS,
    ),
    toolTimeoutMs: parse('MCP_TOOL_TIMEOUT', DEFAULT_MCP_TOOL_TIMEOUT_MS),
  }
}

export interface McpSessionTool {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

export type McpSessionResource = Record<string, unknown>

export interface McpSessionPrompt {
  name: string
  description?: string
  arguments?: readonly {
    name: string
    description?: string
    required?: boolean
  }[]
}

export interface McpServerCatalog {
  capabilities: readonly ('tools' | 'resources' | 'prompts')[]
  instructions?: string
  tools: readonly McpSessionTool[]
  resources: readonly McpSessionResource[]
  prompts: readonly McpSessionPrompt[]
}

type ClientToolResult = Awaited<ReturnType<Client['callTool']>>
type ClientResourceResult = Awaited<ReturnType<Client['readResource']>>
type ClientPromptResult = Awaited<ReturnType<Client['getPrompt']>>

export interface McpServerSessionOptions {
  serverName: string
  connectionTimeoutMs: number
  toolTimeoutMs: number
  lifetimeSignal?: AbortSignal
  createTransport: () => Promise<Transport>
  configureClient?: (client: Client) => void
  onDisconnected: () => void
  onCatalogChanged: (catalog: McpServerCatalog) => void
  onDiscoveryWarning: (
    kind: 'tools' | 'resources' | 'prompts',
    error: unknown,
  ) => void
}

interface Attempt {
  client: Client
  transport: Transport
  generation: number
  disconnected: boolean
}

function timeoutError(serverName: string, timeout: number): Error {
  return new Error(
    `MCP server ${serverName} connection timed out after ${timeout}ms`,
  )
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  )
}

function composedSignal(signals: readonly AbortSignal[]): AbortSignal {
  return AbortSignal.any([...signals])
}

function raceWithDeadline<T>(
  operationFactory: () => Promise<T>,
  signal: AbortSignal,
  error: Error,
): Promise<T> {
  return raceOperation(
    operationFactory,
    undefined,
    error,
    signal,
    () => undefined,
  )
}

function raceOperation<T>(
  operationFactory: () => Promise<T>,
  timeoutMs: number | undefined,
  timeout: Error,
  callerSignal: AbortSignal | undefined,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => {
      if (!callerSignal) return
      finish(() => {
        reject(abortReason(callerSignal))
      })
      onTimeout()
    }
    if (callerSignal?.aborted) {
      onAbort()
      return
    }
    if (callerSignal) {
      callerSignal.addEventListener('abort', onAbort, { once: true })
    }
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        finish(() => reject(timeout))
        onTimeout()
      }, timeoutMs)
    }
    let operation: Promise<T>
    try {
      operation = operationFactory()
    } catch (error) {
      finish(() => reject(error))
      return
    }
    void Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })
}

function boundedCleanup(
  operation: Promise<void>,
  boundMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, boundMs)
    void operation.then(finish, finish)
  })
}

export class McpServerSession {
  private current: Attempt | undefined
  private currentCatalog: McpServerCatalog | undefined
  private generation = 0
  private closed = false
  private reconnectPromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private readonly shutdownController = new AbortController()
  private readonly owned = new Set<Attempt>()
  private readonly pendingDisposals = new Set<Promise<void>>()

  constructor(private readonly options: McpServerSessionOptions) {}

  async connect(): Promise<void> {
    if (this.closed) throw new Error('MCP session is closed')
    if (this.current) return
    await this.runAttempt()
  }

  reconnect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MCP session is closed'))
    if (this.current) return Promise.resolve()
    if (this.reconnectPromise) return this.reconnectPromise
    const run = this.runReconnect()
    this.reconnectPromise = run
    void run.then(
      () => {
        if (this.reconnectPromise === run) this.reconnectPromise = undefined
      },
      () => {
        if (this.reconnectPromise === run) this.reconnectPromise = undefined
      },
    )
    return run
  }

  isConnected(): boolean {
    return this.current !== undefined && !this.closed
  }

  catalog(): McpServerCatalog | undefined {
    return this.currentCatalog
  }

  async callTool(
    params: CallToolRequest['params'],
    signal?: AbortSignal,
  ): Promise<ClientToolResult> {
    await this.ensureConnected(signal)
    const attempt = this.current
    if (!attempt)
      throw new Error(`MCP server ${this.options.serverName} is not connected`)
    if (!this.currentCatalog?.tools.some((tool) => tool.name === params.name)) {
      throw new Error(`MCP tool ${params.name} is unavailable after reconnect`)
    }
    if (signal?.aborted) throw abortReason(signal)
    const timeoutController = new AbortController()
    const combined = signal
      ? composedSignal([signal, timeoutController.signal])
      : timeoutController.signal
    const options = {
      timeout: this.options.toolTimeoutMs,
      maxTotalTimeout: this.options.toolTimeoutMs,
      signal: combined,
    }
    return raceOperation(
      () => attempt.client.callTool(params, undefined, options),
      this.options.toolTimeoutMs,
      new Error(
        `MCP tool call ${this.options.serverName}:${params.name} timed out after ${this.options.toolTimeoutMs}ms`,
      ),
      signal,
      () => timeoutController.abort(),
    )
  }

  async readResource(
    params: ReadResourceRequest['params'],
    signal?: AbortSignal,
  ): Promise<ClientResourceResult> {
    await this.ensureConnected(signal)
    const attempt = this.current
    if (!attempt)
      throw new Error(`MCP server ${this.options.serverName} is not connected`)
    const timeoutController = new AbortController()
    const combined = signal
      ? composedSignal([signal, timeoutController.signal])
      : timeoutController.signal
    return raceOperation(
      () =>
        attempt.client.readResource(params, {
          timeout: 30_000,
          maxTotalTimeout: 30_000,
          signal: combined,
        }),
      30_000,
      new Error(
        `MCP server ${this.options.serverName} resource operation timed out after 30000ms`,
      ),
      signal,
      () => timeoutController.abort(),
    )
  }

  async getPrompt(
    params: GetPromptRequest['params'],
    signal?: AbortSignal,
  ): Promise<ClientPromptResult> {
    await this.ensureConnected(signal)
    const attempt = this.current
    if (!attempt)
      throw new Error(`MCP server ${this.options.serverName} is not connected`)
    const timeoutController = new AbortController()
    const combined = signal
      ? composedSignal([signal, timeoutController.signal])
      : timeoutController.signal
    return raceOperation(
      () =>
        attempt.client.getPrompt(params, {
          timeout: 30_000,
          maxTotalTimeout: 30_000,
          signal: combined,
        }),
      30_000,
      new Error(
        `MCP server ${this.options.serverName} prompt operation timed out after 30000ms`,
      ),
      signal,
      () => timeoutController.abort(),
    )
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    this.generation += 1
    this.shutdownController.abort(new Error('MCP session is closed'))
    this.closePromise = this.finishClose()
    return this.closePromise
  }

  private async ensureConnected(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortReason(signal)
    if (this.current) return
    const reconnect = this.reconnect()
    if (!signal) return reconnect
    await raceOperation(
      () => reconnect,
      undefined,
      new Error('unreachable'),
      signal,
      () => undefined,
    )
  }

  private async runReconnect(): Promise<void> {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.closed) throw new Error('MCP session is closed')
      if (attempt > 0) await this.delay(attempt === 1 ? 250 : 500)
      try {
        await this.runAttempt()
        return
      } catch (error) {
        lastError = error
        if (this.closed) throw error
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        for (const signal of signals)
          signal.removeEventListener('abort', onAbort)
        resolve()
      }, milliseconds)
      const signals = [
        this.options.lifetimeSignal,
        this.shutdownController.signal,
      ].filter((signal): signal is AbortSignal => signal !== undefined)
      const onAbort = () => {
        clearTimeout(timer)
        for (const signal of signals)
          signal.removeEventListener('abort', onAbort)
        const aborted = signals.find((signal) => signal.aborted)
        reject(aborted ? abortReason(aborted) : new Error('MCP session closed'))
      }
      for (const signal of signals) {
        if (signal.aborted) return onAbort()
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  private async runAttempt(): Promise<void> {
    const generation = this.generation
    const controller = new AbortController()
    const lifetime = this.options.lifetimeSignal
    const signals = lifetime
      ? [controller.signal, lifetime, this.shutdownController.signal]
      : [controller.signal, this.shutdownController.signal]
    const signal = composedSignal(signals)
    const deadline = Date.now() + this.options.connectionTimeoutMs
    const timeout = timeoutError(
      this.options.serverName,
      this.options.connectionTimeoutMs,
    )
    const timer = setTimeout(
      () => controller.abort(timeout),
      this.options.connectionTimeoutMs,
    )
    let attempt: Attempt | undefined
    try {
      const transport = await raceWithDeadline(
        () => {
          const transportPromise = this.options.createTransport()
          void transportPromise.then(
            (lateTransport) => {
              if (signal.aborted)
                void lateTransport.close().catch(() => undefined)
            },
            () => undefined,
          )
          return transportPromise
        },
        signal,
        timeout,
      )
      const client = new Client(
        { name: 'praxis', version: '0.1.0' },
        {
          capabilities: {
            elicitation: { form: { applyDefaults: true }, url: {} },
          },
        },
      )
      attempt = { client, transport, generation, disconnected: false }
      const activeAttempt = attempt
      this.owned.add(attempt)
      transport.onclose = () => {
        if (attempt) this.disconnected(attempt)
      }
      this.options.configureClient?.(client)
      if (transport instanceof StdioClientTransport) {
        const stderr = transport.stderr
        if (
          stderr &&
          'resume' in stderr &&
          typeof stderr.resume === 'function'
        ) {
          stderr.resume()
        }
      }
      await raceWithDeadline(
        () =>
          client.connect(transport, {
            timeout: this.remaining(deadline),
            maxTotalTimeout: this.remaining(deadline),
            signal,
          }),
        signal,
        timeout,
      )
      const capabilities = client.getServerCapabilities()
      const tools = capabilities?.tools
        ? await this.discoverTools(client, signal, deadline)
        : []
      const resources = capabilities?.resources
        ? await this.discoverResources(client, signal, deadline)
        : []
      const prompts = capabilities?.prompts
        ? await this.discoverPrompts(client, signal, deadline)
        : []
      const instruction = client.getInstructions()?.trim()
      const catalog: McpServerCatalog = {
        capabilities: [
          ...(capabilities?.tools ? (['tools'] as const) : []),
          ...(capabilities?.resources ? (['resources'] as const) : []),
          ...(capabilities?.prompts ? (['prompts'] as const) : []),
        ],
        ...(instruction ? { instructions: instruction } : {}),
        tools,
        resources,
        prompts,
      }
      if (attempt.disconnected)
        throw new Error(
          `MCP server ${this.options.serverName} disconnected during connection`,
        )
      if (this.closed || generation !== this.generation || signal.aborted)
        throw (
          signal.reason ??
          timeoutError(
            this.options.serverName,
            this.options.connectionTimeoutMs,
          )
        )
      this.current = attempt
      this.currentCatalog = catalog
      if (capabilities?.prompts?.listChanged) {
        client.setNotificationHandler(
          PromptListChangedNotificationSchema,
          async () => {
            if (this.current !== activeAttempt || this.closed) return
            try {
              const refreshed = await this.refreshPrompts(client, activeAttempt)
              if (this.current !== activeAttempt || !this.currentCatalog) return
              this.currentCatalog = {
                ...this.currentCatalog,
                prompts: refreshed,
              }
              this.options.onCatalogChanged(this.currentCatalog)
            } catch (error) {
              if (this.current === activeAttempt && !this.closed)
                this.options.onDiscoveryWarning('prompts', error)
            }
          },
        )
      }
      this.options.onCatalogChanged(catalog)
    } catch (error) {
      if (this.current === attempt) {
        this.current = undefined
        this.currentCatalog = undefined
      }
      if (attempt) {
        const disposal = this.disposeAttempt(attempt)
        this.pendingDisposals.add(disposal)
        void disposal.then(
          () => this.pendingDisposals.delete(disposal),
          () => this.pendingDisposals.delete(disposal),
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private remaining(deadline: number): number {
    return Math.max(1, deadline - Date.now())
  }

  private async discoverTools(
    client: Client,
    signal: AbortSignal,
    deadline: number,
  ): Promise<readonly McpSessionTool[]> {
    const result: McpSessionTool[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 100; page += 1) {
      if (Date.now() >= deadline)
        throw timeoutError(
          this.options.serverName,
          this.options.connectionTimeoutMs,
        )
      if (cursor && seen.has(cursor))
        throw new Error('Repeated MCP tools cursor')
      if (cursor) seen.add(cursor)
      let response: Awaited<ReturnType<Client['listTools']>>
      try {
        response = await raceWithDeadline(
          () =>
            client.listTools(cursor ? { cursor } : undefined, {
              timeout: this.remaining(deadline),
              maxTotalTimeout: this.remaining(deadline),
              signal,
            }),
          signal,
          timeoutError(
            this.options.serverName,
            this.options.connectionTimeoutMs,
          ),
        )
      } catch (error) {
        if (signal.aborted) throw error
        this.options.onDiscoveryWarning('tools', error)
        return []
      }
      result.push(
        ...response.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined
            ? {}
            : { description: tool.description }),
          inputSchema: tool.inputSchema,
          ...(tool.annotations === undefined
            ? {}
            : { annotations: tool.annotations }),
        })),
      )
      if (result.length > 10_000) throw new Error('MCP tool limit exceeded')
      cursor = response.nextCursor
      if (!cursor) return result
    }
    throw new Error('MCP tools page limit exceeded')
  }

  private async discoverResources(
    client: Client,
    signal: AbortSignal,
    deadline: number,
  ): Promise<readonly McpSessionResource[]> {
    const result: McpSessionResource[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 100; page += 1) {
      if (Date.now() >= deadline)
        throw timeoutError(
          this.options.serverName,
          this.options.connectionTimeoutMs,
        )
      if (cursor && seen.has(cursor))
        throw new Error('Repeated MCP resources cursor')
      if (cursor) seen.add(cursor)
      let response: Awaited<ReturnType<Client['listResources']>>
      try {
        response = await raceWithDeadline(
          () =>
            client.listResources(cursor ? { cursor } : undefined, {
              timeout: this.remaining(deadline),
              maxTotalTimeout: this.remaining(deadline),
              signal,
            }),
          signal,
          timeoutError(
            this.options.serverName,
            this.options.connectionTimeoutMs,
          ),
        )
      } catch (error) {
        if (signal.aborted) throw error
        this.options.onDiscoveryWarning('resources', error)
        return []
      }
      result.push(...response.resources.map((resource) => ({ ...resource })))
      if (result.length > 10_000) throw new Error('MCP resource limit exceeded')
      cursor = response.nextCursor
      if (!cursor) return result
    }
    throw new Error('MCP resources page limit exceeded')
  }

  private async discoverPrompts(
    client: Client,
    signal: AbortSignal,
    deadline: number,
  ): Promise<readonly McpSessionPrompt[]> {
    const result: McpSessionPrompt[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < 100; page += 1) {
      if (Date.now() >= deadline)
        throw timeoutError(
          this.options.serverName,
          this.options.connectionTimeoutMs,
        )
      if (cursor && seen.has(cursor))
        throw new Error('Repeated MCP prompts cursor')
      if (cursor) seen.add(cursor)
      let response: Awaited<ReturnType<Client['listPrompts']>>
      try {
        response = await raceWithDeadline(
          () =>
            client.listPrompts(cursor ? { cursor } : undefined, {
              timeout: this.remaining(deadline),
              maxTotalTimeout: this.remaining(deadline),
              signal,
            }),
          signal,
          timeoutError(
            this.options.serverName,
            this.options.connectionTimeoutMs,
          ),
        )
      } catch (error) {
        if (signal.aborted) throw error
        this.options.onDiscoveryWarning('prompts', error)
        return []
      }
      result.push(
        ...response.prompts.map((prompt) => ({
          name: prompt.name,
          ...(prompt.description === undefined
            ? {}
            : { description: prompt.description }),
          ...(prompt.arguments === undefined
            ? {}
            : {
                arguments: prompt.arguments.map((argument) => ({
                  name: argument.name,
                  ...(argument.description === undefined
                    ? {}
                    : { description: argument.description }),
                  ...(argument.required === undefined
                    ? {}
                    : { required: argument.required }),
                })),
              }),
        })),
      )
      if (result.length > 10_000) throw new Error('MCP prompt limit exceeded')
      cursor = response.nextCursor
      if (!cursor) return result
    }
    throw new Error('MCP prompts page limit exceeded')
  }

  private async refreshPrompts(
    client: Client,
    attempt: Attempt,
  ): Promise<readonly McpSessionPrompt[]> {
    const deadline = Date.now() + 30_000
    const controller = new AbortController()
    const timeout = new Error(
      `MCP server ${this.options.serverName} prompt refresh timed out after 30000ms`,
    )
    const timer = setTimeout(() => controller.abort(timeout), 30_000)
    const signals = [
      controller.signal,
      this.shutdownController.signal,
      ...(this.options.lifetimeSignal ? [this.options.lifetimeSignal] : []),
    ]
    const signal = composedSignal(signals)
    const result: McpSessionPrompt[] = []
    let cursor: string | undefined
    const seen = new Set<string>()
    try {
      for (let page = 0; page < 100; page += 1) {
        if (Date.now() >= deadline) throw timeout
        if (cursor && seen.has(cursor))
          throw new Error('Repeated MCP prompts cursor')
        if (cursor) seen.add(cursor)
        const response = await raceWithDeadline(
          () =>
            client.listPrompts(cursor ? { cursor } : undefined, {
              timeout: this.remaining(deadline),
              maxTotalTimeout: this.remaining(deadline),
              signal,
            }),
          signal,
          timeout,
        )
        if (this.closed || this.current !== attempt) throw abortReason(signal)
        result.push(
          ...response.prompts.map((prompt) => ({
            name: prompt.name,
            ...(prompt.description === undefined
              ? {}
              : { description: prompt.description }),
            ...(prompt.arguments === undefined
              ? {}
              : {
                  arguments: prompt.arguments.map((argument) => ({
                    name: argument.name,
                    ...(argument.description === undefined
                      ? {}
                      : { description: argument.description }),
                    ...(argument.required === undefined
                      ? {}
                      : { required: argument.required }),
                  })),
                }),
          })),
        )
        if (result.length > 10_000) throw new Error('MCP prompt limit exceeded')
        cursor = response.nextCursor
        if (!cursor) return result
      }
      throw new Error('MCP prompts page limit exceeded')
    } finally {
      clearTimeout(timer)
    }
  }

  private disconnected(attempt: Attempt): void {
    attempt.disconnected = true
    if (this.current !== attempt || this.closed) return
    this.current = undefined
    this.currentCatalog = undefined
    this.owned.delete(attempt)
    this.options.onDisconnected()
  }

  private async disposeAttempt(attempt: Attempt): Promise<void> {
    if (!this.owned.has(attempt)) return
    this.owned.delete(attempt)
    await boundedCleanup(
      Promise.allSettled([
        attempt.client.close().catch(() => undefined),
        attempt.transport.close().catch(() => undefined),
      ]).then(() => undefined),
      this.options.connectionTimeoutMs,
    )
  }

  private async finishClose(): Promise<void> {
    const attempts = [...this.owned]
    const disposals = [...this.pendingDisposals]
    await boundedCleanup(
      Promise.allSettled([
        ...attempts.map((attempt) => this.disposeAttempt(attempt)),
        ...disposals,
      ]).then(() => undefined),
      this.options.connectionTimeoutMs,
    )
    this.current = undefined
    this.currentCatalog = undefined
  }
}
