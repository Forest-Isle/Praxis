import { describe, expect, it, vi } from 'vitest'
import {
  TeamLeadOperations,
  type TeamCreateRequest,
} from './team-lead-operations.js'
import type { TeamMailboxEndpoint } from './team-mailbox.js'
import type { DurableTeamMailboxBatch } from './team-mailbox.js'

const snapshot = (teamId: string) => ({ teamId }) as never
const input: TeamCreateRequest = {
  teamId: 'team-a',
  name: 'A',
  roster: [],
  tasks: [],
}

function fixture() {
  const endpointMock = {
    participant: 'lead',
    send: vi.fn(async () => ({ teamId: 'team-a' }) as never),
    project: vi.fn<() => Promise<DurableTeamMailboxBatch | null>>(
      async () => null,
    ),
  }
  const endpoint = endpointMock as unknown as TeamMailboxEndpoint
  const team = {
    snapshot: vi.fn(async () => snapshot('team-a')),
    waitForIdle: vi.fn(async () => snapshot('team-a')),
    accept: vi.fn(async () => snapshot('team-a')),
    stop: vi.fn(async () => snapshot('team-a')),
    detach: vi.fn(async () => snapshot('team-a')),
    mailboxEndpoint: vi.fn(() => endpoint),
  }
  const manager = {
    create: vi.fn(async () => team),
    resume: vi.fn(async () => team),
    list: vi.fn(async () => [snapshot('team-a')]),
  }
  const capability = { open: vi.fn(async () => manager) }
  return {
    team,
    endpoint: endpointMock,
    manager,
    capability,
    operations: new TeamLeadOperations(capability as never),
  }
}

