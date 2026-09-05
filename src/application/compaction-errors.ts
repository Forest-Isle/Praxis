import { AgentRunCancelledError } from '../core/runtime.js'

export type CompactionTrigger = 'auto' | 'manual'
export type CompactionPhase =
  | 'validation'
  | 'generation'
  | 'receipt_prepare'
  | 'transcript_commit'
  | 'accounting_commit'
  | 'post_commit'
  | 'recovery'
export type CompactionDurableState =
  'not_committed' | 'committed' | 'indeterminate'
export type CompactionRecoveryDisposition =
  'none' | 'retry' | 'reconcile' | 'blocked'

export interface CompactionTransactionErrorMetadata {
  readonly trigger: CompactionTrigger
  readonly phase: CompactionPhase
  readonly durableState: CompactionDurableState
  readonly recoveryDisposition: CompactionRecoveryDisposition
}

/** A classified compaction failure. The original failure remains available as
 * `cause`, preserving provider error identity and retry/status metadata. */
export class CompactionTransactionError extends Error {
  override readonly name = 'CompactionTransactionError'
  readonly metadata: Readonly<CompactionTransactionErrorMetadata>
  override readonly cause: unknown

  constructor(
    message: string,
    metadata: CompactionTransactionErrorMetadata,
    cause?: unknown,
  ) {
    super(message, { cause })
    this.metadata = Object.freeze({ ...metadata })
    this.cause = cause
  }
}

export function isCompactionTransactionError(
  error: unknown,
): error is CompactionTransactionError {
  return error instanceof CompactionTransactionError
}

export function classifyCompactionError(
  error: unknown,
  metadata: CompactionTransactionErrorMetadata,
): CompactionTransactionError {
  if (error instanceof AgentRunCancelledError) throw error
  if (error instanceof CompactionTransactionError) return error
  return new CompactionTransactionError(
    `Compaction ${metadata.phase} failed: ${error instanceof Error ? error.message : String(error)}`,
    metadata,
    error,
  )
}
