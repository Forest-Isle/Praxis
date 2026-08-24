import {
  projectTranscriptPresentation,
  transcriptPresentationEntryKey,
  transcriptReadSummaryKey,
  type TranscriptItem,
  type TranscriptPresentationEntry,
  type TranscriptPresentationMode,
} from './transcript-presentation.js'
import {
  createTranscriptEntryViewportIndex,
  estimateTranscriptEntryLines,
  projectTranscriptEntryRange,
  type TranscriptEntryViewportIndex,
} from './transcript-viewport.js'

/** Caller-owned local presentation revision; never persisted in a Transcript. */
export interface TuiHistoryChange {
  readonly revision: number
  readonly changedFrom: number
}

const historyChangeLineage = Symbol('tui-history-change-lineage')
type RetainedHistoryChange = TuiHistoryChange & {
  readonly [historyChangeLineage]?: {
    readonly history: readonly TranscriptItem[]
    readonly previousHistory?: readonly TranscriptItem[]
  }
}

function retainedHistoryChange(
  revision: number,
  changedFrom: number,
  history: readonly TranscriptItem[],
  previousHistory?: readonly TranscriptItem[],
): TuiHistoryChange {
  const change: RetainedHistoryChange = { revision, changedFrom }
  Object.defineProperty(change, historyChangeLineage, {
    value: Object.freeze({
      history,
      ...(previousHistory ? { previousHistory } : {}),
    }),
    enumerable: false,
  })
  return Object.freeze(change)
}

/**
 * Creates a caller-owned immutable mutation fact with non-persisted provenance.
 * Provenance lets the retained model verify an append in O(1); unbranded or
 * inconsistent facts remain valid inputs but deliberately take the cold path.
 */
export function createTuiHistoryChange(
  revision: number,
  changedFrom: number,
  history: readonly TranscriptItem[],
  previousHistory?: readonly TranscriptItem[],
): TuiHistoryChange {
  if (previousHistory) {
    if (changedFrom > previousHistory.length || changedFrom > history.length)
      return Object.freeze({ revision, changedFrom })
    for (let index = 0; index < changedFrom; index += 1) {
      if (history[index] !== previousHistory[index])
        return Object.freeze({ revision, changedFrom })
    }
  }
  return retainedHistoryChange(revision, changedFrom, history, previousHistory)
}

/** Constructs an append and its lineage proof without scanning the old prefix. */
export function appendTuiHistory(
  revision: number,
  previousHistory: readonly TranscriptItem[],
  suffix: readonly TranscriptItem[],
): {
  readonly history: TranscriptItem[]
  readonly change: TuiHistoryChange
} {
  const history = [...previousHistory, ...suffix]
  return {
    history,
    change: retainedHistoryChange(
      revision,
      previousHistory.length,
      history,
      previousHistory,
    ),
  }
}

/** @internal Brands an append already constructed by the React history owner. */
export function createTuiAppendHistoryChange(
  revision: number,
  previousHistory: readonly TranscriptItem[],
  history: readonly TranscriptItem[],
): TuiHistoryChange {
  if (history.length <= previousHistory.length)
    return Object.freeze({
      revision,
      changedFrom: previousHistory.length,
    })
  return retainedHistoryChange(
    revision,
    previousHistory.length,
    history,
    previousHistory,
  )
}

interface Leaf {
  readonly kind: 'leaf'
  readonly entries: readonly TranscriptPresentationEntry[]
  readonly rows: readonly number[]
  readonly viewportIndexes: readonly (
    TranscriptEntryViewportIndex | undefined
  )[]
  readonly entryCount: number
  readonly totalRows: number
}

interface Branch {
  readonly kind: 'branch'
  readonly left: RowNode
  readonly right: RowNode
  readonly entryCount: number
  readonly totalRows: number
  readonly height: number
}

type RowNode = Leaf | Branch
const LEAF_SIZE = 64
const VIEWPORT_INDEX_THRESHOLD = 64

function leaf(
  entries: readonly TranscriptPresentationEntry[],
  rows: readonly number[],
  viewportIndexes: readonly (TranscriptEntryViewportIndex | undefined)[] = [],
): Leaf {
  return {
    kind: 'leaf',
    entries,
    rows,
    viewportIndexes,
    entryCount: entries.length,
    totalRows: rows.reduce((total, count) => total + count, 0),
  }
}

function nodeHeight(node: RowNode): number {
  return node.kind === 'branch' ? node.height : 1
}

