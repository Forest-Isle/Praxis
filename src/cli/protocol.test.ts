import { describe, expect, it } from 'vitest'

import {
  createErrorResult,
  parseCliInvocation,
  readStreamJsonMessages,
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
  plugins: [{ name: 'fixture-plugin', path: '/plugins/fixture' }],
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
  it('parses setup lifecycle controls without exposing them as prompt arguments', () => {
    expect(
      parseCliInvocation([
        '--init',
        '--maintenance',
        '--init-only',
        '--session-id',
        sessionId,
        'ignored prompt',
      ]),
    ).toMatchObject({
      init: true,
      maintenance: true,
      initOnly: true,
      sessionId,
      args: ['ignored prompt'],
    })
  })

  it('parses standalone file rewind controls', () => {
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const messageId = '22222222-2222-4222-8222-222222222222'
    expect(
      parseCliInvocation(['--resume', sessionId, '--rewind-files', messageId]),
    ).toMatchObject({
      command: 'resume',
      args: ['resume', sessionId],
      rewindFiles: messageId,
    })
    expect(() => parseCliInvocation(['--rewind-files', messageId])).toThrow(
      '--rewind-files requires --resume',
    )
  })
  it('classifies terminal result errors into SDK subtypes', () => {
    expect(
      createErrorResult(
        'Maximum budget of $1.000000 exceeded',
        sessionId,
        Date.now(),
        2,
      ),
    ).toMatchObject({
      subtype: 'error_max_budget_usd',
      errors: ['Maximum budget of $1.000000 exceeded'],
    })
    expect(
      createErrorResult(
        'StructuredOutput must be called exactly once',
        sessionId,
        Date.now(),
        2,
      ),
    ).toMatchObject({ subtype: 'error_max_structured_output_retries' })
  })

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

  it('parses resume-at only with an explicit --resume selector', () => {
    expect(
      parseCliInvocation([
        '-p',
        '--resume',
        sessionId,
        '--resume-session-at',
        'user-message-uuid',
        'continue',
      ]),
    ).toMatchObject({
      args: ['resume', sessionId, 'continue'],
      resumeSessionAt: 'user-message-uuid',
    })
    expect(
      parseCliInvocation([
        '--background',
        '--resume',
        sessionId,
        '--resume-session-at=user-message-uuid',
        '--fork-session',
        'continue',
      ]),
    ).toMatchObject({
      background: true,
      forkSession: true,
      resumeSessionAt: 'user-message-uuid',
    })
    for (const argv of [
      ['--resume-session-at', 'user-message-uuid', 'start'],
      ['--continue', '--resume-session-at', 'user-message-uuid', 'continue'],
      [
        'resume',
        sessionId,
        '--resume-session-at',
        'user-message-uuid',
        'continue',
      ],
    ]) {
      expect(() => parseCliInvocation(argv)).toThrow(
        '--resume-session-at requires --resume',
      )
    }
    expect(() =>
      parseCliInvocation([
        '--resume',
        sessionId,
        '--resume-session-at',
        'one',
        '--resume-session-at',
        'two',
      ]),
    ).toThrow('--resume-session-at may only be specified once')
  })

  it('parses hidden permission prompt MCP tool controls with last-value precedence', () => {
    expect(
      parseCliInvocation([
        '-p',
        '--permission-prompt-tool',
        'mcp__first__approve',
        '--permission-prompt-tool=mcp__second__approve',
        '--',
        'run',
      ]),
    ).toMatchObject({
      permissionPromptTool: 'mcp__second__approve',
      args: ['run'],
    })
    expect(() =>
      parseCliInvocation(['-p', '--permission-prompt-tool']),
    ).toThrow("option '--permission-prompt-tool <tool>' argument missing")
  })

  it('parses PR-linked resume selectors and rejects conflicting resume modes', () => {
    expect(parseCliInvocation(['--from-pr'])).toMatchObject({ fromPr: true })
    expect(
      parseCliInvocation(['--from-pr=owner/repo#42', '--', 'continue']),
    ).toMatchObject({
      fromPr: 'owner/repo#42',
      args: ['continue'],
    })
    expect(() =>
      parseCliInvocation(['--from-pr=42', '--resume', sessionId]),
    ).toThrow('cannot be combined')
    expect(() => parseCliInvocation(['--from-pr=42', '--continue'])).toThrow(
      'cannot be combined',
    )
    expect(() => parseCliInvocation(['--from-pr='])).toThrow(
      'must not be empty',
    )
    expect(() =>
      parseCliInvocation(['--from-pr=42', '--session-id', sessionId]),
    ).toThrow('if --fork-session is also specified')
    expect(() =>
      parseCliInvocation(['--bg', '--from-pr=42', '--session-id', sessionId]),
    ).toThrow('if --fork-session is also specified')
    expect(
      parseCliInvocation([
        '--from-pr=42',
        '--fork-session',
        '--session-id',
        sessionId,
      ]),
    ).toMatchObject({ fromPr: '42', forkSession: true, sessionId })
  })

  it('parses variadic startup file resources', () => {
    expect(
      parseCliInvocation([
        '--file',
        'file_a:docs/a.txt',
        'file_b:images/b.png',
        '--file=file_c:notes/c.md',
        'prompt',
      ]),
    ).toMatchObject({
      fileResources: [
        'file_a:docs/a.txt',
        'file_b:images/b.png',
        'file_c:notes/c.md',
      ],
      args: ['prompt'],
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

  it('accepts Claude 2.1.208 prefill syntax as a baseline no-op', () => {
    expect(
      parseCliInvocation([
        '-p',
        '--prefill',
        'first',
        '--prefill=last',
        'prompt',
      ]),
    ).toMatchObject({ prefill: 'last', args: ['prompt'] })
    expect(parseCliInvocation(['--prefill=', 'prompt'])).toMatchObject({
      prefill: '',
      args: ['prompt'],
    })
    expect(() => parseCliInvocation(['--prefill'])).toThrow(
      '--prefill is required',
    )
    expect(() => parseCliInvocation(['--prefill', '--print'])).toThrow(
      '--prefill is required',
    )
  })

  it('parses and validates thinking controls', () => {
    expect(
      parseCliInvocation([
        '--thinking',
        'adaptive',
        '--max-thinking-tokens=4096',
        'prompt',
      ]),
    ).toMatchObject({
      thinking: 'adaptive',
      maxThinkingTokens: 4096,
      args: ['prompt'],
    })
    expect(parseCliInvocation(['--thinking=disabled', 'prompt'])).toMatchObject(
      { thinking: 'disabled' },
    )
    expect(() => parseCliInvocation(['--thinking', 'automatic'])).toThrow(
      '--thinking must be one of enabled, adaptive, disabled',
    )
    expect(() => parseCliInvocation(['--max-thinking-tokens', '0'])).toThrow(
      '--max-thinking-tokens must be a positive integer',
    )
    expect(() =>
      parseCliInvocation([
        '--thinking',
        'disabled',
        '--max-thinking-tokens',
        '1024',
      ]),
    ).toThrow('cannot be combined with --thinking=disabled')
    expect(() =>
      parseCliInvocation(['--thinking', 'enabled', '--thinking', 'adaptive']),
    ).toThrow('--thinking may only be specified once')
  })

  it('parses print-only turn and beta controls', () => {
    expect(
      parseCliInvocation([
        '-p',
        '--max-turns',
        '3',
        '--betas',
        'context-1m-2025-08-07',
        'second-beta',
        '--',
        'prompt',
      ]),
    ).toMatchObject({
      maxTurns: 3,
      betas: ['context-1m-2025-08-07', 'second-beta'],
      args: ['prompt'],
    })
    expect(() => parseCliInvocation(['--max-turns', '3'])).toThrow(
      '--max-turns requires --print',
    )
    expect(() => parseCliInvocation(['-p', '--max-turns', '0'])).toThrow(
      'positive integer',
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

  it('parses MCP management scope', () => {
    expect(
      parseCliInvocation(['mcp', '--scope', 'project', 'list']),
    ).toMatchObject({
      command: 'mcp',
      args: ['mcp', 'list'],
      mcpScope: 'project',
    })
    expect(() =>
      parseCliInvocation(['mcp', '--scope', 'invalid', 'list']),
    ).toThrow('--scope must be one of')
  })

  it('parses MCP OAuth and stdio server controls', () => {
    expect(
      parseCliInvocation(['mcp', 'login', 'fixture', '--no-browser']),
    ).toMatchObject({
      command: 'mcp',
      args: ['mcp', 'login', 'fixture'],
      mcpNoBrowser: true,
      mcpDebug: false,
    })
    expect(
      parseCliInvocation(['mcp', 'serve', '-d', '--verbose']),
    ).toMatchObject({
      command: 'mcp',
      args: ['mcp', 'serve'],
      mcpNoBrowser: false,
      mcpDebug: true,
      debug: true,
      verbose: true,
    })
    expect(parseCliInvocation(['-d', 'hello'])).toMatchObject({
      debug: true,
      args: ['hello'],
      mcpDebug: false,
    })
    expect(
      parseCliInvocation([
        '--debug=hooks',
        '--debug-file',
        'debug.log',
        'hello',
      ]),
    ).toMatchObject({ debug: 'hooks', debugFile: 'debug.log' })
    expect(
      parseCliInvocation(['--brief', '--ax-screen-reader', 'prompt']),
    ).toMatchObject({ brief: true, axScreenReader: true })
    expect(parseCliInvocation(['mcp', 'serve', '--mcp-debug'])).toMatchObject({
      mcpDebug: true,
    })
  })

  it('parses complete MCP add controls and preserves subprocess arguments', () => {
    expect(
      parseCliInvocation([
        'mcp',
        'add',
        'fixture',
        '-e',
        'ONE=1',
        '-e',
        'TWO=two',
        '-H',
        'Authorization: Bearer fixture',
        '-H',
        'X-Test: yes',
        '-s',
        'user',
        '-t',
        'streamable-http',
        '--callback-port',
        '4321',
        '--client-id',
        'fixture-client',
        '--client-secret',
        '--',
        'node',
        'server.mjs',
        '--flag',
      ]),
    ).toMatchObject({
      command: 'mcp',
      args: ['mcp', 'add', 'fixture', 'node', 'server.mjs', '--flag'],
      mcpScope: 'user',
      mcpTransport: 'http',
      mcpEnv: ['ONE=1', 'TWO=two'],
      mcpHeaders: ['Authorization: Bearer fixture', 'X-Test: yes'],
      mcpCallbackPort: '4321',
      mcpClientId: 'fixture-client',
      mcpClientSecret: true,
    })
    expect(() =>
      parseCliInvocation(['mcp', 'add', '-t', 'websocket', 'fixture', 'node']),
    ).toThrow('Invalid transport type: websocket')
  })

  it('parses repeatable local plugin directories', () => {
    expect(
      parseCliInvocation([
        '--plugin-dir=/tmp/one',
        '--plugin-dir',
        '/tmp/two',
        'hello',
      ]),
    ).toMatchObject({
      pluginDirectories: ['/tmp/one', '/tmp/two'],
      args: ['hello'],
    })
  })

  it('parses inline agents and explicit MCP injection controls', () => {
    expect(
      parseCliInvocation([
        '--agents',
        '{"reviewer":{"description":"Review","prompt":"Review files"}}',
        '--mcp-config',
        'one.json',
        '{"mcpServers":{"fixture":{"command":"fixture"}}}',
        '--strict-mcp-config',
        '--disable-slash-commands',
        'hello',
      ]),
    ).toMatchObject({
      agentDefinitions:
        '{"reviewer":{"description":"Review","prompt":"Review files"}}',
      mcpConfigs: [
        'one.json',
        '{"mcpServers":{"fixture":{"command":"fixture"}}}',
      ],
      strictMcpConfig: true,
      disableSlashCommands: true,
      args: ['hello'],
    })
  })

  it('requires an option boundary after variadic MCP configs', () => {
    expect(
      parseCliInvocation(['--mcp-config', 'one.json', '--', 'prompt']),
    ).toMatchObject({ mcpConfigs: ['one.json'], args: ['prompt'] })
    expect(
      parseCliInvocation(['--mcp-config', 'one.json', 'prompt']),
    ).toMatchObject({ mcpConfigs: ['one.json', 'prompt'], args: [] })
  })

  it('parses repeatable plugin URLs', () => {
    expect(
      parseCliInvocation([
        '--plugin-url=https://example.test/one.zip',
        '--plugin-url',
        'https://example.test/two.zip',
        'hello',
      ]),
    ).toMatchObject({
      pluginUrls: [
        'https://example.test/one.zip',
        'https://example.test/two.zip',
      ],
      args: ['hello'],
    })
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
        '--exclude-dynamic-system-prompt-sections',
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
      excludeDynamicSystemPromptSections: true,
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
      ['-p', '--include-hook-events', 'hello'],
      [
        '-p',
        '--output-format',
        'stream-json',
        '--include-hook-events',
        '--json',
        'hello',
      ],
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

  it('parses Claude SDK control responses, cancellation, and interrupt requests', async () => {
    const input = [
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'permission-1',
          response: { behavior: 'allow', updatedInput: {} },
        },
      }),
      JSON.stringify({
        type: 'control_cancel_request',
        request_id: 'permission-2',
      }),
      JSON.stringify({
        type: 'control_request',
        request_id: 'interrupt-1',
        request: { subtype: 'interrupt' },
      }),
    ].join('\n')
    const messages = []
    const chunks = (async function* () {
      yield input
    })()
    for await (const message of readStreamJsonMessages(chunks))
      messages.push(message)
    expect(messages).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'permission-1',
          response: { behavior: 'allow', updatedInput: {} },
        },
      },
      { type: 'control_cancel_request', request_id: 'permission-2' },
      {
        type: 'control_request',
        request_id: 'interrupt-1',
        request: { subtype: 'interrupt' },
      },
    ])
  })

  it('parses Claude image content blocks into provider-neutral attachments', async () => {
    const image = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    }
    const [message] = await collectInput([
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'inspect' }, image],
        },
      })}\n`,
    ])
    expect(message).toEqual({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'inspect' }, image],
      },
      prompt: 'inspect',
      images: [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }],
    })
  })

  it('parses Claude document content blocks into provider-neutral attachments', async () => {
    const document = {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'JVBERg==',
      },
    }
    const [message] = await collectInput([
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [document] },
      })}\n`,
    ])
    expect(message).toEqual({
      message: { role: 'user', content: [document] },
      prompt: '',
      documents: [
        { type: 'document', mediaType: 'application/pdf', data: 'JVBERg==' },
      ],
    })
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

    expect(
      records
        .filter((record) => (record as { type: string }).type !== 'system')
        .map((record) => (record as { type: string }).type),
    ).toEqual(['assistant', 'user', 'assistant', 'result'])
    expect(
      records
        .filter((record) => (record as { type: string }).type === 'system')
        .map((record) => (record as { subtype: string }).subtype),
    ).toEqual(['init', 'session_state_changed', 'session_state_changed'])
    expect(records[0]).toMatchObject({
      subtype: 'init',
      output_style: 'default',
      plugins: [{ name: 'fixture-plugin', path: '/plugins/fixture' }],
      fast_mode_state: 'off',
      uuid: expect.any(String),
    })
    expect(
      records.find(
        (record) => (record as { type: string }).type === 'assistant',
      ),
    ).toMatchObject({
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
    expect(
      records.find((record) => (record as { type: string }).type === 'user'),
    ).toMatchObject({
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
      stop_reason: null,
      fast_mode_state: 'off',
      uuid: expect.any(String),
    })
  })

  it('emits SendUserMessage stream records', () => {
    const records: unknown[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record),
      runtimeInfo,
      sessionId,
      false,
    )
    output.sink({
      type: 'user-message',
      message: 'checkpoint',
      status: 'proactive',
      attachments: ['notes.md'],
    })
    expect(records).toContainEqual({
      type: 'user_message',
      message: 'checkpoint',
      status: 'proactive',
      attachments: ['notes.md'],
      uuid: expect.any(String),
      session_id: sessionId,
    })
  })

  it('emits hook lifecycle system records only when requested', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      false,
      true,
    )
    output.sink({
      type: 'hook',
      event: {
        type: 'started',
        hookId: 'hook-1',
        hookName: 'PreToolUse:Bash',
        hookEvent: 'PreToolUse',
      },
    })
    output.sink({
      type: 'hook',
      event: {
        type: 'progress',
        hookId: 'hook-1',
        hookName: 'PreToolUse:Bash',
        hookEvent: 'PreToolUse',
        stdout: 'out',
        stderr: '',
        output: '{"ok":true}',
      },
    })
    output.sink({
      type: 'hook',
      event: {
        type: 'response',
        hookId: 'hook-1',
        hookName: 'PreToolUse:Bash',
        hookEvent: 'PreToolUse',
        stdout: 'out',
        stderr: '',
        output: '{"ok":true}',
        exitCode: 0,
        outcome: 'success',
      },
    })
    expect(records.map((record) => record.subtype)).toEqual([
      'hook_started',
      'hook_progress',
      'hook_response',
    ])
    expect(records[2]).toMatchObject({
      hook_id: 'hook-1',
      hook_name: 'PreToolUse:Bash',
      exit_code: 0,
      outcome: 'success',
      uuid: expect.any(String),
    })

    const hidden: Record<string, unknown>[] = []
    const defaultOutput = new StreamJsonOutput(
      (record) => hidden.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      false,
    )
    defaultOutput.sink({
      type: 'hook',
      event: {
        type: 'started',
        hookId: 'hook-2',
        hookName: 'PreToolUse:Bash',
        hookEvent: 'PreToolUse',
      },
    })
    expect(hidden).toEqual([])
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

  it('keeps thinking out of result text while preserving partial and final blocks', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      true,
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({
      type: 'thinking-start',
      block: { type: 'thinking', thinking: '' },
    })
    output.sink({ type: 'thinking-delta', delta: 'private' })
    output.sink({ type: 'thinking-signature-delta', delta: 'signed' })
    output.sink({
      type: 'thinking-stop',
      block: { type: 'thinking', thinking: 'private', signature: 'signed' },
    })
    output.sink({ type: 'text-delta', delta: 'public' })
    output.sink({ type: 'state', state: 'completed' })

    const streamEvents = records
      .filter((record) => record.type === 'stream_event')
      .map((record) => record.event as Record<string, unknown>)
    expect(streamEvents).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'private' },
    })
    expect(streamEvents).toContainEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'signed' },
    })
    expect(streamEvents).toContainEqual({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'public' },
    })
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'assistant',
        message: expect.objectContaining({
          content: [
            {
              type: 'thinking',
              thinking: 'private',
              signature: 'signed',
            },
            { type: 'text', text: 'public' },
          ],
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

  it('maps local SDK control events to exact stream-json records', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      false,
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'state', state: 'compacting' })
    output.sink({
      type: 'compact-boundary',
      trigger: 'auto',
      preTokens: 123,
      uuid: '22222222-2222-4222-8222-222222222222',
    })
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({
      type: 'tool-progress',
      toolUseId: 't1',
      toolName: 'Bash',
      elapsedTimeSeconds: 1.25,
      taskId: 'a1',
    })
    output.sink({
      type: 'task-started',
      taskId: 'a1',
      description: 'Inspect repo',
      prompt: 'inspect',
    })
    output.sink({
      type: 'task-progress',
      taskId: 'a1',
      description: 'Inspect repo',
      usage: { totalTokens: 4, toolUses: 1, durationMs: 20 },
      lastToolName: 'Bash',
    })
    output.sink({
      type: 'task-notification',
      taskId: 'a1',
      status: 'completed',
      outputFile: '/tmp/a1',
      summary: 'done',
    })
    output.sink({
      type: 'api-retry',
      attempt: 1,
      maxRetries: 2,
      retryDelayMs: 10,
      errorStatus: 503,
      error: 'server_error',
    })
    output.sink({
      type: 'elicitation-complete',
      mcpServerName: 'fixture',
      elicitationId: 'elicit-1',
    })
    output.sink({
      type: 'tool-use-summary',
      summary: 'Read config.json',
      precedingToolUseIds: ['t1'],
    })
    expect(
      records.filter((r) => r.type === 'system').map((r) => r.subtype),
    ).toEqual([
      'session_state_changed',
      'status',
      'compact_boundary',
      'status',
      'task_started',
      'task_progress',
      'task_notification',
      'api_retry',
      'elicitation_complete',
    ])
    expect(records.find((r) => r.type === 'tool_use_summary')).toMatchObject({
      summary: 'Read config.json',
      preceding_tool_use_ids: ['t1'],
      uuid: expect.any(String),
    })
    expect(records.find((r) => r.type === 'tool_progress')).toMatchObject({
      tool_use_id: 't1',
      tool_name: 'Bash',
      elapsed_time_seconds: 1.25,
      task_id: 'a1',
    })
    expect(
      records.find((r) => r.subtype === 'elicitation_complete'),
    ).toMatchObject({
      mcp_server_name: 'fixture',
      elicitation_id: 'elicit-1',
      uuid: expect.any(String),
    })
    expect(records.find((r) => r.subtype === 'task_progress')).toMatchObject({
      usage: { total_tokens: 4, tool_uses: 1, duration_ms: 20 },
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
    expect(
      records
        .filter((record) => (record as { type: string }).type !== 'system')
        .map((record) => (record as { type: string }).type),
    ).toEqual(['assistant', 'result'])
    expect(
      records.find(
        (record) => (record as { type: string }).type === 'assistant',
      ),
    ).toMatchObject({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'provider failed' }],
      },
    })
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['provider failed'],
      session_id: sessionId,
      num_turns: 1,
      duration_api_ms: null,
      total_cost_usd: null,
      modelUsage: {},
      stop_reason: null,
      fast_mode_state: 'off',
      uuid: expect.any(String),
    })
  })
})
