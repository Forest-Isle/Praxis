import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { AgentRunCancelledError, type ModelMessage } from '../core/runtime.js'
import { isClaudeSessionId } from '../compatibility/claude/paths.js'
import { writeFileAtomically } from '../platform/atomic-write.js'

/** A persisted extraction this old is recovered as stale and safely re-extracted. */
const STALE_EXTRACTION_THRESHOLD_MS = 60_000

/** Versioned, explicit progress state for one session's extracted memory. */
export interface SessionMemoryState {
  schemaVersion: 1
  initialized: boolean
  lastObservedTokens: number
  /** Current-context growth baseline after a durable compaction reduction. */
  growthBaselineTokens?: number
  /** Latest extraction attempt occupancy, successful or failed. Older
   * sidecars omit it and fall back to the successful watermark. */
  lastAttemptedTokens?: number
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
    growthBaselineTokens: 0,
    lastAttemptedTokens: 0,
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
  if (
    record.growthBaselineTokens !== undefined &&
    !isNonNegativeSafeInteger(record.growthBaselineTokens)
  ) {
    throw new SessionMemoryStateError(
      'Session memory state growthBaselineTokens must be a non-negative safe integer when present',
    )
  }
  if (
    record.lastAttemptedTokens !== undefined &&
    !isNonNegativeSafeInteger(record.lastAttemptedTokens)
  ) {
    throw new SessionMemoryStateError(
      'Session memory state lastAttemptedTokens must be a non-negative safe integer when present',
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

interface SessionMemoryRecord {
  state: SessionMemoryState
  /** The state pointer and watermark commit in one atomic rename. Older
   *  sidecars without a pointer fall back to summary.md. */
  summaryFile?: string
}

export interface SessionMemorySnapshot {
  state: SessionMemoryState
  summary: string
}

const SESSION_MEMORY_ARTIFACT_PATTERN = /^artifacts\/[a-f0-9]{64}\.md$/u

function parseSessionMemoryState(source: string): SessionMemoryRecord {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new SessionMemoryStateError('Session memory state is not valid JSON')
  }
  assertValidSessionMemoryState(value)
  const record = value as SessionMemoryState & { summaryFile?: unknown }
  if (
    record.summaryFile !== undefined &&
    (typeof record.summaryFile !== 'string' ||
      !SESSION_MEMORY_ARTIFACT_PATTERN.test(record.summaryFile))
  ) {
    throw new SessionMemoryStateError(
      'Session memory state summaryFile must be a safe artifact path when present',
    )
  }
  const state: SessionMemoryState = {
    schemaVersion: record.schemaVersion,
    initialized: record.initialized,
    lastObservedTokens: record.lastObservedTokens,
    ...(record.growthBaselineTokens === undefined
      ? {}
      : { growthBaselineTokens: record.growthBaselineTokens }),
    ...(record.lastAttemptedTokens === undefined
      ? {}
      : { lastAttemptedTokens: record.lastAttemptedTokens }),
    lastObservedToolCalls: record.lastObservedToolCalls,
    lastSummarizedMessageId: record.lastSummarizedMessageId,
    extractionStartedAt: record.extractionStartedAt,
    extractionCompletedAt: record.extractionCompletedAt,
    extractionError: record.extractionError,
  }
  return {
    state,
    ...(typeof record.summaryFile === 'string'
      ? { summaryFile: record.summaryFile }
      : {}),
  }
}

export interface SessionMemoryStoreOptions {
  configRoot: string
  sessionId: string
  sidecarRoot?: string
}

/**
 * Durable sidecar for one session's extracted memory. Claude compatibility
 * defaults to `<configRoot>/praxis/session-memory/<sessionId>/`; callers may
 * select another data plane with
 * `<sidecarRoot>/session-memory/<sessionId>/` (for example, native
 * `<configRoot>/state/session-memory/<sessionId>/`). All writes are atomic
 * (same-directory temp file, fsync, then rename) and version-checked. Never
 * touches shared Claude transcript entries.
 */
export class SessionMemoryStore {
  private readonly directory: string
  private readonly artifactsDirectory: string
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
    this.artifactsDirectory = join(this.directory, 'artifacts')
  }

  async load(): Promise<SessionMemoryState> {
    return (await this.loadRecord()).state
  }

  /** Reads the pointer record once, then resolves exactly the artifact named
   *  by that record. Concurrent commits cannot pair an old watermark with a
   *  newer summary. */
  async loadSnapshot(): Promise<SessionMemorySnapshot> {
    const record = await this.loadRecord()
    return {
      state: record.state,
      summary: await this.loadSummaryForRecord(record),
    }
  }

  private async loadRecord(): Promise<SessionMemoryRecord> {
    let source: string
    try {
      source = await readFile(this.stateFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: createFreshSessionMemoryState() }
      }
      throw error
    }
    return parseSessionMemoryState(source)
  }

