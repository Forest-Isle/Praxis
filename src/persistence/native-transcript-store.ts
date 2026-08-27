import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { TranscriptEvent } from '../core/transcript-event.js'
import type { NativeTranscriptEntry } from '../native/schema.js'
import {
  type DecodedTranscriptRecord,
  type TranscriptCodecDiagnostic,
} from '../core/transcript-codec.js'
import { ExclusiveFileLease } from '../platform/exclusive-file-lease.js'
import { createNativeTranscriptCodec } from './native-transcript-codec.js'
import { classifyTranscriptAppend } from './transcript-file-append.js'

export interface NativeTranscriptTail {
  byteLength: number
  lastLineHash: string | null
  lastEventId: string | null
  newlineTerminated: boolean
  branchParentId?: string | null
}
export interface NativeTranscriptSnapshot {
  records: readonly DecodedTranscriptRecord[]
  /** Claude-shaped projection for higher-level session helpers; never authoritative. */
  entries: NativeTranscriptEntry[]
  tail: NativeTranscriptTail
}
export interface NativeTranscriptRecovery extends NativeTranscriptSnapshot {
  issue: TranscriptCodecDiagnostic | null
}
export type NativeTranscriptAppendResult =
  | { status: 'appended'; tail: NativeTranscriptTail }
  | {
      status: 'conflict'
      reason: 'interleaved-write' | 'locked' | 'tail-changed'
    }
export type NativeTranscriptCreateResult =
  | { status: 'created'; tail: NativeTranscriptTail }
  | { status: 'conflict'; reason: 'already-exists' }
export type NativeTranscriptReserveResult =
  { status: 'reserved' } | { status: 'conflict'; reason: 'already-exists' }
export interface NativeTranscriptLease {
  reserve(): Promise<NativeTranscriptReserveResult>
  load(): Promise<NativeTranscriptSnapshot>
  append(
    expectedTail: NativeTranscriptTail,
    event: TranscriptEvent,
  ): Promise<NativeTranscriptAppendResult>
  appendMany(
    expectedTail: NativeTranscriptTail,
    events: readonly TranscriptEvent[],
  ): Promise<NativeTranscriptAppendResult>
}
export type NativeTranscriptLeaseResult<T> =
  { status: 'completed'; value: T } | { status: 'conflict'; reason: 'locked' }

/**
 * Projects authoritative native events into the Claude-shaped entry view
 * consumed by higher-level session helpers. The projection is intentionally
 * non-authoritative; callers must persist and validate `records`.
 */
export function projectNativeTranscriptEntries(
  records: readonly DecodedTranscriptRecord[],
): NativeTranscriptEntry[] {
  return records.flatMap(({ event }) => {
    const messages = event.kind === 'messages' ? event.messages : []
    if (messages.length === 0) {
      return [
        {
          ...(event as unknown as Record<string, unknown>),
          type:
            event.kind === 'tool-execution-started' ? 'assistant' : 'system',
          uuid: event.id,
          parentUuid: event.parentId,
        } as NativeTranscriptEntry,
      ]
    }
    return messages.map(
      (message, index) =>
        ({
          ...(event as unknown as Record<string, unknown>),
          type: message.role,
          uuid: index === 0 ? event.id : `${event.id}:${index}`,
          parentUuid: index === 0 ? event.parentId : event.id,
          message,
        }) as NativeTranscriptEntry,
    )
  })
}

function attachEntries<
  T extends { records: readonly DecodedTranscriptRecord[] },
>(snapshot: T): T & { entries: NativeTranscriptEntry[] } {
  Object.defineProperty(snapshot, 'entries', {
    value: projectNativeTranscriptEntries(snapshot.records),
    enumerable: false,
  })
  return snapshot as T & { entries: NativeTranscriptEntry[] }
}

const hashLine = (line: Uint8Array) =>
  createHash('sha256').update(line).digest('hex')
const emptyTail = (): NativeTranscriptTail => ({
  byteLength: 0,
  lastLineHash: null,
  lastEventId: null,
  newlineTerminated: true,
})
function splitLines(source: Buffer): Buffer[] {
  const end = source.at(-1) === 0x0a ? source.length - 1 : source.length
  if (!end) return []
  const result: Buffer[] = []
  let start = 0
  for (let i = 0; i < end; i++) {
    if (source[i] === 0x0a) {
      result.push(source.subarray(start, i))
      start = i + 1
    }
  }
  result.push(source.subarray(start, end))
  return result
}
function tailFrom(
  source: Buffer,
  records: readonly DecodedTranscriptRecord[],
): NativeTranscriptTail {
  const lines = splitLines(source)
  const line = lines.at(-1)
  return {
    byteLength: source.length,
    lastLineHash: line ? hashLine(line) : null,
    lastEventId: records.at(-1)?.event.id ?? null,
    newlineTerminated: source.length === 0 || source.at(-1) === 0x0a,
  }
}
function equalTail(a: NativeTranscriptTail, b: NativeTranscriptTail) {
  return (
    a.byteLength === b.byteLength &&
    a.lastLineHash === b.lastLineHash &&
    a.lastEventId === b.lastEventId &&
    a.newlineTerminated === b.newlineTerminated
  )
}
function logicalTail(tail: NativeTranscriptTail) {
  return tail.branchParentId === undefined
    ? tail.lastEventId
    : (tail.branchParentId ?? null)
}

