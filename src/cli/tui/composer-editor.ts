export interface ComposerEditorState {
  text: string
  cursor: number
}

function characters(text: string): string[] {
  return Array.from(text)
}

function normalized(state: ComposerEditorState): ComposerEditorState {
  const length = characters(state.text).length
  return {
    text: state.text,
    cursor: Math.max(0, Math.min(state.cursor, length)),
  }
}

export function createComposerEditor(
  text = '',
  cursor = characters(text).length,
): ComposerEditorState {
  return normalized({ text, cursor })
}

export function insertComposerText(
  state: ComposerEditorState,
  text: string,
): ComposerEditorState {
  const current = normalized(state)
  const source = characters(current.text)
  const inserted = characters(text)
  return {
    text: [
      ...source.slice(0, current.cursor),
      ...inserted,
      ...source.slice(current.cursor),
    ].join(''),
    cursor: current.cursor + inserted.length,
  }
}

export function moveComposerCursor(
  state: ComposerEditorState,
  delta: number,
): ComposerEditorState {
  const current = normalized(state)
  return createComposerEditor(current.text, current.cursor + delta)
}

function wordBoundaryLeft(source: readonly string[], cursor: number): number {
  let index = cursor
  while (index > 0 && /\s/u.test(source[index - 1] ?? '')) index -= 1
  while (index > 0 && !/\s/u.test(source[index - 1] ?? '')) index -= 1
  return index
}

function wordBoundaryRight(source: readonly string[], cursor: number): number {
  let index = cursor
  while (index < source.length && /\s/u.test(source[index] ?? '')) index += 1
  while (index < source.length && !/\s/u.test(source[index] ?? '')) index += 1
  return index
}

export function moveComposerCursorByWord(
  state: ComposerEditorState,
  direction: 'backward' | 'forward',
): ComposerEditorState {
  const current = normalized(state)
  const source = characters(current.text)
  return createComposerEditor(
    current.text,
    direction === 'backward'
      ? wordBoundaryLeft(source, current.cursor)
      : wordBoundaryRight(source, current.cursor),
  )
}

export function deleteComposerBackward(
  state: ComposerEditorState,
): ComposerEditorState {
  const current = normalized(state)
  if (current.cursor === 0) return current
  const source = characters(current.text)
  return createComposerEditor(
    [
      ...source.slice(0, current.cursor - 1),
      ...source.slice(current.cursor),
    ].join(''),
    current.cursor - 1,
  )
}

export function deleteComposerForward(
  state: ComposerEditorState,
): ComposerEditorState {
  const current = normalized(state)
  const source = characters(current.text)
  if (current.cursor >= source.length) return current
  return createComposerEditor(
    [
      ...source.slice(0, current.cursor),
      ...source.slice(current.cursor + 1),
    ].join(''),
    current.cursor,
  )
}

export function deleteComposerWordBackward(
  state: ComposerEditorState,
): ComposerEditorState {
  const current = normalized(state)
  const source = characters(current.text)
  const start = wordBoundaryLeft(source, current.cursor)
  return createComposerEditor(
    [...source.slice(0, start), ...source.slice(current.cursor)].join(''),
    start,
  )
}

export function deleteComposerToStart(
  state: ComposerEditorState,
): ComposerEditorState {
  const current = normalized(state)
  const source = characters(current.text)
  return createComposerEditor(source.slice(current.cursor).join(''), 0)
}

export function deleteComposerToEnd(
  state: ComposerEditorState,
): ComposerEditorState {
  const current = normalized(state)
  const source = characters(current.text)
  return createComposerEditor(source.slice(0, current.cursor).join(''))
}

export function composerEditorSegments(state: ComposerEditorState): {
  before: string
  current: string | null
  after: string
} {
  const normalizedState = normalized(state)
  const source = characters(normalizedState.text)
  return {
    before: source.slice(0, normalizedState.cursor).join(''),
    current: source[normalizedState.cursor] ?? null,
    after: source.slice(normalizedState.cursor + 1).join(''),
  }
}
