import type {
  ModelContentBlock,
  ModelDocument,
  ModelImage,
  ModelMessage,
  ModelTerminalReason,
  ModelThinkingBlock,
  ModelToolCall,
} from './runtime.js'

export interface TranscriptEventIdentity {
  readonly id: string
  readonly parentId: string | null
  readonly sessionId: string
  readonly timestamp: string
}

export interface TranscriptMessagesEvent extends TranscriptEventIdentity {
  readonly kind: 'messages'
  readonly messages: readonly ModelMessage[]
  readonly model?: string
  readonly terminalReason?: ModelTerminalReason
}

export interface TranscriptContextBoundaryEvent extends TranscriptEventIdentity {
  readonly kind: 'context-boundary'
  readonly logicalParentId: string
  readonly trigger: 'auto' | 'manual'
  readonly preTokens: number
  readonly postTokens: number
  readonly durationMs: number
}

export interface TranscriptContextSummaryEvent extends TranscriptEventIdentity {
  readonly kind: 'context-summary'
  readonly summary: string
}

export interface TranscriptToolExecutionStartedEvent extends TranscriptEventIdentity {
  readonly kind: 'tool-execution-started'
  readonly callId: string
}

export type TranscriptEvent =
  | TranscriptMessagesEvent
  | TranscriptContextBoundaryEvent
  | TranscriptContextSummaryEvent
  | TranscriptToolExecutionStartedEvent

