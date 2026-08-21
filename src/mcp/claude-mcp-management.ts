import { constants } from 'node:fs'
import { mkdir, open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  ExclusiveFileLease,
  type ExclusiveFileLeaseHandle,
} from '../platform/exclusive-file-lease.js'
import {
  loadClaudeSharedResources,
  resolveClaudeProjectIdentity,
  type ClaudeJsonResource,
  type ClaudeResourceScope,
} from '../compatibility/claude/shared-resources.js'
import type { DataPlane } from '../persistence/data-plane.js'
import { loadNativeSharedResources } from '../persistence/native-resources.js'

export type McpScope = ClaudeResourceScope
export type McpServerConfig = Record<string, unknown>

export interface McpServerRecord {
  name: string
  scope: McpScope
  path: string
  config: McpServerConfig
}

interface McpManagementOptions {
  dataPlane?: DataPlane
  configRoot?: string
  statePath?: string
  cwd: string
  beforeCommit?: (path: string, attempt: number) => Promise<void>
}

interface McpTarget {
  path: string
  projectIdentity?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function filterDisabledMcpResources(
  resources: readonly ClaudeJsonResource[],
  disabledNames: readonly string[],
): readonly ClaudeJsonResource[] {
  if (disabledNames.length === 0) return resources
  const disabled = new Set(disabledNames)
  return resources.map((resource) => {
    if (!isRecord(resource.value) || !isRecord(resource.value.mcpServers)) {
      return resource
    }
    return {
      ...resource,
      value: {
        ...resource.value,
        mcpServers: Object.fromEntries(
          Object.entries(resource.value.mcpServers).filter(
            ([name]) => !disabled.has(name),
          ),
        ),
      },
    }
  })
}

interface SourceFingerprint {
  source: string
  device: number
  inode: number
  size: number
  modifiedMs: number
}

async function readJsonSource(
  path: string,
  rejectSymlinks = true,
): Promise<{
  value: Record<string, unknown>
  fingerprint?: SourceFingerprint
}> {
  let handle
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (rejectSymlinks ? constants.O_NOFOLLOW : 0),
    )
    const before = await handle.stat()
    const source = await handle.readFile('utf8')
    const after = await handle.stat()
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`MCP config changed while reading: ${path}`)
    }
    let value: unknown
    try {
      value = JSON.parse(source)
    } catch (error) {
      throw new Error(`Invalid MCP config JSON: ${path}`, { cause: error })
    }
    if (!isRecord(value))
      throw new Error(`MCP config must be an object: ${path}`)
    return {
      value,
      fingerprint: {
        source,
        device: after.dev,
        inode: after.ino,
        size: after.size,
        modifiedMs: after.mtimeMs,
      },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: {} }
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`MCP config must not be a symbolic link: ${path}`, {
        cause: error,
      })
    }
    throw error
  } finally {
    await handle?.close()
  }
}

async function sourceUnchanged(
  path: string,
  fingerprint: SourceFingerprint | undefined,
): Promise<boolean> {
  const current = await readJsonSource(path, true)
  if (!fingerprint || !current.fingerprint) {
    return fingerprint === current.fingerprint
  }
  return (
    current.fingerprint.source === fingerprint.source &&
    current.fingerprint.device === fingerprint.device &&
    current.fingerprint.inode === fingerprint.inode &&
    current.fingerprint.size === fingerprint.size &&
    current.fingerprint.modifiedMs === fingerprint.modifiedMs
  )
}

async function canonicalTarget(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  return join(await realpath(dirname(path)), basename(path))
}

function serverMap(
  value: Record<string, unknown>,
  path: string,
): Record<string, McpServerConfig> {
  const servers = value.mcpServers
  if (servers === undefined) return {}
  if (!isRecord(servers))
    throw new Error(`MCP config mcpServers must be an object: ${path}`)
  const result: Record<string, McpServerConfig> = {}
  for (const [name, config] of Object.entries(servers)) {
    if (!isRecord(config))
      throw new Error(`MCP server ${name} must be an object: ${path}`)
    result[name] = config
  }
  return result
}

function setServerMap(
  value: Record<string, unknown>,
  servers: Record<string, McpServerConfig>,
): void {
  value.mcpServers = servers
}

