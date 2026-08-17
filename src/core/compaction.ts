import type { ModelMessage, ModelUsage } from './runtime.js'

export interface CompactionRequest {
  messages: readonly ModelMessage[]
  targetTokens: number
  contextWindowTokens: number
  signal?: AbortSignal
}

export interface CompactionResult {
  summary: string
  usage: ModelUsage
  durationMs: number
  durationWithoutRetriesMs?: number
  model?: string
}

export interface Compactor {
  compact(request: CompactionRequest): Promise<CompactionResult>
}
