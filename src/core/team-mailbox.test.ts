import { describe, expect, it } from 'vitest'

import {
  parseTeamMailboxMessageId,
  parseTeamMailboxMessage,
  parseTeamMailboxPayload,
} from './team-mailbox.js'

const timestamp = '2026-08-24T00:00:00.000Z'

const payloads = [
  { kind: 'text', text: 'hello', summary: 'greeting' },
  {
    kind: 'task',
    phase: 'request',
    requestId: 'r1',
    taskId: 't1',
    text: 'do it',
  },
  {
    kind: 'task',
    phase: 'response',
    requestId: 'r1',
    taskId: 't1',
    status: 'completed',
    text: 'done',
  },
  { kind: 'shutdown', phase: 'request', requestId: 'r2', reason: 'finished' },
  {
    kind: 'shutdown',
    phase: 'response',
    requestId: 'r2',
    approved: true,
    reason: 'approved',
  },
  { kind: 'plan', phase: 'request', requestId: 'r3', plan: 'step one' },
  {
    kind: 'plan',
    phase: 'response',
    requestId: 'r3',
    approved: false,
    feedback: 'revise',
  },
] as const

function message(payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    sequence: 1,
    messageId: 'message-1',
    teamId: 'team-a',
    sender: 'lead',
    recipients: ['worker'],
    payload,
    createdAt: timestamp,
    ...overrides,
  }
}

describe('Team mailbox core contract', () => {
  it('round-trips all typed payload variants and preserves request correlation', () => {
    for (const value of payloads) {
      const parsed = parseTeamMailboxPayload(value)
      expect(parsed).toEqual(value)
      const envelope = parseTeamMailboxMessage(message(parsed))
      expect(envelope.payload).toEqual(parsed)
    }
  })

  it('rejects closed-contract violations, malformed IDs, timestamps, and duplicates', () => {
    expect(() =>
      parseTeamMailboxPayload({ kind: 'unknown', text: 'x' }),
    ).toThrow()
    expect(() =>
      parseTeamMailboxPayload({
        kind: 'task',
        phase: 'response',
        requestId: 'r',
        taskId: 't',
        status: 'wat',
      }),
    ).toThrow()
    expect(() =>
      parseTeamMailboxPayload({ kind: 'text', text: 'x', extra: true }),
    ).toThrow()
    expect(() =>
      parseTeamMailboxMessage(
        message({ kind: 'text', text: 'x' }, { messageId: 'x\n' }),
      ),
    ).toThrow()
    expect(() =>
      parseTeamMailboxMessage(
        message(
          { kind: 'text', text: 'x' },
          { createdAt: '2026-01-01T00:00:00Z' },
        ),
      ),
    ).toThrow()
    expect(() =>
      parseTeamMailboxMessage(
        message(
          { kind: 'text', text: 'x' },
          { recipients: ['worker', 'worker'] },
        ),
      ),
    ).toThrow()
    expect(() =>
      parseTeamMailboxMessage(
        message({ kind: 'text', text: 'x' }, { messageId: 'x'.repeat(301) }),
      ),
    ).toThrow()
  })

  it('deep-freezes envelopes and enforces UTF-8 payload and envelope bounds', () => {
    const parsed = parseTeamMailboxMessage(
      message({ kind: 'text', text: 'hello' }),
    )
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.payload)).toBe(true)
    expect(Object.isFrozen(parsed.recipients)).toBe(true)
    expect(() =>
      parseTeamMailboxPayload({ kind: 'text', text: '🙂'.repeat(5000) }),
    ).toThrow()
    expect(() =>
      parseTeamMailboxMessage(
        message(
          { kind: 'text', text: 'x' },
          { recipients: ['x'.repeat(70_000)] },
        ),
      ),
    ).toThrow()
  })

  it('validates focused mailbox message IDs', () => {
    expect(parseTeamMailboxMessageId('message-1')).toBe('message-1')
    expect(() => parseTeamMailboxMessageId('')).toThrow()
    expect(() => parseTeamMailboxMessageId(' message-1')).toThrow()
    expect(() =>
      parseTeamMailboxMessageId(`message-${'x'.repeat(300)}`),
    ).toThrow()
    expect(() => parseTeamMailboxMessageId('message\n1')).toThrow()
  })
})
