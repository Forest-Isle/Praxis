import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type {
  ModelProviderCapabilities,
  ModelRequest,
  ModelStreamEvent,
  ModelUsage,
} from '../core/runtime.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { OpenAIResponsesProvider } from './openai-responses.js'

type Protocol = 'chat' | 'responses'

interface CapturedCall {
  protocol: Protocol
  pathname: string
  method: string
  headers: string[]
  authorization: string
  body: Record<string, unknown>
}

interface CapturedResult {
  request?: CapturedCall
  events?: ModelStreamEvent[]
  error?: NormalizedError
}

interface NormalizedError {
  kind: string
  retryable: boolean
  message?: string
}

interface Fixture {
  schemaVersion: number
  source: { kind: string; commit: string }
  decision: {
    automaticCrossProtocolFallback: string
    portableSubset: string[]
    failClosed: string[]
    notComparable: string[]
  }
  trajectories: Record<
    string,
    { chat: CapturedResult; responses: CapturedResult }
  >
  terminalMatrix: Record<
    string,
    { chat: CapturedResult; responses: CapturedResult }
  >
  usage: Record<string, unknown>
  capabilities: Record<string, unknown>
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../test/fixtures/native/providers/openai-chat-responses-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as Fixture

const tool = {
  name: 'lookup',
  description: 'Look up a value',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
} as const

const call = (id: string, q: string) => ({
  id,
  name: 'lookup',
  input: { q },
})

const terminalText: ModelRequest = {
  messages: [
    { role: 'system', content: 'You are concise.' },
    { role: 'user', content: 'Say hello.' },
  ],
}

const singleToolContinuation: ModelRequest = {
  messages: [
    { role: 'user', content: 'Look up x.' },
    { role: 'assistant', content: '', toolCalls: [call('call-1', 'x')] },
    {
      role: 'tool',
      toolCallId: 'call-1',
      content: 'value-x',
      isError: false,
    },
  ],
}

const parallelToolContinuation: ModelRequest = {
  messages: [
    { role: 'user', content: 'Look up x and y.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [call('call-1', 'x'), call('call-2', 'y')],
    },
    {
      role: 'tool',
      toolCallId: 'call-1',
      content: 'value-x',
      isError: false,
    },
    {
      role: 'tool',
      toolCallId: 'call-2',
      content: 'value-y',
      isError: false,
    },
  ],
  tools: [tool],
}

const reasoningToolContinuation: ModelRequest = {
  messages: [
    { role: 'user', content: 'Reason, then look up x.' },
    {
      role: 'assistant',
      content: '',
      thinkingBlocks: [
        { type: 'thinking', thinking: 'Need the value.', signature: 'sig-1' },
      ],
      toolCalls: [call('call-1', 'x')],
    },
    {
      role: 'tool',
      toolCallId: 'call-1',
      content: 'value-x',
      isError: false,
    },
  ],
  thinking: { mode: 'enabled' },
}

const signedReasoningHistory: ModelRequest = {
  messages: [
    { role: 'user', content: 'Continue.' },
    {
      role: 'assistant',
      content: 'I considered the options.',
      thinkingBlocks: [
        {
          type: 'thinking',
          thinking: 'Private reasoning.',
          signature: 'sig-2',
        },
      ],
    },
  ],
  thinking: { mode: 'disabled' },
}

const requests: Record<string, ModelRequest> = {
  'terminal-text': terminalText,
  'single-tool-continuation': singleToolContinuation,
  'parallel-tool-continuation': parallelToolContinuation,
  'reasoning-tool-continuation': reasoningToolContinuation,
  'signed-reasoning-history': signedReasoningHistory,
}

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function chatText(
  reason: 'stop' | 'content_filter' | 'length' = 'stop',
): string {
  return [
    frame({ choices: [{ delta: { content: 'ok' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: reason }] }),
    frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    'data: [DONE]\n\n',
  ].join('')
}

function chatUsage(): string {
  return [
    frame({ choices: [{ delta: { content: 'ok' } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    frame({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 6 },
      },
    }),
    'data: [DONE]\n\n',
  ].join('')
}

function responsesText(
  type: 'response.completed' | 'response.incomplete' = 'response.completed',
  response: Record<string, unknown> = {
    usage: { input_tokens: 10, output_tokens: 2 },
  },
): string {
  return [
    frame({ type: 'response.output_text.delta', delta: 'ok' }),
    frame({ type, response }),
  ].join('')
}

function responsesUsage(): string {
  return responsesText('response.completed', {
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 6 },
    },
  })
}

function chatTool(count: 1 | 2 = 1): string {
  const toolCalls = Array.from({ length: count }, (_, index) => ({
    index,
    id: `call-${index + 1}`,
    type: 'function',
    function: {
      name: 'lookup',
      arguments: JSON.stringify({ q: index ? 'y' : 'x' }),
    },
  }))
  return [
    frame({ choices: [{ delta: { tool_calls: toolCalls } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    frame({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }),
    'data: [DONE]\n\n',
  ].join('')
}

function responsesTool(count: 1 | 2 = 1): string {
  const items = Array.from({ length: count }, (_, index) => ({
    type: 'response.output_item.done',
    output_index: index,
    item: {
      type: 'function_call',
      id: `item-${index + 1}`,
      call_id: `call-${index + 1}`,
      name: 'lookup',
      arguments: JSON.stringify({ q: index ? 'y' : 'x' }),
    },
  }))
  return [
    ...items.map(frame),
    frame({
      type: 'response.completed',
      response: { usage: { input_tokens: 12, output_tokens: 3 } },
    }),
  ].join('')
}

function responsesReasoning(): string {
  return [
    frame({
      type: 'response.reasoning_summary_part.added',
      item_id: 'reason-1',
      part: { type: 'summary_text', text: 'ok' },
    }),
    frame({
      type: 'response.reasoning_summary_part.done',
      item_id: 'reason-1',
    }),
    frame({
      type: 'response.output_item.done',
      item: {
        type: 'reasoning',
        id: 'reason-1',
        summary: [{ type: 'summary_text', text: 'ok' }],
        encrypted_content: 'encrypted-1',
      },
    }),
    frame({
      type: 'response.completed',
      response: { usage: { input_tokens: 13, output_tokens: 4 } },
    }),
  ].join('')
}

function responseForTrajectory(protocol: Protocol, name: string): string {
  if (
    name === 'parallel-tool-continuation' ||
    name === 'single-tool-continuation'
  )
    return protocol === 'chat' ? chatText() : responsesText()
  if (name === 'reasoning-tool-continuation')
    return protocol === 'chat' ? chatText() : responsesReasoning()
  return protocol === 'chat' ? chatText() : responsesText()
}

function normalizeError(error: unknown): NormalizedError {
  const value = error as {
    kind?: unknown
    retryable?: unknown
    message?: unknown
  }
  const message = typeof value.message === 'string' ? value.message : ''
  if (message.includes('does not support enabled'))
    return { kind: 'unsupported_capability', retryable: false }
  if (message.includes('ended before a terminal'))
    return {
      kind: 'transport_error',
      retryable: true,
      message: 'premature_eof',
    }
  return {
    kind: typeof value.kind === 'string' ? value.kind : 'unknown',
    retryable: value.retryable === true,
  }
}

function normalizedCall(
  protocol: Protocol,
  input: string | URL | Request,
  init?: RequestInit,
): CapturedCall {
  const headers = new Headers(init?.headers)
  const authorization = headers.get('authorization')
  return {
    protocol,
    pathname: new URL(String(input)).pathname,
    method: String(init?.method ?? 'GET'),
    headers: [...headers.keys()].sort(),
    authorization: authorization?.startsWith('Bearer ')
      ? 'Bearer <redacted>'
      : (authorization ?? ''),
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
  }
}

function outcome(result: CapturedResult): CapturedResult {
  if (result.events !== undefined) return { events: result.events }
  if (result.error !== undefined) return { error: result.error }
  return {}
}

function project(result: CapturedResult): CapturedResult {
  const projected: CapturedResult = {}
  if (result.request !== undefined) projected.request = result.request
  if (result.events !== undefined) projected.events = result.events
  else if (result.error !== undefined) projected.error = result.error
  return projected
}

function usageFrom(result: CapturedResult): ModelUsage {
  const usageEvent = result.events?.find((event) => event.type === 'usage')
  if (usageEvent === undefined || usageEvent.type !== 'usage') {
    throw new Error('Expected provider stream to emit a usage event')
  }
  return usageEvent.usage
}

async function run(
  protocol: Protocol,
  request: ModelRequest,
  body: string | Error,
  status = 200,
): Promise<CapturedResult> {
  const calls: CapturedCall[] = []
  const fetchImplementation: typeof fetch = async (input, init) => {
    calls.push(normalizedCall(protocol, input, init))
    if (body instanceof Error) throw body
    return new Response(body, {
      status,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const provider =
    protocol === 'chat'
      ? new OpenAICompatibleProvider({
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'fixture-key',
          model: 'fixture-model',
          fetchImplementation,
        })
      : new OpenAIResponsesProvider({
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'fixture-key',
          model: 'fixture-model',
          fetchImplementation,
        })
  const events: ModelStreamEvent[] = []
  try {
    for await (const event of provider.complete(request)) events.push(event)
    return { ...(calls[0] === undefined ? {} : { request: calls[0] }), events }
  } catch (error) {
    return {
      ...(calls[0] === undefined ? {} : { request: calls[0] }),
      error: normalizeError(error),
    }
  }
}

function capabilityEvidence(
  chat: ModelProviderCapabilities,
  responses: ModelProviderCapabilities,
): Record<string, unknown> {
  return {
    chat: {
      streaming: chat.streaming,
      usage: chat.usage,
      tools: chat.tools,
      images: chat.images,
      ...(chat.documents === undefined ? {} : { documents: chat.documents }),
      thinking: chat.thinking,
      terminalReasons: chat.terminalReasons,
    },
    responses: {
      streaming: responses.streaming,
      usage: responses.usage,
      tools: responses.tools,
      images: responses.images,
      documents: responses.documents,
      webSearch: responses.webSearch,
      thinking: responses.thinking,
      terminalReasons: responses.terminalReasons,
    },
    comparison: {
      sharedEnabled: [
        'streaming',
        'usage',
        'tools',
        'images',
        'terminalReasons',
      ],
      sharedThinkingModes: ['disabled'],
      chatUndeclared: ['documents', 'webSearch'],
      responsesExplicitlyDisabled: ['documents', 'webSearch'],
      responsesAdditionalThinkingModes: ['enabled', 'adaptive'],
    },
  }
}

describe('OpenAI protocol comparison', () => {
  it('matches the versioned request and continuation artifact', async () => {
    const actual: Record<
      string,
      { chat: CapturedResult; responses: CapturedResult }
    > = {}
    for (const [name, request] of Object.entries(requests)) {
      const chat = await run(
        'chat',
        request,
        responseForTrajectory('chat', name),
      )
      const responses = await run(
        'responses',
        request,
        responseForTrajectory('responses', name),
      )
      actual[name] = {
        chat: project(chat),
        responses: project(responses),
      }
    }
    expect(actual).toEqual(fixture.trajectories)
    expect(fixture.decision.portableSubset).toEqual([
      'terminal-text',
      'single-tool-continuation',
      'parallel-tool-continuation',
      'basic-input-output-usage',
    ])
    expect(fixture.decision.failClosed).toContain('reasoning-tool-continuation')
    expect(fixture.decision.failClosed).toContain('signed-reasoning-history')
    expect(fixture.decision.notComparable).toEqual([
      'developer-instruction-control',
      'tool-selection-control',
      'parallel-tool-execution-control',
      'response-refusal-semantics',
    ])
  })

  it('matches terminal, usage, and fail-closed capability evidence', async () => {
    const chatProvider = new OpenAICompatibleProvider({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'fixture-key',
      model: 'fixture-model',
      fetchImplementation: async () => new Response(chatText()),
    })
    const responsesProvider = new OpenAIResponsesProvider({
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'fixture-key',
      model: 'fixture-model',
      fetchImplementation: async () => new Response(responsesText()),
    })
    const actualMatrix: Record<
      string,
      { chat: CapturedResult; responses: CapturedResult }
    > = {
      'successful-end-turn': {
        chat: await run('chat', terminalText, chatText()),
        responses: await run('responses', terminalText, responsesText()),
      },
      'tool-use-terminal': {
        chat: await run('chat', terminalText, chatTool()),
        responses: await run('responses', terminalText, responsesTool()),
      },
      'max-token-terminal': {
        chat: await run('chat', terminalText, chatText('length')),
        responses: await run(
          'responses',
          terminalText,
          responsesText('response.incomplete', {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          }),
        ),
      },
      'content-filter-and-incomplete': {
        chat: await run('chat', terminalText, chatText('content_filter')),
        responses: await run(
          'responses',
          terminalText,
          responsesText('response.incomplete', {
            status: 'incomplete',
            incomplete_details: { reason: 'content_filter' },
          }),
        ),
      },
      'provider-stream-api-failure': {
        chat: await run(
          'chat',
          terminalText,
          frame({ error: { type: 'api_error', message: 'provider failed' } }),
        ),
        responses: await run(
          'responses',
          terminalText,
          frame({ type: 'error' }),
        ),
      },
      'pre-aborted-cancellation': {
        chat: await run(
          'chat',
          { ...terminalText, signal: abortedSignal() },
          new Error('aborted'),
        ),
        responses: await run(
          'responses',
          { ...terminalText, signal: abortedSignal() },
          new Error('aborted'),
        ),
      },
      'premature-eof': {
        chat: await run(
          'chat',
          terminalText,
          frame({ choices: [{ delta: { content: 'partial' } }] }),
        ),
        responses: await run(
          'responses',
          terminalText,
          frame({ type: 'response.output_text.delta', delta: 'partial' }),
        ),
      },
    }
    const usage = {
      chat: usageFrom(await run('chat', terminalText, chatUsage())),
      responses: usageFrom(
        await run('responses', terminalText, responsesUsage()),
      ),
      modelUsage: ['inputTokens', 'outputTokens'],
      reasoningTokens: 'unrepresented',
      cacheReadInputTokens: 'responses-only-currently',
    }
    const capabilities = capabilityEvidence(
      chatProvider.capabilities,
      responsesProvider.capabilities,
    )
    expect(
      Object.fromEntries(
        Object.entries(actualMatrix).map(([name, results]) => [
          name,
          {
            chat: outcome(results.chat),
            responses: outcome(results.responses),
          },
        ]),
      ),
    ).toEqual(fixture.terminalMatrix)
    expect(usage).toEqual(fixture.usage)
    expect(capabilities).toEqual(fixture.capabilities)
    expect(fixture.decision.automaticCrossProtocolFallback).toBe(
      'not_authorized',
    )
  })
})

function abortedSignal(): AbortSignal {
  const controller = new AbortController()
  controller.abort()
  return controller.signal
}
