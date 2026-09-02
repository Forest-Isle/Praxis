import { describe, expect, it } from 'vitest'

import {
  createErrorResult,
  createSuccessResult,
  isHeadlessCostCommand,
  matchHeadlessColorCommand,
  parseCliInvocation,
  projectProtocolTimings,
  readStreamJsonMessages,
  readStreamUserMessages,
  StreamJsonOutput,
  type CliRuntimeInfo,
} from './protocol.js'

const sessionId = '11111111-1111-4111-8111-111111111111'
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

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
  it('rejects the removed data-plane option', () => {
    expect(() =>
      parseCliInvocation(['--data-plane', 'claude', 'hello']),
    ).toThrow('--data-plane')
    expect(() => parseCliInvocation(['--data-plane=invalid', 'hello'])).toThrow(
      '--data-plane',
    )
  })

  it('normalizes Claude 2.1.237 autocompact window values', () => {
    expect(
      parseCliInvocation(['--autocompact', 'auto', 'hello']),
    ).toMatchObject({ autocompact: 'auto', args: ['hello'] })
    expect(parseCliInvocation(['--autocompact=200', 'hello'])).toMatchObject({
      autocompact: 200_000,
    })
    expect(parseCliInvocation(['--autocompact', '500.5k'])).toMatchObject({
      autocompact: 500_500,
    })
    expect(parseCliInvocation(['--autocompact', '1M'])).toMatchObject({
      autocompact: 1_000_000,
    })
    for (const value of ['99k', '1001k', 'tokens']) {
      expect(() => parseCliInvocation(['--autocompact', value])).toThrow(
        '--autocompact',
      )
    }
  })

  it('rejects Claude cloud session controls with explicit local-only errors', () => {
    expect(() => parseCliInvocation(['--cloud'])).toThrow(
      '--cloud is unavailable: Praxis is local-only',
    )
    expect(() => parseCliInvocation(['--cloud=session-id'])).toThrow(
      '--cloud is unavailable: Praxis is local-only',
    )
    expect(() =>
      parseCliInvocation(['--environment', 'ccpool_fixture']),
    ).toThrow('--environment is unavailable: Praxis is local-only')
    expect(() => parseCliInvocation(['--teleport', 'session-id'])).toThrow(
      '--teleport is unavailable: Praxis is local-only',
    )
  })

  it('parses provider, profile, and auth flow controls without positional leakage', () => {
    expect(
      parseCliInvocation([
        '--provider',
        'openai-codex',
        '--provider-profile=work',
        '--model',
        'gpt-codex',
        'run',
        'hello',
      ]),
    ).toMatchObject({
      provider: 'openai-codex',
      providerProfile: 'work',
      model: 'gpt-codex',
      args: ['run', 'hello'],
    })
    expect(
      parseCliInvocation([
        'auth',
        'login',
        'openai-codex',
        '--profile',
        'work',
        '--device',
        '--no-browser',
        '--json',
      ]),
    ).toMatchObject({
      command: 'auth',
      args: ['auth', 'login', 'openai-codex'],
      authProfile: 'work',
      authDevice: true,
      mcpNoBrowser: true,
      legacyJson: true,
    })
  })

  it('rejects missing, duplicate, and out-of-scope provider auth controls', () => {
    for (const argv of [
      ['--provider'],
      ['--provider='],
      ['--provider-profile'],
      ['--provider-profile='],
      ['auth', 'status', '--profile'],
      ['auth', 'status', '--profile='],
    ]) {
      expect(() => parseCliInvocation(argv)).toThrow(/is required/u)
    }
    expect(() =>
      parseCliInvocation(['--provider', 'openai', '--provider=anthropic']),
    ).toThrow('--provider may only be specified once')
    expect(() =>
      parseCliInvocation([
        '--provider-profile',
        'one',
        '--provider-profile=two',
      ]),
    ).toThrow('--provider-profile may only be specified once')
    expect(() =>
      parseCliInvocation([
        'auth',
        'status',
        '--profile',
        'one',
        '--profile=two',
      ]),
    ).toThrow('--profile may only be specified once')
    expect(() => parseCliInvocation(['run', '--profile', 'work'])).toThrow(
      '--profile is only valid with auth commands',
    )
    expect(() => parseCliInvocation(['auth', 'status', '--device'])).toThrow(
      '--device is only valid with auth login',
    )
    expect(() =>
      parseCliInvocation(['auth', 'status', '--no-browser']),
    ).toThrow('--no-browser is only valid with mcp login or auth login')
    expect(() => parseCliInvocation(['mcp', 'list', '--no-browser'])).toThrow(
      '--no-browser is only valid with mcp login or auth login',
    )
  })

  it('parses Claude import command controls without treating them as plugin options', () => {
    expect(
      parseCliInvocation(['import', 'codex', '--dry-run', '--yes']),
    ).toMatchObject({
      command: 'import',
      args: ['import', 'codex'],
      importDryRun: true,
      importYes: true,
      pluginDryRun: false,
      pluginYes: false,
    })
    expect(
      parseCliInvocation(['import', '--yes=preview-digest', 'gemini']),
    ).toMatchObject({ importYes: 'preview-digest' })
    expect(() => parseCliInvocation(['import', '--yes='])).toThrow(
      '--yes digest must not be empty',
    )
  })

  it('accepts forward-subagent-text only for print stream-json mode', () => {
    expect(
      parseCliInvocation([
        '--print',
        '--verbose',
        '--output-format=stream-json',
        '--forward-subagent-text',
        'hello',
      ]),
    ).toMatchObject({ forwardSubagentText: true, args: ['hello'] })
    expect(() => parseCliInvocation(['--forward-subagent-text'])).toThrow(
      '--forward-subagent-text requires --print and --output-format=stream-json',
    )
  })

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
    expect(
      createErrorResult(
        'Maximum model turns of 3 exceeded',
        sessionId,
        Date.now(),
        3,
      ),
    ).toMatchObject({ subtype: 'error_max_turns', num_turns: 3 })
  })

  it('projects provider and local success envelopes with stable metrics', () => {
    expect(
      createSuccessResult(
        {
          sessionId,
          text: 'answer',
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            cacheReadInputTokens: 4,
            cacheCreationInputTokens: 5,
            webSearchRequests: 1,
          },
          costUsd: 0.5,
          modelUsage: { 'test-model': { inputTokens: 2, outputTokens: 3 } },
          modelCostUsd: { 'test-model': 0.5 },
        },
        runtimeInfo,
        Date.now(),
        1,
        {
          stopReason: 'end_turn',
          ttftMs: 4,
          ttftStreamMs: 6,
          timeToRequestMs: 2,
        },
      ),
    ).toMatchObject({
      subtype: 'success',
      api_error_status: null,
      duration_api_ms: 0,
      total_cost_usd: 0.5,
      stop_reason: 'end_turn',
      terminal_reason: 'completed',
      ttft_ms: 4,
      ttft_stream_ms: 6,
      time_to_request_ms: 2,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 4,
        output_tokens: 3,
        server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
        service_tier: 'standard',
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: '',
        iterations: [],
        speed: 'standard',
      },
      modelUsage: {
        'test-model': {
          costUSD: 0.5,
          webSearchRequests: 0,
        },
      },
    })

    const local = createSuccessResult(
      {
        sessionId,
        text: 'Session color set to: purple',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      runtimeInfo,
      Date.now(),
      7,
      { localCommand: true },
    )
    expect(local).toMatchObject({
      duration_api_ms: 0,
      total_cost_usd: 0,
      num_turns: 0,
      stop_reason: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
    })
    expect(local).not.toHaveProperty('api_error_status')
    expect(local).not.toHaveProperty('terminal_reason')
  })

  it('projects a typed provider API failure once with no error array', () => {
    expect(
      createErrorResult(
        'API Error: 400 fixture rejected request',
        sessionId,
        Date.now(),
        1,
        { providerApiError: true, apiErrorStatus: 400 },
      ),
    ).toMatchObject({
      subtype: 'success',
      is_error: true,
      api_error_status: 400,
      result: 'API Error: 400 fixture rejected request',
      stop_reason: 'stop_sequence',
      terminal_reason: 'api_error',
      duration_api_ms: 0,
      total_cost_usd: 0,
      num_turns: 1,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      },
    })
    expect(
      createErrorResult('fixture rejected request', sessionId, Date.now(), 1, {
        providerApiError: true,
        apiErrorStatus: 400,
      }),
    ).not.toHaveProperty('errors')
  })

  it('calculates protocol timings from the headless turn start', () => {
    expect(projectProtocolTimings(100, 110, 125)).toEqual({
      timeToRequestMs: 10,
      ttftMs: 25,
      ttftStreamMs: 25,
    })
    expect(projectProtocolTimings(100, undefined, 125)).toEqual({
      ttftMs: 25,
      ttftStreamMs: 25,
    })
    expect(projectProtocolTimings(100)).toEqual({})
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
      resumeSelector: sessionId,
    })
  })

  it('parses optional long and attached resume selectors', () => {
    expect(parseCliInvocation(['--resume'])).toMatchObject({
      args: ['resume'],
      resumeSelector: true,
    })
    expect(parseCliInvocation(['--resume='])).toMatchObject({
      args: ['resume'],
      resumeSelector: true,
    })
    for (const argv of [
      ['--resume=Named Session', 'continue'],
      ['-rNamed Session', 'continue'],
    ]) {
      expect(parseCliInvocation(argv)).toMatchObject({
        args: ['resume', 'Named Session', 'continue'],
        resumeSelector: 'Named Session',
      })
    }
    expect(() => parseCliInvocation(['--resume', '--resume=id'])).toThrow(
      '--resume may only be specified once',
    )
    expect(() => parseCliInvocation(['--resume=id', '--continue'])).toThrow(
      '--resume cannot be combined with --continue',
    )
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
        '--resume-session-at requires an explicit --resume selector',
      )
    }
    expect(() =>
      parseCliInvocation([
        '--resume',
        '--resume-session-at',
        'user-message-uuid',
      ]),
    ).toThrow('--resume-session-at requires an explicit --resume selector')
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

  it('parses plugin core and maintenance controls without consuming init names', () => {
    expect(
      parseCliInvocation([
        'plugin',
        'new',
        '--with',
        'skills',
        'agents',
        '--description',
        'fixture plugin',
        'fixture',
      ]),
    ).toMatchObject({
      args: ['plugin', 'new', 'fixture'],
      pluginWith: ['skills', 'agents'],
      pluginDescription: 'fixture plugin',
    })
    expect(
      parseCliInvocation([
        'plugin',
        'tag',
        '--dry-run',
        '--force',
        '--push',
        '-m',
        'Release %s',
        '--remote=upstream',
        'plugins/fixture',
      ]),
    ).toMatchObject({
      args: ['plugin', 'tag', 'plugins/fixture'],
      pluginDryRun: true,
      pluginForce: true,
      pluginPush: true,
      pluginMessage: 'Release %s',
      pluginRemote: 'upstream',
    })
    expect(parseCliInvocation(['plugin', 'disable', '--all'])).toMatchObject({
      pluginAll: true,
      agentsAll: false,
    })
    expect(parseCliInvocation(['plugin', 'disable', '-a'])).toMatchObject({
      pluginAll: true,
      agentsAll: false,
    })
    expect(
      parseCliInvocation([
        'plugin',
        'marketplace',
        'add',
        'owner/repo',
        '--sparse',
        '.claude-plugin',
        'plugins',
      ]),
    ).toMatchObject({
      args: ['plugin', 'marketplace', 'add', 'owner/repo'],
      pluginSparsePaths: ['.claude-plugin', 'plugins'],
    })
    expect(
      parseCliInvocation(['plugin', 'autoremove', '-s=user', '--dry-run']),
    ).toMatchObject({
      args: ['plugin', 'autoremove'],
      mcpScope: 'user',
      pluginDryRun: true,
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
    expect(
      parseCliInvocation(['--worktree', '--tmux', 'prompt']),
    ).toMatchObject({
      worktreeRequested: true,
      tmux: 'native',
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
        'true',
        '--',
        'hello',
      ]),
    ).toMatchObject({ promptSuggestions: true, args: ['hello'] })
    expect(
      parseCliInvocation([
        '-p',
        '--output-format=stream-json',
        '--verbose',
        '--prompt-suggestions=false',
      ]),
    ).toMatchObject({ promptSuggestions: false })
    for (const value of ['false', '0', 'no', 'off', ' FALSE ']) {
      expect(
        parseCliInvocation(['--prompt-suggestions', value, 'prompt']),
      ).toMatchObject({ promptSuggestions: false, args: ['prompt'] })
    }
    for (const value of ['true', '1', 'yes', 'on', ' TRUE ']) {
      expect(
        parseCliInvocation([
          '-p',
          '--output-format=stream-json',
          '--verbose',
          '--prompt-suggestions',
          value,
        ]),
      ).toMatchObject({ promptSuggestions: true })
    }
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
    ).toThrow("argument 'maybe' is invalid. Allowed choices are")
    expect(() =>
      parseCliInvocation(['--prompt-suggestions=', '--version']),
    ).toThrow("argument '' is invalid")
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
    expect(parseCliInvocation(['-d', 'hooks', '--', 'hello'])).toMatchObject({
      debug: 'hooks',
      args: ['hello'],
      mcpDebug: false,
    })
    expect(parseCliInvocation(['-dhooks', 'hello'])).toMatchObject({
      debug: 'hooks',
      args: ['hello'],
    })
    expect(parseCliInvocation(['--debug=', 'hello'])).toMatchObject({
      debug: true,
      args: ['hello'],
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
    expect(parseCliInvocation(['mcp', 'serve', '-d'])).toMatchObject({
      debug: true,
      mcpDebug: true,
    })
    expect(() => parseCliInvocation(['mcp', 'list', '--debug', 'api'])).toThrow(
      'Unknown option: --debug',
    )
    expect(() => parseCliInvocation(['mcp', 'serve', '-dapi'])).toThrow(
      'Unknown option: -dapi',
    )
    expect(() => parseCliInvocation(['mcp', 'list', '-dapi'])).toThrow(
      'Unknown option: -dapi',
    )
    expect(() =>
      parseCliInvocation(['mcp', 'list', '--prompt-suggestions', 'false']),
    ).toThrow('Unknown option: --prompt-suggestions')
    expect(
      parseCliInvocation(['--prompt-suggestions=true', 'mcp', 'list']),
    ).toMatchObject({ promptSuggestions: true, args: ['mcp', 'list'] })
    expect(parseCliInvocation(['mcp', 'serve', '-d', 'api'])).toMatchObject({
      debug: true,
      mcpDebug: true,
      args: ['mcp', 'serve', 'api'],
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
    expect(
      parseCliInvocation([
        'mcp',
        'add-json',
        '--client-secret',
        'fixture',
        '{"type":"http","url":"https://example.test/mcp"}',
      ]),
    ).toMatchObject({
      args: [
        'mcp',
        'add-json',
        'fixture',
        '{"type":"http","url":"https://example.test/mcp"}',
      ],
      mcpClientSecret: true,
    })
  })

  it('parses auto-mode label filters', () => {
    expect(
      parseCliInvocation(['auto-mode', 'defaults', '--label', 'read']),
    ).toMatchObject({
      args: ['auto-mode', 'defaults'],
      autoModeLabel: 'read',
    })
  })

  it('keeps auto-mode reset confirmation separate from plugin confirmation', () => {
    expect(parseCliInvocation(['auto-mode', 'reset', '--yes'])).toMatchObject({
      args: ['auto-mode', 'reset'],
      autoModeResetYes: true,
      pluginYes: false,
    })
    expect(parseCliInvocation(['plugin', 'prune', '--yes'])).toMatchObject({
      autoModeResetYes: false,
      pluginYes: true,
    })
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
        '--trust-project',
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
      trustProject: true,
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
      { includePartialMessages: false },
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
    ).toEqual(['init'])
    const envelopes = records as Record<string, unknown>[]
    expect(envelopes.every((record) => record.session_id === sessionId)).toBe(
      true,
    )
    expect(
      envelopes.every(
        (record) =>
          typeof record.uuid === 'string' && UUID_PATTERN.test(record.uuid),
      ),
    ).toBe(true)
    expect(new Set(envelopes.map((record) => record.uuid)).size).toBe(
      envelopes.length,
    )
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
      duration_api_ms: 0,
      total_cost_usd: 0,
      modelUsage: {
        'test-model': { costUSD: 0 },
      },
      stop_reason: null,
      fast_mode_state: 'off',
      uuid: expect.any(String),
    })
  })

  it('emits a synthetic assistant for a provider-free local command', () => {
    const records: unknown[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record),
      runtimeInfo,
      sessionId,
      {
        includePartialMessages: true,
        emitSessionStateEvents: true,
      },
    )
    output.init()
    output.syntheticAssistant('Session color set to: purple')
    output.result(
      {
        sessionId,
        text: 'Session color set to: purple',
        usage: { inputTokens: 0, outputTokens: 0 },
        durationApiMs: 0,
        costUsd: 0,
        modelUsage: {},
      },
      Date.now(),
    )

    expect(
      records.map((record) => {
        const value = record as {
          type: string
          subtype?: string
          state?: string
        }
        if (value.type === 'result') return 'result'
        return value.subtype === 'session_state_changed'
          ? `${value.subtype}:${value.state}`
          : (value.subtype ?? value.type)
      }),
    ).toEqual([
      'session_state_changed:running',
      'init',
      'assistant',
      'result',
      'session_state_changed:idle',
    ])
    expect(records[1]).toMatchObject({ type: 'system', subtype: 'init' })
    expect(records[2]).toEqual({
      type: 'assistant',
      message: {
        id: expect.any(String),
        type: 'message',
        role: 'assistant',
        model: '<synthetic>',
        content: [{ type: 'text', text: 'Session color set to: purple' }],
        stop_reason: 'stop_sequence',
        stop_sequence: '',
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: expect.stringMatching(UUID_PATTERN),
    })
    expect(records[3]).toMatchObject({
      type: 'result',
      subtype: 'success',
      num_turns: 0,
      duration_api_ms: 0,
      total_cost_usd: 0,
      result: 'Session color set to: purple',
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      stop_reason: null,
    })
  })

  it('matches only bare /color commands with optional arguments', () => {
    expect(matchHeadlessColorCommand('/color')).toBe('')
    expect(matchHeadlessColorCommand('/color ')).toBe('')
    expect(matchHeadlessColorCommand('/color purple')).toBe('purple')
    expect(matchHeadlessColorCommand('/color   purple')).toBe('purple')
    expect(matchHeadlessColorCommand('/color purple  ')).toBe('purple  ')
    expect(matchHeadlessColorCommand('/color red blue')).toBe('red blue')
    expect(matchHeadlessColorCommand('/colorblue')).toBeUndefined()
    expect(matchHeadlessColorCommand('/colorful')).toBeUndefined()
    expect(matchHeadlessColorCommand('/COLOR purple')).toBeUndefined()
    expect(matchHeadlessColorCommand('say /color')).toBeUndefined()
    expect(matchHeadlessColorCommand('')).toBeUndefined()
    expect(matchHeadlessColorCommand('/color\npurple')).toBe('purple')
  })

  it('matches only trimmed exact /cost as a local command', () => {
    expect(isHeadlessCostCommand('/cost')).toBe(true)
    expect(isHeadlessCostCommand('/cost ')).toBe(true)
    expect(isHeadlessCostCommand('  /cost  ')).toBe(true)
    expect(isHeadlessCostCommand('/cost\n')).toBe(true)
    expect(isHeadlessCostCommand('/costs')).toBe(false)
    expect(isHeadlessCostCommand('/cost extra')).toBe(false)
    expect(isHeadlessCostCommand('/Cost')).toBe(false)
    expect(isHeadlessCostCommand('say /cost')).toBe(false)
    expect(isHeadlessCostCommand('')).toBe(false)
  })

  it('maps per-model cost and web search usage from a cost result', () => {
    const startedAt = Date.now()
    const result = createSuccessResult(
      {
        sessionId,
        text: 'Total cost:            $0.0010',
        usage: { inputTokens: 0, outputTokens: 0 },
        durationApiMs: 0,
        costUsd: 0.001,
        modelUsage: {
          'claude-sonnet-4-20250514': {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 2,
            webSearchRequests: 1,
          },
        },
        modelCostUsd: { 'claude-sonnet-4-20250514': 0.001 },
      },
      runtimeInfo,
      startedAt,
      0,
    )
    expect(result).toMatchObject({
      subtype: 'success',
      num_turns: 0,
      duration_api_ms: 0,
      total_cost_usd: 0.001,
      result: 'Total cost:            $0.0010',
      session_id: sessionId,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {
        'claude-sonnet-4-20250514': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          webSearchRequests: 1,
          costUSD: 0.001,
        },
      },
    })
  })

  it('keeps the legacy single-model cost mapping for ordinary results', () => {
    const startedAt = Date.now()
    const result = createSuccessResult(
      {
        sessionId,
        text: 'answer',
        usage: { inputTokens: 2, outputTokens: 3 },
        costUsd: 0.5,
        modelUsage: {
          'test-model': { inputTokens: 2, outputTokens: 3 },
        },
      },
      runtimeInfo,
      startedAt,
      1,
    )
    expect(result).toMatchObject({
      num_turns: 1,
      total_cost_usd: 0.5,
      modelUsage: {
        'test-model': {
          inputTokens: 2,
          outputTokens: 3,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.5,
          contextWindow: 0,
          maxOutputTokens: 0,
        },
      },
    })
  })

  it('serializes numeric contextWindow and maxOutputTokens with capability fallback', () => {
    const startedAt = Date.now()
    const info: CliRuntimeInfo = {
      ...runtimeInfo,
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
    }
    const result = createSuccessResult(
      {
        sessionId,
        text: 'answer',
        usage: { inputTokens: 2, outputTokens: 3 },
        costUsd: 0.5,
        modelUsage: {
          // Known row without metadata: falls back to the matching runtimeInfo
          // model's capability.
          'test-model': { inputTokens: 2, outputTokens: 3 },
          // Unknown model without metadata: serializes as 0.
          'legacy-model': { inputTokens: 4, outputTokens: 1 },
          // Row with its own metadata: preserved exactly.
          'known-model': {
            inputTokens: 6,
            outputTokens: 2,
            contextWindow: 100_000,
            maxOutputTokens: 16_000,
          },
        },
      },
      info,
      startedAt,
      1,
    )
    expect(result.modelUsage).toMatchObject({
      'test-model': {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.5,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
      'legacy-model': {
        inputTokens: 4,
        outputTokens: 1,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      },
      'known-model': {
        inputTokens: 6,
        outputTokens: 2,
        costUSD: 0,
        contextWindow: 100_000,
        maxOutputTokens: 16_000,
      },
    })
  })

  it('serializes capability fallback for the default single-model row', () => {
    const startedAt = Date.now()
    const info: CliRuntimeInfo = {
      ...runtimeInfo,
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
    }
    const result = createSuccessResult(
      {
        sessionId,
        text: 'answer',
        usage: { inputTokens: 2, outputTokens: 3 },
      },
      info,
      startedAt,
      1,
    )
    expect(result.modelUsage).toMatchObject({
      'test-model': {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0,
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
      },
    })
  })

  it('emits SendUserMessage stream records', () => {
    const records: unknown[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record),
      runtimeInfo,
      sessionId,
      { includePartialMessages: false },
    )
    output.sink({
      type: 'user-message',
      message: 'checkpoint',
      status: 'proactive',
      attachments: ['notes.md'],
    })
    expect(records).toContainEqual({
      type: 'user',
      message: 'checkpoint',
      status: 'proactive',
      attachments: ['notes.md'],
      uuid: expect.any(String),
      session_id: sessionId,
    })
  })

  it('envelopes replay, control, warning, tool-result, and supplied identifiers', () => {
    const records: Record<string, unknown>[] = []
    const compactUuid = '22222222-2222-4222-8222-222222222222'
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: false },
    )

    output.replayUser({ role: 'user', content: 'replayed' })
    output.syntheticAssistant('local answer')
    output.controlRequest({
      request_id: 'request-1',
      request: { subtype: 'interrupt' },
    })
    output.sink({ type: 'warning', message: 'warning' })
    output.sink({
      type: 'tool-result',
      callId: 'tool-1',
      content: 'done',
      isError: false,
    })
    output.sink({
      type: 'compact-boundary',
      trigger: 'manual',
      preTokens: 12,
      uuid: compactUuid,
    })

    expect(records.map((record) => record.type)).toEqual([
      'user',
      'assistant',
      'control_request',
      'system',
      'user',
      'system',
    ])
    expect(records.every((record) => record.session_id === sessionId)).toBe(
      true,
    )
    expect(
      records.every(
        (record) =>
          typeof record.uuid === 'string' && UUID_PATTERN.test(record.uuid),
      ),
    ).toBe(true)
    expect(new Set(records.map((record) => record.uuid)).size).toBe(
      records.length,
    )
    expect(records.at(-1)).toMatchObject({
      subtype: 'compact_boundary',
      uuid: compactUuid,
    })
  })

  it('emits hook lifecycle system records only when requested', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: false, includeHookEvents: true },
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
      { includePartialMessages: false },
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
      { includePartialMessages: true },
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'text-delta', delta: 'x' })
    output.sink({
      type: 'tool-call',
      call: { id: 'tool-1', name: 'Read', input: { file_path: 'a.txt' } },
    })
    output.sink({
      type: 'tool-call',
      call: { id: 'tool-2', name: 'Read', input: { file_path: 'b.txt' } },
    })
    output.sink({
      type: 'usage',
      usage: { inputTokens: 7, outputTokens: 3 },
    })
    output.sink({ type: 'state', state: 'executing-tools' })

    expect(
      records.map((record) => {
        if (record.type === 'system')
          return `${record.subtype}:${String(record.status)}`
        if (record.type !== 'stream_event') return record.type
        const event = record.event as { type: string; index?: number }
        return `${event.type}${event.index === undefined ? '' : `:${event.index}`}`
      }),
    ).toEqual([
      'status:requesting',
      'message_start',
      'content_block_start:0',
      'content_block_delta:0',
      'content_block_stop:0',
      'content_block_start:1',
      'content_block_delta:1',
      'content_block_stop:1',
      'content_block_start:2',
      'content_block_delta:2',
      'assistant',
      'content_block_stop:2',
      'message_delta',
      'message_stop',
    ])
    const messageStart = records.find(
      (record) =>
        record.type === 'stream_event' &&
        (record.event as { type?: string }).type === 'message_start',
    )
    const assistant = records.find((record) => record.type === 'assistant')
    const messageDelta = records.find(
      (record) =>
        record.type === 'stream_event' &&
        (record.event as { type?: string }).type === 'message_delta',
    )
    expect(messageStart).toMatchObject({
      event: { message: { usage: { input_tokens: 7, output_tokens: 0 } } },
    })
    expect(assistant).toMatchObject({
      message: { usage: { input_tokens: 7, output_tokens: 0 } },
    })
    expect(messageDelta).toMatchObject({
      event: { usage: { output_tokens: 3 } },
    })
    const uuids = records.map((record) => record.uuid)
    expect(records.every((record) => record.session_id === sessionId)).toBe(
      true,
    )
    expect(uuids.every((uuid) => UUID_PATTERN.test(String(uuid)))).toBe(true)
    expect(new Set(uuids).size).toBe(records.length)
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
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'stream_event',
        event: expect.objectContaining({
          type: 'content_block_delta',
          delta: {
            type: 'input_json_delta',
            partial_json: '{"file_path":"b.txt"}',
          },
        }),
      }),
    )
  })

  it('uses the provider terminal reason in partial stream output', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: true },
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'text-delta', delta: 'partial' })
    output.sink({ type: 'terminal', reason: 'max_tokens' })
    output.sink({ type: 'state', state: 'completed' })

    const messageDelta = records.find(
      (record) =>
        record.type === 'stream_event' &&
        (record.event as { type?: string }).type === 'message_delta',
    )
    expect(messageDelta).toMatchObject({
      event: { delta: { stop_reason: 'max_tokens' } },
    })
  })

  it('closes a headless turn on a failed lifecycle state', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      {
        includePartialMessages: false,
        emitSessionStateEvents: true,
      },
    )
    output.init()
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'state', state: 'failed' })
    output.error('fixture rejected request', Date.now())

    expect(
      records.map((record) =>
        record.subtype === 'session_state_changed'
          ? `${record.subtype}:${String(record.state)}`
          : (record.subtype ?? record.type),
      ),
    ).toEqual([
      'session_state_changed:running',
      'init',
      'assistant',
      'error_during_execution',
      'session_state_changed:idle',
    ])
  })

  it('gates and deduplicates immediate session states before terminal idle', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      {
        includePartialMessages: false,
        emitSessionStateEvents: true,
      },
    )

    output.init()
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'state', state: 'awaiting-permission' })
    output.sink({ type: 'session-state-changed', state: 'requires_action' })
    output.sink({ type: 'session-state-changed', state: 'idle' })
    output.result(
      { sessionId, text: '', usage: { inputTokens: 0, outputTokens: 0 } },
      Date.now(),
    )

    const states = records.filter(
      (record) => record.subtype === 'session_state_changed',
    )
    expect(states.map((record) => record.state)).toEqual([
      'running',
      'requires_action',
      'idle',
    ])
    expect(records.at(-2)).toMatchObject({ type: 'result' })
    expect(records.at(-1)).toMatchObject({
      subtype: 'session_state_changed',
      state: 'idle',
    })
  })

  it('marks and resets a discarded model attempt before the recovered turn', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: true },
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'text-delta', delta: 'discarded partial' })
    output.sink({ type: 'terminal', reason: 'prompt_too_long' })
    output.sink({
      type: 'model-attempt-discarded',
      reason: 'prompt_too_long',
    })
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'text-delta', delta: 'recovered' })
    output.sink({ type: 'terminal', reason: 'end_turn' })
    output.sink({ type: 'state', state: 'completed' })

    const discardIndex = records.findIndex(
      (record) => record.subtype === 'model_attempt_discarded',
    )
    expect(records[discardIndex]).toMatchObject({
      type: 'system',
      reason: 'prompt_too_long',
      session_id: sessionId,
    })
    const recoveredMessage = records
      .slice(discardIndex + 1)
      .find(
        (record) =>
          record.type === 'assistant' ||
          (record.type === 'stream_event' &&
            (record.event as { type?: string }).type === 'message_delta'),
      )
    expect(recoveredMessage).toBeDefined()
    expect(JSON.stringify(records.slice(discardIndex + 1))).toContain(
      'recovered',
    )
    expect(JSON.stringify(records.slice(discardIndex + 1))).not.toContain(
      'discarded partial',
    )
  })

  it('projects a pending tool pair before discarding an overflow attempt', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: false },
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({
      type: 'tool-call',
      call: { id: 'pending-read', name: 'Read', input: {} },
    })
    output.sink({ type: 'terminal', reason: 'prompt_too_long' })
    output.sink({
      type: 'tool-result',
      callId: 'pending-read',
      content: 'Read cancelled: prompt too long',
      isError: true,
    })
    output.sink({
      type: 'model-attempt-discarded',
      reason: 'prompt_too_long',
    })

    const serialized = records.map((record) => JSON.stringify(record))
    const toolUseIndex = serialized.findIndex(
      (record) =>
        record.includes('pending-read') && record.includes('tool_use'),
    )
    const toolResultIndex = serialized.findIndex(
      (record) =>
        record.includes('pending-read') && record.includes('tool_result'),
    )
    const discardIndex = records.findIndex(
      (record) => record.subtype === 'model_attempt_discarded',
    )
    expect(toolUseIndex).toBeGreaterThanOrEqual(0)
    expect(toolResultIndex).toBeGreaterThan(toolUseIndex)
    expect(discardIndex).toBeGreaterThan(toolResultIndex)
  })

  it('keeps thinking out of result text while preserving partial and final blocks', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: true },
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
    expect(
      records.map((record) => {
        if (record.type === 'system')
          return `${record.subtype}:${String(record.status)}`
        if (record.type !== 'stream_event') return record.type
        const event = record.event as { type: string; index?: number }
        return `${event.type}${event.index === undefined ? '' : `:${event.index}`}`
      }),
    ).toEqual([
      'status:requesting',
      'message_start',
      'content_block_start:0',
      'content_block_delta:0',
      'content_block_delta:0',
      'content_block_stop:0',
      'content_block_start:1',
      'content_block_delta:1',
      'assistant',
      'content_block_stop:1',
      'message_delta',
      'message_stop',
    ])
  })

  it('preserves partial thinking without synthesizing a cancelled assistant', () => {
    const partialRecords: Record<string, unknown>[] = []
    const partialOutput = new StreamJsonOutput(
      (record) => partialRecords.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: true },
    )
    partialOutput.sink({ type: 'state', state: 'awaiting-model' })
    partialOutput.sink({
      type: 'thinking-start',
      block: { type: 'thinking', thinking: '' },
    })
    partialOutput.sink({ type: 'thinking-delta', delta: 'partial' })
    partialOutput.sink({ type: 'state', state: 'cancelled' })

    expect(
      partialRecords.filter((record) => record.type === 'assistant'),
    ).toHaveLength(0)
    expect(partialRecords).toContainEqual(
      expect.objectContaining({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'partial' },
        },
      }),
    )
    expect(partialRecords).not.toContainEqual(
      expect.objectContaining({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }),
    )

    const completedRecords: Record<string, unknown>[] = []
    const completedOutput = new StreamJsonOutput(
      (record) => completedRecords.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: true },
    )
    completedOutput.sink({ type: 'state', state: 'awaiting-model' })
    completedOutput.sink({
      type: 'thinking-start',
      block: { type: 'thinking', thinking: '' },
    })
    completedOutput.sink({ type: 'thinking-delta', delta: 'complete' })
    completedOutput.sink({
      type: 'thinking-stop',
      block: { type: 'thinking', thinking: 'complete', signature: 'signed' },
    })
    completedOutput.sink({ type: 'state', state: 'cancelled' })

    const assistants = completedRecords.filter(
      (record) => record.type === 'assistant',
    )
    expect(assistants).toHaveLength(1)
    expect(assistants[0]).toMatchObject({
      message: {
        content: [
          { type: 'thinking', thinking: 'complete', signature: 'signed' },
        ],
      },
    })
  })

  it('emits prompt suggestion records after the result', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: false },
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

  it('preserves the authoritative result session identity', () => {
    const records: Record<string, unknown>[] = []
    const resultSessionId = '44444444-4444-4444-8444-444444444444'
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: false },
    )

    output.result(
      {
        sessionId: resultSessionId,
        text: 'done',
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      Date.now(),
    )

    expect(records).toEqual([
      expect.objectContaining({
        type: 'result',
        session_id: resultSessionId,
        uuid: expect.stringMatching(UUID_PATTERN),
      }),
    ])
  })

  it('maps local SDK control events to exact stream-json records', () => {
    const records: Record<string, unknown>[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record as Record<string, unknown>),
      runtimeInfo,
      sessionId,
      { includePartialMessages: false },
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
      { includePartialMessages: false },
    )
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({
      type: 'failed',
      message: 'provider failed',
      retryable: false,
    })
    output.error('fixture rejected request', Date.now(), {
      providerApiError: true,
      apiErrorStatus: 400,
    })
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
        content: [
          { type: 'text', text: 'API Error: 400 fixture rejected request' },
        ],
      },
    })
    expect(records.at(-1)).toMatchObject({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 400,
      result: 'API Error: 400 fixture rejected request',
      session_id: sessionId,
      num_turns: 1,
      duration_api_ms: 0,
      total_cost_usd: 0,
      modelUsage: {},
      stop_reason: 'stop_sequence',
      terminal_reason: 'api_error',
      fast_mode_state: 'off',
      uuid: expect.any(String),
    })
  })

  it('preserves real partial assistant content on provider failure', () => {
    const records: unknown[] = []
    const output = new StreamJsonOutput(
      (record) => records.push(record),
      runtimeInfo,
      sessionId,
      { includePartialMessages: false },
    )
    output.init(100)
    output.sink({ type: 'state', state: 'awaiting-model' })
    output.sink({ type: 'text-delta', delta: 'partial answer' })
    output.sink({
      type: 'failed',
      message: 'fixture rejected request',
      retryable: false,
    })
    output.error('fixture rejected request', 100, {
      providerApiError: true,
      apiErrorStatus: 400,
    })

    expect(
      records.filter(
        (record) => (record as { type: string }).type === 'assistant',
      ),
    ).toHaveLength(1)
    expect(
      records.find(
        (record) => (record as { type: string }).type === 'assistant',
      ),
    ).toMatchObject({
      message: { content: [{ type: 'text', text: 'partial answer' }] },
    })
    expect(records.at(-1)).toMatchObject({
      subtype: 'success',
      is_error: true,
      result: 'API Error: 400 fixture rejected request',
      terminal_reason: 'api_error',
    })
  })
})
