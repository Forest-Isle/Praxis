import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { isSessionId } from '../../core/session.js'
import {
  resolveClaudePaths,
  resolveClaudeScheduledTaskFile,
  sanitizeClaudeProjectPath,
} from './paths.js'
import type {
  DataPlaneAdapter,
  DataPlaneAdapterOptions,
  DataPlanePaths,
  DataPlaneRootOptions,
  ScheduledTaskFileOptions,
} from '../../persistence/data-plane-adapter.js'

export class ClaudeDataPlaneAdapter implements DataPlaneAdapter {
  readonly dataPlane = 'claude' as const

  resolveRoot(options: DataPlaneRootOptions): string {
    const environment = options.environment ?? process.env
    if (options.root?.trim()) return resolve(options.root)
    const configuredRoot = environment.CLAUDE_CONFIG_DIR
    return resolve(
      configuredRoot?.trim()
        ? configuredRoot
        : resolve(options.homeDirectory ?? homedir(), '.claude'),
    )
  }

  resolvePaths(options: DataPlaneAdapterOptions): DataPlanePaths {
    if (!isSessionId(options.sessionId)) {
      throw new Error(`Invalid session ID: ${options.sessionId}`)
    }
    const root = this.resolveRoot(options)
    const paths = resolveClaudePaths({
      cwd: options.cwd,
      sessionId: options.sessionId,
      configDir: root,
    })
    const projectKey = sanitizeClaudeProjectPath(options.cwd)
    const stateRoot = paths.praxisRoot
    return {
      dataPlane: 'claude',
      root: paths.configRoot,
      projectRoot: paths.projectRoot,
      sessionFile: paths.sessionFile,
      taskRoot: paths.taskRoot,
      stateRoot,
      praxisRoot: stateRoot,
      memoryRoot: resolve(root, 'projects', projectKey, 'memory'),
    }
  }

  resolveScheduledTaskFile(options: ScheduledTaskFileOptions): string {
    return resolveClaudeScheduledTaskFile(options.cwd)
  }
}

export const claudeDataPlaneAdapter = new ClaudeDataPlaneAdapter()
