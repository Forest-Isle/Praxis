import { describe, expect, it } from 'vitest'

import {
  estimateTranscriptEntryLines,
  FULLSCREEN_TRANSCRIPT_RESERVED_ROWS,
} from './transcript-viewport.js'
import {
  projectTranscriptPresentation,
  type TranscriptItem,
} from './transcript-presentation.js'
import { createTuiAppendHistoryChange } from './transcript-window-model.js'
import {
  appendTuiHistory,
  createTuiHistoryChange,
  projectTuiView,
  resolveTuiRenderer,
} from './tui-view-model.js'

const user = (text: string): TranscriptItem => ({ kind: 'user', text })
const assistant = (text: string): TranscriptItem => ({
  kind: 'assistant',
  text,
})
const notice = (text: string): TranscriptItem => ({ kind: 'notice', text })
const tool = (id: string, name = 'Glob'): TranscriptItem => ({
  kind: 'tool',
  call: { id, name, input: name === 'Read' ? { file_path: `/${id}` } : {} },
  detail: `${name} ${id}`,
})
const toolResult = (id: string, isError = false): TranscriptItem => ({
  kind: 'tool-result',
  callId: id,
  text: `${id} result`,
  isError,
})
const shell = (id: string): TranscriptItem => ({
  kind: 'shell',
  callId: id,
  command: `echo ${id}`,
})
const shellResult = (id: string): TranscriptItem => ({
  kind: 'shell-result',
  callId: id,
  stdout: `${id}\n`,
  stderr: '',
  isError: false,
})
const appendChange = (
  revision: number,
  previous: readonly TranscriptItem[],
  history: readonly TranscriptItem[],
) => createTuiAppendHistoryChange(revision, previous, history)