  async loadSummary(): Promise<string> {
    const record = await this.loadRecord()
    return this.loadSummaryForRecord(record)
  }

  private async loadSummaryForRecord(
    record: SessionMemoryRecord,
  ): Promise<string> {
    if (record.summaryFile !== undefined) {
      try {
        return await readFile(join(this.directory, record.summaryFile), 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new SessionMemoryStateError(
            `Session memory summary artifact is missing: ${record.summaryFile}`,
          )
        }
        throw error
      }
    }
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

  async writeState(
    state: SessionMemoryState,
    summaryFile?: string,
  ): Promise<void> {
    assertValidSessionMemoryState(state)
    if (
      summaryFile !== undefined &&
      !SESSION_MEMORY_ARTIFACT_PATTERN.test(summaryFile)
    ) {
      throw new SessionMemoryStateError(
        'Session memory summaryFile must be a safe artifact path',
      )
    }
    const existing = await this.loadRecord()
    if (state.lastObservedToolCalls < existing.state.lastObservedToolCalls) {
      throw new SessionMemoryStateError(
        'Session memory observed tool-call counter must be monotonic',
      )
    }
    await writeFileAtomically(
      this.stateFile,
      `${JSON.stringify(
        {
          ...state,
          ...(summaryFile !== undefined
            ? { summaryFile }
            : existing.summaryFile !== undefined
              ? { summaryFile: existing.summaryFile }
              : {}),
        },
        null,
        2,
      )}\n`,
    )
  }

  /** Writes an immutable summary artifact, then atomically commits its pointer
   *  with the progress watermark. summary.md is a best-effort readable mirror. */
  async commitExtraction(
    state: SessionMemoryState,
    summary: string,
  ): Promise<void> {
    if (typeof summary !== 'string' || summary.trim().length === 0) {
      throw new SessionMemoryStateError(
        'Session memory summary must be a non-empty string',
      )
    }
    const existing = await this.loadRecord()
    const digest = createHash('sha256')
      .update(state.lastSummarizedMessageId ?? '')
      .update('\0')
      .update(summary)
      .digest('hex')
    const summaryFile = `artifacts/${digest}.md`
    const artifact = join(this.directory, summaryFile)
    await writeFileAtomically(artifact, summary)
    try {
      await this.writeState(state, summaryFile)
    } catch (error) {
      if (existing.summaryFile !== summaryFile) {
        await rm(artifact, { force: true }).catch(() => undefined)
      }
      throw error
    }
    await this.writeSummary(summary).catch(() => undefined)
    // Superseded artifacts remain immutable and readable for any concurrent
    // reader that loaded their pointer before this commit. clear() performs
    // lifecycle-safe reclamation after the controller is idle.
  }

  async clear(): Promise<void> {
    await Promise.all([
      rm(this.stateFile, { force: true }),
      rm(this.summaryFile, { force: true }),
      rm(this.artifactsDirectory, { recursive: true, force: true }),
    ])
  }
}

export interface SessionMemoryExtractorInput {
  summary: string
  tokens: number
  toolCalls: number
  messages?: readonly ModelMessage[]
  signal: AbortSignal
}

export type SessionMemoryExtractor = (
  input: SessionMemoryExtractorInput,
) => Promise<string> | string

export interface SessionMemoryControllerOptions {
  store: SessionMemoryStore
  extractor: SessionMemoryExtractor
  onExtractionError?: (error: unknown) => void
  initTokens?: number
  updateTokens?: number
  updateToolCalls?: number
  waitTimeoutMs?: number
  staleExtractionMs?: number
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
  private readonly staleExtractionMs: number
  private stateValue: SessionMemoryState | null = null
  private summaryValue = ''
  private inFlight: Promise<void> | null = null
  private extractionController: AbortController | null = null
  private loading: Promise<void> | null = null
  private observedTokens = 0
  private tokenBaseline = 0
  private attemptTokenBaseline = 0
  private observedToolCalls = 0
  private closed = false

  constructor(private readonly options: SessionMemoryControllerOptions) {
    this.initTokens = options.initTokens ?? 10_000
    this.updateTokens = options.updateTokens ?? 5_000
    this.updateToolCalls = options.updateToolCalls ?? 3
    this.waitTimeoutMs = options.waitTimeoutMs ?? 15_000
    this.staleExtractionMs =
      options.staleExtractionMs ?? STALE_EXTRACTION_THRESHOLD_MS
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
    if (
      typeof this.staleExtractionMs !== 'number' ||
      !Number.isFinite(this.staleExtractionMs) ||
      this.staleExtractionMs <= 0
    ) {
      throw new SessionMemoryStateError(
        'Session memory staleExtractionMs must be a positive number',
      )
    }
  }

