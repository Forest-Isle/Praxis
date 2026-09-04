import type { ModelToolCall } from '../../core/runtime.js'
import { isBackgroundBashTaskId } from '../../application/background-task-id.js'

export type TaskNotificationMetadata = {
  readonly taskId: string
  readonly status: 'completed' | 'failed' | 'stopped'
}

export type TranscriptItem =
  | {
      kind: 'user' | 'assistant'
      text: string
    }
  | {
      kind: 'notice' | 'warning'
      text: string
      taskNotification?: TaskNotificationMetadata
    }
  | { kind: 'local-result'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'compact'; summary: string }
  | {
      kind: 'context'
      usedTokens: number
      contextWindowTokens?: number
      model?: string
      skills: readonly { name: string; tokens: number }[]
      memoryFiles: readonly { path: string; tokens: number }[]
    }
  | { kind: 'tool'; call: ModelToolCall; detail: string }
  | {
      kind: 'tool-result'
      callId: string
      text: string
      isError: boolean
    }
  | { kind: 'shell'; callId: string; command: string }
  | {
      kind: 'shell-result'
      callId: string
      stdout: string
      stderr: string
      isError: boolean
    }

export type TranscriptPresentationMode = 'normal' | 'audit' | 'screen-reader'

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type ToolResultItem = Extract<TranscriptItem, { kind: 'tool-result' }>
type ShellItem = Extract<TranscriptItem, { kind: 'shell' }>
type ShellResultItem = Extract<TranscriptItem, { kind: 'shell-result' }>

type TranscriptPresentationEntryValue =
  | {
      kind: 'item'
      key: string
      item: Exclude<
        TranscriptItem,
        ToolItem | ToolResultItem | ShellItem | ShellResultItem
      >
    }
  | { kind: 'tool'; key: string; item: ToolItem; result?: ToolResultItem }
  | { kind: 'orphan-tool-result'; key: string; item: ToolResultItem }
  | { kind: 'shell'; key: string; item: ShellItem; result?: ShellResultItem }
  | { kind: 'orphan-shell-result'; key: string; item: ShellResultItem }
  | { kind: 'read-summary'; key: string; count: number }

/**
 * Fullscreen-only projection of one oversized renderer row. This metadata is
 * derived from Transcript content and never enters the authoritative source
 * item or persisted JSONL.
 */
export type TranscriptPresentationEntry = TranscriptPresentationEntryValue & {
  readonly viewportSlice?: {
    readonly text: string
    readonly rows: number
    readonly assistantMarkdown?: {
      readonly marginTop: 0 | 1
    }
  }
}

type Pairing = {
  toolResults: Map<number, ToolResultItem>
  toolResultIndexes: Map<number, number>
  toolCallIndexesByResult: Map<number, number>
  pairedToolResultIndexes: Set<number>
  shellResults: Map<number, ShellResultItem>
  shellResultIndexes: Map<number, number>
  pairedShellResultIndexes: Set<number>
}

type ReadSummary = { count: number; end: number }

/** Stable renderer key for one source Transcript item. */
export function transcriptPresentationEntryKey(
  item: TranscriptItem,
  sourceIndex: number,
): string {
  if (item.kind === 'tool') return `tool-${sourceIndex}-${item.call.id}`
  if (item.kind === 'tool-result') return `tool-result-${sourceIndex}`
  if (item.kind === 'shell') return `shell-${sourceIndex}-${item.callId}`
  if (item.kind === 'shell-result') return `shell-result-${sourceIndex}`
  return `item-${sourceIndex}`
}

/** Stable renderer key for a Normal-mode contiguous Read summary. */
export function transcriptReadSummaryKey(sourceIndex: number): string {
  return `read-summary-${sourceIndex}`
}

export function isCompletedBackgroundBashNotification(
  item: TranscriptItem,
): Extract<TranscriptItem, { kind: 'notice' | 'warning' }> | undefined {
  if (item.kind !== 'notice' && item.kind !== 'warning') return undefined
  const metadata = item.taskNotification
  if (
    !metadata ||
    metadata.status !== 'completed' ||
    !isBackgroundBashTaskId(metadata.taskId)
  )
    return undefined
  return item
}

export function completedBackgroundBashSummary(
  count: number,
): Extract<TranscriptItem, { kind: 'notice' | 'warning' }> {
  if (!Number.isInteger(count) || count <= 0)
    throw new RangeError('count must be a positive integer')
  return {
    kind: 'notice',
    text: `${count} background commands completed`,
  }
}

