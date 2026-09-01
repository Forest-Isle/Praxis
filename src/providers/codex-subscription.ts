import {
  ModelProviderError,
  type ModelContentBlock,
  type ModelImage,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelThinkingConfig,
  type ModelToolCall,
  type ProviderErrorKind,
  malformedModelToolCall,
} from '../core/runtime.js'
import {
  CodexOAuthError,
  type CodexOAuthAccess,
  type CodexOAuthAccessOptions,
} from './codex-oauth.js'

export const CODEX_RESPONSES_ENDPOINT =
  'https://chatgpt.com/backend-api/codex/responses'

export type CodexOAuthAccessResolver = (
  options?: CodexOAuthAccessOptions,
) => Promise<CodexOAuthAccess>

export interface CodexSubscriptionProviderOptions {
  model: string
  access: CodexOAuthAccessResolver
  fetchImplementation?: typeof fetch
  maxStreamBufferBytes?: number
  maxToolArgumentsBytes?: number
  maxToolCallsPerResponse?: number
  maxToolMetadataBytes?: number
  maxReasoningBytes?: number
  maxErrorBodyBytes?: number
  thinking?: ModelThinkingConfig
}

interface ResponsesInputItem {
  role?: string
  type?: string
  [key: string]: unknown
}

interface PendingReasoning {
  itemId: string
  summary: string
  signature?: string
  activePart: boolean
  partSeen: boolean
  itemDone: boolean
}

interface PendingFunctionCall {
  key: string
  index: number
  id: string
  name: string
  arguments: string
  done: boolean
  emitted: boolean
  hadArgumentDelta: boolean
}

interface ParserState {
  reasoning: PendingReasoning | undefined
  calls: Map<string, PendingFunctionCall>
  callOrder: number
  toolCallCount: number
  argumentBytes: number
  metadataBytes: number
  terminal: boolean
  usageEmitted: boolean
  toolCallEmitted: boolean
}

const DEFAULT_MAX_STREAM = 1024 * 1024
const DEFAULT_MAX_ARGUMENTS = 1024 * 1024
const DEFAULT_MAX_CALLS = 32
const DEFAULT_MAX_METADATA = 1024 * 1024
const DEFAULT_MAX_REASONING = 1024 * 1024
const DEFAULT_MAX_ERROR = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Codex parser limits must be positive integers')
  return value
}

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function invalid(message: string): ModelProviderError {
  return new ModelProviderError(message, {
    kind: 'invalid_request',
    retryable: false,
  })
}

function validateThinking(thinking: ModelThinkingConfig | undefined): void {
  if (thinking === undefined) return
  if (
    thinking.mode !== 'disabled' &&
    thinking.mode !== 'enabled' &&
    thinking.mode !== 'adaptive'
  ) {
    throw new Error(
      'Codex subscription provider received an invalid thinking mode',
    )
  }
  if (thinking.maxTokens !== undefined)
    throw new Error(
      'Codex subscription provider does not support thinking token budgets',
    )
}

function providerError(
  kind: ProviderErrorKind,
  retryable: boolean,
  status?: number,
): ModelProviderError {
  return new ModelProviderError(
    status === undefined
      ? 'Codex subscription provider request failed'
      : `Codex subscription provider request failed with HTTP ${status}`,
    { kind, retryable, ...(status === undefined ? {} : { status }) },
  )
}

function statusKind(status: number): {
  kind: ProviderErrorKind
  retryable: boolean
} {
  if (status === 401 || status === 403)
    return { kind: 'authentication_failed', retryable: false }
  if (status === 408) return { kind: 'timeout', retryable: true }
  if (status === 429) return { kind: 'rate_limit', retryable: true }
  if (status >= 500) return { kind: 'server_error', retryable: true }
  return { kind: 'invalid_request', retryable: false }
}