  async observe(
    tokens: number,
    toolCalls: number,
    messageId: string,
    messages?: readonly ModelMessage[],
  ): Promise<boolean> {
    const messageSnapshot = cloneMessages(messages)
    await this.ensureLoaded()
    this.assertOpen()
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
    if (toolCalls < state.lastObservedToolCalls) {
      throw new SessionMemoryStateError(
        `Session memory observed tool-call counter regressed (${toolCalls} < ${state.lastObservedToolCalls})`,
      )
    }
    await this.rebaseAfterContextReduction(tokens)
    // A direct absolute observation reports a natural break when no tool calls
    // have accumulated since the last successful extraction.
    const naturalBreak = toolCalls === state.lastObservedToolCalls
    return this.scheduleExtraction(
      tokens,
      toolCalls,
      messageId,
      messageSnapshot,
      naturalBreak,
    )
  }

  /** Observes the current provider-visible context occupancy and a per-turn
   *  tool-call delta. Unlike provider input-token deltas, occupancy may shrink
   *  after compaction; that establishes a new growth baseline. */
  async observeContext(
    currentTokens: number,
    turnToolCalls: number,
    messageId: string,
    messages?: readonly ModelMessage[],
  ): Promise<boolean> {
    const messageSnapshot = cloneMessages(messages)
    await this.ensureLoaded()
    this.assertOpen()
    if (
      !isNonNegativeSafeInteger(currentTokens) ||
      !isNonNegativeSafeInteger(turnToolCalls)
    ) {
      throw new SessionMemoryStateError(
        'Session memory context occupancy and tool-call delta must be non-negative safe integers',
      )
    }
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new SessionMemoryStateError(
        'Session memory message ID must be a non-empty string',
      )
    }
    await this.rebaseAfterContextReduction(currentTokens)
    this.observedToolCalls += turnToolCalls
    return this.scheduleExtraction(
      currentTokens,
      this.observedToolCalls,
      messageId,
      messageSnapshot,
      turnToolCalls === 0,
    )
  }

