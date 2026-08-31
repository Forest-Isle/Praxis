import {
  createComposerEditor,
  type ComposerEditorState,
} from './composer-editor.js'

export const COMPOSER_PROMPT_HISTORY_LIMIT = 100

export interface ComposerPromptHistoryState {
  readonly entries: readonly string[]
  readonly index: number | null
  readonly draft: ComposerEditorState | null
}

export interface ComposerPromptHistoryTransition {
  readonly state: ComposerPromptHistoryState
  readonly editor: ComposerEditorState | null
}

export function createComposerPromptHistory(): ComposerPromptHistoryState {
  return { entries: [], index: null, draft: null }
}

function normalize(prompts: readonly string[]): string[] {
  const entries: string[] = []
  for (const prompt of prompts) {
    if (prompt.trim() === '') continue
    if (entries.at(-1) === prompt) continue
    entries.push(prompt)
  }
  return entries.slice(-COMPOSER_PROMPT_HISTORY_LIMIT)
}

export function seedComposerPromptHistory(
  prompts: readonly string[],
): ComposerPromptHistoryState {
  return { entries: normalize(prompts), index: null, draft: null }
}

export function recordComposerPrompt(
  state: ComposerPromptHistoryState,
  prompt: string,
): ComposerPromptHistoryState {
  if (prompt.trim() === '') return state
  return {
    entries: normalize([...state.entries, prompt]),
    index: null,
    draft: null,
  }
}

export function navigateComposerPromptHistory(
  state: ComposerPromptHistoryState,
  direction: 'previous' | 'next',
  currentEditor: ComposerEditorState,
): ComposerPromptHistoryTransition {
  if (state.entries.length === 0) return { state, editor: null }

  if (direction === 'previous') {
    const index =
      state.index === null
        ? state.entries.length - 1
        : Math.max(0, state.index - 1)
    const draft =
      state.index === null
        ? createComposerEditor(currentEditor.text, currentEditor.cursor)
        : state.draft
    const nextState = { ...state, index, draft }
    return {
      state: nextState,
      editor: createComposerEditor(state.entries[index]),
    }
  }

  if (state.index === null) return { state, editor: null }
  if (state.index < state.entries.length - 1) {
    const index = state.index + 1
    return {
      state: { ...state, index },
      editor: createComposerEditor(state.entries[index]),
    }
  }
  const editor = state.draft
  return {
    state: { ...state, index: null, draft: null },
    editor,
  }
}

export function resetComposerPromptHistoryNavigation(
  state: ComposerPromptHistoryState,
): ComposerPromptHistoryState {
  return { ...state, index: null, draft: null }
}