function transportError(
  error: unknown,
  signal?: AbortSignal,
): ModelProviderError {
  if (signal?.aborted) return providerError('cancelled', false)
  if (
    isRecord(error) &&
    (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT')
  ) {
    return providerError('timeout', true)
  }
  return providerError('transport_error', true)
}

function accessError(error: unknown, signal?: AbortSignal): ModelProviderError {
  if (
    signal?.aborted ||
    (error instanceof CodexOAuthError &&
      error.code === 'authorization_cancelled')
  )
    return providerError('cancelled', false)
  if (error instanceof CodexOAuthError)
    return providerError('authentication_failed', false)
  if (error instanceof ModelProviderError) return error
  return transportError(error, signal)
}

function dataUrl(image: ModelImage): string {
  return `data:${image.mediaType};base64,${image.data}`
}

function appendMedia(
  blocks: readonly ModelContentBlock[] | undefined,
  legacy: readonly ModelImage[] | undefined,
  role: 'user' | 'tool',
): ResponsesInputItem[] {
  const output: ResponsesInputItem[] = []
  const seenImages = new Set<string>()
  const addImage = (image: ModelImage) => {
    const url = dataUrl(image)
    if (seenImages.has(url)) return
    seenImages.add(url)
    output.push({ type: 'input_image', image_url: url })
  }
  let hasDocument = false
  for (const block of blocks ?? []) {
    if (block.type === 'text') {
      if (block.text.length > 0)
        output.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'image') {
      addImage(block)
    } else {
      hasDocument = true
    }
  }
  if (hasDocument)
    throw invalid(
      `Codex subscription provider does not support ${role} documents`,
    )
  for (const image of legacy ?? []) addImage(image)
  return output
}

function userItem(
  message: Extract<ModelMessage, { role: 'user' }>,
): ResponsesInputItem {
  const content = appendMedia(message.contentBlocks, message.images, 'user')
  if (content.length === 0 && message.content.length > 0)
    content.push({ type: 'input_text', text: message.content })
  return { role: 'user', content }
}

function serializeMessages(messages: readonly ModelMessage[]): {
  instructions: string
  input: ResponsesInputItem[]
} {
  const instructions: string[] = []
  const input: ResponsesInputItem[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      instructions.push(message.content)
      continue
    }
    if (message.role === 'user') {
      input.push(userItem(message))
      continue
    }
    if (message.role === 'assistant') {
      for (const block of message.thinkingBlocks ?? []) {
        if (block.type !== 'thinking' || block.signature.length === 0)
          throw invalid(
            'Codex subscription provider cannot replay unsigned thinking',
          )
        input.push({
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: block.thinking }],
          encrypted_content: block.signature,
        })
      }
      if (message.content.length > 0)
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }],
        })
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        })
      }
      continue
    }
    if (message.documents?.length)
      throw invalid(
        'Codex subscription provider does not support tool documents',
      )
    const content = appendMedia(message.contentBlocks, message.images, 'tool')
    const output = message.contentBlocks
      ? message.contentBlocks
          .filter(
            (block): block is Extract<ModelContentBlock, { type: 'text' }> =>
              block.type === 'text',
          )
          .map((block) => block.text)
          .join('')
      : message.content
    input.push({
      type: 'function_call_output',
      call_id: message.toolCallId,
      output,
    })
    const images = content.filter((block) => block.type === 'input_image')
    if (images.length > 0) input.push({ role: 'user', content: images })
  }
  return { instructions: instructions.join('\n\n'), input }
}

export function serializeCodexRequest(
  request: ModelRequest,
  model: string,
  configuredThinking?: ModelThinkingConfig,
): Record<string, unknown> {
  if (request.webSearch !== undefined)
    throw invalid('Codex subscription provider does not support web search')
  if (request.betas !== undefined)
    throw invalid('Codex subscription provider does not support beta features')
  const thinking = request.thinking ?? configuredThinking
  if (
    thinking !== undefined &&
    thinking.mode !== 'disabled' &&
    thinking.mode !== 'enabled' &&
    thinking.mode !== 'adaptive'
  )
    throw invalid(
      'Codex subscription provider received an invalid thinking mode',
    )
  if (thinking?.maxTokens !== undefined)
    throw invalid(
      'Codex subscription provider does not support thinking token budgets',
    )
  if (
    request.messages.some(
      (message) => message.role === 'user' && message.documents?.length,
    )
  )
    throw invalid('Codex subscription provider does not support user documents')
  if (
    request.messages.some(
      (message) => message.role === 'tool' && message.documents?.length,
    )
  )
    throw invalid('Codex subscription provider does not support tool documents')
  const { instructions, input } = serializeMessages(request.messages)
  const body: Record<string, unknown> = {
    model,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    instructions,
    input,
  }
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }))
  }
  if (thinking && thinking.mode !== 'disabled') {
    body.reasoning = {
      ...(request.effort ? { effort: request.effort } : {}),
      summary: 'auto',
    }
  }
  return body
}

