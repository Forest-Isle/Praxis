import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

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
  mcp: ClaudeJsonResource[]
}

export interface LoadClaudeSharedResourcesOptions {
  configRoot: string
  cwd: string
  homeDirectory?: string
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

function directoriesFromRoot(root: string, cwd: string): string[] {
  const directories = [cwd]
  let current = cwd
  while (current !== root) {
    const parent = dirname(current)
    if (parent === current) return [cwd]
    directories.push(parent)
    current = parent
  }
  return directories.reverse()
}

function isWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
  )
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path)
    throw error
  }
}

async function findGitRoot(cwd: string): Promise<string | null> {
  let current = cwd
  while (!(await exists(join(current, '.git')))) {
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
  return current
}

async function readOptionalRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function findMemoryIdentityRoot(gitRoot: string): Promise<string> {
  const gitMarker = join(gitRoot, '.git')
  const marker = await stat(gitMarker)
  if (!marker.isFile()) return gitRoot

  const gitFile = await readFile(gitMarker, 'utf8')
  const match = /^gitdir:\s*(.+)\s*$/m.exec(gitFile)
  if (!match?.[1]) return gitRoot
  const gitDirectory = resolve(gitRoot, match[1])
  const commonDirectory = await readOptionalRaw(join(gitDirectory, 'commondir'))
  if (!commonDirectory) return gitRoot
  const commonGitDirectory = await canonicalPath(
    resolve(gitDirectory, commonDirectory.trim()),
  )
  return dirname(commonGitDirectory)
}

async function resolveProjectContext(
  cwd: string,
  homeDirectory: string,
): Promise<{ directories: string[]; memoryIdentityRoot: string }> {
  const canonicalCwd = await canonicalPath(cwd)
  const gitRoot = await findGitRoot(canonicalCwd)
  if (gitRoot) {
    return {
      directories: directoriesFromRoot(gitRoot, canonicalCwd),
      memoryIdentityRoot: await findMemoryIdentityRoot(gitRoot),
    }
  }

  const canonicalHome = await canonicalPath(homeDirectory)
  return {
    directories: isWithin(canonicalHome, canonicalCwd)
      ? directoriesFromRoot(canonicalHome, canonicalCwd)
      : [canonicalCwd],
    memoryIdentityRoot: canonicalCwd,
  }
}

async function loadProjectSettings(
  configRoot: string,
  projectDirectories: readonly string[],
): Promise<ClaudeJsonResource[]> {
  const userSettings = await readOptionalJson(
    join(configRoot, 'settings.json'),
    'user',
  )
  const projectSettings = await Promise.all(
    projectDirectories.flatMap((directory) => [
      readOptionalJson(join(directory, '.claude', 'settings.json'), 'project'),
      readOptionalJson(
        join(directory, '.claude', 'settings.local.json'),
        'local',
      ),
    ]),
  )
  return [userSettings, ...projectSettings].filter(present)
}

async function loadProjectMcp(
  projectDirectories: readonly string[],
): Promise<ClaudeJsonResource[]> {
  const resources = await Promise.all(
    projectDirectories.map((directory) =>
      readOptionalJson(join(directory, '.mcp.json'), 'project'),
    ),
  )
  return resources.filter(present)
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
  homeDirectory = homedir(),
}: LoadClaudeSharedResourcesOptions): Promise<ClaudeSharedResources> {
  const { directories: projectDirectories, memoryIdentityRoot } =
    await resolveProjectContext(cwd, homeDirectory)
  const projectMemoryDirectory = join(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(memoryIdentityRoot),
    'memory',
  )

  const [
    globalInstruction,
    projectInstructions,
    memory,
    skills,
    commands,
    agents,
    settings,
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
    loadProjectSettings(configRoot, projectDirectories),
    loadProjectMcp(projectDirectories),
  ])

  return {
    instructions: [globalInstruction, ...projectInstructions].filter(present),
    memory,
    skills,
    commands,
    agents,
    settings,
    mcp,
  }
}
