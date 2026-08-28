import { describe, expect, it } from 'vitest'

import type { TranscriptPresentationEntry } from './transcript-presentation.js'
import { projectTuiRows } from './tui-row-ir.js'

const entry = (
  key: string,
  item: Extract<TranscriptPresentationEntry, { kind: 'item' }>['item'],
  viewportSlice?: string,
): TranscriptPresentationEntry => ({
  kind: 'item',
  key,
  item,
  ...(viewportSlice === undefined
    ? {}
    : {
        viewportSlice: {
          text: viewportSlice,
          rows: viewportSlice.split('\n').length,
        },
      }),
})

describe('projectTuiRows', () => {
  it('uses stable source-derived keys and preserves multiline empty lines', () => {
    const rows = projectTuiRows({
      entries: [entry('item-4', { kind: 'user', text: 'first\n\nlast' })],
      width: 80,
      mode: 'normal',
    })
    expect(rows.map((row) => row.key)).toEqual([
      'item-4:0',
      'item-4:1',
      'item-4:2',
      'item-4:3',
    ])
    expect(rows[2]?.segments).toEqual([{ text: ' ', role: 'body' }])
    expect(
      rows.every((row) => row.source === 'item-4' && row.height === 1),
    ).toBe(true)
  })

  it('maps semantic item roles and prefers an existing viewport slice', () => {
    const rows = projectTuiRows({
      entries: [
        entry('assistant-1', { kind: 'assistant', text: 'answer' }),
        entry('thinking-1', { kind: 'thinking', text: 'internal' }),
        entry('warning-1', { kind: 'warning', text: 'problem' }),
        entry(
          'slice-1',
          { kind: 'assistant', text: 'source' },
          'visible\n+added\n-removed',
        ),
      ],
      width: 80,
      mode: 'audit',
    })
    expect(rows[1]?.segments[0]?.role).toBe('body')
    expect(rows[3]?.segments[0]?.role).toBe('muted')
    expect(rows[5]?.segments[0]?.role).toBe('warning')
    expect(rows.slice(6).map((row) => row.segments[0])).toEqual([
      { text: 'visible', role: 'body' },
      { text: '+added', role: 'body' },
      { text: '-removed', role: 'body' },
    ])
  })

  it('uses width-aware physical rows and preserves screen-reader prefixes once', () => {
    const rows = projectTuiRows({
      entries: [
        entry('assistant-wide', { kind: 'assistant', text: '界'.repeat(8) }),
      ],
      width: 10,
      mode: 'screen-reader',
    })
    expect(rows.length).toBeGreaterThan(3)
    expect(rows.map((row) => row.segments[0]?.text)).toContain('Praxis:')
    expect(rows.map((row) => row.segments[0]?.text).join('')).not.toContain('⏺')
  })

  it('falls back for unsupported entries while keeping viewport slices authoritative', () => {
    const rows = projectTuiRows({
      entries: [
        entry('slice-2', { kind: 'assistant', text: 'source' }, 'visible'),
        {
          kind: 'item',
          key: 'context-1',
          item: {
            kind: 'context',
            contextWindowTokens: 100,
            usedTokens: 10,
            memoryFiles: [],
            skills: [],
          },
        },
      ],
      width: 10,
      mode: 'normal',
    })
    expect(rows[0]?.segments).toEqual([{ text: 'visible', role: 'body' }])
    expect(rows[1]?.segments[0]?.role).toBe('heading')
  })

  it('assigns semantic operation roles for running, success, and failure', () => {
    const rows = projectTuiRows({
      entries: [
        {
          kind: 'tool',
          key: 'tool-running',
          item: {
            kind: 'tool',
            call: { id: 'running', name: 'Bash', input: { command: 'pwd' } },
            detail: '',
          },
        },
        {
          kind: 'tool',
          key: 'tool-success',
          item: {
            kind: 'tool',
            call: { id: 'success', name: 'Bash', input: { command: 'pwd' } },
            detail: '',
          },
          result: {
            kind: 'tool-result',
            callId: 'success',
            text: 'ok',
            isError: false,
          },
        },
        {
          kind: 'shell',
          key: 'shell-failure',
          item: { kind: 'shell', callId: 'failure', command: 'false' },
          result: {
            kind: 'shell-result',
            callId: 'failure',
            stdout: '',
            stderr: 'failed',
            isError: true,
          },
        },
      ],
      width: 80,
      mode: 'normal',
    })
    expect(rows.map((row) => row.segments[0]?.role)).toEqual([
      'muted',
      'success',
      'error',
      'error',
    ])
  })
})
