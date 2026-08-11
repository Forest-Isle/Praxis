import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { parse as parseYaml } from 'yaml'

import { sanitizeClaudeProjectPath } from './paths.js'

export type ClaudeResourceScope = 'local' | 'project' | 'user'

export interface ClaudeTextResource {
  path: string
  scope: ClaudeResourceScope
  content: string
  importedFrom?: string
  importRoot?: string
}

export interface ClaudeJsonResource {
  path: string
  scope: ClaudeResourceScope
  value: unknown
  plugin?: true
  environment?: Readonly<Record<string, string>>
  sensitiveValues?: readonly string[]
}

export interface ClaudeContextResources {
  instructions: ClaudeTextResource[]
  conditionalRules: ClaudeConditionalRule[]
  memoryIndex: ClaudeTextResource | null
}

export interface ClaudeConditionalRule extends ClaudeTextResource {
  baseDirectory: string
  content: string
  globs: string[]
  rawContent: string
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
  claudeStatePath?: string
  settingSources?: readonly ClaudeResourceScope[]
}

function selectedScope(
  scope: ClaudeResourceScope,
  settingSources: readonly ClaudeResourceScope[] | undefined,
): boolean {
  return settingSources === undefined || settingSources.includes(scope)
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

const CLAUDE_INSTRUCTION_IMPORT_DEPTH = 4

function stripClaudeInstructionCode(line: string): string {
  let result = ''
  let inlineCodeLength = 0
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      result += inlineCodeLength === 0 ? line[index] : ' '
      index += 1
      continue
    }
    let end = index + 1
    while (line[end] === '`') end += 1
    const length = end - index
    if (inlineCodeLength === 0) inlineCodeLength = length
    else if (length === inlineCodeLength) inlineCodeLength = 0
    result += ' '.repeat(length)
    index = end
  }
  return result
}

function claudeInstructionImportPaths(
  resource: ClaudeTextResource,
  homeDirectory: string,
): string[] {
  const paths: string[] = []
  let fence: { character: string; length: number } | null = null
  for (const line of resource.content.split(/\r?\n/u)) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line)
    if (fence) {
      if (
        fenceMatch?.[1]?.[0] === fence.character &&
        fenceMatch[1].length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ''
      ) {
        fence = null
      }
      continue
    }
    if (fenceMatch?.[1]) {
      fence = {
        character: fenceMatch[1][0] ?? '`',
        length: fenceMatch[1].length,
      }
      continue
    }
    const visible = stripClaudeInstructionCode(line)
    for (const match of visible.matchAll(/@((?:\\[ \t]|[^\s])+)/gu)) {
      const rawPath = match[1]
      if (!rawPath) continue
      const importedPath = rawPath.replace(/\\([ \t])/gu, '$1')
      if (/^https?:\/\//u.test(importedPath)) continue
      paths.push(
        importedPath.startsWith('~/')
          ? join(homeDirectory, importedPath.slice(2))
          : resolve(dirname(resource.path), importedPath),
      )
    }
  }
  return paths
}

