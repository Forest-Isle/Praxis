import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'

import {
  parseTeamMailboxPayload,
  type TeamMailboxMessage,
  type TeamMailboxPayload,
} from '../core/team-mailbox.js'
import { parseTeamId } from '../core/team-ownership.js'
import {
  NativeTeamMailbox,
  type NativeTeamMailboxReadProof,
  type NativeTeamMailboxRetention,
} from '../persistence/native-team-mailbox.js'

export interface TeamMailboxWakeMetadata {
  readonly teamId: string
  readonly messageId: string
  readonly sequence: number
  readonly recipients: readonly string[]
}

export interface DurableTeamMailboxBatch {
  readonly id: string
  readonly messages: readonly string[]
  acknowledge(): Promise<void>
}

export interface TeamMailboxSendInput {
  readonly messageId: string
  readonly to: string | readonly string[] | 'broadcast'
  readonly payload: TeamMailboxPayload
  readonly createdAt?: string
}

export interface TeamMailboxProjectBounds {
  readonly maxBytes?: number
  readonly maxMessages?: number
}

export interface TeamMailboxOptions {
  readonly nativeRoot?: string
  readonly projectIdentity?: string
  readonly teamId: string
  readonly participants: readonly string[]
  readonly store?: NativeTeamMailbox
  readonly retention?: NativeTeamMailboxRetention
  readonly wake?: (metadata: TeamMailboxWakeMetadata) => void | Promise<void>
  readonly warn?: (message: string) => void
}

const DEFAULT_MAX_BYTES = 64 * 1024
const DEFAULT_MAX_MESSAGES = 32

function participant(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new Error('Invalid Team mailbox participant')
  return value
}

function operationIdentity(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value !== value.trim() ||
    value.length > 300 ||
    value.includes('\r') ||
    value.includes('\n')
  )
    throw new Error('Invalid Team mailbox operation ID')
  return value
}

export function teamMailboxMessageId(
  teamId: string,
  sender: string,
  operationId: string,
): string {
  const values = [
    parseTeamId(teamId),
    participant(sender),
    operationIdentity(operationId),
  ]
  const hash = createHash('sha256')
  for (const value of values) {
    const bytes = Buffer.from(value, 'utf8')
    hash.update(Buffer.from(String(bytes.length) + ':', 'ascii'))
    hash.update(bytes)
  }
  return hash.digest('hex')
}

function render(message: TeamMailboxMessage): string {
  return `<team-mailbox-message>\n${JSON.stringify(message)}\n</team-mailbox-message>`
}

function assertBound(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`Invalid ${label}`)
  return value as number
}

export class TeamMailboxService {
  readonly store: NativeTeamMailbox
  private readonly participants: readonly string[]
  private readonly participantSet: ReadonlySet<string>

  constructor(private readonly options: TeamMailboxOptions) {
    if (
      !Array.isArray(options.participants) ||
      options.participants.length === 0
    )
      throw new Error('Invalid Team mailbox participants')
    this.participants = Object.freeze(options.participants.map(participant))
    if (
      new Set(this.participants).size !== this.participants.length ||
      !this.participants.includes('lead')
    )
      throw new Error('Invalid Team mailbox roster')
    this.participantSet = new Set(this.participants)
    if (options.store) {
      this.store = options.store
    } else {
      if (!options.nativeRoot || !options.projectIdentity)
        throw new Error(
          'Native Team mailbox root and project identity are required',
        )
      this.store = NativeTeamMailbox.open({
        nativeRoot: options.nativeRoot,
        projectIdentity: options.projectIdentity,
        teamId: options.teamId,
        participants: this.participants,
        ...(options.retention ? { retention: options.retention } : {}),
      })
    }
  }

  endpoint(sender: string): TeamMailboxEndpoint {
    this.assertParticipant(sender)
    return new TeamMailboxEndpoint(this, sender)
  }

