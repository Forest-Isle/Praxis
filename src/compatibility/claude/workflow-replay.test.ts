import { describe, expect, it } from 'vitest'

import {
  workflowReplayDescriptor,
  workflowReplayKey,
} from './workflow-replay.js'

describe('workflow replay identity', () => {
  it('keeps the existing Praxis key and canonicalizes nested schema order', () => {
    expect(workflowReplayKey('P0')).toBe(
      'v2:ab65645c7b2fd2c95e66d234ab5c89970c6884138180792a5843110e7c774ed3',
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
  })
})
