import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import {
  createClaudeLastPromptEntry,
  translateProviderEvents,
} from './translation.js'

const toolFixtureUrl = new URL(
  '../../../test/fixtures/claude-code/2.1.208/tool-session.jsonl',
  import.meta.url,
)

describe('provider to Claude transcript translation', () => {
  it('creates native last-prompt metadata for the final assistant leaf', () => {
    expect(
      createClaudeLastPromptEntry({
        sessionId: '20000000-0000-4000-8000-000000000001',
        lastPrompt: 'inspect the repo',
        leafUuid: '10000000-0000-4000-8000-000000000004',
      }),
    ).toEqual({
      type: 'last-prompt',
      lastPrompt: 'inspect the repo',
      sessionId: '20000000-0000-4000-8000-000000000001',
      leafUuid: '10000000-0000-4000-8000-000000000004',
    })
  })

  it('creates a native parentUuid chain for text and tool events', () => {
    const uuids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
    ][Symbol.iterator]()
    let second = 0

    const entries = translateProviderEvents(
      [
        { type: 'user-text', text: 'inspect the repo' },
        {
          type: 'assistant-tool-call',
          toolCallId: 'call_fixture',
          name: 'Bash',
          input: { command: 'pwd' },
          providerMessageId: 'provider-message-1',
          model: 'provider/model',
        },
        {
          type: 'tool-result',
          toolCallId: 'call_fixture',
          content: '/tmp/project',
          isError: false,
        },
        {
          type: 'assistant-text',
          text: 'done',
          providerMessageId: 'provider-message-2',
          model: 'provider/model',
        },
      ],
      {
        sessionId: '20000000-0000-4000-8000-000000000001',
        parentUuid: null,
        cwd: '/tmp/project',
        claudeVersion: '2.1.208',
        gitBranch: 'main',
        createUuid: () => {
          const next = uuids.next()
          if (next.done) throw new Error('UUID fixture exhausted')
          return next.value
        },
        now: () => `2026-08-03T08:00:0${second++}.000Z`,
      },
    )

    expect(entries.map((entry) => entry.uuid)).toEqual([
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
      '10000000-0000-4000-8000-000000000004',
    ])
    expect(entries.map((entry) => entry.parentUuid)).toEqual([
      null,
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
    ])
    expect(entries[1]?.message).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'call_fixture',
          name: 'Bash',
          input: { command: 'pwd' },
        },
      ],
    })
    expect(entries[2]?.message).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_fixture',
          content: '/tmp/project',
          is_error: false,
        },
      ],
    })
    expect(entries[3]?.message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
    })
  })

  it('persists text and multiple tool calls as one native assistant message', () => {
    const [entry] = translateProviderEvents(
      [
        {
          type: 'assistant-message',
          text: 'I will inspect both files.',
          toolCalls: [
            {
              id: 'call_one',
              name: 'Read',
              input: { file_path: 'one.txt' },
            },
            {
              id: 'call_two',
              name: 'Read',
              input: { file_path: 'two.txt' },
            },
          ],
          providerMessageId: 'provider-message',
          model: 'provider/model',
        },
      ],
      {
        sessionId: '20000000-0000-4000-8000-000000000001',
        parentUuid: null,
        cwd: '/tmp/project',
        claudeVersion: '2.1.208',
        gitBranch: null,
        createUuid: () => '10000000-0000-4000-8000-000000000001',
        now: () => '2026-08-03T08:00:00.000Z',
      },
    )

    expect(entry?.message).toMatchObject({
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'I will inspect both files.' },
        {
          type: 'tool_use',
          id: 'call_one',
          name: 'Read',
          input: { file_path: 'one.txt' },
        },
        {
          type: 'tool_use',
          id: 'call_two',
          name: 'Read',
          input: { file_path: 'two.txt' },
        },
      ],
    })
  })

  it('does not persist provider-native payloads or reasoning', () => {
    const [entry] = translateProviderEvents(
      [
        {
          type: 'assistant-text',
          text: 'answer',
          providerMessageId: 'provider-message',
          model: 'provider/model',
        },
      ],
      {
        sessionId: '20000000-0000-4000-8000-000000000001',
        parentUuid: null,
        cwd: '/tmp/project',
        claudeVersion: '2.1.208',
        gitBranch: null,
        createUuid: () => '10000000-0000-4000-8000-000000000001',
        now: () => '2026-08-03T08:00:00.000Z',
      },
    )

    expect(JSON.stringify(entry)).not.toContain('providerPayload')
    expect(JSON.stringify(entry)).not.toContain('reasoning')
  })

  it('matches Claude 2.1.208 black-box tool envelope fields', async () => {
    const [toolCallLine, toolResultLine] = (
      await readFile(toolFixtureUrl, 'utf8')
    )
      .trimEnd()
      .split('\n')
    if (!toolCallLine || !toolResultLine)
      throw new Error('Invalid tool fixture')
    const nativeToolCall = JSON.parse(toolCallLine)
    const nativeToolResult = JSON.parse(toolResultLine)

    const [toolCall, toolResult] = translateProviderEvents(
      [
        {
          type: 'assistant-tool-call',
          toolCallId: 'call_fixture',
          name: 'Bash',
          input: {
            command: 'printf praxis-tool-fixture',
            description: 'Run printf praxis-tool-fixture',
          },
          providerMessageId: 'msg_tool_fixture',
          model: 'claude-fixture',
        },
        {
          type: 'tool-result',
          toolCallId: 'call_fixture',
          content: 'praxis-tool-fixture',
          isError: false,
        },
      ],
      {
        sessionId: '11111111-1111-4111-8111-111111111111',
        parentUuid: '99999999-9999-4999-8999-999999999999',
        cwd: '/tmp/praxis-fixture',
        claudeVersion: '2.1.208',
        gitBranch: 'HEAD',
        createUuid: (() => {
          const values = [
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          ]
          return () => {
            const value = values.shift()
            if (!value) throw new Error('UUID fixture exhausted')
            return value
          }
        })(),
        now: (() => {
          let index = 0
          return () => `2026-08-03T08:00:0${index++}.000Z`
        })(),
      },
    )

    expect(toolCall?.message).toEqual(nativeToolCall.message)
    expect(toolResult?.message).toEqual(nativeToolResult.message)
    expect(toolResult?.sourceToolAssistantUUID).toBe(
      nativeToolResult.sourceToolAssistantUUID,
    )
    expect(toolResult?.toolUseResult).toEqual(nativeToolResult.toolUseResult)
  })

  it('can persist a recovered tool result in a later translation call', () => {
    const [toolResult] = translateProviderEvents(
      [
        {
          type: 'tool-result',
          toolCallId: 'call_fixture',
          content: 'recovered',
          isError: false,
        },
      ],
      {
        sessionId: '11111111-1111-4111-8111-111111111111',
        parentUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        cwd: '/tmp/praxis-fixture',
        claudeVersion: '2.1.208',
        gitBranch: null,
        history: [
          {
            type: 'assistant',
            uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            message: {
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'call_fixture' }],
            },
          },
        ],
        createUuid: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        now: () => '2026-08-03T08:00:01.000Z',
      },
    )

    expect(toolResult?.sourceToolAssistantUUID).toBe(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )
  })
})
