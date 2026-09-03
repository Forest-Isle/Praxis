import {
  createOwnedManagedWorktree,
  type ManagedWorktree,
} from './managed-worktree.js'
import {
  createManagedWorktreeHooks,
  type ManagedWorktreeHookContext,
} from './managed-worktree-hooks.js'

export type WorkflowWorktree = ManagedWorktree

export type WorkflowWorktreeHookContext = ManagedWorktreeHookContext

export async function createWorkflowWorktree(options: {
  cwd: string
  praxisRoot: string
  runId: string
  agentId: string
  hookContext?: WorkflowWorktreeHookContext
}): Promise<WorkflowWorktree> {
  return createOwnedManagedWorktree({
    cwd: options.cwd,
    stateRoot: options.praxisRoot,
    directoryName: `${options.runId}-${options.agentId}`,
    ownerId: `workflow:${options.runId}:${options.agentId}`,
    label: 'Workflow',
    kind: 'workflow',
    policy: 'ephemeral',
    ...(options.hookContext
      ? { hooks: createManagedWorktreeHooks(options.hookContext) }
      : {}),
  })
}