  /**
   * Records the observed totals and starts an extraction when the fixed
   * eligibility contract is met. Returns true when an extraction is running or
   * was just scheduled; callers on normal turns never await the extraction.
   */
  private scheduleExtraction(
    tokens: number,
    toolCalls: number,
    messageId: string,
    messages: readonly ModelMessage[] | undefined,
    naturalBreak: boolean,
  ): boolean {
    this.observedTokens = tokens
    this.observedToolCalls = Math.max(this.observedToolCalls, toolCalls)
    if (
      !this.isExtractionDue(
        this.observedTokens,
        this.observedToolCalls,
        naturalBreak,
      )
    ) {
      return false
    }
    if (this.inFlight === null) {
      const controller = new AbortController()
      this.extractionController = controller
      const extraction = this.runExtraction(
        this.observedTokens,
        this.observedToolCalls,
        messageId,
        messages,
        controller.signal,
      )
      this.inFlight = extraction
      extraction
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight === extraction) {
            this.inFlight = null
            this.extractionController = null
          }
        })
    }
    return true
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

  /**
   * Resolves when no extraction is running; rejects on extraction failure.
   * Normal turns do not await this diagnostic seam.
   */
  async waitForIdle(): Promise<void> {
    await this.ensureLoaded()
    const extraction = this.inFlight
    if (extraction === null) return
    await extraction
  }

  /** Compact consumes only the last committed artifact. It waits softly for a
   *  useful extraction, swallows retryable failures, and cancels stale work. */
  async waitForCompact(): Promise<void> {
    await this.ensureLoaded()
    const extraction = this.inFlight
    if (extraction === null) return
    const startedAt = this.stateValue?.extractionStartedAt
    if (
      startedAt !== null &&
      startedAt !== undefined &&
      Date.now() - startedAt >= this.staleExtractionMs
    ) {
      this.extractionController?.abort()
      // Stale work is no longer useful to compact. The extraction owns its
      // eventual retryable error commit and cannot commit a summary after the
      // aborted signal is observed.
      return
    }
    const completed = await this.waitBoundedly(extraction, true)
    if (!completed) this.extractionController?.abort()
  }

  /** Cancels owned extraction work and waits only for the configured bounded
   *  interval. A provider that ignores AbortSignal cannot hold service close. */
  async close(): Promise<void> {
    this.closed = true
    const extraction = this.inFlight
    this.extractionController?.abort()
    if (extraction === null) return
    await this.waitBoundedly(extraction, true)
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
    this.tokenBaseline = fresh.lastObservedTokens
    this.attemptTokenBaseline = fresh.lastObservedTokens
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
    const { state, summary } = await this.options.store.loadSnapshot()
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
          elapsed >= this.staleExtractionMs
            ? `Session memory extraction is stale after ${elapsed}ms`
            : 'Session memory extraction was interrupted',
      }
      await this.options.store.writeState(recovered)
      this.stateValue = recovered
    } else {
      this.stateValue = state
    }
    this.observedTokens = this.stateValue.lastObservedTokens
    this.tokenBaseline =
      this.stateValue.growthBaselineTokens ?? this.stateValue.lastObservedTokens
    this.attemptTokenBaseline =
      this.stateValue.lastAttemptedTokens ?? this.stateValue.lastObservedTokens
    this.observedToolCalls = this.stateValue.lastObservedToolCalls
    this.summaryValue = summary
  }

  private isExtractionDue(
    tokens: number,
    toolCalls: number,
    naturalBreak: boolean,
  ): boolean {
    const state = this.stateValue
    if (state === null) return false
    if (!state.initialized) {
      return tokens >= this.initTokens && tokens > this.attemptTokenBaseline
    }
    // Unchanged context must not retrigger; tool-call growth alone is never
    // enough without at least the update-token growth.
    if (
      tokens - this.tokenBaseline < this.updateTokens ||
      tokens <= this.attemptTokenBaseline
    ) {
      return false
    }
    return (
      toolCalls - state.lastObservedToolCalls >= this.updateToolCalls ||
      naturalBreak
    )
  }

  private async runExtraction(
    tokens: number,
    toolCalls: number,
    messageId: string,
    messages?: readonly ModelMessage[],
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.stateValue
    if (state === null) {
      throw new SessionMemoryStateError('Session memory state is unavailable')
    }
    const started: SessionMemoryState = {
      ...state,
      lastAttemptedTokens: tokens,
      extractionStartedAt: Date.now(),
      extractionCompletedAt: null,
      extractionError: null,
    }
    this.attemptTokenBaseline = tokens
    try {
      await this.options.store.writeState(started)
      this.stateValue = started
      if (signal?.aborted || this.closed) throw new AgentRunCancelledError()
      const summary = await this.options.extractor({
        summary: this.summaryValue,
        tokens,
        toolCalls,
        ...(messages?.length ? { messages } : {}),
        signal: signal ?? new AbortController().signal,
      })
      if (signal?.aborted || this.closed) throw new AgentRunCancelledError()
      if (typeof summary !== 'string' || summary.trim().length === 0) {
        throw new SessionMemoryStateError(
          'Session memory extractor returned an empty summary',
        )
      }
      const completed: SessionMemoryState = {
        ...this.stateValue,
        initialized: true,
        lastObservedTokens: tokens,
        growthBaselineTokens: tokens,
        lastObservedToolCalls: toolCalls,
        lastSummarizedMessageId: messageId,
        extractionStartedAt: null,
        extractionCompletedAt: Date.now(),
        extractionError: null,
      }
      await this.options.store.commitExtraction(completed, summary)
      this.stateValue = completed
      this.tokenBaseline = tokens
      this.summaryValue = summary
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      this.stateValue = {
        ...started,
        extractionStartedAt: null,
        extractionCompletedAt: null,
        extractionError: failure,
      }
      await this.options.store
        .writeState(this.stateValue)
        .catch(() => undefined)
      try {
        this.options.onExtractionError?.(error)
      } catch {
        // Operational warning sinks cannot change extraction lifecycle state.
      }
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new SessionMemoryStateError('Session memory controller is closed')
    }
  }

  private async rebaseAfterContextReduction(tokens: number): Promise<void> {
    if (tokens >= this.tokenBaseline && tokens >= this.attemptTokenBaseline) {
      return
    }
    this.tokenBaseline = Math.min(this.tokenBaseline, tokens)
    this.attemptTokenBaseline = Math.min(this.attemptTokenBaseline, tokens)
    if (this.stateValue === null) return
    this.stateValue = {
      ...this.stateValue,
      growthBaselineTokens: this.tokenBaseline,
      lastAttemptedTokens: this.attemptTokenBaseline,
    }
    await this.options.store.writeState(this.stateValue)
  }

  private async waitBoundedly(
    extraction: Promise<void>,
    ignoreFailure: boolean,
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.waitTimeoutMs)
    })
    try {
      return await Promise.race([
        (ignoreFailure ? extraction.catch(() => undefined) : extraction).then(
          () => true as const,
        ),
        timeout,
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

function cloneMessages(
  messages: readonly ModelMessage[] | undefined,
): readonly ModelMessage[] | undefined {
  return messages === undefined ? undefined : structuredClone(messages)
}
