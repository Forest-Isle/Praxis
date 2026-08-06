import { describe, expect, it } from 'vitest'

import {
  parseCliInvocation,
  readStreamUserMessages,
  StreamJsonOutput,
  type CliRuntimeInfo,
} from './protocol.js'

const sessionId = '11111111-1111-4111-8111-111111111111'

const runtimeInfo: CliRuntimeInfo = {
  cwd: '/workspace',
  model: 'test-model',
  tools: ['Read'],
  mcpServers: [],
  permissionMode: 'default',
  slashCommands: ['review'],
  agents: ['reviewer'],
  skills: ['review'],
  claudeCodeVersion: '2.1.208',
}

async function collectInput(chunks: readonly (string | Uint8Array)[]) {
  const input = (async function* () {
    for (const chunk of chunks) yield chunk
  })()
  const messages = []
  for await (const message of readStreamUserMessages(input)) {
    messages.push(message)
  }
  return messages
}

describe('CLI protocol', () => {
  it('normalizes Claude-style print, resume, format, agent, and session options', () => {
    expect(
      parseCliInvocation([
        '-p',
        '--output-format=json',
        '--session-id',
        sessionId,
        '--agent',
        'reviewer',
        'hello',
      ]),
    ).toMatchObject({
      command: 'hello',
      args: ['hello'],
      print: true,
      outputFormat: 'json',
      inputFormat: 'text',
      sessionId,
      agent: 'reviewer',
    })
    expect(parseCliInvocation(['-r', sessionId, 'continue'])).toMatchObject({
      command: 'resume',
      args: ['resume', sessionId, 'continue'],
    })
  })

  it('parses top-level background agent controls', () => {
    expect(
      parseCliInvocation([
        '--background',
        '--session-id',
        sessionId,
        '--bare',
        'finish task',
      ]),
    ).toMatchObject({
      args: ['finish task'],
      background: true,
      print: false,
      sessionId,
    })
    expect(
      parseCliInvocation(['agents', '--json', '--all', '--cwd', '/workspace']),
    ).toMatchObject({
      command: 'agents',
      args: ['agents'],
      agentsAll: true,
      agentsCwd: '/workspace',
      legacyJson: true,
    })
    expect(parseCliInvocation(['logs', 'abcd1234'])).toMatchObject({
      command: 'logs',
      args: ['logs', 'abcd1234'],
    })
    expect(parseCliInvocation(['stop', 'abcd1234'])).toMatchObject({
      command: 'stop',
      args: ['stop', 'abcd1234'],
    })
    expect(parseCliInvocation(['attach', 'abcd1234'])).toMatchObject({
      command: 'attach',
      args: ['attach', 'abcd1234'],
    })
  })

  it('parses worktree and tmux controls', () => {
    expect(
      parseCliInvocation([
        '--worktree',
        'review',
        '--tmux=classic',
        '--',
        'prompt',
      ]),
    ).toMatchObject({
      worktreeRequested: true,
      worktreeName: 'review',
      tmux: 'classic',
      args: ['prompt'],
    })
    expect(parseCliInvocation(['--worktree', '--', 'prompt'])).toMatchObject({
      worktreeRequested: true,
      args: ['prompt'],
    })
    expect(() => parseCliInvocation(['--tmux', 'prompt'])).toThrow(
      '--tmux requires --worktree',
    )
  })

  it('parses model effort fallback and structured output controls', () => {
    expect(
      parseCliInvocation([
        '-p',
        '--model',
        'sonnet',
        '--effort=xhigh',
        '--fallback-model',
        'haiku,opus',
        '--json-schema',
        '{"type":"object","required":["answer"]}',
        '--max-budget-usd=0.25',
        'prompt',
      ]),
    ).toMatchObject({
      print: true,
      model: 'sonnet',
      effort: 'xhigh',
      fallbackModels: ['haiku', 'opus'],
      jsonSchema: { type: 'object', required: ['answer'] },
      maxBudgetUsd: 0.25,
      args: ['prompt'],
    })
    expect(() => parseCliInvocation(['--effort', 'turbo'])).toThrow(
      '--effort must be one of',
    )
    expect(() => parseCliInvocation(['--json-schema', '{invalid'])).toThrow(
      'valid JSON',
    )
  })

  it('parses and restricts prompt suggestions', () => {
    expect(
      parseCliInvocation([
        '-p',
        '--output-format=stream-json',
        '--verbose',
        '--prompt-suggestions',
        'hello',
      ]),
    ).toMatchObject({ promptSuggestions: true })
    expect(
      parseCliInvocation([
        '-p',
        '--output-format=stream-json',
        '--verbose',
        '--prompt-suggestions=false',
      ]),
    ).toMatchObject({ promptSuggestions: false })
    expect(() => parseCliInvocation(['--prompt-suggestions'])).toThrow(
      '--prompt-suggestions requires --print and --output-format=stream-json',
    )
    expect(() =>
      parseCliInvocation([
        '-p',
        '--output-format=stream-json',
        '--verbose',
        '--prompt-suggestions=maybe',
      ]),
    ).toThrow('must be a boolean')
  })

  it('parses single-user CLI customization, tool, permission, and session controls', () => {
    expect(
      parseCliInvocation([
        '-p',
        '--settings',
        '{"model":"fixture"}',
        '--setting-sources=project,local',
        '--safe-mode',
        '--bare',
        '--system-prompt-file',
        'system.txt',
        '--append-system-prompt',
        'append',
        '--add-dir',
        '../one',
        '../two',
        '--tools=Read,Write',
        '--allowed-tools',
        'Write',
        '--disallowedTools=Bash(rm *)',
        '--permission-mode',
        'acceptEdits',
        '--dangerously-skip-permissions',
        '--allow-dangerously-skip-permissions',
        '--continue',
        '--fork-session',
        '--name',
        'fixture',
        '--no-session-persistence',
        '--',
        'hello',
      ]),
    ).toMatchObject({
      args: ['hello'],
      settings: '{"model":"fixture"}',
      settingSources: ['project', 'local'],
      safeMode: true,
      bare: true,
      systemPromptFile: 'system.txt',
      appendSystemPrompt: 'append',
      addDirectories: ['../one', '../two'],
      tools: ['Read', 'Write'],
      allowedTools: ['Write'],
      disallowedTools: ['Bash(rm *)'],
      permissionMode: 'acceptEdits',
      dangerouslySkipPermissions: true,
      allowDangerouslySkipPermissions: true,
      continueSession: true,
      forkSession: true,
      name: 'fixture',
      sessionPersistence: false,
    })
    expect(
      parseCliInvocation(['--setting-sources=', '--tools=', '--', 'hello']),
    ).toMatchObject({ settingSources: [], tools: [] })
  })

  it('rejects conflicting prompt sources and invalid customization choices', () => {
    for (const argv of [
      ['--system-prompt', 'direct', '--system-prompt-file', 'prompt.txt'],
      [
        '--append-system-prompt',
        'direct',
        '--append-system-prompt-file',
        'prompt.txt',
      ],
      ['--setting-sources', 'user,bogus', 'hello'],
      ['--permission-mode', 'unknown', 'hello'],
    ]) {
      expect(() => parseCliInvocation(argv)).toThrow()
    }
  })

  it('enforces machine protocol option relationships', () => {
    for (const argv of [
      ['-p', '--input-format', 'stream-json'],
      ['-p', '--output-format', 'stream-json', 'hello'],
      ['-p', '--include-partial-messages', 'hello'],
      ['-p', '--replay-user-messages', 'hello'],
      ['-p', '--session-id', 'not-a-uuid', 'hello'],
      ['resume', sessionId, '--session-id', sessionId, 'hello'],
      ['-p', '--continue', '--session-id', sessionId, 'hello'],
      ['-p', '--input-format', 'stream-json', '--json'],
      ['-p', '--include-partial-messages', '--json', 'hello'],
    ]) {
      expect(() => parseCliInvocation(argv)).toThrow()
    }
    expect(
      parseCliInvocation([
        '-p',
        '--continue',
        '--fork-session',
        '--session-id',
        sessionId,
        'hello',
      ]),
    ).toMatchObject({
      continueSession: true,
      forkSession: true,
      sessionId,
    })
  })

  it('parses multiple user messages across CRLF and UTF-8 chunk boundaries', async () => {
    const first = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'first' },
    })}\r\n`
    const second = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '第二条' }],
      },
    })}\n`
    const bytes = new TextEncoder().encode(`${first}${second}`)
    const split = bytes.indexOf(0xe4) + 1
    const messages = await collectInput([
      bytes.slice(0, split),
      bytes.slice(split, split + 1),
      bytes.slice(split + 1),
    ])
    expect(messages).toEqual([
      { message: { role: 'user', content: 'first' }, prompt: 'first' },
      {
        message: {
          role: 'user',
          content: [{ type: 'text', text: '第二条' }],
        },
        prompt: '第二条',
      },
    ])
  })

  it('rejects invalid UTF-8, non-user records, unsupported blocks, and oversized lines', async () => {
    await expect(collectInput([Uint8Array.from([0xff, 0x0a])])).rejects.toThrow(
      'valid UTF-8',
    )
    await expect(
      collectInput([
        `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x' } })}\n`,
      ]),
    ).rejects.toThrow('type user')
    await expect(
      collectInput([
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'image' }] } })}\n`,
      ]),
    ).rejects.toThrow('unsupported content')
    await expect(
      collectInput([
        `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1024 * 1024) } })}\n`,
      ]),
    ).rejects.toThrow('exceeds')
  })

  it('emits init, assistant tool use, tool result, final assistant, and result envelopes', () => {
    const records: unknown[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record),
      runtimeInfo,
      sessionId,
      false,
    )
    output.init()
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'text-delta', delta: 'checking' })
    output.sink({
      type: 'tool-call',
      call: { id: 'tool-1', name: 'Read', input: { file_path: 'a.txt' } },
    })
    output.sink({
      type: 'usage',
      usage: { inputTokens: 2, outputTokens: 3 },
    })
    output.sink({
      type: 'permission-decision',
      callId: 'tool-1',
      behavior: 'allow',
    })
    output.sink({
      type: 'tool-result',
      callId: 'tool-1',
      content: 'contents',
      isError: false,
    })
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'text-delta', delta: 'done' })
    output.sink({
      type: 'usage',
      usage: { inputTokens: 4, outputTokens: 1 },
    })
    output.sink({ type: 'state', state: 'completed' })
    output.result(
      {
        sessionId,
        text: 'done',
        usage: { inputTokens: 6, outputTokens: 4 },
      },
      Date.now(),
    )

    expect(records.map((record) => (record as { type: string }).type)).toEqual([
      'system',
      'assistant',
      'user',
      'assistant',
      'result',
    ])
    expect(records[1]).toMatchObject({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'checking' },
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'a.txt' },
          },
        ],
      },
    })
    expect(records[2]).toMatchObject({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'contents' },
        ],
      },
    })
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      num_turns: 2,
      result: 'done',
      session_id: sessionId,
      duration_api_ms: null,
      total_cost_usd: null,
      modelUsage: {
        'test-model': { costUSD: null },
      },
    })
  })

  it('emits complete partial text and tool event sequences when requested', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      true,
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'text-delta', delta: 'x' })
    output.sink({
      type: 'tool-call',
      call: { id: 'tool-1', name: 'Read', input: { file_path: 'a.txt' } },
    })
    output.sink({ type: 'state', state: 'executing-tools' })

    const eventTypes = records
      .filter((record) => record.type === 'stream_event')
      .map((record) => (record.event as { type: string }).type)
    expect(eventTypes).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'stream_event',
        event: expect.objectContaining({
          type: 'content_block_delta',
          delta: {
            type: 'input_json_delta',
            partial_json: '{"file_path":"a.txt"}',
          },
        }),
      }),
    )
  })

  it('emits prompt suggestion records after the result', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      false,
    )
    output.result(
      { sessionId, text: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
      Date.now(),
    )
    output.promptSuggestion('continue the implementation')
    expect(records.map((record) => record.type)).toEqual([
      'result',
      'prompt_suggestion',
    ])
    expect(records[1]).toMatchObject({
      type: 'prompt_suggestion',
      suggestion: 'continue the implementation',
      session_id: sessionId,
      uuid: expect.any(String),
    })
  })

  it('emits a terminal error result without resetting session identity', () => {
    const records: unknown[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record),
      runtimeInfo,
      sessionId,
      false,
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({
      type: 'failed',
      message: 'provider failed',
      retryable: false,
    })
    output.error('provider failed', Date.now())
    expect(records.map((record) => (record as { type: string }).type)).toEqual([
      'assistant',
      'result',
    ])
    expect(records[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'provider failed' }],
      },
    })
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'provider failed',
      session_id: sessionId,
      num_turns: 1,
      duration_api_ms: null,
      total_cost_usd: null,
    })
  })
})
