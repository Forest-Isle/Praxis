import { describe, expect, it } from 'vitest'
import { isTranscriptEvent } from './transcript-event.js'

const identity = {
  id: '1',
  parentId: null,
  sessionId: 's',
  timestamp: '2026-08-23T00:00:00.000Z',
}
describe('TranscriptEvent', () => {
  it('accepts a durable tool execution claim and rejects blank claims', () => {
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'tool-execution-started',
        callId: 'call-1',
      }),
    ).toBe(true)
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'tool-execution-started',
        callId: '',
      }),
    ).toBe(false)
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'tool-execution-started',
      }),
    ).toBe(false)
  })
  it('accepts canonical events and rejects provider fields', () => {
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'messages',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toBe(true)
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'context-boundary',
        logicalParentId: 'p',
        trigger: 'auto',
        preTokens: 1,
        postTokens: 0,
        durationMs: 2,
      }),
    ).toBe(true)
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'messages',
        messages: [{ role: 'user', content: 'hi' }],
        cwd: '/tmp',
      }),
    ).toBe(false)
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'messages',
        messages: [
          { role: 'tool', toolCallId: '', content: '', isError: false },
        ],
      }),
    ).toBe(false)
  })

  it('rejects provider fields at every nested message boundary', () => {
    const invalidMessages = [
      { role: 'user', content: 'hi', providerMessageId: 'provider' },
      {
        role: 'user',
        content: 'hi',
        contentBlocks: [{ type: 'text', text: 'hi', citations: [] }],
      },
      {
        role: 'assistant',
        content: '',
        thinkingBlocks: [
          {
            type: 'thinking',
            thinking: 'reason',
            signature: 'signed',
            provider: 'claude',
          },
        ],
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call', name: 'Read', input: {}, providerType: 'tool_use' },
        ],
      },
    ]

    for (const message of invalidMessages) {
      expect(
        isTranscriptEvent({
          ...identity,
          kind: 'messages',
          messages: [message],
        }),
      ).toBe(false)
    }
  })

  it('keeps image and document arrays closed to their declared media kind', () => {
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'messages',
        messages: [
          {
            role: 'user',
            content: '',
            images: [
              {
                type: 'document',
                mediaType: 'application/pdf',
                data: 'JVBERg==',
              },
            ],
          },
        ],
      }),
    ).toBe(false)
    expect(
      isTranscriptEvent({
        ...identity,
        kind: 'messages',
        messages: [
          {
            role: 'tool',
            toolCallId: 'call',
            content: '',
            documents: [
              {
                type: 'image',
                mediaType: 'image/png',
                data: 'aGVsbG8=',
              },
            ],
            isError: false,
          },
        ],
      }),
    ).toBe(false)
  })
})