function branch(left: RowNode, right: RowNode): Branch {
  return {
    kind: 'branch',
    left,
    right,
    entryCount: left.entryCount + right.entryCount,
    totalRows: left.totalRows + right.totalRows,
    height: Math.max(nodeHeight(left), nodeHeight(right)) + 1,
  }
}

function rotateRowLeft(node: Branch): RowNode {
  if (node.right.kind !== 'branch') return node
  return branch(branch(node.left, node.right.left), node.right.right)
}

function rotateRowRight(node: Branch): RowNode {
  if (node.left.kind !== 'branch') return node
  return branch(node.left.left, branch(node.left.right, node.right))
}

function balanceRow(node: Branch): RowNode {
  const factor = nodeHeight(node.left) - nodeHeight(node.right)
  if (factor > 1 && node.left.kind === 'branch') {
    const left =
      nodeHeight(node.left.left) < nodeHeight(node.left.right)
        ? rotateRowLeft(node.left)
        : node.left
    return rotateRowRight(branch(left, node.right))
  }
  if (factor < -1 && node.right.kind === 'branch') {
    const right =
      nodeHeight(node.right.right) < nodeHeight(node.right.left)
        ? rotateRowRight(node.right)
        : node.right
    return rotateRowLeft(branch(node.left, right))
  }
  return node
}

function buildBalancedRows(leaves: readonly RowNode[]): RowNode {
  if (leaves.length === 0) return leaf([], [])
  const build = (start: number, end: number): RowNode => {
    if (end - start === 1) return leaves[start] ?? leaf([], [])
    const middle = start + Math.floor((end - start) / 2)
    return branch(build(start, middle), build(middle, end))
  }
  return build(0, leaves.length)
}

function buildTree(
  entries: readonly TranscriptPresentationEntry[],
  rows: readonly number[],
  viewportIndexes: readonly (TranscriptEntryViewportIndex | undefined)[],
): RowNode {
  const leaves: RowNode[] = []
  for (let start = 0; start < entries.length; start += LEAF_SIZE) {
    leaves.push(
      leaf(
        entries.slice(start, start + LEAF_SIZE),
        rows.slice(start, start + LEAF_SIZE),
        viewportIndexes.slice(start, start + LEAF_SIZE),
      ),
    )
  }
  return buildBalancedRows(leaves)
}

function appendTree(
  node: RowNode,
  entry: TranscriptPresentationEntry,
  rows: number,
  viewportIndex: TranscriptEntryViewportIndex | undefined,
): RowNode {
  if (node.kind === 'leaf') {
    if (node.entries.length < LEAF_SIZE)
      return leaf(
        [...node.entries, entry],
        [...node.rows, rows],
        [...node.viewportIndexes, viewportIndex],
      )
    return branch(node, leaf([entry], [rows], [viewportIndex]))
  }
  return balanceRow(
    branch(node.left, appendTree(node.right, entry, rows, viewportIndex)),
  )
}

function updateTree(
  node: RowNode,
  index: number,
  entry: TranscriptPresentationEntry,
  rows: number,
  viewportIndex: TranscriptEntryViewportIndex | undefined,
): RowNode {
  if (node.kind === 'leaf') {
    if (index < 0 || index >= node.entryCount) return node
    const entries = [...node.entries]
    const counts = [...node.rows]
    const viewportIndexes = [...node.viewportIndexes]
    entries[index] = entry
    counts[index] = rows
    viewportIndexes[index] = viewportIndex
    return leaf(entries, counts, viewportIndexes)
  }
  return index < node.left.entryCount
    ? branch(
        updateTree(node.left, index, entry, rows, viewportIndex),
        node.right,
      )
    : branch(
        node.left,
        updateTree(
          node.right,
          index - node.left.entryCount,
          entry,
          rows,
          viewportIndex,
        ),
      )
}

function joinRows(left: RowNode, right: RowNode): RowNode {
  if (left.entryCount === 0) return right
  if (right.entryCount === 0) return left
  if (nodeHeight(left) > nodeHeight(right) + 1 && left.kind === 'branch')
    return balanceRow(branch(left.left, joinRows(left.right, right)))
  if (nodeHeight(right) > nodeHeight(left) + 1 && right.kind === 'branch')
    return balanceRow(branch(joinRows(left, right.left), right.right))
  return branch(left, right)
}

function takeTree(node: RowNode, count: number): RowNode {
  if (count <= 0) return leaf([], [])
  if (count >= node.entryCount) return node
  if (node.kind === 'leaf')
    return leaf(
      node.entries.slice(0, count),
      node.rows.slice(0, count),
      node.viewportIndexes.slice(0, count),
    )
  if (count <= node.left.entryCount) return takeTree(node.left, count)
  return joinRows(node.left, takeTree(node.right, count - node.left.entryCount))
}

