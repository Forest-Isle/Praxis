import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { sanitizeClaudeProjectPath } from '../compatibility/claude/paths.js'
import type {
  ClaudeContextResources,
  ClaudeJsonResource,
  ClaudeResourceScope,
  ClaudeSharedResources,
  ClaudeTextResource,
} from '../compatibility/claude/shared-resources.js'

async function text(
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

async function json(
  path: string,
  scope: ClaudeResourceScope,
): Promise<ClaudeJsonResource | null> {
  const source = await text(path, scope)
  if (!source) return null
  let value: unknown
  try {
    value = JSON.parse(source.content)
  } catch (error) {
    throw new Error(`Invalid Praxis JSON resource: ${path}`, { cause: error })
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Praxis JSON resource must be an object: ${path}`)
  }
  return { path, scope, value }
}

async function files(
  directory: string,
  scope: ClaudeResourceScope,
  name: (value: string) => boolean,
): Promise<ClaudeTextResource[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => files(join(directory, entry.name), scope, name)),
  )
  const paths = entries
    .filter((entry) => entry.isFile() && name(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort()
  const direct = (
    await Promise.all(paths.map((path) => text(path, scope)))
  ).filter((resource): resource is ClaudeTextResource => resource !== null)
  return [...direct, ...nested.flat()]
}

export interface LoadNativeResourcesOptions {
  root: string
  cwd: string
}

export async function loadNativeSettings({
  root,
  cwd,
}: LoadNativeResourcesOptions): Promise<ClaudeJsonResource[]> {
  const project = resolve(cwd, '.praxis')
  const resources = await Promise.all([
    json(join(root, 'settings.json'), 'user'),
    json(join(project, 'settings.json'), 'project'),
    json(join(project, 'settings.local.json'), 'local'),
  ])
  return resources.filter(
    (resource): resource is ClaudeJsonResource => resource !== null,
  )
}

export async function loadNativeSharedResources({
  root,
  cwd,
}: LoadNativeResourcesOptions): Promise<ClaudeSharedResources> {
  const project = resolve(cwd, '.praxis')
  const memoryRoot = resolve(root, 'memory', sanitizeClaudeProjectPath(cwd))
  const [
    userInstruction,
    projectInstruction,
    memory,
    skills,
    commands,
    agents,
    settings,
    userMcp,
    projectMcp,
    localMcp,
  ] = await Promise.all([
    text(join(root, 'PRAXIS.md'), 'user'),
    text(join(project, 'PRAXIS.md'), 'project'),
    files(memoryRoot, 'project', (name) => name.endsWith('.md')),
    Promise.all([
      files(join(root, 'skills'), 'user', (name) => name === 'SKILL.md'),
      files(join(project, 'skills'), 'project', (name) => name === 'SKILL.md'),
    ]).then(([user, local]) => [...user, ...local]),
    Promise.all([
      files(join(root, 'commands'), 'user', (name) => name.endsWith('.md')),
      files(join(project, 'commands'), 'project', (name) =>
        name.endsWith('.md'),
      ),
    ]).then(([user, local]) => [...user, ...local]),
    Promise.all([
      files(join(root, 'agents'), 'user', (name) => name.endsWith('.md')),
      files(join(project, 'agents'), 'project', (name) => name.endsWith('.md')),
    ]).then(([user, local]) => [...user, ...local]),
    loadNativeSettings({ root, cwd }),
    json(join(root, 'mcp.json'), 'user'),
    json(join(project, 'mcp.json'), 'project'),
    json(join(project, 'mcp.local.json'), 'local'),
  ])
  return {
    instructions: [userInstruction, projectInstruction].filter(
      (resource): resource is ClaudeTextResource => resource !== null,
    ),
    memory,
    skills,
    commands,
    agents,
    settings,
    mcp: [userMcp, projectMcp, localMcp].filter(
      (resource): resource is ClaudeJsonResource => resource !== null,
    ),
  }
}

export async function loadNativeContextResources(
  options: LoadNativeResourcesOptions,
): Promise<ClaudeContextResources> {
  const resources = await loadNativeSharedResources(options)
  const memoryIndex = resources.memory.find((resource) =>
    resource.path.endsWith('/MEMORY.md'),
  )
  return {
    instructions: resources.instructions,
    conditionalRules: [],
    memoryIndex: memoryIndex ?? null,
  }
}
