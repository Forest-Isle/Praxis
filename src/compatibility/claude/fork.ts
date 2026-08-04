import { getClaudeContentBlocks } from './tool-links.js'
import {
  copyClaudeEntryWithSessionId,
  isClaudeForkableEntryType,
  type ClaudeTranscriptEntry,
} from './schema.js'

export interface ClaudeNativeForkOptions {
  source: readonly ClaudeTranscriptEntry[]
  sourceSessionId: string
  sessionId: string
}

const TRANSIENT_ENTRY_TYPES = new Set([
  'file-history-delta',
  'file-history-snapshot',
  'queue-operation',
])

function advancesLogicalTail(entry: ClaudeTranscriptEntry): boolean {
  if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    return false
  }
  if (entry.type !== 'attachment') return true
  const attachment = entry.attachment
  if (typeof attachment !== 'object' || attachment === null) return true
  const attachmentType = (attachment as Record<string, unknown>).type
  return (
    attachmentType !== 'hook_success' &&
    attachmentType !== 'hook_error' &&
    attachmentType !== 'hook_additional_context'
  )
}

function validateNativeHistory(
  entries: readonly ClaudeTranscriptEntry[],
): string | undefined {
  const entriesByUuid = new Map<string, ClaudeTranscriptEntry>()
  const toolCalls = new Map<string, string>()
  for (const entry of entries) {
    if (typeof entry.uuid !== 'string') continue
    if (entriesByUuid.has(entry.uuid)) {
      throw new Error(`Claude fork source has duplicate UUID ${entry.uuid}`)
    }
    entriesByUuid.set(entry.uuid, entry)
    if (entry.type !== 'assistant') continue
    for (const block of getClaudeContentBlocks(entry)) {
      if (block.type !== 'tool_use') continue
      const id = block.id
      if (typeof id !== 'string') continue
      if (toolCalls.has(id)) {
        throw new Error(`Claude fork source has duplicate tool_use ${id}`)
      }
      toolCalls.set(id, entry.uuid)
    }
  }

  const childParentUuids = new Set<string>()
  const externalParentUuids = new Set<string>()
  const completedToolCalls = new Set<string>()
  let ordinaryRootCount = 0
  let compactBoundary: ClaudeTranscriptEntry | undefined
  let logicalTailUuid: string | undefined

  for (const entry of entries) {
    const isCompactSummary = entry.isCompactSummary === true
    if (compactBoundary && !isCompactSummary) {
      throw new Error('Claude compact boundary has no adjacent summary')
    }
    if (isCompactSummary) {
      if (!compactBoundary || entry.parentUuid !== compactBoundary.uuid) {
        throw new Error('Claude compact summary has no matching boundary')
      }
      compactBoundary = undefined
    } else if (
      entry.type === 'system' &&
      entry.subtype === 'compact_boundary'
    ) {
      const metadata = entry.compactMetadata
      const preservedSegment =
        typeof metadata === 'object' && metadata !== null
          ? (metadata as Record<string, unknown>).preservedSegment
          : undefined
      if (
        typeof preservedSegment !== 'object' ||
        preservedSegment === null ||
        entry.logicalParentUuid !== logicalTailUuid ||
        (preservedSegment as Record<string, unknown>).headUuid !==
          logicalTailUuid ||
        (preservedSegment as Record<string, unknown>).tailUuid !==
          logicalTailUuid
      ) {
        throw new Error('Claude compact boundary has invalid logical parent')
      }
      compactBoundary = entry
    }

    if (typeof entry.uuid === 'string') {
      if (
        entry.parentUuid === null &&
        !(entry.type === 'system' && entry.subtype === 'compact_boundary')
      ) {
        ordinaryRootCount += 1
      } else if (typeof entry.parentUuid === 'string') {
        if (entriesByUuid.has(entry.parentUuid)) {
          childParentUuids.add(entry.parentUuid)
        } else {
          externalParentUuids.add(entry.parentUuid)
        }
      }
    }
    if (typeof entry.uuid === 'string' && advancesLogicalTail(entry)) {
      logicalTailUuid = entry.uuid
    }

    for (const block of getClaudeContentBlocks(entry)) {
      if (entry.type !== 'user' || block.type !== 'tool_result') continue
      const id = block.tool_use_id
      if (
        typeof id !== 'string' ||
        typeof entry.sourceToolAssistantUUID !== 'string' ||
        toolCalls.get(id) !== entry.sourceToolAssistantUUID
      ) {
        throw new Error('Claude fork source has an unmatched tool_result')
      }
      if (completedToolCalls.has(id)) {
        throw new Error(`Claude fork source has duplicate tool_result ${id}`)
      }
      completedToolCalls.add(id)
    }
  }

  if (compactBoundary) {
    throw new Error('Claude compact boundary has no adjacent summary')
  }
  if (externalParentUuids.size > 0 || ordinaryRootCount > 1) {
    throw new Error('Claude fork source has a dangling parentUuid')
  }

  const states = new Map<string, 'visiting' | 'visited'>()
  for (const startUuid of entriesByUuid.keys()) {
    if (states.get(startUuid) === 'visited') continue
    const path: string[] = []
    let uuid: string | undefined = startUuid
    while (uuid !== undefined && entriesByUuid.has(uuid)) {
      const state = states.get(uuid)
      if (state === 'visiting') {
        throw new Error('Claude fork source parentUuid graph has a cycle')
      }
      if (state === 'visited') break
      states.set(uuid, 'visiting')
      path.push(uuid)
      const parentUuid: unknown = entriesByUuid.get(uuid)?.parentUuid
      uuid = typeof parentUuid === 'string' ? parentUuid : undefined
    }
    for (const pathUuid of path) states.set(pathUuid, 'visited')
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const uuid = entries[index]?.uuid
    if (typeof uuid === 'string' && !childParentUuids.has(uuid)) return uuid
  }
  return undefined
}

