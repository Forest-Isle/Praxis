import { describe, expect, it } from 'vitest'

import type { TranscriptItem } from './transcript-presentation.js'
import { createTuiHistoryChange } from './transcript-window-model.js'
import {
  projectTuiScreen,
  type TuiScreenInput,
  type TuiScreenSurfaceModels,
} from './tui-screen-model.js'
import { projectTuiSessionPicker } from './session-picker-model.js'
import type { TuiSessionPickerModel } from './session-picker-model.js'
import { projectTuiCommandPalette } from './command-palette-model.js'
import type { TuiCommandPaletteModel } from './command-palette-model.js'
import {
  projectTuiMentionPicker,
  type TuiMentionPickerModel,
} from './mention-picker-model.js'
import { projectTuiMcpSurface } from './mcp-surface-model.js'
import type { TuiMcpSurfaceModel } from './mcp-surface-model.js'
import { projectTuiTaskSurface } from './task-surface-model.js'
import type { TuiTaskSurfaceModel } from './task-surface-model.js'
import { projectTuiDoctorSurface } from './doctor-surface-model.js'
import type { TuiDoctorSurfaceModel } from './doctor-surface-model.js'

type Surfaces = TuiScreenSurfaceModels & {
  readonly sessionPicker: { readonly kind: 'picker' } | TuiSessionPickerModel
  readonly priority:
    | {
        readonly kind: 'priority'
        readonly surface?: unknown
      }
    | { readonly kind: 'plan-approval'; readonly selectedIndex: number }
    | { readonly kind: 'question'; readonly questionIndex: number }
  readonly secondary:
    | { readonly kind: 'menu'; readonly surface?: unknown }
    | TuiMcpSurfaceModel
    | TuiTaskSurfaceModel
    | TuiDoctorSurfaceModel
  readonly overlay:
    | { readonly kind: 'overlay'; readonly id: number }
    | TuiCommandPaletteModel
    | TuiMentionPickerModel
}

const presentation = (
  kind: 'fullscreen' | 'classic' | 'screen-reader',
  rows = 24,
) => ({
  kind,
  viewport: {
    columns: 80,
    rows,
    revision: 0,
    source: 'override' as const,
  },
  fixedViewport: kind === 'fullscreen',
  screenReader: kind === 'screen-reader',
})

const makeInput = (
  overrides: Partial<TuiScreenInput<Surfaces>> = {},
): TuiScreenInput<Surfaces> => ({
  presentation: presentation('classic'),
  conversation: {
    initialHistory: [],
    history: [],
    resumeRequested: false,
    scrollOffset: 0,
    detailed: false,
    activeText: 'active',
    activeThinking: '',
  },
  sessionId: 'session-123456',
  surfaces: { overlays: [] },
  ...overrides,
})

const conversation = (
  screen: ReturnType<typeof projectTuiScreen<Surfaces>>,
) => {
  expect(screen.body.kind).toBe('conversation')
  if (screen.body.kind !== 'conversation')
    throw new Error('expected conversation')
  return screen.body
}

