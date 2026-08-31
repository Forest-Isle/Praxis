import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import type { McpServerRecord } from '../../mcp/claude-mcp-management.js'
import {
  initialTuiMcpPanelState,
  projectTuiMcpPanel,
  reduceTuiMcpPanelState,
  tuiMcpServerActions,
  type TuiMcpRuntimeServer,
  type TuiMcpServer,
} from './mcp-panel-projector.js'
import { McpPanel } from './mcp-panel.js'
import { projectTuiMcpSurface } from './mcp-surface-model.js'

type Fixture = {
  schemaVersion: number
  cwd: string
  records: McpServerRecord[]
  disabledNames: string[]
  runtime: TuiMcpRuntimeServer[]
  tools: { name: string; fullName: string; description: string }[]
  expected: {
    serverOrder: string[]
    statuses: Record<string, string>
    locations: Record<string, string>
    actions: Record<string, string[]>
    commands: Record<string, object>
    frames: {
      list: string[]
      detailStdio: string[]
      detailHttpAuth: string[]
      tools: string[]
      tool: string[]
      empty: string[]
      screenReader: string[]
    }
  }
}

const fixture = JSON.parse(
  readFileSync(
    resolve(process.cwd(), 'test/fixtures/native/tui/mcp-panel.json'),
    'utf8',
  ),
) as Fixture

function frame(
  model: ReturnType<typeof projectTuiMcpPanel>,
  state: ReturnType<typeof initialTuiMcpPanelState>,
  screenReader = false,
) {
  return render(
    <McpPanel
      surface={projectTuiMcpSurface({ model, state })}
      screenReader={screenReader}
      width={100}
    />,
  ).lastFrame()
}

function serverNamed(servers: readonly TuiMcpServer[], name: string) {
  const server = servers.find((candidate) => candidate.name === name)
  if (!server) throw new Error(`Missing fixture server: ${name}`)
  return server
}

