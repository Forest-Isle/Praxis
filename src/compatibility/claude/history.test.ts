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
})
