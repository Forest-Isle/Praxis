import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { isSessionId } from '../core/session.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import type {
  DataPlaneAdapter,
  DataPlaneAdapterOptions,
  DataPlanePaths,
  DataPlaneRootOptions,
  ScheduledTaskFileOptions,
} from './data-plane-adapter.js'

export class NativeDataPlaneAdapter implements DataPlaneAdapter {
  readonly dataPlane = 'native' as const

  resolveRoot(options: DataPlaneRootOptions): string {
    const environment = options.environment ?? process.env
    if (options.root?.trim()) return resolve(options.root)
    const configuredRoot = environment.PRAXIS_HOME
    return resolve(
      configuredRoot?.trim()
        ? configuredRoot
        : resolve(options.homeDirectory ?? homedir(), '.praxis'),
    )
  }

  resolvePaths(options: DataPlaneAdapterOptions): DataPlanePaths {
    if (!isSessionId(options.sessionId)) {
      throw new Error(`Invalid session ID: ${options.sessionId}`)
    }
    const root = this.resolveRoot(options)
    const projectKey = sanitizeProjectPath(options.cwd)
    const projectRoot = resolve(root, 'sessions', projectKey)
    return {
      dataPlane: 'native',
      root,
      projectRoot,
      sessionFile: resolve(projectRoot, `${options.sessionId}.jsonl`),
      taskRoot: resolve(root, 'tasks', options.sessionId),
      stateRoot: resolve(root, 'state'),
      praxisRoot: resolve(root, 'state'),
      memoryRoot: resolve(root, 'memory', projectKey),
    }
  }

  resolveScheduledTaskFile(options: ScheduledTaskFileOptions): string {
    return resolve(
      options.root,
      'scheduled',
      `${sanitizeProjectPath(options.cwd)}.json`,
    )
  }
}

export const nativeDataPlaneAdapter = new NativeDataPlaneAdapter()
