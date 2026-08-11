import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { createClaudeCompactEntries } from './compaction.js'

describe('Claude compaction translation', () => {
  it('matches observed selective-summary anchor relationships', async () => {
    const source = await readFile(
      new URL(
        '../../../test/fixtures/claude-code/2.1.208/selective-compact-session.jsonl',
        import.meta.url,
      ),
      'utf8',
    )
    const observed = source
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    for (const direction of ['up_to', 'from'] as const) {
      const summary = observed.find(
        (entry) =>
          (entry.summarizeMetadata as Record<string, unknown> | undefined)
            ?.direction === direction,
      )
      const boundary = observed.find(
        (entry) => entry.uuid === summary?.parentUuid,
      )
      const segment = (
        boundary?.compactMetadata as Record<string, unknown> | undefined
      )?.preservedSegment as Record<string, unknown> | undefined
      expect(segment?.anchorUuid).toBe(
        direction === 'from' ? boundary?.uuid : summary?.uuid,
      )
    }
  })

  it('creates the native append-only boundary and summary pair', () => {
    const uuids = ['boundary', 'summary']
    const entries = createClaudeCompactEntries({
      sessionId: 'session',
      logicalParentUuid: 'logical-tail',
      summary: 'Keep COMPACT_MARKER and continue the pending task.',
      preTokens: 12_000,
      postTokens: 1_500,
      previousCumulativeDroppedTokens: 2_000,
      durationMs: 42,
      cwd: '/workspace',
      claudeVersion: '2.1.208',
      gitBranch: null,
      createUuid: () => uuids.shift() ?? 'unexpected',
      now: () => '2026-08-04T00:00:00.000Z',
    })

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      type: 'system',
      subtype: 'compact_boundary',
      parentUuid: null,
      logicalParentUuid: 'logical-tail',
      uuid: 'boundary',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 12_000,
        postTokens: 1_500,
        durationMs: 42,
        cumulativeDroppedTokens: 12_500,
        preservedSegment: {
          headUuid: 'logical-tail',
          anchorUuid: 'summary',
          tailUuid: 'logical-tail',
        },
        preservedMessages: {
          anchorUuid: 'summary',
          uuids: ['logical-tail'],
          allUuids: ['logical-tail'],
        },
      },
    })
    expect(entries[1]).toMatchObject({
      type: 'user',
      parentUuid: 'boundary',
      uuid: 'summary',
      promptId: expect.any(String),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: {
        role: 'user',
        content: expect.stringContaining('COMPACT_MARKER'),
      },
    })
  })

  it('records native preserved messages for an up-to summary', () => {
    const uuids = ['boundary', 'summary']
    const entries = createClaudeCompactEntries({
      sessionId: 'session',
      logicalParentUuid: 'before-selection',
      summary: 'Earlier work.',
      preTokens: 100,
      postTokens: 40,
      previousCumulativeDroppedTokens: 0,
      durationMs: 42,
      cwd: '/workspace',
      claudeVersion: '2.1.208',
      gitBranch: null,
      trigger: 'manual',
      summarizeMetadata: { messagesSummarized: 3, direction: 'up_to' },
      preservedUuids: ['selected-user', 'later-assistant'],
      createUuid: () => uuids.shift() ?? 'unexpected',
    })

    expect(entries[0]).toMatchObject({
      logicalParentUuid: 'before-selection',
      compactMetadata: {
        trigger: 'manual',
        messagesSummarized: 3,
        preservedSegment: {
          headUuid: 'selected-user',
          anchorUuid: 'summary',
          tailUuid: 'later-assistant',
        },
        preservedMessages: {
          anchorUuid: 'summary',
          uuids: ['selected-user', 'later-assistant'],
          allUuids: ['selected-user', 'later-assistant'],
        },
      },
    })
    expect(entries[1]).toMatchObject({
      isCompactSummary: true,
      summarizeMetadata: { messagesSummarized: 3, direction: 'up_to' },
    })
    expect(entries[1]).not.toHaveProperty('isVisibleInTranscriptOnly')
  })

  it('anchors a from-summary at its native boundary while preserving the prefix', () => {
    const uuids = ['boundary', 'summary']
    const entries = createClaudeCompactEntries({
      sessionId: 'session',
      logicalParentUuid: 'prefix-tail',
      summary: 'Later work.',
      preTokens: 100,
      postTokens: 40,
      previousCumulativeDroppedTokens: 0,
      durationMs: 42,
      cwd: '/workspace',
      claudeVersion: '2.1.208',
      gitBranch: null,
      trigger: 'manual',
      summarizeMetadata: { messagesSummarized: 3, direction: 'from' },
      preservedUuids: ['prefix-head', 'prefix-tail'],
      createUuid: () => uuids.shift() ?? 'unexpected',
    })

    expect(entries[0]).toMatchObject({
      compactMetadata: {
        preservedSegment: {
          headUuid: 'prefix-head',
          anchorUuid: 'boundary',
          tailUuid: 'prefix-tail',
        },
        preservedMessages: {
          anchorUuid: 'boundary',
          uuids: ['prefix-head', 'prefix-tail'],
        },
      },
    })
  })
})