export function createClaudeNativeFork({
  source,
  sourceSessionId,
  sessionId,
}: ClaudeNativeForkOptions): ClaudeTranscriptEntry[] {
  const titles: ClaudeTranscriptEntry[] = []
  const modes: ClaudeTranscriptEntry[] = []
  const permissionModes: ClaudeTranscriptEntry[] = []
  const history: ClaudeTranscriptEntry[] = []
  const nativeHistory: ClaudeTranscriptEntry[] = []
  let lastPrompt: ClaudeTranscriptEntry | undefined
  let nativeLastPrompt: ClaudeTranscriptEntry | undefined

  for (const entry of source) {
    if (TRANSIENT_ENTRY_TYPES.has(entry.type)) {
      if (
        (entry.type === 'queue-operation' &&
          entry.sessionId !== sourceSessionId) ||
        (entry.type !== 'queue-operation' &&
          entry.sessionId !== undefined &&
          entry.sessionId !== sourceSessionId)
      ) {
        throw new Error('Claude fork source entry has the wrong sessionId')
      }
      continue
    }
    if (entry.isSidechain === true) {
      if (!isClaudeForkableEntryType(entry.type)) {
        throw new Error(
          `Claude transcript entry type ${entry.type} is not forkable by Praxis`,
        )
      }
      if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) {
        throw new Error('Claude fork entry has no sessionId')
      }
      continue
    }
    if (!isClaudeForkableEntryType(entry.type)) {
      throw new Error(
        `Claude transcript entry type ${entry.type} is not forkable by Praxis`,
      )
    }
    if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) {
      throw new Error('Claude fork entry has no sessionId')
    }
    if (entry.sessionId !== sourceSessionId) {
      throw new Error('Claude fork source entry has the wrong sessionId')
    }
    const copied = copyClaudeEntryWithSessionId(entry, sessionId)
    if (entry.type === 'ai-title') titles.push(copied)
    else if (entry.type === 'mode') modes.push(copied)
    else if (entry.type === 'permission-mode') permissionModes.push(copied)
    else if (entry.type === 'last-prompt') {
      lastPrompt = copied
      nativeLastPrompt = entry
    } else {
      history.push(copied)
      nativeHistory.push(entry)
    }
  }

  if (history.length === 0) {
    throw new Error('Claude session has no native history to fork')
  }
  const logicalTailUuid = validateNativeHistory(nativeHistory)
  if (
    nativeLastPrompt &&
    (typeof nativeLastPrompt.leafUuid !== 'string' ||
      nativeLastPrompt.leafUuid !== logicalTailUuid)
  ) {
    nativeLastPrompt = undefined
    lastPrompt = undefined
  }
  return [
    ...titles.slice(-1),
    ...modes.slice(-1),
    ...permissionModes.slice(-1),
    ...history,
    ...(lastPrompt ? [lastPrompt] : []),
  ]
}
