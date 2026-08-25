import { describe, expect, it } from 'vitest'
import {
  ClaudeTeamCompatibilityAdapter,
  isClaudeTeamCompatibilityError,
} from './team.js'

const adapter = new ClaudeTeamCompatibilityAdapter()

describe('Claude Team compatibility adapter', () => {
  it('decodes strict create/delete and encodes results', () => {
    expect(
      adapter.decodeCreate({
        team_name: 'team_1',
        description: 'Ship',
        agent_type: 'worker',
      }),
    ).toEqual({
      kind: 'team.create',
      teamId: 'team_1',
      name: 'team_1',
      description: 'Ship',
      leadAgentType: 'worker',
    })
    expect(adapter.decodeDelete({})).toEqual({ kind: 'team.delete' })
    expect(adapter.encodeCreateResult({ teamId: 'team_1' })).toMatchObject({
      team_name: 'team_1',
      success: true,
    })
  })
  it('decodes text, broadcast, and structured responses losslessly', () => {
    expect(
      adapter.decodeSendMessage({ to: '*', summary: 's', message: 'hello' }),
    ).toEqual({
      kind: 'team.message',
      to: 'broadcast',
      payload: { kind: 'text', text: 'hello', summary: 's' },
    })
    expect(
      adapter.decodeSendMessage({
        to: 'worker',
        message: {
          type: 'shutdown_response',
          request_id: 'r1',
          approve: true,
          reason: 'done',
        },
      }),
    ).toMatchObject({
      to: 'worker',
      payload: {
        kind: 'shutdown',
        phase: 'response',
        requestId: 'r1',
        approved: true,
        reason: 'done',
      },
    })
    expect(
      adapter.decodeSendMessage({
        to: 'worker',
        message: {
          type: 'plan_approval_response',
          request_id: 'r2',
          approve: false,
          feedback: 'retry',
        },
      }),
    ).toMatchObject({
      payload: { kind: 'plan', approved: false, feedback: 'retry' },
    })
  })
  it('fails closed on unknown, lossy, and invalid shapes', () => {
    for (const input of [
      { team_name: 'bad name' },
      { team_name: 'x', extra: true },
      { to: 'x', message: { type: 'shutdown_request' } },
      { to: 'x', message: { type: 'unknown', request_id: 'r' } },
    ]) {
      try {
        adapter.decodeCreate(input)
      } catch (error) {
        expect(isClaudeTeamCompatibilityError(error)).toBe(true)
      }
    }
    expect(() =>
      adapter.decodeSendMessage({
        to: 'x',
        message: { type: 'shutdown_request' },
      }),
    ).toThrow()
    expect(() => adapter.decodeDelete({ extra: 1 })).toThrow()
  })
})