function treeAt(
  node: RowNode,
  index: number,
): TranscriptPresentationEntry | undefined {
  if (index < 0 || index >= node.entryCount) return undefined
  if (node.kind === 'leaf') return node.entries[index]
  return index < node.left.entryCount
    ? treeAt(node.left, index)
    : treeAt(node.right, index - node.left.entryCount)
}

function treeEntries(
  node: RowNode,
  output: TranscriptPresentationEntry[] = [],
): readonly TranscriptPresentationEntry[] {
  if (node.kind === 'leaf') output.push(...node.entries)
  else {
    treeEntries(node.left, output)
    treeEntries(node.right, output)
  }
  return output
}

interface RowSelection {
  readonly entry: TranscriptPresentationEntry
  readonly start: number
  readonly rows: number
  readonly viewportIndex?: TranscriptEntryViewportIndex
}

function collectRange(
  node: RowNode,
  start: number,
  end: number,
  base = 0,
  output: RowSelection[] = [],
): readonly RowSelection[] {
  if (end <= base || start >= base + node.totalRows) return output
  if (node.kind === 'leaf') {
    let cursor = base
    for (let index = 0; index < node.entryCount; index += 1) {
      const count = node.rows[index] ?? 0
      const entry = node.entries[index]
      const viewportIndex = node.viewportIndexes[index]
      if (entry && cursor + count > start && cursor < end)
        output.push({
          entry,
          start: cursor,
          rows: count,
          ...(viewportIndex ? { viewportIndex } : {}),
        })
      cursor += count
    }
    return output
  }
  collectRange(node.left, start, end, base, output)
  collectRange(node.right, start, end, base + node.left.totalRows, output)
  return output
}

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>
type ShellItem = Extract<TranscriptItem, { kind: 'shell' }>
type ToolEntry = Extract<TranscriptPresentationEntry, { kind: 'tool' }>

interface PendingCall {
  readonly sourceIndex: number
  readonly presentationIndex: number
  readonly item: ToolItem | ShellItem
}

interface PendingList {
  readonly value: PendingCall
  readonly next?: PendingList
}

interface PendingQueue {
  readonly front?: PendingList
  readonly back?: PendingList
  readonly length: number
}

interface PendingNode {
  readonly key: string
  readonly queue: PendingQueue
  readonly left?: PendingNode
  readonly right?: PendingNode
  readonly height: number
}

function pendingHeight(node: PendingNode | undefined): number {
  return node?.height ?? 0
}

function pendingNode(
  key: string,
  queue: PendingQueue,
  left?: PendingNode,
  right?: PendingNode,
): PendingNode {
  return {
    key,
    queue,
    ...(left ? { left } : {}),
    ...(right ? { right } : {}),
    height: Math.max(pendingHeight(left), pendingHeight(right)) + 1,
  }
}

function rotatePendingLeft(node: PendingNode): PendingNode {
  const right = node.right
  if (!right) return node
  return pendingNode(
    right.key,
    right.queue,
    pendingNode(node.key, node.queue, node.left, right.left),
    right.right,
  )
}

function rotatePendingRight(node: PendingNode): PendingNode {
  const left = node.left
  if (!left) return node
  return pendingNode(
    left.key,
    left.queue,
    left.left,
    pendingNode(node.key, node.queue, left.right, node.right),
  )
}

function balancePending(node: PendingNode): PendingNode {
  const factor = pendingHeight(node.left) - pendingHeight(node.right)
  if (factor > 1 && node.left) {
    const left =
      pendingHeight(node.left.left) < pendingHeight(node.left.right)
        ? rotatePendingLeft(node.left)
        : node.left
    return rotatePendingRight(
      pendingNode(node.key, node.queue, left, node.right),
    )
  }
  if (factor < -1 && node.right) {
    const right =
      pendingHeight(node.right.right) < pendingHeight(node.right.left)
        ? rotatePendingRight(node.right)
        : node.right
    return rotatePendingLeft(
      pendingNode(node.key, node.queue, node.left, right),
    )
  }
  return node
}

function pendingGet(
  node: PendingNode | undefined,
  key: string,
): PendingQueue | undefined {
  let cursor = node
  while (cursor) {
    if (key === cursor.key) return cursor.queue
    cursor = key < cursor.key ? cursor.left : cursor.right
  }
  return undefined
}

