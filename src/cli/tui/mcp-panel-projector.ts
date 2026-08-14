import type {
  McpScope,
  McpServerRecord,
} from '../../mcp/claude-mcp-management.js'

export type TuiMcpCapability = 'tools' | 'resources' | 'prompts'
export type TuiMcpServerStatus =
  'connected' | 'failed' | 'disabled' | 'needs-authentication'

export interface TuiMcpTool {
  name: string
  fullName: string
  description?: string
}

export interface TuiMcpRuntimeServer {
  name: string
  status: Exclude<TuiMcpServerStatus, 'disabled'>
  statusDetail?: string
  authDetail?: string
  capabilities?: readonly TuiMcpCapability[]
  toolCount?: number
}

export interface TuiMcpServer {
  name: string
  scope: McpScope
  path: string
  location: string
  status: TuiMcpServerStatus
  statusDetail: string
  authDetail?: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args: readonly string[]
  url?: string
  capabilities: readonly TuiMcpCapability[]
  toolCount: number
  tools?: readonly TuiMcpTool[]
}

export interface TuiMcpPanelModel {
  cwd: string
  servers: readonly TuiMcpServer[]
}

export type TuiMcpPanelDepth = 'list' | 'detail' | 'tools' | 'tool'

export interface TuiMcpPanelState {
  depth: TuiMcpPanelDepth
  serverIndex: number
  selectedIndex: number
}

export type TuiMcpPanelInput =
  | { type: 'up' | 'down' | 'confirm' | 'back' }
  | { type: 'select'; index: number }

export type TuiMcpPanelCommand =
  | { type: 'close' }
  | { type: 'view-tools'; name: string }
  | { type: 'reconnect'; name: string }
  | { type: 'authenticate'; name: string }
  | {
      type: 'set-enabled'
      name: string
      scope: McpScope
      enabled: boolean
    }

export interface TuiMcpPanelTransition {
  state: TuiMcpPanelState
  command?: TuiMcpPanelCommand
}

const SCOPE_ORDER: Record<McpScope, number> = {
  project: 0,
  local: 1,
  user: 2,
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function transport(
  config: Readonly<Record<string, unknown>>,
): TuiMcpServer['transport'] {
  if (config.type === 'sse') return 'sse'
  return config.type === 'http' || typeof config.url === 'string'
    ? 'http'
    : 'stdio'
}

export function projectTuiMcpPanel({
  cwd,
  records,
  disabledNames,
  runtime,
}: {
  cwd: string
  records: readonly McpServerRecord[]
  disabledNames: readonly string[]
  runtime: readonly TuiMcpRuntimeServer[]
}): TuiMcpPanelModel {
  const disabled = new Set(disabledNames)
  const runtimeByName = new Map(runtime.map((server) => [server.name, server]))
  const servers = records
    .map((record): TuiMcpServer => {
      const active = runtimeByName.get(record.name)
      const status: TuiMcpServerStatus = disabled.has(record.name)
        ? 'disabled'
        : (active?.status ?? 'failed')
      const selectedTransport = transport(record.config)
      const command = stringValue(record.config.command)
      const url = stringValue(record.config.url)
      return {
        name: record.name,
        scope: record.scope,
        path: record.path,
        location:
          record.scope === 'local'
            ? `${record.path} [project: ${cwd}]`
            : record.path,
        status,
        statusDetail:
          status === 'disabled'
            ? '◯ disabled'
            : status === 'needs-authentication'
              ? '△ needs authentication'
              : status === 'connected'
                ? `done: ${active?.statusDetail ?? 'connected'}`
                : `failed: ${active?.statusDetail ?? 'failed'}`,
        ...(active?.authDetail ? { authDetail: active.authDetail } : {}),
        transport: selectedTransport,
        ...(selectedTransport === 'stdio' && command ? { command } : {}),
        ...(selectedTransport !== 'stdio' && url ? { url } : {}),
        args: stringArray(record.config.args),
        capabilities: active?.capabilities ?? [],
        toolCount: active?.toolCount ?? 0,
      }
    })
    .sort(
      (left, right) =>
        SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope] ||
        left.location.localeCompare(right.location) ||
        left.name.localeCompare(right.name),
    )
  return { cwd, servers }
}