describe('TeamLeadOperations', () => {
  it('routes owned Lead sends and aggregates inboxes in stable order', async () => {
    const f = fixture()
    const second = fixture()
    const firstBatch = {
      id: 'a',
      messages: ['a'],
      acknowledge: vi.fn(async () => undefined),
    }
    const secondBatch = {
      id: 'b',
      messages: ['b'],
      acknowledge: vi.fn(async () => undefined),
    }
    f.endpoint.project.mockResolvedValue(firstBatch)
    second.endpoint.project.mockResolvedValue(secondBatch)
    f.manager.create.mockResolvedValueOnce(f.team)
    f.manager.create.mockResolvedValueOnce(second.team)
    await f.operations.create(input, 'lead-a')
    await f.operations.create({ ...input, teamId: 'team-b' }, 'lead-a')
    await f.operations.send(
      {
        teamId: 'team-a',
        to: 'worker',
        payload: { kind: 'text', text: 'hello' },
      },
      'lead-a',
      'call-1',
    )
    expect(f.endpoint.send).toHaveBeenCalledOnce()
    const inbox = await f.operations.projectInbox('lead-a', {
      maxMessages: 2,
      maxBytes: 100,
    })
    expect(inbox?.messages).toEqual(['a', 'b'])
    await inbox?.acknowledge()
    expect(firstBatch.acknowledge).toHaveBeenCalledOnce()
    expect(secondBatch.acknowledge).toHaveBeenCalledOnce()
  })

  it('owns handles, enforces lead identity, and removes stopped teams', async () => {
    const f = fixture()
    await f.operations.create(input, 'lead-a')
    await expect(f.operations.resume('team-a', 'lead-a')).resolves.toEqual(
      snapshot('team-a'),
    )
    await expect(f.operations.resume('team-a', 'lead-b')).rejects.toThrow(
      'another lead',
    )
    await expect(
      f.operations.accept({ teamId: 'team-a', taskId: 't' }, 'lead-b'),
    ).rejects.toThrow('another lead')
    await f.operations.stop({ teamId: 'team-a' }, 'lead-a')
    await expect(f.operations.waitForIdle('team-a', 'lead-a')).rejects.toThrow(
      'resume it first',
    )
  })

  it('tracks durable coordinator policy across owned Teams', async () => {
    const f = fixture()
    const second = fixture()
    f.team.snapshot.mockResolvedValue({
      teamId: 'team-a',
      policy: { lead: 'coordinator' },
    } as never)
    second.team.snapshot.mockResolvedValue({
      teamId: 'team-b',
      policy: { lead: 'coordinator' },
    } as never)
    f.manager.create
      .mockResolvedValueOnce(f.team)
      .mockResolvedValueOnce(second.team)
    await f.operations.create(input, 'lead-a')
    await f.operations.create({ ...input, teamId: 'team-b' }, 'lead-a')
    expect(f.operations.activeLeadPolicy('lead-a')).toBe('coordinator')
    await f.operations.stop({ teamId: 'team-a' }, 'lead-a')
    expect(f.operations.activeLeadPolicy('lead-a')).toBe('coordinator')
    await f.operations.stop({ teamId: 'team-b' }, 'lead-a')
    expect(f.operations.activeLeadPolicy('lead-a')).toBe('hybrid')
  })

  it('does not retain failed create or resume and retains a failed stop', async () => {
    const f = fixture()
    f.manager.create.mockRejectedValueOnce(new Error('create failed'))
    await expect(f.operations.create(input, 'lead-a')).rejects.toThrow(
      'create failed',
    )
    await expect(
      f.operations.accept({ teamId: 'team-a', taskId: 'task' }, 'lead-a'),
    ).rejects.toThrow('resume it first')
    f.manager.resume.mockRejectedValueOnce(new Error('resume failed'))
    await expect(f.operations.resume('team-a', 'lead-a')).rejects.toThrow(
      'resume failed',
    )
    await expect(f.operations.waitForIdle('team-a', 'lead-a')).rejects.toThrow(
      'resume it first',
    )
    await f.operations.create(input, 'lead-a')
    await expect(
      f.operations.accept(
        {
          teamId: 'team-a',
          taskId: 'task',
          generation: 2,
          decision: 'rejected',
        },
        'lead-a',
      ),
    ).resolves.toEqual(snapshot('team-a'))
    expect(f.team.accept).toHaveBeenCalledWith('task', 2, 'rejected')
    await expect(f.operations.waitForIdle('team-a', 'lead-a')).resolves.toEqual(
      snapshot('team-a'),
    )
    expect(f.team.waitForIdle).toHaveBeenCalledOnce()
    f.team.stop.mockRejectedValueOnce(new Error('stop failed'))
    await expect(
      f.operations.stop({ teamId: 'team-a' }, 'lead-a'),
    ).rejects.toThrow('stop failed')
    await expect(
      f.operations.stop({ teamId: 'team-a' }, 'lead-a'),
    ).resolves.toBeDefined()
  })

  it('attempts every owned Team during close and aggregates failures', async () => {
    const second = fixture()
    await second.operations.create(input, 'lead-a')
    const other = {
      ...second.team,
      stop: vi.fn(async () => {
        throw new Error('bad')
      }),
    }
    second.manager.create.mockResolvedValueOnce(other as never)
    await expect(
      second.operations.create({ ...input, teamId: 'team-b' }, 'lead-a'),
    ).resolves.toBeDefined()
    await expect(second.operations.close()).rejects.toBeInstanceOf(
      AggregateError,
    )
    expect(second.team.stop).toHaveBeenCalledOnce()
    expect(other.stop).toHaveBeenCalledOnce()
  })

  it('lists without claiming or requiring a live handle', async () => {
    const f = fixture()
    await expect(f.operations.list()).resolves.toEqual([snapshot('team-a')])
    expect(f.manager.list).toHaveBeenCalledOnce()
    expect(f.manager.resume).not.toHaveBeenCalled()
  })

  it('removes only successfully detached handles before close', async () => {
    const detached = fixture()
    await detached.operations.create(input, 'lead-a')
    await expect(
      detached.operations.detach('team-a', 'lead-a'),
    ).resolves.toEqual(snapshot('team-a'))
    await detached.operations.close()
    expect(detached.team.detach).toHaveBeenCalledOnce()
    expect(detached.team.stop).not.toHaveBeenCalled()

    const failed = fixture()
    await failed.operations.create(input, 'lead-a')
    failed.team.detach.mockRejectedValueOnce(new Error('detach failed'))
    await expect(failed.operations.detach('team-a', 'lead-a')).rejects.toThrow(
      'detach failed',
    )
    await failed.operations.close()
    expect(failed.team.stop).toHaveBeenCalledOnce()
  })
})
