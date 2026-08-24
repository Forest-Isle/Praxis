import { Buffer } from 'node:buffer'

import type { TeamMailboxMessage } from '../core/team-mailbox.js'
import type { TeamSnapshot } from '../core/team-ownership.js'
import type { LocalTeam, LocalTeamManager } from './team-manager.js'
import type { LocalTeamCapability } from './team-capability.js'
import type {
  DurableTeamMailboxBatch,
  TeamMailboxProjectBounds,
  TeamMailboxSendInput,
} from './team-mailbox.js'
import { teamMailboxMessageId } from './team-mailbox.js'

export type TeamCreateRequest = Omit<
  Parameters<LocalTeamManager['create']>[0],
  'leadSessionId'
>

export interface TeamLeadSendInput extends Omit<
  TeamMailboxSendInput,
  'messageId'
> {
  readonly teamId: string
}

interface OwnedTeam {
  readonly leadSessionId: string
  readonly team: LocalTeam
  readonly leadPolicy: 'hybrid' | 'coordinator'
}

export class TeamLeadOperations {
  private readonly owned = new Map<string, OwnedTeam>()
  private closed = false

  constructor(private readonly capability: Pick<LocalTeamCapability, 'open'>) {}

  async create(
    input: TeamCreateRequest,
    leadSessionId: string,
  ): Promise<TeamSnapshot> {
    const manager = await this.manager()
    if (this.owned.has(input.teamId))
      throw new Error(`Team ${input.teamId} is already active`)
    const team = await manager.create({ ...input, leadSessionId })
    const snapshot = await team.snapshot()
    this.owned.set(input.teamId, {
      leadSessionId,
      team,
      leadPolicy: snapshot.policy?.lead ?? 'hybrid',
    })
    return snapshot
  }

  async resume(teamId: string, leadSessionId: string): Promise<TeamSnapshot> {
    const current = this.owned.get(teamId)
    if (current) {
      if (current.leadSessionId !== leadSessionId)
        throw new Error(`Team ${teamId} is active under another lead session`)
      return current.team.snapshot()
    }
    const team = await (await this.manager()).resume({ teamId, leadSessionId })
    const snapshot = await team.snapshot()
    this.owned.set(teamId, {
      leadSessionId,
      team,
      leadPolicy: snapshot.policy?.lead ?? 'hybrid',
    })
    return snapshot
  }

  activeLeadPolicy(leadSessionId: string): 'hybrid' | 'coordinator' {
    for (const owned of this.owned.values())
      if (
        owned.leadSessionId === leadSessionId &&
        owned.leadPolicy === 'coordinator'
      )
        return 'coordinator'
    return 'hybrid'
  }

  async list(): Promise<readonly TeamSnapshot[]> {
    return (await this.manager()).list()
  }

  async accept(
    input: {
      teamId: string
      taskId: string
      generation?: number
      decision?: 'accepted' | 'rejected'
    },
    leadSessionId: string,
  ): Promise<TeamSnapshot> {
    return this.forLead(input.teamId, leadSessionId, (team) =>
      team.accept(input.taskId, input.generation, input.decision),
    )
  }

  async send(
    input: TeamLeadSendInput,
    leadSessionId: string,
    operationId: string,
  ): Promise<TeamMailboxMessage> {
    const owned = this.require(input.teamId, leadSessionId)
    return owned.team.mailboxEndpoint('lead').send({
      messageId: teamMailboxMessageId(input.teamId, 'lead', operationId),
      to: input.to,
      payload: input.payload,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    })
  }

  async projectInbox(
    leadSessionId: string,
    bounds: TeamMailboxProjectBounds = {},
  ): Promise<DurableTeamMailboxBatch | null> {
    const maxBytes = bounds.maxBytes ?? 64 * 1024
    const maxMessages = bounds.maxMessages ?? 32
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new Error('Invalid Team inbox maxBytes')
    if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0)
      throw new Error('Invalid Team inbox maxMessages')
    const batches: DurableTeamMailboxBatch[] = []
    let bytes = 0
    let messageCount = 0
    for (const owned of [...this.owned.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, value]) => value)) {
      if (owned.leadSessionId !== leadSessionId) continue
      const remainingMessages = maxMessages - messageCount
      if (remainingMessages <= 0) break
      const batch = await owned.team.mailboxEndpoint('lead').project({
        maxBytes: maxBytes - bytes,
        maxMessages: remainingMessages,
      })
      if (!batch) continue
      batches.push(batch)
      bytes += batch.messages.reduce(
        (total, message) => total + Buffer.byteLength(message, 'utf8'),
        0,
      )
      messageCount += batch.messages.length
      if (bytes >= maxBytes || messageCount >= maxMessages) break
    }
    if (batches.length === 0) return null
    let acknowledged = false
    return {
      id: `lead:${leadSessionId}:${batches.map((batch) => batch.id).join('|')}`,
      messages: Object.freeze(batches.flatMap((batch) => batch.messages)),
      acknowledge: async () => {
        if (acknowledged) return
        for (const batch of batches) await batch.acknowledge()
        acknowledged = true
      },
    }
  }

  async stop(
    input: { teamId: string; drainMs?: number },
    leadSessionId: string,
  ): Promise<TeamSnapshot> {
    const owned = this.require(input.teamId, leadSessionId)
    const snapshot = await owned.team.stop(
      input.drainMs === undefined ? {} : { drainMs: input.drainMs },
    )
    this.owned.delete(input.teamId)
    return snapshot
  }

  async waitForIdle(
    teamId: string,
    leadSessionId: string,
  ): Promise<TeamSnapshot> {
    return this.forLead(teamId, leadSessionId, (team) => team.waitForIdle())
  }

  async detach(teamId: string, leadSessionId: string): Promise<TeamSnapshot> {
    const owned = this.require(teamId, leadSessionId)
    const snapshot = await owned.team.detach()
    this.owned.delete(teamId)
    return snapshot
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const failures: unknown[] = []
    for (const [teamId, owned] of this.owned) {
      try {
        await owned.team.stop()
        this.owned.delete(teamId)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Failed to stop Teams')
  }

  private async manager(): Promise<LocalTeamManager> {
    if (this.closed) throw new Error('Team lead operations are closed')
    return this.capability.open()
  }

  private require(teamId: string, leadSessionId: string): OwnedTeam {
    const owned = this.owned.get(teamId)
    if (!owned) throw new Error(`Team ${teamId} is not active; resume it first`)
    if (owned.leadSessionId !== leadSessionId)
      throw new Error(`Team ${teamId} is active under another lead session`)
    return owned
  }

  private async forLead<T>(
    teamId: string,
    leadSessionId: string,
    operation: (team: LocalTeam) => Promise<T>,
  ): Promise<T> {
    return operation(this.require(teamId, leadSessionId).team)
  }
}
