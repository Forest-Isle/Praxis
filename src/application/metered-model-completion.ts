import {
  AgentRunCancelledError,
  type ModelProvider,
  type ModelRequest,
  type ModelToolCall,
  type ModelUsage,
} from '../core/runtime.js'

export interface MeteredModelCompletion {
  text: string
  toolCalls: readonly ModelToolCall[]
  usage: ModelUsage
  model?: string
  durationApiMs: number
  durationApiWithoutRetriesMs: number
}

export interface MeteredModelRequestOptions {
  onTextDelta?: (delta: string) => void
  onMetrics?: (metrics: MeteredModelCompletion) => void
}

function nonblankModel(provider: ModelProvider): string | undefined {
  if (provider.model === undefined) return undefined
  return provider.model.trim() === '' ? undefined : provider.model
}

function enrichCapabilityMetadata(
  usage: ModelUsage,
  value: number | undefined,
  field: 'contextWindow' | 'maxOutputTokens',
): ModelUsage {
  if (usage[field] !== undefined) return usage
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) {
    return usage
  }
  return { ...usage, [field]: value }
}

function enrichedUsage(provider: ModelProvider, usage: ModelUsage): ModelUsage {
  return enrichCapabilityMetadata(
    enrichCapabilityMetadata(
      usage,
      provider.capabilities.contextWindowTokens,
      'contextWindow',
    ),
    provider.capabilities.maxOutputTokens,
    'maxOutputTokens',
  )
}

export async function completeMeteredModelRequest(
  provider: ModelProvider,
  request: ModelRequest,
  options: MeteredModelRequestOptions = {},
): Promise<MeteredModelCompletion> {
  const { onTextDelta, onMetrics } = options
  if (request.signal?.aborted) throw new AgentRunCancelledError()
  let text = ''
  const toolCalls: ModelToolCall[] = []
  let usage: ModelUsage = { inputTokens: 0, outputTokens: 0 }
  let attemptDurationMs: number | undefined
  let attemptDurationSeen = false
  const apiStartedAt = performance.now()
  let metrics: MeteredModelCompletion
  try {
    for await (const event of provider.complete(request)) {
      if (request.signal?.aborted) throw new AgentRunCancelledError()
      if (event.type === 'api-retry') continue
      if (event.type === 'api-attempt-duration') {
        if (attemptDurationSeen) {
          throw new Error(
            'Provider emitted multiple api-attempt-duration events in one attempt',
          )
        }
        attemptDurationSeen = true
        const { durationMs } = event
        if (
          typeof durationMs !== 'number' ||
          !Number.isFinite(durationMs) ||
          durationMs < 0
        ) {
          throw new TypeError(
            'api-attempt-duration durationMs must be a finite nonnegative number',
          )
        }
        attemptDurationMs = durationMs
        continue
      }
      if (event.type === 'text-delta') {
        text += event.delta
        onTextDelta?.(event.delta)
      } else if (event.type === 'usage') {
        usage = event.usage
      } else if (event.type === 'tool-call') {
        toolCalls.push(event.call)
      }
    }
  } finally {
    const model = nonblankModel(provider)
    const durationApiMs = Math.max(0, performance.now() - apiStartedAt)
    metrics = {
      text,
      toolCalls,
      usage: enrichedUsage(provider, usage),
      ...(model === undefined ? {} : { model }),
      durationApiMs,
      durationApiWithoutRetriesMs: attemptDurationMs ?? durationApiMs,
    }
    onMetrics?.(metrics)
  }
  return metrics
}
