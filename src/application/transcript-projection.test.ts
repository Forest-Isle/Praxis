import { describe, expect, it } from 'vitest'
import {
  activeEvents,
  projectActiveMessages,
  projectTranscriptDisplay,
  lastUserPrompt,
} from './transcript-projection.js'
import type { TranscriptEvent } from '../core/transcript-event.js'

const base = { sessionId: 's', timestamp: '2026-08-23T00:00:00.000Z' }
const msg = (id: string, parentId: string | null, content: string) => ({
  kind: 'messages' as const,
  ...base,
  id,
  parentId,
  messages: [{ role: 'user' as const, content }],
})
describe('transcript projection', () => {
  it('selects newest leaf and preserves parent order', () => {
    const events = [
      msg('root', null, 'root'),
      msg('old', 'root', 'old'),
      { ...msg('new', 'root', 'new'), timestamp: '2026-08-23T00:01:00.000Z' },
    ]
    expect(activeEvents(events).map((event) => event.id)).toEqual([
      'root',
      'new',
    ])
    expect(lastUserPrompt(events)).toBe('new')
  })
  it('supports checkpoint and projects compact/tool items once', () => {
    const events = [
      msg('root', null, 'ask'),
      {
        ...base,
        kind: 'context-summary' as const,
        id: 'summary',
        parentId: 'root',
        summary: 'prior',
      },
      {
        ...base,
        kind: 'messages' as const,
        id: 'answer',
        parentId: 'summary',
        messages: [
          {
            role: 'assistant' as const,
            content: 'ok',
            thinkingBlocks: [
              {
                type: 'thinking' as const,
                thinking: 'think',
                signature: 'sig',
              },
            ],
            toolCalls: [{ id: 'c', name: 'x', input: {} }],
          },
          {
            role: 'tool' as const,
            toolCallId: 'c',
            content: 'done',
            isError: false,
          },
        ],
      },
    ]
    expect(
      projectTranscriptDisplay(events, 'answer').map((item) => item.kind),
    ).toEqual([
      'user',
      'compact',
      'thinking',
      'assistant',
      'tool',
      'tool-result',
    ])
    expect(() => activeEvents(events, 'missing')).toThrow(
      'Unknown transcript checkpoint',
    )
  })

  it('ignores durable tool execution claims in model projection', () => {
    const events = [
      msg('root', null, 'ask'),
      {
        ...base,
        kind: 'tool-execution-started' as const,
        id: 'claim',
        parentId: 'root',
        callId: 'call',
      },
    ]
    expect(
      projectActiveMessages(events as unknown as TranscriptEvent[]),
    ).toEqual([{ role: 'user', content: 'ask' }])
  })

  it('follows a compact boundary logical parent through the active branch', () => {
    const events = [
      msg('root', null, 'before compact'),
      {
        ...base,
        timestamp: '2026-08-23T00:01:00.000Z',
        kind: 'context-boundary' as const,
        id: 'boundary',
        parentId: null,
        logicalParentId: 'root',
        trigger: 'auto' as const,
        preTokens: 100,
        postTokens: 40,
        durationMs: 10,
      },
      {
        ...base,
        timestamp: '2026-08-23T00:02:00.000Z',
        kind: 'context-summary' as const,
        id: 'summary',
        parentId: 'boundary',
        summary: 'condensed context',
      },
      {
        ...msg('after', 'summary', 'after compact'),
        timestamp: '2026-08-23T00:03:00.000Z',
      },
    ]

    expect(activeEvents(events).map((event) => event.id)).toEqual([
      'root',
      'boundary',
      'summary',
      'after',
    ])
    expect(projectTranscriptDisplay(events)).toEqual([
      { kind: 'compact', summary: 'condensed context' },
      { kind: 'user', text: 'after compact' },
    ])
    expect(projectActiveMessages(events)).toEqual([
      { role: 'user', content: 'condensed context' },
      { role: 'user', content: 'after compact' },
    ])
    expect(projectActiveMessages(events, 'root')).toEqual([
      { role: 'user', content: 'before compact' },
    ])
  })

  it('projects canonical shell envelopes with stable input/result pairing', () => {
    const events = [
      msg('prompt', null, 'run the check'),
      msg('shell-input', 'prompt', '<bash-input>printf hi</bash-input>'),
      msg(
        'shell-output',
        'shell-input',
        '<bash-stdout>hi</bash-stdout><bash-stderr>warn</bash-stderr>',
      ),
    ]

    expect(projectTranscriptDisplay(events)).toEqual([
      { kind: 'user', text: 'run the check' },
      { kind: 'shell', callId: 'shell-input', command: 'printf hi' },
      {
        kind: 'shell-result',
        callId: 'shell-input',
        stdout: 'hi',
        stderr: 'warn',
        isError: true,
      },
    ])
    expect(lastUserPrompt(events)).toBe('run the check')
  })
})