function usageFrom(value: unknown): ModelStreamEvent | undefined {
  if (!isRecord(value)) return undefined
  const input = value.input_tokens
  const output = value.output_tokens
  if (input === undefined && output === undefined) {
    throw invalid('Codex provider returned invalid usage')
  }
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isSafeInteger(input) ||
    input < 0 ||
    !Number.isSafeInteger(output) ||
    output < 0
  )
    throw invalid('Codex provider returned invalid usage')
  const details = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : undefined
  const cached = details?.cached_tokens
  if (
    cached !== undefined &&
    (typeof cached !== 'number' || !Number.isSafeInteger(cached) || cached < 0)
  )
    throw invalid('Codex provider returned invalid usage')
  return {
    type: 'usage',
    usage: {
      inputTokens: input,
      outputTokens: output,
      ...(typeof cached === 'number' && cached > 0
        ? { cacheReadInputTokens: cached }
        : {}),
    },
  }
}

function responsePayload(
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (isRecord(value.response)) return value.response
  return value
}

function callKey(value: Record<string, unknown>): {
  key: string
  index: number
} {
  if (value.item_id !== undefined && typeof value.item_id !== 'string')
    throw invalid('Codex provider returned an invalid function item identity')
  const id = typeof value.item_id === 'string' ? value.item_id : undefined
  const outputIndex =
    typeof value.output_index === 'number' ? value.output_index : undefined
  if (
    value.output_index !== undefined &&
    typeof value.output_index !== 'number'
  )
    throw invalid('Codex provider returned an invalid output index')
  if (
    outputIndex !== undefined &&
    (!Number.isSafeInteger(outputIndex) || outputIndex < 0)
  )
    throw invalid('Codex provider returned an invalid output index')
  if (outputIndex !== undefined)
    return { key: `index:${outputIndex}`, index: outputIndex }
  if (id) return { key: `id:${id}`, index: Number.MAX_SAFE_INTEGER }
  throw invalid('Codex provider returned a function call without an identity')
}

function finishReason(reason: unknown): 'end_turn' | 'max_tokens' {
  if (reason === 'max_output_tokens') return 'max_tokens'
  throw invalid('Codex provider returned an unsupported incomplete response')
}

function finishReasonFor(
  value: Record<string, unknown>,
): 'end_turn' | 'tool_use' | 'max_tokens' {
  const response = responsePayload(value)
  if (
    value.type === 'response.incomplete' ||
    response.status === 'incomplete'
  ) {
    const details = isRecord(response.incomplete_details)
      ? response.incomplete_details
      : undefined
    return finishReason(details?.reason ?? response.reason)
  }
  return 'tool_use'
}

function reasoningBytes(reasoning: PendingReasoning): number {
  return (
    bytes(reasoning.summary) +
    (reasoning.signature === undefined ? 0 : bytes(reasoning.signature))
  )
}

function completedReasoning(state: ParserState): ModelStreamEvent[] {
  const reasoning = state.reasoning
  if (
    !reasoning ||
    reasoning.activePart ||
    !reasoning.itemDone ||
    !reasoning.signature
  )
    throw invalid('Codex provider returned an incomplete reasoning block')
  const events: ModelStreamEvent[] = []
  if (reasoning.signature.length > 0)
    events.push({
      type: 'thinking-signature-delta',
      delta: reasoning.signature,
    })
  events.push({
    type: 'thinking-stop',
    block: {
      type: 'thinking',
      thinking: reasoning.summary,
      signature: reasoning.signature,
    },
  })
  state.reasoning = undefined
  return events
}

