import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadClaudeSharedResources } from '../compatibility/claude/shared-resources.js'
import type { ToolRegistry } from '../core/runtime.js'
import {
  ClaudeMcpManagement,
  filterDisabledMcpResources,
} from './claude-mcp-management.js'
import { ClaudeMcpToolRegistry } from './claude-mcp-tools.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeMcpManagement', () => {
  it('writes and reads native user, project, and local scopes under Praxis paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-native-mcp-management-'))
    roots.push(root)
    const configRoot = join(root, 'praxis')
    const cwd = join(root, 'project')
    const management = new ClaudeMcpManagement({
      dataPlane: 'native',
      configRoot,
      cwd,
    })

    await management.add('user', { command: 'user' }, 'user')
    await management.add('project', { command: 'project' }, 'project')
    await management.add('local', { command: 'local' }, 'local')
    await management.setEnabled('project', 'project', false)

    await expect(management.list()).resolves.toEqual([
      expect.objectContaining({ name: 'local', scope: 'local' }),
      expect.objectContaining({ name: 'project', scope: 'project' }),
      expect.objectContaining({ name: 'user', scope: 'user' }),
    ])
    await expect(
      readFile(join(configRoot, 'mcp.json'), 'utf8'),
    ).resolves.toContain('"user"')
    await expect(
      readFile(join(cwd, '.praxis', 'mcp.json'), 'utf8'),
    ).resolves.toContain('"project"')
    await expect(
      readFile(join(cwd, '.praxis', 'mcp.local.json'), 'utf8'),
    ).resolves.toContain('"local"')
    await expect(management.disabled()).resolves.toEqual(['project'])
    await expect(
      readFile(join(configRoot, 'state.json'), 'utf8'),
    ).resolves.toContain('disabledMcpServers')
    await expect(
      readFile(join(configRoot, '.claude.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes disabled effective servers from the live registry and restores them on enable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const serverScript = join(root, 'server.mjs')
    await mkdir(cwd, { recursive: true })
    await writeFile(
      serverScript,
      `let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  while (buffer.includes('\\n')) {
    const newline = buffer.indexOf('\\n')
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    const result = request.method === 'initialize'
      ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'management-fixture', version: '1' } }
      : request.method === 'tools/list'
        ? { tools: [{ name: 'marker', description: 'marker', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: 'ok' }] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
  }
})
`,
    )
    const management = new ClaudeMcpManagement({ configRoot, cwd })
    await management.add(
      'effective',
      { command: process.execPath, args: [serverScript, 'user'] },
      'user',
    )
    await management.add('effective', {
      command: process.execPath,
      args: [serverScript, 'local'],
    })
    await expect(management.get('effective')).resolves.toMatchObject({
      scope: 'local',
    })
    const runtimeResources = async () =>
      filterDisabledMcpResources(
        (await loadClaudeSharedResources({ configRoot, cwd })).mcp,
        await management.disabled(),
      )
    const base: ToolRegistry = {
      definitions: () => [],
      prepare: async (call) => call,
      execute: async () => ({ content: '', isError: false }),
    }
    const registry = await ClaudeMcpToolRegistry.connect({
      base,
      cwd,
      configRoot,
      resources: await runtimeResources(),
      reloadResources: runtimeResources,
    })
    try {
      expect(registry.definitions().map(({ name }) => name)).toEqual([
        'mcp__effective__marker',
      ])

      await management.setEnabled('effective', 'local', false)
      await registry.reload()
      expect(registry.definitions()).toEqual([])
      await expect(registry.tools('effective')).rejects.toThrow(
        'Unknown MCP server effective',
      )

      await management.setEnabled('effective', 'local', true)
      await registry.reload()
      expect(registry.definitions().map(({ name }) => name)).toEqual([
        'mcp__effective__marker',
      ])
      await expect(registry.tools('effective')).resolves.toMatchObject([
        { name: 'marker', fullName: 'mcp__effective__marker' },
      ])
    } finally {
      await registry.close()
    }
  })

  it('writes Claude-compatible local/project/user scopes and preserves unknown state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const management = new ClaudeMcpManagement({ configRoot, cwd })

    await mkdir(configRoot, { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(
      join(configRoot, '.claude.json'),
      JSON.stringify({ machineID: 'keep', projects: {} }),
    )
    await management.add('local', { type: 'stdio', command: 'local' })
    await management.add(
      'project',
      { type: 'http', url: 'https://example.com/mcp' },
      'project',
    )
    await management.add('user', { type: 'stdio', command: 'user' }, 'user')

    await expect(management.list()).resolves.toEqual([
      expect.objectContaining({ name: 'local', scope: 'local' }),
      expect.objectContaining({ name: 'project', scope: 'project' }),
      expect.objectContaining({ name: 'user', scope: 'user' }),
    ])
    expect(await readFile(join(configRoot, '.claude.json'), 'utf8')).toContain(
      '"machineID": "keep"',
    )
    expect(await readFile(join(cwd, '.mcp.json'), 'utf8')).toContain(
      'https://example.com/mcp',
    )
  })

  it('uses nearest-scope precedence and removes only the selected scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const management = new ClaudeMcpManagement({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
    })
    await management.add('shared', { type: 'stdio', command: 'user' }, 'user')
    await management.add('shared', { type: 'stdio', command: 'local' })
    await expect(management.get('shared')).resolves.toMatchObject({
      scope: 'local',
      config: { command: 'local' },
    })
    await management.remove('shared', 'local')
    await expect(management.get('shared')).resolves.toMatchObject({
      scope: 'user',
      config: { command: 'user' },
    })
  })

  it('resets project MCP approval choices without deleting servers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    await new ClaudeMcpManagement({ configRoot, cwd }).add('fixture', {
      type: 'stdio',
      command: 'node',
    })
    const statePath = join(configRoot, '.claude.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const identity = Object.keys(state.projects)[0]
    if (!identity) throw new Error('Missing MCP project identity')
    state.projects[identity].enabledMcpjsonServers = ['fixture']
    state.projects[identity].disabledMcpjsonServers = ['other']
    await writeFile(statePath, JSON.stringify(state))

    await new ClaudeMcpManagement({ configRoot, cwd }).resetProjectChoices()
    const updated = JSON.parse(await readFile(statePath, 'utf8'))
    expect(updated.projects[identity]).toMatchObject({
      mcpServers: { fixture: { command: 'node', type: 'stdio' } },
      enabledMcpjsonServers: [],
      disabledMcpjsonServers: [],
    })
  })

  it('disables user, project, and local servers without deleting definitions or unknown state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const management = new ClaudeMcpManagement({ configRoot, cwd })
    await management.add('user-server', { command: 'user' }, 'user')
    await management.add('project-server', { command: 'project' }, 'project')
    await management.add('local-server', { command: 'local' }, 'local')
    const statePath = join(configRoot, '.claude.json')
    const before = JSON.parse(await readFile(statePath, 'utf8'))
    before.unknown = { keep: true }
    await writeFile(statePath, JSON.stringify(before))

    await management.setEnabled('user-server', 'user', false)
    await management.setEnabled('project-server', 'project', false)
    await management.setEnabled('local-server', 'local', false)

    expect(await management.disabled()).toEqual([
      'user-server',
      'project-server',
      'local-server',
    ])
    const disabled = JSON.parse(await readFile(statePath, 'utf8'))
    expect(disabled.unknown).toEqual({ keep: true })
    expect(disabled.mcpServers['user-server']).toEqual({ command: 'user' })
    const identity = Object.keys(disabled.projects)[0]
    if (!identity) throw new Error('Missing MCP project identity')
    expect(disabled.projects[identity].mcpServers['local-server']).toEqual({
      command: 'local',
    })
    expect(
      JSON.parse(await readFile(join(cwd, '.mcp.json'), 'utf8')).mcpServers[
        'project-server'
      ],
    ).toEqual({ command: 'project' })

    await management.setEnabled('project-server', 'project', true)
    expect(await management.disabled()).toEqual(['user-server', 'local-server'])
  })

  it('preserves concurrent disabled-server updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const management = new ClaudeMcpManagement({
      configRoot: join(root, 'config'),
      cwd: join(root, 'project'),
    })
    await management.add('one', { command: 'one' })
    await management.add('two', { command: 'two' })

    await Promise.all([
      management.setEnabled('one', 'local', false),
      management.setEnabled('two', 'local', false),
    ])

    expect(new Set(await management.disabled())).toEqual(
      new Set(['one', 'two']),
    )
  })

  it('retries a commit fingerprint conflict and preserves the external writer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const initial = new ClaudeMcpManagement({ configRoot, cwd })
    await initial.add('fixture', { command: 'node' })
    let raced = false
    const management = new ClaudeMcpManagement({
      configRoot,
      cwd,
      beforeCommit: async (path, attempt) => {
        if (raced || attempt !== 0) return
        raced = true
        const current = JSON.parse(await readFile(path, 'utf8'))
        await writeFile(path, JSON.stringify({ ...current, external: 'keep' }))
      },
    })

    await management.setEnabled('fixture', 'local', false)

    const state = JSON.parse(
      await readFile(join(configRoot, '.claude.json'), 'utf8'),
    )
    expect(state.external).toBe('keep')
    expect(await management.disabled()).toEqual(['fixture'])
  })

  it('uses one canonical lease for config-root path aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const aliasRoot = join(root, 'config-alias')
    const cwd = join(root, 'project')
    await mkdir(configRoot, { recursive: true })
    await symlink(configRoot, aliasRoot)
    const direct = new ClaudeMcpManagement({ configRoot, cwd })
    const alias = new ClaudeMcpManagement({ configRoot: aliasRoot, cwd })

    await Promise.all([
      direct.add('one', { command: 'one' }, 'user'),
      alias.add('two', { command: 'two' }, 'user'),
    ])

    expect(
      new Set((await direct.list('user')).map(({ name }) => name)),
    ).toEqual(new Set(['one', 'two']))
  })

  it('fails closed on corrupt state and unsafe state-file symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-mcp-management-'))
    roots.push(root)
    const configRoot = join(root, 'config')
    const cwd = join(root, 'project')
    const statePath = join(configRoot, '.claude.json')
    const management = new ClaudeMcpManagement({ configRoot, cwd })
    await management.add('fixture', { command: 'node' }, 'project')
    await mkdir(configRoot, { recursive: true })
    await writeFile(statePath, '{invalid')
    await expect(
      management.setEnabled('fixture', 'project', false),
    ).rejects.toThrow()
    await expect(readFile(statePath, 'utf8')).resolves.toBe('{invalid')

    const external = join(root, 'external.json')
    await writeFile(
      external,
      JSON.stringify({
        mcpServers: { fixture: { command: 'node' } },
        projects: {},
      }),
    )
    await rm(statePath)
    await symlink(external, statePath)
    await expect(management.disabled()).rejects.toThrow('symbolic link')
    await expect(readFile(external, 'utf8')).resolves.toContain('fixture')
  })
})