function pendingSet(
  node: PendingNode | undefined,
  key: string,
  queue: PendingQueue,
): PendingNode {
  if (!node) return pendingNode(key, queue)
  if (key === node.key) return pendingNode(key, queue, node.left, node.right)
  return key < node.key
    ? balancePending(
        pendingNode(
          node.key,
          node.queue,
          pendingSet(node.left, key, queue),
          node.right,
        ),
      )
    : balancePending(
        pendingNode(
          node.key,
          node.queue,
          node.left,
          pendingSet(node.right, key, queue),
        ),
      )
}

function pendingMinimum(node: PendingNode): PendingNode {
  let cursor = node
  while (cursor.left) cursor = cursor.left
  return cursor
}

function pendingDelete(
  node: PendingNode | undefined,
  key: string,
): PendingNode | undefined {
  if (!node) return undefined
  if (key < node.key) {
    const left = pendingDelete(node.left, key)
    return balancePending(pendingNode(node.key, node.queue, left, node.right))
  }
  if (key > node.key) {
    const right = pendingDelete(node.right, key)
    return balancePending(pendingNode(node.key, node.queue, node.left, right))
  }
  if (!node.left) return node.right
  if (!node.right) return node.left
  const successor = pendingMinimum(node.right)
  return balancePending(
    pendingNode(
      successor.key,
      successor.queue,
      node.left,
      pendingDelete(node.right, successor.key),
    ),
  )
}

function pendingPush(
  root: PendingNode | undefined,
  key: string,
  call: PendingCall,
): PendingNode {
  const queue = pendingGet(root, key) ?? { length: 0 }
  return pendingSet(root, key, {
    ...queue,
    back: { value: call, ...(queue.back ? { next: queue.back } : {}) },
    length: queue.length + 1,
  })
}

function reversePendingList(
  list: PendingList | undefined,
): PendingList | undefined {
  let cursor = list
  let reversed: PendingList | undefined
  while (cursor) {
    reversed = {
      value: cursor.value,
      ...(reversed ? { next: reversed } : {}),
    }
    cursor = cursor.next
  }
  return reversed
}

function pendingFirst(
  queue: PendingQueue | undefined,
): PendingCall | undefined {
  if (queue?.front) return queue.front.value
  let cursor = queue?.back
  while (cursor?.next) cursor = cursor.next
  return cursor?.value
}

function pendingPop(
  root: PendingNode | undefined,
  key: string,
): readonly [PendingCall | undefined, PendingNode | undefined] {
  const queue = pendingGet(root, key)
  if (!queue || queue.length === 0) return [undefined, root]
  const front = queue.front ?? reversePendingList(queue.back)
  const first = front?.value
  if (!first) return [undefined, root]
  const remaining: PendingQueue = {
    ...(front.next ? { front: front.next } : {}),
    ...(queue.front && queue.back ? { back: queue.back } : {}),
    length: queue.length - 1,
  }
  return [
    first,
    remaining.length > 0
      ? pendingSet(root, key, remaining)
      : pendingDelete(root, key),
  ]
}

interface ReadRunCall {
  readonly sourceIndex: number
  readonly entry: ToolEntry
}

interface TailReadRun {
  readonly startSourceIndex: number
  readonly startPresentationIndex: number
  readonly nextSourceIndex: number
  readonly calls: readonly ReadRunCall[]
  readonly summarized: boolean
}

export interface TranscriptWindowState {
  readonly history: readonly TranscriptItem[]
  readonly mode: TranscriptPresentationMode
  readonly width: number
  readonly tree: RowNode
  readonly pendingTools?: PendingNode
  readonly pendingShells?: PendingNode
  readonly tailReadRun?: TailReadRun
  readonly revision: number
}

export interface TranscriptWindowInput {
  readonly history: readonly TranscriptItem[]
  readonly mode: TranscriptPresentationMode
  readonly width: number
  readonly pageRows: number
  readonly scrollOffset: number
  readonly revision: number
  readonly bounded: boolean
}

export interface TranscriptWindowResult {
  readonly state: TranscriptWindowState
  readonly allEntries: readonly TranscriptPresentationEntry[]
  readonly entries: readonly TranscriptPresentationEntry[]
  readonly totalRows: number
  readonly maxOffset: number
  readonly transition: 'cold' | 'same' | 'append'
}

interface MutablePendingQueue {
  readonly calls: PendingCall[]
  next: number
}

interface ColdPairing {
  readonly pendingTools?: PendingNode
  readonly pendingShells?: PendingNode
  readonly entryIndexes: ReadonlyMap<string, number>
  readonly pairedToolCallByResult: ReadonlyMap<number, PendingCall>
  readonly toolResultByCall: ReadonlyMap<
    number,
    Extract<TranscriptItem, { kind: 'tool-result' }>
  >
}

