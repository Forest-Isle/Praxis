import { describe, expect, it } from 'vitest'

import {
  autoUpdateTarget,
  copyCandidates,
  externalEditorInitialContent,
  formatTurnDuration,
  questionTimeoutMilliseconds,
  sessionRecap,
  spinnerTip,
  shouldShowCopyPicker,
  workflowRuntimeInstructions,
} from './runtime-interactions.js'

describe('runtime setting interaction projections', () => {
  it('projects timeout, duration, update channel, and disabled tips', () => {
    expect(questionTimeoutMilliseconds('60s')).toBe(60_000)
    expect(questionTimeoutMilliseconds('never')).toBeUndefined()
    expect(formatTurnDuration(65_000)).toBe('1m 5s')
    expect(autoUpdateTarget('stable')).toBe('stable')
    expect(spinnerTip({ tips: false })).toBeUndefined()
  })

  it('projects workflow policy', () => {
    expect(
      workflowRuntimeInstructions({
        workflows: true,
        workflowKeywordTriggerEnabled: false,
        workflowSizeGuideline: 'small',
      }),
    ).toContain('Do not infer')
  })

  it('adds the optional last response context to external-editor input and recaps sessions', () => {
    const history = [
      { kind: 'user', text: 'question' },
      { kind: 'assistant', text: 'answer' },
    ] as const
    expect(externalEditorInitialContent('next', history, true)).toContain(
      'answer',
    )
    expect(sessionRecap(history)).toContain('Last request: question')
  })

  it('extracts source-compatible /copy picker candidates', () => {
    const response = 'Use this:\n```../../tsx\nconst value = 1\n```'
    expect(shouldShowCopyPicker(response)).toBe(true)
    expect(copyCandidates(response)).toEqual([
      expect.objectContaining({
        kind: 'full',
        label: 'Full response',
        text: response,
        filename: 'response.md',
      }),
      expect.objectContaining({
        kind: 'code',
        label: 'const value = 1',
        text: 'const value = 1',
        filename: 'copy.tsx',
      }),
      expect.objectContaining({
        kind: 'always',
        label: 'Always copy full response',
      }),
    ])
    expect(shouldShowCopyPicker('plain response')).toBe(false)
  })
})
