import { describe, expect, it } from 'vitest'

import {
  createContextSnapshot,
  injectFirstUserMessageContext,
  projectContextSnapshot,
} from './context.js'

describe('injectFirstUserMessageContext', () => {
  it('prefixes only the first user message and preserves attachments', () => {
    const images = [
      { type: 'image' as const, mediaType: 'image/png' as const, data: 'AA==' },
    ]
    expect(
      injectFirstUserMessageContext(
        [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'first', images },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'second' },
        ],
        'dynamic',
      ),
    ).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'dynamic\n\nfirst', images },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ])
  })

  it('adds a user context message when no user message exists', () => {
    expect(
      injectFirstUserMessageContext(
        [{ role: 'system', content: 'system' }],
        'dynamic',
      ),
    ).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'dynamic' },
    ])
  })
})

describe('canonical context snapshots', () => {
  it('projects ordered system, first-user, and stable-prefix data', () => {
    const snapshot = createContextSnapshot([
      { id: 'static', content: 'S', placement: 'system', stability: 'static' },
      {
        id: 'user-a',
        content: 'A',
        placement: 'first-user',
        stability: 'session',
      },
      {
        id: 'volatile',
        content: 'V',
        placement: 'system',
        stability: 'volatile',
      },
      {
        id: 'user-b',
        content: 'B',
        placement: 'first-user',
        stability: 'session',
      },
    ])
    expect(projectContextSnapshot(snapshot)).toEqual({
      systemMessages: [
        { role: 'system', content: 'S' },
        { role: 'system', content: 'V' },
      ],
      firstUserMessageContext: 'A\n\nB',
      stableSystemSectionCount: 1,
    })
  })

  it('rejects duplicate ids and non-volatile sections after volatile system context', () => {
    expect(() =>
      createContextSnapshot([
        { id: 'x', content: 'x', placement: 'system', stability: 'volatile' },
        { id: 'y', content: 'y', placement: 'system', stability: 'session' },
      ]),
    ).toThrow('Non-volatile system sections')
    expect(() =>
      createContextSnapshot([
        { id: 'x', content: 'x', placement: 'system', stability: 'session' },
        { id: 'x', content: 'x', placement: 'system', stability: 'session' },
      ]),
    ).toThrow('Duplicate context section')
    expect(() =>
      projectContextSnapshot({
        sections: [
          {
            id: 'external',
            content: '   ',
            placement: 'system',
            stability: 'session',
          },
        ],
      }),
    ).toThrow('Context section external content is required')
  })
})
