import { describe, expect, it } from 'vitest'
import { createClaudeTranscriptCodec } from '../compatibility/claude/transcript-codec.js'
import { createNativeTranscriptCodec } from './native-transcript-codec.js'

const event = {
  kind: 'messages' as const,
  id: '1',
  parentId: null,
  sessionId: 's',
  timestamp: '2026-08-23T00:00:00.000Z',
  messages: [{ role: 'user' as const, content: 'hi' }],
}
describe('native transcript codec', () => {
  it('round trips unknown fields opaquely and recovers prefixes', () => {
    const codec = createNativeTranscriptCodec()
    const line = JSON.stringify({
      schema: 'praxis.transcript',
      version: 1,
      extra: 1,
      event,
    })
    const decoded = codec.decodeDocument(`${line}\n{bad`)
    expect(decoded.records).toHaveLength(1)
    expect(decoded.issue?.kind).toBe('corrupt-line')
    const firstRecord = decoded.records[0]
    expect(firstRecord).toBeDefined()
    if (!firstRecord) return
    const encoded = codec.encodeLine(
      firstRecord.event,
      firstRecord.preservation,
    )
    expect(encoded.ok && encoded.line).toBe(line)
    expect(createNativeTranscriptCodec(2).writeMode).toBe('read-only')
  })
  it('reports invalid utf8 after a valid prefix', () => {
    const codec = createNativeTranscriptCodec()
    const first = new TextEncoder().encode(
      JSON.stringify({ schema: 'praxis.transcript', version: 1, event }) + '\n',
    )
    const result = codec.decodeDocument(new Uint8Array([...first, 0xff]))
    expect(result.records).toHaveLength(1)
    expect(result.validPrefixByteLength).toBe(first.length)
  })

  it('preserves canonical message ordering and rewrites changed events', () => {
    const codec = createNativeTranscriptCodec()
    const ordered = {
      ...event,
      messages: [
        { role: 'user' as const, content: 'before' },
        {
          role: 'tool' as const,
          toolCallId: 'call',
          content: 'result',
          isError: false,
        },
        { role: 'user' as const, content: 'after' },
      ],
    }
    const line = JSON.stringify({
      schema: 'praxis.transcript',
      version: 1,
      unknown: true,
      event: ordered,
    })
    const decoded = codec.decodeLine(line)
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.record.event).toMatchObject(ordered)
    if (decoded.record.event.kind !== 'messages') return

    const changed = codec.encodeLine(
      { ...decoded.record.event, messages: [{ role: 'user', content: 'new' }] },
      decoded.record.preservation,
    )
    expect(changed.ok).toBe(true)
    if (changed.ok) {
      const value = JSON.parse(changed.line)
      expect(value).not.toHaveProperty('unknown')
      expect(value.event.messages).toEqual([{ role: 'user', content: 'new' }])
    }
  })

  it('rejects foreign preservation tokens and unsupported versions or events', () => {
    const codec = createNativeTranscriptCodec()
    const claude = createClaudeTranscriptCodec({
      version: '2.1.208',
      cwd: '/tmp',
    })
    const claudeLine = JSON.stringify({
      type: 'user',
      uuid: '1',
      parentUuid: null,
      sessionId: 's',
      timestamp: '2026-08-23T00:00:00.000Z',
      version: '2.1.208',
      cwd: '/tmp',
      message: { role: 'user', content: 'hi' },
    })
    const claudeDecoded = claude.decodeLine(claudeLine)
    expect(claudeDecoded.ok).toBe(true)
    if (claudeDecoded.ok) {
      const foreign = codec.encodeLine(
        claudeDecoded.record.event,
        claudeDecoded.record.preservation,
      )
      expect(foreign.ok).toBe(false)
      if (!foreign.ok) expect(foreign.issue.kind).toBe('unsupported-event')
    }

    expect(
      codec.decodeLine(
        JSON.stringify({
          schema: 'praxis.transcript',
          version: 2,
          event,
        }),
      ),
    ).toMatchObject({
      ok: false,
      issue: { kind: 'unsupported-version', schemaVersion: 2 },
    })
    expect(
      codec.decodeLine(
        JSON.stringify({
          schema: 'praxis.transcript',
          version: 1,
          event: { ...event, provider: 'claude' },
        }),
      ),
    ).toMatchObject({ ok: false, issue: { kind: 'unsupported-event' } })
    expect(createNativeTranscriptCodec(2).encodeLine(event)).toMatchObject({
      ok: false,
      issue: { kind: 'unsupported-version' },
    })
  })

  it('reports malformed JSON and exact CRLF/trailing-newline byte prefixes', () => {
    const codec = createNativeTranscriptCodec()
    expect(codec.decodeLine('{bad', 4, 23)).toMatchObject({
      ok: false,
      issue: { kind: 'corrupt-line', lineNumber: 4, byteOffset: 23 },
    })

    const line = JSON.stringify({
      schema: 'praxis.transcript',
      version: 1,
      event,
    })
    const source = `${line}\r\n${line}\n`
    const decoded = codec.decodeDocument(source)
    expect(decoded.issue).toBeNull()
    expect(decoded.records).toHaveLength(2)
    expect(decoded.validPrefixByteLength).toBe(
      new TextEncoder().encode(source).length,
    )
    const firstRecord = decoded.records[0]
    expect(firstRecord).toBeDefined()
    if (!firstRecord) return
    expect(
      codec.encodeLine(firstRecord.event, firstRecord.preservation),
    ).toEqual({ ok: true, line: `${line}\r` })

    const corrupt = codec.decodeDocument(`${line}\r\n{bad\n`)
    expect(corrupt.records).toHaveLength(1)
    expect(corrupt.issue).toMatchObject({
      kind: 'corrupt-line',
      lineNumber: 2,
      byteOffset: new TextEncoder().encode(`${line}\r\n`).length,
    })
    expect(corrupt.validPrefixByteLength).toBe(
      new TextEncoder().encode(`${line}\r\n`).length,
    )
  })
})