function scopedValue(
  root: Record<string, unknown>,
  target: McpTarget,
): Record<string, unknown> {
  if (!target.projectIdentity) return root
  const projects = isRecord(root.projects) ? root.projects : {}
  const project = projects[target.projectIdentity]
  return isRecord(project) ? (project as Record<string, unknown>) : {}
}

function setScopedValue(
  root: Record<string, unknown>,
  target: McpTarget,
  value: Record<string, unknown>,
): void {
  if (!target.projectIdentity) return
  const projects = isRecord(root.projects) ? root.projects : {}
  projects[target.projectIdentity] = value
  root.projects = projects
}

async function mutateJson(
  path: string,
  mutate: (
    value: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
  beforeCommit?: (path: string, attempt: number) => Promise<void>,
): Promise<void> {
  path = await canonicalTarget(path)
  const lease = new ExclusiveFileLease(`${path}.praxis.lock`)
  let handle: ExclusiveFileLeaseHandle | null = null
  for (let attempt = 0; attempt < 400; attempt += 1) {
    handle = await lease.tryAcquire()
    if (handle) break
    await setTimeout(5)
  }
  if (!handle) throw new Error(`MCP config write lock timed out: ${path}`)
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { value, fingerprint } = await readJsonSource(path, true)
      const next = mutate(value)
      if (!next) return
      await beforeCommit?.(path, attempt)
      const committed = await writeFileAtomically(
        path,
        `${JSON.stringify(next, null, 2)}\n`,
        { beforeCommit: () => sourceUnchanged(path, fingerprint) },
      )
      if (committed) return
    }
    throw new Error(`MCP config changed concurrently: ${path}`)
  } finally {
    await handle.release()
  }
}

function projectState(
  root: Record<string, unknown>,
  identity: string,
  path: string,
): Record<string, unknown> {
  if (root.projects !== undefined && !isRecord(root.projects)) {
    throw new Error(`MCP config projects must be an object: ${path}`)
  }
  const projects = root.projects as Record<string, unknown> | undefined
  const project = projects?.[identity]
  if (project !== undefined && !isRecord(project)) {
    throw new Error(`MCP project state must be an object: ${path}`)
  }
  return project ? { ...project } : {}
}

function disabledServerNames(
  project: Record<string, unknown>,
  path: string,
): string[] {
  const disabled = project.disabledMcpServers
  if (disabled === undefined) return []
  if (
    !Array.isArray(disabled) ||
    disabled.some((name) => typeof name !== 'string')
  ) {
    throw new Error(`disabledMcpServers must be a string array: ${path}`)
  }
  return [...disabled]
}

export class ClaudeMcpManagement {
  private readonly dataPlane: DataPlane
  private readonly configRoot: string
  private readonly statePath: string
  private readonly cwd: string
  private readonly beforeCommit?: McpManagementOptions['beforeCommit']

  constructor(options: McpManagementOptions) {
    this.dataPlane = options.dataPlane ?? 'claude'
    this.configRoot = resolve(
      options.configRoot ??
        process.env.CLAUDE_CONFIG_DIR ??
        join(homedir(), '.claude'),
    )
    this.statePath = resolve(
      options.statePath ??
        join(
          this.configRoot,
          this.dataPlane === 'native' ? 'state.json' : '.claude.json',
        ),
    )
    this.cwd = resolve(options.cwd)
    this.beforeCommit = options.beforeCommit
  }

