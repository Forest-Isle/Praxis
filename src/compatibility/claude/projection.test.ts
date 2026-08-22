import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  getClaudeAgentSetting,
  getClaudeLastPrompt,
  projectClaudeDisplayTranscript,
  projectClaudeModelMessages,
  projectClaudeSidechainContinuationMessages,
  projectClaudeTextMessages,
} from './projection.js'
import { createClaudeCompactEntries } from './compaction.js'

describe('Claude transcript projection', () => {
  it('renders native compact summaries as expandable transcript markers', () => {
    const compact = createClaudeCompactEntries({
      sessionId: 'compact-session',
      logicalParentUuid: 'assistant-before',
      summary: 'durable summary',
      preTokens: 100,
      postTokens: 20,
      previousCumulativeDroppedTokens: 0,
      durationMs: 10,
      cwd: '/workspace',
      claudeVersion: '2.1.208',
      gitBranch: null,
      createUuid: (() => {
        const uuids = ['boundary', 'summary']
        return () => uuids.shift() ?? 'fallback'
      })(),
    })

    expect(
      projectClaudeDisplayTranscript([
        {
          type: 'assistant',
          uuid: 'assistant-before',
          parentUuid: null,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'discarded answer' }],
          },
        },
        ...compact,
      ]),
    ).toEqual([{ kind: 'compact', summary: 'durable summary' }])
  })

  it('replays messages preserved after a native up-to summary', () => {
    const compact = createClaudeCompactEntries({
      sessionId: 'compact-session',
      logicalParentUuid: 'assistant-before',
      summary: 'summary before the selected prompt',
      preTokens: 100,
      postTokens: 40,
      previousCumulativeDroppedTokens: 0,
      durationMs: 10,
      cwd: '/workspace',
      claudeVersion: '2.1.208',
      gitBranch: null,
      summarizeMetadata: { messagesSummarized: 2, direction: 'up_to' },
      preservedUuids: ['user-preserved', 'assistant-preserved'],
      createUuid: (() => {
        const uuids = ['boundary', 'summary']
        return () => uuids.shift() ?? 'fallback'
      })(),
    })
    const entries = [
      {
        type: 'assistant',
        uuid: 'assistant-before',
        parentUuid: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'discarded answer' }],
        },
      },
      {
        type: 'user',
        uuid: 'user-preserved',
        parentUuid: 'assistant-before',
        message: { role: 'user', content: 'selected prompt remains' },
      },
      {
        type: 'assistant',
        uuid: 'assistant-preserved',
        parentUuid: 'user-preserved',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'later answer remains' }],
        },
      },
      ...compact,
    ]

    expect(projectClaudeDisplayTranscript(entries)).toEqual([
      { kind: 'compact', summary: 'summary before the selected prompt' },
      { kind: 'user', text: 'selected prompt remains' },
      { kind: 'assistant', text: 'later answer remains' },
    ])
    expect(projectClaudeModelMessages(entries)).toEqual([
      expect.objectContaining({ role: 'user' }),
      { role: 'user', content: 'selected prompt remains' },
      { role: 'assistant', content: 'later answer remains' },
    ])
    const [discarded, preservedUser, preservedAssistant] = entries
    if (!discarded || !preservedUser || !preservedAssistant) {
      throw new Error('projection fixture is incomplete')
    }
    expect(
      projectClaudeDisplayTranscript([
        discarded,
        ...compact,
        preservedUser,
        preservedAssistant,
      ]),
    ).toEqual([
      { kind: 'compact', summary: 'summary before the selected prompt' },
      { kind: 'user', text: 'selected prompt remains' },
      { kind: 'assistant', text: 'later answer remains' },
    ])
  })

  it('projects active display history with thinking, tools, results, and shell turns', () => {
    const entries = [
      {
        type: 'user',
        uuid: 'user-1',
        parentUuid: null,
        promptSource: 'typed',
        message: { role: 'user', content: 'inspect two files' },
      },
      {
        type: 'assistant',
        uuid: 'assistant-1',
        parentUuid: 'user-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'I should inspect both.',
              signature: 'sig',
            },
            {
              type: 'tool_use',
              id: 'read-1',
              name: 'Read',
              input: { file_path: '/tmp/one.ts' },
            },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'result-1',
        parentUuid: 'assistant-1',
        sourceToolAssistantUUID: 'assistant-1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-1',
              content: [{ type: 'text', text: 'line one' }],
            },
          ],
        },
      },
      {
        type: 'assistant',
        uuid: 'assistant-2',
        parentUuid: 'result-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      },
      {
        type: 'user',
        uuid: 'shell-in',
        parentUuid: 'assistant-2',
        message: { role: 'user', content: '<bash-input>pwd</bash-input>' },
      },
      {
        type: 'user',
        uuid: 'shell-out',
        parentUuid: 'shell-in',
        message: {
          role: 'user',
          content: '<bash-stdout>/tmp</bash-stdout><bash-stderr></bash-stderr>',
        },
      },
    ]

    expect(projectClaudeDisplayTranscript(entries)).toEqual([
      { kind: 'user', text: 'inspect two files' },
      { kind: 'thinking', text: 'I should inspect both.' },
      {
        kind: 'tool',
        call: {
          id: 'read-1',
          name: 'Read',
          input: { file_path: '/tmp/one.ts' },
        },
        detail: '',
      },
      {
        kind: 'tool-result',
        callId: 'read-1',
        text: 'line one',
        isError: false,
      },
      { kind: 'assistant', text: 'Done.' },
      { kind: 'shell', callId: 'shell-in', command: 'pwd' },
      {
        kind: 'shell-result',
        callId: 'shell-in',
        stdout: '/tmp',
        stderr: '',
        isError: false,
      },
    ])
  })

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
    expect(
      getClaudeAgentSetting([
        { type: 'agent-setting', agentSetting: 'reviewer' },
      ]),
    ).toBe('reviewer')
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
        type: 'attachment',
        attachment: {
          type: 'nested_memory',
          path: '/workspace/.claude/rules/typescript.md',
          content: {
            path: '/workspace/.claude/rules/typescript.md',
            type: 'Project',
            content: 'USE_TYPESCRIPT\n',
            globs: ['src/**/*.ts'],
            contentDiffersFromDisk: true,
            rawContent: '---\npaths:\n  - "src/**/*.ts"\n---\nUSE_TYPESCRIPT\n',
          },
          displayPath: '.claude/rules/typescript.md',
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'hook_success',
          content: 'PROMPT_HOOK_CONTEXT',
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          content: ['PRE_HOOK_CONTEXT', 'POST_HOOK_CONTEXT'],
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
      { role: 'system', content: 'USE_TYPESCRIPT\n' },
      { role: 'system', content: 'PROMPT_HOOK_CONTEXT' },
      {
        role: 'system',
        content: 'PRE_HOOK_CONTEXT\nPOST_HOOK_CONTEXT',
      },
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

  it('projects signed and redacted thinking blocks for provider resume', () => {
    expect(
      projectClaudeModelMessages([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'reason', signature: 'signed' },
              { type: 'redacted_thinking', data: 'opaque' },
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'Read',
                input: {},
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: '',
        thinkingBlocks: [
          { type: 'thinking', thinking: 'reason', signature: 'signed' },
          { type: 'redacted_thinking', data: 'opaque' },
        ],
        toolCalls: [{ id: 'call_1', name: 'Read', input: {} }],
      },
    ])
  })

  it('projects native Claude user images for resume', () => {
    expect(
      projectClaudeModelMessages([
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'inspect' },
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
        },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: 'inspect',
        images: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
      },
    ])
  })

  it('projects native Claude user documents for resume', () => {
    expect(
      projectClaudeModelMessages([
        {
          type: 'user',
          message: {
            role: 'user',
            content: [
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
        },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: '',
        documents: [
          { type: 'document', mediaType: 'application/pdf', data: 'JVBERg==' },
        ],
      },
    ])
  })

  it('keeps every tool result adjacent when a Read activates a rule', () => {
    const entries = [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_read',
              name: 'Read',
              input: { file_path: 'src/app.ts' },
            },
            {
              type: 'tool_use',
              id: 'call_grep',
              name: 'Grep',
              input: { pattern: 'value' },
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
              content: 'export const value = 1',
            },
          ],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'nested_memory',
          path: '/workspace/.claude/rules/typescript.md',
          content: { content: 'USE_TYPESCRIPT\n' },
          displayPath: '.claude/rules/typescript.md',
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_grep',
              content: 'src/app.ts:1:value',
            },
          ],
        },
      },
    ]

    expect(projectClaudeModelMessages(entries)).toEqual([
      { role: 'system', content: 'USE_TYPESCRIPT\n' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_read',
            name: 'Read',
            input: { file_path: 'src/app.ts' },
          },
          {
            id: 'call_grep',
            name: 'Grep',
            input: { pattern: 'value' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_read',
        content: 'export const value = 1',
        isError: false,
      },
      {
        role: 'tool',
        toolCallId: 'call_grep',
        content: 'src/app.ts:1:value',
        isError: false,
      },
    ])
  })

  it('keeps structured media and error tool results paired', async () => {
    const fixture = new URL(
      '../../../test/fixtures/claude-code/2.1.208/media-error-session.jsonl',
      import.meta.url,
    )
    const entries = (await readFile(fixture, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))

    expect(projectClaudeModelMessages(entries)).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_read_fixture',
            name: 'Read',
            input: { file_path: '/tmp/praxis-fixture/fixture.png' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_read_fixture',
        content: '',
        images: [
          {
            type: 'image',
            mediaType: 'image/png',
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
          },
        ],
        isError: false,
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_error_fixture',
            name: 'Bash',
            input: { command: "sh -c 'echo fixture-error >&2; exit 7'" },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_error_fixture',
        content: 'Exit code 7\nfixture-error',
        isError: true,
      },
    ])
  })

  it('preserves ordered content blocks only for native MCP results', () => {
    const blocks = [
      { type: 'text', text: 'before' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aGVsbG8=',
        },
      },
    ]
    expect(
      projectClaudeModelMessages([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_mcp',
                name: 'mcp__fixture__media',
                input: {},
              },
            ],
          },
        },
        {
          type: 'user',
          toolUseResult: blocks,
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_mcp',
                content: blocks,
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_mcp', name: 'mcp__fixture__media', input: {} }],
      },
      {
        role: 'tool',
        toolCallId: 'call_mcp',
        content: 'before',
        contentBlocks: [
          { type: 'text', text: 'before' },
          { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
        ],
        images: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
        isError: false,
      },
    ])
  })

  it('projects document blocks from native tool results', () => {
    expect(
      projectClaudeModelMessages([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_document',
                name: 'Read',
                input: { file_path: '/tmp/report.pdf' },
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
                tool_use_id: 'call_document',
                content: [
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
            ],
          },
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call_document',
            name: 'Read',
            input: { file_path: '/tmp/report.pdf' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_document',
        content: '',
        documents: [
          { type: 'document', mediaType: 'application/pdf', data: 'JVBERg==' },
        ],
        isError: false,
      },
    ])
  })

  it('projects only the latest compact summary and later messages', () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: 'DROPPED_USER' } },
      {
        type: 'attachment',
        attachment: {
          type: 'hook_additional_context',
          content: ['DROPPED_HOOK_CONTEXT'],
        },
      },
      {
        type: 'attachment',
        attachment: {
          type: 'nested_memory',
          content: { content: 'PERSISTED_RULE' },
        },
      },
      {
        type: 'user',
        isCompactSummary: true,
        message: { role: 'user', content: 'COMPACT_SUMMARY' },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'AFTER_COMPACT' }],
        },
      },
    ]

    expect(projectClaudeTextMessages(entries)).toEqual([
      { role: 'user', content: 'COMPACT_SUMMARY' },
      { role: 'assistant', content: 'AFTER_COMPACT' },
    ])
    expect(projectClaudeModelMessages(entries)).toEqual([
      { role: 'system', content: 'PERSISTED_RULE' },
      { role: 'user', content: 'COMPACT_SUMMARY' },
      { role: 'assistant', content: 'AFTER_COMPACT' },
    ])
  })

  it('builds deterministic sidechain continuation context from complete tool pairs and replacements', () => {
    const entries = [
      { type: 'user', message: { role: 'user', content: 'ROOT_PROMPT' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'paired thought', signature: 'sig' },
            {
              type: 'tool_use',
              id: 'call_complete',
              name: 'Read',
              input: { file_path: '/tmp/a' },
            },
            {
              type: 'tool_use',
              id: 'call_dangling',
              name: 'Read',
              input: { file_path: '/tmp/b' },
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
              tool_use_id: 'call_complete',
              content: 'ORIGINAL_RESULT',
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'orphan thought', signature: 'sig' },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '   ' }],
        },
      },
      {
        type: 'content-replacement',
        replacements: [
          {
            kind: 'tool-result',
            toolUseId: 'call_complete',
            replacement: 'RECONSTRUCTED_RESULT',
          },
        ],
      },
    ]

    expect(projectClaudeSidechainContinuationMessages(entries)).toEqual([
      { role: 'user', content: 'ROOT_PROMPT' },
      {
        role: 'assistant',
        content: '',
        thinkingBlocks: [
          { type: 'thinking', thinking: 'paired thought', signature: 'sig' },
        ],
        toolCalls: [
          {
            id: 'call_complete',
            name: 'Read',
            input: { file_path: '/tmp/a' },
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_complete',
        content: 'RECONSTRUCTED_RESULT',
        isError: false,
      },
    ])
  })

  it('fails sidechain continuation locally for duplicate tool IDs', () => {
    const duplicate = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'duplicate', name: 'Read', input: {} },
        ],
      },
    }
    expect(() =>
      projectClaudeSidechainContinuationMessages([duplicate, duplicate]),
    ).toThrow('duplicate tool ID duplicate')
  })
})