export async function resolveClaudeInstructionImports(
  resources: readonly ClaudeTextResource[],
  { homeDirectory = homedir() }: { homeDirectory?: string } = {},
): Promise<ClaudeTextResource[]> {
  const seen = new Set(
    await Promise.all(resources.map(({ path }) => canonicalPath(path))),
  )
  const resolved: ClaudeTextResource[] = []

  const appendImports = async (
    resource: ClaudeTextResource,
    root: ClaudeTextResource,
    depth: number,
  ): Promise<void> => {
    if (depth >= CLAUDE_INSTRUCTION_IMPORT_DEPTH) return
    for (const path of claudeInstructionImportPaths(resource, homeDirectory)) {
      let canonical: string
      let content: string
      try {
        canonical = await realpath(path)
        content = await readFile(canonical, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (seen.has(canonical)) continue
      seen.add(canonical)
      const imported: ClaudeTextResource = {
        path: canonical,
        scope: root.scope,
        content,
        importedFrom: resource.path,
        importRoot: root.path,
      }
      resolved.push(imported)
      await appendImports(imported, root, depth + 1)
    }
  }

  for (const resource of resources) {
    resolved.push(resource)
    await appendImports(resource, resource, 0)
  }
  return resolved
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

function parseConditionalRule(
  resource: ClaudeTextResource,
  baseDirectory: string,
): ClaudeConditionalRule | null {
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
    throw new Error(`Invalid Claude rule frontmatter: ${resource.path}`, {
      cause: error,
    })
  }
  if (typeof metadata !== 'object' || metadata === null) return null
  const paths = (metadata as Record<string, unknown>).paths
  if (paths === undefined) return null
  const globs = typeof paths === 'string' ? [paths] : paths
  if (
    !Array.isArray(globs) ||
    globs.length === 0 ||
    globs.some((glob) => typeof glob !== 'string' || glob.length === 0)
  ) {
    throw new Error(`Invalid Claude rule paths: ${resource.path}`)
  }

  return {
    ...resource,
    baseDirectory,
    content: lines.slice(closingIndex + 1).join('\n'),
    globs,
    rawContent: resource.content,
  }
}

async function loadAllRules(
  directory: string,
  scope: ClaudeResourceScope,
): Promise<ClaudeTextResource[]> {
  const paths = await findFiles(directory, (name) => name.endsWith('.md'))
  return loadFiles(paths, scope)
}

async function loadRuleResources(
  directory: string,
  scope: ClaudeResourceScope,
  baseDirectory: string,
): Promise<{
  unconditional: ClaudeTextResource[]
  conditional: ClaudeConditionalRule[]
}> {
  const rules = await loadAllRules(directory, scope)
  const parsed = rules.map((rule) => parseConditionalRule(rule, baseDirectory))
  return {
    unconditional: rules.filter((_, index) => parsed[index] === null),
    conditional: parsed.filter(
      (rule): rule is ClaudeConditionalRule => rule !== null,
    ),
  }
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
): Promise<{
  directories: string[]
  extensionDirectories: string[]
  homeBoundary: string | null
  memoryIdentityRoot: string
}> {
  const canonicalCwd = await canonicalPath(cwd)
  const gitRoot = await findGitRoot(canonicalCwd)
  if (gitRoot) {
    return {
      directories: directoriesFromRoot(gitRoot, canonicalCwd),
      extensionDirectories: directoriesFromRoot(gitRoot, canonicalCwd),
      homeBoundary: null,
      memoryIdentityRoot: await findMemoryIdentityRoot(gitRoot),
    }
  }

  const canonicalHome = await canonicalPath(homeDirectory)
  const directories = isWithin(canonicalHome, canonicalCwd)
    ? directoriesFromRoot(canonicalHome, canonicalCwd)
    : [canonicalCwd]
  return {
    directories,
    extensionDirectories:
      directories[0] === canonicalHome ? directories.slice(1) : directories,
    homeBoundary: directories[0] === canonicalHome ? canonicalHome : null,
    memoryIdentityRoot: canonicalCwd,
  }
}

export async function resolveClaudeProjectIdentity({
  cwd,
  homeDirectory = homedir(),
}: {
  cwd: string
  homeDirectory?: string
}): Promise<string> {
  return (await resolveProjectContext(cwd, homeDirectory)).memoryIdentityRoot
}

async function loadProjectSettings(
  configRoot: string,
  cwd: string,
): Promise<ClaudeJsonResource[]> {
  const userSettings = await readOptionalJson(
    join(configRoot, 'settings.json'),
    'user',
  )
  const projectSettings = await Promise.all([
    readOptionalJson(join(cwd, '.claude', 'settings.json'), 'project'),
    readOptionalJson(join(cwd, '.claude', 'settings.local.json'), 'local'),
  ])
  return [userSettings, ...projectSettings].filter(present)
}

export async function loadClaudeSettings({
  configRoot,
  cwd,
  settingSources,
}: LoadClaudeSharedResourcesOptions): Promise<ClaudeJsonResource[]> {
  return (
    await loadProjectSettings(configRoot, await canonicalPath(cwd))
  ).filter((resource) => selectedScope(resource.scope, settingSources))
}

export async function resolveClaudeProjectMemoryDirectory({
  configRoot,
  cwd,
  homeDirectory = homedir(),
}: LoadClaudeSharedResourcesOptions): Promise<string> {
  const { memoryIdentityRoot } = await resolveProjectContext(cwd, homeDirectory)
  return join(
    await canonicalPath(configRoot),
    'projects',
    sanitizeClaudeProjectPath(memoryIdentityRoot),
    'memory',
  )
}

async function loadProjectMcp(
  statePath: string,
  projectDirectories: readonly string[],
  projectIdentity: string,
): Promise<ClaudeJsonResource[]> {
  const [state, projectResources] = await Promise.all([
    readOptionalJson(statePath, 'user'),
    Promise.all(
      projectDirectories.map((directory) =>
        readOptionalJson(join(directory, '.mcp.json'), 'project'),
      ),
    ),
  ])
  const stateValue = isRecord(state?.value) ? state.value : null
  const userServers = isRecord(stateValue?.mcpServers)
    ? stateValue.mcpServers
    : null
  const projects = isRecord(stateValue?.projects) ? stateValue.projects : null
  const localProject = isRecord(projects?.[projectIdentity])
    ? projects[projectIdentity]
    : null
  const localServers = isRecord(localProject?.mcpServers)
    ? localProject.mcpServers
    : null
  return [
    ...(state && userServers
      ? [
          {
            path: state.path,
            scope: 'user' as const,
            value: { mcpServers: userServers },
          },
        ]
      : []),
    ...projectResources.filter(present),
    ...(state && localServers
      ? [
          {
            path: state.path,
            scope: 'local' as const,
            value: { mcpServers: localServers },
          },
        ]
      : []),
  ]
}

export async function loadClaudeMcpResources({
  configRoot,
  cwd,
  homeDirectory = homedir(),
  claudeStatePath = join(configRoot, '.claude.json'),
  settingSources,
}: LoadClaudeSharedResourcesOptions): Promise<ClaudeJsonResource[]> {
  const { directories, memoryIdentityRoot } = await resolveProjectContext(
    cwd,
    homeDirectory,
  )
  return (
    await loadProjectMcp(claudeStatePath, directories, memoryIdentityRoot)
  ).filter((resource) => selectedScope(resource.scope, settingSources))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ProjectResourceGroup<Rules> {
  instructions: ClaudeTextResource[]
  rules: Rules
}

async function loadProjectResourceGroups<Rules>(
  projectDirectories: readonly string[],
  homeBoundary: string | null,
  loadRules: (rulesDirectory: string, ownerDirectory: string) => Promise<Rules>,
): Promise<ProjectResourceGroup<Rules>[]> {
  return Promise.all(
    projectDirectories.map(async (directory) => {
      const claudeRoot = join(directory, '.claude')
      const [rootInstruction, localInstruction, dotInstruction, rules] =
        await Promise.all([
          readOptionalText(join(directory, 'CLAUDE.md'), 'project'),
          readOptionalText(join(directory, 'CLAUDE.local.md'), 'local'),
          directory === homeBoundary
            ? null
            : readOptionalText(join(claudeRoot, 'CLAUDE.md'), 'project'),
          loadRules(join(claudeRoot, 'rules'), directory),
        ])
      return {
        instructions: [
          rootInstruction,
          localInstruction,
          dotInstruction,
        ].filter(present),
        rules,
      }
    }),
  )
}

async function loadProjectInstructions(
  projectDirectories: readonly string[],
  homeBoundary: string | null,
): Promise<ClaudeTextResource[]> {
  const resourceGroups = await loadProjectResourceGroups(
    projectDirectories,
    homeBoundary,
    (rulesDirectory, ownerDirectory) =>
      ownerDirectory === homeBoundary
        ? Promise.resolve([])
        : loadAllRules(rulesDirectory, 'project'),
  )

  return resourceGroups.flatMap((group) => [
    ...group.instructions,
    ...group.rules,
  ])
}

async function loadProjectContextResources(
  projectDirectories: readonly string[],
  homeBoundary: string | null,
): Promise<{
  instructions: ClaudeTextResource[]
  conditionalRules: ClaudeConditionalRule[]
}> {
  const resourceGroups = await loadProjectResourceGroups(
    projectDirectories,
    homeBoundary,
    (rulesDirectory, ownerDirectory) =>
      ownerDirectory === homeBoundary
        ? Promise.resolve({ unconditional: [], conditional: [] })
        : loadRuleResources(rulesDirectory, 'project', ownerDirectory),
  )
  return {
    instructions: resourceGroups.flatMap((group) => [
      ...group.instructions,
      ...group.rules.unconditional,
    ]),
    conditionalRules: resourceGroups.flatMap(
      (group) => group.rules.conditional,
    ),
  }
}

function present<T>(value: T | null): value is T {
  return value !== null
}

async function loadResolvedClaudeContext(
  configRoot: string,
  projectDirectories: readonly string[],
  homeBoundary: string | null,
  memoryIdentityRoot: string,
): Promise<ClaudeContextResources> {
  const projectMemoryDirectory = join(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(memoryIdentityRoot),
    'memory',
  )
  const [globalInstruction, globalRules, projectContext, memoryIndex] =
    await Promise.all([
      readOptionalText(join(configRoot, 'CLAUDE.md'), 'user'),
      loadRuleResources(
        join(configRoot, 'rules'),
        'user',
        projectDirectories.at(-1) ?? memoryIdentityRoot,
      ),
      loadProjectContextResources(projectDirectories, homeBoundary),
      readOptionalText(join(projectMemoryDirectory, 'MEMORY.md'), 'project'),
    ])
  return {
    instructions: [
      globalInstruction,
      ...globalRules.unconditional,
      ...projectContext.instructions,
    ].filter(present),
    conditionalRules: [
      ...globalRules.conditional,
      ...projectContext.conditionalRules,
    ],
    memoryIndex,
  }
}

export async function loadClaudeContextResources({
  configRoot,
  cwd,
  homeDirectory = homedir(),
  settingSources,
}: LoadClaudeSharedResourcesOptions): Promise<ClaudeContextResources> {
  const { directories, homeBoundary, memoryIdentityRoot } =
    await resolveProjectContext(cwd, homeDirectory)
  const resources = await loadResolvedClaudeContext(
    configRoot,
    directories,
    homeBoundary,
    memoryIdentityRoot,
  )
  const instructions = resources.instructions.filter((resource) =>
    selectedScope(resource.scope, settingSources),
  )
  return {
    instructions: await resolveClaudeInstructionImports(instructions, {
      homeDirectory,
    }),
    conditionalRules: resources.conditionalRules.filter((resource) =>
      selectedScope(resource.scope, settingSources),
    ),
    memoryIndex:
      resources.memoryIndex &&
      selectedScope(resources.memoryIndex.scope, settingSources)
        ? resources.memoryIndex
        : null,
  }
}

export async function loadClaudeSharedResources({
  configRoot,
  cwd,
  homeDirectory = homedir(),
  claudeStatePath = join(configRoot, '.claude.json'),
  settingSources,
}: LoadClaudeSharedResourcesOptions): Promise<ClaudeSharedResources> {
  const {
    directories: projectDirectories,
    extensionDirectories,
    homeBoundary,
    memoryIdentityRoot,
  } = await resolveProjectContext(cwd, homeDirectory)
  const projectMemoryDirectory = join(
    configRoot,
    'projects',
    sanitizeClaudeProjectPath(memoryIdentityRoot),
    'memory',
  )
  const [
    globalInstruction,
    globalRules,
    projectInstructions,
    memory,
    skills,
    commands,
    agents,
    settings,
    mcp,
  ] = await Promise.all([
    readOptionalText(join(configRoot, 'CLAUDE.md'), 'user'),
    loadAllRules(join(configRoot, 'rules'), 'user'),
    loadProjectInstructions(projectDirectories, homeBoundary),
    findFiles(projectMemoryDirectory, (name) => name.endsWith('.md')).then(
      (paths) => loadFiles(paths, 'project'),
    ),
    loadScopedFiles(
      join(configRoot, 'skills'),
      extensionDirectories.map((path) => join(path, '.claude', 'skills')),
      (name) => name === 'SKILL.md',
    ),
    loadScopedFiles(
      join(configRoot, 'commands'),
      extensionDirectories.map((path) => join(path, '.claude', 'commands')),
      (name) => name.endsWith('.md'),
    ),
    loadScopedFiles(
      join(configRoot, 'agents'),
      extensionDirectories.map((path) => join(path, '.claude', 'agents')),
      (name) => name.endsWith('.md'),
    ),
    loadClaudeSettings({
      configRoot,
      cwd,
      ...(settingSources === undefined ? {} : { settingSources }),
    }),
    loadProjectMcp(claudeStatePath, projectDirectories, memoryIdentityRoot),
  ])

  const selected = <T extends { scope: ClaudeResourceScope }>(
    resources: readonly T[],
  ): T[] =>
    resources.filter((resource) =>
      selectedScope(resource.scope, settingSources),
    )
  const instructions = await resolveClaudeInstructionImports(
    selected(
      [globalInstruction, ...globalRules, ...projectInstructions].filter(
        present,
      ),
    ),
    { homeDirectory },
  )
  return {
    instructions,
    memory: selected(memory),
    skills: selected(skills),
    commands: selected(commands),
    agents: selected(agents),
    settings,
    mcp: selected(mcp),
  }
}
