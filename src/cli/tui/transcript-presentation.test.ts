import { describe, expect, it } from 'vitest'

import {
  projectTranscriptPresentation,
  type TranscriptItem,
} from './transcript-presentation.js'

describe('projectTranscriptPresentation', () => {
  it('keeps ordinary items and ordered tool/shell pairs and orphans', () => {
    const items: TranscriptItem[] = [
      { kind: 'assistant', text: 'hello' },
      {
        kind: 'tool',
        call: { id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
        detail: '',
      },
      {
        kind: 'tool-result',
        callId: 'tool-1',
        text: '/tmp',
        isError: false,
      },
      { kind: 'shell', callId: 'shell-1', command: 'echo hi' },
      {
        kind: 'shell-result',
        callId: 'missing-shell',
        stdout: 'orphan',
        stderr: '',
        isError: false,
      },
      {
        kind: 'shell-result',
        callId: 'shell-1',
        stdout: 'hi',
        stderr: '',
        isError: false,
      },
    ]

    expect(projectTranscriptPresentation(items, 'normal')).toEqual([
      { kind: 'item', key: 'item-0', item: items[0] },
      {
        kind: 'tool',
        key: 'tool-1-tool-1',
        item: items[1],
        result: items[2],
      },
      {
        kind: 'shell',
        key: 'shell-3-shell-1',
        item: items[3],
        result: items[5],
      },
      {
        kind: 'orphan-shell-result',
        key: 'shell-result-4',
        item: items[4],
      },
    ])
  })

  it('groups only a complete contiguous run of successful Reads in normal mode', () => {
    const read = (id: string, path: string): TranscriptItem => ({
      kind: 'tool',
      call: { id, name: 'Read', input: { file_path: path } },
      detail: '',
    })
    const result = (
      callId: string,
      text: string,
      isError = false,
    ): TranscriptItem => ({
      kind: 'tool-result',
      callId,
      text,
      isError,
    })
    const items: TranscriptItem[] = [
      read('one', '/one'),
      read('two', '/two'),
      result('one', 'one'),
      result('two', 'two'),
      { kind: 'assistant', text: 'break' },
      read('three', '/three'),
      result('three', 'error', true),
      read('four', '/four'),
      { kind: 'assistant', text: 'interleaved' },
      result('four', 'four'),
    ]

    expect(projectTranscriptPresentation(items, 'normal')).toEqual([
      { kind: 'read-summary', key: 'read-summary-0', count: 2 },
      { kind: 'item', key: 'item-4', item: items[4] },
      { kind: 'tool', key: 'tool-5-three', item: items[5], result: items[6] },
      { kind: 'tool', key: 'tool-7-four', item: items[7], result: items[9] },
      { kind: 'item', key: 'item-8', item: items[8] },
    ])
  })

  it('expands successful Reads individually in audit and screen-reader modes', () => {
    const items: TranscriptItem[] = [
      {
        kind: 'tool',
        call: { id: 'read', name: 'Read', input: { file_path: '/one' } },
        detail: '',
      },
      { kind: 'tool-result', callId: 'read', text: 'one', isError: false },
    ]

    for (const mode of ['audit', 'screen-reader'] as const) {
      expect(projectTranscriptPresentation(items, mode)).toEqual([
        { kind: 'tool', key: 'tool-0-read', item: items[0], result: items[1] },
      ])
    }
  })

  it('keeps results before calls and duplicate unmatched results visible', () => {
    const items: TranscriptItem[] = [
      { kind: 'tool-result', callId: 'tool', text: 'before', isError: false },
      {
        kind: 'tool',
        call: { id: 'tool', name: 'Bash', input: { command: 'pwd' } },
        detail: '',
      },
      { kind: 'tool-result', callId: 'tool', text: 'paired', isError: false },
      {
        kind: 'tool-result',
        callId: 'tool',
        text: 'duplicate',
        isError: false,
      },
    ]

    expect(projectTranscriptPresentation(items, 'normal')).toEqual([
      {
        kind: 'orphan-tool-result',
        key: 'tool-result-0',
        item: items[0],
      },
      { kind: 'tool', key: 'tool-1-tool', item: items[1], result: items[2] },
      {
        kind: 'orphan-tool-result',
        key: 'tool-result-3',
        item: items[3],
      },
    ])
  })

  it('keeps keys unique when malformed input repeats call IDs', () => {
    const items: TranscriptItem[] = [
      {
        kind: 'tool',
        call: { id: 'duplicate', name: 'Bash', input: {} },
        detail: '',
      },
      {
        kind: 'tool',
        call: { id: 'duplicate', name: 'Bash', input: {} },
        detail: '',
      },
      { kind: 'shell', callId: 'duplicate', command: 'one' },
      { kind: 'shell', callId: 'duplicate', command: 'two' },
    ]

    const keys = projectTranscriptPresentation(items, 'normal').map(
      (entry) => entry.key,
    )
    expect(keys).toEqual([
      'tool-0-duplicate',
      'tool-1-duplicate',
      'shell-2-duplicate',
      'shell-3-duplicate',
    ])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps call keys globally unique and stable across append-only growth', () => {
    const items: TranscriptItem[] = [
      {
        kind: 'tool',
        call: { id: 'alpha', name: 'Bash', input: {} },
        detail: '',
      },
      {
        kind: 'tool',
        call: { id: 'alpha-duplicate-2', name: 'Bash', input: {} },
        detail: '',
      },
      {
        kind: 'tool',
        call: { id: 'alpha', name: 'Bash', input: {} },
        detail: '',
      },
      {
        kind: 'tool-result',
        callId: 'missing',
        text: 'orphan',
        isError: false,
      },
      {
        kind: 'tool',
        call: { id: 'result-3', name: 'Bash', input: {} },
        detail: '',
      },
    ]

    const initial = projectTranscriptPresentation(items, 'normal')
    const keys = initial.map((entry) => entry.key)
    expect(keys).toEqual([
      'tool-0-alpha',
      'tool-1-alpha-duplicate-2',
      'tool-2-alpha',
      'tool-result-3',
      'tool-4-result-3',
    ])
    expect(new Set(keys).size).toBe(keys.length)

    const appended = projectTranscriptPresentation(
      [...items, { kind: 'assistant', text: 'done' }],
      'normal',
    )
    expect(appended.slice(0, initial.length).map((entry) => entry.key)).toEqual(
      keys,
    )
  })
})