  async send(
    input: TeamMailboxSendInput,
    sender: string,
  ): Promise<TeamMailboxMessage> {
    this.assertParticipant(sender)
    const recipients = this.recipients(input.to, sender)
    const result = await this.store.append({
      messageId: input.messageId,
      sender,
      recipients,
      payload: parseTeamMailboxPayload(input.payload),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
    if (this.options.wake) {
      try {
        await this.options.wake({
          teamId: result.message.teamId,
          messageId: result.message.messageId,
          sequence: result.message.sequence,
          recipients: result.message.recipients,
        })
      } catch (error) {
        try {
          this.options.warn?.(
            `Team mailbox wake failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        } catch {
          // Advisory reporting must not change a durably persisted send result.
        }
      }
    }
    return result.message
  }

  async project(
    sender: string,
    bounds: TeamMailboxProjectBounds = {},
  ): Promise<DurableTeamMailboxBatch | null> {
    this.assertParticipant(sender)
    const maxBytes =
      bounds.maxBytes === undefined
        ? DEFAULT_MAX_BYTES
        : assertBound(bounds.maxBytes, 'mailbox projection maxBytes')
    const maxMessages =
      bounds.maxMessages === undefined
        ? DEFAULT_MAX_MESSAGES
        : assertBound(bounds.maxMessages, 'mailbox projection maxMessages')
    const read = await this.store.read(sender, { maxMessages })
    if (read.messages.length === 0) return null
    const messages: string[] = []
    let bytes = 0
    for (const message of read.messages) {
      const text = render(message)
      const size = Buffer.byteLength(text, 'utf8')
      if (messages.length === 0 && size > maxBytes)
        throw new Error('First Team mailbox message exceeds projection budget')
      if (messages.length >= maxMessages || bytes + size > maxBytes) break
      messages.push(text)
      bytes += size
    }
    if (messages.length === 0) return null
    const selected = read.messages.slice(0, messages.length)
    const last = selected[selected.length - 1]
    if (!last) throw new Error('Team mailbox projection selected no messages')
    const proof: NativeTeamMailboxReadProof = {
      participant: sender,
      expectedCursor: read.expectedCursor,
      throughSequence: last.sequence,
      messageIds: selected.map((message) => message.messageId),
    }
    const id = `${this.options.teamId}:${sender}:${proof.expectedCursor}-${proof.throughSequence}`
    let acknowledged = false
    return {
      id,
      messages: Object.freeze(messages),
      acknowledge: async () => {
        if (acknowledged) return
        await this.store.acknowledge(proof)
        acknowledged = true
      },
    }
  }

  private recipients(
    to: TeamMailboxSendInput['to'],
    sender: string,
  ): readonly string[] {
    if (to === 'broadcast') {
      return Object.freeze(
        [...this.participants].filter((name) => name !== sender).sort(),
      )
    }
    const values = typeof to === 'string' ? [to] : [...to]
    if (values.length === 0)
      throw new Error('Team mailbox delivery requires a recipient')
    const result: string[] = []
    for (const value of values) {
      this.assertParticipant(value)
      if (value === sender)
        throw new Error('Team mailbox sender cannot address itself')
      if (!result.includes(value)) result.push(value)
    }
    if (result.length === 0)
      throw new Error('Team mailbox delivery requires a recipient')
    return Object.freeze(result)
  }

  private assertParticipant(value: string): void {
    const name = participant(value)
    if (!this.participantSet.has(name))
      throw new Error(`Unknown Team mailbox participant: ${name}`)
  }
}

export class TeamMailboxEndpoint {
  constructor(
    private readonly service: TeamMailboxService,
    readonly participant: string,
  ) {}

  send(input: TeamMailboxSendInput): Promise<TeamMailboxMessage> {
    return this.service.send(input, this.participant)
  }

  project(
    bounds?: TeamMailboxProjectBounds,
  ): Promise<DurableTeamMailboxBatch | null> {
    return this.service.project(this.participant, bounds)
  }
}
