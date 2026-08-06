import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface WorkflowWorktree {
  cwd: string
  cleanup(): Promise<{ retained: boolean; reason?: string }>
}

export async function createWorkflowWorktree(options: {
  cwd: string
  praxisRoot: string
  runId: string
  agentId: string
}): Promise<WorkflowWorktree> {
  let root: string
  try {
    const result = await execFileAsync(
      'git',
      ['-C', options.cwd, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8' },
    )
    root = result.stdout.trim()
  } catch {
    throw new Error('Workflow worktree isolation requires a Git repository')
  }
  const parent = join(options.praxisRoot, 'workflow-worktrees')
  const path = join(parent, `${options.runId}-${options.agentId}`)
  await mkdir(parent, { recursive: true })
  try {
    await execFileAsync(
      'git',
      ['-C', root, 'worktree', 'add', '--detach', path, 'HEAD'],
      { encoding: 'utf8' },
    )
  } catch (error) {
    throw new Error(
      `Could not create workflow worktree: ${(error as Error).message}`,
    )
  }
  let cleaned = false
  return {
    cwd: path,
    cleanup: async () => {
      if (cleaned) return { retained: false }
      cleaned = true
      let status: string
      try {
        status = (
          await execFileAsync('git', ['-C', path, 'status', '--porcelain'], {
            encoding: 'utf8',
          })
        ).stdout
      } catch (error) {
        return {
          retained: true,
          reason: `Could not inspect workflow worktree ${path}: ${(error as Error).message}`,
        }
      }
      if (status.trim().length > 0) {
        return {
          retained: true,
          reason: `Workflow worktree has uncommitted changes and was retained at ${path}`,
        }
      }
      try {
        await execFileAsync('git', ['-C', root, 'worktree', 'remove', path], {
          encoding: 'utf8',
        })
        return { retained: false }
      } catch (error) {
        return {
          retained: true,
          reason: `Could not remove workflow worktree ${path}: ${(error as Error).message}`,
        }
      }
    },
  }
}
