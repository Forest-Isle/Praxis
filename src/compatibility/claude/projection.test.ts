import { describe, expect, it } from 'vitest'

import { getClaudeLastPrompt, projectClaudeTextMessages } from './projection.js'

describe('Claude transcript projection', () => {
  it('projects only user and assistant text without leaking protocol metadata', () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: 'hello' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 'ignored' },
          ],
        },
      },
      {
        type: 'last-prompt',
        lastPrompt: 'hello',
        sessionId: 'session',
        leafUuid: 'leaf',
      },
    ]

    expect(projectClaudeTextMessages(entries)).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'answer' },
    ])
    expect(getClaudeLastPrompt(entries)).toBe('hello')
  })
})
