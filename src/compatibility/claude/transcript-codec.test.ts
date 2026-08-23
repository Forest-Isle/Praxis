import { describe, expect, it } from 'vitest'
import { createClaudeTranscriptCodec } from './transcript-codec.js'

const codec = createClaudeTranscriptCodec({ version: '2.1.208', cwd: '/tmp' })
const entry = {
  type: 'user',
  uuid: '1',
  parentUuid: null,
  sessionId: 's',
  timestamp: '2026-08-23T00:00:00.000Z',
  version: '2.1.208',
  cwd: '/tmp',
  isSidechain: false,
  userType: 'external',
  entrypoint: 'cli',
  message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
}
const identity = {
  id: 'event',
  parentId: 'parent',
  sessionId: 's',
  timestamp: '2026-08-23T00:00:00.000Z',
}
describe('Claude transcript codec', () => {
  it('decodes supported entries and preserves raw lines', () => {
    const line = JSON.stringify(entry)
    const result = codec.decodeLine(line)
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(
        codec.encodeLine(result.record.event, result.record.preservation),
      ).toEqual({ ok: true, line })
  })
  it('rejects unsupported versions', () =>
    expect(
      createClaudeTranscriptCodec({ version: 'future', cwd: '/tmp' }).writeMode,
    ).toBe('read-only'))

  it('encodes a mixed user and tool batch without dropping message order', () => {
    const encoded = codec.encodeLine({
      kind: 'messages',
      ...identity,
      messages: [
        { role: 'user', content: 'before' },
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: 'result',
          isError: false,
        },
        { role: 'user', content: 'after' },
      ],
    })

    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(JSON.parse(encoded.line)).toMatchObject({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'result',
            is_error: false,
          },
          { type: 'text', text: 'after' },
        ],
      },
    })
  })

  it('decodes text and media around tool results in canonical order', () => {
    const decoded = codec.decodeLine(
      JSON.stringify({
        ...entry,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            {
              type: 'tool_result',
              tool_use_id: 'call-1',
              is_error: true,
              content: [
                { type: 'text', text: 'result' },
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'aGVsbG8=',
                  },
                },
              ],
            },
            { type: 'text', text: 'after' },
          ],
        },
      }),
    )

    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.record.event).toMatchObject({
      kind: 'messages',
      messages: [
        {
          role: 'user',
          content: 'before',
          contentBlocks: [{ type: 'text', text: 'before' }],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          content: 'result',
          isError: true,
          contentBlocks: [
            { type: 'text', text: 'result' },
            { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
          ],
        },
        {
          role: 'user',
          content: 'after',
          contentBlocks: [{ type: 'text', text: 'after' }],
        },
      ],
    })
  })

  it('encodes a complete assistant message through the closed writer', () => {
    const encoded = codec.encodeLine({
      kind: 'messages',
      ...identity,
      model: 'claude-test',
      terminalReason: 'tool_use',
      messages: [
        {
          role: 'assistant',
          content: 'I will inspect it.',
          thinkingBlocks: [
            { type: 'thinking', thinking: 'inspect', signature: 'signed' },
            { type: 'redacted_thinking', data: 'opaque' },
          ],
          toolCalls: [{ id: 'call-1', name: 'Read', input: { path: 'a.ts' } }],
        },
      ],
    })

    expect(encoded.ok).toBe(true)
    if (!encoded.ok) return
    expect(JSON.parse(encoded.line)).toMatchObject({
      type: 'assistant',
      message: {
        id: identity.id,
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        stop_reason: 'tool_use',
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [
          { type: 'thinking', thinking: 'inspect', signature: 'signed' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'call-1', name: 'Read' },
        ],
      },
    })
  })

  it('writes valid compact boundary and summary entries', () => {
    const boundary = codec.encodeLine({
      kind: 'context-boundary',
      ...identity,
      parentId: null,
      logicalParentId: 'logical-tail',
      trigger: 'manual',
      preTokens: 100,
      postTokens: 40,
      durationMs: 5,
    })
    const summary = codec.encodeLine({
      kind: 'context-summary',
      ...identity,
      summary: 'Continue the task.',
    })

    expect(boundary.ok).toBe(true)
    expect(summary.ok).toBe(true)
    if (!boundary.ok || !summary.ok) return
    expect(JSON.parse(boundary.line)).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      parentUuid: null,
      isMeta: false,
      level: 'info',
      compactMetadata: {
        cumulativeDroppedTokens: 60,
        preservedSegment: { headUuid: 'logical-tail' },
        preservedMessages: { uuids: ['logical-tail'] },
      },
    })
    expect(JSON.parse(summary.line)).toMatchObject({
      type: 'user',
      promptId: identity.id,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
  })

  it('rejects canonical combinations that one Claude line cannot represent', () => {
    const unsupported = [
      codec.encodeLine({
        kind: 'messages',
        ...identity,
        messages: [
          { role: 'user', content: 'one' },
          { role: 'user', content: 'two' },
        ],
      }),
      codec.encodeLine({
        kind: 'messages',
        ...identity,
        model: 'claude-test',
        terminalReason: 'prompt_too_long',
        messages: [{ role: 'assistant', content: 'too long' }],
      }),
      codec.encodeLine({
        kind: 'messages',
        ...identity,
        messages: [
          {
            role: 'tool',
            toolCallId: 'call-1',
            content: '',
            images: [
              { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
            ],
            isError: false,
          },
        ],
      }),
    ]

    expect(unsupported.every((result) => !result.ok)).toBe(true)
    for (const result of unsupported) {
      if (!result.ok) expect(result.issue.kind).toBe('unsupported-event')
    }
  })

  it('preserves unchanged bytes and closes changed writes', () => {
    const line = ` {"unknown":true,${JSON.stringify(entry).slice(1)} `
    const decoded = codec.decodeLine(line)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(
      codec.encodeLine(decoded.record.event, decoded.record.preservation),
    ).toEqual({ ok: true, line })
    if (decoded.record.event.kind !== 'messages') return

    const changed = codec.encodeLine(
      { ...decoded.record.event, messages: [{ role: 'user', content: 'bye' }] },
      decoded.record.preservation,
    )
    expect(changed.ok).toBe(true)
    if (changed.ok) {
      expect(JSON.parse(changed.line)).not.toHaveProperty('unknown')
      expect(JSON.parse(changed.line).message.content).toBe('bye')
    }
  })

  it('reports malformed, unsupported, and read-only writes as typed issues', () => {
    const malformed = codec.decodeLine('{bad', 3, 17)
    const unsupported = codec.decodeLine(JSON.stringify({ type: 'progress' }))
    const readOnly = createClaudeTranscriptCodec({
      version: 'future',
      cwd: '/tmp',
    }).encodeLine({
      kind: 'messages',
      ...identity,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(malformed).toMatchObject({
      ok: false,
      issue: { kind: 'corrupt-line', lineNumber: 3, byteOffset: 17 },
    })
    expect(unsupported).toMatchObject({
      ok: false,
      issue: { kind: 'unsupported-event' },
    })
    expect(readOnly).toMatchObject({
      ok: false,
      issue: { kind: 'unsupported-version' },
    })
  })
})
