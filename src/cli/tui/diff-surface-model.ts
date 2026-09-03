import {
  visiblePatchLines,
  type TuiDiffFile,
  type TuiDiffSnapshot,
} from './git-diff.js'

export interface TuiDiffSurfaceInput {
  /**
   * Display-ordered sources. Labels are stable and unique within the surface
   * (`Current`, then one `T<n>` per captured turn) and therefore identify tabs
   * and their file rows across reordering.
   */
  readonly sources: readonly { label: string; snapshot: TuiDiffSnapshot }[]
  readonly sourceIndex: number
  readonly selectedIndex: number
  readonly viewingFile: boolean
  readonly scrollOffset: number
}

export interface TuiDiffSurfaceAction {
  readonly visualLabel?: string
  readonly screenReaderLabel: string
}

export interface TuiDiffSurfaceCancellation {
  readonly visualLabel: string
  readonly screenReaderLabel: string
}

export interface TuiDiffSurfaceFile {
  readonly id: string
  readonly path: string
  readonly additions: number
  readonly deletions: number
}

export interface TuiDiffSurfacePatchRow {
  readonly id: string
  readonly text: string
  readonly kind: 'added' | 'removed' | 'context'
  readonly absoluteIndex: number
}

export interface TuiDiffSurfaceSourceTab {
  readonly id: string
  readonly index: number
  readonly label: string
  readonly selected: boolean
}

export interface TuiDiffSurfaceSummaryView {
  readonly kind: 'summary'
  readonly totals: { readonly additions: number; readonly deletions: number }
  readonly files: readonly TuiDiffSurfaceFile[]
  readonly selectedIndex: number | null
  readonly emptyText: string
  readonly actions: readonly TuiDiffSurfaceAction[]
  readonly cancellation: TuiDiffSurfaceCancellation
}

export interface TuiDiffSurfaceFileDetailView {
  readonly kind: 'file-detail'
  readonly file: TuiDiffSurfaceFile
  readonly patchRows: readonly TuiDiffSurfacePatchRow[]
  readonly windowSize: 18
  readonly scrollOffset: number
  readonly scrollRange: { readonly min: number; readonly max: number }
  readonly totalLines: number
  readonly visibleStart: number
  readonly visibleEnd: number
  readonly emptyPatchText: string
  readonly actions: readonly TuiDiffSurfaceAction[]
  readonly cancellation: TuiDiffSurfaceCancellation
}

export interface TuiDiffSurfaceModel {
  readonly kind: 'diff'
  readonly title: string
  readonly sourceTabs: readonly TuiDiffSurfaceSourceTab[]
  readonly currentSource: {
    readonly index: number
    readonly label: string
  } | null
  readonly view: TuiDiffSurfaceSummaryView | TuiDiffSurfaceFileDetailView
}

function index(value: number, count: number): number {
  if (count === 0) return 0
  const integer = Number.isFinite(value) ? Math.trunc(value) : 0
  return Math.max(0, Math.min(count - 1, integer))
}

function count(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
    : 0
}

function sum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function sourceId(label: string): string {
  return JSON.stringify(['diff-source', label])
}

function fileModel(file: TuiDiffFile, sourceLabel: string): TuiDiffSurfaceFile {
  return {
    id: JSON.stringify(['diff-file', sourceLabel, file.path]),
    path: file.path,
    additions: count(file.additions),
    deletions: count(file.deletions),
  }
}

export function projectTuiDiffSurface(
  input: TuiDiffSurfaceInput,
): TuiDiffSurfaceModel {
  const sources = input.sources
  const sourceIndex = index(input.sourceIndex, sources.length)
  const selectedSource = sources[sourceIndex]
  const source = selectedSource ?? {
    label: 'Current',
    snapshot: { files: [], additions: 0, deletions: 0 },
  }
  const files = source.snapshot.files.map((file) =>
    fileModel(file, source.label),
  )
  const selectedIndex = index(input.selectedIndex, files.length)
  const sourceTabs = sources.map((item, itemIndex) => ({
    id: sourceId(item.label),
    index: itemIndex,
    label: item.label,
    selected: itemIndex === sourceIndex,
  }))
  const cancellation =
    input.viewingFile && files[selectedIndex]
      ? { visualLabel: 'Esc to back', screenReaderLabel: 'Escape to go back' }
      : { visualLabel: 'Esc to close', screenReaderLabel: 'Escape to close' }
  if (!input.viewingFile || files.length === 0) {
    return {
      kind: 'diff',
      title: 'Changes since session start',
      sourceTabs,
      currentSource: selectedSource
        ? { index: sourceIndex, label: source.label }
        : null,
      view: {
        kind: 'summary',
        totals: files.reduce(
          (totals, file) => ({
            additions: sum(totals.additions, file.additions),
            deletions: sum(totals.deletions, file.deletions),
          }),
          { additions: 0, deletions: 0 },
        ),
        files,
        selectedIndex: files.length === 0 ? null : selectedIndex,
        emptyText: 'No uncommitted changes.',
        actions: [
          ...(sources.length > 1
            ? [
                {
                  visualLabel: '←/→ to switch source',
                  screenReaderLabel:
                    'Use left and right arrows to switch source',
                },
              ]
            : []),
          ...(files.length
            ? [
                {
                  visualLabel: '↑/↓ to select · Enter to view',
                  screenReaderLabel:
                    'Use up and down arrows to select a file, then Enter to view',
                },
              ]
            : []),
        ],
        cancellation,
      },
    }
  }
  const file = files[selectedIndex]
  if (file === undefined) {
    throw new Error('Diff detail requires a selected file')
  }
  const rawLines = visiblePatchLines(
    source.snapshot.files[selectedIndex]?.patch ?? '',
  )
  const maxOffset = Math.max(0, rawLines.length - 18)
  const offset = Math.max(
    0,
    Math.min(
      maxOffset,
      Number.isFinite(input.scrollOffset) ? Math.trunc(input.scrollOffset) : 0,
    ),
  )
  const patchRows = rawLines.slice(offset, offset + 18).map((text, row) => ({
    id: JSON.stringify(['diff-patch', file.id, offset + row]),
    text,
    kind:
      text.startsWith('+') && !text.startsWith('+++')
        ? ('added' as const)
        : text.startsWith('-') && !text.startsWith('---')
          ? ('removed' as const)
          : ('context' as const),
    absoluteIndex: offset + row,
  }))
  return {
    kind: 'diff',
    title: 'Changes since session start',
    sourceTabs,
    currentSource: selectedSource
      ? { index: sourceIndex, label: source.label }
      : null,
    view: {
      kind: 'file-detail',
      file,
      patchRows,
      windowSize: 18,
      scrollOffset: offset,
      scrollRange: { min: 0, max: maxOffset },
      totalLines: rawLines.length,
      visibleStart: rawLines.length ? offset + 1 : 0,
      visibleEnd: offset + patchRows.length,
      emptyPatchText: 'No patch content.',
      actions: [
        ...(sources.length > 1
          ? [
              {
                visualLabel: '←/→ to switch source',
                screenReaderLabel: 'Use left and right arrows to switch source',
              },
            ]
          : []),
        ...(rawLines.length > 18
          ? [
              {
                visualLabel: '↑/↓ to scroll',
                screenReaderLabel: 'Use up and down arrows to scroll the patch',
              },
            ]
          : []),
      ],
      cancellation,
    },
  }
}
