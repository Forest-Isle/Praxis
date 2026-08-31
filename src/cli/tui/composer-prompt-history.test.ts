import { describe, expect, it } from 'vitest'

import { createComposerEditor } from './composer-editor.js'
import {
  COMPOSER_PROMPT_HISTORY_LIMIT,
  navigateComposerPromptHistory,
  resetComposerPromptHistoryNavigation,
  createComposerPromptHistory,
  recordComposerPrompt,
  seedComposerPromptHistory,
} from './composer-prompt-history.js'

describe('composer prompt history', () => {
  it('normalizes adjacent duplicates and retains chronological entries', () => {
    expect(seedComposerPromptHistory(['', 'a', 'a', 'b', 'a']).entries).toEqual(
      ['a', 'b', 'a'],
    )
  })

  it('walks chronologically, clamps, and restores the draft cursor', () => {
    const state = seedComposerPromptHistory(['oldest', 'middle', 'newest'])
    const draft = createComposerEditor('draft', 2)
    const first = navigateComposerPromptHistory(state, 'previous', draft)
    expect(first.editor).toEqual(createComposerEditor('newest'))
    const older = navigateComposerPromptHistory(
      first.state,
      'previous',
      first.editor ?? draft,
    )
    expect(older.editor).toEqual(createComposerEditor('middle'))
    const oldest = navigateComposerPromptHistory(
      older.state,
      'previous',
      older.editor ?? draft,
    )
    expect(oldest.editor).toEqual(createComposerEditor('oldest'))
    expect(
      navigateComposerPromptHistory(
        oldest.state,
        'previous',
        oldest.editor ?? draft,
      ).editor,
    ).toEqual(createComposerEditor('oldest'))
    const newer = navigateComposerPromptHistory(
      oldest.state,
      'next',
      oldest.editor ?? draft,
    )
    expect(newer.editor).toEqual(createComposerEditor('middle'))
    const newest = navigateComposerPromptHistory(
      newer.state,
      'next',
      newer.editor ?? draft,
    )
    expect(newest.editor).toEqual(createComposerEditor('newest'))
    const restored = navigateComposerPromptHistory(
      newest.state,
      'next',
      newest.editor ?? draft,
    )
    expect(restored.editor).toEqual(draft)
    expect(restored.state.index).toBeNull()
    expect(
      navigateComposerPromptHistory(state, 'next', draft).editor,
    ).toBeNull()
    expect(
      navigateComposerPromptHistory(
        createComposerPromptHistory(),
        'next',
        draft,
      ).editor,
    ).toBeNull()
  })

  it('restores the exact draft editor after navigating back and forward', () => {
    const state = seedComposerPromptHistory(['older', 'newer'])
    const draft = createComposerEditor('draft', 2)
    const previous = navigateComposerPromptHistory(state, 'previous', draft)
    expect(previous.editor).toEqual(createComposerEditor('newer'))
    if (previous.editor === null) throw new Error('Expected recalled prompt')
    const next = navigateComposerPromptHistory(
      previous.state,
      'next',
      previous.editor,
    )
    expect(next.editor).toEqual(draft)
  })

  it('records adjacent duplicates as one entry and ignores empty prompts', () => {
    const state = seedComposerPromptHistory(['a'])
    expect(recordComposerPrompt(state, 'a').entries).toEqual(['a'])
    expect(recordComposerPrompt(state, '  ')).toBe(state)
  })

  it('resets browsing when recording and retains only the newest bounded entries', () => {
    const browsing = navigateComposerPromptHistory(
      seedComposerPromptHistory(['a', 'b']),
      'previous',
      createComposerEditor('draft'),
    ).state
    const recorded = recordComposerPrompt(browsing, 'b')
    expect(recorded.entries).toEqual(['a', 'b'])
    expect(recorded.index).toBeNull()
    expect(recorded.draft).toBeNull()
    expect(recordComposerPrompt(recorded, 'a').entries).toEqual(['a', 'b', 'a'])
    const prompts = Array.from(
      { length: COMPOSER_PROMPT_HISTORY_LIMIT + 1 },
      (_, i) => `p${i}`,
    )
    const capped = seedComposerPromptHistory(prompts)
    expect(capped.entries).toHaveLength(COMPOSER_PROMPT_HISTORY_LIMIT)
    expect(capped.entries[0]).toBe('p1')
    expect(recordComposerPrompt(capped, 'last').entries[0]).toBe('p2')
  })

  it('explicitly resets navigation while retaining entries', () => {
    const state = navigateComposerPromptHistory(
      seedComposerPromptHistory(['a']),
      'previous',
      createComposerEditor('draft'),
    ).state
    const reset = resetComposerPromptHistoryNavigation(state)
    expect(reset.entries).toEqual(['a'])
    expect(reset.index).toBeNull()
    expect(reset.draft).toBeNull()
  })
})
