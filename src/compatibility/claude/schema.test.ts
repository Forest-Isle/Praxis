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
const advancedFixtureUrls = [
  'compact-session.jsonl',
  'sidechain-layout/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/subagents/agent-fixture.jsonl',
  'media-error-session.jsonl',
  'interrupted-session.jsonl',
].map(
  (name) =>
    new URL(
      `../../../test/fixtures/claude-code/2.1.208/${name}`,
      import.meta.url,
    ),
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

    expect(() =>
      adapter.serializeForAppend({
        ...adapter.parse(userLine ?? ''),
        version: '2.1.209',
      }),
    ).toThrow('must target Claude Code 2.1.208')
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

  it('rejects malformed message content before append', async () => {
    const source = await readFile(fixtureUrl, 'utf8')
    const [userLine, assistantLine] = source.trimEnd().split('\n')
    const adapter = selectClaudeSchemaAdapter('2.1.208')
    const user = adapter.parse(userLine ?? '')
    const assistant = adapter.parse(assistantLine ?? '')

    expect(() =>
      adapter.serializeForAppend({
        ...user,
        message: { role: 'user', content: [{ type: 'text' }] },
      }),
    ).toThrow('invalid user content block')
    expect(() =>
      adapter.serializeForAppend({
        ...assistant,
        message: {
          ...(assistant.message as Record<string, unknown>),
          content: [{ type: 'tool_use', id: '', name: 'Bash', input: {} }],
        },
      }),
    ).toThrow('invalid assistant tool_use block')

    expect(
      adapter.serializeForAppend({
        ...user,
        message: {
          role: 'user',
          content: 'Discuss the literal JSON {"type":"image"}.',
        },
      }),
    ).toContain('literal JSON')
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

  it('losslessly reads advanced Claude entries without enabling their writers', async () => {
    const adapter = selectClaudeSchemaAdapter('2.1.208')
    const fixtures = await Promise.all(
      advancedFixtureUrls.map(async (url) => {
        const source = await readFile(url, 'utf8')
        const lines = source.trimEnd().split('\n')
        expect(
          lines.map((line) => adapter.serialize(adapter.parse(line))),
        ).toEqual(lines)
        return lines.map((line) => adapter.parse(line))
      }),
    )
    const entries = fixtures.flat()

    const compactSummary = entries.find((entry) => entry.isCompactSummary)
    const sidechain = entries.find((entry) => entry.isSidechain)
    const imageResult = entries.find((entry) =>
      JSON.stringify(entry).includes('"type":"image"'),
    )
    const interrupted = entries.find(
      (entry) => entry.toolDenialKind === 'user-rejected',
    )
    if (!compactSummary || !sidechain || !imageResult || !interrupted) {
      throw new Error('Advanced fixture profile is incomplete')
    }

    expect(() => adapter.serializeForAppend(compactSummary)).toThrow(
      'compact summaries',
    )
    expect(() => adapter.serializeForAppend(sidechain)).toThrow('sidechains')
    expect(() => adapter.serializeForAppend(imageResult)).toThrow(
      'image results',
    )
    expect(() => adapter.serializeForAppend(interrupted)).toThrow(
      'tool denials',
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
