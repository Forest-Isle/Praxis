import { randomUUID } from 'node:crypto'

import type {
  ModelMessage,
  ModelToolCall,
  ToolExecutionResult,
} from '../core/runtime.js'
import type {
  TranscriptEvent,
  TranscriptMessagesEvent,
} from '../core/transcript-event.js'
import {
  activeEvents,
  projectActiveMessages,
  unresolvedActiveToolCallIds,
} from './transcript-projection.js'
import type {
  NativeTranscriptLease,
  NativeTranscriptLeaseResult,
  NativeTranscriptSnapshot,
  NativeTranscriptTail,
} from '../persistence/native-transcript-store.js'

/** Minimal transcript-store contract required by the native session facade. */
export interface NativeSessionTranscriptStore {
  withLease<T>(
    operation: (lease: NativeTranscriptLease) => Promise<T>,
  ): Promise<NativeTranscriptLeaseResult<T>>
}

export type NativeTranscriptActivation =
  | { readonly kind: 'start' }
  | { readonly kind: 'resume'; readonly atEventId?: string }

export interface NativeMessageAppend {
  readonly messages: readonly ModelMessage[]
  readonly model?: string
  readonly terminalReason?: TranscriptMessagesEvent['terminalReason']
}

export interface NativeCompactionAppend {
  readonly summary: string
  readonly trigger: 'auto' | 'manual'
  readonly preTokens: number
  readonly postTokens: number
  readonly durationMs: number
  readonly preservedMessages?: readonly ModelMessage[]
  /** Optional parent in the active branch when compacting a selected range. */
  readonly logicalParentId?: string
  readonly direction?: 'from' | 'up_to'
  readonly messagesSummarized?: number
  readonly preservePrefix?: boolean
}

export type NativeInterruption =
  | { readonly kind: 'complete' | 'none' }
  | { readonly kind: 'interrupted-prompt'; readonly prompt: string }
  | { readonly kind: 'interrupted-turn' }
  | {
      readonly kind: 'recoverable-tools'
      readonly calls: readonly ModelToolCall[]
    }
  | {
      readonly kind: 'indeterminate-tools'
      readonly callIds: readonly string[]
    }

export interface NativeSessionTranscriptLease {
  /** Events on the currently selected active branch, in parent order. */
  activeEvents(): TranscriptEvent[]
  activeMessages(): ModelMessage[]
  interruption(): NativeInterruption
  beginToolExecution(callId: string): Promise<void>
  appendToolCompletion(input: {
    callId: string
    result: ToolExecutionResult
    followUpUserMessages?: readonly string[]
  }): Promise<void>
  appendMessages(input: NativeMessageAppend): Promise<string>
  appendCompaction(input: NativeCompactionAppend): Promise<{
    boundaryId: string
    summaryId: string
  }>
}

export interface NativeForkOptions {
  readonly atEventId?: string
  readonly recordCount?: number
  readonly ensureExisting?: boolean
}

export interface NativeSessionTranscriptOptions {
  readonly sessionId: string
  readonly store: NativeSessionTranscriptStore
  readonly createId?: () => string
  readonly now?: () => string
}

export class NativeSessionTranscript {
  private readonly sessionId: string
  private readonly store: NativeSessionTranscriptStore
  private readonly createId: () => string
  private readonly now: () => string

