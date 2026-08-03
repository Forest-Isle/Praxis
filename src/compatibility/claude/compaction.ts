import { randomUUID } from 'node:crypto'

import type { ClaudeTranscriptEntry } from './schema.js'

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
  createUuid?: () => string
  now?: () => string
}

function compactSummaryContent(summary: string): string {
  return `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n${summary}\n\nContinue the conversation from where it left off without asking the user any further questions. Resume directly.`
}

export function createClaudeCompactEntries(
  options: ClaudeCompactEntriesOptions,
): [ClaudeTranscriptEntry, ClaudeTranscriptEntry] {
  const createUuid = options.createUuid ?? randomUUID
  const now = options.now ?? (() => new Date().toISOString())
  const boundaryUuid = createUuid()
  const summaryUuid = createUuid()
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
        trigger: 'auto',
        preTokens: options.preTokens,
        durationMs: options.durationMs,
        preservedSegment: {
          headUuid: options.logicalParentUuid,
          anchorUuid: summaryUuid,
          tailUuid: options.logicalParentUuid,
        },
        preservedMessages: {
          anchorUuid: summaryUuid,
          uuids: [options.logicalParentUuid],
          allUuids: [options.logicalParentUuid],
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
      isVisibleInTranscriptOnly: true,
      message: {
        role: 'user',
        content: compactSummaryContent(options.summary),
      },
    },
  ]
}

export function getCumulativeDroppedTokens(
  entries: readonly ClaudeTranscriptEntry[],
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