function parseEvent(
  value: Record<string, unknown>,
  state: ParserState,
  limits: {
    arguments: number
    calls: number
    metadata: number
    reasoning: number
  },
): ModelStreamEvent[] {
  if (state.terminal)
    throw invalid('Codex provider emitted data after terminal response')
  const type = typeof value.type === 'string' ? value.type : ''
  const events: ModelStreamEvent[] = []
  if (type === 'response.output_text.delta') {
    const delta = value.delta
    if (typeof delta !== 'string')
      throw invalid('Codex provider returned invalid text delta')
    if (delta.length) events.push({ type: 'text-delta', delta })
    return events
  }
  if (type === 'response.reasoning_summary_part.added') {
    const itemId = value.item_id
    if (typeof itemId !== 'string' || itemId.length === 0)
      throw invalid(
        'Codex provider returned reasoning without an item identity',
      )
    const part = isRecord(value.part) ? value.part : value
    if (state.reasoning) {
      if (state.reasoning.itemId !== itemId || state.reasoning.itemDone)
        throw invalid('Codex provider interleaved reasoning blocks')
      if (state.reasoning.activePart)
        throw invalid('Codex provider interleaved reasoning summary parts')
      if (state.reasoning.summary.length > 0) {
        state.reasoning.summary += '\n'
        if (reasoningBytes(state.reasoning) > limits.reasoning)
          throw invalid('Codex provider exceeded the reasoning limit')
        events.push({ type: 'thinking-delta', delta: '\n' })
      }
      state.reasoning.activePart = true
      state.reasoning.partSeen = true
    } else {
      state.reasoning = {
        itemId,
        summary: '',
        activePart: true,
        partSeen: true,
        itemDone: false,
      }
      events.push({
        type: 'thinking-start',
        block: { type: 'thinking', thinking: '' },
      })
    }
    if (isRecord(part) && typeof part.text === 'string' && part.text.length) {
      state.reasoning.summary += part.text
      if (reasoningBytes(state.reasoning) > limits.reasoning)
        throw invalid('Codex provider exceeded the reasoning limit')
      events.push({ type: 'thinking-delta', delta: part.text })
    }
    return events
  }
  if (type === 'response.reasoning_summary_text.delta') {
    if (!state.reasoning)
      throw invalid('Codex provider returned reasoning text without a block')
    if (!state.reasoning.activePart)
      throw invalid(
        'Codex provider returned reasoning text without an active part',
      )
    if (value.item_id !== state.reasoning.itemId)
      throw invalid('Codex provider reasoning item identity mismatch')
    const delta = value.delta
    if (typeof delta !== 'string')
      throw invalid('Codex provider returned invalid reasoning delta')
    state.reasoning.summary += delta
    if (reasoningBytes(state.reasoning) > limits.reasoning)
      throw invalid('Codex provider exceeded the reasoning limit')
    if (delta.length) events.push({ type: 'thinking-delta', delta })
    return events
  }
  if (type === 'response.reasoning_summary_part.done') {
    if (!state.reasoning)
      throw invalid('Codex provider completed unknown reasoning block')
    if (value.item_id !== state.reasoning.itemId)
      throw invalid('Codex provider reasoning item identity mismatch')
    if (!state.reasoning.activePart)
      throw invalid('Codex provider duplicated a reasoning summary part')
    state.reasoning.activePart = false
    if (state.reasoning.itemDone) events.push(...completedReasoning(state))
    return events
  }
  if (type === 'response.function_call_arguments.delta') {
    const { key, index } = callKey(value)
    let call =
      value.item_id === undefined
        ? undefined
        : state.calls.get(`id:${String(value.item_id)}`)
    if (!call) call = state.calls.get(key)
    if (!call) {
      if (state.toolCallCount >= limits.calls)
        throw invalid('Codex provider exceeded the tool call limit')
      call = {
        key,
        index,
        id: '',
        name: '',
        arguments: '',
        done: false,
        emitted: false,
        hadArgumentDelta: false,
      }
      state.calls.set(key, call)
      state.toolCallCount++
    }
    if (call.done) throw invalid('Codex provider duplicated a function call')
    const delta = value.delta
    if (typeof delta !== 'string')
      throw invalid('Codex provider returned invalid function arguments')
    call.arguments += delta
    call.hadArgumentDelta = true
    state.argumentBytes += bytes(delta)
    if (state.argumentBytes > limits.arguments)
      throw invalid('Codex provider exceeded the function argument limit')
    if (typeof value.item_id === 'string')
      state.metadataBytes += bytes(value.item_id)
    if (state.metadataBytes > limits.metadata)
      throw invalid('Codex provider exceeded function metadata limits')
    return events
  }
  if (type === 'response.output_item.done') {
    const item = isRecord(value.item) ? value.item : undefined
    if (!item || typeof item.type !== 'string')
      throw invalid('Codex provider returned an invalid output item')
    if (item.type === 'reasoning') {
      const itemId = typeof item.id === 'string' ? item.id : undefined
      if (!itemId)
        throw invalid(
          'Codex provider returned reasoning without an item identity',
        )
      const signature = item.encrypted_content
      if (typeof signature !== 'string' || signature.length === 0)
        throw invalid('Codex provider returned unsigned reasoning')
      if (!state.reasoning) {
        const summary = item.summary
        if (!Array.isArray(summary) || summary.length === 0)
          throw invalid('Codex provider returned an invalid reasoning summary')
        const texts: string[] = []
        for (const entry of summary) {
          if (
            !isRecord(entry) ||
            entry.type !== 'summary_text' ||
            typeof entry.text !== 'string' ||
            entry.text.length === 0
          )
            throw invalid(
              'Codex provider returned an invalid reasoning summary',
            )
          texts.push(entry.text)
        }
        state.reasoning = {
          itemId,
          summary: texts.join('\n'),
          activePart: false,
          partSeen: true,
          itemDone: true,
          signature,
        }
        if (reasoningBytes(state.reasoning) > limits.reasoning)
          throw invalid('Codex provider exceeded the reasoning limit')
        events.push({
          type: 'thinking-start',
          block: { type: 'thinking', thinking: '' },
        })
        events.push({ type: 'thinking-delta', delta: state.reasoning.summary })
        events.push(...completedReasoning(state))
        return events
      }
      if (state.reasoning.itemId !== itemId)
        throw invalid('Codex provider reasoning item identity mismatch')
      if (state.reasoning.itemDone)
        throw invalid('Codex provider duplicated a reasoning item')
      if (item.summary !== undefined) {
        if (!Array.isArray(item.summary) || item.summary.length === 0)
          throw invalid('Codex provider returned an invalid reasoning summary')
        for (const entry of item.summary) {
          if (
            !isRecord(entry) ||
            entry.type !== 'summary_text' ||
            typeof entry.text !== 'string' ||
            entry.text.length === 0
          )
            throw invalid(
              'Codex provider returned an invalid reasoning summary',
            )
        }
      }
      state.reasoning.signature = signature
      state.reasoning.itemDone = true
      if (reasoningBytes(state.reasoning) > limits.reasoning)
        throw invalid('Codex provider exceeded the reasoning limit')
      if (!state.reasoning.activePart) events.push(...completedReasoning(state))
      return events
    }
    if (item.type !== 'function_call') return events
    const id = typeof item.call_id === 'string' ? item.call_id : ''
    const name = typeof item.name === 'string' ? item.name : ''
    if (!id || !name)
      throw invalid('Codex provider returned an invalid function call')
    const outputIndex =
      typeof value.output_index === 'number'
        ? value.output_index
        : typeof item.output_index === 'number'
          ? item.output_index
          : undefined
    if (
      (value.output_index !== undefined &&
        typeof value.output_index !== 'number') ||
      (item.output_index !== undefined && typeof item.output_index !== 'number')
    )
      throw invalid('Codex provider returned an invalid output index')
    const itemId = typeof item.id === 'string' ? item.id : undefined
    if (
      outputIndex !== undefined &&
      (!Number.isSafeInteger(outputIndex) || outputIndex < 0)
    )
      throw invalid('Codex provider returned an invalid output index')
    const key =
      outputIndex !== undefined
        ? `index:${outputIndex}`
        : itemId
          ? `id:${itemId}`
          : undefined
    if (!key)
      throw invalid(
        'Codex provider returned a function call without an identity',
      )
    let call =
      itemId === undefined ? undefined : state.calls.get(`id:${itemId}`)
    if (!call) call = state.calls.get(key)
    if (!call && outputIndex !== undefined) {
      call = [...state.calls.values()].find(
        (candidate) => candidate.index === outputIndex,
      )
    }
    if (!call) {
      if (state.toolCallCount >= limits.calls)
        throw invalid('Codex provider exceeded the tool call limit')
      call = {
        key,
        index: outputIndex ?? state.callOrder++,
        id: '',
        name: '',
        arguments: '',
        done: false,
        emitted: false,
        hadArgumentDelta: false,
      }
      state.calls.set(key, call)
      state.toolCallCount++
    }
    if (call.done || call.emitted)
      throw invalid('Codex provider duplicated a function call')
    call.id = id
    call.name = name
    const fullArguments = item.arguments
    if (call.arguments.length === 0) {
      if (typeof fullArguments !== 'string' || fullArguments.length === 0)
        throw invalid(
          'Codex provider returned a function call without arguments',
        )
      call.arguments = fullArguments
      state.argumentBytes += bytes(fullArguments)
      if (state.argumentBytes > limits.arguments)
        throw invalid('Codex provider exceeded the function argument limit')
    } else if (
      typeof fullArguments === 'string' &&
      call.hadArgumentDelta &&
      fullArguments !== call.arguments
    ) {
      throw invalid('Codex provider returned mismatched function arguments')
    }
    state.metadataBytes +=
      bytes(id) + bytes(name) + (itemId === undefined ? 0 : bytes(itemId))
    if (state.metadataBytes > limits.metadata)
      throw invalid('Codex provider exceeded function metadata limits')
    call.done = true
    let parsed: unknown
    try {
      parsed = JSON.parse(call.arguments || '{}')
    } catch {
      if (!id || !name)
        throw invalid('Codex provider returned an invalid tool call')
      call.emitted = true
      state.toolCallEmitted = true
      events.push({ type: 'tool-call', call: malformedModelToolCall(id, name) })
      return events
    }
    if (!isRecord(parsed))
      throw invalid('Codex provider returned non-object function arguments')
    call.emitted = true
    state.toolCallEmitted = true
    const toolCall: ModelToolCall = { id, name, input: parsed }
    events.push({ type: 'tool-call', call: toolCall })
    return events
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    if (state.reasoning)
      throw invalid('Codex provider ended with incomplete reasoning')
    for (const call of state.calls.values()) {
      if (!call.done || !call.emitted)
        throw invalid('Codex provider ended with an incomplete function call')
    }
    const response = responsePayload(value)
    const usage = usageFrom(
      isRecord(response.usage)
        ? response.usage
        : isRecord(value.usage)
          ? value.usage
          : undefined,
    )
    if (usage && !state.usageEmitted) {
      state.usageEmitted = true
      events.push(usage)
    }
    state.terminal = true
    events.push({
      type: 'terminal',
      reason:
        type === 'response.incomplete'
          ? finishReasonFor(value)
          : state.toolCallEmitted
            ? 'tool_use'
            : 'end_turn',
    })
    return events
  }
  if (type === 'response.failed' || type === 'error' || isRecord(value.error))
    throw providerError('api_error', true)
  return events
}

