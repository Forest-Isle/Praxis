import { describe, expect, it } from 'vitest'
import { projectNativeSessionEntries } from './native-session-projection.js'
import type { TranscriptEvent } from '../core/transcript-event.js'

const base = {
  sessionId: 'session-1',
  timestamp: '2026-08-23T00:00:00.000Z',
}

describe('projectNativeSessionEntries', () => {
  it('projects context events and ignores execution claims', () => {
    const events: TranscriptEvent[] = [
      {
        ...base,
        kind: 'context-boundary',
        id: 'boundary',
        parentId: 'root',
        logicalParentId: 'logical',
        trigger: 'manual',
        preTokens: 100,
        postTokens: 40,
        durationMs: 12,
      },
      {
        ...base,
        kind: 'context-summary',
        id: 'summary',
        parentId: 'boundary',
        summary: 'condensed',
      },
      {
        ...base,
        kind: 'tool-execution-started',
        id: 'claim',
        parentId: 'summary',
        callId: 'call',
      },
    ]
    expect(projectNativeSessionEntries(events)).toEqual([
      {
        type: 'system',
        uuid: 'boundary',
        parentUuid: 'root',
        subtype: 'compact_boundary',
        logicalParentUuid: 'logical',
        compactMetadata: {
          trigger: 'manual',
          preTokens: 100,
          postTokens: 40,
          durationMs: 12,
        },
      },
      {
        type: 'user',
        uuid: 'summary',
        parentUuid: 'boundary',
        isCompactSummary: true,
        message: { role: 'user', content: 'condensed' },
      },
    ])
  })

  it('preserves multi-message identity chain and assistant/tool projections', () => {
    const events: TranscriptEvent[] = [
      {
        ...base,
        kind: 'messages',
        id: 'turn',
        parentId: 'root',
        messages: [
          { role: 'user', content: 'first' },
          {
            role: 'assistant',
            content: 'answer',
            toolCalls: [{ id: 'call', name: 'check', input: { x: 1 } }],
          },
          {
            role: 'tool',
            toolCallId: 'call',
            content: 'result',
            isError: true,
          },
        ],
      },
    ]
    expect(projectNativeSessionEntries(events)).toEqual([
      {
        type: 'user',
        uuid: 'turn:0',
        parentUuid: 'root',
        message: { role: 'user', content: 'first' },
      },
      {
        type: 'assistant',
        uuid: 'turn:1',
        parentUuid: 'turn:0',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 'call', name: 'check', input: { x: 1 } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'turn',
        parentUuid: 'turn:1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call',
              content: 'result',
              is_error: true,
            },
          ],
        },
      },
    ])
  })

  it('recognizes settings, title, file history markers and falls back safely', () => {
    const snapshot = JSON.stringify({
      type: 'file-history-snapshot',
      message: { role: 'user', content: 'snap' },
    })
    const delta = JSON.stringify({ type: 'file-history-delta', files: ['a'] })
    const events: TranscriptEvent[] = [
      {
        ...base,
        kind: 'messages',
        id: 'markers',
        parentId: null,
        messages: [
          {
            role: 'user',
            content: '<praxis-agent-setting>fast</praxis-agent-setting>',
          },
          {
            role: 'user',
            content: '<praxis-session-name>Title</praxis-session-name>',
          },
          {
            role: 'user',
            content: `<praxis-file-history>${snapshot}</praxis-file-history>`,
          },
          {
            role: 'user',
            content: `<praxis-file-history>${delta}</praxis-file-history>`,
          },
          {
            role: 'user',
            content: '<praxis-file-history>{bad</praxis-file-history>',
          },
          {
            role: 'user',
            content:
              '<praxis-file-history>{"type":"other"}</praxis-file-history>',
          },
        ],
      },
    ]
    const projected = projectNativeSessionEntries(events)
    expect(projected.map((entry) => entry.type)).toEqual([
      'agent-setting',
      'custom-title',
      'file-history-snapshot',
      'file-history-delta',
      'user',
      'user',
    ])
    expect(projected[4]).toMatchObject({
      uuid: 'markers:4',
      parentUuid: 'markers:3',
    })
    expect(projected[5]).toMatchObject({
      uuid: 'markers',
      parentUuid: 'markers:4',
    })
  })

  it('does not mutate events or nested message/tool inputs', () => {
    const events: TranscriptEvent[] = [
      {
        ...base,
        kind: 'messages',
        id: 'immutable',
        parentId: null,
        messages: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c', name: 'tool', input: { a: 1 } }],
          },
        ],
      },
    ]
    const before = structuredClone(events)
    const projected = projectNativeSessionEntries(events)
    expect(projected).toEqual([
      {
        type: 'assistant',
        uuid: 'immutable',
        parentUuid: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'c', name: 'tool', input: { a: 1 } },
          ],
        },
      },
    ])
    expect(events).toEqual(before)
  })
})
