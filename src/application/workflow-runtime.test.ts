import { describe, expect, it, vi } from 'vitest'

import { executeWorkflowScript } from './workflow-runtime.js'

function host() {
  return {
    total: 1000,
    spent: vi.fn(() => 2),
    log: vi.fn(),
    phase: vi.fn(),
    agent: vi.fn(async (prompt: string) => `result:${prompt}`),
    workflow: vi.fn(async (name: string) => `nested:${name}`),
  }
}

describe('executeWorkflowScript', () => {
  it('runs host calls, args, budget, pipeline, and parallel in the sandbox', async () => {
    const runtimeHost = host()
    const result = await executeWorkflowScript({
      body: `
log('start')
phase('Run')
const piped = await pipeline([1, 2], async (value, original, index) => value + original + index, async value => value + 1)
const joined = await parallel([
  () => agent(args.prompt),
  () => workflow('child', { ok: true }),
  () => { throw new Error('drop') },
])
return { piped, joined, total: budget.total, spent: budget.spent(), remaining: budget.remaining() }`,
      args: { prompt: 'hello' },
      host: runtimeHost,
    })
    expect(result).toEqual({
      piped: [3, 6],
      joined: ['result:hello', 'nested:child', null],
      total: 1000,
      spent: 2,
      remaining: 998,
    })
    expect(runtimeHost.log).toHaveBeenCalledWith('start')
    expect(runtimeHost.phase).toHaveBeenCalledWith('Run')
  })

  it.each(['Date.now()', 'Math.random()', 'new Date()'])(
    'rejects nondeterministic expression %s',
    async (expression) => {
      await expect(
        executeWorkflowScript({
          body: `return ${expression}`,
          args: {},
          host: host(),
        }),
      ).rejects.toThrow('not available in workflows')
    },
  )

  it('aborts infinite guest execution', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      executeWorkflowScript({
        body: 'while (true) {}',
        args: {},
        host: host(),
        signal: controller.signal,
      }),
    ).rejects.toThrow()
  })

  it('exposes undefined args and an unbounded token budget faithfully', async () => {
    const runtimeHost = { ...host(), total: null, spent: vi.fn(() => 7) }
    await expect(
      executeWorkflowScript({
        body: 'return { argsMissing: args === undefined, total: budget.total, unbounded: budget.remaining() === Infinity }',
        args: undefined,
        host: runtimeHost,
      }),
    ).resolves.toEqual({
      argsMissing: true,
      total: null,
      unbounded: true,
    })
  })
})
