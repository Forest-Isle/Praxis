import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import {
  isClaudeSessionId,
  sanitizeClaudeProjectPath,
} from '../compatibility/claude/paths.js'
import { resolveClaudeProjectIdentity } from '../compatibility/claude/shared-resources.js'
import { writeFileAtomically } from '../platform/atomic-write.js'

const MAX_ATOMIC_UPDATE_RETRIES = 8

export type ClaudeProjectPurgeItemKind =
  | 'project'
  | 'tasks'
  | 'debug'
  | 'file-history'
  | 'prompt-history'
  | 'config-key'

type ClaudeProjectPurgeOperation =
  | 'remove-path'
  | 'filter-history'
  | 'remove-project-config'
  | 'clear-project-config'

export interface ClaudeProjectPurgeItem {
  id: string
  kind: ClaudeProjectPurgeItemKind
  description: string
  path: string
  count: number
  operation: ClaudeProjectPurgeOperation
  projectIdentity?: string
  projectIdentities?: string[]
}

export interface ClaudeProjectPurgePlan {
  mode: 'project' | 'all'
  configRoot: string
  statePath: string
  targetPath?: string
  projectIdentity?: string
  projectRootPaths: string[]
  sessionIds: string[]
  items: ClaudeProjectPurgeItem[]
}

export interface PlanClaudeProjectPurgeOptions {
  cwd: string
  path?: string
  all?: boolean
  configRoot?: string
  statePath?: string
  homeDirectory?: string
}

export type ClaudeProjectPurgeSelection =
  'delete' | 'skip' | 'delete-all' | 'abort'

export interface ExecuteClaudeProjectPurgeOptions {
  dryRun?: boolean
  selectItem?: (
    item: ClaudeProjectPurgeItem,
  ) => Promise<ClaudeProjectPurgeSelection>
}

export interface ClaudeProjectPurgeFailure {
  item: ClaudeProjectPurgeItem
  error: Error
}

