import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  parseClaudeVersionOutput,
  selectClaudeSchemaAdapter,
} from './schema.js'

const fixtureUrl = new URL(
  '../../../test/fixtures/claude-code/2.1.208/basic-session.jsonl',
  import.meta.url,
)

describe('ClaudeSchemaAdapter', () => {
  it('round-trips Claude Code 2.1.208 entries without losing unknown fields', async () => {
    const source = await readFile(fixtureUrl, 'utf8')
    const lines = source.trimEnd().split('\n')
    const adapter = selectClaudeSchemaAdapter('2.1.208')

    expect(adapter.writeMode).toBe('read-write')
    expect(lines.map((line) => adapter.serialize(adapter.parse(line)))).toEqual(
      lines,
    )
    expect(adapter.parse(lines[0] ?? '').futureField).toEqual({
      preserve: true,
    })
  })

  it('accepts only native conversational entry types for new appends', async () => {
    const source = await readFile(fixtureUrl, 'utf8')
    const [userLine] = source.trimEnd().split('\n')
    const adapter = selectClaudeSchemaAdapter('2.1.208')

    expect(adapter.serializeForAppend(adapter.parse(userLine ?? ''))).toBe(
      userLine,
    )
    expect(() =>
      adapter.serializeForAppend({ type: 'praxis-provider-state' }),
    ).toThrow('not appendable')
    expect(() => adapter.serializeForAppend({ type: 'user' })).toThrow(
      'missing uuid',
    )
  })

  it('falls back to read-only parsing for unknown Claude versions', () => {
    const adapter = selectClaudeSchemaAdapter('9.0.0')
    const entry = adapter.parse('{"type":"user","unknown":true}')

    expect(adapter.writeMode).toBe('read-only')
    expect(entry).toEqual({ type: 'user', unknown: true })
    expect(() => adapter.serializeForAppend(entry)).toThrow(
      'Unsupported Claude Code transcript version',
    )
  })

  it('rejects malformed transcript lines', () => {
    const adapter = selectClaudeSchemaAdapter('2.1.208')

    expect(() => adapter.parse('{')).toThrow('Invalid Claude transcript JSON')
    expect(() => adapter.parse('[]')).toThrow(
      'Claude transcript entry must be an object',
    )
    expect(() => adapter.parse('{"message":{}}')).toThrow(
      'Claude transcript entry must have a type',
    )
  })
})

describe('Claude version detection', () => {
  it('parses the installed CLI version format', () => {
    expect(parseClaudeVersionOutput('2.1.208 (Claude Code)\n')).toBe('2.1.208')
  })

  it('rejects an unexpected executable response', () => {
    expect(() => parseClaudeVersionOutput('Claude Code')).toThrow(
      'Unable to detect Claude Code version',
    )
  })
})
