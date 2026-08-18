import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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

function claudeDjb2Hash(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }

  return hash
}

export function sanitizeClaudeProjectPath(path: string): string {
  const sanitized = path.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }

  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(claudeDjb2Hash(path)).toString(36)}`
}

/**
 * Returns the truncated sanitized directory prefix Claude Code uses for long
 * project paths, or null when the path is short enough that its project
 * directory key is unambiguous.
 */
export function claudeProjectPathPrefix(path: string): string | null {
  const sanitized = path.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return null
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-`
}

/**
 * Deterministically discovers the Claude project directory for a long project
 * path whose exact key cannot be resolved from the current cwd. Only reads
 * entries inside `<configRoot>/projects` that share the truncated sanitized
 * prefix, so the scan is bounded and never leaves the config root. Prefers the
 * exact key for the cwd, then the most recently modified matching directory
 * with a lexicographic name tiebreak.
 */
export async function discoverClaudeProjectRoot(
  configRoot: string,
  cwd: string,
): Promise<string | null> {
  const prefix = claudeProjectPathPrefix(cwd)
  if (prefix === null) return null

  const projectsRoot = join(configRoot, 'projects')
  let entries
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  const exactKey = sanitizeClaudeProjectPath(cwd)
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.includes('--worktrees-')) continue
    if (entry.name.startsWith(prefix)) candidates.push(entry.name)
  }
  if (candidates.length === 0) return null
  if (candidates.includes(exactKey)) return resolve(projectsRoot, exactKey)

  const withMtime = await Promise.all(
    candidates.map(async (name) => {
      try {
        const metadata = await stat(join(projectsRoot, name))
        return { name, mtimeMs: metadata.mtimeMs }
      } catch {
        return null
      }
    }),
  )
  const readable = withMtime.filter(
    (candidate): candidate is { name: string; mtimeMs: number } =>
      candidate !== null,
  )
  if (readable.length === 0) return null
  readable.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name),
  )
  const selected = readable[0]
  if (selected === undefined) return null
  return resolve(projectsRoot, selected.name)
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