  constructor(options: NativeSessionTranscriptOptions) {
    this.sessionId = options.sessionId
    this.store = options.store
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async forkTo(
    target: NativeSessionTranscript,
    options: NativeForkOptions = {},
  ): Promise<void> {
    if (this.sessionId === target.sessionId)
      throw new Error('native fork source and target session IDs must differ')
    const sourceResult = await this.store.withLease((lease) => lease.load())
    if (sourceResult.status === 'conflict')
      throw new Error(
        `native fork source lease conflict: ${sourceResult.reason}`,
      )
    const source = sourceResult.value
    if (source.records.length === 0)
      throw new Error('native fork source session is missing or empty')
    if (
      source.records.some((record) => record.event.sessionId !== this.sessionId)
    )
      throw new Error('native fork source sessionId does not match')
    const recordCount = options.recordCount
    if (
      recordCount !== undefined &&
      (!Number.isSafeInteger(recordCount) ||
        recordCount <= 0 ||
        recordCount > source.records.length)
    )
      throw new Error('native fork source recordCount is invalid')
    const prefix = source.records.slice(0, recordCount)
    const selected = activeEvents(
      prefix.map((record) => record.event),
      options.atEventId,
    )
    const terminal = prefix.at(-1)?.event
    if (
      terminal?.kind === 'context-boundary' ||
      selected.at(-1)?.kind === 'context-boundary'
    )
      throw new Error(
        'native fork source ends with an incomplete context boundary',
      )
    const expected = selected.map((event) => ({
      ...event,
      sessionId: target.sessionId,
    }))
    const ensureExisting = options.ensureExisting === true
    const targetResult = await target.store.withLease(async (lease) => {
      const reservation = await lease.reserve()
      if (reservation.status === 'reserved') {
        const empty = await lease.load()
        const appended = await lease.appendMany(empty.tail, expected)
        if (appended.status === 'conflict')
          throw new Error(
            `native fork target append conflict: ${appended.reason}`,
          )
        return
      }
      if (!ensureExisting) throw new Error('native fork target already exists')
      const existing = await lease.load()
      if (
        existing.records.length < expected.length ||
        expected.some(
          (event, index) =>
            JSON.stringify(existing.records[index]?.event) !==
            JSON.stringify(event),
        )
      )
        throw new Error('native fork target is not the expected native fork')
    })
    if (targetResult.status === 'conflict')
      throw new Error(
        `native fork target lease conflict: ${targetResult.reason}`,
      )
  }

  async withLease<T>(
    activation: NativeTranscriptActivation,
    operation: (lease: NativeSessionTranscriptLease) => Promise<T>,
  ): Promise<T> {
    let prepared: NativeTranscriptSnapshot | undefined
    let selectedId: string | undefined
    const result = await this.store.withLease(async (nativeLease) => {
      if (activation.kind === 'start') {
        const reserved = await nativeLease.reserve()
        if (reserved.status === 'conflict')
          throw new Error('native transcript session already exists')
      }
      prepared = await nativeLease.load()
      if (activation.kind === 'resume') {
        if (prepared.records.length === 0)
          throw new Error('native transcript session is missing or empty')
        if (
          prepared.records.some(
            (record) => record.event.sessionId !== this.sessionId,
          )
        )
          throw new Error('native transcript sessionId does not match')
        const events = prepared.records.map((record) => record.event)
        const selected = activeEvents(events, activation.atEventId)
        if (selected.length === 0)
          throw new Error('native transcript session has no active events')
        selectedId = selected.at(-1)?.id
      }
      const initial = prepared
      const currentId = selectedId ?? initial.records.at(-1)?.event.id ?? null
      const records = [...initial.records]
      const usedIds = new Set(records.map((record) => record.event.id))
      const createUniqueId = (): string => {
        let id = this.createId()
        while (usedIds.has(id)) id = this.createId()
        usedIds.add(id)
        return id
      }
      let tail: NativeTranscriptTail =
        currentId === null
          ? initial.tail
          : { ...initial.tail, branchParentId: currentId }
      let activeId = currentId
      let mutationQueue: Promise<void> = Promise.resolve()
      const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = mutationQueue.then(operation, operation)
        mutationQueue = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      }
      const lease: NativeSessionTranscriptLease = {
        activeEvents: () =>
          activeEvents(
            records.map((record) => record.event),
            activeId ?? undefined,
          ).slice(),
        activeMessages: () =>
          projectActiveMessages(
            records.map((record) => record.event),
            activeId ?? undefined,
          ).slice(),
        interruption: () => {
          const events = activeEvents(
            records.map((record) => record.event),
            activeId ?? undefined,
          )
          const boundaryIndex = Math.max(
            -1,
            ...events
              .map((event, index) =>
                event.kind === 'context-boundary' ? index : -1,
              )
              .filter((index) => index >= 0),
          )
          const active = events.slice(boundaryIndex + 1)
          const calls = new Map<string, ModelToolCall>()
          const results = new Set<string>()
          const claimed = new Set<string>()
          for (const event of active) {
            if (event.kind === 'tool-execution-started') {
              claimed.add(event.callId)
              continue
            }
            if (event.kind !== 'messages') continue
            for (const message of event.messages) {
              if (message.role === 'assistant')
                for (const call of message.toolCalls ?? [])
                  calls.set(call.id, call)
              else if (message.role === 'tool') results.add(message.toolCallId)
            }
          }
          const unresolved = [...calls.entries()].filter(
            ([id]) => !results.has(id),
          )
          const indeterminate = unresolved
            .map(([id]) => id)
            .filter((id) => claimed.has(id))
          if (indeterminate.length > 0)
            return { kind: 'indeterminate-tools', callIds: indeterminate }
          if (unresolved.length > 0)
            return {
              kind: 'recoverable-tools',
              calls: unresolved.map(([, call]) => call),
            }
          let lastMessages: readonly ModelMessage[] | undefined
          for (const event of active) {
            if (event.kind !== 'messages') continue
            lastMessages = event.messages
          }
          const lastMessage = lastMessages?.at(-1)
          if (lastMessage?.role === 'assistant') return { kind: 'complete' }
          if (lastMessages?.some((message) => message.role === 'tool'))
            return { kind: 'interrupted-turn' }
          if (lastMessage?.role === 'user')
            return { kind: 'interrupted-prompt', prompt: lastMessage.content }
          return { kind: 'none' }
        },
        beginToolExecution: (callId) =>
          enqueue(async () => {
            const events = activeEvents(
              records.map((record) => record.event),
              activeId ?? undefined,
            )
            const activeMessages = projectActiveMessages(
              records.map((record) => record.event),
              activeId ?? undefined,
            )
            const call = activeMessages
              .filter(
                (
                  message,
                ): message is Extract<ModelMessage, { role: 'assistant' }> =>
                  message.role === 'assistant',
              )
              .flatMap((message) => message.toolCalls ?? [])
              .find((candidate) => candidate.id === callId)
            if (!call) throw new Error(`Unknown native tool call: ${callId}`)
            const boundaryIndex = Math.max(
              -1,
              ...events.map((event, index) =>
                event.kind === 'context-boundary' ? index : -1,
              ),
            )
            const postBoundary = events.slice(boundaryIndex + 1)
            const resolved = new Set(
              projectActiveMessages(
                records.map((record) => record.event),
                activeId ?? undefined,
              )
                .filter((message) => message.role === 'tool')
                .map((message) => message.toolCallId),
            )
            if (resolved.has(callId))
              throw new Error(`Native tool call is already resolved: ${callId}`)
            if (
              postBoundary.some(
                (event) =>
                  event.kind === 'tool-execution-started' &&
                  event.callId === callId,
              )
            )
              throw new Error(`Native tool call already claimed: ${callId}`)
            const event: TranscriptEvent = {
              kind: 'tool-execution-started',
              id: createUniqueId(),
              parentId: activeId,
              sessionId: this.sessionId,
              timestamp: this.now(),
              callId,
            }
            const appended = await nativeLease.append(tail, event)
            if (appended.status === 'conflict')
              throw new Error(
                `native transcript append conflict: ${appended.reason}`,
              )
            records.push({ event })
            tail = appended.tail
            activeId = event.id
          }),
        appendToolCompletion: (input) =>
          enqueue(async () => {
            const { callId, result, followUpUserMessages = [] } = input
            const events = activeEvents(
              records.map((record) => record.event),
              activeId ?? undefined,
            )
            const messages = projectActiveMessages(
              records.map((record) => record.event),
              activeId ?? undefined,
            )
            const call = messages
              .filter(
                (
                  message,
                ): message is Extract<ModelMessage, { role: 'assistant' }> =>
                  message.role === 'assistant',
              )
              .flatMap((message) => message.toolCalls ?? [])
              .find((candidate) => candidate.id === callId)
            if (!call) throw new Error(`Unknown native tool call: ${callId}`)
            if (
              !events.some(
                (event) =>
                  event.kind === 'tool-execution-started' &&
                  event.callId === callId,
              )
            )
              throw new Error(`Native tool call was not claimed: ${callId}`)
            if (
              messages.some(
                (message) =>
                  message.role === 'tool' && message.toolCallId === callId,
              )
            )
              throw new Error(`Native tool call is already resolved: ${callId}`)
            const event: TranscriptEvent = {
              kind: 'messages',
              id: createUniqueId(),
              parentId: activeId,
              sessionId: this.sessionId,
              timestamp: this.now(),
              messages: [
                {
                  role: 'tool',
                  toolCallId: callId,
                  content: result.content,
                  ...(result.contentBlocks?.length
                    ? { contentBlocks: result.contentBlocks }
                    : {}),
                  ...(result.images?.length ? { images: result.images } : {}),
                  ...(result.documents?.length
                    ? { documents: result.documents }
                    : {}),
                  isError: result.isError,
                },
                ...followUpUserMessages.map((content) => ({
                  role: 'user' as const,
                  content,
                })),
              ],
            }
            const appended = await nativeLease.append(tail, event)
            if (appended.status === 'conflict')
              throw new Error(
                `native transcript append conflict: ${appended.reason}`,
              )
            records.push({ event })
            tail = appended.tail
            activeId = event.id
          }),
        appendMessages: (input) =>
          enqueue(async () => {
            if (input.messages.length === 0)
              throw new Error('native transcript cannot append empty messages')
            const event: TranscriptEvent = {
              kind: 'messages',
              id: createUniqueId(),
              parentId: activeId,
              sessionId: this.sessionId,
              timestamp: this.now(),
              messages: [...input.messages],
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.terminalReason === undefined
                ? {}
                : { terminalReason: input.terminalReason }),
            }
            const appended = await nativeLease.append(tail, event)
            if (appended.status === 'conflict')
              throw new Error(
                `native transcript append conflict: ${appended.reason}`,
              )
            records.push({ event })
            tail = appended.tail
            activeId = event.id
            return event.id
          }),
        appendCompaction: (input) =>
          enqueue(async () => {
            if (records.length === 0 || activeId === null)
              throw new Error('Cannot compact an empty native transcript')
            if (input.summary.trim().length === 0)
              throw new Error('Native compact summary must not be blank')
            for (const value of [
              input.preTokens,
              input.postTokens,
              input.durationMs,
            ]) {
              if (!Number.isFinite(value) || value < 0)
                throw new Error(
                  'Native compact accounting values must be non-negative',
                )
            }
            const events = records.map((record) => record.event)
            if (
              unresolvedActiveToolCallIds(
                projectActiveMessages(events, activeId),
              ).length > 0
            )
              throw new Error(
                'Cannot compact a native transcript with unresolved tool calls',
              )
            const boundaryId = createUniqueId()
            const summaryId = createUniqueId()
            const boundary: TranscriptEvent = {
              kind: 'context-boundary',
              id: boundaryId,
              parentId: null,
              sessionId: this.sessionId,
              timestamp: this.now(),
              logicalParentId: input.logicalParentId ?? activeId,
              trigger: input.trigger,
              preTokens: input.preTokens,
              postTokens: input.postTokens,
              durationMs: input.durationMs,
              ...(input.direction === undefined
                ? {}
                : { direction: input.direction }),
              ...(input.messagesSummarized === undefined
                ? {}
                : { messagesSummarized: input.messagesSummarized }),
              ...(input.preservePrefix === undefined
                ? {}
                : { preservePrefix: input.preservePrefix }),
            }
            const summary: TranscriptEvent = {
              kind: 'context-summary',
              id: summaryId,
              parentId: boundaryId,
              sessionId: this.sessionId,
              timestamp: this.now(),
              summary: input.summary,
            }
            const suffix = input.preservedMessages ?? []
            const replayToolCallIds = new Map<string, string>()
            for (const message of suffix) {
              if (message.role !== 'assistant') continue
              for (const call of message.toolCalls ?? [])
                replayToolCallIds.set(call.id, createUniqueId())
            }
            const replaySuffix: ModelMessage[] = suffix
              .filter(
                (message) =>
                  message.role !== 'tool' ||
                  replayToolCallIds.has(message.toolCallId),
              )
              .map((message) => {
                if (message.role === 'assistant')
                  return {
                    ...message,
                    ...(message.toolCalls === undefined
                      ? {}
                      : {
                          toolCalls: message.toolCalls.map((call) => ({
                            ...call,
                            id: replayToolCallIds.get(call.id) ?? call.id,
                          })),
                        }),
                  }
                if (message.role === 'tool')
                  return {
                    ...message,
                    toolCallId:
                      replayToolCallIds.get(message.toolCallId) ??
                      message.toolCallId,
                  }
                return { ...message }
              })
            const suffixEvent: TranscriptEvent | undefined = replaySuffix.length
              ? {
                  kind: 'messages',
                  id: createUniqueId(),
                  parentId: summaryId,
                  sessionId: this.sessionId,
                  timestamp: this.now(),
                  messages: replaySuffix,
                }
              : undefined
            const compactedEvents = [
              boundary,
              summary,
              ...(suffixEvent === undefined ? [] : [suffixEvent]),
            ]
            const appended = await nativeLease.appendMany(tail, compactedEvents)
            if (appended.status === 'conflict')
              throw new Error(
                `native transcript append conflict: ${appended.reason}`,
              )
            records.push(
              { event: boundary },
              { event: summary },
              ...(suffixEvent === undefined ? [] : [{ event: suffixEvent }]),
            )
            tail = appended.tail
            activeId = suffixEvent?.id ?? summaryId
            return { boundaryId, summaryId }
          }),
      }
      return operation(lease)
    })
    if (result.status === 'conflict')
      throw new Error(`native transcript lease conflict: ${result.reason}`)
    return result.value
  }
}
