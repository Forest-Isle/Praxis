import { describe, expect, it } from 'vitest'

import type { ModelToolCall, ToolRegistry } from './runtime.js'
import { resolveToolSchedulingPolicy } from './tool-scheduling-policy.js'

const call: ModelToolCall = { id: 'call', name: 'Read', input: {} }

function registry(
  schedulingPolicy?: ToolRegistry['schedulingPolicy'],
): ToolRegistry {
  return {
    definitions: () => [],
    ...(schedulingPolicy ? { schedulingPolicy } : {}),
    prepare: async (value) => value,
    execute: async () => ({ content: 'ok', isError: false }),
  }
}

describe('resolveToolSchedulingPolicy', () => {
  it('fails closed for missing, throwing, and malformed classifiers', () => {
    expect(resolveToolSchedulingPolicy(registry(), call)).toEqual({
      concurrency: 'exclusive',
    })
    expect(
      resolveToolSchedulingPolicy(
        registry(() => {
          throw new Error('classifier failed')
        }),
        call,
      ),
    ).toEqual({ concurrency: 'exclusive' })
    expect(
      resolveToolSchedulingPolicy(
        registry(() => ({ concurrency: 'invalid' }) as never),
        call,
      ),
    ).toEqual({ concurrency: 'exclusive' })
    expect(
      resolveToolSchedulingPolicy(
        registry(
          () =>
            ({
              concurrency: 'concurrent',
              startAfterAssistant: 'yes',
            }) as never,
        ),
        call,
      ),
    ).toEqual({ concurrency: 'exclusive' })
  })

  it('isolates the classifier from mutations to the provider call', () => {
    const policy = resolveToolSchedulingPolicy(
      registry((candidate) => {
        candidate.input.changed = true
        return { concurrency: 'concurrent' }
      }),
      call,
    )
    expect(policy).toEqual({ concurrency: 'concurrent' })
    expect(call.input).toEqual({})
  })
})
