import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { getDataOwnership } from './ownership.js'

const MAX_SANITIZED_LENGTH = 200
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isClaudeSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

export interface ResolveClaudePathsOptions {
  cwd: string
  sessionId: string
  configDir?: string
}

export interface ClaudePaths {
  configRoot: string
  projectRoot: string
  sessionFile: string
  taskRoot: string
  praxisRoot: string
}

function stablePathHash(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash, 31) + value.charCodeAt(index)
    hash |= 0
  }

  return Math.abs(hash)
}

export function sanitizeClaudeProjectPath(path: string): string {
  const sanitized = path.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }

  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${stablePathHash(path).toString(36)}`
}

export function resolveClaudeScheduledTaskFile(cwd: string): string {
  const policy = getDataOwnership('scheduled-prompts')
  if (
    policy.plane !== 'shared' ||
    policy.praxisAccess !== 'read-write' ||
    policy.location !== '.claude/scheduled_tasks.json'
  ) {
    throw new Error('Invalid scheduled prompt ownership policy')
  }
  return resolve(cwd, '.claude', 'scheduled_tasks.json')
}

export function resolveClaudePaths({
  cwd,
  sessionId,
  configDir,
}: ResolveClaudePathsOptions): ClaudePaths {
  if (!isClaudeSessionId(sessionId)) {
    throw new Error(`Invalid Claude session ID: ${sessionId}`)
  }

  const configuredRoot = configDir ?? process.env.CLAUDE_CONFIG_DIR
  const configRoot = resolve(configuredRoot ?? resolve(homedir(), '.claude'))
  const projectRoot = resolve(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(cwd),
  )
  const taskPolicy = getDataOwnership('durable-task-graph')
  if (
    taskPolicy.plane !== 'shared' ||
    taskPolicy.praxisAccess !== 'read-write' ||
    taskPolicy.location !== 'tasks/<session-id>/'
  ) {
    throw new Error('Invalid durable task graph ownership policy')
  }

  return {
    configRoot,
    projectRoot,
    sessionFile: resolve(projectRoot, `${sessionId}.jsonl`),
    taskRoot: resolve(configRoot, 'tasks', sessionId),
    praxisRoot: resolve(configRoot, 'praxis'),
  }
}
