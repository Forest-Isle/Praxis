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
  stopBackgroundTask(taskId: string): string
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
    for (const source of this.agentSources.get(sessionId) ?? []) {
      if (
        !source.backgroundSnapshots().some(({ agentId }) => agentId === taskId)
      ) {
        continue
      }
      source.stopBackgroundTask(taskId)
      return
    }
    if (this.workflows?.hasForSession(sessionId, taskId)) {
      await this.workflows.stopAndWait(taskId)
      return
    }
    throw new Error(`No task found with ID: ${taskId}`)
  }

  clear(): void {
    this.bashSources.clear()
    this.agentSources.clear()
  }
}