describe('McpPanel native fixture', () => {
  it('projects, navigates, and renders every MCP panel state', () => {
    const model = projectTuiMcpPanel(fixture)
    const connected = model.servers.find(
      (server) => server.name === 'connected-project',
    )
    expect(model.servers.map((server) => server.name)).toEqual(
      fixture.expected.serverOrder,
    )
    expect(
      Object.fromEntries(
        model.servers.map((server) => [server.name, server.status]),
      ),
    ).toEqual(fixture.expected.statuses)
    expect(
      Object.fromEntries(
        model.servers.map((server) => [server.name, server.location]),
      ),
    ).toEqual(fixture.expected.locations)
    expect(model.servers.map((server) => server.statusDetail)).toEqual([
      'done: ready',
      'failed: failed',
      '△ needs authentication',
      '◯ disabled',
    ])
    expect(connected).toBeDefined()
    const modelWithTools = {
      ...model,
      servers: model.servers.map((server) =>
        server.name === 'connected-project'
          ? { ...server, tools: fixture.tools }
          : server,
      ),
    }

    for (const server of modelWithTools.servers) {
      expect(tuiMcpServerActions(server).map((action) => action.type)).toEqual(
        fixture.expected.actions[server.name],
      )
    }
    expect(
      tuiMcpServerActions(
        serverNamed(modelWithTools.servers, 'connected-project'),
      )[0],
    ).toEqual(fixture.expected.commands.viewTools)
    expect(
      tuiMcpServerActions(
        serverNamed(modelWithTools.servers, 'failed-project'),
      )[0],
    ).toEqual(fixture.expected.commands.reconnect)
    expect(
      tuiMcpServerActions(serverNamed(modelWithTools.servers, 'auth-local'))[0],
    ).toEqual(fixture.expected.commands.authenticate)
    expect(
      tuiMcpServerActions(
        serverNamed(modelWithTools.servers, 'connected-project'),
      )[2],
    ).toEqual(fixture.expected.commands.disable)
    expect(
      tuiMcpServerActions(
        serverNamed(modelWithTools.servers, 'disabled-user'),
      )[0],
    ).toEqual(fixture.expected.commands.enable)

    let state = initialTuiMcpPanelState(modelWithTools)
    expect(state).toEqual({ depth: 'list', serverIndex: 0, selectedIndex: 0 })
    expect(
      reduceTuiMcpPanelState(modelWithTools, state, {
        type: 'select',
        index: -10,
      }).state.serverIndex,
    ).toBe(0)
    expect(
      reduceTuiMcpPanelState(modelWithTools, state, {
        type: 'select',
        index: 99,
      }).state.serverIndex,
    ).toBe(3)
    state = reduceTuiMcpPanelState(modelWithTools, state, {
      type: 'confirm',
    }).state
    expect(state.depth).toBe('detail')
    state = reduceTuiMcpPanelState(
      modelWithTools,
      { ...state, selectedIndex: 99 },
      { type: 'select', index: 99 },
    ).state
    expect(state.selectedIndex).toBe(2)
    expect(
      reduceTuiMcpPanelState(modelWithTools, state, { type: 'confirm' })
        .command,
    ).toEqual(fixture.expected.commands.disable)
    state = { depth: 'list', serverIndex: 0, selectedIndex: 0 }
    state = reduceTuiMcpPanelState(modelWithTools, state, {
      type: 'confirm',
    }).state
    expect(
      reduceTuiMcpPanelState(modelWithTools, state, { type: 'confirm' }).state
        .depth,
    ).toBe('tools')
    state = { depth: 'tools', serverIndex: 0, selectedIndex: 0 }
    expect(
      reduceTuiMcpPanelState(modelWithTools, state, { type: 'confirm' }).state
        .depth,
    ).toBe('tool')
    state = { depth: 'tool', serverIndex: 0, selectedIndex: 0 }
    state = reduceTuiMcpPanelState(modelWithTools, state, {
      type: 'back',
    }).state
    expect(state.depth).toBe('tools')
    state = reduceTuiMcpPanelState(modelWithTools, state, {
      type: 'back',
    }).state
    expect(state.depth).toBe('detail')
    state = reduceTuiMcpPanelState(modelWithTools, state, {
      type: 'back',
    }).state
    expect(state.depth).toBe('list')
    expect(
      reduceTuiMcpPanelState(modelWithTools, state, { type: 'back' }).command,
    ).toEqual({ type: 'close' })

    const listFrame = frame(modelWithTools, {
      depth: 'list',
      serverIndex: 0,
      selectedIndex: 0,
    })
    for (const fragment of fixture.expected.frames.list)
      expect(listFrame).toContain(fragment)
    const detailFrame = frame(modelWithTools, {
      depth: 'detail',
      serverIndex: 0,
      selectedIndex: 0,
    })
    for (const fragment of fixture.expected.frames.detailStdio)
      expect(detailFrame).toContain(fragment)
    const authFrame = frame(modelWithTools, {
      depth: 'detail',
      serverIndex: 2,
      selectedIndex: 0,
    })
    for (const fragment of fixture.expected.frames.detailHttpAuth)
      expect(authFrame).toContain(fragment)
    const toolsFrame = frame(modelWithTools, {
      depth: 'tools',
      serverIndex: 0,
      selectedIndex: 0,
    })
    for (const fragment of fixture.expected.frames.tools)
      expect(toolsFrame).toContain(fragment)
    const toolFrame = frame(modelWithTools, {
      depth: 'tool',
      serverIndex: 0,
      selectedIndex: 0,
    })
    for (const fragment of fixture.expected.frames.tool)
      expect(toolFrame).toContain(fragment)
    const empty = projectTuiMcpPanel({
      ...fixture,
      records: [],
      runtime: [],
      disabledNames: [],
    })
    const emptyFrame = frame(empty, initialTuiMcpPanelState(empty))
    for (const fragment of fixture.expected.frames.empty)
      expect(emptyFrame).toContain(fragment)
    const reader = frame(
      modelWithTools,
      { depth: 'list', serverIndex: 0, selectedIndex: 0 },
      true,
    )
    expect(reader).toContain('Selected server: connected-project')
    expect(reader).not.toContain('❯')
    expect(
      frame(
        modelWithTools,
        { depth: 'detail', serverIndex: 0, selectedIndex: 0 },
        true,
      ),
    ).toContain('Selected action: View tools')
    expect(
      frame(
        modelWithTools,
        { depth: 'tools', serverIndex: 0, selectedIndex: 0 },
        true,
      ),
    ).toContain('Selected tool: search')
  })
})