export interface ClaudeProjectPurgeResult {
  dryRun: boolean
  aborted: boolean
  deleted: ClaudeProjectPurgeItem[]
  skipped: ClaudeProjectPurgeItem[]
  failures: ClaudeProjectPurgeFailure[]
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      const parent = dirname(absolute)
      if (parent === absolute) return absolute
      return join(
        await canonicalPath(parent),
        absolute.slice(parent.length + 1),
      )
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function assertLexicallyContained(configRoot: string, candidate: string): void {
  const child = relative(configRoot, candidate)
  if (
    child.length === 0 ||
    child === '..' ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error(`Refusing to purge path outside config root: ${candidate}`)
  }
}

async function assertSafePurgePath(
  configRoot: string,
  candidate: string,
): Promise<void> {
  const absolute = resolve(candidate)
  assertLexicallyContained(configRoot, absolute)
  let metadata
  try {
    metadata = await lstat(absolute)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing to purge symbolic link: ${absolute}`)
  }
  const canonical = await realpath(absolute)
  assertLexicallyContained(configRoot, canonical)
}

async function assertMutableRegularFile(path: string): Promise<void> {
  let current = resolve(path)
  while (true) {
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `Refusing to update path through symbolic link: ${current}`,
        )
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  try {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing to update symbolic link: ${path}`)
    }
    if (!metadata.isFile()) throw new Error(`Expected a file: ${path}`)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function parseState(
  source: string | null,
  statePath: string,
): Record<string, unknown> {
  if (source === null) return {}
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid Claude state JSON: ${statePath}`, { cause: error })
  }
  if (!isRecord(value)) {
    throw new Error(`Claude state must be an object: ${statePath}`)
  }
  if (value.projects !== undefined && !isRecord(value.projects)) {
    throw new Error(`Claude state projects must be an object: ${statePath}`)
  }
  return value
}

function stateProjects(
  state: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(state.projects) ? state.projects : {}
}

function historyProject(line: string): string | null {
  const source = line.endsWith('\r') ? line.slice(0, -1) : line
  if (source.trim().length === 0) return null
  try {
    const value: unknown = JSON.parse(source)
    return isRecord(value) && typeof value.project === 'string'
      ? value.project
      : null
  } catch {
    return null
  }
}

function filterProjectHistory(
  source: string,
  projectPaths: readonly string[],
): { content: string; removed: number } {
  const paths = new Set(projectPaths)
  let cursor = 0
  let content = ''
  let removed = 0
  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor)
    const end = newline === -1 ? source.length : newline
    const line = source.slice(cursor, end)
    const segment = source.slice(cursor, newline === -1 ? end : end + 1)
    if (paths.has(historyProject(line) ?? '')) removed += 1
    else content += segment
    cursor = newline === -1 ? source.length : end + 1
  }
  return { content, removed }
}

async function discoverSessionIds(projectRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(projectRoot, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      return []
    }
    throw error
  }
  const sessionIds = new Set<string>()
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      const sessionId = entry.name.slice(0, -'.jsonl'.length)
      if (isClaudeSessionId(sessionId)) sessionIds.add(sessionId)
    }
    if (entry.isDirectory() && isClaudeSessionId(entry.name)) {
      sessionIds.add(entry.name)
    }
  }
  return [...sessionIds].sort()
}

async function discoverProjectRoots(
  configRoot: string,
  targetPaths: readonly string[],
): Promise<string[]> {
  const projectsRoot = join(configRoot, 'projects')
  if (!(await pathExists(projectsRoot))) return []
  await assertSafePurgePath(configRoot, projectsRoot)
  let entries
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true })
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      return []
    }
    throw error
  }
  const targetKeys = targetPaths.map(sanitizeClaudeProjectPath)
  return entries
    .filter((entry) =>
      targetKeys.some(
        (targetKey) =>
          entry.name === targetKey ||
          entry.name.startsWith(`${targetKey}--worktrees-`),
      ),
    )
    .map((entry) => join(projectsRoot, entry.name))
    .sort()
}

function removePathItem(
  kind: ClaudeProjectPurgeItemKind,
  path: string,
  description: string,
): ClaudeProjectPurgeItem {
  return {
    id: `${kind}:${path}`,
    kind,
    path,
    description,
    count: 1,
    operation: 'remove-path',
  }
}

async function addExistingPath(
  items: ClaudeProjectPurgeItem[],
  configRoot: string,
  item: ClaudeProjectPurgeItem,
): Promise<void> {
  if (!(await pathExists(item.path))) return
  await assertSafePurgePath(configRoot, item.path)
  items.push(item)
}

export async function planClaudeProjectPurge(
  options: PlanClaudeProjectPurgeOptions,
): Promise<ClaudeProjectPurgePlan> {
  if (options.all && options.path !== undefined) {
    throw new Error('Cannot specify both a path and --all')
  }
  const configuredRoot =
    options.configRoot ??
    (process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))
  const configRoot = await canonicalPath(configuredRoot)
  const defaultStatePath =
    options.configRoot !== undefined || Boolean(process.env.CLAUDE_CONFIG_DIR)
      ? join(configRoot, '.claude.json')
      : resolve(homedir(), '.claude.json')
  const statePath = await canonicalPath(options.statePath ?? defaultStatePath)
  await assertMutableRegularFile(statePath)
  const state = parseState(await readOptionalFile(statePath), statePath)
  const projects = stateProjects(state)
  const items: ClaudeProjectPurgeItem[] = []

  if (options.all) {
    const roots: Array<{
      kind: ClaudeProjectPurgeItemKind
      name: string
      description: string
    }> = [
      {
        kind: 'project',
        name: 'projects',
        description: 'all project transcripts and memory',
      },
      {
        kind: 'tasks',
        name: 'tasks',
        description: 'all session task lists',
      },
      {
        kind: 'debug',
        name: 'debug',
        description: 'all session debug logs',
      },
      {
        kind: 'file-history',
        name: 'file-history',
        description: 'all session file edit history',
      },
      {
        kind: 'prompt-history',
        name: 'history.jsonl',
        description: 'prompt history across all projects',
      },
    ]
    for (const root of roots) {
      const path = join(configRoot, root.name)
      await addExistingPath(
        items,
        configRoot,
        removePathItem(root.kind, path, root.description),
      )
    }
    const projectCount = Object.keys(projects).length
    if (projectCount > 0) {
      items.push({
        id: `config-key:${statePath}:all`,
        kind: 'config-key',
        path: statePath,
        description: 'all project entries in Claude state',
        count: projectCount,
        operation: 'clear-project-config',
      })
    }
    return {
      mode: 'all',
      configRoot,
      statePath,
      projectRootPaths: [],
      sessionIds: [],
      items,
    }
  }

  const requestedPath = resolve(options.path ?? options.cwd)
  const targetPath = await canonicalPath(requestedPath)
  const targetPaths = [...new Set([requestedPath, targetPath])]
  const projectIdentity = await resolveClaudeProjectIdentity({
    cwd: targetPath,
    homeDirectory: options.homeDirectory ?? homedir(),
  })
  const projectRootPaths = await discoverProjectRoots(configRoot, targetPaths)
  const sessionIdSet = new Set<string>()
  for (const projectRoot of projectRootPaths) {
    await assertSafePurgePath(configRoot, projectRoot)
    for (const sessionId of await discoverSessionIds(projectRoot)) {
      sessionIdSet.add(sessionId)
    }
  }
  const sessionIds = [...sessionIdSet].sort()
  for (const sessionId of sessionIds) {
    await addExistingPath(
      items,
      configRoot,
      removePathItem(
        'tasks',
        join(configRoot, 'tasks', sessionId),
        `tasks for session ${sessionId}`,
      ),
    )
    await addExistingPath(
      items,
      configRoot,
      removePathItem(
        'debug',
        join(configRoot, 'debug', `${sessionId}.txt`),
        `debug log for session ${sessionId}`,
      ),
    )
    await addExistingPath(
      items,
      configRoot,
      removePathItem(
        'file-history',
        join(configRoot, 'file-history', sessionId),
        `file edit history for session ${sessionId}`,
      ),
    )
  }
  for (const projectRoot of projectRootPaths) {
    await addExistingPath(
      items,
      configRoot,
      removePathItem('project', projectRoot, 'project transcripts and memory'),
    )
  }

  const historyPath = join(configRoot, 'history.jsonl')
  const historyExists = await pathExists(historyPath)
  if (historyExists) await assertSafePurgePath(configRoot, historyPath)
  const historySource = historyExists
    ? await readOptionalFile(historyPath)
    : null
  if (historySource !== null) {
    const { removed } = filterProjectHistory(historySource, targetPaths)
    if (removed > 0) {
      items.push({
        id: `prompt-history:${historyPath}:${targetPath}`,
        kind: 'prompt-history',
        path: historyPath,
        description: `${removed} prompt history line(s) for project`,
        count: removed,
        operation: 'filter-history',
        projectIdentity: targetPath,
        projectIdentities: targetPaths,
      })
    }
  }
  const projectIdentities = [...new Set([projectIdentity, ...targetPaths])]
  for (const identity of projectIdentities) {
    if (!Object.hasOwn(projects, identity)) continue
    items.push({
      id: `config-key:${statePath}:${identity}`,
      kind: 'config-key',
      path: statePath,
      description: 'project entry in Claude state',
      count: 1,
      operation: 'remove-project-config',
      projectIdentity: identity,
    })
  }
  return {
    mode: 'project',
    configRoot,
    statePath,
    targetPath,
    projectIdentity,
    projectRootPaths,
    sessionIds,
    items,
  }
}

async function atomicallyUpdate(
  path: string,
  update: (source: string | null) => string | null,
): Promise<void> {
  await assertMutableRegularFile(path)
  for (let attempt = 0; attempt < MAX_ATOMIC_UPDATE_RETRIES; attempt += 1) {
    const source = await readOptionalFile(path)
    const content = update(source)
    if (content === null || content === source) return
    const committed = await writeFileAtomically(path, content, {
      beforeCommit: async () => (await readOptionalFile(path)) === source,
    })
    if (committed) return
  }
  throw new Error(`Claude state changed repeatedly during purge: ${path}`)
}

async function executeItem(
  plan: ClaudeProjectPurgePlan,
  item: ClaudeProjectPurgeItem,
): Promise<void> {
  if (item.operation === 'remove-path') {
    await assertSafePurgePath(plan.configRoot, item.path)
    await rm(item.path, { recursive: true, force: true })
    return
  }
  if (item.operation === 'filter-history') {
    const projectPath = item.projectIdentity
    if (!projectPath) throw new Error('Missing project path for history purge')
    const projectPaths = item.projectIdentities ?? [projectPath]
    await assertSafePurgePath(plan.configRoot, item.path)
    await atomicallyUpdate(item.path, (source) => {
      if (source === null) return null
      return filterProjectHistory(source, projectPaths).content
    })
    return
  }
  await atomicallyUpdate(item.path, (source) => {
    if (source === null) return null
    const state = parseState(source, item.path)
    const projects = { ...stateProjects(state) }
    if (item.operation === 'remove-project-config') {
      const projectIdentity = item.projectIdentity
      if (!projectIdentity || !Object.hasOwn(projects, projectIdentity)) {
        return null
      }
      delete projects[projectIdentity]
    } else {
      if (Object.keys(projects).length === 0) return null
      for (const key of Object.keys(projects)) delete projects[key]
    }
    state.projects = projects
    return `${JSON.stringify(state, null, 2)}\n`
  })
}

export async function executeClaudeProjectPurge(
  plan: ClaudeProjectPurgePlan,
  options: ExecuteClaudeProjectPurgeOptions = {},
): Promise<ClaudeProjectPurgeResult> {
  if (options.dryRun) {
    return {
      dryRun: true,
      aborted: false,
      deleted: [],
      skipped: [],
      failures: [],
    }
  }
  const deleted: ClaudeProjectPurgeItem[] = []
  const skipped: ClaudeProjectPurgeItem[] = []
  const failures: ClaudeProjectPurgeFailure[] = []
  let deleteAll = false
  let aborted = false
  for (const item of plan.items) {
    const selection = deleteAll
      ? 'delete'
      : await (options.selectItem?.(item) ?? Promise.resolve('delete'))
    if (selection === 'abort') {
      aborted = true
      break
    }
    if (selection === 'skip') {
      skipped.push(item)
      continue
    }
    if (selection === 'delete-all') deleteAll = true
    try {
      await executeItem(plan, item)
      deleted.push(item)
    } catch (error) {
      failures.push({
        item,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }
  }
  return { dryRun: false, aborted, deleted, skipped, failures }
}