function coldPairing(
  history: readonly TranscriptItem[],
  entries: readonly TranscriptPresentationEntry[],
): ColdPairing {
  const entryIndexes = new Map(
    entries.map((entry, index) => [entry.key, index] as const),
  )
  const tools = new Map<string, MutablePendingQueue>()
  const shells = new Map<string, MutablePendingQueue>()
  const pairedToolCallByResult = new Map<number, PendingCall>()
  const toolResultByCall = new Map<
    number,
    Extract<TranscriptItem, { kind: 'tool-result' }>
  >()

  for (let sourceIndex = 0; sourceIndex < history.length; sourceIndex += 1) {
    const item = history[sourceIndex]
    if (!item) continue
    if (item.kind === 'tool') {
      const pending = tools.get(item.call.id) ?? { calls: [], next: 0 }
      pending.calls.push({
        sourceIndex,
        presentationIndex:
          entryIndexes.get(transcriptPresentationEntryKey(item, sourceIndex)) ??
          -1,
        item,
      })
      tools.set(item.call.id, pending)
      continue
    }
    if (item.kind === 'tool-result') {
      const pending = tools.get(item.callId)
      const call = pending?.calls[pending.next]
      if (pending && call) {
        pending.next += 1
        pairedToolCallByResult.set(sourceIndex, call)
        toolResultByCall.set(call.sourceIndex, item)
        if (pending.next === pending.calls.length) tools.delete(item.callId)
      }
      continue
    }
    if (item.kind === 'shell') {
      const pending = shells.get(item.callId) ?? { calls: [], next: 0 }
      pending.calls.push({
        sourceIndex,
        presentationIndex:
          entryIndexes.get(transcriptPresentationEntryKey(item, sourceIndex)) ??
          -1,
        item,
      })
      shells.set(item.callId, pending)
      continue
    }
    if (item.kind === 'shell-result') {
      const pending = shells.get(item.callId)
      if (pending?.calls[pending.next]) pending.next += 1
      if (pending && pending.next === pending.calls.length)
        shells.delete(item.callId)
    }
  }

  let pendingTools: PendingNode | undefined
  for (const [key, pending] of tools) {
    for (const call of pending.calls.slice(pending.next))
      pendingTools = pendingPush(pendingTools, key, call)
  }
  let pendingShells: PendingNode | undefined
  for (const [key, pending] of shells) {
    for (const call of pending.calls.slice(pending.next))
      pendingShells = pendingPush(pendingShells, key, call)
  }
  return {
    ...(pendingTools ? { pendingTools } : {}),
    ...(pendingShells ? { pendingShells } : {}),
    entryIndexes,
    pairedToolCallByResult,
    toolResultByCall,
  }
}

function coldTailReadRun(
  history: readonly TranscriptItem[],
  pairing: ColdPairing,
): TailReadRun | undefined {
  let start = history.length
  while (start > 0) {
    const item = history[start - 1]
    if (item?.kind === 'tool' && item.call.name === 'Read') {
      start -= 1
      continue
    }
    if (item?.kind === 'tool-result' && !item.isError) {
      const call = pairing.pairedToolCallByResult.get(start - 1)
      if (call?.item.kind === 'tool' && call.item.call.name === 'Read') {
        start -= 1
        continue
      }
    }
    break
  }
  if (start >= history.length) return undefined

  const readCalls: ReadRunCall[] = []
  for (let index = start; index < history.length; index += 1) {
    const item = history[index]
    if (item?.kind === 'tool' && item.call.name === 'Read') {
      const result = pairing.toolResultByCall.get(index)
      readCalls.push({
        sourceIndex: index,
        entry: {
          kind: 'tool',
          key: transcriptPresentationEntryKey(item, index),
          item,
          ...(result ? { result } : {}),
        },
      })
      continue
    }
    if (item?.kind === 'tool-result') {
      const call = pairing.pairedToolCallByResult.get(index)
      if (!call || call.sourceIndex < start || item.isError) return undefined
      continue
    }
    return undefined
  }
  if (readCalls.length === 0) return undefined

  const summarized = readCalls.every((call) => call.entry.result !== undefined)
  const firstCall = readCalls[0]
  if (!firstCall) return undefined
  const targetKey = summarized
    ? transcriptReadSummaryKey(start)
    : firstCall.entry.key
  const startPresentationIndex = pairing.entryIndexes.get(targetKey)
  if (startPresentationIndex === undefined) return undefined
  return {
    startSourceIndex: start,
    startPresentationIndex,
    nextSourceIndex: history.length,
    calls: readCalls,
    summarized,
  }
}

