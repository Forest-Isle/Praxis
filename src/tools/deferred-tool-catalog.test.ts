import { describe, expect, it, vi } from 'vitest'

import type {
  ModelToolCall,
  ModelToolDefinition,
  ToolRegistry,
} from '../core/runtime.js'
import { DeferredToolCatalog } from './deferred-tool-catalog.js'

const definition = (name: string, description = name): ModelToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object' },
})

function base(
  definitions: readonly ModelToolDefinition[] = [
    definition('Read', 'read files'),
    definition('mcp__search', 'search project documents'),
    definition('mcp__deploy', 'deploy an app'),
  ],
): ToolRegistry {
  return {
    definitions: () => definitions,
    schedulingPolicy: () => ({ concurrency: 'concurrent' }),
    prepare: async (call) => ({ ...call, input: { prepared: true } }),
    execute: async () => ({ content: 'delegated', isError: false }),
  }
}

const search = (
  registry: ToolRegistry,
  query: unknown,
  input: Record<string, unknown> = { query },
) =>
  registry.execute(
    { id: 'search', name: 'ToolSearch', input },
    { cwd: '/workspace' },
  )

describe('DeferredToolCatalog', () => {
  it('matches names and descriptions in deterministic rank and base order', async () => {
    const registry = new DeferredToolCatalog(
      base([
        definition('Read'),
        definition('mcp__third', 'project search documents'),
        definition('mcp__project_search', 'other'),
        definition('mcp__project', 'search documents'),
      ]),
    ).startTurn()

    expect(registry.definitions().map(({ name }) => name)).toEqual([
      'Read',
      'ToolSearch',
    ])
    await expect(search(registry, 'project search')).resolves.toMatchObject({
      isError: false,
    })
    expect(registry.definitions().map(({ name }) => name)).toEqual([
      'Read',
      'mcp__third',
      'mcp__project_search',
      'mcp__project',
      'ToolSearch',
    ])
  })

  it('activates at most eight matches and keeps repeated searches idempotent', async () => {
    const registry = new DeferredToolCatalog(
      base([
        definition('Read'),
        ...Array.from({ length: 10 }, (_, index) =>
          definition(`mcp__fixture__${index}`, 'shared catalog match'),
        ),
      ]),
    ).startTurn()

    const first = await search(registry, 'shared match')
    const second = await search(registry, 'shared match')
    const names = registry.definitions().map(({ name }) => name)

    expect(first.content).toContain('Activated')
    expect(second.content).toContain('Already active')
    expect(names.filter((name) => name.startsWith('mcp__'))).toHaveLength(8)
    expect(new Set(names).size).toBe(names.length)

    const mixed = new DeferredToolCatalog(
      base([
        definition('mcp__alpha', 'alpha beta match'),
        definition('mcp__beta', 'alpha beta match'),
      ]),
    ).startTurn()
    await search(mixed, 'mcp__alpha')
    const mixedResult = await search(mixed, 'alpha beta')
    expect(mixedResult.content).toContain('Activated: mcp__beta')
    expect(mixedResult.content).toContain('Already active: mcp__alpha')
  })

  it('bounds Unicode queries, summaries, and total search output by code point', async () => {
    const longDescription = '😀'.repeat(300)
    const summaryRegistry = new DeferredToolCatalog(
      base([definition('mcp__unicode', `unicode-match ${longDescription}`)]),
    ).startTurn()
    const summaryResult = await search(summaryRegistry, 'unicode-match')
    expect(summaryResult.content).toContain(`${'😀'.repeat(223)}...`)

    const longDefinitions = Array.from({ length: 8 }, (_, index) =>
      definition(`mcp__${'名'.repeat(550)}_${index}`, 'unicode-match'),
    )
    const registry = new DeferredToolCatalog(base(longDefinitions)).startTurn()

    const result = await search(registry, 'unicode-match')
    expect(Array.from(result.content)).toHaveLength(4096)
    expect(result.content).toContain('next model request')

    const unicodeQuery = new DeferredToolCatalog(base()).startTurn()
    await expect(search(unicodeQuery, '😀'.repeat(256))).resolves.toMatchObject(
      {
        isError: false,
      },
    )
    await expect(search(unicodeQuery, '😀'.repeat(257))).resolves.toMatchObject(
      {
        isError: true,
      },
    )
  })

  it('rejects invalid searches without activation', async () => {
    const registry = new DeferredToolCatalog(base()).startTurn()

    for (const input of [
      { query: '' },
      { query: '   ' },
      { query: 1 },
      { query: 'search', extra: true },
      {},
    ]) {
      await expect(search(registry, undefined, input)).resolves.toMatchObject({
        isError: true,
      })
    }
    expect(registry.definitions().map(({ name }) => name)).toEqual([
      'Read',
      'ToolSearch',
    ])
  })

  it('fails closed before activation and delegates every interface afterward', async () => {
    const schedulingPolicy = vi.fn(() => ({
      concurrency: 'concurrent' as const,
    }))
    const prepare = vi.fn(async (call: ModelToolCall) => ({
      ...call,
      input: { prepared: true },
    }))
    const execute = vi.fn(async () => ({
      content: 'delegated',
      isError: false,
    }))
    const registry = new DeferredToolCatalog({
      ...base(),
      schedulingPolicy,
      prepare,
      execute,
    }).startTurn()
    const call = { id: 'mcp', name: 'mcp__search', input: {} }

    expect(() => registry.schedulingPolicy?.(call)).toThrow(
      'call ToolSearch first',
    )
    await expect(registry.prepare(call, { cwd: '/workspace' })).rejects.toThrow(
      'call ToolSearch first',
    )
    await expect(registry.execute(call, { cwd: '/workspace' })).rejects.toThrow(
      'call ToolSearch first',
    )

    await search(registry, 'search')
    expect(registry.schedulingPolicy?.(call)).toEqual({
      concurrency: 'concurrent',
    })
    await expect(
      registry.prepare(call, { cwd: '/workspace' }),
    ).resolves.toMatchObject({ input: { prepared: true } })
    await expect(
      registry.execute(call, { cwd: '/workspace' }),
    ).resolves.toEqual({ content: 'delegated', isError: false })
    expect(schedulingPolicy).toHaveBeenCalledWith(call)
    expect(prepare).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  })

  it('restores known MCP tools and isolates activation between turns', async () => {
    const catalog = new DeferredToolCatalog(base())
    const restored = catalog.startTurn({
      restoredToolNames: ['mcp__search', 'Unknown', 'Read', 'ToolSearch'],
    })

    expect(restored.definitions().map(({ name }) => name)).toEqual([
      'Read',
      'mcp__search',
      'ToolSearch',
    ])
    await search(restored, 'deploy')
    expect(
      catalog
        .startTurn()
        .definitions()
        .map(({ name }) => name),
    ).toEqual(['Read', 'ToolSearch'])
  })

  it('preserves the base registry when disabled or when no MCP tools exist', () => {
    const duplicateMcp = base([
      definition('mcp__same'),
      definition('mcp__same'),
    ])
    const duplicateLocal = base([definition('Read'), definition('Read')])

    expect(
      new DeferredToolCatalog(duplicateMcp).startTurn({ enabled: false }),
    ).toBe(duplicateMcp)
    expect(new DeferredToolCatalog(duplicateLocal).startTurn()).toBe(
      duplicateLocal,
    )
    expect(() => new DeferredToolCatalog(duplicateMcp).startTurn()).toThrow(
      'Duplicate tool definition',
    )
    expect(() =>
      new DeferredToolCatalog(
        base([definition('ToolSearch'), definition('mcp__fixture')]),
      ).startTurn(),
    ).toThrow('Tool definition collision')
  })
})
