import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  copyClaudeEntryWithSessionId,
  parseClaudeVersionOutput,
  selectClaudeSchemaAdapter,
} from './schema.js'
import { createClaudeSidechainRoot } from './sidechain.js'

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

  it('replaces only root sessionId without normalizing native JSON', () => {
    const source =
      '{"type":"user","parentUuid":null,"isSidechain":false,"uuid":"user","timestamp":"2026-08-04T00:00:00.000Z","cwd":"/tmp/project","future":{"sessionId":"source","unsafe":9007199254740993},"sessionId":"source","version":"2.1.208","message":{"role":"user","content":"hello"}}'
    const adapter = selectClaudeSchemaAdapter('2.1.208')
    const copied = copyClaudeEntryWithSessionId(adapter.parse(source), 'target')

    expect(adapter.serializeForFork(copied)).toBe(
      source.replace(
        '"sessionId":"source","version"',
        '"sessionId":"target","version"',
      ),
    )

    const titleSource =
      '{"type":"custom-title","customTitle":"Named","future":{"sessionId":"source"},"sessionId":"source"}'
    const copiedTitle = copyClaudeEntryWithSessionId(
      adapter.parse(titleSource),
      'target',
    )
    expect(adapter.serializeForFork(copiedTitle)).toBe(
      titleSource.replace(',"sessionId":"source"}', ',"sessionId":"target"}'),
    )
  })

  it('accepts only the native append profile', async () => {
    const source = await readFile(fixtureUrl, 'utf8')
    const [userLine, , lastPromptLine] = source.trimEnd().split('\n')
    const adapter = selectClaudeSchemaAdapter('2.1.208')

    expect(adapter.serializeForAppend(adapter.parse(userLine ?? ''))).toBe(
      userLine,
    )
    expect(() =>
      adapter.serializeForAppend({ type: 'praxis-provider-state' }),
    ).toThrow('not appendable')
    const customTitle = {
      type: 'custom-title',
      customTitle: 'Named session',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    const agentName = {
      type: 'agent-name',
      agentName: 'Named session',
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    expect(adapter.serializeForAppend(customTitle)).toBe(
      JSON.stringify(customTitle),
    )
    expect(adapter.serializeForAppend(agentName)).toBe(
      JSON.stringify(agentName),
    )
    expect(adapter.serializeForFork(customTitle)).toBe(
      JSON.stringify(customTitle),
    )
    expect(adapter.serializeForFork(agentName)).toBe(JSON.stringify(agentName))
    expect(() =>
      adapter.serializeForAppend({ ...customTitle, customTitle: '' }),
    ).toThrow('invalid metadata')
    expect(() =>
      adapter.serializeForAppend({ ...agentName, agentName: '' }),
    ).toThrow('invalid metadata')
    expect(() => adapter.serializeForAppend({ type: 'user' })).toThrow(
      'missing uuid',
    )
    expect(
      adapter.serializeForAppend(adapter.parse(lastPromptLine ?? '')),
    ).toBe(lastPromptLine)
    const nativeLastPrompt = {
      type: 'last-prompt',
      sessionId: 'session',
      leafUuid: 'leaf',
    }
    expect(adapter.serializeForFork(nativeLastPrompt)).toBe(
      JSON.stringify(nativeLastPrompt),
    )
    expect(() => adapter.serializeForAppend(nativeLastPrompt)).toThrow(
      'invalid metadata',
    )
    expect(adapter.serializeForFork(adapter.parse(userLine ?? ''))).toBe(
      userLine,
    )
    expect(() =>
      adapter.serializeForAppend({
        type: 'last-prompt',
        sessionId: 'session',
        lastPrompt: 'prompt',
      }),
    ).toThrow('invalid leafUuid')
    expect(() =>
      adapter.serializeForAppend({
        type: 'last-prompt',
        sessionId: '',
        lastPrompt: 'prompt',
        leafUuid: 'leaf',
      }),
    ).toThrow('invalid metadata')
    expect(() =>
      adapter.serializeForAppend({
        type: 'last-prompt',
        sessionId: 'session',
        lastPrompt: '',
        leafUuid: 'leaf',
      }),
    ).toThrow('invalid metadata')

    expect(() =>
      adapter.serializeForAppend({
        ...adapter.parse(userLine ?? ''),
        version: '2.1.209',
      }),
    ).toThrow('must target Claude Code 2.1.208')
    for (const serialize of [
      adapter.serializeForAppend.bind(adapter),
      adapter.serializeForFork.bind(adapter),
    ]) {
      expect(() =>
        serialize({ ...adapter.parse(userLine ?? ''), parentUuid: '' }),
      ).toThrow('invalid parentUuid')
    }
    expect(() =>
      adapter.serializeForSidechainAppend({
        ...createClaudeSidechainRoot({
          sessionId: 'session',
          promptId: 'prompt',
          prompt: 'hello',
          agentId: '0123456789abcdef',
          cwd: '/tmp/project',
          claudeVersion: '2.1.208',
          gitBranch: null,
          uuid: 'sidechain-root',
          timestamp: '2026-08-04T00:00:00.000Z',
        }),
        parentUuid: '',
      }),
    ).toThrow('invalid parentUuid')
    expect(
      adapter.serializeForAppend({
        type: 'agent-setting',
        agentSetting: 'reviewer',
        sessionId: 'session',
      }),
    ).toBe(
      '{"type":"agent-setting","agentSetting":"reviewer","sessionId":"session"}',
    )
    expect(() =>
      adapter.serializeForAppend({
        type: 'agent-setting',
        agentSetting: '',
        sessionId: 'session',
      }),
    ).toThrow('invalid metadata')
    const prLink = {
      type: 'pr-link',
      sessionId: 'session',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      prRepository: 'owner/repo',
      timestamp: '2026-08-08T00:00:00.000Z',
    }
    expect(adapter.serializeForAppend(prLink)).toBe(JSON.stringify(prLink))
    expect(adapter.serializeForFork(prLink)).toBe(JSON.stringify(prLink))
    expect(() =>
      adapter.serializeForAppend({ ...prLink, prNumber: 0 }),
    ).toThrow('invalid metadata')
  })

  it('accepts only validated Claude 2.1.208 nested-memory attachments', () => {
    const adapter = selectClaudeSchemaAdapter('2.1.208')
    const attachment = {
      type: 'attachment',
      parentUuid: '10000000-0000-4000-8000-000000000001',
      isSidechain: false,
      uuid: '10000000-0000-4000-8000-000000000002',
      timestamp: '2026-08-03T08:00:01.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/tmp/project',
      sessionId: '20000000-0000-4000-8000-000000000001',
      version: '2.1.208',
      gitBranch: null,
      attachment: {
        type: 'nested_memory',
        path: '/tmp/project/.claude/rules/typescript.md',
        content: {
          path: '/tmp/project/.claude/rules/typescript.md',
          type: 'Project',
          content: 'USE_TYPESCRIPT\n',
          globs: ['src/**/*.ts'],
          contentDiffersFromDisk: true,
          rawContent: '---\npaths:\n  - "src/**/*.ts"\n---\nUSE_TYPESCRIPT\n',
        },
        displayPath: '.claude/rules/typescript.md',
      },
    }

    expect(adapter.serializeForAppend(attachment)).toBe(
      JSON.stringify(attachment),
    )
    expect(() =>
      adapter.serializeForAppend({
        ...attachment,
        attachment: {
          ...attachment.attachment,
          content: { ...attachment.attachment.content, globs: [] },
        },
      }),
    ).toThrow('invalid nested-memory attachment')
    for (const invalidEnvelope of [
      { ...attachment, isSidechain: undefined },
      { ...attachment, userType: undefined },
      { ...attachment, entrypoint: undefined },
      { ...attachment, gitBranch: undefined },
      { ...attachment, gitBranch: 1 },
    ]) {
      expect(() => adapter.serializeForAppend(invalidEnvelope)).toThrow(
        'invalid nested-memory attachment',
      )
    }
    expect(adapter.serializeForFork(attachment)).toBe(
      JSON.stringify(attachment),
    )
  })

  it('accepts only validated Claude 2.1.208 hook attachments', () => {
    const adapter = selectClaudeSchemaAdapter('2.1.208')
    const common = {
      type: 'attachment',
      parentUuid: 'parent',
      isSidechain: false,
      uuid: 'hook',
      timestamp: '2026-08-03T08:00:00.000Z',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/tmp/project',
      sessionId: 'session',
      version: '2.1.208',
      gitBranch: null,
    }
    const success = {
      ...common,
      attachment: {
        type: 'hook_success',
        hookName: 'PreToolUse:Bash',
        toolUseID: 'call_hook',
        hookEvent: 'PreToolUse',
        content: '',
        stdout: '',
        stderr: '',
        exitCode: 0,
        command: 'node hook.mjs',
        durationMs: 4,
      },
    }
    const context = {
      ...common,
      uuid: 'context',
      attachment: {
        type: 'hook_additional_context',
        content: ['HOOK_CONTEXT'],
        hookName: 'PreToolUse:Bash',
        toolUseID: 'call_hook',
        hookEvent: 'PreToolUse',
      },
    }

    expect(adapter.serializeForAppend(success)).toBe(JSON.stringify(success))
    expect(adapter.serializeForAppend(context)).toBe(JSON.stringify(context))
    for (const entrypoint of ['sdk-cli', 'sdk-ts']) {
      const nativeSuccess = { ...success, entrypoint }
      expect(adapter.serializeForFork(nativeSuccess)).toBe(
        JSON.stringify(nativeSuccess),
      )
      expect(() => adapter.serializeForAppend(nativeSuccess)).toThrow(
        'invalid hook attachment',
      )
    }
    expect(() =>
      adapter.serializeForAppend({
        ...success,
        attachment: { ...success.attachment, command: '' },
      }),
    ).toThrow('invalid hook success attachment')
    expect(() =>
      adapter.serializeForAppend({
        ...context,
        attachment: { ...context.attachment, content: [] },
      }),
    ).toThrow('invalid hook context attachment')
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
    expect(
      adapter.serializeForAppend({
        ...user,
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'aGVsbG8=',
              },
            },
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: 'JVBERg==',
              },
            },
          ],
        },
      }),
    ).toContain('application/pdf')
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

  it('writes only the validated native compaction profile from advanced entries', async () => {
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

    const compactBoundary = entries.find(
      (entry) => entry.subtype === 'compact_boundary',
    )
    if (!compactBoundary) throw new Error('Compact boundary fixture is missing')
    expect(adapter.serializeForAppend(compactBoundary)).toBe(
      JSON.stringify(compactBoundary),
    )
    expect(adapter.serializeForAppend(compactSummary)).toBe(
      JSON.stringify(compactSummary),
    )
    expect(adapter.serializeForFork(compactSummary)).toBe(
      JSON.stringify(compactSummary),
    )
    expect(() => adapter.serializeForAppend(sidechain)).toThrow('sidechains')
    expect(
      adapter.serializeForSidechainAppend({
        ...sidechain,
        entrypoint: 'cli',
      }),
    ).toContain('"isSidechain":true')
    expect(() =>
      adapter.serializeForSidechainAppend({
        ...sidechain,
        entrypoint: 'cli',
        agentId: '',
      }),
    ).toThrow('missing agentId')
    expect(adapter.serializeForAppend(imageResult)).toBe(
      JSON.stringify(imageResult),
    )
    expect(
      adapter.serializeForSidechainAppend({
        ...imageResult,
        isSidechain: true,
        entrypoint: 'cli',
        agentId: '0123456789abcdef',
      }),
    ).toContain('"type":"image"')
    expect(adapter.serializeForFork(imageResult)).toBe(
      JSON.stringify(imageResult),
    )
    expect(() => adapter.serializeForAppend(interrupted)).toThrow(
      'tool denials',
    )
    expect(adapter.serializeForFork(interrupted)).toBe(
      JSON.stringify(interrupted),
    )
    expect(() =>
      adapter.serializeForFork({
        ...imageResult,
        message: {
          ...(imageResult.message as Record<string, unknown>),
          content: [{}],
        },
      }),
    ).toThrow('invalid user content block')
    expect(() =>
      adapter.serializeForAppend({
        ...imageResult,
        toolUseResult: {
          type: 'image',
          file: {
            base64: 'different',
            type: 'image/png',
            originalSize: 9,
          },
        },
      }),
    ).toThrow('image tool result metadata')
    const imageMessage = imageResult.message as Record<string, unknown>
    const imageToolResult = (
      imageMessage.content as Record<string, unknown>[]
    )[0]
    const textArrayResult = {
      ...imageResult,
      toolUseResult: undefined,
      message: {
        ...imageMessage,
        content: [
          {
            ...imageToolResult,
            content: [{ type: 'text', text: 'unexpected' }],
          },
        ],
      },
    }
    expect(() => adapter.serializeForAppend(textArrayResult)).toThrow(
      'invalid tool result content',
    )
    expect(() =>
      adapter.serializeForAppend({
        ...textArrayResult,
        toolUseResult: imageResult.toolUseResult,
      }),
    ).toThrow('image tool result metadata')
    const textMessageWithImageMetadata = {
      ...imageResult,
      message: { role: 'user', content: 'unexpected' },
    }
    expect(() =>
      adapter.serializeForAppend(textMessageWithImageMetadata),
    ).toThrow('image tool result metadata')
    expect(() =>
      adapter.serializeForSidechainAppend({
        ...textMessageWithImageMetadata,
        isSidechain: true,
        entrypoint: 'cli',
        agentId: '0123456789abcdef',
      }),
    ).toThrow('image tool result metadata')
    expect(() =>
      adapter.serializeForFork({
        ...imageResult,
        type: 'system',
        subtype: 'future-system-event',
      }),
    ).toThrow('unsupported subtype')
    expect(() =>
      adapter.serializeForFork({
        ...imageResult,
        type: 'system',
        subtype: 'turn_duration',
        isSidechain: undefined,
      }),
    ).toThrow('main chain')
    expect(() =>
      adapter.serializeForFork({
        ...imageResult,
        type: 'attachment',
        attachment: { type: 'future-attachment' },
      }),
    ).toThrow('unsupported attachment')
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
