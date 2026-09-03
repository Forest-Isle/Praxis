import { describe, expect, it } from 'vitest'

import {
  projectTranscriptPresentation,
  type TranscriptItem,
} from './transcript-presentation.js'
import {
  appendTuiHistory,
  projectTranscriptWindow,
} from './transcript-window-model.js'

const backgroundNotification = (
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  text = `Task ${status} · command`,
): TranscriptItem => ({
  kind: status === 'failed' ? 'warning' : 'notice',
  text,
  taskNotification: { taskId, status },
})

describe('projectTranscriptPresentation', () => {
  it('collapses ten contiguous completed background Bash notifications', () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      backgroundNotification(
        `b${index.toString(36).padStart(8, '0')}`,
        'completed',
      ),
    )

    expect(projectTranscriptPresentation(items, 'normal')).toEqual([
      {
        kind: 'item',
        key: 'item-0',
        item: { kind: 'notice', text: '10 background commands completed' },
      },
    ])
  })

  it('keeps every non-completed item as a separator', () => {
    const user = { kind: 'user', text: 'user' } as const
    const assistant = { kind: 'assistant', text: 'assistant' } as const
    const tool: TranscriptItem = {
      kind: 'tool',
      call: { id: 'tool', name: 'Bash', input: {} },
      detail: '',
    }
    const ordinary = { kind: 'notice', text: 'ordinary' } as const
    const nonBash = backgroundNotification('aagent123', 'completed')
    const failed = backgroundNotification('baaaaaaac', 'failed')
    const stopped = backgroundNotification('baaaaaaae', 'stopped')
    const items: TranscriptItem[] = [
      backgroundNotification('baaaaaaaa', 'completed'),
      backgroundNotification('baaaaaaab', 'completed'),
      failed,
      backgroundNotification('baaaaaaad', 'completed'),
      stopped,
      backgroundNotification('baaaaaaaf', 'completed'),
      backgroundNotification('baaaaaaag', 'completed'),
      user,
      backgroundNotification('baaaaaaah', 'completed'),
      assistant,
      backgroundNotification('baaaaaaai', 'completed'),
      tool,
      backgroundNotification('baaaaaaaj', 'completed'),
      ordinary,
      backgroundNotification('baaaaaaak', 'completed'),
      nonBash,
      backgroundNotification('baaaaaaal', 'completed'),
    ]

    expect(projectTranscriptPresentation(items, 'normal')).toEqual([
      {
        kind: 'item',
        key: 'item-0',
        item: { kind: 'notice', text: '2 background commands completed' },
      },
      { kind: 'item', key: 'item-2', item: failed },
      { kind: 'item', key: 'item-3', item: items[3] },
      { kind: 'item', key: 'item-4', item: stopped },
      {
        kind: 'item',
        key: 'item-5',
        item: { kind: 'notice', text: '2 background commands completed' },
      },
      { kind: 'item', key: 'item-7', item: user },
      { kind: 'item', key: 'item-8', item: items[8] },
      { kind: 'item', key: 'item-9', item: assistant },
      { kind: 'item', key: 'item-10', item: items[10] },
      { kind: 'tool', key: 'tool-11-tool', item: tool },
      { kind: 'item', key: 'item-12', item: items[12] },
      { kind: 'item', key: 'item-13', item: ordinary },
      { kind: 'item', key: 'item-14', item: items[14] },
      { kind: 'item', key: 'item-15', item: nonBash },
      { kind: 'item', key: 'item-16', item: items[16] },
    ])
  })

  it('keeps singleton notifications detailed and separates ineligible items', () => {
    const singleton = backgroundNotification('baaaaaaaa', 'failed')
    const ordinary = { kind: 'notice', text: 'ordinary' } as const
    const nonBash = backgroundNotification('aagent123', 'completed')
    const items: TranscriptItem[] = [
      singleton,
      ordinary,
      backgroundNotification('baaaaaaab', 'completed'),
      nonBash,
      backgroundNotification('baaaaaaac', 'completed'),
    ]

    expect(projectTranscriptPresentation(items, 'normal')).toEqual([
      { kind: 'item', key: 'item-0', item: singleton },
      { kind: 'item', key: 'item-1', item: ordinary },
      { kind: 'item', key: 'item-2', item: items[2] },
      { kind: 'item', key: 'item-3', item: nonBash },
      { kind: 'item', key: 'item-4', item: items[4] },
    ])
  })

  it('preserves notification history and metadata in audit modes', () => {
    const items = [
      backgroundNotification('baaaaaaaa', 'completed'),
      backgroundNotification('baaaaaaab', 'failed'),
    ]

    for (const mode of ['audit', 'screen-reader'] as const)
      expect(projectTranscriptPresentation(items, mode)).toEqual([
        { kind: 'item', key: 'item-0', item: items[0] },
        { kind: 'item', key: 'item-1', item: items[1] },
      ])
  })

  it('does not mutate source items while collapsing', () => {
    const items = [
      backgroundNotification('baaaaaaaa', 'completed'),
      backgroundNotification('baaaaaaab', 'completed'),
    ]
    const snapshot = items.map((item) => {
      if (item.kind !== 'notice' && item.kind !== 'warning') return item
      return {
        ...item,
        ...(item.taskNotification
          ? { taskNotification: { ...item.taskNotification } }
          : {}),
      }
    })

    projectTranscriptPresentation(items, 'normal')

    expect(items).toEqual(snapshot)
  })

  it('updates background notifications incrementally', () => {
    const first = backgroundNotification('baaaaaaaa', 'completed')
    const second = backgroundNotification('baaaaaaab', 'completed')
    const initial = [first]
    const initialResult = projectTranscriptWindow({
      history: initial,
      mode: 'normal',
      width: 80,
      pageRows: 20,
      scrollOffset: 0,
      revision: 0,
      bounded: false,
    })
    const appended = appendTuiHistory(1, initial, [second])
    const appendResult = projectTranscriptWindow(
      {
        history: appended.history,
        mode: 'normal',
        width: 80,
        pageRows: 20,
        scrollOffset: 0,
        revision: 1,
        bounded: false,
      },
      initialResult.state,
      appended.change,
    )

    expect(appendResult.transition).toBe('append')
    expect(appendResult.entries).toEqual(
      projectTranscriptPresentation(appended.history, 'normal'),
    )
    expect(appendResult.entries).toEqual([
      {
        kind: 'item',
        key: 'item-0',
        item: { kind: 'notice', text: '2 background commands completed' },
      },
    ])

    const appendedAgain = appendTuiHistory(2, appended.history, [
      backgroundNotification('baaaaaaac', 'completed'),
    ])
    const appendAgainResult = projectTranscriptWindow(
      {
        history: appendedAgain.history,
        mode: 'normal',
        width: 80,
        pageRows: 20,
        scrollOffset: 0,
        revision: 2,
        bounded: false,
      },
      appendResult.state,
      appendedAgain.change,
    )

    expect(appendAgainResult.transition).toBe('append')
    expect(appendAgainResult.entries).toEqual(
      projectTranscriptPresentation(appendedAgain.history, 'normal'),
    )
    expect(appendAgainResult.entries).toEqual([
      {
        kind: 'item',
        key: 'item-0',
        item: { kind: 'notice', text: '3 background commands completed' },
      },
    ])

    const coldRestoredHistory = [first, second]
    const coldRestored = projectTranscriptWindow({
      history: coldRestoredHistory,
      mode: 'normal',
      width: 80,
      pageRows: 20,
      scrollOffset: 0,
      revision: 2,
      bounded: false,
    })
    const coldRestoredAppend = appendTuiHistory(3, coldRestoredHistory, [
      backgroundNotification('baaaaaaac', 'completed'),
    ])
    const coldRestoredAppendResult = projectTranscriptWindow(
      {
        history: coldRestoredAppend.history,
        mode: 'normal',
        width: 80,
        pageRows: 20,
        scrollOffset: 0,
        revision: 3,
        bounded: false,
      },
      coldRestored.state,
      coldRestoredAppend.change,
    )

    expect(coldRestoredAppendResult.transition).toBe('append')
    expect(coldRestoredAppendResult.entries).toEqual(
      projectTranscriptPresentation(coldRestoredAppend.history, 'normal'),
    )
    expect(coldRestoredAppendResult.entries).toEqual([
      {
        kind: 'item',
        key: 'item-0',
        item: { kind: 'notice', text: '3 background commands completed' },
      },
    ])

    const separator = backgroundNotification('baaaaaaad', 'failed')
    const newRun = appendTuiHistory(4, coldRestoredAppend.history, [
      separator,
      backgroundNotification('baaaaaaae', 'completed'),
      backgroundNotification('baaaaaaaf', 'completed'),
    ])
    const newRunResult = projectTranscriptWindow(
      {
        history: newRun.history,
        mode: 'normal',
        width: 80,
        pageRows: 20,
        scrollOffset: 0,
        revision: 4,
        bounded: false,
      },
      coldRestoredAppendResult.state,
      newRun.change,
    )

    expect(newRunResult.transition).toBe('append')
    expect(newRunResult.entries).toEqual(
      projectTranscriptPresentation(newRun.history, 'normal'),
    )
    expect(newRunResult.entries).toEqual([
      {
        kind: 'item',
        key: 'item-0',
        item: { kind: 'notice', text: '3 background commands completed' },
      },
      { kind: 'item', key: 'item-3', item: separator },
      {
        kind: 'item',
        key: 'item-4',
        item: { kind: 'notice', text: '2 background commands completed' },
      },
    ])
  })

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
