import { describe, expect, it } from 'vitest'

import { injectFirstUserMessageContext } from './context.js'

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
