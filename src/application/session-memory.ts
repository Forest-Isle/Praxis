import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { ModelMessage } from '../core/runtime.js'
import { isClaudeSessionId } from '../compatibility/claude/paths.js'
import { writeFileAtomically } from '../platform/atomic-write.js'

/** Versioned, explicit progress state for one session's extracted memory. */
export interface SessionMemoryState {
  schemaVersion: 1
  initialized: boolean
  lastObservedTokens: number
  lastObservedToolCalls: number
  lastSummarizedMessageId: string | null
  extractionStartedAt: number | null
  extractionCompletedAt: number | null
  extractionError: string | null
}

export class SessionMemoryStateError extends Error {
  override readonly name = 'SessionMemoryStateError'

  constructor(message: string) {
    super(message)
  }
}

export class SessionMemoryTimeoutError extends Error {
  override readonly name = 'SessionMemoryTimeoutError'

  constructor(message: string) {
    super(message)
  }
}

export function createFreshSessionMemoryState(): SessionMemoryState {
  return {
    schemaVersion: 1,
    initialized: false,
    lastObservedTokens: 0,
    lastObservedToolCalls: 0,
    lastSummarizedMessageId: null,
    extractionStartedAt: null,
    extractionCompletedAt: null,
    extractionError: null,
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNullableTimestamp(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  )
}

function assertValidSessionMemoryState(
  value: unknown,
): asserts value is SessionMemoryState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SessionMemoryStateError('Session memory state must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) {
    throw new SessionMemoryStateError(
      `Unsupported session memory schema version: ${String(record.schemaVersion)}`,
    )
  }
  if (typeof record.initialized !== 'boolean') {
    throw new SessionMemoryStateError(
      'Session memory state initialized must be a boolean',
    )
  }
  if (!isNonNegativeSafeInteger(record.lastObservedTokens)) {
    throw new SessionMemoryStateError(
      'Session memory state lastObservedTokens must be a non-negative safe integer',
    )
  }
  if (!isNonNegativeSafeInteger(record.lastObservedToolCalls)) {
    throw new SessionMemoryStateError(
      'Session memory state lastObservedToolCalls must be a non-negative safe integer',
    )
  }
  if (
    record.lastSummarizedMessageId !== null &&
    typeof record.lastSummarizedMessageId !== 'string'
  ) {
    throw new SessionMemoryStateError(
      'Session memory state lastSummarizedMessageId must be a string or null',
    )
  }
  if (!isNullableTimestamp(record.extractionStartedAt)) {
    throw new SessionMemoryStateError(
      'Session memory state extractionStartedAt must be a non-negative timestamp or null',
    )
  }
  if (!isNullableTimestamp(record.extractionCompletedAt)) {
    throw new SessionMemoryStateError(
      'Session memory state extractionCompletedAt must be a non-negative timestamp or null',
    )
  }
  if (
    record.extractionError !== null &&
    typeof record.extractionError !== 'string'
  ) {
    throw new SessionMemoryStateError(
      'Session memory state extractionError must be a string or null',
    )
  }
}

function parseSessionMemoryState(source: string): SessionMemoryState {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new SessionMemoryStateError('Session memory state is not valid JSON')
  }
  assertValidSessionMemoryState(value)
  return value
}

export interface SessionMemoryStoreOptions {
  configRoot: string
  sessionId: string
  sidecarRoot?: string
}

/**
 * Durable sidecar for one session's extracted memory under
 * `<configRoot>/praxis/session-memory/<sessionId>/`. All writes are atomic
 * (same-directory temp file, fsync, then rename) and version-checked. Never
 * touches shared Claude transcript entries.
 */
export class SessionMemoryStore {
  private readonly directory: string
  private readonly stateFile: string
  private readonly summaryFile: string

  constructor(options: SessionMemoryStoreOptions) {
    if (
      typeof options.configRoot !== 'string' ||
      options.configRoot.length === 0
    ) {
      throw new SessionMemoryStateError(
        'Session memory configRoot must be a non-empty string',
      )
    }
    if (!isClaudeSessionId(options.sessionId)) {
      throw new SessionMemoryStateError(
        `Invalid session memory session ID: ${options.sessionId}`,
      )
    }
    this.directory = resolve(
      options.sidecarRoot ?? resolve(options.configRoot, 'praxis'),
      'session-memory',
      options.sessionId,
    )
    this.stateFile = join(this.directory, 'state.json')
    this.summaryFile = join(this.directory, 'summary.md')
  }

