import { describe, expect, it } from 'vitest'

import { createClaudeCompactEntries } from './compaction.js'

describe('Claude compaction translation', () => {
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
})