function parseFrame(
  frame: string,
  state: ParserState,
  limits: {
    arguments: number
    calls: number
    metadata: number
    reasoning: number
  },
): ModelStreamEvent[] {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw invalid('Codex provider returned malformed SSE JSON')
  }
  if (!isRecord(parsed))
    throw invalid('Codex provider returned malformed SSE event')
  return parseEvent(parsed, state, limits)
}

export function parseCodexSseFrame(data: string): ModelStreamEvent[] {
  const state: ParserState = {
    reasoning: undefined,
    calls: new Map(),
    callOrder: 0,
    toolCallCount: 0,
    argumentBytes: 0,
    metadataBytes: 0,
    terminal: false,
    usageEmitted: false,
    toolCallEmitted: false,
  }
  return parseFrame(data, state, {
    arguments: DEFAULT_MAX_ARGUMENTS,
    calls: DEFAULT_MAX_CALLS,
    metadata: DEFAULT_MAX_METADATA,
    reasoning: DEFAULT_MAX_REASONING,
  })
}

async function drainBody(response: Response, maxBytes: number): Promise<void> {
  const reader = response.body?.getReader()
  if (!reader) return
  let total = 0
  let ended = false
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) {
        ended = true
        return
      }
      total += next.value.byteLength
      if (total > maxBytes) return
    }
  } finally {
    if (!ended) {
      try {
        await reader.cancel()
      } catch {
        /* preserve primary error */
      }
    }
    reader.releaseLock()
  }
}