  async load(): Promise<SessionMemoryState> {
    let source: string
    try {
      source = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createFreshSessionMemoryState()
      }
      throw error
    }
    return parseSessionMemoryState(source)
  }

  async loadSummary(): Promise<string> {
    let source: string
    try {
      source = await readFile(this.summaryFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
    return source
  }

  async writeSummary(summary: string): Promise<void> {
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      throw new SessionMemoryStateError(
        'Session memory summary must be a non-empty string',
      )
    }
    await writeFileAtomically(this.summaryFile, summary)
  }

  async writeState(state: SessionMemoryState): Promise<void> {
    assertValidSessionMemoryState(state)
    const existing = await this.load()
    if (
      state.lastObservedTokens < existing.lastObservedTokens ||
      state.lastObservedToolCalls < existing.lastObservedToolCalls
    ) {
      throw new SessionMemoryStateError(
        'Session memory observed counters must be monotonic',
      )
    }
    await writeFileAtomically(
      this.stateFile,
      `${JSON.stringify(state, null, 2)}\n`,
    )
  }

  async clear(): Promise<void> {
    await Promise.all([
      rm(this.stateFile, { force: true }),
      rm(this.summaryFile, { force: true }),
    ])
  }
}

export interface SessionMemoryExtractorInput {
  summary: string
  tokens: number
  toolCalls: number
  messages?: readonly ModelMessage[]
}

export type SessionMemoryExtractor = (
  input: SessionMemoryExtractorInput,
) => Promise<string> | string

export interface SessionMemoryControllerOptions {
  store: SessionMemoryStore
  extractor: SessionMemoryExtractor
  initTokens?: number
  updateTokens?: number
  updateToolCalls?: number
  waitTimeoutMs?: number
}

/**
 * Serialized extraction lifecycle for one session. Concurrent callers of
 * `observe` share one in-flight extraction promise, so two extractors never
 * run for the same session. A persisted extraction that never completed is
 * marked failed on reopen and can be retried.
 */
export class SessionMemoryController {
  private readonly initTokens: number
  private readonly updateTokens: number
  private readonly updateToolCalls: number
  private readonly waitTimeoutMs: number
  private stateValue: SessionMemoryState | null = null
  private summaryValue = ''
  private inFlight: Promise<void> | null = null
  private loading: Promise<void> | null = null
  private observedTokens = 0
  private observedToolCalls = 0

  constructor(private readonly options: SessionMemoryControllerOptions) {
    this.initTokens = options.initTokens ?? 10_000
    this.updateTokens = options.updateTokens ?? 5_000
    this.updateToolCalls = options.updateToolCalls ?? 20
    this.waitTimeoutMs = options.waitTimeoutMs ?? 30_000
    for (const [name, value] of [
      ['initTokens', this.initTokens],
      ['updateTokens', this.updateTokens],
      ['updateToolCalls', this.updateToolCalls],
    ] as const) {
      if (!isNonNegativeSafeInteger(value) || value === 0) {
        throw new SessionMemoryStateError(
          `Session memory ${name} must be a positive safe integer`,
        )
      }
    }
    if (
      typeof this.waitTimeoutMs !== 'number' ||
      !Number.isFinite(this.waitTimeoutMs) ||
      this.waitTimeoutMs <= 0
    ) {
      throw new SessionMemoryStateError(
        'Session memory waitTimeoutMs must be a positive number',
      )
    }
  }

