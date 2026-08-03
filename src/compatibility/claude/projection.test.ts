import { describe, expect, it } from 'vitest'

import {
  getClaudeLastPrompt,
  projectClaudeModelMessages,
  projectClaudeTextMessages,
} from './projection.js'

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

  it('projects native tool use and results into provider-neutral messages', () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: 'inspect' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            {
              type: 'tool_use',
              id: 'call_read',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_read',
              content: '# Praxis',
              is_error: false,
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ]

    expect(projectClaudeModelMessages(entries)).toEqual([
      { role: 'user', content: 'inspect' },
      {
        role: 'assistant',
        content: 'checking',
        toolCalls: [
          {
            id: 'call_read',
            name: 'Read',
            input: { file_path: 'README.md' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_read',
        content: '# Praxis',
        isError: false,
      },
      { role: 'assistant', content: 'done' },
    ])
  })
})
