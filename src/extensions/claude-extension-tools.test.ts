import { describe, expect, it, vi } from 'vitest'

import type { ToolRegistry } from '../core/runtime.js'
import { ClaudeExtensionCatalog } from './claude-extensions.js'
import {
  ClaudeExtensionPermissionResolver,
  ClaudeExtensionToolRegistry,
} from './claude-extension-tools.js'

function catalog(disabled = false, extraFrontmatter = '') {
  return new ClaudeExtensionCatalog({
    agents: [],
    commands: [],
    skills: [
      {
        path: '/config/skills/probe/SKILL.md',
        scope: 'user',
        content: `---\nname: probe\ndescription: Probe skill.\ndisable-model-invocation: ${disabled}\n${extraFrontmatter}---\nMARKER [$ARGUMENTS]`,
      },
    ],
  })
}

function baseRegistry(): ToolRegistry {
  return {
    definitions: () => [
      { name: 'Read', description: 'Read.', inputSchema: { type: 'object' } },
    ],
    prepare: vi.fn(async (call) => call),
    execute: vi.fn(async () => ({ content: 'read', isError: false })),
  }
}

describe('ClaudeExtensionToolRegistry', () => {
  it('loads an invocable skill as a native tool result plus user context', async () => {
    const registry = new ClaudeExtensionToolRegistry(baseRegistry(), catalog())
    const call = {
      id: 'call_skill',
      name: 'Skill',
      input: { skill: 'probe', args: 'alpha beta' },
    }

    expect(registry.definitions().map((definition) => definition.name)).toEqual(
      ['Read', 'Skill'],
    )
    await expect(
      registry.prepare(call, { cwd: '/workspace' }),
    ).resolves.toEqual(call)
    await expect(
      registry.execute(call, { cwd: '/workspace' }),
    ).resolves.toEqual({
      content: 'Launching skill: probe',
      isError: false,
      followUpUserMessages: [
        'Base directory for this skill: /config/skills/probe\n\nMARKER [alpha beta]',
      ],
    })
  })

  it('excludes model-disabled skills while retaining built-in commands', () => {
    const registry = new ClaudeExtensionToolRegistry(
      baseRegistry(),
      catalog(true),
    )
    const definitions = registry.definitions()
    expect(definitions.map((definition) => definition.name)).toEqual([
      'Read',
      'Skill',
    ])
    expect(
      definitions.find(({ name }) => name === 'Skill')?.inputSchema,
    ).toMatchObject({
      properties: { skill: { enum: ['loop', 'statusline'] } },
    })
  })
})

describe('ClaudeExtensionPermissionResolver', () => {
  it('auto-allows safe skills after preserving explicit base decisions', async () => {
    const base = {
      resolve: vi.fn(() => ({ behavior: 'ask' as const })),
    }
    const resolver = new ClaudeExtensionPermissionResolver(base, catalog())
    await expect(
      resolver.resolve({
        id: '1',
        name: 'Skill',
        input: { skill: 'probe' },
      }),
    ).resolves.toEqual({ behavior: 'allow' })
    await expect(
      resolver.resolve({ id: '2', name: 'Agent', input: {} }),
    ).resolves.toEqual({ behavior: 'ask' })
  })

  it('asks for skills with privileged properties and keeps deny precedence', async () => {
    const ask = { resolve: vi.fn(() => ({ behavior: 'ask' as const })) }
    const privilegedCatalog = catalog(false, 'allowed-tools: Bash\n')
    await expect(
      new ClaudeExtensionPermissionResolver(ask, privilegedCatalog).resolve({
        id: 'privileged',
        name: 'Skill',
        input: { skill: 'probe' },
      }),
    ).resolves.toMatchObject({
      behavior: 'ask',
      metadata: { command: { name: 'probe', permissionSafe: false } },
    })
    const deny = {
      resolve: vi.fn(() => ({ behavior: 'deny' as const, reason: 'x' })),
    }
    await expect(
      new ClaudeExtensionPermissionResolver(deny, catalog()).resolve({
        id: 'denied',
        name: 'Skill',
        input: { skill: 'probe' },
      }),
    ).resolves.toEqual({ behavior: 'deny', reason: 'x' })
  })
})
