import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  memory: ClaudeTextResource | null
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

function present<T>(value: T | null): value is T {
  return value !== null
}

export async function loadClaudeSharedResources({
  configRoot,
  cwd,
}: LoadClaudeSharedResourcesOptions): Promise<ClaudeSharedResources> {
  const projectClaudeRoot = join(cwd, '.claude')
  const memoryPath = join(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(cwd),
    'memory',
    'MEMORY.md',
  )

  const [
    globalInstruction,
    projectInstruction,
    dotInstruction,
    rulePaths,
    memory,
    globalSkillPaths,
    projectSkillPaths,
    globalCommandPaths,
    projectCommandPaths,
    globalAgentPaths,
    projectAgentPaths,
    userSettings,
    projectSettings,
    localSettings,
    mcp,
  ] = await Promise.all([
    readOptionalText(join(configRoot, 'CLAUDE.md'), 'user'),
    readOptionalText(join(cwd, 'CLAUDE.md'), 'project'),
    readOptionalText(join(projectClaudeRoot, 'CLAUDE.md'), 'project'),
    findFiles(join(projectClaudeRoot, 'rules'), (name) => name.endsWith('.md')),
    readOptionalText(memoryPath, 'project'),
    findFiles(join(configRoot, 'skills'), (name) => name === 'SKILL.md'),
    findFiles(join(projectClaudeRoot, 'skills'), (name) => name === 'SKILL.md'),
    findFiles(join(configRoot, 'commands'), (name) => name.endsWith('.md')),
    findFiles(join(projectClaudeRoot, 'commands'), (name) =>
      name.endsWith('.md'),
    ),
    findFiles(join(configRoot, 'agents'), (name) => name.endsWith('.md')),
    findFiles(join(projectClaudeRoot, 'agents'), (name) =>
      name.endsWith('.md'),
    ),
    readOptionalJson(join(configRoot, 'settings.json'), 'user'),
    readOptionalJson(join(projectClaudeRoot, 'settings.json'), 'project'),
    readOptionalJson(join(projectClaudeRoot, 'settings.local.json'), 'local'),
    readOptionalJson(join(cwd, '.mcp.json'), 'project'),
  ])

  const [rules, globalSkills, projectSkills, globalCommands, projectCommands] =
    await Promise.all([
      loadFiles(rulePaths, 'project'),
      loadFiles(globalSkillPaths, 'user'),
      loadFiles(projectSkillPaths, 'project'),
      loadFiles(globalCommandPaths, 'user'),
      loadFiles(projectCommandPaths, 'project'),
    ])
  const [globalAgents, projectAgents] = await Promise.all([
    loadFiles(globalAgentPaths, 'user'),
    loadFiles(projectAgentPaths, 'project'),
  ])

  return {
    instructions: [
      globalInstruction,
      projectInstruction,
      dotInstruction,
      ...rules,
    ].filter(present),
    memory,
    skills: [...globalSkills, ...projectSkills],
    commands: [...globalCommands, ...projectCommands],
    agents: [...globalAgents, ...projectAgents],
    settings: [userSettings, projectSettings, localSettings].filter(present),
    mcp,
  }
}
