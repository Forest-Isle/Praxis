import {
  createComposerEditor,
  deleteComposerToEnd,
  deleteComposerToStart,
  deleteComposerWordBackward,
  insertComposerText,
  moveComposerCursorByWord,
  type ComposerEditorState,
} from './composer-editor.js'
import {
  deleteComposerImageBackward,
  deleteComposerImageForward,
  moveComposerCursorAcrossImages,
} from './composer-images.js'

/**
 * Projection of an ink useInput key event that the pure composer router
 * consumes. It deliberately omits terminal/resolution concerns so the
 * router can never submit, exit, or resolve a modal.
 */
export interface ComposerKeyProjection {
  value: string
  left: boolean
  right: boolean
  backspace: boolean
  delete: boolean
  ctrl: boolean
  meta: boolean
  escape: boolean
}

export type ComposerKeyTransition =
  | { kind: 'edit'; editor: ComposerEditorState }
  | { kind: 'cancel' }
  | { kind: 'noop' }

/**
 * Pure normal-composer key transition router. Recognized editing input maps
 * onto the existing composer-editor/composer-images primitives; Escape maps to
 * a cancel result without mutating state; everything else is a noop.
 */
export function routeComposerKey(
  editor: ComposerEditorState,
  key: ComposerKeyProjection,
): ComposerKeyTransition {
  const state = createComposerEditor(editor.text, editor.cursor)
  const lower = key.value.toLowerCase()
  const controlKey = (letter: string) =>
    (key.ctrl && lower === letter) ||
    key.value === String.fromCharCode(letter.charCodeAt(0) - 96)
  const printable =
    key.value.length > 0 &&
    [...key.value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint >= 32 && codePoint !== 127
    })

  if (key.escape) return { kind: 'cancel' }
  if (key.left) {
    return {
      kind: 'edit',
      editor: key.meta
        ? moveComposerCursorByWord(state, 'backward')
        : moveComposerCursorAcrossImages(state, -1),
    }
  }
  if (key.right) {
    return {
      kind: 'edit',
      editor: key.meta
        ? moveComposerCursorByWord(state, 'forward')
        : moveComposerCursorAcrossImages(state, 1),
    }
  }
  if (controlKey('a')) {
    return { kind: 'edit', editor: createComposerEditor(state.text, 0) }
  }
  if (controlKey('e')) {
    return { kind: 'edit', editor: createComposerEditor(state.text) }
  }
  if (controlKey('b')) {
    return { kind: 'edit', editor: moveComposerCursorAcrossImages(state, -1) }
  }
  if (controlKey('f')) {
    return { kind: 'edit', editor: moveComposerCursorAcrossImages(state, 1) }
  }
  if (controlKey('w')) {
    return { kind: 'edit', editor: deleteComposerWordBackward(state) }
  }
  if (controlKey('u')) {
    return { kind: 'edit', editor: deleteComposerToStart(state) }
  }
  if (controlKey('k')) {
    return { kind: 'edit', editor: deleteComposerToEnd(state) }
  }
  if (key.backspace) {
    return { kind: 'edit', editor: deleteComposerImageBackward(state) }
  }
  if (key.delete) {
    return { kind: 'edit', editor: deleteComposerImageForward(state) }
  }
  if (!key.ctrl && !key.meta && key.value && printable) {
    return { kind: 'edit', editor: insertComposerText(state, key.value) }
  }
  return { kind: 'noop' }
}
