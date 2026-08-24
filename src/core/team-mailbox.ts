import { parseTeamId } from './team-ownership.js'

export type TeamMailboxPayload =
  | { readonly kind: 'text'; readonly text: string; readonly summary?: string }
  | {
      readonly kind: 'task'
      readonly phase: 'request'
      readonly requestId: string
      readonly taskId: string
      readonly text: string
    }
  | {
      readonly kind: 'task'
      readonly phase: 'response'
      readonly requestId: string
      readonly taskId: string
      readonly status: 'accepted' | 'rejected' | 'completed' | 'failed'
      readonly text?: string
    }
  | {
      readonly kind: 'shutdown'
      readonly phase: 'request'
      readonly requestId: string
      readonly reason?: string
    }
  | {
      readonly kind: 'shutdown'
      readonly phase: 'response'
      readonly requestId: string
      readonly approved: boolean
      readonly reason?: string
    }
  | {
      readonly kind: 'plan'
      readonly phase: 'request'
      readonly requestId: string
      readonly plan: string
    }
  | {
      readonly kind: 'plan'
      readonly phase: 'response'
      readonly requestId: string
      readonly approved: boolean
      readonly feedback?: string
    }

export interface TeamMailboxMessage {
  readonly version: 1
  readonly sequence: number
  readonly messageId: string
  readonly teamId: string
  readonly sender: string
  readonly recipients: readonly string[]
  readonly payload: TeamMailboxPayload
  readonly createdAt: string
}

