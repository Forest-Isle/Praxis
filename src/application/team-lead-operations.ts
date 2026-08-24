import type { TeamSnapshot } from '../core/team-ownership.js'
import type { LocalTeam, LocalTeamManager } from './team-manager.js'
import type { LocalTeamCapability } from './team-capability.js'

export interface TeamCreateRequest {
  readonly teamId: string
  readonly name: string
  readonly roster: Parameters<LocalTeamManager['create']>[0]['roster']
  readonly tasks: Parameters<LocalTeamManager['create']>[0]['tasks']
}

interface OwnedTeam {
  readonly leadSessionId: string
  readonly team: LocalTeam
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
    this.owned.set(input.teamId, { leadSessionId, team })
    return team.snapshot()
  }

  async resume(teamId: string, leadSessionId: string): Promise<TeamSnapshot> {
    const current = this.owned.get(teamId)
    if (current) {
      if (current.leadSessionId !== leadSessionId)
        throw new Error(`Team ${teamId} is active under another lead session`)
      return current.team.snapshot()
    }
    const team = await (await this.manager()).resume({ teamId, leadSessionId })
    this.owned.set(teamId, { leadSessionId, team })
    return team.snapshot()
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
