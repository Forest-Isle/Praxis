import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  getClaudeAgentSetting,
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
})
