import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'
import { UnknownCostSidecar } from './unknown-cost-sidecar.js'

export interface ClaudeStoredModelCostUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
  readonly webSearchRequests: number
  readonly costUsd: number
}

export interface ClaudeSessionCostState {
  readonly sessionId: string
  readonly totalCostUsd: number
  readonly apiDurationMs: number
  readonly apiDurationWithoutRetriesMs: number
  readonly toolDurationMs: number
  readonly wallDurationMs: number
  readonly linesAdded: number
  readonly linesRemoved: number
  readonly modelUsage: Readonly<Record<string, ClaudeStoredModelCostUsage>>
  readonly hasUnknownModelCost?: boolean
}

export interface ClaudeCostStateStoreOptions {
  statePath: string
  projectIdentity: string
  lockFile?: string
  sidecarPath?: string
  sidecarLockFile?: string
}

export interface ClaudeCostStateSaveHooks {
  readonly afterValidation?: () => Promise<void>
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string'
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNonBlank(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must not be blank`)
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new TypeError(`Invalid value for ${field}: expected an object`)
  }
  return value
}

function readNumberField(
  record: Record<string, unknown>,
  field: string,
  integer: boolean,
): number {
  const value = record[field]
  if (value === undefined) {
    return 0
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `Invalid value for ${field}: expected a finite non-negative number`,
    )
  }
  if (integer && !Number.isInteger(value)) {
    throw new TypeError(`Invalid value for ${field}: expected an integer`)
  }
  return value
}

const MISSING_FINGERPRINT = 'missing'

function fingerprintOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function requireMetric(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `Invalid value for ${field}: expected a finite non-negative number`,
    )
  }
  return value
}

function requireCounter(value: unknown, field: string): number {
  const counter = requireMetric(value, field)
  if (!Number.isInteger(counter)) {
    throw new TypeError(`Invalid value for ${field}: expected an integer`)
  }
  return counter
}

function requireSafeIntegerTotal(value: number, field: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Invalid value for ${field}: expected a safe integer`)
  }
}

interface DerivedTotals {
  readonly lastTotalInputTokens: number
  readonly lastTotalOutputTokens: number
  readonly lastTotalCacheCreationInputTokens: number
  readonly lastTotalCacheReadInputTokens: number
  readonly lastTotalWebSearchRequests: number
}

export class ClaudeCostStateStore {
  readonly statePath: string
  readonly projectIdentity: string
  readonly lockFile: string
  private readonly lease: ExclusiveFileLease
  private readonly sidecar: UnknownCostSidecar | null

  constructor(options: ClaudeCostStateStoreOptions) {
    assertNonBlank(options.statePath, 'statePath')
    assertNonBlank(options.projectIdentity, 'projectIdentity')
    this.statePath = options.statePath
    this.projectIdentity = options.projectIdentity
    this.lockFile =
      options.lockFile ?? join(dirname(options.statePath), '.praxis-state.lock')
    this.lease = new ExclusiveFileLease(this.lockFile)
    this.sidecar =
      options.sidecarPath === undefined
        ? null
        : new UnknownCostSidecar({
            sidecarPath: options.sidecarPath,
            ...(options.sidecarLockFile === undefined
              ? {}
              : { lockFile: options.sidecarLockFile }),
          })
  }

  async load(sessionId: string): Promise<ClaudeSessionCostState | null> {
    assertNonBlank(sessionId, 'sessionId')
    const { content } = await this.readStateFile()
    if (content === null) {
      return null
    }
    const native = this.restoreMatchingSession(content, sessionId)
    if (native === null) {
      return null
    }
    const hasUnknownModelCost = this.sidecar
      ? await this.sidecar.readFlag(sessionId)
      : false
    return { ...native, hasUnknownModelCost }
  }

