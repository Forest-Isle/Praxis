import { describe, expect, it, vi } from 'vitest'

import type { ToolRegistry } from '../core/runtime.js'
import { ClaudeExtensionCatalog } from './claude-extensions.js'
import {
  ClaudeExtensionPermissionResolver,
  ClaudeExtensionToolRegistry,
} from './claude-extension-tools.js'

function catalog(disabled = false) {
  return new ClaudeExtensionCatalog({
    agents: [],
    commands: [],
    skills: [
      {
        path: '/config/skills/probe/SKILL.md',
        scope: 'user',
        content: `---\nname: probe\ndescription: Probe skill.\ndisable-model-invocation: ${disabled}\n---\nMARKER [$ARGUMENTS]`,
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

  it('does not expose model-disabled skills', () => {
    const registry = new ClaudeExtensionToolRegistry(
      baseRegistry(),
      catalog(true),
    )
    expect(registry.definitions().map((definition) => definition.name)).toEqual(
      ['Read'],
    )
  })
})

describe('ClaudeExtensionPermissionResolver', () => {
  it('allows Skill and delegates other tools', async () => {
    const base = {
      resolve: vi.fn(() => ({ behavior: 'deny' as const, reason: 'x' })),
    }
    const resolver = new ClaudeExtensionPermissionResolver(base)
    expect(resolver.resolve({ id: '1', name: 'Skill', input: {} })).toEqual({
      behavior: 'allow',
    })
    expect(resolver.resolve({ id: '2', name: 'Read', input: {} })).toEqual({
      behavior: 'deny',
      reason: 'x',
    })
  })
})