  async list(scope?: McpScope): Promise<McpServerRecord[]> {
    const resources =
      this.dataPlane === 'native'
        ? await loadNativeSharedResources({
            root: this.configRoot,
            cwd: this.cwd,
          })
        : await loadClaudeSharedResources({
            configRoot: this.configRoot,
            cwd: this.cwd,
            settingSources: ['user', 'project', 'local'],
          })
    const records = new Map<string, McpServerRecord>()
    for (const resource of resources.mcp) {
      for (const [name, config] of Object.entries(
        serverMap(resource.value as Record<string, unknown>, resource.path),
      )) {
        records.set(name, {
          name,
          scope: resource.scope,
          path: resource.path,
          config,
        })
      }
    }
    return [...records.values()]
      .filter((record) => scope === undefined || record.scope === scope)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  async get(name: string, scope?: McpScope): Promise<McpServerRecord> {
    const record = (await this.list(scope)).find((item) => item.name === name)
    if (!record) throw new Error(`MCP server not found: ${name}`)
    return record
  }

  async add(
    name: string,
    config: McpServerConfig,
    scope: McpScope = 'local',
  ): Promise<McpServerRecord> {
    this.validateName(name)
    if (!isRecord(config))
      throw new Error('MCP server config must be an object')
    const target = await this.target(scope)
    await mutateJson(
      target.path,
      (root) => {
        const scoped = { ...scopedValue(root, target) }
        const servers = { ...serverMap(scoped, target.path), [name]: config }
        setServerMap(scoped, servers)
        if (!target.projectIdentity) return scoped
        const next = { ...root }
        setScopedValue(next, target, scoped)
        return next
      },
      this.beforeCommit,
    )
    return { name, scope, path: target.path, config }
  }

  async remove(name: string, scope?: McpScope): Promise<McpServerRecord> {
    this.validateName(name)
    const scopes: McpScope[] = scope ? [scope] : ['local', 'project', 'user']
    for (const candidate of scopes) {
      const target = await this.target(candidate)
      let removed: McpServerConfig | undefined
      await mutateJson(
        target.path,
        (root) => {
          const scoped = { ...scopedValue(root, target) }
          const servers = { ...serverMap(scoped, target.path) }
          removed = servers[name]
          if (!removed) return undefined
          delete servers[name]
          setServerMap(scoped, servers)
          if (!target.projectIdentity) return scoped
          const next = { ...root }
          setScopedValue(next, target, scoped)
          return next
        },
        this.beforeCommit,
      )
      if (removed)
        return { name, scope: candidate, path: target.path, config: removed }
    }
    throw new Error(`MCP server not found: ${name}`)
  }

  async resetProjectChoices(): Promise<void> {
    const path = this.statePath
    const identity = await resolveClaudeProjectIdentity({ cwd: this.cwd })
    await mutateJson(
      path,
      (root) => {
        const projects = isRecord(root.projects) ? { ...root.projects } : {}
        const project = isRecord(projects[identity]) ? projects[identity] : {}
        projects[identity] = {
          ...project,
          enabledMcpjsonServers: [],
          disabledMcpjsonServers: [],
        }
        return { ...root, projects }
      },
      this.beforeCommit,
    )
  }

  async disabled(): Promise<readonly string[]> {
    const path = this.statePath
    const identity = await resolveClaudeProjectIdentity({ cwd: this.cwd })
    const root = (await readJsonSource(path, true)).value
    return disabledServerNames(projectState(root, identity, path), path)
  }

  async setEnabled(
    name: string,
    scope: McpScope,
    enabled: boolean,
  ): Promise<void> {
    this.validateName(name)
    await this.get(name, scope)
    const path = this.statePath
    const identity = await resolveClaudeProjectIdentity({ cwd: this.cwd })
    await mutateJson(
      path,
      (root) => {
        const project = projectState(root, identity, path)
        const disabled = disabledServerNames(project, path)
        const next = enabled
          ? disabled.filter((candidate) => candidate !== name)
          : disabled.includes(name)
            ? disabled
            : [...disabled, name]
        if (
          next.length === disabled.length &&
          next.every((candidate, index) => candidate === disabled[index])
        ) {
          return undefined
        }
        const projects = isRecord(root.projects) ? { ...root.projects } : {}
        projects[identity] = { ...project, disabledMcpServers: next }
        return { ...root, projects }
      },
      this.beforeCommit,
    )
  }

  private async target(scope: McpScope): Promise<McpTarget> {
    if (this.dataPlane === 'native') {
      if (scope === 'user') return { path: join(this.configRoot, 'mcp.json') }
      return {
        path: join(
          this.cwd,
          '.praxis',
          scope === 'local' ? 'mcp.local.json' : 'mcp.json',
        ),
      }
    }
    if (scope === 'project') return { path: join(this.cwd, '.mcp.json') }
    const path = this.statePath
    if (scope === 'user') return { path }
    const projectIdentity = await resolveClaudeProjectIdentity({
      cwd: this.cwd,
    })
    return { path, projectIdentity }
  }

  private validateName(name: string): void {
    if (!name || name.trim() !== name)
      throw new Error('MCP server name is required')
  }
}

export function mcpScope(value: string): McpScope {
  if (value !== 'local' && value !== 'project' && value !== 'user') {
    throw new Error('--scope must be one of local, user, project')
  }
  return value
}
