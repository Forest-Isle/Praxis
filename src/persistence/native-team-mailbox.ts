import { chmod, readFile, open } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  parseTeamMailboxMessageId,
  parseTeamMailboxMessage,
  type TeamMailboxMessage,
  type TeamMailboxPayload,
} from '../core/team-mailbox.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../platform/exclusive-file-lease.js'
import { writeFileAtomically } from '../platform/atomic-write.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import { parseTeamId } from '../core/team-ownership.js'

export interface NativeTeamMailboxRetention {
  readonly maxRecords?: number
  readonly maxBytes?: number
}

export interface NativeTeamMailboxOptions {
  readonly nativeRoot: string
  readonly projectIdentity: string
  readonly teamId: string
  readonly participants: readonly string[]
  readonly retention?: NativeTeamMailboxRetention
}

export interface NativeTeamMailboxAppendInput {
  readonly messageId: string
  readonly sender: string
  readonly recipients: readonly string[]
  readonly payload: TeamMailboxPayload
  readonly createdAt?: string
}

export interface NativeTeamMailboxAppendResult {
  readonly message: TeamMailboxMessage
  readonly inserted: boolean
}

export interface NativeTeamMailboxReadProof {
  readonly participant: string
  readonly expectedCursor: number
  readonly throughSequence: number
  readonly messageIds: readonly string[]
}

export interface NativeTeamMailboxReadResult {
  readonly messages: readonly TeamMailboxMessage[]
  readonly expectedCursor: number
  readonly throughSequence: number
  readonly messageIds: readonly string[]
  readonly proof: NativeTeamMailboxReadProof
}

interface MailboxState {
  readonly version: 1
  readonly revision: number
  readonly teamId: string
  readonly projectIdentity: string
  readonly nextSequence: number
  readonly prunedThrough: number
  readonly cursors: Record<string, number>
  readonly updatedAt: string
}

const DEFAULT_MAX_RECORDS = 4096
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`Invalid ${label}`)
  return value
}

function strictParticipant(value: unknown, label: string): string {
  return nonblank(value, label)
}

function increment(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    throw new Error(`${label} exhausted`)
  return value + 1
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw new Error(`Unknown mailbox state field: ${key}`)
}

function iso(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !ISO.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('Invalid mailbox state timestamp')
  return value
}

function now(): string {
  return new Date().toISOString()
}