function effectiveParentId(event: TranscriptEvent): string | null {
  return event.kind === 'context-boundary'
    ? event.logicalParentId
    : event.parentId
}

function validateHistory(events: readonly TranscriptEvent[]): void {
  const ids = new Set<string>()
  const sessions = new Set<string>()
  const calls = new Set<string>()
  const children = new Map<string, TranscriptEvent[]>()

  for (const [index, event] of events.entries()) {
    if (ids.has(event.id))
      throw new Error(
        'Invalid native transcript invariant: event IDs must be unique',
      )
    if (sessions.size && !sessions.has(event.sessionId))
      throw new Error(
        'Invalid native transcript invariant: sessionId must match history',
      )
    if (event.kind === 'context-boundary') {
      if (event.parentId !== null || !ids.has(event.logicalParentId))
        throw new Error(
          'Invalid native transcript invariant: context boundary logicalParentId must reference history',
        )
    } else if (event.parentId === null) {
      if (index !== 0)
        throw new Error(
          'Invalid native transcript invariant: only the first logical root may have a null parentId',
        )
    } else if (!ids.has(event.parentId)) {
      throw new Error(
        'Invalid native transcript invariant: event parentId must reference an earlier event',
      )
    }
    const parentId = effectiveParentId(event)
    if (parentId !== null) {
      const siblings = children.get(parentId) ?? []
      siblings.push(event)
      children.set(parentId, siblings)
    }
    ids.add(event.id)
    sessions.add(event.sessionId)
    if (event.kind !== 'messages') continue
    for (const message of event.messages) {
      if (message.role !== 'assistant') continue
      for (const call of message.toolCalls ?? []) {
        if (calls.has(call.id))
          throw new Error(
            'Invalid native transcript invariant: assistant tool-call IDs must be unique',
          )
        calls.add(call.id)
      }
    }
  }

  const root = events[0]
  if (!root) return
  type Frame =
    | { event: TranscriptEvent; leaving: false }
    | {
        event: TranscriptEvent
        leaving: true
        addedCalls: string[]
        addedResults: string[]
      }
  const activeCalls = new Set<string>()
  const activeResults = new Set<string>()
  const stack: Frame[] = [{ event: root, leaving: false }]
  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) break
    if (frame.leaving) {
      for (const id of frame.addedCalls) activeCalls.delete(id)
      for (const id of frame.addedResults) activeResults.delete(id)
      continue
    }
    const addedCalls: string[] = []
    const addedResults: string[] = []
    if (frame.event.kind === 'messages') {
      for (const message of frame.event.messages) {
        if (message.role === 'assistant') {
          for (const call of message.toolCalls ?? []) {
            activeCalls.add(call.id)
            addedCalls.push(call.id)
          }
        } else if (message.role === 'tool') {
          if (!activeCalls.has(message.toolCallId))
            throw new Error(
              'Invalid native transcript invariant: tool result references unknown tool call on active ancestry',
            )
          if (activeResults.has(message.toolCallId))
            throw new Error(
              'Invalid native transcript invariant: tool call has multiple results on active ancestry',
            )
          activeResults.add(message.toolCallId)
          addedResults.push(message.toolCallId)
        }
      }
    }
    stack.push({
      event: frame.event,
      leaving: true,
      addedCalls,
      addedResults,
    })
    const descendants = children.get(frame.event.id) ?? []
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      const descendant = descendants[index]
      if (descendant) stack.push({ event: descendant, leaving: false })
    }
  }
}

