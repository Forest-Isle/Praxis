import { describe, expect, it } from 'vitest'

import type { ClaudeTranscriptEntry } from './schema.js'
import {
  selectClaudeActiveTranscript,
  selectClaudeTranscriptAtMessage,
} from './history.js'

function message(
  type: 'user' | 'assistant',
  uuid: string,
  parentUuid: string | null,
): ClaudeTranscriptEntry {
  return {
    type,
    uuid,
    parentUuid,
    sessionId: '11111111-1111-4111-8111-111111111111',
    message: { role: type, content: uuid },
  }
}

describe('Claude active transcript selection', () => {
  const root = message('user', 'root', null)
  const firstAnswer = message('assistant', 'first-answer', 'root')
  const abandonedPrompt = message('user', 'abandoned-prompt', 'first-answer')
  const abandonedAnswer = message(
    'assistant',
    'abandoned-answer',
    'abandoned-prompt',
  )
  const branchPrompt = message('user', 'branch-prompt', 'root')
  const branchAnswer = message('assistant', 'branch-answer', 'branch-prompt')

  it('projects only ancestry of latest native leaf while retaining metadata', () => {
    const entries: ClaudeTranscriptEntry[] = [
      {
        type: 'custom-title',
        customTitle: 'Branch',
        sessionId: root.sessionId,
      },
      root,
      firstAnswer,
      abandonedPrompt,
      abandonedAnswer,
      branchPrompt,
      branchAnswer,
      {
        type: 'last-prompt',
        lastPrompt: 'branch-prompt',
        leafUuid: 'branch-answer',
        sessionId: root.sessionId,
      },
    ]

    expect(selectClaudeActiveTranscript(entries)).toEqual([
      entries[0],
      root,
      branchPrompt,
      branchAnswer,
      entries[7],
    ])
  })

  it('selects active ancestry through a user target and drops stale last-prompt', () => {
    const entries = [root, firstAnswer, abandonedPrompt, abandonedAnswer]
    expect(
      selectClaudeTranscriptAtMessage(entries, 'abandoned-prompt'),
    ).toEqual([root, firstAnswer, abandonedPrompt])
  })

  it('accepts active assistants and rejects missing or abandoned targets', () => {
    const entries = [
      root,
      firstAnswer,
      abandonedPrompt,
      abandonedAnswer,
      branchPrompt,
      branchAnswer,
    ]
    expect(selectClaudeTranscriptAtMessage(entries, 'branch-answer')).toEqual([
      root,
      branchPrompt,
      branchAnswer,
    ])
    expect(() => selectClaudeTranscriptAtMessage(entries, 'missing')).toThrow(
      'No message found with message.uuid of: missing',
    )
    expect(() =>
      selectClaudeTranscriptAtMessage(entries, 'abandoned-prompt'),
    ).toThrow('No message found with message.uuid of: abandoned-prompt')
  })

  it('follows a compact boundary logical parent instead of an unrelated physical tail', () => {
    const compactBoundary: ClaudeTranscriptEntry = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'compact-boundary',
      parentUuid: null,
      logicalParentUuid: 'first-answer',
      sessionId: root.sessionId,
      isSidechain: false,
      content: 'Conversation compacted',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 2000,
        postTokens: 1000,
        durationMs: 10,
        cumulativeDroppedTokens: 1000,
        preservedSegment: {
          headUuid: 'root',
          anchorUuid: 'first-answer',
          tailUuid: 'first-answer',
        },
        preservedMessages: {
          anchorUuid: 'first-answer',
          uuids: ['root', 'first-answer'],
          allUuids: ['root', 'first-answer'],
        },
      },
    }
    const compactSummary: ClaudeTranscriptEntry = {
      type: 'user',
      uuid: 'compact-summary',
      parentUuid: 'compact-boundary',
      sessionId: root.sessionId,
      isSidechain: false,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      promptId: 'compact-summary',
      message: {
        role: 'user',
        content: 'Continued from a compacted conversation.',
      },
    }
    const unrelatedTail = message('user', 'unrelated-tail', 'root')

    expect(
      selectClaudeActiveTranscript([
        root,
        firstAnswer,
        compactBoundary,
        compactSummary,
        unrelatedTail,
      ]),
    ).toEqual([root, firstAnswer, compactBoundary, compactSummary])
  })
})
