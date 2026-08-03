import { randomUUID } from 'node:crypto'

import { getClaudeLastPrompt, projectClaudeTextMessages } from './projection.js'
import type { ClaudeTranscriptEntry } from './schema.js'
import {
  createClaudeLastPromptEntry,
  translateProviderEvents,
  type ProviderPersistenceEvent,
} from './translation.js'

export interface ClaudeTextForkOptions {
  source: readonly ClaudeTranscriptEntry[]
  sessionId: string
  cwd: string
  claudeVersion: string
}

export function createClaudeTextFork({
  source,
  sessionId,
  cwd,
  claudeVersion,
}: ClaudeTextForkOptions): ClaudeTranscriptEntry[] {
  const entries: ClaudeTranscriptEntry[] = []
  let parentUuid: string | null = null
  let lastUserPrompt = ''

  for (const message of projectClaudeTextMessages(source)) {
    let event: ProviderPersistenceEvent
    if (message.role === 'user') {
      lastUserPrompt = message.content
      event = { type: 'user-text', text: message.content }
    } else {
      event = {
        type: 'assistant-text',
        text: message.content,
        providerMessageId: `msg_${randomUUID().replaceAll('-', '')}`,
        model: 'praxis/fork',
      }
    }
    const [entry] = translateProviderEvents([event], {
      sessionId,
      parentUuid,
      cwd,
      claudeVersion,
      gitBranch: null,
    })
    if (!entry || typeof entry.uuid !== 'string') {
      throw new Error('Could not create Claude text fork entry')
    }
    entries.push(entry)
    parentUuid = entry.uuid
  }

  const leaf = entries.at(-1)
  if (leaf?.type === 'assistant' && typeof leaf.uuid === 'string') {
    entries.push(
      createClaudeLastPromptEntry({
        sessionId,
        lastPrompt: getClaudeLastPrompt(source) ?? lastUserPrompt,
        leafUuid: leaf.uuid,
      }),
    )
  }
  if (entries.length === 0)
    throw new Error('Claude session has no text to fork')
  return entries
}
