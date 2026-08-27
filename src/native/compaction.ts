import { randomUUID } from 'node:crypto'

import type { NativeTranscriptEntry } from './schema.js'

export interface ClaudeCompactEntriesOptions {
  sessionId: string
  logicalParentUuid: string
  summary: string
  preTokens: number
  postTokens: number
  previousCumulativeDroppedTokens: number
  durationMs: number
  cwd: string
  claudeVersion: string
  gitBranch: string | null
  trigger?: 'auto' | 'manual'
  summarizeMetadata?: {
    messagesSummarized: number
    direction: 'from' | 'up_to'
  }
  preservedUuids?: readonly string[]
  createUuid?: () => string
  now?: () => string
}

export function formatClaudeCompactSummary(summary: string): string {
  return `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${summary}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly.`
}

export function parseClaudeCompactSummary(content: string): string | null {
  const prefix =
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n'
  const suffix =
    '\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly.'
  if (!content.startsWith(prefix) || !content.endsWith(suffix)) return null
  return content.slice(prefix.length, -suffix.length)
}

export function getClaudePreservedMessageUuids(
  boundary: NativeTranscriptEntry | undefined,
): readonly string[] {
  const metadata = boundary?.compactMetadata
  const preservedMessages =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>).preservedMessages
      : undefined
  if (
    typeof preservedMessages !== 'object' ||
    preservedMessages === null ||
    !Array.isArray((preservedMessages as Record<string, unknown>).uuids)
  ) {
    return []
  }
  const uuids = (preservedMessages as Record<string, unknown>)
    .uuids as unknown[]
  return uuids.every((uuid): uuid is string => typeof uuid === 'string')
    ? uuids
    : []
}

export function createClaudeCompactEntries(
  options: ClaudeCompactEntriesOptions,
): [NativeTranscriptEntry, NativeTranscriptEntry] {
  const createUuid = options.createUuid ?? randomUUID
  const now = options.now ?? (() => new Date().toISOString())
  const boundaryUuid = createUuid()
  const summaryUuid = createUuid()
  const anchorUuid =
    options.summarizeMetadata?.direction === 'from' ? boundaryUuid : summaryUuid
  const timestamp = now()
  const common = {
    isSidechain: false,
    timestamp,
    userType: 'external',
    entrypoint: 'cli',
    cwd: options.cwd,
    sessionId: options.sessionId,
    version: options.claudeVersion,
    gitBranch: options.gitBranch,
  }
  const cumulativeDroppedTokens =
    options.previousCumulativeDroppedTokens +
    Math.max(0, options.preTokens - options.postTokens)
  const preservedUuids =
    options.preservedUuids === undefined
      ? [options.logicalParentUuid]
      : options.preservedUuids.length > 0
        ? [...options.preservedUuids]
        : options.summarizeMetadata?.direction === 'from'
          ? [boundaryUuid]
          : [options.logicalParentUuid]

  return [
    {
      ...common,
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isMeta: false,
      level: 'info',
      logicalParentUuid: options.logicalParentUuid,
      compactMetadata: {
        trigger: options.trigger ?? 'auto',
        preTokens: options.preTokens,
        ...(options.summarizeMetadata
          ? { messagesSummarized: options.summarizeMetadata.messagesSummarized }
          : {}),
        durationMs: options.durationMs,
        preservedSegment: {
          headUuid: preservedUuids[0],
          anchorUuid,
          tailUuid: preservedUuids[preservedUuids.length - 1],
        },
        preservedMessages: {
          anchorUuid,
          uuids: preservedUuids,
          allUuids: preservedUuids,
        },
        postTokens: options.postTokens,
        cumulativeDroppedTokens,
      },
      parentUuid: null,
      uuid: boundaryUuid,
    },
    {
      ...common,
      type: 'user',
      parentUuid: boundaryUuid,
      uuid: summaryUuid,
      promptId: summaryUuid,
      isCompactSummary: true,
      ...(options.summarizeMetadata ? {} : { isVisibleInTranscriptOnly: true }),
      ...(options.summarizeMetadata
        ? { summarizeMetadata: options.summarizeMetadata }
        : {}),
      message: {
        role: 'user',
        content: formatClaudeCompactSummary(options.summary),
      },
    },
  ]
}

export function getCumulativeDroppedTokens(
  entries: readonly NativeTranscriptEntry[],
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const metadata = entries[index]?.compactMetadata
    if (
      typeof metadata === 'object' &&
      metadata !== null &&
      !Array.isArray(metadata)
    ) {
      const value = (metadata as Record<string, unknown>)
        .cumulativeDroppedTokens
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return value
      }
    }
  }
  return 0
}
