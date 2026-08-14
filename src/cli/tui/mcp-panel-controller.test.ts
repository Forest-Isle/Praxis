import { describe, expect, it, vi } from 'vitest'

import type { McpServerRecord } from '../../mcp/claude-mcp-management.js'
import {
  McpPanelController,
  mcpRuntimeFromSession,
  type TuiMcpRuntimeController,
} from './mcp-panel-controller.js'

const record: McpServerRecord = {
  name: 'fixture',
  scope: 'project',
  path: '/workspace/.mcp.json',
  config: { type: 'stdio', command: 'node' },
}

describe('McpPanelController', () => {
  it('adapts the live interactive session API without a presentation-only copy', async () => {
    const commands = {
      mcpInspect: vi.fn(async () => []),
      mcpReconnect: vi.fn(async () => undefined),
      mcpAuthenticate: vi.fn(async () => undefined),
      mcpReload: vi.fn(async () => undefined),
      mcpTools: vi.fn(async () => []),
    }
    const runtime = mcpRuntimeFromSession(commands)

    await runtime.inspect()
    await runtime.reconnect('fixture')
    await runtime.authenticate('fixture')
    await runtime.reload()
    await runtime.tools('fixture')

    expect(commands.mcpInspect).toHaveBeenCalledOnce()
    expect(commands.mcpReconnect).toHaveBeenCalledWith('fixture')
    expect(commands.mcpAuthenticate).toHaveBeenCalledWith('fixture')
    expect(commands.mcpReload).toHaveBeenCalledOnce()
    expect(commands.mcpTools).toHaveBeenCalledWith('fixture')
  })

  it('loads config and live runtime state through the existing seams', async () => {
    const management = {
      list: vi.fn(async () => [record]),
      disabled: vi.fn(async () => []),
      setEnabled: vi.fn(async () => undefined),
    }
    const runtime: TuiMcpRuntimeController = {
      inspect: vi.fn(async () => [
        { name: 'fixture', status: 'connected' as const, toolCount: 1 },
      ]),
      reconnect: vi.fn(async () => undefined),
      authenticate: vi.fn(async () => undefined),
      reload: vi.fn(async () => undefined),
      tools: vi.fn(async () => []),
    }
    const controller = new McpPanelController({
      cwd: '/workspace',
      management,
      runtime,
    })

    await expect(controller.open()).resolves.toMatchObject({
      servers: [{ name: 'fixture', status: 'connected', toolCount: 1 }],
    })
  })

  it('executes reconnect and enablement through runtime/store before reloading', async () => {
    const calls: string[] = []
    const management = {
      async list() {
        calls.push('list')
        return [record]
      },
      async disabled() {
        calls.push('disabled')
        return []
      },
      async setEnabled(name: string, scope: string, enabled: boolean) {
        calls.push(`set:${name}:${scope}:${enabled}`)
      },
    }
    const runtime: TuiMcpRuntimeController = {
      async inspect() {
        calls.push('inspect')
        return [{ name: 'fixture', status: 'connected' }]
      },
      async reconnect(name) {
        calls.push(`reconnect:${name}`)
      },
      async authenticate(name) {
        calls.push(`authenticate:${name}`)
      },
      async reload() {
        calls.push('reload')
      },
      async tools() {
        return []
      },
    }
    const controller = new McpPanelController({
      cwd: '/workspace',
      management,
      runtime,
    })

    await controller.execute({ type: 'reconnect', name: 'fixture' })
    expect(calls.splice(0)).toEqual([
      'reconnect:fixture',
      'list',
      'disabled',
      'inspect',
    ])
    await controller.execute({ type: 'authenticate', name: 'fixture' })
    expect(calls.splice(0)).toEqual([
      'authenticate:fixture',
      'list',
      'disabled',
      'inspect',
    ])
    await controller.execute({
      type: 'set-enabled',
      name: 'fixture',
      scope: 'project',
      enabled: false,
    })
    expect(calls).toEqual([
      'set:fixture:project:false',
      'reload',
      'list',
      'disabled',
      'inspect',
    ])
  })

  it('loads tools and returns actionable failures without corrupting panel state', async () => {
    const runtimeError = new Error('reconnect failed')
    const runtime: TuiMcpRuntimeController = {
      async inspect() {
        return [{ name: 'fixture', status: 'connected', toolCount: 1 }]
      },
      async reconnect() {
        throw runtimeError
      },
      async authenticate() {},
      async reload() {},
      async tools(name) {
        return [
          {
            name: 'marker',
            fullName: `mcp__${name}__marker`,
            description: 'Fixture marker.',
          },
        ]
      },
    }
    const controller = new McpPanelController({
      cwd: '/workspace',
      management: {
        async list() {
          return [record]
        },
        async disabled() {
          return []
        },
        async setEnabled() {},
      },
      runtime,
    })

    await expect(
      controller.execute({ type: 'view-tools', name: 'fixture' }),
    ).resolves.toMatchObject({
      servers: [
        {
          name: 'fixture',
          tools: [{ fullName: 'mcp__fixture__marker' }],
        },
      ],
    })
    const opened = await controller.open()
    await expect(
      controller.dispatch(
        opened,
        { depth: 'detail', serverIndex: 0, selectedIndex: 0 },
        { type: 'confirm' },
      ),
    ).resolves.toMatchObject({
      state: { depth: 'tools', serverIndex: 0, selectedIndex: 0 },
      model: {
        servers: [{ tools: [{ fullName: 'mcp__fixture__marker' }] }],
      },
      closed: false,
    })
    const operations: string[] = []
    const failedDetail = {
      depth: 'detail',
      serverIndex: 0,
      selectedIndex: 1,
    } as const
    await expect(
      controller.dispatch(
        opened,
        failedDetail,
        { type: 'confirm' },
        (command) => operations.push(command.type),
      ),
    ).resolves.toEqual({
      model: opened,
      state: failedDetail,
      closed: false,
      error: runtimeError.message,
    })
    expect(operations).toEqual(['reconnect'])
  })
})
