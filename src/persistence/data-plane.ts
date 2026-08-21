import { homedir } from 'node:os'
import { resolve } from 'node:path'

import {
  isClaudeSessionId,
  sanitizeClaudeProjectPath,
} from '../compatibility/claude/paths.js'

export type DataPlane = 'native' | 'claude'

export interface ResolveDataPlaneOptions {
  dataPlane?: DataPlane
  cwd: string
  sessionId: string
  root?: string
  environment?: Readonly<Record<string, string | undefined>>
  homeDirectory?: string
}

export interface DataPlanePaths {
  dataPlane: DataPlane
  root: string
  projectRoot: string
  sessionFile: string
  taskRoot: string
  stateRoot: string
  /** Compatibility alias for callers that previously received `praxisRoot`. */
  praxisRoot: string
  memoryRoot: string
}

export function resolveDataPlane(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DataPlane {
  const value = environment.PRAXIS_DATA_PLANE?.trim()
  if (value === undefined || value === '') return 'native'
  if (value === 'native' || value === 'claude') return value
  throw new Error('PRAXIS_DATA_PLANE must be "native" or "claude"')
}

export function resolveDataPlaneRoot(
  options: {
    dataPlane?: DataPlane
    root?: string
    environment?: Readonly<Record<string, string | undefined>>
    homeDirectory?: string
  } = {},
): string {
  const environment = options.environment ?? process.env
  const dataPlane = options.dataPlane ?? resolveDataPlane(environment)
  const homeDirectory = options.homeDirectory ?? homedir()
  if (options.root?.trim()) return resolve(options.root)
  if (dataPlane === 'native') {
    const configuredRoot = environment.PRAXIS_HOME
    return resolve(
      configuredRoot?.trim()
        ? configuredRoot
        : resolve(homeDirectory, '.praxis'),
    )
  }
  const configuredRoot = environment.CLAUDE_CONFIG_DIR
  return resolve(
    configuredRoot?.trim() ? configuredRoot : resolve(homeDirectory, '.claude'),
  )
}

export function resolveDataPlanePaths(
  options: ResolveDataPlaneOptions,
): DataPlanePaths {
  if (!isClaudeSessionId(options.sessionId)) {
    throw new Error(`Invalid session ID: ${options.sessionId}`)
  }
  const environment = options.environment ?? process.env
  const dataPlane = options.dataPlane ?? resolveDataPlane(environment)
  const root = resolveDataPlaneRoot({
    dataPlane,
    environment,
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.homeDirectory === undefined
      ? {}
      : { homeDirectory: options.homeDirectory }),
  })
  const projectKey = sanitizeClaudeProjectPath(options.cwd)
  const projectRoot =
    dataPlane === 'native'
      ? resolve(root, 'sessions', projectKey)
      : resolve(root, 'projects', projectKey)
  const stateRoot =
    dataPlane === 'native' ? resolve(root, 'state') : resolve(root, 'praxis')
  return {
    dataPlane,
    root,
    projectRoot,
    sessionFile: resolve(projectRoot, `${options.sessionId}.jsonl`),
    taskRoot:
      dataPlane === 'native'
        ? resolve(root, 'tasks', options.sessionId)
        : resolve(root, 'tasks', options.sessionId),
    stateRoot,
    praxisRoot: stateRoot,
    memoryRoot:
      dataPlane === 'native'
        ? resolve(root, 'memory', projectKey)
        : resolve(root, 'projects', projectKey, 'memory'),
  }
}

export function resolveScheduledTaskFile(options: {
  dataPlane: DataPlane
  cwd: string
  root: string
}): string {
  return options.dataPlane === 'native'
    ? resolve(
        options.root,
        'scheduled',
        `${sanitizeClaudeProjectPath(options.cwd)}.json`,
      )
    : resolve(options.cwd, '.claude', 'scheduled_tasks.json')
}
