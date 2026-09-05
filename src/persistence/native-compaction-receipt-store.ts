import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelUsage } from '../core/runtime.js'
import type { TurnCompactionMetric } from '../application/turn-accounting.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'

export const NATIVE_COMPACTION_RECEIPT_VERSION = 1 as const
const MAX_RECEIPTS = 4096
const MAX_BYTES = 512 * 1024

export interface NativeCompactionReceipt {
  readonly version: 1
  readonly receiptId: string
  readonly sessionId: string
  readonly boundaryId: string
  readonly summaryId: string
  readonly trigger: 'auto' | 'manual'
  readonly metric: TurnCompactionMetric
  readonly costUsd: number | null
  readonly before: string
  readonly after: string
}

export interface CompactionReceiptStore {
  prepare(receipt: NativeCompactionReceipt): Promise<void>
  acknowledge(sessionId: string, receiptId: string): Promise<void>
  list(
    sessionId: string,
  ): Promise<
    readonly { receipt: NativeCompactionReceipt; acknowledged: boolean }[]
  >
}

function recordKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key))
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && recordKeys(value, keys)
}
function nonblank(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${field} must not be blank`)
}
function usage(value: unknown): value is ModelUsage {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const row = value as Record<string, unknown>
  if (
    !recordKeys(row, [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'cacheCreationInputTokens1h',
      'webSearchRequests',
      'contextWindow',
      'maxOutputTokens',
    ])
  )
    return false
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
    'cacheCreationInputTokens1h',
    'webSearchRequests',
  ] as const) {
    const n = row[field]
    if (n !== undefined && (!Number.isSafeInteger(n) || Number(n) < 0))
      return false
  }
  for (const field of ['contextWindow', 'maxOutputTokens'] as const) {
    const n = row[field]
    if (n !== undefined && (!Number.isSafeInteger(n) || Number(n) < 0))
      return false
  }
  if (
    Number(row.cacheCreationInputTokens1h ?? 0) >
    Number(row.cacheCreationInputTokens ?? 0)
  )
    return false
  return (
    Number.isSafeInteger(row.inputTokens) &&
    Number(row.inputTokens) >= 0 &&
    Number.isSafeInteger(row.outputTokens) &&
    Number(row.outputTokens) >= 0
  )
}
function metric(value: unknown): value is TurnCompactionMetric {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const row = value as Record<string, unknown>
  if (
    !recordKeys(row, [
      'usage',
      'model',
      'durationApiMs',
      'durationApiWithoutRetriesMs',
    ]) ||
    !usage(row.usage)
  )
    return false
  if (
    row.model !== undefined &&
    (typeof row.model !== 'string' || row.model.trim() === '')
  )
    return false
  if (
    [
      row.usage.inputTokens,
      row.usage.outputTokens,
      row.usage.cacheReadInputTokens,
      row.usage.cacheCreationInputTokens,
      row.usage.cacheCreationInputTokens1h,
      row.usage.webSearchRequests,
    ].some((value) => typeof value === 'number' && value > 0) &&
    row.model === undefined
  )
    return false
  return [row.durationApiMs, row.durationApiWithoutRetriesMs].every(
    (n) => typeof n === 'number' && Number.isFinite(n) && Number(n) >= 0,
  )
}
function parseReceipt(value: unknown): NativeCompactionReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid compaction receipt')
  const row = value as Record<string, unknown>
  const keys = [
    'version',
    'receiptId',
    'sessionId',
    'boundaryId',
    'summaryId',
    'trigger',
    'metric',
    'costUsd',
    'before',
    'after',
  ] as const
  if (!exactKeys(row, keys) || row.version !== 1 || !metric(row.metric))
    throw new TypeError('Invalid compaction receipt')
  for (const key of [
    'receiptId',
    'sessionId',
    'boundaryId',
    'summaryId',
    'before',
    'after',
  ])
    nonblank(row[key], key)
  safeId(row.receiptId as string)
  safeId(row.sessionId as string)
  safeId(row.boundaryId as string)
  safeId(row.summaryId as string)
  if (
    !/^[a-f0-9]{64}$/u.test(row.before as string) ||
    !/^[a-f0-9]{64}$/u.test(row.after as string)
  )
    throw new TypeError('Invalid compaction accounting fingerprint')
  if (
    row.receiptId === row.boundaryId ||
    row.receiptId === row.summaryId ||
    row.boundaryId === row.summaryId
  )
    throw new TypeError('Compaction receipt IDs must be distinct')
  if (row.trigger !== 'auto' && row.trigger !== 'manual')
    throw new TypeError('Invalid compaction receipt trigger')
  if (
    row.costUsd !== null &&
    (typeof row.costUsd !== 'number' ||
      !Number.isFinite(row.costUsd) ||
      row.costUsd < 0)
  )
    throw new TypeError('Invalid compaction receipt cost')
  const parsedMetric = row.metric as TurnCompactionMetric
  if (
    parsedMetric.durationApiWithoutRetriesMs > parsedMetric.durationApiMs ||
    (![
      parsedMetric.usage.inputTokens,
      parsedMetric.usage.outputTokens,
      parsedMetric.usage.cacheReadInputTokens,
      parsedMetric.usage.cacheCreationInputTokens,
      parsedMetric.usage.cacheCreationInputTokens1h,
      parsedMetric.usage.webSearchRequests,
    ].some((entry) => typeof entry === 'number' && entry > 0) &&
      row.costUsd !== null)
  )
    throw new TypeError('Invalid compaction receipt accounting outcome')
  return structuredClone(row) as unknown as NativeCompactionReceipt
}

function safeId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value))
    throw new TypeError('Invalid compaction receipt ID')
}

export class NativeCompactionReceiptStore implements CompactionReceiptStore {
  /** Compatibility alias for callers that name the file-backed adapter. */
  readonly directory: string
  private readonly lease: ExclusiveFileLease
  constructor(options: {
    readonly sidecarRoot: string
    readonly lockFile?: string
  }) {
    nonblank(options.sidecarRoot, 'sidecarRoot')
    this.directory = join(options.sidecarRoot, 'compaction-receipts')
    this.lease = new ExclusiveFileLease(
      options.lockFile ??
        join(options.sidecarRoot, 'locks', 'compaction-receipts.lock'),
    )
  }
  async prepare(receipt: NativeCompactionReceipt): Promise<void> {
    const checked = parseReceipt(receipt)
    safeId(checked.receiptId)
    const serialized = `${JSON.stringify(checked)}\n`
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES)
      throw new Error('Invalid compaction receipt file')
    const handle = await this.acquire()
    try {
      const directory = join(this.directory, checked.sessionId)
      try {
        const stat = await lstat(directory)
        if (!stat.isDirectory())
          throw new Error('Compaction receipt session path is not a directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await mkdir(directory, { recursive: true, mode: 0o700 })
      }
      const requestedIds = new Set([
        checked.receiptId,
        checked.boundaryId,
        checked.summaryId,
      ])
      for (const { receipt: existingReceipt } of await this.list(
        checked.sessionId,
      )) {
        if (existingReceipt.receiptId === checked.receiptId) continue
        if (
          [
            existingReceipt.receiptId,
            existingReceipt.boundaryId,
            existingReceipt.summaryId,
          ].some((id) => requestedIds.has(id))
        )
          throw new Error('Duplicate compaction transaction identity')
      }
      const path = join(directory, `${checked.receiptId}.json`)
      const ackPath = join(directory, `${checked.receiptId}.ack`)
      try {
        await lstat(ackPath)
        throw new Error(
          'Compaction receipt acknowledgement already exists for this receipt',
        )
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      let existing: string | null = null
      try {
        const reader = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        try {
          const stat = await reader.stat()
          if (
            !stat.isFile() ||
            (stat.mode & 0o077) !== 0 ||
            stat.size > MAX_BYTES
          )
            throw new Error('Invalid compaction receipt file')
          existing = await reader.readFile('utf8')
        } finally {
          await reader.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (existing !== null) {
        const prior = parseReceipt(JSON.parse(existing))
        if (JSON.stringify(prior) !== JSON.stringify(checked))
          throw new Error(
            'Compaction receipt ID already contains a different receipt',
          )
        return
      }
      await writeFileAtomically(path, serialized, { mode: 0o600 })
    } finally {
      await handle.release()
    }
  }
  async acknowledge(sessionId: string, receiptId: string): Promise<void> {
    safeId(sessionId)
    safeId(receiptId)
    const handle = await this.acquire()
    try {
      const directory = join(this.directory, sessionId)
      const directoryStat = await lstat(directory)
      if (!directoryStat.isDirectory())
        throw new Error('Compaction receipt session path is not a directory')
      const source = join(directory, `${receiptId}.json`)
      const sourceHandle = await open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        const stat = await sourceHandle.stat()
        if (!stat.isFile() || (stat.mode & 0o077) !== 0)
          throw new Error('Compaction receipt is not a regular file')
        if (stat.size > MAX_BYTES)
          throw new Error('Invalid compaction receipt file')
        const parsed = parseReceipt(
          JSON.parse(await sourceHandle.readFile('utf8')),
        )
        if (parsed.sessionId !== sessionId || parsed.receiptId !== receiptId)
          throw new Error('Compaction receipt path mismatch')
      } finally {
        await sourceHandle.close()
      }
      const ack = join(directory, `${receiptId}.ack`)
      try {
        const marker = await open(
          ack,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        try {
          const stat = await marker.stat()
          if (
            !stat.isFile() ||
            (stat.mode & 0o077) !== 0 ||
            stat.size > 256 ||
            (await marker.readFile('utf8')) !== `${receiptId}\n`
          )
            throw new Error('Invalid compaction receipt acknowledgement')
          return
        } finally {
          await marker.close()
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await writeFileAtomically(ack, `${receiptId}\n`, { mode: 0o600 })
    } finally {
      await handle.release()
    }
  }
  async list(
    sessionId: string,
  ): Promise<
    readonly { receipt: NativeCompactionReceipt; acknowledged: boolean }[]
  > {
    safeId(sessionId)
    const sessionDirectory = join(this.directory, sessionId)
    let files: string[]
    try {
      const directoryStat = await lstat(sessionDirectory)
      if (!directoryStat.isDirectory())
        throw new Error('Compaction receipt session path is not a directory')
      files = await readdir(sessionDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (files.length > MAX_RECEIPTS)
      throw new Error('Too many compaction receipt artifacts')
    const result: {
      receipt: NativeCompactionReceipt
      acknowledged: boolean
    }[] = []
    const receiptIds = new Set<string>()
    const transactionIds = new Set<string>()
    const ackIds = new Set<string>()
    for (const name of files.sort()) {
      if (!name.endsWith('.json') && !name.endsWith('.ack'))
        throw new Error('Unknown compaction receipt artifact')
      if (name.endsWith('.ack')) {
        const ackId = name.slice(0, -4)
        safeId(ackId)
        ackIds.add(ackId)
        continue
      }
      const receiptId = name.slice(0, -5)
      safeId(receiptId)
      const handle = await open(
        join(sessionDirectory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      try {
        const stat = await handle.stat()
        if (
          !stat.isFile() ||
          (stat.mode & 0o077) !== 0 ||
          stat.size > MAX_BYTES
        )
          throw new Error('Invalid compaction receipt file')
        const parsed = parseReceipt(JSON.parse(await handle.readFile('utf8')))
        if (parsed.sessionId !== sessionId || parsed.receiptId !== receiptId)
          throw new Error('Compaction receipt path mismatch')
        if (receiptIds.has(receiptId))
          throw new Error('Duplicate compaction receipt ID')
        receiptIds.add(receiptId)
        for (const id of [receiptId, parsed.boundaryId, parsed.summaryId]) {
          if (transactionIds.has(id))
            throw new Error('Duplicate compaction transaction identity')
          transactionIds.add(id)
        }
        let acknowledged = false
        try {
          const marker = await open(
            join(sessionDirectory, `${receiptId}.ack`),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          )
          try {
            const markerStat = await marker.stat()
            if (
              !markerStat.isFile() ||
              (markerStat.mode & 0o077) !== 0 ||
              markerStat.size > 256 ||
              (await marker.readFile('utf8')) !== `${receiptId}\n`
            )
              throw new Error('Invalid compaction receipt acknowledgement')
          } finally {
            await marker.close()
          }
          acknowledged = true
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        result.push({ receipt: parsed, acknowledged })
      } finally {
        await handle.close()
      }
    }
    for (const ackId of ackIds)
      if (!receiptIds.has(ackId))
        throw new Error('Acknowledgement has no receipt')
    return result.sort((a, b) =>
      a.receipt.receiptId < b.receipt.receiptId
        ? -1
        : a.receipt.receiptId > b.receipt.receiptId
          ? 1
          : 0,
    )
  }
  private async acquire(): Promise<{ release(): Promise<void> }> {
    for (let i = 0; i < 400; i += 1) {
      const handle = await this.lease.tryAcquire()
      if (handle) return handle
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('Timed out acquiring compaction receipt lock')
  }
}

export { NativeCompactionReceiptStore as NativeCompactionReceiptFileStore }
