import type {
  ClaudeHookInput,
  ClaudeHookRunner,
} from '../hooks/claude-hooks.js'
import type {
  ManagedWorktreeHookInput,
  ManagedWorktreeHookOutcome,
  ManagedWorktreeHooks,
  ManagedWorktreeRemoveHookInput,
} from './managed-worktree.js'

export interface ManagedWorktreeHookContext {
  runner: ClaudeHookRunner
  sessionId: string
  transcriptPath: string
  permissionMode: string
  signal?: AbortSignal
}

function lifecycleHookInput(
  input: ManagedWorktreeHookInput | ManagedWorktreeRemoveHookInput,
  context: ManagedWorktreeHookContext,
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

export function createManagedWorktreeHooks(
  context: ManagedWorktreeHookContext,
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
