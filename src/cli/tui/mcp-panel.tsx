import { Box, Text } from 'ink'

import {
  tuiMcpServerActions,
  type TuiMcpPanelCommand,
  type TuiMcpPanelModel,
  type TuiMcpPanelState,
  type TuiMcpServer,
} from './mcp-panel-projector.js'
import type { TuiMcpSurfaceModel } from './mcp-surface-model.js'

const SCOPE_LABELS = {
  project: 'Project MCPs',
  local: 'Local MCPs',
  user: 'User MCPs',
} as const

function capitalized(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function serverStatus(server: TuiMcpServer): string {
  if (server.status === 'connected') {
    return `✔  connected${
      server.toolCount > 0
        ? ` · ${server.toolCount} ${server.toolCount === 1 ? 'tool' : 'tools'}`
        : ''
    }`
  }
  if (server.status === 'needs-authentication') {
    return '△  needs authentication'
  }
  return server.status === 'failed' ? '✘  failed' : '◯  disabled'
}

function actionLabel(command: TuiMcpPanelCommand): string {
  if (command.type === 'view-tools') return 'View tools'
  if (command.type === 'reconnect') return 'Reconnect'
  if (command.type === 'authenticate') return 'Authenticate'
  if (command.type === 'set-enabled') {
    return command.enabled ? 'Enable' : 'Disable'
  }
  return 'Close'
}

function ListPanel({
  model,
  state,
  screenReader,
}: {
  model: TuiMcpPanelModel
  state: TuiMcpPanelState
  screenReader: boolean
}) {
  return (
    <Box flexDirection="column">
      <Text bold>Manage MCP servers</Text>
      <Text>
        {model.servers.length}{' '}
        {model.servers.length === 1 ? 'server' : 'servers'}
      </Text>
      {(['project', 'local', 'user'] as const).flatMap((scope) => {
        const scoped = model.servers
          .map((server, index) => ({ server, index }))
          .filter(({ server }) => server.scope === scope)
        if (scoped.length === 0) return null
        const locations = [
          ...new Set(scoped.map(({ server }) => server.location)),
        ]
        return locations.map((location) => (
          <Box
            key={`${scope}:${location}`}
            flexDirection="column"
            marginTop={1}
          >
            <Text>
              {SCOPE_LABELS[scope]} {'  '}({location})
            </Text>
            {scoped
              .filter(({ server }) => server.location === location)
              .map(({ server, index }) => {
                const selected = index === state.serverIndex
                return (
                  <Text
                    key={`${scope}:${server.name}`}
                    inverse={!screenReader && selected}
                  >
                    {screenReader && selected
                      ? 'Selected server: '
                      : selected
                        ? '❯  '
                        : '   '}
                    {server.name} {' · '}
                    {serverStatus(server)}
                  </Text>
                )
              })}
          </Box>
        ))
      })}
      <Text>※ Run praxis --debug to see error logs</Text>
      <Text dimColor>↑/↓ to navigate · Enter to confirm · Esc to cancel</Text>
    </Box>
  )
}

function DetailPanel({
  server,
  state,
  screenReader,
}: {
  server: TuiMcpServer
  state: TuiMcpPanelState
  screenReader: boolean
}) {
  const actions = tuiMcpServerActions(server)
  return (
    <Box flexDirection="column">
      <Text bold>{capitalized(server.name)} MCP Server</Text>
      <Text>Status: {server.statusDetail}</Text>
      {server.authDetail ? <Text>Auth: {server.authDetail}</Text> : null}
      {server.transport === 'stdio' ? (
        <>
          <Text>Command: {server.command ?? ''}</Text>
          {server.args.length > 0 ? (
            <Text>Args: {server.args.join(' ')}</Text>
          ) : null}
        </>
      ) : (
        <Text>URL: {server.url ?? ''}</Text>
      )}
      <Text>Config location: {server.location}</Text>
      {server.status === 'connected' && server.capabilities.length > 0 ? (
        <Text>Capabilities: {' ' + server.capabilities.join(' · ')}</Text>
      ) : null}
      {server.status === 'connected' && server.toolCount > 0 ? (
        <Text>{`Tools:  ${server.toolCount} ${
          server.toolCount === 1 ? 'tool' : 'tools'
        }`}</Text>
      ) : null}
      {actions.map((action, index) => (
        <Text
          key={`${action.type}:${index}`}
          inverse={!screenReader && index === state.selectedIndex}
        >
          {screenReader && index === state.selectedIndex
            ? 'Selected action: '
            : `${index + 1}. `}
          {actionLabel(action)}
        </Text>
      ))}
      <Text>Enter selection [1-{actions.length}], or Escape to cancel:</Text>
      <Text dimColor>↑/↓ to navigate · Enter to select · Esc to back</Text>
    </Box>
  )
}

function ToolsPanel({
  server,
  state,
  screenReader,
}: {
  server: TuiMcpServer
  state: TuiMcpPanelState
  screenReader: boolean
}) {
  const tools = server.tools ?? []
  return (
    <Box flexDirection="column">
      <Text bold>Tools for {server.name}</Text>
      <Text>
        {tools.length} {tools.length === 1 ? 'tool' : 'tools'}
      </Text>
      {tools.map((tool, index) => (
        <Text
          key={tool.fullName}
          inverse={!screenReader && index === state.selectedIndex}
        >
          {screenReader && index === state.selectedIndex
            ? 'Selected tool: '
            : `${index + 1}. `}
          {tool.name}
        </Text>
      ))}
      <Text>Enter selection [1-{tools.length}], or Escape to cancel:</Text>
      <Text dimColor>↑/↓ to navigate · Enter to select · Esc to back</Text>
    </Box>
  )
}

function ToolPanel({
  server,
  state,
}: {
  server: TuiMcpServer
  state: TuiMcpPanelState
}) {
  const tool = server.tools?.[state.selectedIndex]
  if (!tool) return null
  return (
    <Box flexDirection="column">
      <Text bold>{tool.name}</Text>
      <Text>{server.name}</Text>
      <Text>Tool name: {' ' + tool.name}</Text>
      <Text>Full name: {' ' + tool.fullName}</Text>
      <Text>Description:</Text>
      <Text>{tool.description ?? ''}</Text>
      <Text dimColor>Esc to go back</Text>
    </Box>
  )
}

export function McpPanel({
  surface,
  screenReader = false,
  width,
}: {
  surface: TuiMcpSurfaceModel
  screenReader?: boolean
  width?: number
}) {
  const { model, state } = surface
  const terminalWidth = width ?? 80
  const server = model.servers[state.serverIndex]
  let content
  if (model.servers.length === 0)
    content = (
      <Text>
        No MCP servers configured. Run praxis doctor if this is unexpected — it
        lists MCP config files that failed validation.
      </Text>
    )
  else if (!server) content = null
  else if (state.depth === 'detail') {
    content = (
      <DetailPanel server={server} state={state} screenReader={screenReader} />
    )
  } else if (state.depth === 'tools') {
    content = (
      <ToolsPanel server={server} state={state} screenReader={screenReader} />
    )
  } else if (state.depth === 'tool') {
    content = <ToolPanel server={server} state={state} />
  } else {
    content = (
      <ListPanel model={model} state={state} screenReader={screenReader} />
    )
  }
  return (
    <Box flexDirection="column" width={terminalWidth}>
      {content}
    </Box>
  )
}