function canReuseEntry(
  previous: TranscriptPresentationEntry,
  next: TranscriptPresentationEntry,
): boolean {
  if (previous.kind !== next.kind || previous.key !== next.key) return false
  if (previous.kind === 'read-summary' && next.kind === 'read-summary')
    return previous.count === next.count
  if (previous.kind === 'item' && next.kind === 'item')
    return previous.item === next.item
  if (previous.kind === 'tool' && next.kind === 'tool')
    return previous.item === next.item && previous.result === next.result
  if (previous.kind === 'shell' && next.kind === 'shell')
    return previous.item === next.item && previous.result === next.result
  if (
    previous.kind === 'orphan-tool-result' &&
    next.kind === 'orphan-tool-result'
  )
    return previous.item === next.item
  if (
    previous.kind === 'orphan-shell-result' &&
    next.kind === 'orphan-shell-result'
  )
    return previous.item === next.item
  return false
}

function reuseColdEntries(
  previous: TranscriptWindowState | undefined,
  entries: readonly TranscriptPresentationEntry[],
): readonly TranscriptPresentationEntry[] {
  if (!previous) return entries
  const byKey = new Map(
    treeEntries(previous.tree).map((entry) => [entry.key, entry] as const),
  )
  return entries.map((entry) => {
    const prior = byKey.get(entry.key)
    return prior && canReuseEntry(prior, entry) ? prior : entry
  })
}

function coldState(
  input: TranscriptWindowInput,
  previous?: TranscriptWindowState,
): TranscriptWindowState {
  const projected = projectTranscriptPresentation(input.history, input.mode)
  const entries = reuseColdEntries(previous, projected)
  const rows = entries.map((entry) =>
    estimateTranscriptEntryLines(entry, input.width, input.mode),
  )
  const viewportIndexes = entries.map((entry, index) => {
    const rowCount = rows[index] ?? 0
    if (rowCount <= VIEWPORT_INDEX_THRESHOLD) return undefined
    const viewportIndex = createTranscriptEntryViewportIndex(
      entry,
      input.width,
      input.mode,
    )
    return viewportIndex?.rows.length === rowCount ? viewportIndex : undefined
  })
  const pairing = coldPairing(input.history, entries)
  const tailReadRun =
    input.mode === 'normal'
      ? coldTailReadRun(input.history, pairing)
      : undefined
  return {
    history: input.history,
    mode: input.mode,
    width: input.width,
    tree: buildTree(entries, rows, viewportIndexes),
    ...(pairing.pendingTools ? { pendingTools: pairing.pendingTools } : {}),
    ...(pairing.pendingShells ? { pendingShells: pairing.pendingShells } : {}),
    ...(tailReadRun ? { tailReadRun } : {}),
    revision: input.revision,
  }
}

function entryForItem(
  item: TranscriptItem,
  sourceIndex: number,
): TranscriptPresentationEntry {
  const key = transcriptPresentationEntryKey(item, sourceIndex)
  if (item.kind === 'tool') return { kind: 'tool', key, item }
  if (item.kind === 'tool-result')
    return { kind: 'orphan-tool-result', key, item }
  if (item.kind === 'shell') return { kind: 'shell', key, item }
  if (item.kind === 'shell-result')
    return { kind: 'orphan-shell-result', key, item }
  return { kind: 'item', key, item }
}

function appendEntry(
  tree: RowNode,
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): RowNode {
  const rowCount = estimateTranscriptEntryLines(entry, width, mode)
  const viewportIndex =
    rowCount > VIEWPORT_INDEX_THRESHOLD
      ? createTranscriptEntryViewportIndex(entry, width, mode)
      : undefined
  return appendTree(
    tree,
    entry,
    rowCount,
    viewportIndex?.rows.length === rowCount ? viewportIndex : undefined,
  )
}

function updateEntry(
  tree: RowNode,
  index: number,
  entry: TranscriptPresentationEntry,
  width: number,
  mode: TranscriptPresentationMode,
): RowNode {
  const rowCount = estimateTranscriptEntryLines(entry, width, mode)
  const viewportIndex =
    rowCount > VIEWPORT_INDEX_THRESHOLD
      ? createTranscriptEntryViewportIndex(entry, width, mode)
      : undefined
  return updateTree(
    tree,
    index,
    entry,
    rowCount,
    viewportIndex?.rows.length === rowCount ? viewportIndex : undefined,
  )
}

