import type { ClaudeTranscriptEntry } from './schema.js'
import { getClaudePreservedMessageUuids } from './compaction.js'
import { isClaudeDurableMetadataType } from './session-metadata.js'

function entryUuid(entry: ClaudeTranscriptEntry): string | null {
  return typeof entry.uuid === 'string' ? entry.uuid : null
}

const ADDITIONAL_NON_STRUCTURAL_ENTRY_TYPES = new Set([
  'queue-operation',
  'relocated',
])

function isNonStructuralEntryType(type: string): boolean {
  return (
    isClaudeDurableMetadataType(type) ||
    ADDITIONAL_NON_STRUCTURAL_ENTRY_TYPES.has(type)
  )
}

export function isClaudeDurableLastPromptSnapshot(
  entries: readonly ClaudeTranscriptEntry[],
  index: number,
): boolean {
  const entry = entries[index]
  if (entry?.type !== 'last-prompt') return false
  for (let prior = index - 1; prior >= 0; prior -= 1) {
    const candidate = entries[prior]
    if (
      candidate?.type !== 'last-prompt' ||
      candidate.sessionId !== entry.sessionId ||
      candidate.leafUuid !== entry.leafUuid ||
      candidate.lastPrompt !== entry.lastPrompt
    ) {
      continue
    }
    const structuralEntries = entries
      .slice(prior + 1, index)
      .filter(
        (between) =>
          between.isSidechain !== true &&
          typeof between.uuid === 'string' &&
          !isNonStructuralEntryType(between.type),
      )
    return structuralEntries.length > 0
  }
  return false
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
    // After compaction the active leaf continues from the boundary's logical
    // parent. Ignore unrelated physical entries that do not descend from the
    // boundary and keep the compact summary as the leaf when none do.
    const continuation = latestCompactBranchLeafUuid(
      entries,
      index + 1,
      boundary ? entryUuid(boundary) : null,
      summary.uuid,
    )
    return continuation === null ? summary.uuid : continuation
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.isSidechain === true) continue
    if (entry.type === 'last-prompt' && typeof entry.leafUuid === 'string') {
      if (isClaudeDurableLastPromptSnapshot(entries, index)) continue
      return entry.leafUuid
    }
    const uuid = entryUuid(entry)
    if (uuid) return uuid
  }
  return null
}

function latestCompactBranchLeafUuid(
  entries: readonly ClaudeTranscriptEntry[],
  fromIndex: number,
  boundaryUuid: string | null,
  summaryUuid: string,
): string | null {
  const byUuid = new Map<string, ClaudeTranscriptEntry>()
  for (const entry of entries) {
    const uuid = entryUuid(entry)
    if (uuid && entry.isSidechain !== true) byUuid.set(uuid, entry)
  }
  for (let index = entries.length - 1; index >= fromIndex; index -= 1) {
    const entry = entries[index]
    if (!entry || entry.isSidechain === true) continue
    const candidate =
      entry.type === 'last-prompt' && typeof entry.leafUuid === 'string'
        ? entry.leafUuid
        : entryUuid(entry)
    if (candidate === null) continue
    let uuid: string | null = candidate
    const seen = new Set<string>()
    while (uuid !== null) {
      if (uuid === summaryUuid || uuid === boundaryUuid) return candidate
      if (seen.has(uuid)) break
      seen.add(uuid)
      const node = byUuid.get(uuid)
      if (!node) break
      uuid =
        node.type === 'system' &&
        node.subtype === 'compact_boundary' &&
        typeof node.logicalParentUuid === 'string'
          ? node.logicalParentUuid
          : typeof node.parentUuid === 'string'
            ? node.parentUuid
            : null
    }
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
        (entry.type === 'attachment' &&
          typeof entry.parentUuid === 'string' &&
          active.has(entry.parentUuid)) ||
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

/** Validates and selects ancestry from the newest structural non-sidechain
 * entry. Explicit path resume uses this instead of potentially stale
 * last-prompt metadata. */
export function selectClaudeTranscriptFromNewestLeaf(
  entries: readonly ClaudeTranscriptEntry[],
): { entries: ClaudeTranscriptEntry[]; leafUuid: string } {
  let leafUuid: string | undefined
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      entry?.isSidechain !== true &&
      !isNonStructuralEntryType(entry?.type ?? '') &&
      typeof entry?.uuid === 'string'
    ) {
      leafUuid = entry.uuid
      break
    }
  }
  if (leafUuid === undefined) {
    throw new Error('Claude transcript has no resumable non-sidechain leaf')
  }
  return {
    entries: expandPreservedMessages(
      entries,
      selectAncestry(entries, leafUuid),
    ),
    leafUuid,
  }
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
