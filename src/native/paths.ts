import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, resolve } from 'node:path'

import { isSessionId } from '../core/session.js'
import { sanitizeProjectPath } from '../platform/project-path-key.js'
import { getNativeDataOwnership } from './ownership.js'

const MAX_SANITIZED_LENGTH = 200

export function isClaudeSessionId(value: string): boolean {
  return isSessionId(value)
}

export interface ResolveNativePathsOptions {
  cwd: string
  sessionId: string
  configDir?: string
}

export interface NativePaths {
  configRoot: string
  projectRoot: string
  sessionFile: string
  taskRoot: string
  praxisRoot: string
}

export function sanitizeNativeProjectPath(path: string): string {
  return sanitizeProjectPath(path)
}

export interface DiscoverNativeProjectRootOptions {
  configRoot: string
  cwd: string
  sessionId?: string
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function hasClaudeSessionTranscript(directory: string): Promise<boolean> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  for (const name of names) {
    if (extname(name) !== '.jsonl') continue
    if (!isClaudeSessionId(name.slice(0, -'.jsonl'.length))) continue
    if (await isRegularFile(resolve(directory, name))) return true
  }
  return false
}

/**
 * Locates the native project directory for a cwd, preferring the exact
 * sanitized hash path and falling back to a long-path truncated-prefix
 * candidate when Claude used a different runtime hash. When a sessionId is
 * supplied, the exact directory only matches if it contains the requested
 * regular session file; an existing exact directory without that file still
 * falls through to the long-path prefix scan. Candidate selection is
 * directory-prefix based and never uses mtime; ambiguous prefixes are rejected.
 */
export async function discoverNativeProjectRoot({
  configRoot,
  cwd,
  sessionId,
}: DiscoverNativeProjectRootOptions): Promise<string | undefined> {
  if (sessionId !== undefined && !isSessionId(sessionId)) {
    return undefined
  }

  const sanitized = sanitizeNativeProjectPath(cwd)
  const exactProjectRoot = resolve(configRoot, 'sessions', sanitized)
  if (sessionId !== undefined) {
    // A sessionId targets a concrete transcript; an existing exact directory
    // only matches when it actually holds the requested session file. Praxis
    // may have created an empty exact directory before the transcript landed
    // in an alternate long-path prefix directory, so fall through to the
    // prefix scan instead of returning the empty exact directory.
    if (await isRegularFile(resolve(exactProjectRoot, `${sessionId}.jsonl`))) {
      return exactProjectRoot
    }
  } else if (await isDirectory(exactProjectRoot)) {
    return exactProjectRoot
  }

  if (sanitized.length <= MAX_SANITIZED_LENGTH) return undefined

  const prefix = sanitized.slice(0, MAX_SANITIZED_LENGTH)
  let names: string[]
  try {
    names = await readdir(resolve(configRoot, 'sessions'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  const candidates: string[] = []
  for (const name of names) {
    if (!name.startsWith(`${prefix}-`)) continue
    const candidate = resolve(configRoot, 'sessions', name)
    if (!(await isDirectory(candidate))) continue
    if (sessionId !== undefined) {
      if (await isRegularFile(resolve(candidate, `${sessionId}.jsonl`))) {
        candidates.push(candidate)
      }
      continue
    }
    if (await hasClaudeSessionTranscript(candidate)) {
      candidates.push(candidate)
    }
  }

  return candidates.length === 1 ? candidates[0] : undefined
}

export function resolveNativeScheduledTaskFile(
  cwd: string,
  configRoot = resolve(homedir(), '.praxis'),
): string {
  const policy = getNativeDataOwnership('scheduled-prompts')
  if (policy.plane !== 'shared' || policy.praxisAccess !== 'read-write') {
    throw new Error('Invalid scheduled prompt ownership policy')
  }
  return resolve(
    configRoot,
    'scheduled',
    `${sanitizeNativeProjectPath(cwd)}.json`,
  )
}

export function resolveNativePaths({
  cwd,
  sessionId,
  configDir,
}: ResolveNativePathsOptions): NativePaths {
  if (!isSessionId(sessionId)) {
    throw new Error(`Invalid native session ID: ${sessionId}`)
  }

  const configRoot = resolve(configDir ?? resolve(homedir(), '.praxis'))
  const projectRoot = resolve(
    configRoot,
    'sessions',
    sanitizeNativeProjectPath(cwd),
  )
  const taskPolicy = getNativeDataOwnership('durable-task-graph')
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
    praxisRoot: resolve(configRoot, 'state'),
  }
}