export function initialTuiMcpPanelState(
  model: TuiMcpPanelModel,
): TuiMcpPanelState {
  return {
    depth: 'list',
    serverIndex: bounded(0, model.servers.length),
    selectedIndex: 0,
  }
}

export function tuiMcpServerActions(
  server: TuiMcpServer,
): readonly TuiMcpPanelCommand[] {
  if (server.status === 'disabled') {
    return [
      {
        type: 'set-enabled',
        name: server.name,
        scope: server.scope,
        enabled: true,
      },
    ]
  }
  if (server.status === 'needs-authentication') {
    return [
      { type: 'authenticate', name: server.name },
      {
        type: 'set-enabled',
        name: server.name,
        scope: server.scope,
        enabled: false,
      },
    ]
  }
  return [
    ...(server.status === 'connected' && server.toolCount > 0
      ? [{ type: 'view-tools' as const, name: server.name }]
      : []),
    { type: 'reconnect' as const, name: server.name },
    {
      type: 'set-enabled' as const,
      name: server.name,
      scope: server.scope,
      enabled: false,
    },
  ]
}

function bounded(index: number, length: number): number {
  return Math.min(Math.max(0, index), Math.max(0, length - 1))
}

export function reduceTuiMcpPanelState(
  model: TuiMcpPanelModel,
  state: TuiMcpPanelState,
  input: TuiMcpPanelInput,
): TuiMcpPanelTransition {
  const serverIndex = bounded(state.serverIndex, model.servers.length)
  const server = model.servers[serverIndex]
  const normalized = { ...state, serverIndex }
  if (input.type === 'back') {
    if (state.depth === 'list') {
      return { state: normalized, command: { type: 'close' } }
    }
    if (state.depth === 'detail') {
      return { state: { depth: 'list', serverIndex, selectedIndex: 0 } }
    }
    if (state.depth === 'tools') {
      return { state: { depth: 'detail', serverIndex, selectedIndex: 0 } }
    }
    return { state: { depth: 'tools', serverIndex, selectedIndex: 0 } }
  }
  if (!server) return { state: normalized }

  if (state.depth === 'list') {
    if (input.type === 'confirm') {
      return {
        state: { depth: 'detail', serverIndex, selectedIndex: 0 },
      }
    }
    const offset = input.type === 'up' ? -1 : input.type === 'down' ? 1 : 0
    const requested =
      input.type === 'select' ? input.index : serverIndex + offset
    return {
      state: {
        depth: 'list',
        serverIndex: bounded(requested, model.servers.length),
        selectedIndex: 0,
      },
    }
  }

  if (state.depth === 'detail') {
    const actions = tuiMcpServerActions(server)
    const selectedIndex = bounded(state.selectedIndex, actions.length)
    if (input.type === 'confirm') {
      const command = actions[selectedIndex]
      if (command?.type === 'view-tools') {
        return {
          state: { depth: 'tools', serverIndex, selectedIndex: 0 },
          command,
        }
      }
      return command
        ? { state: { ...normalized, selectedIndex }, command }
        : { state: { ...normalized, selectedIndex } }
    }
    const offset = input.type === 'up' ? -1 : input.type === 'down' ? 1 : 0
    const requested =
      input.type === 'select' ? input.index : selectedIndex + offset
    return {
      state: {
        ...normalized,
        selectedIndex: bounded(requested, actions.length),
      },
    }
  }

  if (state.depth === 'tool') return { state: normalized }

  const tools = server.tools ?? []
  const selectedIndex = bounded(state.selectedIndex, tools.length)
  if (state.depth === 'tools' && input.type === 'confirm' && tools.length > 0) {
    return { state: { depth: 'tool', serverIndex, selectedIndex } }
  }
  const offset = input.type === 'up' ? -1 : input.type === 'down' ? 1 : 0
  const requested =
    input.type === 'select' ? input.index : selectedIndex + offset
  return {
    state: {
      ...normalized,
      selectedIndex: bounded(requested, tools.length),
    },
  }
}
