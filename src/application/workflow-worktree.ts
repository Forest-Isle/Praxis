import {
  createOwnedManagedWorktree,
  type ManagedWorktree,
} from './managed-worktree.js'

export type WorkflowWorktree = ManagedWorktree

export async function createWorkflowWorktree(options: {
  cwd: string
  praxisRoot: string
  runId: string
  agentId: string
}): Promise<WorkflowWorktree> {
  return createOwnedManagedWorktree({
    cwd: options.cwd,
    stateRoot: options.praxisRoot,
    directoryName: `${options.runId}-${options.agentId}`,
    ownerId: `workflow:${options.runId}:${options.agentId}`,
    label: 'Workflow',
    kind: 'workflow',
    policy: 'ephemeral',
  })
}
