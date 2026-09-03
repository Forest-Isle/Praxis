import type { PermissionResolver, ToolRegistry } from '../core/runtime.js'
import type { ClaudeTeamAgentRuntime } from './team-agent-runtime.js'
import type { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import { createManagedWorktreeHooks } from './managed-worktree-hooks.js'
import { resolveDataPlanePaths } from '../persistence/data-plane.js'
import { LocalTeamManager } from './team-manager.js'

/** The local Team manager's conservative default parallelism. */
export const DEFAULT_LOCAL_TEAM_CONCURRENCY = 4

export interface LocalTeamCapabilityOptions {
  readonly nativeRoot: string
  /** Resolves the active workspace at the moment the Team capability opens. */
  readonly cwd: () => string
  readonly maxConcurrent: number
  readonly baseTools: ToolRegistry
  readonly permissions: PermissionResolver
  readonly createRuntime: () => ClaudeTeamAgentRuntime
  readonly hooks?: ClaudeHookRunner
  readonly permissionMode?: string
  readonly signal?: AbortSignal
}

/**
 * Lazy internal seam for the future Team lead tools.
 *
 * Keeping this port private to composition means enabling the experimental
 * capability cannot perform Team discovery during ordinary session startup.
 */
export class LocalTeamCapability {
  private openPromise: Promise<LocalTeamManager> | undefined

  constructor(private readonly options: LocalTeamCapabilityOptions) {}

  open(): Promise<LocalTeamManager> {
    if (this.openPromise) return this.openPromise

    const promise = (async () => {
      const cwd = this.options.cwd()
      if (!cwd) throw new Error('A Team workspace cwd is required')
      const runtime = this.options.createRuntime()
      return LocalTeamManager.open({
        nativeRoot: this.options.nativeRoot,
        cwd,
        maxConcurrent: this.options.maxConcurrent,
        baseTools: this.options.baseTools,
        permissions: this.options.permissions,
        runtime,
        ...(this.options.hooks
          ? {
              hooksFactory: (leadSessionId: string) =>
                createManagedWorktreeHooks({
                  runner: this.options.hooks as ClaudeHookRunner,
                  sessionId: leadSessionId,
                  transcriptPath: resolveDataPlanePaths({
                    dataPlane: 'native',
                    root: this.options.nativeRoot,
                    cwd,
                    sessionId: leadSessionId,
                  }).sessionFile,
                  permissionMode: this.options.permissionMode ?? 'default',
                  ...(this.options.signal
                    ? { signal: this.options.signal }
                    : {}),
                }),
            }
          : {}),
      })
    })()
    this.openPromise = promise
    void promise.catch(() => {
      if (this.openPromise === promise) this.openPromise = undefined
    })
    return promise
  }
}
