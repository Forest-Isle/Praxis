import type { ModelMessage, ModelUsage } from './runtime.js'

export interface CompactionRequest {
  messages: readonly ModelMessage[]
  targetTokens: number
  signal?: AbortSignal
}

export interface CompactionResult {
  summary: string
  usage: ModelUsage
  durationMs: number
}

export interface Compactor {
  compact(request: CompactionRequest): Promise<CompactionResult>
}