describe('projectTuiView', () => {
  const base = {
    fixedViewport: false,
    screenReader: false,
    rows: undefined,
    width: 80,
    scrollOffset: 0,
    detailedTranscript: false,
  }

  it('keeps an empty session fresh with the input history untouched', () => {
    const history = [notice('Using flicker-free rendering')]
    const view = projectTuiView({
      ...base,
      initialHistory: history,
      history,
      resume: false,
    })
    expect(view.freshSession).toBe(true)
    expect(view.resumed).toBe(false)
    expect(view.hasConversationHistory).toBe(false)
    expect(view.transcriptEntries).toHaveLength(1)
  })

  it('classifies a resumed session only when resume is set and real content exists', () => {
    const initialHistory = [user('continue the work'), assistant('ok')]
    const view = projectTuiView({
      ...base,
      initialHistory,
      history: initialHistory,
      resume: true,
    })
    expect(view.resumed).toBe(true)
    expect(view.freshSession).toBe(false)
    expect(view.hasConversationHistory).toBe(true)

    // Supplying a session id with an empty transcript stays fresh.
    const emptyView = projectTuiView({
      ...base,
      initialHistory: [],
      history: [],
      resume: true,
    })
    expect(emptyView.resumed).toBe(false)
    expect(emptyView.freshSession).toBe(true)
  })

  it('classifies a started conversation as not fresh and not resumed', () => {
    const history = [user('review the diff'), assistant('done')]
    const view = projectTuiView({
      ...base,
      initialHistory: [],
      history,
      resume: false,
    })
    expect(view.resumed).toBe(false)
    expect(view.freshSession).toBe(false)
    expect(view.hasConversationHistory).toBe(true)
  })

  it('preserves transcript identity and order in classic and screen-reader projections', () => {
    const history = [user('a'), assistant('b'), user('c')]
    const classic = projectTuiView({
      ...base,
      initialHistory: history,
      history,
      resume: true,
    })
    expect(classic.transcriptEntries).toHaveLength(3)

    const screenReader = projectTuiView({
      ...base,
      fixedViewport: true,
      screenReader: true,
      rows: 24,
      initialHistory: history,
      history,
      resume: true,
    })
    expect(screenReader.transcriptEntries).toHaveLength(3)
  })

  it('projects the newest transcript tail in fullscreen while preserving kept item order', () => {
    const history = Array.from({ length: 30 }, (_, index) => [
      user(`prompt ${index + 1}`),
      assistant(`reply ${index + 1}`),
    ]).flat()
    const view = projectTuiView({
      ...base,
      fixedViewport: true,
      rows: 24,
      initialHistory: history,
      history,
      resume: true,
    })
    expect(view.transcriptEntries.length).toBeGreaterThan(0)
    expect(view.transcriptEntries.at(-1)?.key).toBe('item-59')
    expect(view.transcriptEntries.map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['item-59']),
    )
  })

  it('projects complete presentation entries before the fullscreen viewport', () => {
    const history: TranscriptItem[] = [
      user('before'),
      {
        kind: 'tool',
        call: { id: 'call-1', name: 'Bash', input: { command: 'pwd' } },
        detail: '',
      },
      { kind: 'tool-result', callId: 'call-1', text: '/tmp', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-1', name: 'Read', input: { file_path: '/a' } },
        detail: '',
      },
      { kind: 'tool-result', callId: 'read-1', text: 'a', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-2', name: 'Read', input: { file_path: '/b' } },
        detail: '',
      },
      { kind: 'tool-result', callId: 'read-2', text: 'b', isError: false },
    ]
    const view = projectTuiView({
      ...base,
      fixedViewport: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 1,
      initialHistory: history,
      history,
      resume: true,
    })
    const full = projectTranscriptPresentation(history, 'normal')
    expect(view.transcriptEntries).toEqual([full.at(-1)])
    expect(full.map((entry) => entry.key)).toEqual(
      projectTranscriptPresentation(history, 'normal').map(
        (entry) => entry.key,
      ),
    )
    expect(
      view.transcriptEntries.every(
        (entry) => entry.kind !== 'orphan-tool-result',
      ),
    ).toBe(true)
  })

  it('retains a finalized assistant marker at the minimum fullscreen height', () => {
    const marker = 'BACKGROUND_CONTEXT_READY'
    const history: TranscriptItem[] = [assistant(marker)]
    const view = projectTuiView({
      ...base,
      fixedViewport: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS,
      width: 32,
      initialHistory: [],
      history,
      resume: false,
    })

    expect(view.transcriptPageRows).toBe(2)
    expect(view.maxTranscriptScrollOffset).toBe(0)
    expect(view.transcriptEntries).toHaveLength(1)
    expect(view.transcriptEntries[0]).toMatchObject({
      kind: 'item',
      key: 'item-0',
      item: { kind: 'assistant', text: marker },
    })
    expect(
      view.transcriptEntries[0]?.kind === 'item' &&
        view.transcriptEntries[0].item,
    ).toBe(history[0])
    expect(history).toEqual([assistant(marker)])
  })

  it('keeps screen-reader history complete and ungrouped outside the viewport', () => {
    const history: readonly TranscriptItem[] = [
      user('inspect both files'),
      {
        kind: 'tool',
        call: { id: 'read-a', name: 'Read', input: { file_path: '/a' } },
        detail: 'Read /a',
      },
      { kind: 'tool-result', callId: 'read-a', text: 'a', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-b', name: 'Read', input: { file_path: '/b' } },
        detail: 'Read /b',
      },
      { kind: 'tool-result', callId: 'read-b', text: 'b', isError: false },
      assistant('done'),
    ]

    const view = projectTuiView({
      ...base,
      fixedViewport: true,
      screenReader: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 1,
      initialHistory: history,
      history,
      resume: true,
    })

    expect(view.transcriptEntries).toEqual(
      projectTranscriptPresentation(history, 'screen-reader'),
    )
    expect(view.transcriptEntries.map((entry) => entry.kind)).toEqual([
      'item',
      'tool',
      'tool',
      'item',
    ])
    expect(view.transcriptEntries).not.toContainEqual(
      expect.objectContaining({ kind: 'read-summary' }),
    )
  })

  it('preserves the classic and screen-reader scroll extent contract', () => {
    const history: readonly TranscriptItem[] = [
      assistant(
        Array.from({ length: 20 }, (_, index) => `row-${index}`).join('\n'),
      ),
    ]
    const rows = FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 4
    for (const screenReader of [false, true]) {
      const mode = screenReader ? 'screen-reader' : 'normal'
      const view = projectTuiView({
        ...base,
        fixedViewport: false,
        screenReader,
        rows,
        initialHistory: history,
        history,
        resume: false,
      })
      const entry = projectTranscriptPresentation(history, mode)[0]
      if (!entry) throw new Error('expected a transcript entry')
      expect(view.maxTranscriptScrollOffset).toBe(
        estimateTranscriptEntryLines(entry, 80, mode) - 4,
      )
      expect(view.transcriptEntries).toEqual(
        projectTranscriptPresentation(history, mode),
      )
    }
  })

  it('keeps classic order while switching normal summaries to audit details', () => {
    const history: readonly TranscriptItem[] = [
      user('inspect'),
      {
        kind: 'tool',
        call: { id: 'read-a', name: 'Read', input: { file_path: '/a' } },
        detail: 'Read /a',
      },
      { kind: 'tool-result', callId: 'read-a', text: 'a', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-b', name: 'Read', input: { file_path: '/b' } },
        detail: 'Read /b',
      },
      { kind: 'tool-result', callId: 'read-b', text: 'b', isError: false },
      assistant('done'),
    ]
    const normal = projectTuiView({
      ...base,
      initialHistory: history,
      history,
      resume: true,
    })
    const audit = projectTuiView({
      ...base,
      detailedTranscript: true,
      initialHistory: history,
      history,
      resume: true,
    })

    expect(normal.transcriptEntries.map((entry) => entry.kind)).toEqual([
      'item',
      'read-summary',
      'item',
    ])
    expect(audit.transcriptEntries.map((entry) => entry.kind)).toEqual([
      'item',
      'tool',
      'tool',
      'item',
    ])
    expect(normal.transcriptEntries.map((entry) => entry.key)).toEqual([
      'item-0',
      'read-summary-1',
      'item-5',
    ])
    expect(audit.transcriptEntries.map((entry) => entry.key)).toEqual([
      'item-0',
      'tool-1-read-a',
      'tool-3-read-b',
      'item-5',
    ])
  })

  it('keeps retained entry keys stable across append, resize, and window movement', () => {
    const history: readonly TranscriptItem[] = Array.from(
      { length: 10 },
      (_, index) => user(`prompt-${index}`),
    )
    const project = (
      currentHistory: readonly TranscriptItem[],
      rows: number,
      width: number,
      scrollOffset: number,
    ) =>
      projectTuiView({
        ...base,
        fixedViewport: true,
        rows,
        width,
        scrollOffset,
        initialHistory: history,
        history: currentHistory,
        resume: true,
      }).transcriptEntries

    const initial = project(
      history,
      FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 8,
      80,
      0,
    )
    const appended = project(
      [...history, assistant('appended')],
      FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 8,
      80,
      0,
    )
    const resized = project(
      history,
      FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 6,
      40,
      0,
    )
    const moved = project(
      history,
      FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 8,
      80,
      2,
    )
    expect(initial.map((entry) => entry.key)).toEqual([
      'item-6',
      'item-7',
      'item-8',
      'item-9',
    ])
    expect(appended.map((entry) => entry.key)).toEqual([
      'item-7',
      'item-8',
      'item-9',
      'item-10',
    ])
    expect(resized.map((entry) => entry.key)).toEqual([
      'item-7',
      'item-8',
      'item-9',
    ])
    expect(moved.map((entry) => entry.key)).toEqual([
      'item-5',
      'item-6',
      'item-7',
      'item-8',
    ])
  })

  it('retains unchanged entry references across a valid append revision', () => {
    const initial: readonly TranscriptItem[] = [
      user('keep this row'),
      assistant('unchanged response'),
    ]
    const first = projectTuiView({
      ...base,
      initialHistory: initial,
      history: initial,
      resume: true,
      historyChange: { revision: 0, changedFrom: 0 },
    })
    const nextHistory = [...initial, assistant('new response')]
    const next = projectTuiView(
      {
        ...base,
        initialHistory: initial,
        history: nextHistory,
        resume: true,
        historyChange: appendChange(1, initial, nextHistory),
      },
      first,
    )
    expect(next.transcriptEntries).toHaveLength(3)
    expect(next.transcriptEntries[0]).toBe(first.transcriptEntries[0])
    expect(next.transcriptEntries[1]).toBe(first.transcriptEntries[1])
    expect(next.transcriptEntries[2]?.key).toBe('item-2')
  })

  it('falls back to the exact cold projection for stale or invalid revision facts', () => {
    const initial: readonly TranscriptItem[] = [
      user('keep'),
      assistant('old response'),
    ]
    const stableUser = initial[0] ?? user('keep')
    const first = projectTuiView({
      ...base,
      initialHistory: initial,
      history: initial,
      resume: true,
      historyChange: { revision: 0, changedFrom: 0 },
    })
    const cases = [
      {
        history: [stableUser, assistant('same revision replacement')],
        historyChange: { revision: 0, changedFrom: 1 },
      },
      {
        history: [...initial, assistant('skipped revision append')],
        historyChange: { revision: 2, changedFrom: initial.length },
      },
      {
        history: [...initial, assistant('NaN revision append')],
        historyChange: { revision: Number.NaN, changedFrom: initial.length },
      },
      {
        history: initial.slice(0, 1),
        historyChange: { revision: 1, changedFrom: -1 },
      },
      {
        history: [assistant('out of range replacement')],
        historyChange: { revision: 1, changedFrom: 99 },
      },
    ] satisfies readonly {
      history: readonly TranscriptItem[]
      historyChange: { revision: number; changedFrom: number }
    }[]

    for (const testCase of cases) {
      const input = {
        ...base,
        initialHistory: initial,
        history: testCase.history,
        resume: true,
        historyChange: testCase.historyChange,
      }
      expect(projectTuiView(input, first)).toEqual(projectTuiView(input))
    }

    const replacement = cases[0]?.history
    const replaced = replacement
      ? projectTuiView(
          {
            ...base,
            initialHistory: initial,
            history: replacement,
            resume: true,
            historyChange: { revision: 0, changedFrom: 1 },
          },
          first,
        )
      : undefined
    expect(
      replaced?.transcriptEntries[1]?.kind === 'item' &&
        replaced.transcriptEntries[1].item.kind === 'assistant'
        ? replaced.transcriptEntries[1].item.text
        : '',
    ).toBe('same revision replacement')
  })

  it('cold-projects missing or unverified append provenance exactly', () => {
    const stableTail = assistant('stable tail')
    const initial: readonly TranscriptItem[] = [user('old prefix'), stableTail]
    const first = projectTuiView({
      ...base,
      initialHistory: initial,
      history: initial,
      resume: true,
      historyChange: { revision: 0, changedFrom: 0 },
    })
    const inconsistent = [
      user('replacement prefix'),
      stableTail,
      assistant('appended tail'),
    ]
    const unverifiedInput = {
      ...base,
      initialHistory: initial,
      history: inconsistent,
      resume: true,
      historyChange: { revision: 1, changedFrom: initial.length },
    }
    const missingInput = {
      ...base,
      initialHistory: initial,
      history: inconsistent,
      resume: true,
    }
    const inconsistentBrandedInput = {
      ...unverifiedInput,
      historyChange: createTuiHistoryChange(
        1,
        initial.length,
        inconsistent,
        initial,
      ),
    }

    expect(projectTuiView(unverifiedInput, first)).toEqual(
      projectTuiView(unverifiedInput),
    )
    expect(projectTuiView(inconsistentBrandedInput, first)).toEqual(
      projectTuiView(inconsistentBrandedInput),
    )
    expect(projectTuiView(missingInput, first)).toEqual(
      projectTuiView(missingInput),
    )
    const replacement = projectTuiView(unverifiedInput, first)
      .transcriptEntries[0]
    expect(
      replacement?.kind === 'item' && replacement.item.kind === 'user'
        ? replacement.item.text
        : '',
    ).toBe('replacement prefix')

    const appended = appendTuiHistory(1, initial, [
      assistant('verified append'),
    ])
    const incremental = projectTuiView(
      {
        ...base,
        initialHistory: initial,
        history: appended.history,
        resume: true,
        historyChange: appended.change,
      },
      first,
    )
    expect(incremental).toEqual(
      projectTuiView({
        ...base,
        initialHistory: initial,
        history: appended.history,
        resume: true,
        historyChange: appended.change,
      }),
    )
    expect(incremental.transcriptEntries[0]).toBe(first.transcriptEntries[0])
  })

  it('keeps valid filter and in-place patch revisions cold-equivalent', () => {
    const initial: readonly TranscriptItem[] = [
      user('keep-0'),
      notice('remove'),
      assistant('patch-old'),
      notice('keep-3'),
    ]
    const first = projectTuiView({
      ...base,
      initialHistory: initial,
      history: initial,
      resume: true,
      historyChange: { revision: 0, changedFrom: 0 },
    })
    const filtered = initial.filter((_, index) => index !== 1)
    const filterInput = {
      ...base,
      initialHistory: initial,
      history: filtered,
      resume: true,
      historyChange: createTuiHistoryChange(1, 1, filtered, initial),
    }
    const filteredView = projectTuiView(filterInput, first)
    expect(filteredView).toEqual(projectTuiView(filterInput))

    const patched = [...filtered]
    patched[1] = assistant('patch-new')
    const patchInput = {
      ...base,
      initialHistory: initial,
      history: patched,
      resume: true,
      historyChange: createTuiHistoryChange(2, 1, patched, filtered),
    }
    const patchedView = projectTuiView(patchInput, filteredView)
    expect(patchedView).toEqual(projectTuiView(patchInput))
    expect(
      patchedView.transcriptEntries[1]?.kind === 'item' &&
        patchedView.transcriptEntries[1].item.kind === 'assistant'
        ? patchedView.transcriptEntries[1].item.text
        : '',
    ).toBe('patch-new')
  })

  it('keeps every incremental pairing and Read transition cold-equivalent', () => {
    const scenarios: readonly (readonly TranscriptItem[])[] = [
      [tool('a', 'Read'), toolResult('a'), tool('b', 'Read'), toolResult('b')],
      [tool('a', 'Read'), tool('b', 'Read'), toolResult('a'), toolResult('b')],
      [
        tool('a', 'Read'),
        toolResult('a', true),
        tool('b', 'Read'),
        toolResult('b'),
      ],
      [tool('a', 'Read'), notice('interleaved'), toolResult('a')],
      [
        tool('duplicate'),
        tool('duplicate'),
        toolResult('duplicate'),
        toolResult('duplicate'),
      ],
      [
        shell('duplicate'),
        shell('duplicate'),
        shellResult('duplicate'),
        shellResult('duplicate'),
      ],
      [toolResult('orphan'), shellResult('orphan')],
    ]

    for (const scenario of scenarios) {
      let history: readonly TranscriptItem[] = []
      let previous = projectTuiView({
        ...base,
        initialHistory: [],
        history,
        resume: false,
        historyChange: { revision: 0, changedFrom: 0 },
      })
      for (let index = 0; index < scenario.length; index += 1) {
        const previousHistory = history
        const changedFrom = history.length
        const item = scenario[index]
        if (!item) throw new Error('expected incremental scenario item')
        history = [...history, item]
        const input = {
          ...base,
          initialHistory: [],
          history,
          resume: false,
          historyChange: createTuiHistoryChange(
            index + 1,
            changedFrom,
            history,
            previousHistory,
          ),
        }
        const incremental = projectTuiView(input, previous)
        expect(incremental).toEqual(projectTuiView(input))
        previous = incremental
      }
    }

    for (const mode of [
      { detailedTranscript: true, screenReader: false },
      { detailedTranscript: false, screenReader: true },
    ]) {
      let history: readonly TranscriptItem[] = []
      let previous = projectTuiView({
        ...base,
        ...mode,
        initialHistory: [],
        history,
        resume: false,
        historyChange: { revision: 0, changedFrom: 0 },
      })
      for (const [index, item] of [
        tool('mode-read', 'Read'),
        toolResult('mode-read'),
        assistant('mode tail'),
      ].entries()) {
        const previousHistory = history
        const changedFrom = history.length
        history = [...history, item]
        const input = {
          ...base,
          ...mode,
          initialHistory: [],
          history,
          resume: false,
          historyChange: createTuiHistoryChange(
            index + 1,
            changedFrom,
            history,
            previousHistory,
          ),
        }
        const incremental = projectTuiView(input, previous)
        expect(incremental).toEqual(projectTuiView(input))
        previous = incremental
      }
    }

    const readHistory = [tool('many', 'Read'), toolResult('many')]
    const empty = projectTuiView({
      ...base,
      initialHistory: [],
      history: [],
      resume: false,
      historyChange: { revision: 0, changedFrom: 0 },
    })
    const appendedTogether = projectTuiView(
      {
        ...base,
        initialHistory: [],
        history: readHistory,
        resume: false,
        historyChange: appendChange(1, [], readHistory),
      },
      empty,
    )
    expect(appendedTogether).toEqual(
      projectTuiView({
        ...base,
        initialHistory: [],
        history: readHistory,
        resume: false,
        historyChange: { revision: 1, changedFrom: 0 },
      }),
    )
    expect(appendedTogether.transcriptEntries).toMatchObject([
      { kind: 'read-summary', key: 'read-summary-0', count: 1 },
    ])
  })

  it('replaces only the paired row when a retained result arrives', () => {
    const initialHistory: readonly TranscriptItem[] = [
      notice('stable prefix'),
      tool('tool-call'),
      shell('shell-call'),
    ]
    const first = projectTuiView({
      ...base,
      initialHistory,
      history: initialHistory,
      resume: false,
      historyChange: { revision: 0, changedFrom: 0 },
    })
    const withToolResult = [...initialHistory, toolResult('tool-call')]
    const second = projectTuiView(
      {
        ...base,
        initialHistory,
        history: withToolResult,
        resume: false,
        historyChange: appendChange(1, initialHistory, withToolResult),
      },
      first,
    )
    expect(second.transcriptEntries[0]).toBe(first.transcriptEntries[0])
    expect(second.transcriptEntries[1]).not.toBe(first.transcriptEntries[1])
    expect(second.transcriptEntries[2]).toBe(first.transcriptEntries[2])

    const withShellResult = [...withToolResult, shellResult('shell-call')]
    const third = projectTuiView(
      {
        ...base,
        initialHistory,
        history: withShellResult,
        resume: false,
        historyChange: appendChange(2, withToolResult, withShellResult),
      },
      second,
    )
    expect(third.transcriptEntries[0]).toBe(second.transcriptEntries[0])
    expect(third.transcriptEntries[1]).toBe(second.transcriptEntries[1])
    expect(third.transcriptEntries[2]).not.toBe(second.transcriptEntries[2])
    expect(third).toEqual(
      projectTuiView({
        ...base,
        initialHistory,
        history: withShellResult,
        resume: false,
        historyChange: {
          revision: 2,
          changedFrom: withToolResult.length,
        },
      }),
    )
  })

  it('retains semantic entry identity through resize, mode, and classification changes', () => {
    const history: readonly TranscriptItem[] = [
      user('stable'),
      tool('read', 'Read'),
      toolResult('read'),
      assistant('done'),
    ]
    const first = projectTuiView({
      ...base,
      initialHistory: history,
      history,
      resume: true,
      historyChange: { revision: 0, changedFrom: 0 },
    })
    const resizedInput = {
      ...base,
      width: 40,
      initialHistory: history,
      history,
      resume: true,
      historyChange: { revision: 0, changedFrom: 0 },
    }
    const resized = projectTuiView(resizedInput, first)
    expect(resized).toEqual(projectTuiView(resizedInput))
    expect(resized.transcriptEntries[0]).toBe(first.transcriptEntries[0])

    const auditInput = {
      ...resizedInput,
      detailedTranscript: true,
      initialHistory: [],
      resume: false,
    }
    const audit = projectTuiView(auditInput, resized)
    expect(audit).toEqual(projectTuiView(auditInput))
    expect(audit.resumed).toBe(false)
    expect(audit.hasConversationHistory).toBe(true)
    expect(audit.transcriptEntries[0]).toBe(resized.transcriptEntries[0])
  })

  it('does not read a retained 120k hidden prefix during append or scroll', () => {
    const initialHistory: readonly TranscriptItem[] = []
    const prefix: readonly TranscriptItem[] = Array.from(
      { length: 120_000 },
      (_, index) => notice(`diagnostic-${index}`),
    )
    const first = projectTuiView({
      ...base,
      fixedViewport: true,
      rows: 24,
      initialHistory,
      history: prefix,
      resume: false,
      historyChange: { revision: 0, changedFrom: 0 },
    })
    const target = [...prefix, assistant('new conversation row')]
    const guarded = new Proxy(target, {
      get(source, property, receiver) {
        if (/^\d+$/u.test(String(property))) {
          const index = Number(property)
          if (index < prefix.length - 1)
            throw new Error(`hidden prefix index ${index} was read`)
        }
        return Reflect.get(source, property, receiver)
      },
    })
    const appendInput = {
      ...base,
      fixedViewport: true,
      rows: 24,
      initialHistory,
      history: guarded,
      resume: false,
      historyChange: appendChange(1, prefix, guarded),
    }
    const appended = projectTuiView(appendInput, first)
    expect(appended.hasConversationHistory).toBe(true)
    expect(
      appended.transcriptEntries.some(
        (entry) =>
          entry.kind === 'item' &&
          entry.item.kind === 'assistant' &&
          entry.item.text === 'new conversation row',
      ),
    ).toBe(true)
    expect(
      projectTuiView({ ...appendInput, scrollOffset: 1 }, appended)
        .transcriptEntries.length,
    ).toBeGreaterThan(0)
  })

  it('does not rebuild an oversized entry row index while scrolling', () => {
    const text = Array.from(
      { length: 500 },
      (_, index) => `row-${index} alpha beta gamma`,
    ).join('\n')
    let textReads = 0
    const history: readonly TranscriptItem[] = [
      {
        kind: 'assistant',
        get text() {
          textReads += 1
          return text
        },
      },
    ]
    const historyChange = createTuiHistoryChange(0, 0, history)
    const input = {
      ...base,
      fixedViewport: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 5,
      initialHistory: history,
      history,
      resume: false,
      historyChange,
    }
    const newest = projectTuiView(input)
    const readsAfterColdProjection = textReads
    const older = projectTuiView({ ...input, scrollOffset: 100 }, newest)

    expect(older.transcriptEntries).toHaveLength(1)
    expect(textReads).toBe(readsAfterColdProjection)
  })

  it('keeps both partial boundaries visible in a scrolled mixed window', () => {
    const history: readonly TranscriptItem[] = [
      assistant('first-0\nfirst-1\nfirst-2'),
      assistant('second-0\nsecond-1\nsecond-2'),
    ]
    const view = projectTuiView({
      ...base,
      fixedViewport: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 5,
      initialHistory: history,
      history,
      resume: false,
      scrollOffset: 1,
    })

    expect(view.transcriptEntries.map((entry) => entry.key)).toEqual([
      'item-0',
      'item-1',
    ])
    expect(
      view.transcriptEntries.reduce(
        (rows, entry) =>
          rows + estimateTranscriptEntryLines(entry, 80, 'normal'),
        0,
      ),
    ).toBeLessThanOrEqual(5)
  })

  it('reaches the beginning and end of an oversized entry through scrolling', () => {
    const history: readonly TranscriptItem[] = [
      assistant(
        Array.from({ length: 40 }, (_, index) => `row-${index}`).join('\n'),
      ),
    ]
    const input = {
      ...base,
      fixedViewport: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 4,
      initialHistory: history,
      history,
      resume: false,
      historyChange: { revision: 0, changedFrom: 0 },
    }
    const newest = projectTuiView(input)
    const oldest = projectTuiView(
      { ...input, scrollOffset: newest.maxTranscriptScrollOffset },
      newest,
    )
    const middle = projectTuiView({ ...input, scrollOffset: 10 }, newest)
    const repeatedMiddle = projectTuiView(
      { ...input, scrollOffset: 10 },
      middle,
    )
    const newestText = newest.transcriptEntries[0]
    const oldestText = oldest.transcriptEntries[0]
    expect(newestText?.kind).toBe('item')
    expect(oldestText?.kind).toBe('item')
    if (
      newestText?.kind === 'item' &&
      newestText.item.kind === 'assistant' &&
      oldestText?.kind === 'item' &&
      oldestText.item.kind === 'assistant'
    ) {
      expect(newestText.item.text).toContain('row-39')
      expect(oldestText.item.text).toContain('row-0')
      expect(
        middle.transcriptEntries[0]?.kind === 'item' &&
          middle.transcriptEntries[0].item.kind === 'assistant'
          ? middle.transcriptEntries[0].item.text
          : '',
      ).toContain('row-28')
    }
    expect(repeatedMiddle.transcriptEntries[0]).toBe(
      middle.transcriptEntries[0],
    )
  })

  it('retains a partial leading oversized entry before complete following rows', () => {
    const history: readonly TranscriptItem[] = [
      assistant(
        Array.from({ length: 10 }, (_, index) => `leading-${index}`).join('\n'),
      ),
      user('middle user'),
      user('newest user'),
    ]
    const input = {
      ...base,
      fixedViewport: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 5,
      initialHistory: history,
      history,
      resume: false,
      scrollOffset: 2,
      historyChange: { revision: 0, changedFrom: 0 },
    }
    const view = projectTuiView(input)

    expect(view.transcriptEntries.map((entry) => entry.key)).toEqual([
      'item-0',
      'item-1',
    ])
    expect(view.transcriptEntries[0]?.viewportSlice?.text).toContain('leading-')
    expect(
      view.transcriptEntries.reduce(
        (rows, entry) =>
          rows + estimateTranscriptEntryLines(entry, input.width, 'normal'),
        0,
      ),
    ).toBe(5)
  })

  it('reaches every oversized content row for every renderer entry shape', () => {
    const content = Array.from(
      { length: 40 },
      (_, index) => `row-${index}`,
    ).join('\n')
    const cases: readonly (readonly TranscriptItem[])[] = [
      [assistant(content)],
      [user(content)],
      [{ kind: 'thinking', text: content }],
      [{ kind: 'compact', summary: content }],
      [tool('oversized'), toolResult('oversized')].map((item) =>
        item.kind === 'tool-result' ? { ...item, text: content } : item,
      ),
      [
        shell('oversized'),
        {
          kind: 'shell-result',
          callId: 'oversized',
          stdout: content,
          stderr: '',
          isError: false,
        },
      ],
      [
        {
          kind: 'tool-result',
          callId: 'orphan-tool',
          text: content,
          isError: false,
        },
      ],
      [
        {
          kind: 'shell-result',
          callId: 'orphan-shell',
          stdout: content,
          stderr: '',
          isError: false,
        },
      ],
    ]

    for (const history of cases) {
      const source = JSON.stringify(history)
      const input = {
        ...base,
        fixedViewport: true,
        detailedTranscript: true,
        rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 4,
        initialHistory: history,
        history,
        resume: false,
        historyChange: { revision: 0, changedFrom: 0 },
      }
      const first = projectTuiView(input)
      const seen = new Set<number>()
      for (
        let scrollOffset = 0;
        scrollOffset <= first.maxTranscriptScrollOffset;
        scrollOffset += 1
      ) {
        const selected = projectTuiView({ ...input, scrollOffset }, first)
        for (const match of JSON.stringify(selected.transcriptEntries).matchAll(
          /row-(\d+)/gu,
        ))
          seen.add(Number(match[1]))
      }
      expect([...seen].sort((left, right) => left - right)).toEqual(
        Array.from({ length: 40 }, (_, index) => index),
      )
      expect(JSON.stringify(history)).toBe(source)
    }
  })

  it('reaches every visual row of one hard-wrapped assistant line', () => {
    const markers = Array.from(
      { length: 32 },
      (_, index) => `r${String(index).padStart(7, '0')}`,
    )
    const history: readonly TranscriptItem[] = [assistant(markers.join(''))]
    const input = {
      ...base,
      fixedViewport: true,
      rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 4,
      width: 12,
      initialHistory: history,
      history,
      resume: false,
      historyChange: { revision: 0, changedFrom: 0 },
    }
    const first = projectTuiView(input)
    const reached = new Set<string>()
    for (
      let scrollOffset = 0;
      scrollOffset <= first.maxTranscriptScrollOffset;
      scrollOffset += 1
    ) {
      const selected = projectTuiView({ ...input, scrollOffset }, first)
      for (const match of JSON.stringify(selected.transcriptEntries).matchAll(
        /r\d{7}/gu,
      ))
        reached.add(match[0])
    }
    expect(reached).toEqual(new Set(markers))
  })

  it('reaches multi-field tool and shell content in authoritative order', () => {
    const tokens = (prefix: string) =>
      Array.from(
        { length: 12 },
        (_, index) => `${prefix}-${String(index).padStart(2, '0')}`,
      )
    const command = tokens('cmd')
    const result = tokens('result')
    const oldLines = tokens('old')
    const newLines = tokens('new')
    const shellCommand = tokens('shell')
    const stdout = tokens('out')
    const stderr = tokens('err')
    const cases: readonly {
      history: readonly TranscriptItem[]
      expected: readonly string[]
    }[] = [
      {
        history: [
          {
            kind: 'tool',
            call: {
              id: 'bash',
              name: 'Bash',
              input: { command: command.join('\n') },
            },
            detail: '',
          },
          {
            kind: 'tool-result',
            callId: 'bash',
            text: result.join('\n'),
            isError: false,
          },
        ],
        expected: [...command, ...result],
      },
      {
        history: [
          {
            kind: 'tool',
            call: {
              id: 'edit',
              name: 'Edit',
              input: {
                file_path: '/tmp/example',
                old_string: oldLines.join('\n'),
                new_string: newLines.join('\n'),
              },
            },
            detail: '',
          },
          {
            kind: 'tool-result',
            callId: 'edit',
            text: 'updated',
            isError: false,
          },
        ],
        expected: [...oldLines, ...newLines],
      },
      {
        history: [
          {
            kind: 'shell',
            callId: 'shell',
            command: shellCommand.join('\n'),
          },
          {
            kind: 'shell-result',
            callId: 'shell',
            stdout: stdout.join('\n'),
            stderr: stderr.join('\n'),
            isError: false,
          },
        ],
        expected: [...shellCommand, ...stdout, ...stderr],
      },
    ]

    for (const testCase of cases) {
      const input = {
        ...base,
        fixedViewport: true,
        detailedTranscript: true,
        rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 5,
        width: 40,
        initialHistory: testCase.history,
        history: testCase.history,
        resume: false,
        historyChange: { revision: 0, changedFrom: 0 },
      }
      const first = projectTuiView(input)
      const ordered: string[] = []
      const seen = new Set<string>()
      for (
        let offset = first.maxTranscriptScrollOffset;
        offset >= 0;
        offset -= 1
      ) {
        const selected = projectTuiView(
          { ...input, scrollOffset: offset },
          first,
        )
        const slice = selected.transcriptEntries[0]?.viewportSlice?.text ?? ''
        for (const match of slice.matchAll(
          /(?:cmd|result|old|new|shell|out|err)-\d{2}/gu,
        )) {
          const marker = match[0]
          if (!seen.has(marker)) {
            seen.add(marker)
            ordered.push(marker)
          }
        }
      }
      expect(ordered).toEqual(testCase.expected)
    }
  })

  it('moves paired tool, paired shell, and Read summaries across boundaries atomically', () => {
    const history: readonly TranscriptItem[] = [
      {
        kind: 'tool',
        call: { id: 'tool', name: 'Glob', input: { pattern: '*' } },
        detail: 'Glob *',
      },
      {
        kind: 'tool-result',
        callId: 'tool',
        text: 'glob-result',
        isError: false,
      },
      { kind: 'shell', callId: 'shell', command: 'pwd' },
      {
        kind: 'shell-result',
        callId: 'shell',
        stdout: '/tmp',
        stderr: '',
        isError: false,
      },
      {
        kind: 'tool',
        call: { id: 'read-a', name: 'Read', input: { file_path: '/a' } },
        detail: 'Read /a',
      },
      { kind: 'tool-result', callId: 'read-a', text: 'a', isError: false },
      {
        kind: 'tool',
        call: { id: 'read-b', name: 'Read', input: { file_path: '/b' } },
        detail: 'Read /b',
      },
      { kind: 'tool-result', callId: 'read-b', text: 'b', isError: false },
      assistant('tail'),
    ]
    const full = projectTranscriptPresentation(history, 'normal')
    expect(full.map((entry) => entry.kind)).toEqual([
      'tool',
      'shell',
      'read-summary',
      'item',
    ])

    for (let scrollOffset = 0; scrollOffset <= 12; scrollOffset += 1) {
      const entries = projectTuiView({
        ...base,
        fixedViewport: true,
        rows: FULLSCREEN_TRANSCRIPT_RESERVED_ROWS + 4,
        scrollOffset,
        initialHistory: history,
        history,
        resume: true,
      }).transcriptEntries
      expect(
        entries.every((entry) =>
          full.some((fullEntry) => fullEntry.key === entry.key),
        ),
      ).toBe(true)
      expect(
        entries.some(
          (entry) =>
            entry.kind === 'orphan-tool-result' ||
            entry.kind === 'orphan-shell-result',
        ),
      ).toBe(false)
      for (const entry of entries) {
        if (entry.kind === 'tool' || entry.kind === 'shell') {
          expect(entry.result).toBeDefined()
        }
      }
    }
  })
})

