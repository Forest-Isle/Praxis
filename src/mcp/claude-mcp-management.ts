import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { writeFileAtomically } from '../platform/atomic-write.js'
import {
  loadClaudeSharedResources,
  resolveClaudeProjectIdentity,
  type ClaudeResourceScope,
} from '../compatibility/claude/shared-resources.js'

export type McpScope = ClaudeResourceScope
export type McpServerConfig = Record<string, unknown>

export interface McpServerRecord {
  name: string
  scope: McpScope
  path: string
  config: McpServerConfig
}

interface McpManagementOptions {
  configRoot?: string
  cwd: string
}

interface McpTarget {
  path: string
  projectIdentity?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    throw new Error(`Invalid MCP config JSON: ${path}`, { cause: error })
  }
  if (!isRecord(value)) throw new Error(`MCP config must be an object: ${path}`)
  return value
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

async function writeJson(
  path: string,
  value: Record<string, unknown>,
): Promise<void> {
  const committed = await writeFileAtomically(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
  )
  if (!committed) throw new Error(`MCP config write was interrupted: ${path}`)
}

export class ClaudeMcpManagement {
  private readonly configRoot: string
  private readonly cwd: string

  constructor(options: McpManagementOptions) {
    this.configRoot = resolve(
      options.configRoot ??
        process.env.CLAUDE_CONFIG_DIR ??
        join(homedir(), '.claude'),
    )
    this.cwd = resolve(options.cwd)
  }

  async list(scope?: McpScope): Promise<McpServerRecord[]> {
    const resources = await loadClaudeSharedResources({
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
    const root = await readJson(target.path)
    const scoped = scopedValue(root, target)
    const servers = serverMap(scoped, target.path)
    servers[name] = config
    setServerMap(scoped, servers)
    setScopedValue(root, target, scoped)
    await writeJson(target.path, root)
    return { name, scope, path: target.path, config }
  }

  async remove(name: string, scope?: McpScope): Promise<McpServerRecord> {
    this.validateName(name)
    const scopes: McpScope[] = scope ? [scope] : ['local', 'project', 'user']
    for (const candidate of scopes) {
      const target = await this.target(candidate)
      const root = await readJson(target.path)
      const scoped = scopedValue(root, target)
      const servers = serverMap(scoped, target.path)
      const config = servers[name]
      if (!config) continue
      delete servers[name]
      setServerMap(scoped, servers)
      setScopedValue(root, target, scoped)
      await writeJson(target.path, root)
      return { name, scope: candidate, path: target.path, config }
    }
    throw new Error(`MCP server not found: ${name}`)
  }

  async resetProjectChoices(): Promise<void> {
    const path = join(this.configRoot, '.claude.json')
    const root = await readJson(path)
    const identity = await resolveClaudeProjectIdentity({ cwd: this.cwd })
    const projects = isRecord(root.projects) ? root.projects : {}
    const project = isRecord(projects[identity]) ? projects[identity] : {}
    project.enabledMcpjsonServers = []
    project.disabledMcpjsonServers = []
    projects[identity] = project
    root.projects = projects
    await writeJson(path, root)
  }

  private async target(scope: McpScope): Promise<McpTarget> {
    if (scope === 'project') return { path: join(this.cwd, '.mcp.json') }
    const path = join(this.configRoot, '.claude.json')
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
