import {
  createOwnedManagedWorktree,
  type ManagedWorktreeHookOutcome,
  type ManagedWorktreeHooks,
  type ManagedWorktreeHookInput,
  type ManagedWorktreeRemoveHookInput,
  type ManagedWorktree,
} from './managed-worktree.js'
import type {
  ClaudeHookInput,
  ClaudeHookRunner,
} from '../hooks/claude-hooks.js'

export type WorkflowWorktree = ManagedWorktree

export interface WorkflowWorktreeHookContext {
  runner: ClaudeHookRunner
  sessionId: string
  transcriptPath: string
  permissionMode: string
  signal?: AbortSignal
}

function lifecycleHookInput(
  input: ManagedWorktreeHookInput | ManagedWorktreeRemoveHookInput,
  context: WorkflowWorktreeHookContext,
  event: 'WorktreeCreate' | 'WorktreeRemove',
): ClaudeHookInput {
  const reason = 'reason' in input ? input.reason : undefined
  return {
    session_id: context.sessionId,
    transcript_path: context.transcriptPath,
    cwd: input.worktreePath,
    permission_mode: context.permissionMode,
    hook_event_name: event,
    worktree_path: input.worktreePath,
    worktree_kind: input.worktreeKind,
    worktree_id: input.worktreeId,
    owner_id: input.ownerId,
    base_commit: input.baseCommit,
    ...(event === 'WorktreeRemove' && reason !== undefined ? { reason } : {}),
  }
}

function lifecycleHooks(
  context: WorkflowWorktreeHookContext,
): ManagedWorktreeHooks {
  return {
    afterCreate: async (input): Promise<ManagedWorktreeHookOutcome> =>
      context.runner.run(
        lifecycleHookInput(input, context, 'WorktreeCreate'),
        input.worktreeKind,
        context.signal,
      ),
    beforeRemove: async (input): Promise<ManagedWorktreeHookOutcome> =>
      context.runner.run(
        lifecycleHookInput(input, context, 'WorktreeRemove'),
        input.worktreeKind,
        context.signal,
      ),
  }
}

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
      ? { hooks: lifecycleHooks(options.hookContext) }
      : {}),
  })
}
