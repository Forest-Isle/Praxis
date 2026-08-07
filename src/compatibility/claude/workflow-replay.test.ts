import { describe, expect, it } from 'vitest'

import {
  workflowReplayDescriptor,
  workflowReplayKey,
} from './workflow-replay.js'

describe('workflow replay identity', () => {
  it('matches Claude v2 chained replay keys and canonicalizes options', () => {
    const first = workflowReplayKey('P0')
    expect(first).toBe(
      'v2:8cb48efd10ba515c873fbaa3762384198b6c850c61e7ce05e8c16e342e6e1799',
    )
    expect(workflowReplayKey('P0', {}, first)).toBe(
      'v2:7f8f9a0b8fc028cb45d5aed858181c40dd3cc583a966fa73ece75cc40df1ff80',
    )
    expect(workflowReplayKey('P1', {}, first)).toBe(
      'v2:e79773bad244a9b1d1228d1f9e50d701f4f0779df69cf1e4fe6652ce86b4cbac',
    )
    expect(
      workflowReplayDescriptor('P0', {
        schema: {
          required: ['value'],
          type: 'object',
          properties: { value: { type: 'string' } },
        },
        effort: 'low',
      }),
    ).toBe(
      workflowReplayDescriptor('P0', {
        effort: 'low',
        schema: {
          properties: { value: { type: 'string' } },
          type: 'object',
          required: ['value'],
        },
      }),
    )
    expect(
      workflowReplayKey('P0', {
        schema: {
          required: ['value'],
          type: 'object',
          properties: { value: { type: 'string' } },
        },
        effort: 'low',
      }),
    ).toBe(
      workflowReplayKey('P0', {
        effort: 'low',
        schema: {
          properties: { value: { type: 'string' } },
          type: 'object',
          required: ['value'],
        },
      }),
    )
    expect(
      workflowReplayKey('P0', {
        schema: JSON.parse('{"type":"object","__proto__":{"type":"string"}}'),
      }),
    ).not.toBe(workflowReplayKey('P0', { schema: { type: 'object' } }))
  })
})
