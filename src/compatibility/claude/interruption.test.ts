import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import type { ClaudeTranscriptEntry } from './schema.js'
import {
  CLAUDE_INTERRUPTED_TURN_CONTINUATION,
  classifyClaudeInterruption,
} from './interruption.js'

const sessionId = '11111111-1111-4111-8111-111111111111'

function user(content: unknown, uuid = 'user'): ClaudeTranscriptEntry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId,
    message: { role: 'user', content },
  }
}

function assistant(content: unknown): ClaudeTranscriptEntry {
  return {
    type: 'assistant',
    uuid: 'assistant',
    parentUuid: 'user',
    sessionId,
    message: { role: 'assistant', content },
  }
}

describe('Claude interruption classification', () => {
  it('classifies a valid assistant tail as complete', () => {
    expect(
      classifyClaudeInterruption([user('work'), assistant('done')]),
    ).toEqual({ kind: 'complete' })
  })

  it('finds a plain interrupted prompt behind thinking, whitespace, and tool use', () => {
    expect(
      classifyClaudeInterruption([
        user('retry me'),
        assistant([
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: '   ' },
          { type: 'tool_use', id: 'pending', name: 'Bash', input: {} },
        ]),
        { type: 'custom-title', customTitle: 'session', sessionId },
      ]),
    ).toMatchObject({
      kind: 'interrupted-prompt',
      prompt: 'retry me',
      replayEntries: [],
      replayParentUuid: null,
    })
  })

  it('classifies non-terminal tool results and context attachments as interrupted turns', () => {
    const prompt = user('continue tool')
    const tool = assistant([
      { type: 'tool_use', id: 'call', name: 'Read', input: {} },
    ])
    const result = {
      type: 'user',
      uuid: 'result',
      parentUuid: 'assistant',
      sessionId,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call', content: 'read' },
        ],
      },
    }
    expect(classifyClaudeInterruption([prompt, tool, result])).toMatchObject({
      kind: 'interrupted-turn',
      prompt: CLAUDE_INTERRUPTED_TURN_CONTINUATION,
      replayEntries: [prompt, tool, result],
      replayParentUuid: 'result',
    })
    expect(
      classifyClaudeInterruption([
        prompt,
        { type: 'attachment', uuid: 'context', parentUuid: 'user', sessionId },
      ]),
    ).toMatchObject({
      kind: 'interrupted-turn',
      prompt: CLAUDE_INTERRUPTED_TURN_CONTINUATION,
      replayEntries: [prompt, expect.objectContaining({ uuid: 'context' })],
      replayParentUuid: 'context',
    })
  })

  it('does not invent continuations for compact, terminal, or synthetic tails', () => {
    const terminal = {
      ...user([
        {
          type: 'tool_result',
          tool_use_id: 'call',
          is_error: true,
          content: "The user doesn't want to proceed with this tool use.",
        },
      ]),
      toolDenialKind: 'user-rejected',
    }
    expect(classifyClaudeInterruption([user('work'), terminal])).toEqual({
      kind: 'none',
    })
    expect(
      classifyClaudeInterruption([
        { ...user('summary'), isCompactSummary: true },
      ]),
    ).toEqual({ kind: 'none' })
    expect(
      classifyClaudeInterruption([
        user('work'),
        { ...assistant('billing error'), isApiErrorMessage: true },
      ]),
    ).toEqual({ kind: 'none' })
  })

  it.each(['cd-records.jsonl', 'background-empty-records.jsonl'])(
    'does not replay meta or local-command users from %s',
    async (fixture) => {
      const source = await readFile(
        new URL(
          `../../../test/fixtures/claude-code/2.1.208/${fixture}`,
          import.meta.url,
        ),
        'utf8',
      )
      const entries = source
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as ClaudeTranscriptEntry)

      expect(classifyClaudeInterruption(entries)).toEqual({ kind: 'none' })
    },
  )
})
