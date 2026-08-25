import { describe, expect, it, vi } from 'vitest'
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

  it('routes delete and send through lead operations and encodes results', async () => {
    const operations = {
      create: vi.fn(),
      stop: vi.fn(async ({ teamId }: { teamId: string }) => ({ teamId })),
      send: vi.fn(async ({ teamId }: { teamId: string }) => ({
        teamId,
        recipients: ['worker'],
      })),
    }
    await expect(
      adapter.executeDelete(
        { team_name: 'team_1' },
        operations as never,
        'lead-session',
      ),
    ).resolves.toEqual({
      team_name: 'team_1',
      success: true,
      message: 'Team team_1 deleted',
    })
    await expect(
      adapter.executeSend(
        { team_name: 'team_1', to: 'worker', message: 'hello' },
        operations as never,
        'lead-session',
        'operation-1',
      ),
    ).resolves.toEqual({
      team_name: 'team_1',
      success: true,
      message: 'Message sent',
      routing: { recipients: ['worker'] },
    })
    expect(operations.stop).toHaveBeenCalledWith(
      { teamId: 'team_1' },
      'lead-session',
    )
    expect(operations.send).toHaveBeenCalledWith(
      {
        teamId: 'team_1',
        to: 'worker',
        payload: { kind: 'text', text: 'hello' },
      },
      'lead-session',
      'operation-1',
    )
  })

  it('creates Claude’s lead-only team without inventing roster or tasks', async () => {
    const operations = {
      create: vi.fn(async ({ teamId }: { teamId: string }) => ({ teamId })),
      stop: vi.fn(),
      send: vi.fn(),
    }
    await expect(
      adapter.executeCreate(
        { team_name: 'team_1', description: 'Ship' },
        operations,
        'lead-session',
      ),
    ).resolves.toEqual({
      team_name: 'team_1',
      success: true,
      message: 'Team team_1 created',
      lead_agent_id: 'team-lead@team_1',
    })
    expect(operations.create).toHaveBeenCalledWith(
      { teamId: 'team_1', name: 'team_1', roster: [], tasks: [] },
      'lead-session',
    )
  })
})
