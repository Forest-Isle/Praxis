import type { CopyCandidate } from './runtime-interactions.js'

export interface TuiLeafSelectionOption {
  readonly id: string
  readonly label: string
  readonly description: string
}

export type TuiLeafSurfaceModel =
  | { readonly kind: 'model-input'; readonly value: string }
  | {
      readonly kind: 'export'
      readonly options: readonly TuiLeafSelectionOption[]
      readonly selectedIndex: number
    }
  | {
      readonly kind: 'copy'
      readonly options: readonly TuiLeafSelectionOption[]
      readonly selectedIndex: number
      readonly messageAge: number
    }
  | { readonly kind: 'export-filename'; readonly value: string }
  | { readonly kind: 'compact-progress'; readonly progress: number }

type SemanticOption = TuiLeafSelectionOption

export function projectTuiLeafSurface(input: {
  kind: 'model-input'
  value: string
}): Extract<TuiLeafSurfaceModel, { kind: 'model-input' }>
export function projectTuiLeafSurface(input: {
  kind: 'export'
  selectedIndex: number
}): Extract<TuiLeafSurfaceModel, { kind: 'export' }>
export function projectTuiLeafSurface(input: {
  kind: 'copy'
  candidates: readonly CopyCandidate[]
  selectedIndex: number
  messageAge: number
}): Extract<TuiLeafSurfaceModel, { kind: 'copy' }>
export function projectTuiLeafSurface(input: {
  kind: 'copy'
  candidates: readonly SemanticOption[]
  selectedIndex: number
  messageAge: number
}): Extract<TuiLeafSurfaceModel, { kind: 'copy' }>
export function projectTuiLeafSurface(input: {
  kind: 'export-filename'
  value: string
}): Extract<TuiLeafSurfaceModel, { kind: 'export-filename' }>
export function projectTuiLeafSurface(input: {
  kind: 'compact-progress'
  progress: number
}): Extract<TuiLeafSurfaceModel, { kind: 'compact-progress' }>
export function projectTuiLeafSurface(
  input:
    | { kind: 'model-input'; value: string }
    | { kind: 'export'; selectedIndex: number }
    | {
        kind: 'copy'
        candidates: readonly (CopyCandidate | SemanticOption)[]
        selectedIndex: number
        messageAge: number
      }
    | { kind: 'export-filename'; value: string }
    | { kind: 'compact-progress'; progress: number },
): TuiLeafSurfaceModel {
  switch (input.kind) {
    case 'model-input':
      return { kind: 'model-input', value: input.value }
    case 'export': {
      const options = [
        {
          id: 'clipboard',
          label: 'Copy to clipboard',
          description: 'Copy the conversation to your system clipboard',
        },
        {
          id: 'file',
          label: 'Save to file',
          description:
            'Save the conversation to a file in the current directory',
        },
      ] as const
      return {
        kind: 'export',
        options,
        selectedIndex: clampIndex(input.selectedIndex, options.length),
      }
    }
    case 'copy': {
      const options = input.candidates.map((candidate, index) => {
        if ('id' in candidate) return candidate
        return {
          id: `copy-${candidate.kind}-${index}`,
          label: candidate.label,
          description: candidate.description,
        }
      })
      return {
        kind: 'copy',
        options,
        selectedIndex: clampIndex(input.selectedIndex, options.length),
        messageAge: input.messageAge,
      }
    }
    case 'export-filename':
      return { kind: 'export-filename', value: input.value }
    case 'compact-progress':
      return {
        kind: 'compact-progress',
        progress: Math.max(0, Math.min(100, input.progress)),
      }
  }
}

function clampIndex(index: number, length: number): number {
  if (length === 0) return 0
  return Math.max(0, Math.min(length - 1, Math.floor(index)))
}
