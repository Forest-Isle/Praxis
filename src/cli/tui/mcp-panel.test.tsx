import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import type { McpServerRecord } from '../../mcp/claude-mcp-management.js'
import { McpPanel } from './mcp-panel.js'
import {
  initialTuiMcpPanelState,
  projectTuiMcpPanel,
  reduceTuiMcpPanelState,
  type TuiMcpPanelModel,
} from './mcp-panel-projector.js'

interface McpFixture {
  version: string
  captureFile: string
  captureSha256: string
  terminal: { columns: number; lines: number; screenReader: boolean }
  empty: { message: string }
  list: Record<string, string | string[]>
  detail: Record<string, string | string[]>
  tools: Record<string, string | string[]>
}

const fixtureUrl = new URL(
  '../../../test/fixtures/claude-code/2.1.208/mcp-tui.json',
  import.meta.url,
)
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as McpFixture
const capture = await readFile(new URL(fixture.captureFile, fixtureUrl), 'utf8')

const records: McpServerRecord[] = [
  {
    name: 'broken',
    scope: 'project',
    path: '/workspace/.mcp.json',
    config: { type: 'stdio', command: '/missing' },
  },
  {
    name: 'connected',
    scope: 'project',
    path: '/workspace/.mcp.json',
    config: { type: 'stdio', command: 'node', args: ['server.mjs'] },
  },
  {
    name: 'local-server',
    scope: 'local',
    path: '/config/.claude.json',
    config: { type: 'stdio', command: 'node', args: ['local.mjs'] },
  },
  {
    name: 'user-server',
    scope: 'user',
    path: '/config/.claude.json',
    config: { type: 'http', url: 'https://example.test/mcp' },
  },
]

const model = projectTuiMcpPanel({
  cwd: '/workspace',
  records,
  disabledNames: ['local-server'],
  runtime: [
    { name: 'broken', status: 'failed', statusDetail: 'failed' },
    {
      name: 'connected',
      status: 'connected',
      capabilities: ['tools', 'resources', 'prompts'],
      toolCount: 1,
    },
    { name: 'user-server', status: 'connected', toolCount: 1 },
  ],
})

