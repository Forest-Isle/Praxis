import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ModelToolDefinition, ToolRegistry } from '../core/runtime.js'
import { createPraxisMcpServer } from './praxis-mcp-server.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-server-'))
  roots.push(root)
  return root
}

function textContent(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item): item is { type: 'text'; text: string } =>
      Boolean(
        item &&
        typeof item === 'object' &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string',
      ),
    )
    .map((item) => item.text)
    .join('\n')
}

describe('Praxis MCP stdio server', () => {
  it('advertises and executes the local tool surface over MCP', async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, 'fixture.txt'), 'shared local tool\n')
    await writeFile(
      join(root, 'pixel.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    const hosted = createPraxisMcpServer({ cwd: root })
    const client = new Client({ name: 'fixture-client', version: '1' })
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair()
    await hosted.server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      expect(client.getServerVersion()).toEqual({
        name: 'praxis-agent',
        version: '0.1.0',
      })
      expect(client.getServerCapabilities()).toMatchObject({ tools: {} })
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'Bash',
        'Read',
        'Edit',
        'Write',
        'NotebookEdit',
        'Glob',
        'Grep',
        'ReportFindings',
      ])
      const read = await client.callTool({
        name: 'Read',
        arguments: { file_path: 'fixture.txt' },
      })
      expect(textContent(read)).toContain('shared local tool')
      const image = await client.callTool({
        name: 'Read',
        arguments: { file_path: 'pixel.png' },
      })
      expect(image.content).toEqual([
        expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
      ])
      const unknown = await client.callTool({ name: 'Unknown', arguments: {} })
      expect(unknown).toMatchObject({ isError: true })
      expect(textContent(unknown)).toContain('Unknown tool')
    } finally {
      await client.close()
      await hosted.close()
    }
  })

  it('runs foreground and background Agent calls with TaskOutput', async () => {
    const root = await fixtureRoot()
    const closed = vi.fn()
    const requested: unknown[] = []
    const hosted = createPraxisMcpServer({
      cwd: root,
      createAgentService: async (options) => {
        requested.push(options)
        return {
          run: async (prompt, _signal, _sessionId, name) => ({
            sessionId: `session-${prompt}`,
            text: `${name}:${prompt}`,
          }),
          close: async () => closed(),
        }
      },
    })
    const client = new Client({ name: 'fixture-client', version: '1' })
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair()
    await hosted.server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['Agent', 'TaskOutput']),
      )
      const foreground = await client.callTool({
        name: 'Agent',
        arguments: {
          description: 'Review change',
          prompt: 'foreground',
          subagent_type: 'reviewer',
          model: 'fixture-model',
          run_in_background: false,
        },
      })
      expect(textContent(foreground)).toContain(
        'Review change:foreground\n\nsessionId: session-foreground',
      )
      expect(requested[0]).toMatchObject({
        agent: 'reviewer',
        model: 'fixture-model',
      })

      const background = await client.callTool({
        name: 'Agent',
        arguments: { description: 'Run task', prompt: 'background' },
      })
      const taskId = textContent(background).match(
        /task_id: (agent-[a-f0-9]+)/u,
      )?.[1]
      expect(taskId).toBeDefined()
      const output = await client.callTool({
        name: 'TaskOutput',
        arguments: { task_id: taskId, block: true, timeout: 1000 },
      })
      expect(textContent(output)).toContain(
        'Run task:background\n\nsessionId: session-background',
      )
      expect(closed).toHaveBeenCalledTimes(2)
    } finally {
      await client.close()
      await hosted.close()
    }
  })

  it('redacts provider secrets from MCP tool errors', async () => {
    const root = await fixtureRoot()
    const secret = 'mcp-server-secret-canary'
    vi.stubEnv('PRAXIS_TEST_API_KEY', secret)
    const hosted = createPraxisMcpServer({
      cwd: root,
      createToolRegistry: async () => ({
        definitions: () => [
          {
            name: 'SecretTool',
            description: 'fixture',
            inputSchema: { type: 'object' },
          },
        ],
        prepare: async (call) => call,
        execute: async () => {
          throw new Error(`provider failed: ${secret}`)
        },
      }),
    })
    const client = new Client({ name: 'fixture-client', version: '1' })
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair()
    await hosted.server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const result = await client.callTool({
        name: 'SecretTool',
        arguments: {},
      })
      expect(textContent(result)).toContain('[REDACTED]')
      expect(textContent(result)).not.toContain(secret)
    } finally {
      await client.close()
      await hosted.close()
    }
  })

  it('exposes, executes, and closes the shared CLI tool registry', async () => {
    const root = await fixtureRoot()
    const close = vi.fn(async () => undefined)
    const registry: ToolRegistry & { close(): Promise<void> } = {
      definitions: () => [
        {
          name: 'SharedTool',
          description: 'Shared CLI tool',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
      ],
      prepare: async (call) => call,
      execute: async (call) => ({
        content: `shared:${String(call.input.value)}`,
        isError: false,
      }),
      close,
    }
    const hosted = createPraxisMcpServer({
      cwd: root,
      createToolRegistry: async () => registry,
    })
    const client = new Client({ name: 'fixture-client', version: '1' })
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair()
    await hosted.server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const tools = await client.listTools()
      expect(tools.tools.map((tool) => tool.name)).toContain('SharedTool')
      const result = await client.callTool({
        name: 'SharedTool',
        arguments: { value: 'fixture' },
      })
      expect(textContent(result)).toBe('shared:fixture')
    } finally {
      await client.close()
      await hosted.close()
      await hosted.close()
    }
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uses shared Agent tools when the hosted registry provides them', async () => {
    const root = await fixtureRoot()
    const agentService = vi.fn(async () => ({
      run: async () => ({ sessionId: 'unused', text: 'unused' }),
      close: async () => undefined,
    }))
    const hosted = createPraxisMcpServer({
      cwd: root,
      createAgentService: agentService,
      createToolRegistry: async () => ({
        definitions: () => [
          AGENT_DEFINITION_FIXTURE,
          TASK_OUTPUT_DEFINITION_FIXTURE,
        ],
        prepare: async (call) => call,
        execute: async (call) => ({
          content: `shared:${call.name}`,
          isError: false,
        }),
      }),
    })
    const client = new Client({ name: 'fixture-client', version: '1' })
    const [serverTransport, clientTransport] =
      InMemoryTransport.createLinkedPair()
    await hosted.server.connect(serverTransport)
    await client.connect(clientTransport)

    try {
      const result = await client.callTool({
        name: 'Agent',
        arguments: { description: 'fixture', prompt: 'fixture' },
      })
      expect(textContent(result)).toBe('shared:Agent')
      expect(agentService).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await hosted.close()
    }
  })
})

const AGENT_DEFINITION_FIXTURE: ModelToolDefinition = {
  name: 'Agent',
  description: 'fixture Agent',
  inputSchema: { type: 'object' },
}

const TASK_OUTPUT_DEFINITION_FIXTURE: ModelToolDefinition = {
  name: 'TaskOutput',
  description: 'fixture TaskOutput',
  inputSchema: { type: 'object' },
}
