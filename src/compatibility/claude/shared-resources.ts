import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { sanitizeClaudeProjectPath } from './paths.js'

export type ClaudeResourceScope = 'local' | 'project' | 'user'

export interface ClaudeTextResource {
  path: string
  scope: ClaudeResourceScope
  content: string
}

export interface ClaudeJsonResource {
  path: string
  scope: ClaudeResourceScope
  value: unknown
}

export interface ClaudeSharedResources {
  instructions: ClaudeTextResource[]
  memory: ClaudeTextResource[]
  skills: ClaudeTextResource[]
  commands: ClaudeTextResource[]
  agents: ClaudeTextResource[]
  settings: ClaudeJsonResource[]
  mcp: ClaudeJsonResource | null
}

export interface LoadClaudeSharedResourcesOptions {
  configRoot: string
  cwd: string
}

async function readOptionalText(
  path: string,
  scope: ClaudeResourceScope,
): Promise<ClaudeTextResource | null> {
  try {
    return { path, scope, content: await readFile(path, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function readOptionalJson(
  path: string,
  scope: ClaudeResourceScope,
): Promise<ClaudeJsonResource | null> {
  const resource = await readOptionalText(path, scope)
  if (!resource) return null

  try {
    return { path, scope, value: JSON.parse(resource.content) }
  } catch (error) {
    throw new Error(`Invalid Claude JSON resource: ${path}`, { cause: error })
  }
}

async function findFiles(
  directory: string,
  matches: (name: string) => boolean,
): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return findFiles(path, matches)
      return entry.isFile() && matches(entry.name) ? [path] : []
    }),
  )

  return files.flat().sort()
}

async function loadFiles(
  paths: readonly string[],
  scope: ClaudeResourceScope,
): Promise<ClaudeTextResource[]> {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      scope,
      content: await readFile(path, 'utf8'),
    })),
  )
}

async function loadScopedFiles(
  userDirectory: string,
  projectDirectories: readonly string[],
  matches: (name: string) => boolean,
): Promise<ClaudeTextResource[]> {
  const [userPaths, projectPathGroups] = await Promise.all([
    findFiles(userDirectory, matches),
    Promise.all(projectDirectories.map((path) => findFiles(path, matches))),
  ])
  const projectPaths = projectPathGroups.flat()
  const [userResources, projectResources] = await Promise.all([
    loadFiles(userPaths, 'user'),
    loadFiles(projectPaths, 'project'),
  ])
  return [...userResources, ...projectResources]
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function findProjectDirectories(cwd: string): Promise<string[]> {
  const resolvedCwd = resolve(cwd)
  const directories = [resolvedCwd]
  let current = resolvedCwd

  while (!(await exists(join(current, '.git')))) {
    const parent = dirname(current)
    if (parent === current) return [resolvedCwd]
    directories.push(parent)
    current = parent
  }

  return directories.reverse()
}

async function loadProjectInstructions(
  projectDirectories: readonly string[],
): Promise<ClaudeTextResource[]> {
  const resourceGroups = await Promise.all(
    projectDirectories.map(async (directory) => {
      const claudeRoot = join(directory, '.claude')
      const [rootInstruction, dotInstruction, rulePaths] = await Promise.all([
        readOptionalText(join(directory, 'CLAUDE.md'), 'project'),
        readOptionalText(join(claudeRoot, 'CLAUDE.md'), 'project'),
        findFiles(join(claudeRoot, 'rules'), (name) => name.endsWith('.md')),
      ])
      const rules = await loadFiles(rulePaths, 'project')
      return [rootInstruction, dotInstruction, ...rules].filter(present)
    }),
  )

  return resourceGroups.flat()
}

function present<T>(value: T | null): value is T {
  return value !== null
}

export async function loadClaudeSharedResources({
  configRoot,
  cwd,
}: LoadClaudeSharedResourcesOptions): Promise<ClaudeSharedResources> {
  const projectDirectories = await findProjectDirectories(cwd)
  const projectClaudeRoot = join(cwd, '.claude')
  const projectMemoryDirectory = join(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(projectDirectories[0] ?? resolve(cwd)),
    'memory',
  )

  const [
    globalInstruction,
    projectInstructions,
    memory,
    skills,
    commands,
    agents,
    userSettings,
    projectSettings,
    localSettings,
    mcp,
  ] = await Promise.all([
    readOptionalText(join(configRoot, 'CLAUDE.md'), 'user'),
    loadProjectInstructions(projectDirectories),
    findFiles(projectMemoryDirectory, (name) => name.endsWith('.md')).then(
      (paths) => loadFiles(paths, 'project'),
    ),
    loadScopedFiles(
      join(configRoot, 'skills'),
      projectDirectories.map((path) => join(path, '.claude', 'skills')),
      (name) => name === 'SKILL.md',
    ),
    loadScopedFiles(
      join(configRoot, 'commands'),
      projectDirectories.map((path) => join(path, '.claude', 'commands')),
      (name) => name.endsWith('.md'),
    ),
    loadScopedFiles(
      join(configRoot, 'agents'),
      projectDirectories.map((path) => join(path, '.claude', 'agents')),
      (name) => name.endsWith('.md'),
    ),
    readOptionalJson(join(configRoot, 'settings.json'), 'user'),
    readOptionalJson(join(projectClaudeRoot, 'settings.json'), 'project'),
    readOptionalJson(join(projectClaudeRoot, 'settings.local.json'), 'local'),
    readOptionalJson(join(cwd, '.mcp.json'), 'project'),
  ])

  return {
    instructions: [globalInstruction, ...projectInstructions].filter(present),
    memory,
    skills,
    commands,
    agents,
    settings: [userSettings, projectSettings, localSettings].filter(present),
    mcp,
  }
}
