import type { BackgroundAgentSnapshot } from './background-agent-manager.js'
import type {
  BackgroundBashSnapshot,
  BackgroundBashToolResult,
} from './background-bash-manager.js'
import type { WorkflowTaskSnapshot } from './workflow-manager.js'

export interface BackgroundTaskSnapshot {
  shells: readonly BackgroundBashSnapshot[]
  agents: readonly BackgroundAgentSnapshot[]
  workflows: readonly WorkflowTaskSnapshot[]
}

export interface BackgroundBashTaskSource {
  backgroundSnapshots(): Promise<readonly BackgroundBashSnapshot[]>
  stopBackgroundTask(taskId: string): Promise<BackgroundBashToolResult>
}

export interface BackgroundAgentTaskSource {
  backgroundSnapshots(): readonly BackgroundAgentSnapshot[]
  outputBackgroundTask(
    taskId: string,
    options: { block: boolean; timeout: number },
  ): Promise<string>
  stopBackgroundTask(taskId: string): Promise<string>
  sendBackgroundMessage(
    agentId: string,
    message: string,
    summary: string | undefined,
    toolUseId: string,
  ): string
  hasForegroundTask(): boolean
  backgroundForegroundTask(): BackgroundAgentSnapshot
}

export interface WorkflowTaskSource {
  list(sessionId?: string): readonly WorkflowTaskSnapshot[]
  hasForSession(sessionId: string, taskId: string): boolean
  stopAndWait(taskId: string): Promise<void>
}

function uniqueById<T>(values: readonly T[], id: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [id(value), value])).values()]
}

function addSource<T>(
  sources: Map<string, Set<T>>,
  sessionId: string,
  value: T,
) {
  const existing = sources.get(sessionId)
  if (existing) existing.add(value)
  else sources.set(sessionId, new Set([value]))
}

/** Aggregates the actual task owners created across turns of one CLI session. */
export class BackgroundTaskRuntime {
  private readonly bashSources = new Map<
    string,
    Set<BackgroundBashTaskSource>
  >()
  private readonly agentSources = new Map<
    string,
    Set<BackgroundAgentTaskSource>
  >()

  constructor(private readonly workflows: WorkflowTaskSource | null) {}

  registerBash(sessionId: string, source: BackgroundBashTaskSource): void {
    addSource(this.bashSources, sessionId, source)
  }

  registerAgents(sessionId: string, source: BackgroundAgentTaskSource): void {
    addSource(this.agentSources, sessionId, source)
  }

  async snapshot(sessionId: string): Promise<BackgroundTaskSnapshot> {
    const shellGroups = await Promise.all(
      [...(this.bashSources.get(sessionId) ?? [])].map((source) =>
        source.backgroundSnapshots(),
      ),
    )
    return {
      shells: uniqueById(shellGroups.flat(), ({ taskId }) => taskId),
      agents: uniqueById(
        [...(this.agentSources.get(sessionId) ?? [])].flatMap((source) =>
          source.backgroundSnapshots(),
        ),
        ({ agentId }) => agentId,
      ),
      workflows: uniqueById(
        this.workflows?.list(sessionId) ?? [],
        ({ task_id: taskId }) => taskId,
      ),
    }
  }

  async stop(sessionId: string, taskId: string): Promise<void> {
    for (const source of this.bashSources.get(sessionId) ?? []) {
      if (
        !(await source.backgroundSnapshots()).some(
          ({ taskId: id }) => id === taskId,
        )
      ) {
        continue
      }
      await source.stopBackgroundTask(taskId)
      return
    }
    if ((await this.stopAgent(sessionId, taskId)) !== null) return
    if (this.workflows?.hasForSession(sessionId, taskId)) {
      await this.workflows.stopAndWait(taskId)
      return
    }
    throw new Error(`No task found with ID: ${taskId}`)
  }

  async outputAgent(
    sessionId: string,
    agentId: string,
    options: { block: boolean; timeout: number },
  ): Promise<string | null> {
    const source = this.agentSource(sessionId, agentId)
    return source ? source.outputBackgroundTask(agentId, options) : null
  }

  async stopAgent(sessionId: string, agentId: string): Promise<string | null> {
    const source = this.agentSource(sessionId, agentId)
    return source ? source.stopBackgroundTask(agentId) : null
  }

  sendAgent(
    sessionId: string,
    agentId: string,
    message: string,
    summary: string | undefined,
    toolUseId: string,
  ): string | null {
    return (
      this.sendAgentWithOwner(sessionId, agentId, message, summary, toolUseId)
        ?.content ?? null
    )
  }

  sendAgentWithOwner(
    sessionId: string,
    agentId: string,
    message: string,
    summary: string | undefined,
    toolUseId: string,
  ): { content: string; owner: BackgroundAgentTaskSource } | null {
    const source = this.agentSource(sessionId, agentId)
    return source
      ? {
          content: source.sendBackgroundMessage(
            agentId,
            message,
            summary,
            toolUseId,
          ),
          owner: source,
        }
      : null
  }

  backgroundForeground(sessionId: string): BackgroundAgentSnapshot {
    const sources = [...(this.agentSources.get(sessionId) ?? [])].reverse()
    const source = sources.find((candidate) => candidate.hasForegroundTask())
    if (!source) throw new Error('No foreground agent is running')
    return source.backgroundForegroundTask()
  }

  clear(): void {
    this.bashSources.clear()
    this.agentSources.clear()
  }

  private agentSource(
    sessionId: string,
    identifier: string,
  ): BackgroundAgentTaskSource | null {
    const sources = [...(this.agentSources.get(sessionId) ?? [])]
    const idMatches = sources.filter((source) =>
      source
        .backgroundSnapshots()
        .some(({ agentId }) => agentId === identifier),
    )
    if (idMatches.length > 1) {
      throw new Error(
        `Multiple background agent owners claim ID: ${identifier}`,
      )
    }
    if (idMatches[0]) return idMatches[0]

    const nameMatches = sources.filter((source) =>
      source.backgroundSnapshots().some(({ name }) => name === identifier),
    )
    if (nameMatches.length > 1) {
      throw new Error(
        `Multiple live background agents are named '${identifier}'`,
      )
    }
    return nameMatches[0] ?? null
  }
}