  async save(
    state: ClaudeSessionCostState,
    hooks: ClaudeCostStateSaveHooks = {},
  ): Promise<void> {
    this.validateState(state)
    const totals = this.deriveTotals(state)

    const handle = await this.acquireLease()
    try {
      await this.commitState(state, totals, hooks)
    } finally {
      await handle.release()
    }
    await this.sidecar?.writeFlag(
      state.sessionId,
      state.hasUnknownModelCost ?? false,
    )
  }

  private async readStateFile(): Promise<{
    content: string | null
    fingerprint: string
  }> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(
        this.statePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return { content: null, fingerprint: MISSING_FINGERPRINT }
      }
      if (isErrnoException(err) && err.code === 'ELOOP') {
        throw new TypeError(
          `Claude state path must be a regular file: ${this.statePath}`,
          {
            cause: err,
          },
        )
      }
      throw err
    }

    try {
      const stat = await handle.stat()
      if (!stat.isFile()) {
        throw new TypeError(
          `Claude state path must be a regular file: ${this.statePath}`,
        )
      }
      const content = await handle.readFile('utf8')
      return { content, fingerprint: fingerprintOf(content) }
    } finally {
      await handle.close()
    }
  }

  private async readStateForMerge(): Promise<{
    root: Record<string, unknown>
    fingerprint: string
  }> {
    const { content, fingerprint } = await this.readStateFile()
    if (content === null) {
      return { root: {}, fingerprint }
    }
    let root: unknown
    try {
      root = JSON.parse(content)
    } catch (err) {
      throw new TypeError(`Invalid JSON: ${this.statePath}`, { cause: err })
    }
    if (!isObject(root)) {
      throw new TypeError(`JSON root must be an object: ${this.statePath}`)
    }
    return { root, fingerprint }
  }

  private async readFingerprint(): Promise<string> {
    const { fingerprint } = await this.readStateFile()
    return fingerprint
  }

  private async acquireLease(): Promise<{ release(): Promise<void> }> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const handle = await this.lease.tryAcquire()
      if (handle) {
        return handle
      }
      await sleep(5)
    }
    throw new Error(
      `Timed out acquiring Claude state lock for ${this.statePath}`,
    )
  }

  private validateState(state: ClaudeSessionCostState): void {
    assertNonBlank(state.sessionId, 'sessionId')

    requireMetric(state.totalCostUsd, 'totalCostUsd')
    requireMetric(state.apiDurationMs, 'apiDurationMs')
    requireMetric(
      state.apiDurationWithoutRetriesMs,
      'apiDurationWithoutRetriesMs',
    )
    requireMetric(state.toolDurationMs, 'toolDurationMs')
    requireMetric(state.wallDurationMs, 'wallDurationMs')
    requireCounter(state.linesAdded, 'linesAdded')
    requireCounter(state.linesRemoved, 'linesRemoved')
    if (
      state.hasUnknownModelCost !== undefined &&
      typeof state.hasUnknownModelCost !== 'boolean'
    ) {
      throw new TypeError('hasUnknownModelCost must be a boolean')
    }

    const rawUsage = requireObject(state.modelUsage, 'modelUsage')
    for (const [modelKey, rawValue] of Object.entries(rawUsage)) {
      assertNonBlank(modelKey, `modelUsage.${modelKey}`)
      const usage = requireObject(rawValue, `modelUsage.${modelKey}`)
      requireCounter(usage.inputTokens, `modelUsage.${modelKey}.inputTokens`)
      requireCounter(usage.outputTokens, `modelUsage.${modelKey}.outputTokens`)
      requireCounter(
        usage.cacheReadInputTokens,
        `modelUsage.${modelKey}.cacheReadInputTokens`,
      )
      requireCounter(
        usage.cacheCreationInputTokens,
        `modelUsage.${modelKey}.cacheCreationInputTokens`,
      )
      requireCounter(
        usage.webSearchRequests,
        `modelUsage.${modelKey}.webSearchRequests`,
      )
      requireMetric(usage.costUsd, `modelUsage.${modelKey}.costUsd`)
    }
  }

  private deriveTotals(state: ClaudeSessionCostState): DerivedTotals {
    let lastTotalInputTokens = 0
    let lastTotalOutputTokens = 0
    let lastTotalCacheCreationInputTokens = 0
    let lastTotalCacheReadInputTokens = 0
    let lastTotalWebSearchRequests = 0

    for (const usage of Object.values(state.modelUsage)) {
      lastTotalInputTokens += usage.inputTokens
      lastTotalOutputTokens += usage.outputTokens
      lastTotalCacheCreationInputTokens += usage.cacheCreationInputTokens
      lastTotalCacheReadInputTokens += usage.cacheReadInputTokens
      lastTotalWebSearchRequests += usage.webSearchRequests
    }

    requireSafeIntegerTotal(lastTotalInputTokens, 'lastTotalInputTokens')
    requireSafeIntegerTotal(lastTotalOutputTokens, 'lastTotalOutputTokens')
    requireSafeIntegerTotal(
      lastTotalCacheCreationInputTokens,
      'lastTotalCacheCreationInputTokens',
    )
    requireSafeIntegerTotal(
      lastTotalCacheReadInputTokens,
      'lastTotalCacheReadInputTokens',
    )
    requireSafeIntegerTotal(
      lastTotalWebSearchRequests,
      'lastTotalWebSearchRequests',
    )

    return {
      lastTotalInputTokens,
      lastTotalOutputTokens,
      lastTotalCacheCreationInputTokens,
      lastTotalCacheReadInputTokens,
      lastTotalWebSearchRequests,
    }
  }

  private mergeModelUsage(
    oldValue: unknown,
    newUsage: Readonly<Record<string, ClaudeStoredModelCostUsage>>,
  ): Record<string, unknown> {
    const oldUsage =
      oldValue === undefined ? {} : requireObject(oldValue, 'lastModelUsage')
    const merged: Record<string, unknown> = {}
    for (const [modelKey, usage] of Object.entries(newUsage)) {
      const oldEntry = oldUsage[modelKey]
      const mergedEntry =
        oldEntry === undefined
          ? {}
          : requireObject(oldEntry, `lastModelUsage.${modelKey}`)
      merged[modelKey] = {
        ...mergedEntry,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        webSearchRequests: usage.webSearchRequests,
        costUSD: usage.costUsd,
      }
    }
    return merged
  }

  private mergeState(
    root: Record<string, unknown>,
    state: ClaudeSessionCostState,
    totals: DerivedTotals,
  ): Record<string, unknown> {
    const mergedRoot: Record<string, unknown> = { ...root }

    const projectsValue = root.projects
    const projects =
      projectsValue === undefined
        ? {}
        : requireObject(projectsValue, 'projects')
    const mergedProjects: Record<string, unknown> = { ...projects }

    const projectValue = projects[this.projectIdentity]
    const project =
      projectValue === undefined
        ? {}
        : requireObject(projectValue, `projects.${this.projectIdentity}`)
    const mergedProject: Record<string, unknown> = { ...project }

    mergedProject.lastModelUsage = this.mergeModelUsage(
      project.lastModelUsage,
      state.modelUsage,
    )

    mergedProject.lastCost = state.totalCostUsd
    mergedProject.lastAPIDuration = state.apiDurationMs
    mergedProject.lastAPIDurationWithoutRetries =
      state.apiDurationWithoutRetriesMs
    mergedProject.lastToolDuration = state.toolDurationMs
    mergedProject.lastDuration = state.wallDurationMs
    mergedProject.lastLinesAdded = state.linesAdded
    mergedProject.lastLinesRemoved = state.linesRemoved
    mergedProject.lastTotalInputTokens = totals.lastTotalInputTokens
    mergedProject.lastTotalOutputTokens = totals.lastTotalOutputTokens
    mergedProject.lastTotalCacheCreationInputTokens =
      totals.lastTotalCacheCreationInputTokens
    mergedProject.lastTotalCacheReadInputTokens =
      totals.lastTotalCacheReadInputTokens
    mergedProject.lastTotalWebSearchRequests = totals.lastTotalWebSearchRequests
    mergedProject.lastSessionId = state.sessionId

    mergedProjects[this.projectIdentity] = mergedProject
    mergedRoot.projects = mergedProjects

    return mergedRoot
  }

  private async commitState(
    state: ClaudeSessionCostState,
    totals: DerivedTotals,
    hooks: ClaudeCostStateSaveHooks,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { root, fingerprint } = await this.readStateForMerge()
      const merged = this.mergeState(root, state, totals)
      const content = `${JSON.stringify(merged, null, 2)}\n`
      const committed = await writeFileAtomically(this.statePath, content, {
        mode: 0o600,
        beforeCommit: async () => {
          if ((await this.readFingerprint()) !== fingerprint) {
            return false
          }
          await hooks.afterValidation?.()
          return (await this.readFingerprint()) === fingerprint
        },
      })
      if (committed) {
        return
      }
    }
    throw new Error(`Claude state changed concurrently: ${this.statePath}`)
  }

  private restoreMatchingSession(
    content: string,
    sessionId: string,
  ): Omit<ClaudeSessionCostState, 'hasUnknownModelCost'> | null {
    let root: unknown
    try {
      root = JSON.parse(content)
    } catch (err) {
      throw new TypeError(`Invalid JSON: ${this.statePath}`, { cause: err })
    }

    if (!isObject(root)) {
      throw new TypeError(`JSON root must be an object: ${this.statePath}`)
    }

    if (!('projects' in root)) {
      return null
    }
    const projects = requireObject(root.projects, 'projects')

    if (!(this.projectIdentity in projects)) {
      return null
    }
    const project = requireObject(
      projects[this.projectIdentity],
      `projects.${this.projectIdentity}`,
    )

    if (project.lastSessionId !== sessionId) {
      return null
    }

    const modelUsage = this.readModelUsage(project.lastModelUsage)

    return {
      sessionId,
      totalCostUsd: readNumberField(project, 'lastCost', false),
      apiDurationMs: readNumberField(project, 'lastAPIDuration', false),
      apiDurationWithoutRetriesMs: readNumberField(
        project,
        'lastAPIDurationWithoutRetries',
        false,
      ),
      toolDurationMs: readNumberField(project, 'lastToolDuration', false),
      wallDurationMs: readNumberField(project, 'lastDuration', false),
      linesAdded: readNumberField(project, 'lastLinesAdded', true),
      linesRemoved: readNumberField(project, 'lastLinesRemoved', true),
      modelUsage,
    }
  }

  private readModelUsage(
    value: unknown,
  ): Readonly<Record<string, ClaudeStoredModelCostUsage>> {
    if (value === undefined) {
      return {}
    }
    const usage: Record<string, ClaudeStoredModelCostUsage> = {}
    const rawUsage = requireObject(value, 'lastModelUsage')

    for (const [modelKey, rawValue] of Object.entries(rawUsage)) {
      if (modelKey.trim() === '') {
        throw new TypeError(
          'Invalid value for lastModelUsage: expected a non-empty model key',
        )
      }
      const record = requireObject(rawValue, `lastModelUsage.${modelKey}`)
      // Build fresh records so callers cannot mutate the parsed state through aliases.
      usage[modelKey] = {
        inputTokens: readNumberField(record, 'inputTokens', true),
        outputTokens: readNumberField(record, 'outputTokens', true),
        cacheReadInputTokens: readNumberField(
          record,
          'cacheReadInputTokens',
          true,
        ),
        cacheCreationInputTokens: readNumberField(
          record,
          'cacheCreationInputTokens',
          true,
        ),
        webSearchRequests: readNumberField(record, 'webSearchRequests', true),
        costUsd: readNumberField(record, 'costUSD', false),
      }
    }

    return usage
  }
}