const MAX_ID_LENGTH = 300
const MAX_PAYLOAD_BYTES = 16 * 1024
const MAX_MESSAGE_BYTES = 64 * 1024
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown Team mailbox field: ${key}`)
}

function id(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    value.length > MAX_ID_LENGTH ||
    value.includes('\r') ||
    value.includes('\n')
  )
    throw new Error(`Invalid ${label}`)
  return value
}

export function parseTeamMailboxMessageId(value: unknown): string {
  return id(value, 'message ID')
}

function participantName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`Invalid ${label}`)
  return value
}

function body(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error(`Invalid ${label}`)
  return value
}

function optionalBody(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  return body(value, label)
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !ISO_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('Invalid Team mailbox timestamp')
  return value
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      freeze(child)
    Object.freeze(value)
  }
  return value
}

function assertSerializedBytes(
  value: unknown,
  limit: number,
  label: string,
): void {
  const serialized = JSON.stringify(value)
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > limit)
    throw new Error(`${label} exceeds ${limit} UTF-8 bytes`)
}

export function parseTeamMailboxPayload(value: unknown): TeamMailboxPayload {
  const source = object(value, 'Team mailbox payload')
  if (source.kind === 'text') {
    closed(source, ['kind', 'text', 'summary'])
    const result: TeamMailboxPayload = {
      kind: 'text' as const,
      text: body(source.text, 'text message'),
      ...(source.summary === undefined
        ? {}
        : { summary: body(source.summary, 'message summary') }),
    }
    assertSerializedBytes(result, MAX_PAYLOAD_BYTES, 'Team mailbox payload')
    return freeze(result)
  }
  if (source.kind === 'task') {
    if (source.phase === 'request') {
      closed(source, ['kind', 'phase', 'requestId', 'taskId', 'text'])
      const result: TeamMailboxPayload = {
        kind: 'task' as const,
        phase: 'request' as const,
        requestId: id(source.requestId, 'request ID'),
        taskId: id(source.taskId, 'task ID'),
        text: body(source.text, 'task request text'),
      }
      assertSerializedBytes(result, MAX_PAYLOAD_BYTES, 'Team mailbox payload')
      return freeze(result)
    }
    if (source.phase === 'response') {
      closed(source, ['kind', 'phase', 'requestId', 'taskId', 'status', 'text'])
      if (
        source.status !== 'accepted' &&
        source.status !== 'rejected' &&
        source.status !== 'completed' &&
        source.status !== 'failed'
      )
        throw new Error('Invalid task response status')
      const text = optionalBody(source.text, 'task response text')
      const result = {
        kind: 'task' as const,
        phase: 'response' as const,
        requestId: id(source.requestId, 'request ID'),
        taskId: id(source.taskId, 'task ID'),
        status: source.status as
          'accepted' | 'rejected' | 'completed' | 'failed',
        ...(text === undefined ? {} : { text }),
      }
      assertSerializedBytes(result, MAX_PAYLOAD_BYTES, 'Team mailbox payload')
      return freeze(result)
    }
  }
  if (source.kind === 'shutdown') {
    if (source.phase === 'request') {
      closed(source, ['kind', 'phase', 'requestId', 'reason'])
      const reason = optionalBody(source.reason, 'shutdown reason')
      const result = {
        kind: 'shutdown' as const,
        phase: 'request' as const,
        requestId: id(source.requestId, 'request ID'),
        ...(reason === undefined ? {} : { reason }),
      }
      assertSerializedBytes(result, MAX_PAYLOAD_BYTES, 'Team mailbox payload')
      return freeze(result)
    }
    if (source.phase === 'response') {
      closed(source, ['kind', 'phase', 'requestId', 'approved', 'reason'])
      if (typeof source.approved !== 'boolean')
        throw new Error('Invalid shutdown approval')
      const reason = optionalBody(source.reason, 'shutdown reason')
      const result = {
        kind: 'shutdown' as const,
        phase: 'response' as const,
        requestId: id(source.requestId, 'request ID'),
        approved: source.approved,
        ...(reason === undefined ? {} : { reason }),
      }
      assertSerializedBytes(result, MAX_PAYLOAD_BYTES, 'Team mailbox payload')
      return freeze(result)
    }
  }
  if (source.kind === 'plan') {
    if (source.phase === 'request') {
      closed(source, ['kind', 'phase', 'requestId', 'plan'])
      const result = {
        kind: 'plan' as const,
        phase: 'request' as const,
        requestId: id(source.requestId, 'request ID'),
        plan: body(source.plan, 'plan'),
      }
      assertSerializedBytes(result, MAX_PAYLOAD_BYTES, 'Team mailbox payload')
      return freeze(result)
    }
    if (source.phase === 'response') {
      closed(source, ['kind', 'phase', 'requestId', 'approved', 'feedback'])
      if (typeof source.approved !== 'boolean')
        throw new Error('Invalid plan approval')
      const feedback = optionalBody(source.feedback, 'plan feedback')
      const result = {
        kind: 'plan' as const,
        phase: 'response' as const,
        requestId: id(source.requestId, 'request ID'),
        approved: source.approved,
        ...(feedback === undefined ? {} : { feedback }),
      }
      assertSerializedBytes(result, MAX_PAYLOAD_BYTES, 'Team mailbox payload')
      return freeze(result)
    }
  }
  throw new Error('Invalid Team mailbox payload variant')
}

export function parseTeamMailboxMessage(value: unknown): TeamMailboxMessage {
  const source = object(value, 'Team mailbox message')
  closed(source, [
    'version',
    'sequence',
    'messageId',
    'teamId',
    'sender',
    'recipients',
    'payload',
    'createdAt',
  ])
  if (source.version !== 1) throw new Error('Invalid Team mailbox version')
  if (
    !Number.isSafeInteger(source.sequence) ||
    (source.sequence as number) <= 0
  )
    throw new Error('Invalid Team mailbox sequence')
  const messageId = id(source.messageId, 'message ID')
  const teamId = parseTeamId(source.teamId)
  const sender = participantName(source.sender, 'sender')
  if (!Array.isArray(source.recipients) || source.recipients.length === 0)
    throw new Error('Invalid Team mailbox recipients')
  const recipients = source.recipients.map((entry) =>
    participantName(entry, 'recipient'),
  )
  if (new Set(recipients).size !== recipients.length)
    throw new Error('Duplicate Team mailbox recipient')
  const payload = parseTeamMailboxPayload(source.payload)
  const createdAt = timestamp(source.createdAt)
  const result = {
    version: 1 as const,
    sequence: source.sequence as number,
    messageId,
    teamId,
    sender,
    recipients: freeze(recipients),
    payload,
    createdAt,
  }
  assertSerializedBytes(result, MAX_MESSAGE_BYTES, 'Team mailbox message')
  return freeze(result)
}