describe('McpPanel', () => {
  it('binds every fixture field to the immutable 2.1.208 raw capture', () => {
    expect(createHash('sha256').update(capture).digest('hex')).toBe(
      fixture.captureSha256,
    )
    expect(capture).toContain(`Claude Code v${fixture.version}`)
    expect(fixture.terminal).toEqual({
      columns: 100,
      lines: 32,
      screenReader: true,
    })
    for (const section of [
      fixture.empty,
      fixture.list,
      fixture.detail,
      fixture.tools,
    ]) {
      for (const value of Object.values(section).flat()) {
        expect(capture).toContain(value)
      }
    }
  })

  it('matches the observed Claude 2.1.208 populated list contract', async () => {
    const app = render(
      <McpPanel
        model={model}
        state={initialTuiMcpPanelState(model)}
        screenReader={fixture.terminal.screenReader}
        width={fixture.terminal.columns}
      />,
    )
    const frame = app.lastFrame() ?? ''

    expect(frame).toContain(fixture.list.title)
    expect(frame).toContain(fixture.list.count)
    for (const group of fixture.list.groups as string[]) {
      expect(frame).toContain(group)
    }
    expect(frame).toContain(fixture.list.connected)
    expect(frame).toContain(fixture.list.failed)
    expect(frame).toContain(fixture.list.disabled)
    expect(frame).toContain(fixture.list.diagnostic)
    expect(frame).toContain(fixture.list.help)
    expect(frame).toContain(fixture.list.footer)
    expect(frame).toContain('Selected server: broken')
    expect(frame).not.toContain('❯')
  })

  it('renders the observed empty result without inventing management actions', async () => {
    const empty: TuiMcpPanelModel = { cwd: '/workspace', servers: [] }
    const app = render(
      <McpPanel model={empty} state={initialTuiMcpPanelState(empty)} />,
    )

    expect(app.lastFrame()?.replace(/\s+/gu, ' ')).toContain(
      fixture.empty.message,
    )
    expect(app.lastFrame()).not.toContain('Reconnect')
    expect(app.lastFrame()).not.toContain('Disable')
  })

  it('renders server status, transport detail, capabilities, and real actions', () => {
    const connected = render(
      <McpPanel
        model={model}
        state={{ depth: 'detail', serverIndex: 1, selectedIndex: 0 }}
      />,
    ).lastFrame()
    expect(connected).toContain('Connected MCP Server')
    expect(connected).toContain(fixture.detail.connectedStatus)
    expect(connected).toContain('Command: node')
    expect(connected).toContain('Args: server.mjs')
    expect(connected).toContain('Capabilities:  tools · resources · prompts')
    expect(connected).toContain('Tools:  1 tool')
    expect(connected).toContain('1. View tools')
    expect(connected).toContain('2. Reconnect')
    expect(connected).toContain('3. Disable')

    const failed = render(
      <McpPanel
        model={model}
        state={{ depth: 'detail', serverIndex: 0, selectedIndex: 0 }}
      />,
    ).lastFrame()
    expect(failed).toContain(fixture.detail.failedStatus)
    expect(failed).not.toContain('View tools')

    const disabled = render(
      <McpPanel
        model={model}
        state={{ depth: 'detail', serverIndex: 2, selectedIndex: 0 }}
      />,
    ).lastFrame()
    expect(disabled).toContain(fixture.detail.disabledStatus)
    expect(disabled).toContain('1. Enable')
    expect(disabled).not.toContain('Reconnect')

    const http = render(
      <McpPanel
        model={model}
        state={{ depth: 'detail', serverIndex: 3, selectedIndex: 0 }}
      />,
    ).lastFrame()
    expect(http).toContain('URL: https://example.test/mcp')

    const authenticationModel = projectTuiMcpPanel({
      cwd: '/workspace',
      records: [
        {
          name: 'oauth-required',
          scope: 'project',
          path: '/workspace/.mcp.json',
          config: { type: 'http', url: 'http://127.0.0.1:18988/mcp' },
        },
      ],
      disabledNames: [],
      runtime: [
        {
          name: 'oauth-required',
          status: 'needs-authentication',
          authDetail: 'failed: not authenticated',
        },
      ],
    })
    const authentication = render(
      <McpPanel
        model={authenticationModel}
        state={{ depth: 'detail', serverIndex: 0, selectedIndex: 0 }}
        screenReader
      />,
    ).lastFrame()
    const authenticationList = render(
      <McpPanel
        model={authenticationModel}
        state={initialTuiMcpPanelState(authenticationModel)}
      />,
    ).lastFrame()
    expect(authenticationList).toContain(fixture.list.needsAuthentication)
    expect(authentication).toContain(fixture.detail.needsAuthenticationStatus)
    expect(authentication).toContain(fixture.detail.authenticationDetail)
    expect(authentication).toContain('Selected action: Authenticate')
    expect(authentication).toContain('2. Disable')
    expect(authentication).not.toContain('Reconnect')
    expect(authentication).not.toContain('❯')
  })

  it('uses the runtime-backed tool list and detail surfaces', () => {
    const withTools: TuiMcpPanelModel = {
      ...model,
      servers: model.servers.map((server) =>
        server.name === 'connected'
          ? {
              ...server,
              tools: [
                {
                  name: 'marker',
                  fullName: 'mcp__connected__marker',
                  description: 'Returns the fixture marker.',
                },
              ],
            }
          : server,
      ),
    }
    const tools = render(
      <McpPanel
        model={withTools}
        state={{ depth: 'tools', serverIndex: 1, selectedIndex: 0 }}
        screenReader
      />,
    ).lastFrame()
    expect(tools).toContain(`${fixture.tools.titlePrefix}connected`)
    expect(tools).toContain('1 tool')
    expect(tools).toContain('Selected tool: marker')
    expect(tools).not.toContain('❯')

    const detail = render(
      <McpPanel
        model={withTools}
        state={{ depth: 'tool', serverIndex: 1, selectedIndex: 0 }}
      />,
    ).lastFrame()
    for (const label of fixture.tools.detailLabels as string[]) {
      expect(detail).toContain(label)
    }
    expect(detail).toContain('Tool name:  marker')
    expect(detail).toContain('Full name:  mcp__connected__marker')
    expect(detail).toContain('Returns the fixture marker.')
    expect(detail).toContain(fixture.tools.footer)
  })

  it('returns one level at a time and cancels only from the server list', () => {
    const list = initialTuiMcpPanelState(model)
    const detail = reduceTuiMcpPanelState(model, list, { type: 'confirm' })
    expect(detail).toEqual({
      state: { depth: 'detail', serverIndex: 0, selectedIndex: 0 },
    })
    expect(
      reduceTuiMcpPanelState(model, detail.state, { type: 'back' }),
    ).toEqual({ state: list })
    expect(
      reduceTuiMcpPanelState(
        model,
        { depth: 'tools', serverIndex: 1, selectedIndex: 0 },
        { type: 'back' },
      ),
    ).toEqual({
      state: { depth: 'detail', serverIndex: 1, selectedIndex: 0 },
    })
    expect(
      reduceTuiMcpPanelState(
        model,
        { depth: 'tool', serverIndex: 1, selectedIndex: 0 },
        { type: 'back' },
      ),
    ).toEqual({
      state: { depth: 'tools', serverIndex: 1, selectedIndex: 0 },
    })
    const toolDetailModel: TuiMcpPanelModel = {
      ...model,
      servers: model.servers.map((server, index) =>
        index === 1
          ? {
              ...server,
              tools: [
                { name: 'one', fullName: 'mcp__connected__one' },
                { name: 'two', fullName: 'mcp__connected__two' },
              ],
            }
          : server,
      ),
    }
    expect(
      reduceTuiMcpPanelState(
        toolDetailModel,
        { depth: 'tool', serverIndex: 1, selectedIndex: 0 },
        { type: 'down' },
      ),
    ).toEqual({
      state: { depth: 'tool', serverIndex: 1, selectedIndex: 0 },
    })
    expect(reduceTuiMcpPanelState(model, list, { type: 'back' })).toEqual({
      state: list,
      command: { type: 'close' },
    })
  })

  it('emits runtime/store commands instead of mutating visual status', () => {
    const detail = {
      depth: 'detail',
      serverIndex: 1,
      selectedIndex: 0,
    } as const
    expect(reduceTuiMcpPanelState(model, detail, { type: 'confirm' })).toEqual({
      state: { ...detail, depth: 'tools' },
      command: { type: 'view-tools', name: 'connected' },
    })
    expect(
      reduceTuiMcpPanelState(
        model,
        { ...detail, selectedIndex: 2 },
        { type: 'confirm' },
      ),
    ).toEqual({
      state: { ...detail, selectedIndex: 2 },
      command: {
        type: 'set-enabled',
        name: 'connected',
        scope: 'project',
        enabled: false,
      },
    })
    expect(model.servers[1]?.status).toBe('connected')

    const authenticationModel = projectTuiMcpPanel({
      cwd: '/workspace',
      records: [
        {
          name: 'oauth-required',
          scope: 'project',
          path: '/workspace/.mcp.json',
          config: { type: 'http', url: 'https://example.test/mcp' },
        },
      ],
      disabledNames: [],
      runtime: [{ name: 'oauth-required', status: 'needs-authentication' }],
    })
    expect(
      reduceTuiMcpPanelState(
        authenticationModel,
        { depth: 'detail', serverIndex: 0, selectedIndex: 0 },
        { type: 'confirm' },
      ).command,
    ).toEqual({ type: 'authenticate', name: 'oauth-required' })
  })

  it('bounds selection and wraps long locations within narrow terminals', () => {
    const state = reduceTuiMcpPanelState(
      model,
      { depth: 'list', serverIndex: 99, selectedIndex: 0 },
      { type: 'down' },
    ).state
    expect(state.serverIndex).toBe(3)

    const frame =
      render(<McpPanel model={model} state={state} width={40} />).lastFrame() ??
      ''
    expect(frame).toContain('Manage MCP servers')
    expect(frame).toContain('/config/.claude.json')
    expect(
      Math.max(...frame.split('\n').map((line) => line.length)),
    ).toBeLessThanOrEqual(40)
  })

  it('groups project servers by location and infers URL-only HTTP transports', () => {
    const grouped = projectTuiMcpPanel({
      cwd: '/workspace/child',
      disabledNames: [],
      records: [
        {
          name: 'parent',
          scope: 'project',
          path: '/workspace/.mcp.json',
          config: { url: 'https://example.test/mcp' },
        },
        {
          name: 'child',
          scope: 'project',
          path: '/workspace/child/.mcp.json',
          config: { command: 'node' },
        },
      ],
      runtime: [],
    })
    expect(grouped.servers[0]).toMatchObject({
      name: 'parent',
      transport: 'http',
      url: 'https://example.test/mcp',
    })
    const frame =
      render(
        <McpPanel model={grouped} state={initialTuiMcpPanelState(grouped)} />,
      ).lastFrame() ?? ''
    expect(frame.match(/Project MCPs/gu)).toHaveLength(2)
    expect(frame).toContain('/workspace/.mcp.json')
    expect(frame).toContain('/workspace/child/.mcp.json')
  })
})