const terminalReasons = new Set<ModelTerminalReason>([
  'end_turn',
  'tool_use',
  'max_tokens',
  'prompt_too_long',
])
const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
const documentTypes = new Set([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}
export function isModelImage(value: unknown): value is ModelImage {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'mediaType', 'data']) &&
    value.type === 'image' &&
    imageTypes.has(String(value.mediaType)) &&
    isNonEmptyString(value.data)
  )
}
export function isModelDocument(value: unknown): value is ModelDocument {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'mediaType', 'data']) &&
    value.type === 'document' &&
    documentTypes.has(String(value.mediaType)) &&
    isNonEmptyString(value.data)
  )
}
function isModelMedia(value: unknown): value is ModelImage | ModelDocument {
  return isModelImage(value) || isModelDocument(value)
}
export function isModelContentBlock(
  value: unknown,
): value is ModelContentBlock {
  if (!isRecord(value)) return false
  if (value.type === 'text') {
    return (
      hasOnlyKeys(value, ['type', 'text']) && typeof value.text === 'string'
    )
  }
  return isModelMedia(value)
}
function isModelToolCall(value: unknown): value is ModelToolCall {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'name', 'input']) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isRecord(value.input)
  )
}
function isModelThinkingBlock(value: unknown): value is ModelThinkingBlock {
  return isRecord(value) && value.type === 'thinking'
    ? hasOnlyKeys(value, ['type', 'thinking', 'signature']) &&
        typeof value.thinking === 'string' &&
        isNonEmptyString(value.signature)
    : isRecord(value) && value.type === 'redacted_thinking'
      ? hasOnlyKeys(value, ['type', 'data']) && isNonEmptyString(value.data)
      : false
}
function isModelMessage(value: unknown): value is ModelMessage {
  if (!isRecord(value) || !isNonEmptyString(value.role)) return false
  if (value.role === 'system') {
    return (
      hasOnlyKeys(value, ['role', 'content']) &&
      typeof value.content === 'string'
    )
  }
  if (value.role === 'user') {
    return (
      hasOnlyKeys(value, [
        'role',
        'content',
        'contentBlocks',
        'images',
        'documents',
      ]) &&
      typeof value.content === 'string' &&
      (!('contentBlocks' in value) ||
        (Array.isArray(value.contentBlocks) &&
          value.contentBlocks.every(isModelContentBlock))) &&
      (!('images' in value) ||
        (Array.isArray(value.images) && value.images.every(isModelImage))) &&
      (!('documents' in value) ||
        (Array.isArray(value.documents) &&
          value.documents.every(isModelDocument)))
    )
  }
  if (value.role === 'assistant') {
    return (
      hasOnlyKeys(value, ['role', 'content', 'thinkingBlocks', 'toolCalls']) &&
      typeof value.content === 'string' &&
      (!('thinkingBlocks' in value) ||
        (Array.isArray(value.thinkingBlocks) &&
          value.thinkingBlocks.every(isModelThinkingBlock))) &&
      (!('toolCalls' in value) ||
        (Array.isArray(value.toolCalls) &&
          value.toolCalls.every(isModelToolCall)))
    )
  }
  return (
    value.role === 'tool' &&
    hasOnlyKeys(value, [
      'role',
      'toolCallId',
      'content',
      'contentBlocks',
      'images',
      'documents',
      'isError',
    ]) &&
    isNonEmptyString(value.toolCallId) &&
    typeof value.content === 'string' &&
    typeof value.isError === 'boolean' &&
    (!('contentBlocks' in value) ||
      (Array.isArray(value.contentBlocks) &&
        value.contentBlocks.every(isModelContentBlock))) &&
    (!('images' in value) ||
      (Array.isArray(value.images) && value.images.every(isModelImage))) &&
    (!('documents' in value) ||
      (Array.isArray(value.documents) &&
        value.documents.every(isModelDocument)))
  )
}
function hasValidIdentity(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.id) &&
    (value.parentId === null || isNonEmptyString(value.parentId)) &&
    isNonEmptyString(value.sessionId) &&
    typeof value.timestamp === 'string' &&
    !Number.isNaN(Date.parse(value.timestamp)) &&
    new Date(value.timestamp).toISOString() === value.timestamp
  )
}
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function isTranscriptEvent(value: unknown): value is TranscriptEvent {
  if (
    !isRecord(value) ||
    !hasValidIdentity(value) ||
    typeof value.kind !== 'string'
  )
    return false
  if (value.kind === 'tool-execution-started') {
    return (
      hasOnlyKeys(value, [
        'kind',
        'id',
        'parentId',
        'sessionId',
        'timestamp',
        'callId',
      ]) &&
      isNonEmptyString(value.callId) &&
      value.callId.trim().length > 0
    )
  }
  if (value.kind === 'messages') {
    return (
      hasOnlyKeys(value, [
        'kind',
        'id',
        'parentId',
        'sessionId',
        'timestamp',
        'messages',
        'model',
        'terminalReason',
      ]) &&
      Array.isArray(value.messages) &&
      value.messages.length > 0 &&
      value.messages.every(isModelMessage) &&
      (!('model' in value) || isNonEmptyString(value.model)) &&
      (!('terminalReason' in value) ||
        terminalReasons.has(value.terminalReason as ModelTerminalReason))
    )
  }
  if (value.kind === 'context-boundary') {
    return (
      hasOnlyKeys(value, [
        'kind',
        'id',
        'parentId',
        'sessionId',
        'timestamp',
        'logicalParentId',
        'trigger',
        'preTokens',
        'postTokens',
        'durationMs',
      ]) &&
      isNonEmptyString(value.logicalParentId) &&
      (value.trigger === 'auto' || value.trigger === 'manual') &&
      isNonNegativeNumber(value.preTokens) &&
      isNonNegativeNumber(value.postTokens) &&
      isNonNegativeNumber(value.durationMs)
    )
  }
  return (
    value.kind === 'context-summary' &&
    hasOnlyKeys(value, [
      'kind',
      'id',
      'parentId',
      'sessionId',
      'timestamp',
      'summary',
    ]) &&
    typeof value.summary === 'string'
  )
}

export function parseTranscriptEvent(value: unknown): TranscriptEvent {
  if (!isTranscriptEvent(value)) throw new Error('Invalid TranscriptEvent')
  return value
}

export function validateTranscriptEvent(
  value: unknown,
): value is TranscriptEvent {
  return isTranscriptEvent(value)
}