function pairResults(items: readonly TranscriptItem[]): Pairing {
  const toolResults = new Map<number, ToolResultItem>()
  const toolResultIndexes = new Map<number, number>()
  const toolCallIndexesByResult = new Map<number, number>()
  const pairedToolResultIndexes = new Set<number>()
  const shellResults = new Map<number, ShellResultItem>()
  const shellResultIndexes = new Map<number, number>()
  const pairedShellResultIndexes = new Set<number>()
  const pendingTools = new Map<string, { indexes: number[]; next: number }>()
  const pendingShells = new Map<string, { indexes: number[]; next: number }>()

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue
    if (item.kind === 'tool') {
      const pending = pendingTools.get(item.call.id) ?? { indexes: [], next: 0 }
      pending.indexes.push(index)
      pendingTools.set(item.call.id, pending)
    } else if (item.kind === 'tool-result') {
      const pending = pendingTools.get(item.callId)
      const callIndex = pending?.indexes[pending.next]
      if (pending && callIndex !== undefined) {
        pending.next += 1
        toolResults.set(callIndex, item)
        toolResultIndexes.set(callIndex, index)
        toolCallIndexesByResult.set(index, callIndex)
        pairedToolResultIndexes.add(index)
      }
      if (pending && pending.next === pending.indexes.length) {
        pendingTools.delete(item.callId)
      }
    } else if (item.kind === 'shell') {
      const pending = pendingShells.get(item.callId) ?? { indexes: [], next: 0 }
      pending.indexes.push(index)
      pendingShells.set(item.callId, pending)
    } else if (item.kind === 'shell-result') {
      const pending = pendingShells.get(item.callId)
      const callIndex = pending?.indexes[pending.next]
      if (pending && callIndex !== undefined) {
        pending.next += 1
        shellResults.set(callIndex, item)
        shellResultIndexes.set(callIndex, index)
        pairedShellResultIndexes.add(index)
      }
      if (pending && pending.next === pending.indexes.length) {
        pendingShells.delete(item.callId)
      }
    }
  }

  return {
    toolResults,
    toolResultIndexes,
    toolCallIndexesByResult,
    pairedToolResultIndexes,
    shellResults,
    shellResultIndexes,
    pairedShellResultIndexes,
  }
}

function readSummaryCount(
  items: readonly TranscriptItem[],
  start: number,
  pairing: Pairing,
  cache: Map<number, ReadSummary | undefined>,
): ReadSummary | undefined {
  if (cache.has(start)) return cache.get(start)
  const reads: number[] = []
  const readIndexes = new Set<number>()
  let cursor = start
  const failed = (): undefined => {
    for (const readIndex of reads) cache.set(readIndex, undefined)
    return undefined
  }

  while (cursor < items.length) {
    const item = items[cursor]
    if (item?.kind === 'tool' && item.call.name === 'Read') {
      reads.push(cursor)
      readIndexes.add(cursor)
      cursor += 1
      continue
    }
    if (
      item?.kind === 'tool-result' &&
      pairing.toolCallIndexesByResult.has(cursor) &&
      readIndexes.has(pairing.toolCallIndexesByResult.get(cursor) ?? -1)
    ) {
      if (item.isError) return failed()
      cursor += 1
      continue
    }
    break
  }

  if (
    reads.length === 0 ||
    reads.some((index) => {
      const resultIndex = pairing.toolResultIndexes.get(index)
      return resultIndex === undefined || resultIndex >= cursor
    })
  ) {
    return failed()
  }
  const summary = { count: reads.length, end: cursor }
  cache.set(start, summary)
  return summary
}

export function projectTranscriptPresentation(
  items: readonly TranscriptItem[],
  mode: TranscriptPresentationMode,
): readonly TranscriptPresentationEntry[] {
  const pairing = pairResults(items)
  const entries: TranscriptPresentationEntry[] = []
  const readSummaryCache = new Map<number, ReadSummary | undefined>()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (!item) continue

    if (mode === 'normal') {
      const notification = isCompletedBackgroundBashNotification(item)
      if (notification) {
        const notifications = [notification]
        let end = index + 1
        while (end < items.length) {
          const next = items[end]
          const nextNotification = next
            ? isCompletedBackgroundBashNotification(next)
            : undefined
          if (!nextNotification) break
          notifications.push(nextNotification)
          end += 1
        }
        if (notifications.length >= 2) {
          entries.push({
            kind: 'item',
            key: transcriptPresentationEntryKey(item, index),
            item: completedBackgroundBashSummary(notifications.length),
          })
          index = end - 1
          continue
        }
      }
    }

    if (
      mode === 'normal' &&
      item.kind === 'tool' &&
      item.call.name === 'Read'
    ) {
      const summary = readSummaryCount(items, index, pairing, readSummaryCache)
      if (summary) {
        entries.push({
          kind: 'read-summary',
          key: transcriptReadSummaryKey(index),
          count: summary.count,
        })
        index = summary.end - 1
        continue
      }
    }

    if (item.kind === 'tool') {
      const result = pairing.toolResults.get(index)
      entries.push({
        kind: 'tool',
        key: transcriptPresentationEntryKey(item, index),
        item,
        ...(result ? { result } : {}),
      })
      continue
    }
    if (item.kind === 'tool-result') {
      if (pairing.pairedToolResultIndexes.has(index)) continue
      entries.push({
        kind: 'orphan-tool-result',
        key: transcriptPresentationEntryKey(item, index),
        item,
      })
      continue
    }
    if (item.kind === 'shell') {
      const result = pairing.shellResults.get(index)
      entries.push({
        kind: 'shell',
        key: transcriptPresentationEntryKey(item, index),
        item,
        ...(result ? { result } : {}),
      })
      continue
    }
    if (item.kind === 'shell-result') {
      if (pairing.pairedShellResultIndexes.has(index)) continue
      entries.push({
        kind: 'orphan-shell-result',
        key: transcriptPresentationEntryKey(item, index),
        item,
      })
      continue
    }
    entries.push({
      kind: 'item',
      key: transcriptPresentationEntryKey(item, index),
      item,
    })
  }

  return entries
}
