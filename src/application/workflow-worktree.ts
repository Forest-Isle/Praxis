import { join } from 'node:path'

import {
  createManagedWorktree,
  type ManagedWorktree,
} from './managed-worktree.js'

export type WorkflowWorktree = ManagedWorktree

export async function createWorkflowWorktree(options: {
  cwd: string
  praxisRoot: string
  runId: string
  agentId: string
}): Promise<WorkflowWorktree> {
  return createManagedWorktree({
    cwd: options.cwd,
    parentDirectory: join(options.praxisRoot, 'workflow-worktrees'),
    directoryName: `${options.runId}-${options.agentId}`,
    label: 'Workflow',
  })
}
