import { describe, expect, it } from 'vitest'

import { translateProviderEvents } from './translation.js'

describe('provider to Claude transcript translation', () => {
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
})