describe('resolveTuiRenderer', () => {
  it('defaults interactive TTY execution to fullscreen', () => {
    expect(
      resolveTuiRenderer({
        configured: 'default',
        explicitlyConfigured: false,
        interactiveTty: true,
        screenReader: false,
      }),
    ).toBe('fullscreen')
  })

  it('retains classic for screen-reader execution', () => {
    expect(
      resolveTuiRenderer({
        configured: 'fullscreen',
        explicitlyConfigured: true,
        interactiveTty: true,
        screenReader: true,
      }),
    ).toBe('default')
  })

  it('retains classic for non-interactive execution', () => {
    expect(
      resolveTuiRenderer({
        configured: 'default',
        explicitlyConfigured: false,
        interactiveTty: false,
        screenReader: false,
      }),
    ).toBe('default')
  })

  it('honors an explicit fullscreen configuration', () => {
    expect(
      resolveTuiRenderer({
        configured: 'fullscreen',
        explicitlyConfigured: true,
        interactiveTty: true,
        screenReader: false,
      }),
    ).toBe('fullscreen')
  })

  it('honors an explicit classic configuration over the fullscreen default', () => {
    expect(
      resolveTuiRenderer({
        configured: 'default',
        explicitlyConfigured: true,
        interactiveTty: true,
        screenReader: false,
      }),
    ).toBe('default')
  })
})