export class NativeTranscriptStore {
  private readonly lease: ExclusiveFileLease
  constructor(
    private readonly options: { transcriptFile: string; lockFile: string },
  ) {
    this.lease = new ExclusiveFileLease(options.lockFile)
  }
  private async source() {
    try {
      return await readFile(this.options.transcriptFile)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
      throw e
    }
  }
  private decode(source: Buffer, recover: boolean): NativeTranscriptRecovery {
    if (!source.length)
      return attachEntries({ records: [], tail: emptyTail(), issue: null })
    const decoded = createNativeTranscriptCodec().decodeDocument(source)
    if (decoded.issue && !recover)
      throw new Error(`Invalid native transcript: ${decoded.issue.message}`)
    if (!recover) validateHistory(decoded.records.map((record) => record.event))
    return attachEntries({
      records: decoded.records,
      tail: tailFrom(source, decoded.records),
      issue: decoded.issue,
    })
  }
  async load(): Promise<NativeTranscriptSnapshot> {
    const { records, tail } = this.decode(await this.source(), false)
    return attachEntries({ records, tail })
  }
  async loadReadOnly() {
    return this.decode(await this.source(), true)
  }
  async exportReadOnly() {
    return this.source()
  }
  private prepare(
    history: readonly DecodedTranscriptRecord[],
    events: readonly TranscriptEvent[],
    expected: NativeTranscriptTail,
  ) {
    if (!events.length)
      throw new Error('Cannot append an empty native transcript batch')
    const all = history.map((r) => r.event)
    const historicalIds = new Set<string>(all.map((event) => event.id))
    if (
      expected.branchParentId !== undefined &&
      expected.branchParentId !== null &&
      !historicalIds.has(expected.branchParentId)
    )
      throw new Error(
        'Invalid native transcript invariant: branchParentId must reference an earlier event',
      )
    validateHistory([...history.map((record) => record.event), ...events])
    const ids = new Set<string>()
    const sessions = new Set<string>()
    for (const e of all) {
      if (ids.has(e.id))
        throw new Error(
          'Invalid native transcript invariant: event IDs must be unique',
        )
      if (sessions.size && !sessions.has(e.sessionId))
        throw new Error(
          'Invalid native transcript invariant: sessionId must match history',
        )
      ids.add(e.id)
      sessions.add(e.sessionId)
    }
    let parent = logicalTail(expected)
    const lines: Buffer[] = []
    for (const event of events) {
      const codec = createNativeTranscriptCodec()
      const encoded = codec.encodeLine(event)
      if (!encoded.ok)
        throw new Error(
          `Invalid native transcript event: ${encoded.issue.message}`,
        )
      if (ids.has(event.id))
        throw new Error(
          'Invalid native transcript invariant: event IDs must be unique',
        )
      if (sessions.size && !sessions.has(event.sessionId))
        throw new Error(
          'Invalid native transcript invariant: sessionId must match history',
        )
      sessions.add(event.sessionId)
      if (event.kind === 'context-boundary') {
        if (event.parentId !== null || !ids.has(event.logicalParentId))
          throw new Error(
            'Invalid native transcript invariant: context boundary logicalParentId must reference history',
          )
        parent = event.id
      } else if (event.parentId !== parent)
        throw new Error(
          'Invalid native transcript invariant: event parentId does not match logical tail',
        )
      lines.push(Buffer.from(`${encoded.line}\n`))
      ids.add(event.id)
      parent = event.id
    }
    return Buffer.concat(lines)
  }
  async create(
    events: readonly TranscriptEvent[],
  ): Promise<NativeTranscriptCreateResult> {
    const bytes = this.prepare([], events, emptyTail())
    await mkdir(dirname(this.options.transcriptFile), { recursive: true })
    let handle
    try {
      handle = await open(this.options.transcriptFile, 'wx', 0o600)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        return { status: 'conflict', reason: 'already-exists' }
      throw e
    }
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { status: 'created', tail: (await this.load()).tail }
  }
  private async reserveUnderLease(): Promise<NativeTranscriptReserveResult> {
    await mkdir(dirname(this.options.transcriptFile), { recursive: true })
    let handle
    try {
      handle = await open(this.options.transcriptFile, 'wx', 0o600)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        return { status: 'conflict', reason: 'already-exists' }
      throw e
    }
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    return { status: 'reserved' }
  }
  async withLease<T>(
    operation: (lease: NativeTranscriptLease) => Promise<T>,
  ): Promise<NativeTranscriptLeaseResult<T>> {
    const lock = await this.lease.tryAcquire()
    if (!lock) return { status: 'conflict', reason: 'locked' }
    try {
      const value = await operation({
        reserve: () => this.reserveUnderLease(),
        load: () => this.load(),
        append: (tail, event) => this.appendUnderLease(tail, [event]),
        appendMany: (tail, events) => this.appendUnderLease(tail, events),
      })
      return { status: 'completed', value }
    } finally {
      await lock.release()
    }
  }
  private async appendUnderLease(
    expected: NativeTranscriptTail,
    events: readonly TranscriptEvent[],
  ): Promise<NativeTranscriptAppendResult> {
    const current = await this.load()
    if (!equalTail(current.tail, expected))
      return { status: 'conflict', reason: 'tail-changed' }
    if (!current.tail.newlineTerminated)
      throw new Error(
        'Invalid native transcript: file is not newline-terminated',
      )
    const bytes = this.prepare(current.records, events, expected)
    await mkdir(dirname(this.options.transcriptFile), { recursive: true })
    const handle = await open(this.options.transcriptFile, 'a')
    try {
      const stat = await handle.stat()
      if (stat.size !== expected.byteLength)
        return { status: 'conflict', reason: 'tail-changed' }
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    let written: Buffer
    try {
      written = await readFile(this.options.transcriptFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { status: 'conflict', reason: 'tail-changed' }
      throw error
    }
    if (
      classifyTranscriptAppend(written, expected.byteLength, bytes) ===
      'interleaved-write'
    )
      return { status: 'conflict', reason: 'interleaved-write' }
    const tail = (await this.load()).tail
    return { status: 'appended', tail }
  }
  async append(expectedTail: NativeTranscriptTail, event: TranscriptEvent) {
    const result = await this.withLease((lease) =>
      lease.append(expectedTail, event),
    )
    return result.status === 'completed' ? result.value : result
  }
}
