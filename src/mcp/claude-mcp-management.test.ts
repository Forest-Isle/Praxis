import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ClaudeMcpManagement } from './claude-mcp-management.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

describe('ClaudeMcpManagement', () => {
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
})
