import type {
  ClaudeMcpManagement,
  McpScope,
  McpServerRecord,
} from '../../mcp/claude-mcp-management.js'
import type { ClaudeMcpRuntime } from '../../mcp/claude-mcp-tools.js'
import {
  projectTuiMcpPanel,
  reduceTuiMcpPanelState,
  type TuiMcpPanelInput,
  type TuiMcpPanelCommand,
  type TuiMcpPanelModel,
  type TuiMcpPanelState,
} from './mcp-panel-projector.js'

interface TuiMcpManagementController {
  list(): Promise<McpServerRecord[]>
  disabled(): Promise<readonly string[]>
  setEnabled(name: string, scope: McpScope, enabled: boolean): Promise<void>
}

export type TuiMcpRuntimeController = ClaudeMcpRuntime

export class McpPanelController {
  private readonly cwd: string
  private readonly management: TuiMcpManagementController
  private readonly runtime: ClaudeMcpRuntime

  constructor(options: {
    cwd: string
    management: Pick<ClaudeMcpManagement, 'list' | 'disabled' | 'setEnabled'>
    runtime: ClaudeMcpRuntime
  }) {
    this.cwd = options.cwd
    this.management = options.management
    this.runtime = options.runtime
  }

  async open(): Promise<TuiMcpPanelModel> {
    const [records, disabledNames, runtime] = await Promise.all([
      this.management.list(),
      this.management.disabled(),
      this.runtime.inspect(),
    ])
    return projectTuiMcpPanel({
      cwd: this.cwd,
      records,
      disabledNames,
      runtime,
    })
  }

  async execute(command: TuiMcpPanelCommand): Promise<TuiMcpPanelModel | null> {
    if (command.type === 'close') return null
    if (command.type === 'reconnect') {
      await this.runtime.reconnect(command.name)
      return this.open()
    }
    if (command.type === 'authenticate') {
      await this.runtime.authenticate(command.name)
      return this.open()
    }
    if (command.type === 'set-enabled') {
      await this.management.setEnabled(
        command.name,
        command.scope,
        command.enabled,
      )
      await this.runtime.reload()
      return this.open()
    }
    const tools = await this.runtime.tools(command.name)
    const model = await this.open()
    return {
      ...model,
      servers: model.servers.map((server) =>
        server.name === command.name ? { ...server, tools } : server,
      ),
    }
  }

  async dispatch(
    model: TuiMcpPanelModel,
    state: TuiMcpPanelState,
    input: TuiMcpPanelInput,
  ): Promise<{
    model: TuiMcpPanelModel
    state: TuiMcpPanelState
    closed: boolean
  }> {
    const transition = reduceTuiMcpPanelState(model, state, input)
    if (!transition.command) {
      return { model, state: transition.state, closed: false }
    }
    const next = await this.execute(transition.command)
    return {
      model: next ?? model,
      state: transition.state,
      closed: next === null,
    }
  }
}
