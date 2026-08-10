import {
  createComposerEditor,
  deleteComposerBackward,
  deleteComposerForward,
  insertComposerText,
  moveComposerCursor,
  type ComposerEditorState,
} from './composer-editor.js'

type ImageMarker = { id: number; start: number; end: number }

function imageMarkers(text: string): readonly ImageMarker[] {
  const markers: ImageMarker[] = []
  const pattern = /\[Image #(\d+)\]/gu
  for (const match of text.matchAll(pattern)) {
    const value = match[0]
    const index = match.index
    const start = Array.from(text.slice(0, index)).length
    markers.push({ id: Number(match[1]), start, end: start + value.length })
  }
  return markers
}

export function composerImageIds(text: string): readonly number[] {
  return imageMarkers(text).map(({ id }) => id)
}

export function insertComposerImageMarker(
  state: ComposerEditorState,
  id: number,
): ComposerEditorState {
  const current = createComposerEditor(state.text, state.cursor)
  const before = Array.from(current.text).slice(0, current.cursor).join('')
  const separator = /\[Image #\d+\]$/u.test(before) ? ' ' : ''
  return insertComposerText(current, `${separator}[Image #${id}]`)
}

export function moveComposerCursorAcrossImages(
  state: ComposerEditorState,
  delta: -1 | 1,
): ComposerEditorState {
  const current = createComposerEditor(state.text, state.cursor)
  const marker = imageMarkers(current.text).find(({ start, end }) =>
    delta < 0
      ? start < current.cursor && current.cursor <= end
      : start <= current.cursor && current.cursor < end,
  )
  if (marker) {
    return createComposerEditor(
      current.text,
      delta < 0 ? marker.start : marker.end,
    )
  }
  return moveComposerCursor(current, delta)
}

export function deleteComposerImageBackward(
  state: ComposerEditorState,
): ComposerEditorState {
  const current = createComposerEditor(state.text, state.cursor)
  const marker = imageMarkers(current.text).find(
    ({ start, end }) => start < current.cursor && current.cursor <= end,
  )
  if (!marker) return deleteComposerBackward(current)
  const source = Array.from(current.text)
  return createComposerEditor(
    [...source.slice(0, marker.start), ...source.slice(marker.end)].join(''),
    marker.start,
  )
}

export function deleteComposerImageForward(
  state: ComposerEditorState,
): ComposerEditorState {
  const current = createComposerEditor(state.text, state.cursor)
  const marker = imageMarkers(current.text).find(
    ({ start, end }) => start <= current.cursor && current.cursor < end,
  )
  if (!marker) return deleteComposerForward(current)
  const source = Array.from(current.text)
  return createComposerEditor(
    [...source.slice(0, marker.start), ...source.slice(marker.end)].join(''),
    marker.start,
  )
}