function appendState(
  input: TranscriptWindowInput,
  previous: TranscriptWindowState,
  change: TuiHistoryChange,
): TranscriptWindowState | undefined {
  const changedFrom = change.changedFrom
  const lineage = (change as RetainedHistoryChange)[historyChangeLineage]
  const previousLength = previous.history.length
  if (
    lineage?.history !== input.history ||
    lineage.previousHistory !== previous.history ||
    input.mode !== previous.mode ||
    input.width !== previous.width ||
    input.revision !== previous.revision + 1 ||
    changedFrom !== previousLength ||
    input.history.length <= previousLength ||
    (previousLength > 0 &&
      input.history[previousLength - 1] !==
        previous.history[previousLength - 1])
  )
    return undefined

  const suffix = input.history.slice(previousLength)
  let tree = previous.tree
  let pendingTools = previous.pendingTools
  let pendingShells = previous.pendingShells
  let tailReadRun = previous.tailReadRun

  for (let offset = 0; offset < suffix.length; offset += 1) {
    const sourceIndex = previousLength + offset
    const item = suffix[offset]
    if (!item) continue

    const pendingTool =
      item.kind === 'tool-result'
        ? pendingFirst(pendingGet(pendingTools, item.callId))
        : undefined
    const continuesReadRun =
      input.mode === 'normal' &&
      tailReadRun?.nextSourceIndex === sourceIndex &&
      ((item.kind === 'tool' && item.call.name === 'Read') ||
        (item.kind === 'tool-result' &&
          pendingTool?.item.kind === 'tool' &&
          pendingTool.item.call.name === 'Read' &&
          tailReadRun.calls.some(
            (call) => call.sourceIndex === pendingTool.sourceIndex,
          )))
    if (!continuesReadRun) tailReadRun = undefined

    if (item.kind === 'tool') {
      if (item.call.name === 'Read' && input.mode === 'normal') {
        if (tailReadRun?.summarized) {
          tree = takeTree(tree, tailReadRun.startPresentationIndex)
          for (const call of tailReadRun.calls)
            tree = appendEntry(tree, call.entry, input.width, input.mode)
        }
        const entry = entryForItem(item, sourceIndex)
        if (entry.kind !== 'tool') return undefined
        const presentationIndex = tree.entryCount
        tree = appendEntry(tree, entry, input.width, input.mode)
        pendingTools = pendingPush(pendingTools, item.call.id, {
          sourceIndex,
          presentationIndex,
          item,
        })
        tailReadRun = tailReadRun
          ? {
              ...tailReadRun,
              nextSourceIndex: sourceIndex + 1,
              calls: [...tailReadRun.calls, { sourceIndex, entry }],
              summarized: false,
            }
          : {
              startSourceIndex: sourceIndex,
              startPresentationIndex: presentationIndex,
              nextSourceIndex: sourceIndex + 1,
              calls: [{ sourceIndex, entry }],
              summarized: false,
            }
        continue
      }

      const entry = entryForItem(item, sourceIndex)
      const presentationIndex = tree.entryCount
      tree = appendEntry(tree, entry, input.width, input.mode)
      pendingTools = pendingPush(pendingTools, item.call.id, {
        sourceIndex,
        presentationIndex,
        item,
      })
      continue
    }

    if (item.kind === 'tool-result') {
      const [pending, nextPendingTools] = pendingPop(pendingTools, item.callId)
      pendingTools = nextPendingTools
      if (!pending) {
        tree = appendEntry(
          tree,
          entryForItem(item, sourceIndex),
          input.width,
          input.mode,
        )
        continue
      }
      const prior = treeAt(tree, pending.presentationIndex)
      if (prior?.kind !== 'tool') return undefined
      const next: ToolEntry = { ...prior, result: item }
      tree = updateEntry(
        tree,
        pending.presentationIndex,
        next,
        input.width,
        input.mode,
      )

      if (continuesReadRun && tailReadRun) {
        const calls = tailReadRun.calls.map((call) =>
          call.sourceIndex === pending.sourceIndex
            ? { ...call, entry: next }
            : call,
        )
        if (item.isError) {
          tailReadRun = undefined
        } else if (calls.every((call) => call.entry.result !== undefined)) {
          tree = takeTree(tree, tailReadRun.startPresentationIndex)
          tree = appendEntry(
            tree,
            {
              kind: 'read-summary',
              key: transcriptReadSummaryKey(tailReadRun.startSourceIndex),
              count: calls.length,
            },
            input.width,
            input.mode,
          )
          tailReadRun = {
            ...tailReadRun,
            nextSourceIndex: sourceIndex + 1,
            calls,
            summarized: true,
          }
        } else {
          tailReadRun = {
            ...tailReadRun,
            nextSourceIndex: sourceIndex + 1,
            calls,
            summarized: false,
          }
        }
      }
      continue
    }

    if (item.kind === 'shell') {
      const entry = entryForItem(item, sourceIndex)
      const presentationIndex = tree.entryCount
      tree = appendEntry(tree, entry, input.width, input.mode)
      pendingShells = pendingPush(pendingShells, item.callId, {
        sourceIndex,
        presentationIndex,
        item,
      })
      continue
    }

    if (item.kind === 'shell-result') {
      const [pending, nextPendingShells] = pendingPop(
        pendingShells,
        item.callId,
      )
      pendingShells = nextPendingShells
      if (!pending) {
        tree = appendEntry(
          tree,
          entryForItem(item, sourceIndex),
          input.width,
          input.mode,
        )
        continue
      }
      const prior = treeAt(tree, pending.presentationIndex)
      if (prior?.kind !== 'shell') return undefined
      const next = { ...prior, result: item } satisfies Extract<
        TranscriptPresentationEntry,
        { kind: 'shell' }
      >
      tree = updateEntry(
        tree,
        pending.presentationIndex,
        next,
        input.width,
        input.mode,
      )
      continue
    }

    tree = appendEntry(
      tree,
      entryForItem(item, sourceIndex),
      input.width,
      input.mode,
    )
  }

  return {
    history: input.history,
    mode: input.mode,
    width: input.width,
    tree,
    ...(pendingTools ? { pendingTools } : {}),
    ...(pendingShells ? { pendingShells } : {}),
    ...(tailReadRun ? { tailReadRun } : {}),
    revision: input.revision,
  }
}