export class CodexSubscriptionProvider implements ModelProvider {
  readonly model: string
  readonly capabilities: ModelProvider['capabilities'] = {
    streaming: true,
    usage: true,
    tools: true,
    images: true,
    documents: false,
    webSearch: false,
    thinking: { modes: ['disabled', 'enabled', 'adaptive'], maxTokens: false },
    terminalReasons: true,
  }

  private readonly fetchImplementation: typeof fetch
  private readonly maxStreamBufferBytes: number
  private readonly maxToolArgumentsBytes: number
  private readonly maxToolCallsPerResponse: number
  private readonly maxToolMetadataBytes: number
  private readonly maxReasoningBytes: number
  private readonly maxErrorBodyBytes: number

  constructor(private readonly options: CodexSubscriptionProviderOptions) {
    validateThinking(options.thinking)
    this.model = options.model
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.maxStreamBufferBytes = positiveInteger(
      options.maxStreamBufferBytes,
      DEFAULT_MAX_STREAM,
    )
    this.maxToolArgumentsBytes = positiveInteger(
      options.maxToolArgumentsBytes,
      DEFAULT_MAX_ARGUMENTS,
    )
    this.maxToolCallsPerResponse = positiveInteger(
      options.maxToolCallsPerResponse,
      DEFAULT_MAX_CALLS,
    )
    this.maxToolMetadataBytes = positiveInteger(
      options.maxToolMetadataBytes,
      DEFAULT_MAX_METADATA,
    )
    this.maxReasoningBytes = positiveInteger(
      options.maxReasoningBytes,
      DEFAULT_MAX_REASONING,
    )
    this.maxErrorBodyBytes = positiveInteger(
      options.maxErrorBodyBytes,
      DEFAULT_MAX_ERROR,
    )
  }