function serialized(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function sameContent(
  left: TeamMailboxMessage,
  right: TeamMailboxMessage,
): boolean {
  return (
    left.teamId === right.teamId &&
    left.sender === right.sender &&
    JSON.stringify(left.recipients) === JSON.stringify(right.recipients) &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  )
}

export class NativeTeamMailbox {
  readonly messagesPath: string
  readonly statePath: string
  readonly mutationPath: string
  private readonly participants: readonly string[]
  private readonly participantSet: ReadonlySet<string>
  private readonly maxRecords: number
  private readonly maxBytes: number
  private mutation: Promise<void> = Promise.resolve()

  private constructor(private readonly options: NativeTeamMailboxOptions) {
    const root = resolve(options.nativeRoot)
    const directory = resolve(
      root,
      'state',
      'teams',
      sanitizeProjectPath(options.projectIdentity),
      options.teamId,
      'mailbox',
    )
    this.messagesPath = resolve(directory, 'messages.jsonl')
    this.statePath = resolve(directory, 'state.json')
    this.mutationPath = resolve(directory, 'mutation.lock')
    this.participants = Object.freeze([...options.participants])
    this.participantSet = new Set(this.participants)
    this.maxRecords = options.retention?.maxRecords ?? DEFAULT_MAX_RECORDS
    this.maxBytes = options.retention?.maxBytes ?? DEFAULT_MAX_BYTES
  }

  static open(options: NativeTeamMailboxOptions): NativeTeamMailbox {
    if (
      typeof options.nativeRoot !== 'string' ||
      options.nativeRoot.trim() === ''
    )
      throw new Error('Invalid native mailbox root')
    const projectIdentity = nonblank(
      options.projectIdentity,
      'project identity',
    )
    const teamId = parseTeamId(options.teamId)
    if (
      !Array.isArray(options.participants) ||
      options.participants.length === 0
    )
      throw new Error('Invalid mailbox participants')
    const participants = options.participants.map((entry) =>
      strictParticipant(entry, 'participant'),
    )
    if (new Set(participants).size !== participants.length)
      throw new Error('Duplicate mailbox participant')
    if (!participants.includes('lead'))
      throw new Error('Mailbox participants must include lead')
    const maxRecords = options.retention?.maxRecords ?? DEFAULT_MAX_RECORDS
    const maxBytes = options.retention?.maxBytes ?? DEFAULT_MAX_BYTES
    if (!Number.isSafeInteger(maxRecords) || maxRecords <= 0)
      throw new Error('Invalid mailbox maxRecords')
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error('Invalid mailbox maxBytes')
    return new NativeTeamMailbox({
      ...options,
      projectIdentity,
      teamId,
      participants,
      retention: { maxRecords, maxBytes },
    })
  }

  append(
    input: NativeTeamMailboxAppendInput,
  ): Promise<NativeTeamMailboxAppendResult> {
    return this.enqueue(() =>
      this.mutate<NativeTeamMailboxAppendResult>(async (state, records) => {
        const candidate = parseTeamMailboxMessage({
          version: 1,
          sequence: state.nextSequence,
          messageId: input.messageId,
          teamId: this.options.teamId,
          sender: input.sender,
          recipients: input.recipients,
          payload: input.payload,
          createdAt: input.createdAt ?? now(),
        })
        this.assertParticipants(candidate)
        const duplicate = records.find(
          (record) => record.messageId === candidate.messageId,
        )
        if (duplicate) {
          if (!sameContent(duplicate, candidate))
            throw new Error(
              'Mailbox message ID conflicts with existing content',
            )
          return {
            result: { message: duplicate, inserted: false },
            state,
            records,
          }
        }
        let bytes = records.reduce(
          (total, record) =>
            total + Buffer.byteLength(serialized(record), 'utf8'),
          0,
        )
        const appendedBytes = Buffer.byteLength(serialized(candidate), 'utf8')
        if (
          records.length + 1 > this.maxRecords ||
          bytes + appendedBytes > this.maxBytes
        ) {
          const compacted = await this.compact(state, records)
          state = compacted.state
          records = compacted.records
          bytes = records.reduce(
            (total, record) =>
              total + Buffer.byteLength(serialized(record), 'utf8'),
            0,
          )
        }
        if (
          records.length + 1 > this.maxRecords ||
          bytes + appendedBytes > this.maxBytes
        )
          throw new Error(
            'Team mailbox backpressure: unread messages exceed retention bounds',
          )
        const nextSequence = increment(candidate.sequence, 'Mailbox sequence')
        const nextRevision = increment(state.revision, 'Mailbox revision')
        const line = serialized(candidate)
        const handle = await open(this.messagesPath, 'a', 0o600)
        let offset = 0
        try {
          await chmod(this.messagesPath, 0o600)
          const stat = await handle.stat()
          offset = stat.size
          await handle.writeFile(line, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        const exact = await readFile(this.messagesPath)
        const expected = Buffer.from(line, 'utf8')
        if (!exact.subarray(offset).equals(expected))
          throw new Error('Mailbox append verification failed')
        const nextState: MailboxState = {
          ...state,
          revision: nextRevision,
          nextSequence,
          updatedAt: now(),
        }
        await this.writeState(nextState)
        return {
          result: { message: candidate, inserted: true },
          state: nextState,
          records: [...records, candidate],
        }
      }),
    )
  }

  read(
    participant: string,
    bounds: { maxMessages?: number } = {},
  ): Promise<NativeTeamMailboxReadResult> {
    return this.enqueue(() =>
      this.mutate(async (state, records) => {
        this.assertParticipant(participant)
        const expectedCursor = state.cursors[participant] ?? 0
        const maxMessages = bounds.maxMessages ?? Number.MAX_SAFE_INTEGER
        if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0)
          throw new Error('Invalid mailbox read maxMessages')
        const messages = records
          .filter(
            (record) =>
              record.sequence > expectedCursor &&
              record.recipients.includes(participant),
          )
          .slice(0, maxMessages)
        const throughSequence = messages.at(-1)?.sequence ?? expectedCursor
        const messageIds = messages.map((message) => message.messageId)
        return {
          result: {
            messages: Object.freeze(messages),
            expectedCursor,
            throughSequence,
            messageIds: Object.freeze(messageIds),
            proof: Object.freeze({
              participant,
              expectedCursor,
              throughSequence,
              messageIds: Object.freeze(messageIds),
            }),
          },
          state,
          records,
        }
      }),
    )
  }

  acknowledge(proof: NativeTeamMailboxReadProof): Promise<void> {
    return this.enqueue(() =>
      this.mutate(async (state, records) => {
        this.assertParticipant(proof.participant)
        if (
          !Number.isSafeInteger(proof.expectedCursor) ||
          proof.expectedCursor < 0 ||
          !Number.isSafeInteger(proof.throughSequence) ||
          proof.throughSequence < proof.expectedCursor ||
          !Array.isArray(proof.messageIds) ||
          proof.messageIds.some((messageId) => {
            try {
              parseTeamMailboxMessageId(messageId)
              return false
            } catch {
              return true
            }
          })
        )
          throw new Error('Invalid mailbox acknowledgement proof')
        const current = state.cursors[proof.participant] ?? 0
        if (proof.throughSequence >= state.nextSequence)
          throw new Error(
            'Mailbox acknowledgement exceeds durable high-watermark',
          )
        const targeted = records.filter(
          (record) =>
            record.sequence > proof.expectedCursor &&
            record.sequence <= proof.throughSequence &&
            record.recipients.includes(proof.participant),
        )
        const matches =
          targeted.length === proof.messageIds.length &&
          targeted.every(
            (record, index) => record.messageId === proof.messageIds[index],
          )
        if (proof.expectedCursor < current) {
          if (proof.throughSequence > current)
            throw new Error('Stale mailbox acknowledgement proof')
          if (proof.expectedCursor < state.prunedThrough || !matches)
            throw new Error(
              'Mailbox acknowledgement proof is outside the retained window',
            )
          return { result: undefined, state, records }
        }
        if (proof.expectedCursor > current)
          throw new Error('Mailbox acknowledgement cursor skipped')
        if (!matches)
          throw new Error(
            'Mailbox acknowledgement proof does not match unread messages',
          )
        const nextCursors = {
          ...state.cursors,
          [proof.participant]: proof.throughSequence,
        }
        const nextRevision = increment(state.revision, 'Mailbox revision')
        const nextState: MailboxState = {
          ...state,
          revision: nextRevision,
          cursors: nextCursors,
          updatedAt: now(),
        }
        await this.writeState(nextState)
        return { result: undefined, state: nextState, records }
      }),
    ).then(() => undefined)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation)
    this.mutation = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async mutate<T>(
    operation: (
      state: MailboxState,
      records: TeamMailboxMessage[],
    ) => Promise<{
      result: T
      state: MailboxState
      records: TeamMailboxMessage[]
    }>,
  ): Promise<T> {
    const lease = await this.acquireMutation()
    try {
      const { state, records } = await this.load()
      const output = await operation(state, records)
      return output.result
    } finally {
      await lease.release()
    }
  }

  private async acquireMutation(): Promise<ExclusiveFileLeaseHandle> {
    const deadline = Date.now() + 5000
    for (;;) {
      const lease = await new ExclusiveFileLease(this.mutationPath).tryAcquire()
      if (lease) return lease
      if (Date.now() >= deadline)
        throw new Error(`Team mailbox mutation is busy: ${this.mutationPath}`)
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10))
    }
  }

  private async load(): Promise<{
    state: MailboxState
    records: TeamMailboxMessage[]
  }> {
    const state = await this.loadState()
    await this.ensureMode(this.statePath)
    await this.ensureMode(this.messagesPath)
    let source = ''
    try {
      source = await readFile(this.messagesPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (source && !source.endsWith('\n')) {
      const lastNewline = source.lastIndexOf('\n')
      const committedBytes =
        lastNewline < 0
          ? 0
          : Buffer.byteLength(source.slice(0, lastNewline + 1), 'utf8')
      await this.truncateAndSync(committedBytes)
      source = lastNewline < 0 ? '' : source.slice(0, lastNewline + 1)
    }
    const records: TeamMailboxMessage[] = []
    let previous: number | undefined
    let retainedStarted = false
    let prunedRows = 0
    const ids = new Set<string>()
    const lines = source.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line === undefined) throw new Error('Invalid mailbox record line')
      if (!line) {
        if (index === lines.length - 1) continue
        throw new Error('Invalid blank Team mailbox record')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        throw new Error('Corrupt Team mailbox record', { cause: error })
      }
      const message = parseTeamMailboxMessage(parsed)
      this.assertParticipants(message, state)
      if (ids.has(message.messageId))
        throw new Error('Duplicate Team mailbox message ID')
      ids.add(message.messageId)
      if (
        previous !== undefined &&
        message.sequence !== increment(previous, 'Mailbox sequence')
      )
        throw new Error('Team mailbox physical records are not contiguous')
      if (message.sequence <= state.prunedThrough) {
        if (retainedStarted)
          throw new Error('Invalid pruned Team mailbox prefix')
        previous = message.sequence
        prunedRows += 1
        continue
      }
      const expected = increment(state.prunedThrough, 'Mailbox sequence')
      retainedStarted = true
      if (records.length === 0 && message.sequence !== expected)
        throw new Error('Team mailbox records are not contiguous')
      records.push(message)
      previous = message.sequence
    }
    if (prunedRows > 0 && !retainedStarted && previous !== state.prunedThrough)
      throw new Error('Incomplete pruned Team mailbox prefix')
    const expectedNext = retainedStarted
      ? increment(previous as number, 'Mailbox sequence')
      : increment(state.prunedThrough, 'Mailbox sequence')
    if (state.nextSequence > expectedNext)
      throw new Error('Mailbox state high-watermark is not durable')
    if (state.nextSequence < expectedNext) {
      const nextRevision = increment(state.revision, 'Mailbox revision')
      const nextState = {
        ...state,
        nextSequence: expectedNext,
        revision: nextRevision,
        updatedAt: now(),
      }
      await this.writeState(nextState)
      if (prunedRows > 0) await this.rewriteRecords(records)
      return { state: nextState, records }
    }
    if (prunedRows > 0) await this.rewriteRecords(records)
    return { state, records }
  }

  private async truncateAndSync(bytes: number): Promise<void> {
    const handle = await open(this.messagesPath, 'r+')
    try {
      await handle.truncate(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async rewriteRecords(
    records: readonly TeamMailboxMessage[],
  ): Promise<void> {
    await writeFileAtomically(
      this.messagesPath,
      records.map(serialized).join(''),
      { mode: 0o600 },
    )
  }

  private async ensureMode(path: string): Promise<void> {
    try {
      await chmod(path, 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async loadState(): Promise<MailboxState> {
    let source: string
    try {
      source = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const state = this.initialState()
      await this.writeState(state)
      return state
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch (error) {
      throw new Error('Corrupt Team mailbox state', { cause: error })
    }
    const sourceObject = object(value, 'mailbox state')
    closed(sourceObject, [
      'version',
      'revision',
      'teamId',
      'projectIdentity',
      'nextSequence',
      'prunedThrough',
      'cursors',
      'updatedAt',
    ])
    if (
      sourceObject.version !== 1 ||
      !Number.isSafeInteger(sourceObject.revision) ||
      (sourceObject.revision as number) < 0 ||
      !Number.isSafeInteger(sourceObject.nextSequence) ||
      (sourceObject.nextSequence as number) <= 0 ||
      !Number.isSafeInteger(sourceObject.prunedThrough) ||
      (sourceObject.prunedThrough as number) < 0 ||
      (sourceObject.nextSequence as number) <=
        (sourceObject.prunedThrough as number)
    )
      throw new Error('Invalid Team mailbox state counters')
    if (
      sourceObject.teamId !== this.options.teamId ||
      sourceObject.projectIdentity !== this.options.projectIdentity
    )
      throw new Error('Invalid Team mailbox state identity')
    const cursorsObject = object(sourceObject.cursors, 'mailbox cursors')
    const cursorParticipants = Object.keys(cursorsObject)
    if (cursorParticipants.some((key) => key.trim() === ''))
      throw new Error('Invalid mailbox cursor participant')
    const cursors = Object.create(null) as Record<string, number>
    let addedCurrentCursor = false
    for (const historical of cursorParticipants) {
      const cursor = cursorsObject[historical]
      if (
        !Number.isSafeInteger(cursor) ||
        (cursor as number) < 0 ||
        (cursor as number) > (sourceObject.nextSequence as number) - 1
      )
        throw new Error('Invalid mailbox cursor')
      cursors[historical] = cursor as number
    }
    for (const participant of this.participants) {
      if (!Object.hasOwn(cursorsObject, participant)) {
        cursors[participant] = sourceObject.prunedThrough as number
        addedCurrentCursor = true
      }
    }
    const parsedState: MailboxState = {
      version: 1,
      revision: sourceObject.revision as number,
      teamId: this.options.teamId,
      projectIdentity: this.options.projectIdentity,
      nextSequence: sourceObject.nextSequence as number,
      prunedThrough: sourceObject.prunedThrough as number,
      cursors,
      updatedAt: iso(sourceObject.updatedAt),
    }
    if (!addedCurrentCursor) return parsedState
    const reconciled: MailboxState = {
      ...parsedState,
      revision: increment(parsedState.revision, 'Mailbox revision'),
      updatedAt: now(),
    }
    await this.writeState(reconciled)
    return reconciled
  }

  private initialState(): MailboxState {
    return {
      version: 1,
      revision: 0,
      teamId: this.options.teamId,
      projectIdentity: this.options.projectIdentity,
      nextSequence: 1,
      prunedThrough: 0,
      cursors: Object.fromEntries(
        this.participants.map((participant) => [participant, 0]),
      ),
      updatedAt: now(),
    }
  }

  private async writeState(state: MailboxState): Promise<void> {
    await writeFileAtomically(this.statePath, serialized(state), {
      mode: 0o600,
    })
  }

  private async compact(
    state: MailboxState,
    records: TeamMailboxMessage[],
  ): Promise<{ state: MailboxState; records: TeamMailboxMessage[] }> {
    let count = 0
    let bytes = 0
    for (const record of records) {
      if (
        !record.recipients.every(
          (participant) => (state.cursors[participant] ?? 0) >= record.sequence,
        )
      )
        break
      count += 1
      bytes += Buffer.byteLength(serialized(record), 'utf8')
    }
    if (count === 0) return { state, records }
    const last = records[count - 1]
    if (!last) return { state, records }
    const nextState: MailboxState = {
      ...state,
      revision: increment(state.revision, 'Mailbox revision'),
      prunedThrough: last.sequence,
      updatedAt: now(),
    }
    await this.writeState(nextState)
    await writeFileAtomically(
      this.messagesPath,
      records.slice(count).map(serialized).join(''),
      { mode: 0o600 },
    )
    void bytes
    return { state: nextState, records: records.slice(count) }
  }

  private assertParticipant(participant: string): void {
    const value = strictParticipant(participant, 'participant')
    if (!this.participantSet.has(value))
      throw new Error(`Unknown mailbox participant: ${value}`)
  }

  private assertParticipants(
    message: TeamMailboxMessage,
    state?: MailboxState,
  ): void {
    const known = state
      ? new Set(Object.keys(state.cursors))
      : this.participantSet
    const assertKnown = (value: string) => {
      if (!known.has(value))
        throw new Error(`Unknown mailbox participant: ${value}`)
    }
    assertKnown(message.sender)
    for (const recipient of message.recipients) assertKnown(recipient)
    if (message.recipients.includes(message.sender))
      throw new Error('Mailbox sender cannot be a recipient')
    if (message.teamId !== this.options.teamId)
      throw new Error('Mailbox Team identity mismatch')
  }
}