function select(
  state: TranscriptWindowState,
  pageRows: number,
  offset: number,
  width: number,
  mode: TranscriptPresentationMode,
): readonly TranscriptPresentationEntry[] {
  const max = Math.max(0, state.tree.totalRows - pageRows)
  const clamped = Math.min(Math.max(0, offset), max)
  const end = state.tree.totalRows - clamped
  const start = Math.max(0, end - pageRows)
  const candidates = collectRange(state.tree, start, end)
  const selected: TranscriptPresentationEntry[] = []
  for (const candidate of candidates) {
    const candidateEnd = candidate.start + candidate.rows
    const overlapStart = Math.max(start, candidate.start)
    const overlapEnd = Math.min(end, candidateEnd)
    if (overlapStart >= overlapEnd) continue
    const localStart = overlapStart - candidate.start
    const overlapRows = overlapEnd - overlapStart
    if (localStart === 0 && overlapRows === candidate.rows) {
      selected.push(candidate.entry)
      continue
    }
    if (clamped === 0 && candidateEnd < end) continue
    const projected = projectTranscriptEntryRange(
      candidate.entry,
      localStart,
      overlapRows,
      width,
      mode,
      candidate.viewportIndex,
    )
    const projectedRows = projected.viewportSlice?.rows ?? candidate.rows
    if (projectedRows <= overlapRows) selected.push(projected)
  }
  return selected
}

export function projectTranscriptWindow(
  input: TranscriptWindowInput,
  previous?: TranscriptWindowState,
  change?: TuiHistoryChange,
): TranscriptWindowResult {
  const validFacts =
    change !== undefined &&
    change.revision === input.revision &&
    Number.isInteger(input.revision) &&
    input.revision >= 0 &&
    Number.isInteger(change.changedFrom) &&
    change.changedFrom >= 0 &&
    change.changedFrom <= input.history.length
  const advanced =
    previous && validFacts && change
      ? appendState(input, previous, change)
      : undefined
  const same =
    !advanced &&
    validFacts &&
    previous !== undefined &&
    input.revision === previous.revision &&
    input.history === previous.history &&
    input.mode === previous.mode &&
    input.width === previous.width
  const state = advanced ?? (same ? previous : coldState(input, previous))
  const transition: TranscriptWindowResult['transition'] = advanced
    ? 'append'
    : same
      ? 'same'
      : 'cold'
  const totalRows = state.tree.totalRows
  const maxOffset = Math.max(0, totalRows - input.pageRows)
  const allEntries = input.bounded ? [] : treeEntries(state.tree)
  const entries = input.bounded
    ? input.pageRows >= totalRows
      ? treeEntries(state.tree)
      : select(
          state,
          input.pageRows,
          input.scrollOffset,
          input.width,
          input.mode,
        )
    : allEntries
  return { state, allEntries, entries, totalRows, maxOffset, transition }
}