  async *complete(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    const body = serializeCodexRequest(
      request,
      this.model,
      this.options.thinking,
    )
    const signal = request.signal
    let access: CodexOAuthAccess
    try {
      access = await this.options.access(signal === undefined ? {} : { signal })
    } catch (error) {
      throw accessError(error, signal)
    }
    let refreshed = false
    let response: Response
    while (true) {
      const headers = {
        Authorization: `Bearer ${access.accessToken}`,
        'chatgpt-account-id': access.accountId,
        originator: 'praxis',
        'OpenAI-Beta': 'responses=experimental',
        accept: 'text/event-stream',
        'content-type': 'application/json',
      }
      try {
        response = await this.fetchImplementation(CODEX_RESPONSES_ENDPOINT, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        })
      } catch (error) {
        throw transportError(error, signal)
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true
        try {
          await drainBody(response, this.maxErrorBodyBytes)
        } catch {
          /* ignore unread body failures */
        }
        try {
          access = await this.options.access({
            forceAfter: access.accessToken,
            ...(signal === undefined ? {} : { signal }),
          })
        } catch (error) {
          throw accessError(error, signal)
        }
        continue
      }
      if (!response.ok) {
        try {
          await drainBody(response, this.maxErrorBodyBytes)
        } catch {
          /* preserve generic error */
        }
        const status = response.status
        const classified = statusKind(status)
        throw providerError(classified.kind, classified.retryable, status)
      }
      break
    }
    if (!response.body) throw providerError('transport_error', true)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let streamEnded = false
    const state: ParserState = {
      reasoning: undefined,
      calls: new Map(),
      callOrder: 0,
      toolCallCount: 0,
      argumentBytes: 0,
      metadataBytes: 0,
      terminal: false,
      usageEmitted: false,
      toolCallEmitted: false,
    }
    const limits = {
      arguments: this.maxToolArgumentsBytes,
      calls: this.maxToolCallsPerResponse,
      metadata: this.maxToolMetadataBytes,
      reasoning: this.maxReasoningBytes,
    }
    try {
      while (true) {
        const next = await reader.read()
        buffer += decoder.decode(next.value, { stream: !next.done })
        buffer = buffer.replaceAll('\r\n', '\n')
        if (bytes(buffer) > this.maxStreamBufferBytes)
          throw invalid('Codex provider exceeded the SSE buffer limit')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const event of parseFrame(frame, state, limits)) yield event
          if (state.terminal) break
          boundary = buffer.indexOf('\n\n')
        }
        if (state.terminal) break
        if (next.done) {
          streamEnded = true
          if (buffer.trim().length > 0)
            throw providerError('transport_error', true)
          throw providerError('transport_error', true)
        }
      }
    } catch (error) {
      if (error instanceof ModelProviderError) throw error
      throw transportError(error, signal)
    } finally {
      if (!streamEnded) {
        try {
          await reader.cancel()
        } catch {
          /* preserve primary error or consumer return */
        }
      }
      reader.releaseLock()
    }
  }
}