  async observe(
    tokens: number,
    toolCalls: number,
    messageId: string,
    messages?: readonly ModelMessage[],
  ): Promise<boolean> {
    await this.ensureLoaded()
    const state = this.stateValue
    if (state === null) {
      throw new SessionMemoryStateError('Session memory state is unavailable')
    }
    if (
      !isNonNegativeSafeInteger(tokens) ||
      !isNonNegativeSafeInteger(toolCalls)
    ) {
      throw new SessionMemoryStateError(
        'Session memory observed counters must be non-negative safe integers',
      )
    }
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new SessionMemoryStateError(
        'Session memory message ID must be a non-empty string',
      )
    }
    if (
      tokens < state.lastObservedTokens ||
      toolCalls < state.lastObservedToolCalls
    ) {
      throw new SessionMemoryStateError(
        `Session memory observed counters regressed (tokens ${tokens} < ${state.lastObservedTokens}, toolCalls ${toolCalls} < ${state.lastObservedToolCalls})`,
      )
    }
    this.observedTokens = Math.max(this.observedTokens, tokens)
    this.observedToolCalls = Math.max(this.observedToolCalls, toolCalls)
    if (!this.isExtractionDue(this.observedTokens, this.observedToolCalls)) {
      return false
    }
    if (this.inFlight === null) {
      const extraction = this.runExtraction(
        this.observedTokens,
        this.observedToolCalls,
        messageId,
        messages,
      )
      this.inFlight = extraction
      extraction
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight === extraction) this.inFlight = null
        })
    }
    return true
  }

  /**
   * Adds non-negative deltas to the current cumulative observed totals and
   * delegates to the serialized extraction path with those cumulative totals.
   * The persisted counters only advance once an extraction succeeds.
   */
  async observeDelta(
    inputTokens: number,
    toolCalls: number,
    messageId: string,
    messages?: readonly ModelMessage[],
  ): Promise<boolean> {
    await this.ensureLoaded()
    const state = this.stateValue
    if (state === null) {
      throw new SessionMemoryStateError('Session memory state is unavailable')
    }
    if (
      !isNonNegativeSafeInteger(inputTokens) ||
      !isNonNegativeSafeInteger(toolCalls)
    ) {
      throw new SessionMemoryStateError(
        'Session memory observed deltas must be non-negative safe integers',
      )
    }
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new SessionMemoryStateError(
        'Session memory message ID must be a non-empty string',
      )
    }
    this.observedTokens += inputTokens
    this.observedToolCalls += toolCalls
    return this.observe(
      this.observedTokens,
      this.observedToolCalls,
      messageId,
      messages,
    )
  }

  /** Safe snapshot of the loaded durable summary; empty when none exists. */
  async summary(): Promise<string> {
    await this.ensureLoaded()
    return this.summaryValue
  }

  /** Safe snapshot of the loaded session memory state. */
  async state(): Promise<SessionMemoryState> {
    await this.ensureLoaded()
    if (this.stateValue === null) {
      throw new SessionMemoryStateError('Session memory state is unavailable')
    }
    return { ...this.stateValue }
  }

  /** Resolves when no extraction is running; rejects on failure or timeout. */
  async waitForIdle(): Promise<void> {
    await this.ensureLoaded()
    const extraction = this.inFlight
    if (extraction === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new SessionMemoryTimeoutError(
              `Session memory extraction did not complete within ${this.waitTimeoutMs}ms`,
            ),
          ),
        this.waitTimeoutMs,
      )
    })
    try {
      await Promise.race([extraction, timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async clear(): Promise<void> {
    await this.ensureLoaded()
    if (this.inFlight !== null) {
      throw new SessionMemoryStateError(
        'Session memory cannot be cleared while extraction is in progress',
      )
    }
    await this.options.store.clear()
    const fresh = createFreshSessionMemoryState()
    this.stateValue = fresh
    this.observedTokens = fresh.lastObservedTokens
    this.observedToolCalls = fresh.lastObservedToolCalls
    this.summaryValue = ''
  }

  private ensureLoaded(): Promise<void> {
    if (this.loading !== null) return this.loading
    this.loading = this.loadState().catch((error: unknown) => {
      this.loading = null
      throw error
    })
    return this.loading
  }

  private async loadState(): Promise<void> {
    const [state, summary] = await Promise.all([
      this.options.store.load(),
      this.options.store.loadSummary(),
    ])
    if (
      state.extractionStartedAt !== null &&
      state.extractionCompletedAt === null
    ) {
      const elapsed = Date.now() - state.extractionStartedAt
      const recovered: SessionMemoryState = {
        ...state,
        extractionStartedAt: null,
        extractionCompletedAt: null,
        extractionError:
          elapsed >= this.waitTimeoutMs
            ? `Session memory extraction is stale after ${elapsed}ms`
            : 'Session memory extraction was interrupted',
      }
      await this.options.store.writeState(recovered)
      this.stateValue = recovered
    } else {
      this.stateValue = state
    }
    this.observedTokens = this.stateValue.lastObservedTokens
    this.observedToolCalls = this.stateValue.lastObservedToolCalls
    this.summaryValue = summary
  }

  private isExtractionDue(tokens: number, toolCalls: number): boolean {
    const state = this.stateValue
    if (state === null) return false
    if (!state.initialized) return tokens >= this.initTokens
    return (
      tokens - state.lastObservedTokens >= this.updateTokens ||
      toolCalls - state.lastObservedToolCalls >= this.updateToolCalls
    )
  }

  private async runExtraction(
    tokens: number,
    toolCalls: number,
    messageId: string,
    messages?: readonly ModelMessage[],
  ): Promise<void> {
    const state = this.stateValue
    if (state === null) {
      throw new SessionMemoryStateError('Session memory state is unavailable')
    }
    this.stateValue = {
      ...state,
      extractionStartedAt: Date.now(),
      extractionCompletedAt: null,
      extractionError: null,
    }
    await this.options.store.writeState(this.stateValue)
    try {
      const summary = await this.options.extractor({
        summary: this.summaryValue,
        tokens,
        toolCalls,
        ...(messages?.length ? { messages } : {}),
      })
      if (typeof summary !== 'string' || summary.trim().length === 0) {
        throw new SessionMemoryStateError(
          'Session memory extractor returned an empty summary',
        )
      }
      // Persist the summary before the completed state so a crash in between
      // is recovered as a stale extraction and safely re-extracted.
      await this.options.store.writeSummary(summary)
      this.stateValue = {
        ...this.stateValue,
        initialized: true,
        lastObservedTokens: tokens,
        lastObservedToolCalls: toolCalls,
        lastSummarizedMessageId: messageId,
        extractionStartedAt: null,
        extractionCompletedAt: Date.now(),
        extractionError: null,
      }
      await this.options.store.writeState(this.stateValue)
      this.summaryValue = summary
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      this.stateValue = {
        ...this.stateValue,
        extractionStartedAt: null,
        extractionCompletedAt: null,
        extractionError: failure,
      }
      await this.options.store
        .writeState(this.stateValue)
        .catch(() => undefined)
      throw error
    }
  }
}
