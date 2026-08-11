import type { ClaudeTranscriptEntry } from './schema.js'
import { getClaudePreservedMessageUuids } from './compaction.js'

function entryUuid(entry: ClaudeTranscriptEntry): string | null {
  return typeof entry.uuid === 'string' ? entry.uuid : null
}

function latestLeafUuid(
  entries: readonly ClaudeTranscriptEntry[],
): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const summary = entries[index]
    if (
      summary?.isCompactSummary !== true ||
      typeof summary.uuid !== 'string'
    ) {
      continue
    }
    const boundary = entries.find((entry) => entry.uuid === summary.parentUuid)
    const uuids = new Set(getClaudePreservedMessageUuids(boundary))
    const hasNewDescendant = entries
      .slice(index + 1)
      .some(
        (entry) =>
          typeof entry.uuid === 'string' &&
          !uuids.has(entry.uuid) &&
          entry.isSidechain !== true,
      )
    if (!hasNewDescendant) return summary.uuid
    break
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.isSidechain === true) continue
    if (entry.type === 'last-prompt' && typeof entry.leafUuid === 'string') {
      return entry.leafUuid
    }
    const uuid = entryUuid(entry)
    if (uuid) return uuid
  }
  return null
}

function ancestryUuids(
  entries: readonly ClaudeTranscriptEntry[],
  leafUuid: string,
): Set<string> {
  const byUuid = new Map<string, ClaudeTranscriptEntry>()
  for (const entry of entries) {
    const uuid = entryUuid(entry)
    if (uuid && entry.isSidechain !== true) byUuid.set(uuid, entry)
  }

  const active = new Set<string>()
  let uuid: string | null = leafUuid
  while (uuid !== null) {
    if (active.has(uuid)) {
      throw new Error('Claude transcript parentUuid graph has a cycle')
    }
    const entry = byUuid.get(uuid)
    if (!entry) {
      if (active.size > 0) break
      throw new Error(`Claude transcript has dangling parentUuid ${uuid}`)
    }
    active.add(uuid)
    uuid =
      entry.type === 'system' &&
      entry.subtype === 'compact_boundary' &&
      typeof entry.logicalParentUuid === 'string'
        ? entry.logicalParentUuid
        : typeof entry.parentUuid === 'string'
          ? entry.parentUuid
          : null
  }
  return active
}

function selectAncestry(
  entries: readonly ClaudeTranscriptEntry[],
  leafUuid: string,
): ClaudeTranscriptEntry[] {
  const active = ancestryUuids(entries, leafUuid)
  return entries.filter((entry) => {
    if (entry.isSidechain === true) return false
    const uuid = entryUuid(entry)
    if (uuid) {
      return (
        active.has(uuid) ||
        (entry.type === 'user' &&
          typeof entry.sourceToolAssistantUUID === 'string' &&
          active.has(entry.sourceToolAssistantUUID))
      )
    }
    return entry.type !== 'last-prompt' || entry.leafUuid === leafUuid
  })
}

function expandPreservedMessages(
  entries: readonly ClaudeTranscriptEntry[],
  active: readonly ClaudeTranscriptEntry[],
): ClaudeTranscriptEntry[] {
  const byUuid = new Map(
    entries.flatMap((entry) =>
      typeof entry.uuid === 'string' ? [[entry.uuid, entry] as const] : [],
    ),
  )
  const included = new Set(
    active.flatMap((entry) =>
      typeof entry.uuid === 'string' ? [entry.uuid] : [],
    ),
  )
  const expanded: ClaudeTranscriptEntry[] = []
  for (const entry of active) {
    expanded.push(entry)
    if (entry.isCompactSummary !== true) continue
    const boundary = byUuid.get(
      typeof entry.parentUuid === 'string' ? entry.parentUuid : '',
    )
    const uuids = getClaudePreservedMessageUuids(boundary)
    for (const uuid of uuids) {
      if (typeof uuid !== 'string' || included.has(uuid)) continue
      const preserved = byUuid.get(uuid)
      if (!preserved || preserved.isSidechain === true) continue
      expanded.push(preserved)
      included.add(uuid)
    }
  }
  return expanded
}

export function selectClaudeActiveTranscript(
  entries: readonly ClaudeTranscriptEntry[],
): ClaudeTranscriptEntry[] {
  const leafUuid = latestLeafUuid(entries)
  if (
    leafUuid === null ||
    !entries.some(
      (entry) => entry.uuid === leafUuid && entry.isSidechain !== true,
    )
  ) {
    return [...entries]
  }
  return expandPreservedMessages(entries, selectAncestry(entries, leafUuid))
}

export function selectClaudeTranscriptAtMessage(
  entries: readonly ClaudeTranscriptEntry[],
  messageUuid: string,
): ClaudeTranscriptEntry[] {
  const active = selectClaudeActiveTranscript(entries)
  const target = active.find(
    (entry) =>
      entry.uuid === messageUuid &&
      (entry.type === 'user' || entry.type === 'assistant') &&
      typeof entry.message === 'object' &&
      entry.message !== null &&
      !Array.isArray(entry.message) &&
      ((entry.message as Record<string, unknown>).role === 'user' ||
        (entry.message as Record<string, unknown>).role === 'assistant'),
  )
  if (!target) {
    throw new Error(`No message found with message.uuid of: ${messageUuid}`)
  }
  return selectAncestry(entries, messageUuid)
}