describe('projectTuiScreen', () => {
  it('preserves the projected session-picker payload identity', () => {
    const picker = projectTuiSessionPicker({
      choices: [null, { sessionId: 'session-1', status: 'ready' }],
      query: '',
      selectedIndex: 1,
    })
    const screen = projectTuiScreen<Surfaces>(
      makeInput({ surfaces: { sessionPicker: picker, overlays: [] } }),
    )
    expect(screen.body.kind).toBe('session-picker')
    if (screen.body.kind === 'session-picker') {
      expect(screen.body.surface).toBe(picker)
    }
  })

  it('preserves the command-palette payload identity through compose overlays', () => {
    const palette = projectTuiCommandPalette({
      commands: [
        { name: 'review', description: 'Review changes', source: 'command' },
      ],
      query: 'rev',
      selectedIndex: 0,
    })
    const screen = projectTuiScreen<Surfaces>(
      makeInput({ surfaces: { overlays: [palette] } }),
    )
    const foreground = conversation(screen).foreground
    expect(foreground.kind).toBe('compose')
    if (foreground.kind === 'compose') {
      expect(foreground.overlays[0]).toBe(palette)
    }
  })

  it('preserves the mention-picker payload identity through compose overlays', () => {
    const picker = projectTuiMentionPicker({
      files: [{ path: 'src/', directory: true }],
      agents: [],
      query: '',
      selectedIndex: 0,
    })
    const screen = projectTuiScreen<Surfaces>(
      makeInput({ surfaces: { overlays: [picker] } }),
    )
    const foreground = conversation(screen).foreground
    expect(foreground.kind).toBe('compose')
    if (foreground.kind === 'compose') {
      expect(foreground.overlays[0]).toBe(picker)
    }
  })

  it('preserves the MCP semantic surface identity through secondary payloads', () => {
    const surface = projectTuiMcpSurface({
      model: { cwd: '/workspace', servers: [] },
      state: { depth: 'list', serverIndex: 0, selectedIndex: 0 },
    })
    const screen = projectTuiScreen<Surfaces>(
      makeInput({ surfaces: { secondary: surface, overlays: [] } }),
    )
    const foreground = conversation(screen).foreground
    expect(foreground.kind).toBe('secondary')
    if (foreground.kind === 'secondary')
      expect(foreground.surface).toBe(surface)
  })

  it('preserves the task semantic surface identity through secondary payloads', () => {
    const tasks = [
      {
        id: 'task-1',
        kind: 'shell' as const,
        status: 'running' as const,
        label: 'sleep 1',
        createdAtMs: 1,
      },
    ]
    const state = { depth: 'list' as const, selectedIndex: 0, scrollOffset: 0 }
    const surface = projectTuiTaskSurface({ tasks, state })
    const screen = projectTuiScreen<Surfaces>(
      makeInput({ surfaces: { secondary: surface, overlays: [] } }),
    )
    const foreground = conversation(screen).foreground
    expect(foreground.kind).toBe('secondary')
    if (foreground.kind === 'secondary')
      expect(foreground.surface).toBe(surface)
  })

  it('preserves the doctor semantic surface identity through secondary payloads', () => {
    const surface = projectTuiDoctorSurface({
      loading: true,
      report: null,
      error: null,
    })
    const screen = projectTuiScreen<Surfaces>(
      makeInput({ surfaces: { secondary: surface, overlays: [] } }),
    )
    const foreground = conversation(screen).foreground
    expect(foreground.kind).toBe('secondary')
    if (foreground.kind === 'secondary')
      expect(foreground.surface).toBe(surface)
  })

  it('returns the input presentation object and applies body precedence', () => {
    const sourcePresentation = presentation('classic')
    const picker = projectTuiScreen<Surfaces>(
      makeInput({
        presentation: sourcePresentation,
        surfaces: { sessionPicker: { kind: 'picker' }, overlays: [] },
      }),
    )
    expect(picker.presentation).toBe(sourcePresentation)
    expect(picker.body.kind).toBe('session-picker')
  })

  it('applies priority, secondary, then compose precedence', () => {
    const priority = projectTuiScreen<Surfaces>(
      makeInput({
        surfaces: {
          priority: { kind: 'priority' },
          secondary: { kind: 'menu' },
          overlays: [],
        },
      }),
    )
    expect(conversation(priority).foreground).toEqual({
      kind: 'priority',
      surface: { kind: 'priority' },
    })

    const secondary = projectTuiScreen<Surfaces>(
      makeInput({
        surfaces: { secondary: { kind: 'menu' }, overlays: [] },
      }),
    )
    expect(conversation(secondary).foreground).toEqual({
      kind: 'secondary',
      surface: { kind: 'menu' },
    })

    const first = { kind: 'overlay' as const, id: 1 }
    const second = { kind: 'overlay' as const, id: 2 }
    const compose = projectTuiScreen<Surfaces>(
      makeInput({ surfaces: { overlays: [first, second] } }),
    )
    const foreground = conversation(compose).foreground
    expect(foreground.kind).toBe('compose')
    if (foreground.kind === 'compose') {
      expect(foreground.overlays).toEqual([first, second])
      expect(foreground.overlays[0]).toBe(first)
      expect(foreground.overlays[1]).toBe(second)
    }
  })

  it('preserves permission payloads through generic precedence', () => {
    const permissionPriority = {
      kind: 'permission-dashboard',
      selectedIndex: 1,
    }
    const permissionSecondary = {
      kind: 'permission-scope',
      selectedIndex: 0,
    }
    const priority = projectTuiScreen<Surfaces>(
      makeInput({
        surfaces: {
          priority: { kind: 'priority', surface: permissionPriority },
          secondary: { kind: 'menu', surface: permissionSecondary },
          overlays: [],
        },
      }),
    )
    expect(conversation(priority).foreground).toEqual({
      kind: 'priority',
      surface: { kind: 'priority', surface: permissionPriority },
    })

    const legacy = { kind: 'menu' as const }
    const secondary = projectTuiScreen<Surfaces>(
      makeInput({ surfaces: { secondary: legacy, overlays: [] } }),
    )
    expect(conversation(secondary).foreground).toEqual({
      kind: 'secondary',
      surface: legacy,
    })
  })

  it('preserves decision payload identity through generic precedence', () => {
    const decisionPlan = { kind: 'plan-approval' as const, selectedIndex: 2 }
    const screen = projectTuiScreen<Surfaces>(
      makeInput({
        surfaces: {
          priority: decisionPlan,
          overlays: [],
        },
      }),
    )
    const foreground = conversation(screen).foreground
    expect(foreground).toEqual({
      kind: 'priority',
      surface: decisionPlan,
    })
    if (foreground.kind === 'priority') {
      expect(foreground.surface).toBe(decisionPlan)
    }
  })

  it('projects fresh, started, resumed, and screen-reader intros', () => {
    expect(conversation(projectTuiScreen<Surfaces>(makeInput())).intro).toBe(
      'welcome',
    )
    expect(
      conversation(
        projectTuiScreen<Surfaces>(
          makeInput({
            conversation: {
              ...makeInput().conversation,
              history: [{ kind: 'user', text: 'started' }],
            },
          }),
        ),
      ).intro,
    ).toBe('identity')
    expect(
      conversation(
        projectTuiScreen<Surfaces>(
          makeInput({
            conversation: {
              ...makeInput().conversation,
              resumeRequested: true,
              initialHistory: [{ kind: 'user', text: 'loaded' }],
              history: [{ kind: 'user', text: 'loaded' }],
            },
          }),
        ),
      ).intro,
    ).toBe('none')
    expect(
      conversation(
        projectTuiScreen<Surfaces>(
          makeInput({ presentation: presentation('screen-reader') }),
        ),
      ).intro,
    ).toBe('none')
  })

  it('keeps full classic and screen-reader history and bounds fullscreen', () => {
    const history: TranscriptItem[] = Array.from(
      { length: 20 },
      (_, index) => ({
        kind: 'user',
        text: `entry-${index}`,
      }),
    )
    const classic = conversation(
      projectTuiScreen<Surfaces>(
        makeInput({ conversation: { ...makeInput().conversation, history } }),
      ),
    )
    const reader = conversation(
      projectTuiScreen<Surfaces>(
        makeInput({
          presentation: presentation('screen-reader'),
          conversation: { ...makeInput().conversation, history },
        }),
      ),
    )
    const fullscreen = conversation(
      projectTuiScreen<Surfaces>(
        makeInput({
          presentation: presentation('fullscreen', 8),
          conversation: { ...makeInput().conversation, history },
        }),
      ),
    )
    expect(classic.transcript.entries).toHaveLength(history.length)
    expect(reader.transcript.entries).toHaveLength(history.length)
    expect(fullscreen.transcript.entries.length).toBeLessThan(history.length)
    const tail = fullscreen.transcript.entries.at(-1)
    expect(tail?.kind).toBe('item')
    if (tail?.kind === 'item') expect(tail.item).toBe(history.at(-1))
  })

  it('projects exact reading modes and active visibility', () => {
    const normal = conversation(projectTuiScreen<Surfaces>(makeInput()))
    expect(normal.transcript.readingMode).toBe('normal')
    expect(normal.transcript.active.visible).toBe(true)
    expect(normal.transcript.scrollOffset).toBe(0)
    const audit = conversation(
      projectTuiScreen<Surfaces>(
        makeInput({
          conversation: { ...makeInput().conversation, detailed: true },
        }),
      ),
    )
    expect(audit.transcript.readingMode).toBe('audit')
    const history: TranscriptItem[] = Array.from(
      { length: 20 },
      (_, index) => ({ kind: 'user', text: `scroll-${index}` }),
    )
    const scrolled = conversation(
      projectTuiScreen<Surfaces>(
        makeInput({
          presentation: presentation('fullscreen', 8),
          conversation: {
            ...makeInput().conversation,
            history,
            scrollOffset: 1,
          },
        }),
      ),
    )
    expect(scrolled.transcript.scrollOffset).toBe(1)
    expect(scrolled.transcript.active.visible).toBe(false)

    for (const scrollOffset of [-1, 999]) {
      const clamped = conversation(
        projectTuiScreen<Surfaces>(
          makeInput({
            presentation: presentation('fullscreen', 8),
            conversation: { ...makeInput().conversation, scrollOffset },
          }),
        ),
      )
      expect(clamped.transcript.scrollOffset).toBe(0)
      expect(clamped.transcript.active.visible).toBe(true)
    }
  })

  it('reuses unchanged entry identities across a valid append', () => {
    const first: TranscriptItem = { kind: 'user', text: 'first' }
    const second: TranscriptItem = { kind: 'assistant', text: 'second' }
    const third: TranscriptItem = { kind: 'user', text: 'third' }
    const initial = [first, second]
    const initialScreen = projectTuiScreen<Surfaces>(
      makeInput({
        conversation: { ...makeInput().conversation, history: initial },
      }),
    )
    const next = [...initial, third]
    const appended = projectTuiScreen<Surfaces>(
      makeInput({
        conversation: {
          ...makeInput().conversation,
          history: next,
          historyChange: createTuiHistoryChange(
            1,
            initial.length,
            next,
            initial,
          ),
        },
      }),
      initialScreen,
    )
    const oldEntries = conversation(initialScreen).transcript.entries
    const newEntries = conversation(appended).transcript.entries
    expect(newEntries[0]).toBe(oldEntries[0])
    expect(newEntries[1]).toBe(oldEntries[1])
  })

  it('retains identity when returning from a session picker', () => {
    const item: TranscriptItem = { kind: 'user', text: 'stable' }
    const initial = projectTuiScreen<Surfaces>(
      makeInput({
        conversation: { ...makeInput().conversation, history: [item] },
      }),
    )
    const picker = projectTuiScreen<Surfaces>(
      makeInput({
        conversation: { ...makeInput().conversation, history: [item] },
        surfaces: { sessionPicker: { kind: 'picker' }, overlays: [] },
      }),
      initial,
    )
    const returned = projectTuiScreen<Surfaces>(
      makeInput({
        conversation: { ...makeInput().conversation, history: [item] },
      }),
      picker,
    )
    expect(conversation(returned).transcript.entries[0]).toBe(
      conversation(initial).transcript.entries[0],
    )
  })
})
