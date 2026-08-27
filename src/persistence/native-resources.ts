import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { resolveProjectMemoryPolicy } from '../core/project-memory.js'
import type {
  ContextResources,
  JsonResource,
  ResourceScope,
  SharedResources,
  TextResource,
  ConditionalRule,
} from '../core/resources.js'
import { resolveProjectMemoryDirectory } from '../platform/project-memory-paths.js'

async function text(
  path: string,
  scope: ResourceScope,
): Promise<TextResource | null> {
  try {
    return { path, scope, content: await readFile(path, 'utf8') }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function json(
  path: string,
  scope: ResourceScope,
): Promise<JsonResource | null> {
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
  scope: ResourceScope,
  name: (value: string) => boolean,
): Promise<TextResource[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const orderedEntries = entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  const nested = await Promise.all(
    orderedEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => files(join(directory, entry.name), scope, name)),
  )
  const paths = orderedEntries
    .filter((entry) => entry.isFile() && name(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort()
  const direct = (
    await Promise.all(paths.map((path) => text(path, scope)))
  ).filter((resource): resource is TextResource => resource !== null)
  return [...direct, ...nested.flat()]
}

function parseConditionalRule(
  resource: TextResource,
  baseDirectory: string,
): ConditionalRule | null {
  const lines = resource.content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === '---',
  )
  if (closingIndex < 0) return null
  let metadata: unknown
  try {
    metadata = parseYaml(lines.slice(1, closingIndex).join('\n'))
  } catch (error) {
    throw new Error(`Invalid Praxis rule frontmatter: ${resource.path}`, {
      cause: error,
    })
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null
  }
  const paths = (metadata as Record<string, unknown>).paths
  if (paths === undefined) return null
  const globs = typeof paths === 'string' ? [paths] : paths
  if (
    !Array.isArray(globs) ||
    globs.length === 0 ||
    globs.some((glob) => typeof glob !== 'string' || glob.length === 0)
  ) {
    throw new Error(`Invalid Praxis rule paths: ${resource.path}`)
  }
  return {
    ...resource,
    baseDirectory,
    content: lines.slice(closingIndex + 1).join('\n'),
    globs,
    rawContent: resource.content,
  }
}

async function loadRuleResources(
  directory: string,
  scope: ResourceScope,
  baseDirectory: string,
): Promise<{ unconditional: TextResource[]; conditional: ConditionalRule[] }> {
  const rules = await files(directory, scope, (name) => name.endsWith('.md'))
  const parsed = rules.map((rule) => parseConditionalRule(rule, baseDirectory))
  return {
    unconditional: rules.filter((_, index) => parsed[index] === null),
    conditional: parsed.filter(
      (rule): rule is ConditionalRule => rule !== null,
    ),
  }
}

export interface LoadNativeResourcesOptions {
  root: string
  cwd: string
  environment?: Readonly<Record<string, string | undefined>>
  includeProjectMemory?: boolean
}

export async function loadNativeSettings({
  root,
  cwd,
}: LoadNativeResourcesOptions): Promise<JsonResource[]> {
  const project = resolve(cwd, '.praxis')
  const resources = await Promise.all([
    json(join(root, 'settings.json'), 'user'),
    json(join(project, 'settings.json'), 'project'),
    json(join(project, 'settings.local.json'), 'local'),
  ])
  return resources.filter(
    (resource): resource is JsonResource => resource !== null,
  )
}

export async function loadNativeSharedResources({
  root,
  cwd,
  environment = process.env,
  includeProjectMemory = true,
}: LoadNativeResourcesOptions): Promise<SharedResources> {
  const project = resolve(cwd, '.praxis')
  const memoryRoot = await resolveProjectMemoryDirectory({
    configRoot: root,
    cwd,
  })
  const settings = await loadNativeSettings({ root, cwd })
  const memoryEnabled =
    includeProjectMemory &&
    resolveProjectMemoryPolicy({
      settings,
      environment,
    }).enabled
  const [
    userInstruction,
    projectInstruction,
    memory,
    skills,
    commands,
    agents,
    userMcp,
    projectMcp,
    localMcp,
    userRules,
    projectRules,
  ] = await Promise.all([
    text(join(root, 'PRAXIS.md'), 'user'),
    text(join(project, 'PRAXIS.md'), 'project'),
    memoryEnabled
      ? files(memoryRoot, 'project', (name) => name.endsWith('.md'))
      : Promise.resolve([]),
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
    json(join(root, 'mcp.json'), 'user'),
    json(join(project, 'mcp.json'), 'project'),
    json(join(project, 'mcp.local.json'), 'local'),
    loadRuleResources(join(root, 'rules'), 'user', root),
    loadRuleResources(join(project, 'rules'), 'project', cwd),
  ])
  return {
    instructions: [
      userInstruction,
      ...userRules.unconditional,
      projectInstruction,
      ...projectRules.unconditional,
    ].filter((resource): resource is TextResource => resource !== null),
    memory,
    skills,
    commands,
    agents,
    settings,
    mcp: [userMcp, projectMcp, localMcp].filter(
      (resource): resource is JsonResource => resource !== null,
    ),
  }
}

export async function loadNativeContextResources(
  options: LoadNativeResourcesOptions,
): Promise<ContextResources> {
  const resources = await loadNativeSharedResources(options)
  const project = resolve(options.cwd, '.praxis')
  const [userRules, projectRules] = await Promise.all([
    loadRuleResources(join(options.root, 'rules'), 'user', options.root),
    loadRuleResources(join(project, 'rules'), 'project', options.cwd),
  ])
  const memoryIndex = resources.memory.find((resource) =>
    resource.path.endsWith('/MEMORY.md'),
  )
  return {
    instructions: resources.instructions,
    conditionalRules: [...userRules.conditional, ...projectRules.conditional],
    memoryIndex: memoryIndex ?? null,
  }
}
