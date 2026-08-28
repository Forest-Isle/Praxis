import { cleanup, render } from 'ink-testing-library'
import { Box, Text } from 'ink'
import type { ComponentProps, ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { TuiThemeProvider } from './theme.js'
import { PraxisLogo, PRAXIS_LOGO_ROWS } from './praxis-logo.js'
import {
  ACTIVE_STREAM_MAX_LINES,
  BtwPanel,
  CommandPalette,
  Composer,
  CustomThemeEditor,
  DiffDashboard,
  DialogFrame,
  ExternalEditorWait,
  FilePicker,
  HelpMenu,
  HookDashboard,
  LeafSurface,
  ListDashboard,
  MemoryDashboard,
  MarkdownText,
  MentionPicker,
  ModelMenu,
  EffortMenu,
  SelectionMenu,
  SessionIdentity,
  SessionPicker,
  ShortcutHelp,
  ThemePicker,
  Transcript,
  WelcomePanel,
  activeStreamWindow,
} from './claude-style.js'
import { projectTuiHooks } from './hook-settings.js'
import { projectTuiHooksSurface } from './hooks-surface-model.js'
import { projectTuiCommandPalette } from './command-palette-model.js'
import { projectTuiDiffSurface } from './diff-surface-model.js'
import { projectTuiSessionPicker } from './session-picker-model.js'
import { projectTuiMentionPicker } from './mention-picker-model.js'
import { projectTuiMemorySurface } from './memory-surface-model.js'
import {
  projectTranscriptPresentation,
  type TranscriptItem,
  type TranscriptPresentationEntry,
  type TranscriptPresentationMode,
} from './transcript-presentation.js'
import {
  projectTranscriptPresentationTail,
  projectTranscriptPresentationWindow,
} from './transcript-viewport.js'
import { projectTuiHelpSurface } from './help-surface-model.js'
import { projectTuiListSurface } from './list-surface-model.js'
import { projectTuiBtwSurface } from './btw-surface-model.js'
import {
  projectTuiEffortSurface,
  projectTuiModelSurface,
} from './model-effort-surface-model.js'
import { projectTuiThemeSurface } from './theme-surface-model.js'
import { projectTuiLeafSurface } from './leaf-surface-model.js'

afterEach(() => cleanup())

function expectNoColorSgr(frame: string): void {
  const sgr = new RegExp(String.raw`\u001b\[([0-9;]*)m`, 'gu')
  for (const match of frame.matchAll(sgr)) {
    const parameters =
      (match[1] ?? '') === '' ? [0] : (match[1] ?? '').split(';').map(Number)
    expect(
      parameters.some(
        (parameter) =>
          (parameter >= 30 && parameter <= 37) ||
          (parameter >= 40 && parameter <= 47) ||
          (parameter >= 90 && parameter <= 97) ||
          (parameter >= 100 && parameter <= 107) ||
          parameter === 38 ||
          parameter === 48,
      ),
    ).toBe(false)
  }
}

const transcriptEntries = (
  items: readonly TranscriptItem[],
  mode: TranscriptPresentationMode,
) => projectTranscriptPresentation(items, mode)

const display = {
  version: '0.1.2',
  cwd: '/Users/test/dev/Praxis',
  model: 'test-model',
  effort: 'high',
  permissionMode: 'default',
}

function renderNormal(element: ReactElement) {
  const previousNoColor = process.env.NO_COLOR
  delete process.env.NO_COLOR
  try {
    return render(
      <TuiThemeProvider
        settings={{ theme: 'dark', syntaxHighlightingDisabled: false }}
      >
        {element}
      </TuiThemeProvider>,
    )
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
}

describe('Claude-style TUI components', () => {
  it('renders Btw answers, errors, history, and copy state from its surface', () => {
    const app = renderNormal(
      <BtwPanel
        surface={projectTuiBtwSurface({
          entries: [
            { id: 1, question: 'first?', answer: 'answer', status: 'complete' },
            {
              id: 2,
              question: 'second?',
              answer: '',
              status: 'error',
              error: 'Side question failed',
            },
          ],
          selectedIndex: 0,
          scrollOffset: 0,
          copied: true,
        })}
        width={80}
        screenReader={false}
      />,
    )
    expect(app.lastFrame()).toContain('/btw first?')
    expect(app.lastFrame()).toContain('/btw second?')
    expect(app.lastFrame()).toContain('answer')
    expect(app.lastFrame()).toContain('Copied to clipboard')
  })

  it('renders the observed memory file dialog and screen-reader branch', () => {
    const entries = [
      {
        kind: 'file' as const,
        label: 'User memory',
        path: '/home/test/.claude/CLAUDE.md',
        displayPath: '~/.claude/CLAUDE.md',
        annotation: 'Saved in ~/.claude/CLAUDE.md',
        scope: 'user' as const,
      },
      {
        kind: 'folder' as const,
        label: 'Open auto-memory folder',
        path: '/memory',
        displayPath: '/memory',
        scope: 'project' as const,
      },
    ]
    const app = render(
      <MemoryDashboard
        surface={projectTuiMemorySurface({
          autoMemoryEnabled: true,
          entries,
          selectedIndex: 1,
          openedIndex: 1,
          dataPlane: 'native',
        })}
        width={100}
        screenReader={false}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Memory')
    expect(frame).toContain('Auto-memory: on')
    expect(frame).toContain('1. User memory')
    expect(frame).toContain('Saved in ~/.claude/CLAUDE.md')
    expect(frame).toContain('2. Open auto-memory folder ✔')
    expect(frame).not.toContain('https://code.claude.com/docs/en/memory')
    expect(frame.split('\n')[0]).toBe('─'.repeat(100))

    const accessible = render(
      <MemoryDashboard
        surface={projectTuiMemorySurface({
          autoMemoryEnabled: false,
          entries: entries.slice(0, 1),
          selectedIndex: 0,
          openedIndex: null,
          dataPlane: 'native',
        })}
        width={40}
        screenReader
      />,
    )
    expect(accessible.lastFrame()).toContain('Auto-memory: off')
    expect(accessible.lastFrame()).not.toContain('────')
  })

  it('renders a complete wide welcome surface and local identity', () => {
    const app = render(<WelcomePanel display={display} width={80} showTips />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Praxis Code v0.1.2')
    expect(frame).toContain('Welcome to Praxis')
    expect(frame).toContain('test-model · high effort')
    expect(frame).toContain('/Users/test/dev/Praxis')
    expect(frame).toContain('/init to create PRAXIS.md')
    expect(frame).toContain('/config to open settings')
    expect(frame).toContain('Get started')
    expect(frame).toContain('Stored by Praxis')
    expect(frame).toContain('Sessions · memory · skills')
    // Title lives in the top border row, exactly one line wide.
    expect(frame.split('\n')[0]).toContain('╭───Praxis Code v0.1.2')
    expect(frame.split('\n').every((line) => line.length <= 80)).toBe(true)
    // No long Claude release-note copy in the startup surface.
    expect(frame).not.toContain("What's new")
    expect(frame).not.toContain('SendMessage')
    expect(frame).not.toContain('/release-notes')
  })

  it('renders the reusable Praxis logo glyph rows', () => {
    const app = render(<PraxisLogo />)
    const frame = app.lastFrame() ?? ''
    expect(PRAXIS_LOGO_ROWS).toEqual(['╭─╮', '│▸│', '╰╲╯', ' ╲✦'])
    expect(frame.split('\n')).toEqual([...PRAXIS_LOGO_ROWS])
  })

  it('renders one semantic label for the Praxis logo in screen-reader mode', () => {
    const app = render(<PraxisLogo screenReader />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toBe('Praxis')
    expect(PRAXIS_LOGO_ROWS.some((row) => frame.includes(row))).toBe(false)
  })

  it('stays complete and within bounds on a narrow terminal', () => {
    const app = render(<WelcomePanel display={display} width={40} showTips />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Welcome to Praxis')
    expect(frame).toContain('test-model · high effort')
    expect(frame).toContain('/Users/test/dev/Praxis')
    expect(frame).toContain('Get started')
    expect(frame).toContain('Stored by Praxis')
    expect(frame.split('\n').every((line) => line.length <= 40)).toBe(true)
    expect(frame).not.toContain("What's new")
    expect(frame).not.toContain('SendMessage')
    expect(frame).not.toContain('/release-notes')
  })

  it('renders no startup panel when tips are disabled', () => {
    const app = render(
      <WelcomePanel display={display} width={80} showTips={false} />,
    )
    expect(app.lastFrame()).toBe('')
  })

  it('renders a compact session identity with version, model, effort, and cwd', () => {
    const app = render(<SessionIdentity display={display} width={80} />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Praxis Code v0.1.2')
    expect(frame).toContain('test-model')
    expect(frame).toContain('high effort')
    expect(frame).toContain('/Users/test/dev/Praxis')
    expect(frame).not.toContain('Welcome to Praxis')
    expect(frame.split('\n').every((line) => line.length <= 80)).toBe(true)
  })

  it('keeps every identity line at or below 40 columns', () => {
    const app = render(<SessionIdentity display={display} width={40} />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Praxis Code v0.1.2')
    expect(frame).toContain('test-model')
    expect(frame).toContain('high effort')
    expect(frame).toContain('/Users/test/dev/Praxis')
    expect(frame.split('\n').every((line) => line.length <= 40)).toBe(true)
  })

  it('truncates long model and cwd lines to the supplied width', () => {
    const longDisplay = {
      version: '0.1.2',
      cwd: '/a/very/long/path/that/would/overflow/the/narrow/terminal/width',
      model: 'claude-opus-4-5-sonnet-20261010-superlong-model-name',
      effort: 'max',
    }
    const app = render(<SessionIdentity display={longDisplay} width={40} />)
    const frame = app.lastFrame() ?? ''
    expect(frame.split('\n').every((line) => line.length <= 40)).toBe(true)
  })

  it('truncates every identity line to a width below 32', () => {
    const narrowDisplay = {
      version: '0.1.2',
      cwd: '/a/very/long/path/that/would/overflow/the/narrow/terminal/width',
      model: 'claude-opus-4-5-sonnet-20261010-superlong-model-name',
      effort: 'max',
    }
    const app = render(<SessionIdentity display={narrowDisplay} width={16} />)
    const frame = app.lastFrame() ?? ''
    expect(frame.split('\n').every((line) => line.length <= 16)).toBe(true)
  })

  it('renders markdown hierarchy and fenced code', () => {
    const app = render(
      <MarkdownText
        text={'# Result\n- first\n> note\n```ts\nconst ok = true\n```'}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Result')
    expect(frame).toContain('• first')
    expect(frame).toContain('│ note')
    expect(frame).toContain('╭─ ts')
    expect(frame).toContain('│ const ok = true')
  })

  it('renders transcript code and diff surfaces under persisted syntax settings', () => {
    const runtimeSurfaces = (
      <>
        <Transcript
          screenReader={false}
          activeText=""
          entries={transcriptEntries(
            [
              {
                kind: 'assistant',
                text: '```ts\nfunction greet() { return "hello" }\n```',
              },
              {
                kind: 'tool',
                call: {
                  id: 'diff',
                  name: 'Bash',
                  input: { command: 'git diff' },
                },
                detail: 'Bash {"command":"git diff"}',
              },
              {
                kind: 'tool-result',
                callId: 'diff',
                text: '@@ fixture\n-function oldName() {}\n+function newName() {}',
                isError: false,
              },
            ],
            'normal',
          )}
        />
        <DiffDashboard
          model={projectTuiDiffSurface({
            sources: [
              {
                label: 'Current',
                snapshot: {
                  additions: 1,
                  deletions: 1,
                  files: [
                    {
                      path: 'fixture.ts',
                      additions: 1,
                      deletions: 1,
                      patch:
                        '@@ fixture\n-function oldName() {}\n+function newName() {}',
                    },
                  ],
                },
              },
            ],
            sourceIndex: 0,
            selectedIndex: 0,
            viewingFile: true,
            scrollOffset: 0,
          })}
          width={100}
          screenReader={false}
        />
      </>
    )
    const enabled = render(
      <TuiThemeProvider
        settings={{ theme: 'dark', syntaxHighlightingDisabled: false }}
      >
        {runtimeSurfaces}
      </TuiThemeProvider>,
    )
    const enabledFrame = enabled.lastFrame() ?? ''
    expect(enabledFrame).toContain('│ function greet() { return "hello" }')
    expect(enabledFrame).toContain('-function oldName() {}')
    expect(enabledFrame).toContain('+function newName() {}')

    const disabled = render(
      <TuiThemeProvider
        settings={{ theme: 'dark', syntaxHighlightingDisabled: true }}
      >
        {runtimeSurfaces}
      </TuiThemeProvider>,
    )
    expect(disabled.lastFrame()).toContain(
      '│ function greet() { return "hello" }',
    )
  })

  it('reproduces identical transcript output on repeated renders', () => {
    const buildTree = () => (
      <TuiThemeProvider
        settings={{ theme: 'dark', syntaxHighlightingDisabled: false }}
      >
        <Transcript
          screenReader={false}
          activeText=""
          entries={transcriptEntries(
            [
              { kind: 'user', text: 'inspect the fixture' },
              {
                kind: 'assistant',
                text: '# Result\n- first item\n> quoted note\ninline `code` and **bold** and [link](https://example.com)\n```ts\nconst ok = true\nfunction greet() { return "hello" }\n```\nDone.',
              },
              {
                kind: 'tool',
                call: {
                  id: 'diff',
                  name: 'Bash',
                  input: { command: 'git diff' },
                },
                detail: 'Bash {"command":"git diff"}',
              },
              {
                kind: 'tool-result',
                callId: 'diff',
                text: '@@ fixture\n-function oldName() {}\n+function newName() {}',
                isError: false,
              },
            ],
            'normal',
          )}
        />
      </TuiThemeProvider>
    )
    const app = render(buildTree())
    const first = app.lastFrame() ?? ''
    app.rerender(buildTree())
    const second = app.lastFrame() ?? ''
    expect(second).toBe(first)
    expect(second).toContain('❯ inspect the fixture')
    expect(second).toContain('Result')
    expect(second).toContain('• first item')
    expect(second).toContain('│ quoted note')
    expect(second).toContain('╭─ ts')
    expect(second).toContain('│ const ok = true')
    expect(second).toContain('│ function greet() { return "hello" }')
    expect(second).toContain('⏺ Bash(git diff)')
    expect(second).toContain('-function oldName() {}')
    expect(second).toContain('+function newName() {}')
  })

  it('keeps active, successful, and failed tool states distinguishable', () => {
    const call = {
      kind: 'tool' as const,
      call: {
        id: 'tool-state',
        name: 'Bash',
        input: { command: 'printf ok' },
      },
      detail: '',
    }
    const active = renderNormal(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries([call], 'normal')}
      />,
    ).lastFrame()
    const successful = renderNormal(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries(
          [
            call,
            {
              kind: 'tool-result',
              callId: 'tool-state',
              text: 'ok',
              isError: false,
            },
          ],
          'normal',
        )}
      />,
    ).lastFrame()
    const failed = renderNormal(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries(
          [
            call,
            {
              kind: 'tool-result',
              callId: 'tool-state',
              text: 'permission denied',
              isError: true,
            },
          ],
          'normal',
        )}
      />,
    ).lastFrame()

    expect(active).toContain('⏺ Bash(printf ok)')
    expect(successful).toContain('⏺ Bash(printf ok)')
    expect(successful).toContain('⎿ ok')
    expect(failed).toContain('⏺ Bash(printf ok)')
    expect(failed).toContain('⎿ Error: permission denied')
  })

  it('keeps historical transcript items equivalent while active and palette/mode changes stay live', () => {
    const items = [
      { kind: 'user', text: 'inspect the fixture' },
      {
        kind: 'assistant',
        text: '# Result\n```ts\nconst ok = true\nfunction greet() { return "hello" }\n```',
      },
    ] as const
    const tree = (
      theme: 'dark' | 'dark-ansi',
      syntaxHighlightingDisabled: boolean,
      activeText: string,
      screenReader = false,
    ) => (
      <TuiThemeProvider settings={{ theme, syntaxHighlightingDisabled }}>
        <Transcript
          screenReader={screenReader}
          activeText={activeText}
          entries={transcriptEntries(
            items,
            screenReader ? 'screen-reader' : 'normal',
          )}
        />
      </TuiThemeProvider>
    )
    const app = render(tree('dark', false, ''))
    const baseline = app.lastFrame() ?? ''
    expect(baseline).toContain('❯ inspect the fixture')
    expect(baseline).toContain('│ const ok = true')
    expect(baseline).toContain('│ function greet() { return "hello" }')

    // Active streaming content updates while historical items stay equivalent.
    app.rerender(tree('dark', false, 'streaming tail'))
    const streaming = app.lastFrame() ?? ''
    expect(streaming).toContain('✳ streaming tail')
    expect(streaming).toContain('❯ inspect the fixture')
    expect(streaming).toContain('│ const ok = true')
    expect(streaming).toContain('│ function greet() { return "hello" }')

    // Palette and syntax-mode changes must not reuse stale subtrees or drop
    // historical items. The test harness strips color escapes, so the proof
    // here is structural stability of every visible string.
    app.rerender(tree('dark-ansi', false, 'streaming tail'))
    const ansi = app.lastFrame() ?? ''
    expect(ansi).toContain('streaming tail')
    expect(ansi).toContain('const ok = true')
    expect(ansi).toContain('❯ inspect the fixture')
    expect(ansi).toContain('│ function greet() { return "hello" }')

    app.rerender(tree('dark-ansi', true, 'streaming tail'))
    const disabled = app.lastFrame() ?? ''
    expect(disabled).toContain('streaming tail')
    expect(disabled).toContain('const ok = true')
    expect(disabled).toContain('❯ inspect the fixture')
    expect(disabled).toContain('│ function greet() { return "hello" }')

    // Screen-reader mode visibly updates the transcript layout.
    app.rerender(tree('dark-ansi', true, 'streaming tail', true))
    const accessible = app.lastFrame() ?? ''
    expect(accessible).toContain('You: inspect the fixture')
    expect(accessible).toContain('Praxis: streaming tail')
    expect(accessible).toContain('const ok = true')
    expect(accessible).not.toContain('✳')
  })

  it('renders incomplete streaming Markdown without corrupting the frame', () => {
    const app = render(
      <Transcript
        screenReader={false}
        activeText="# Unfinished\n```ts\nconst partial = "
        entries={[]}
      />,
    )
    const frame = app.lastFrame() ?? ''
    // The completed heading line still renders through the Markdown path.
    expect(frame).toContain('✳')
    expect(frame).toContain('Unfinished')
    // The unterminated code fence cannot swallow the pending partial line or
    // produce a spurious close; every row stays within the viewport width.
    expect(frame).toContain('const partial =')
    expect(frame).not.toContain('╰─')
    expect(frame.split('\n').every((line) => line.length <= 80)).toBe(true)
  })

  it('bounds the active streaming window while completed turns stay full', () => {
    const lines = Array.from(
      { length: 60 },
      (_, index) => `stream line ${index}`,
    )
    const app = render(
      <Transcript
        screenReader={false}
        activeText={`${lines.join('\n')}\npending tail`}
        entries={[]}
      />,
    )
    const frame = app.lastFrame() ?? ''
    // The bounded window keeps the most recent lines and the plain pending
    // tail, and marks the dropped earlier content instead of re-rendering it.
    expect(frame).toContain('earlier streaming content')
    expect(frame).toContain('stream line 59')
    expect(frame).toContain('pending tail')
    expect(frame).not.toContain('stream line 0')

    // Completed assistant entries still render the full document through the
    // regular history Markdown path, so observable final text is unchanged.
    const completed = render(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries(
          [{ kind: 'assistant', text: lines.join('\n') }],
          'normal',
        )}
      />,
    )
    expect(completed.lastFrame()).toContain('stream line 0')
    expect(completed.lastFrame()).toContain('stream line 59')
  })

  it('keeps the full active stream for screen readers', () => {
    const lines = Array.from(
      { length: 60 },
      (_, index) => `stream line ${index}`,
    )
    const app = render(
      <Transcript screenReader activeText={lines.join('\n')} entries={[]} />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Praxis:')
    expect(frame).toContain('stream line 0')
    expect(frame).toContain('stream line 59')
    expect(frame).not.toContain('earlier streaming content')
  })

  it('hides the live stream while viewing an older transcript window', () => {
    const app = render(
      <Transcript
        screenReader={false}
        activeText="live output below"
        activeStreamVisible={false}
        entries={transcriptEntries(
          [{ kind: 'assistant', text: 'older reply' }],
          'normal',
        )}
      />,
    )
    expect(app.lastFrame()).toContain('older reply')
    expect(app.lastFrame()).not.toContain('live output below')
  })

  it('renders only the presentation entries supplied by the viewport', () => {
    const entries = projectTranscriptPresentation(
      [
        { kind: 'assistant', text: 'excluded older answer' },
        { kind: 'assistant', text: 'retained visible answer' },
      ],
      'normal',
    )
    const retained = entries.at(-1)
    if (!retained) throw new Error('expected retained presentation entry')

    const app = render(
      <Transcript screenReader={false} activeText="" entries={[retained]} />,
    )
    expect(app.lastFrame()).toContain('retained visible answer')
    expect(app.lastFrame()).not.toContain('excluded older answer')
  })

  it('does not re-read an unchanged memoized history row while the stream changes', () => {
    let textReads = 0
    const item = {
      kind: 'assistant' as const,
      get text() {
        textReads += 1
        return 'stable retained answer'
      },
    }
    const entry: TranscriptPresentationEntry = {
      kind: 'item',
      key: 'item-0',
      item,
    }
    const entries = [entry]
    const app = render(
      <Transcript
        screenReader={false}
        activeText="frame 0"
        entries={entries}
      />,
    )
    const readsAfterFirstRender = textReads
    expect(readsAfterFirstRender).toBeGreaterThan(0)

    app.rerender(
      <Transcript
        screenReader={false}
        activeText="frame 1"
        entries={entries}
      />,
    )
    expect(app.lastFrame()).toContain('frame 1')
    expect(app.lastFrame()).toContain('stable retained answer')
    expect(textReads).toBe(readsAfterFirstRender)
  })

  it('keeps semantic renderers for projected oversized rows', () => {
    const entries = projectTranscriptPresentation(
      [
        {
          kind: 'assistant',
          text: `${Array.from({ length: 20 }, (_, index) => `older-${index}`).join('\n')}\n# Selected viewport heading`,
        },
      ],
      'normal',
    )
    const projected = projectTranscriptPresentationTail(
      entries,
      4,
      80,
      'normal',
    )
    expect(projected[0]?.viewportSlice).toBeDefined()
    const app = render(
      <Transcript screenReader={false} activeText="" entries={projected} />,
    )

    expect(app.lastFrame()).toContain('Selected viewport heading')
    expect(app.lastFrame()).toContain('⏺')
    expect(app.lastFrame()).not.toContain('# Selected viewport heading')
    expect(app.lastFrame()).not.toContain('older-0')

    const toolEntries = projectTranscriptPresentation(
      [
        {
          kind: 'tool',
          call: {
            id: 'tool-viewport',
            name: 'Bash',
            input: { command: `hidden-command-${'x'.repeat(200)}` },
          },
          detail: '',
        },
        {
          kind: 'tool-result',
          callId: 'tool-viewport',
          text: Array.from(
            { length: 20 },
            (_, index) => `selected-result-${index}`,
          ).join('\n'),
          isError: false,
        },
      ],
      'audit',
    )
    const toolProjected = projectTranscriptPresentationTail(
      toolEntries,
      4,
      40,
      'audit',
    )
    const tool = render(
      <Box width={40}>
        <Transcript
          screenReader={false}
          activeText=""
          detailedTranscript
          entries={toolProjected}
        />
      </Box>,
    )
    const toolFrame = tool.lastFrame() ?? ''
    expect(toolFrame).toContain('selected-result-19')
    expect(toolFrame).not.toContain('hidden-command')
    expect(toolFrame.split('\n')).toHaveLength(4)

    const shellEntries = projectTranscriptPresentation(
      [
        {
          kind: 'shell',
          callId: 'shell-viewport',
          command: `hidden-shell-${'x'.repeat(200)}`,
        },
        {
          kind: 'shell-result',
          callId: 'shell-viewport',
          stdout: Array.from(
            { length: 20 },
            (_, index) => `selected-shell-result-${index}`,
          ).join('\n'),
          stderr: '',
          isError: false,
        },
      ],
      'audit',
    )
    const shellProjected = projectTranscriptPresentationTail(
      shellEntries,
      4,
      40,
      'audit',
    )
    const shell = render(
      <Box width={40}>
        <Transcript
          screenReader={false}
          activeText=""
          detailedTranscript
          entries={shellProjected}
        />
      </Box>,
    )
    const shellFrame = shell.lastFrame() ?? ''
    expect(shellFrame).toContain('selected-shell-result-19')
    expect(shellFrame).not.toContain('hidden-shell')
    expect(shellFrame.split('\n')).toHaveLength(4)
  })

  it('keeps projected Markdown within the fullscreen viewport rows', () => {
    const entries = projectTranscriptPresentation(
      [{ kind: 'assistant', text: '```ts\n123456789012345678\n```' }],
      'normal',
    )
    const source = JSON.stringify(entries)
    const projected = projectTranscriptPresentationTail(
      entries,
      4,
      20,
      'normal',
    )
    const retained = projected[0]
    if (retained?.kind !== 'item' || retained.item.kind !== 'assistant') {
      throw new Error('expected a projected assistant entry')
    }

    const app = render(
      <Box width={20}>
        <Transcript screenReader={false} activeText="" entries={projected} />
      </Box>,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame.split('\n')).toHaveLength(4)
    expect(retained.item.text).toMatch(/^```ts\n/u)
    expect(retained.item.text).toMatch(/\n```$/u)
    expect(retained.item.text).toContain('678')
    expect(JSON.stringify(entries)).toBe(source)
  })

  it('preserves fenced Markdown semantics in an oversized assistant tail', () => {
    const entries = projectTranscriptPresentation(
      [
        {
          kind: 'assistant',
          text: `${Array.from({ length: 20 }, (_, index) => `older-${index}`).join('\n')}\n\`\`\`ts\nconst visible = 1\n\`\`\``,
        },
      ],
      'normal',
    )
    const projected = projectTranscriptPresentationTail(
      entries,
      5,
      40,
      'normal',
    )
    const app = render(
      <Box width={40}>
        <Transcript screenReader={false} activeText="" entries={projected} />
      </Box>,
    )
    const frame = app.lastFrame() ?? ''

    expect(frame).toContain('⏺')
    expect(frame).toContain('╭─ ts')
    expect(frame).toContain('│ const visible = 1')
    expect(frame).toContain('╰─')
    expect(frame).not.toContain('```')
    expect(frame.split('\n')).toHaveLength(5)
  })

  it('preserves fenced Markdown context in an arbitrary assistant window', () => {
    const entries = projectTranscriptPresentation(
      [
        {
          kind: 'assistant',
          text: `before\n\`\`\`ts\n${Array.from({ length: 20 }, (_, index) => `const code${index} = ${index}`).join('\n')}\n\`\`\`\nafter`,
        },
      ],
      'normal',
    )
    const projected = projectTranscriptPresentationWindow(
      entries,
      5,
      40,
      10,
      'normal',
    )
    const retained = projected[0]
    if (retained?.kind !== 'item' || retained.item.kind !== 'assistant')
      throw new Error('expected a projected assistant entry')
    const app = render(
      <Box width={40}>
        <Transcript screenReader={false} activeText="" entries={projected} />
      </Box>,
    )
    const frame = app.lastFrame() ?? ''

    expect(retained.item.text).toMatch(/^```ts\n/u)
    expect(retained.item.text).toMatch(/\n```$/u)
    expect(frame).toContain('⏺')
    expect(frame).toContain('╭─ ts')
    expect(frame).toContain('│ const code')
    expect(frame).toContain('╰─')
    expect(frame).not.toContain('before')
    expect(frame).not.toContain('after')
    expect(frame.split('\n')).toHaveLength(5)
  })

  it.each([
    ['compact normal', 'normal', 2, [{ kind: 'compact', summary: '' }]],
    [
      'Edit audit result summary',
      'audit',
      5,
      [
        {
          kind: 'tool',
          call: {
            id: 'edit',
            name: 'Edit',
            input: {
              file_path: '/tmp/x',
              old_string: 'x'.repeat(40),
              new_string: '',
            },
          },
          detail: '',
        },
        {
          kind: 'tool-result',
          callId: 'edit',
          text: 'ok',
          isError: false,
        },
      ],
    ],
    [
      'long context normal',
      'normal',
      16,
      [
        {
          kind: 'context',
          usedTokens: 123_456,
          contextWindowTokens: 200_000,
          model: 'claude-opus-4-5-superlong-model',
          skills: [
            {
              name: 'a-very-long-skill-name-that-wraps',
              tokens: 1_000,
            },
          ],
          memoryFiles: [
            {
              path: '/a/very/long/memory/path/that-wraps.md',
              tokens: 2_000,
            },
          ],
        },
      ],
    ],
  ] satisfies readonly [
    string,
    TranscriptPresentationMode,
    number,
    readonly TranscriptItem[],
  ][])(
    'keeps narrow %s within its row budget',
    (_name, mode, budget, items) => {
      const entries = projectTranscriptPresentation(items, mode)
      const source = JSON.stringify(entries)
      const projected = projectTranscriptPresentationTail(
        entries,
        budget,
        32,
        mode,
      )
      const app = render(
        <Box width={32}>
          <Transcript screenReader={false} activeText="" entries={projected} />
        </Box>,
      )
      const frame = app.lastFrame() ?? ''
      const rows = frame ? frame.split('\n') : []
      expect(rows.length).toBeLessThanOrEqual(budget)
      expect(rows.every((line) => line.length <= 32)).toBe(true)
      expect(JSON.stringify(entries)).toBe(source)
    },
  )

  it('keeps rendered Ink rows within width for wide and nested transcript families', () => {
    const cases: readonly {
      name: string
      mode: TranscriptPresentationMode
      widths: readonly number[]
      items: readonly TranscriptItem[]
    }[] = [
      {
        name: 'wide user',
        mode: 'normal',
        widths: [32, 40, 80],
        items: [{ kind: 'user', text: '中文界面'.repeat(30) }],
      },
      {
        name: 'wide assistant',
        mode: 'normal',
        widths: [32, 40, 80],
        items: [{ kind: 'assistant', text: '终端输出与性能稳定'.repeat(24) }],
      },
      {
        name: 'warning',
        mode: 'normal',
        widths: [32, 40],
        items: [{ kind: 'warning', text: '警告信息'.repeat(30) }],
      },
      {
        name: 'thinking',
        mode: 'normal',
        widths: [32, 40, 80],
        items: [{ kind: 'thinking', text: 'reasoning detail '.repeat(40) }],
      },
      {
        name: 'screen-reader context',
        mode: 'screen-reader',
        widths: [32, 40, 80],
        items: [
          {
            kind: 'context',
            usedTokens: 123_456,
            contextWindowTokens: 200_000,
            model: 'claude-opus-super-long-model-name',
            skills: [
              { name: 'very-long-skill-name-that-wraps', tokens: 1_234 },
              { name: '中文技能名称需要换行', tokens: 2_345 },
            ],
            memoryFiles: [],
          },
        ],
      },
      {
        name: 'local result',
        mode: 'normal',
        widths: [32, 40, 80],
        items: [{ kind: 'local-result', text: 'local result '.repeat(40) }],
      },
      {
        name: 'tool error',
        mode: 'audit',
        widths: [32, 40, 80],
        items: [
          {
            kind: 'tool',
            call: { id: 'error', name: 'Fetch', input: {} },
            detail: 'detail',
          },
          {
            kind: 'tool-result',
            callId: 'error',
            text: '错误输出'.repeat(80),
            isError: true,
          },
        ],
      },
      {
        name: 'Bash detail and output',
        mode: 'normal',
        widths: [32, 40, 80],
        items: [
          {
            kind: 'tool',
            call: {
              id: 'bash',
              name: 'Bash',
              input: { command: 'echo '.repeat(30) },
            },
            detail: '',
          },
          {
            kind: 'tool-result',
            callId: 'bash',
            text: 'line '.repeat(30) + '\nsecond\nthird\nfourth',
            isError: false,
          },
        ],
      },
      {
        name: 'screen-reader shell',
        mode: 'screen-reader',
        widths: [32, 40, 80],
        items: [
          { kind: 'shell', callId: 'shell', command: 'printf '.repeat(30) },
          {
            kind: 'shell-result',
            callId: 'shell',
            stdout: '标准输出'.repeat(40) + '\nsecond\nthird\nfourth',
            stderr: '标准错误'.repeat(30),
            isError: true,
          },
        ],
      },
      {
        name: 'orphan results',
        mode: 'normal',
        widths: [32, 40, 80],
        items: [
          {
            kind: 'tool-result',
            callId: 'missing',
            text: 'orphan result '.repeat(50),
            isError: false,
          },
          {
            kind: 'shell-result',
            callId: 'missing-shell',
            stdout: '孤立输出'.repeat(40),
            stderr: '孤立错误'.repeat(30),
            isError: true,
          },
        ],
      },
    ]

    for (const testCase of cases) {
      const entries = projectTranscriptPresentation(
        testCase.items,
        testCase.mode,
      )
      for (const width of testCase.widths) {
        for (const entry of entries) {
          const app = render(
            <Box width={width}>
              <Transcript
                entries={[entry]}
                activeText=""
                screenReader={testCase.mode === 'screen-reader'}
                detailedTranscript={testCase.mode === 'audit'}
              />
            </Box>,
          )
          const frame = app.lastFrame() ?? ''
          expect(frame.split('\n').every((line) => line.length <= width)).toBe(
            true,
          )
          app.unmount()
        }
      }
    }
  })

  it('splits active streaming text into a bounded stable window and plain tail', () => {
    expect(activeStreamWindow('partial line')).toEqual({
      stableText: '',
      pendingText: 'partial line',
      truncated: false,
    })
    expect(activeStreamWindow('head\nbody')).toEqual({
      stableText: 'head\n',
      pendingText: 'body',
      truncated: false,
    })
    expect(activeStreamWindow('one\n')).toEqual({
      stableText: 'one\n',
      pendingText: '',
      truncated: false,
    })
    const many = Array.from(
      { length: ACTIVE_STREAM_MAX_LINES + 10 },
      (_, index) => `line ${index}`,
    ).join('\n')
    const window = activeStreamWindow(`${many}\ntail`)
    expect(window.truncated).toBe(true)
    expect(window.pendingText).toBe('tail')
    expect(window.stableText.startsWith('line 10')).toBe(true)
    expect(window.stableText).toContain('line 49')
    expect(window.stableText).not.toContain('line 0')
  })

  it('gives user, assistant, tool, result, and warning distinct shapes', () => {
    const app = render(
      <Transcript
        screenReader={false}
        activeText="streaming"
        entries={transcriptEntries(
          [
            { kind: 'user', text: 'inspect' },
            { kind: 'assistant', text: 'Working' },
            {
              kind: 'tool',
              call: {
                id: 'call-1',
                name: 'Bash',
                input: { command: 'npm test' },
              },
              detail: 'Bash {"command":"npm test"}',
            },
            {
              kind: 'tool-result',
              callId: 'call-1',
              text: '@@ file\n-old\n+new',
              isError: false,
            },
            { kind: 'warning', text: 'careful' },
          ],
          'normal',
        )}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('❯ inspect')
    expect(frame).toContain('⏺ Bash(npm test)')
    expect(frame).toContain('⎿ @@ file')
    expect(frame).toContain('@@ file')
    expect(frame).toContain('-old')
    expect(frame).toContain('+new')
    expect(frame).toContain('⚠ careful')
    expect(frame).toContain('✳ streaming')
  })

  it('collapses long tool output and renders edit replacements inline', () => {
    const items = [
      {
        kind: 'tool' as const,
        call: {
          id: 'bash',
          name: 'Bash',
          input: { command: 'fixture' },
        },
        detail: 'Bash fixture',
      },
      {
        kind: 'tool-result' as const,
        callId: 'bash',
        text: 'one\ntwo\nthree\nfour\nfive',
        isError: false,
      },
      {
        kind: 'tool' as const,
        call: {
          id: 'edit',
          name: 'Edit',
          input: {
            file_path: '/tmp/fixture.txt',
            old_string: 'before\n',
            new_string: 'after\nsecond line\n',
          },
        },
        detail: 'Edit fixture',
      },
      {
        kind: 'tool-result' as const,
        callId: 'edit',
        text: 'Replaced 1 occurrence(s)',
        isError: false,
      },
    ]
    const collapsed = render(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries(items, 'normal')}
      />,
    )
    expect(collapsed.lastFrame()).toContain('… +2 lines (ctrl+o to expand)')
    expect(collapsed.lastFrame()).not.toContain('five')
    expect(collapsed.lastFrame()).toContain('Update(/tmp/fixture.txt)')
    expect(collapsed.lastFrame()).toContain('Added 2 lines, removed 1 line')
    expect(collapsed.lastFrame()).not.toContain('1 -before')
    expect(collapsed.lastFrame()).not.toContain('2 +second line')

    const detailed = render(
      <Transcript
        screenReader={false}
        activeText=""
        detailedTranscript
        entries={transcriptEntries(items, 'audit')}
      />,
    )
    expect(detailed.lastFrame()).toContain('five')
    expect(detailed.lastFrame()).not.toContain('… +2 lines')
    expect(detailed.lastFrame()).toContain('1 -before')
    expect(detailed.lastFrame()).toContain('2 +second line')
  })

  it('groups adjacent successful reads and expands every file', () => {
    const items = [
      {
        kind: 'tool' as const,
        call: {
          id: 'read-1',
          name: 'Read',
          input: { file_path: '/tmp/one.ts' },
        },
        detail: '',
      },
      {
        kind: 'tool' as const,
        call: {
          id: 'read-2',
          name: 'Read',
          input: { file_path: '/tmp/two.ts' },
        },
        detail: '',
      },
      {
        kind: 'tool-result' as const,
        callId: 'read-1',
        text: 'one',
        isError: false,
      },
      {
        kind: 'tool-result' as const,
        callId: 'read-2',
        text: 'two',
        isError: false,
      },
      { kind: 'assistant' as const, text: 'Between groups.' },
      {
        kind: 'tool' as const,
        call: {
          id: 'read-3',
          name: 'Read',
          input: { file_path: '/tmp/three.ts' },
        },
        detail: '',
      },
      {
        kind: 'tool-result' as const,
        callId: 'read-3',
        text: 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.',
        isError: false,
      },
    ]
    const collapsed = render(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries(items, 'normal')}
      />,
    )
    expect(collapsed.lastFrame()).toContain('Read 2 files (ctrl+o to expand)')
    expect(collapsed.lastFrame()).toContain('Read 1 file (ctrl+o to expand)')
    expect(collapsed.lastFrame()).not.toContain('/tmp/one.ts')

    const expanded = render(
      <Transcript
        screenReader={false}
        activeText=""
        detailedTranscript
        entries={transcriptEntries(items, 'audit')}
      />,
    )
    expect(expanded.lastFrame()).toContain('Read(/tmp/one.ts)')
    expect(expanded.lastFrame()).toContain('Read(/tmp/two.ts)')
    expect(expanded.lastFrame()).toContain('Read(/tmp/three.ts)')
    expect(expanded.lastFrame()).toContain('Unchanged since last read')
  })

  it('renders diff source tabs, file selection, and patch view', () => {
    const snapshot = {
      files: [
        {
          path: 'fixture.txt',
          additions: 2,
          deletions: 1,
          patch:
            'diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1,2 @@\n-before\n+after\n+second line\n',
        },
      ],
      additions: 2,
      deletions: 1,
    }
    const list = renderNormal(
      <DiffDashboard
        model={projectTuiDiffSurface({
          sources: [
            { label: 'Current', snapshot },
            { label: 'T1', snapshot },
          ],
          sourceIndex: 0,
          selectedIndex: 0,
          viewingFile: false,
          scrollOffset: 0,
        })}
        width={100}
        screenReader={false}
      />,
    )
    expect(list.lastFrame()).toContain('Uncommitted changes (git diff HEAD)')
    expect(list.lastFrame()).toContain('Current')
    expect(list.lastFrame()).toContain('T1')
    expect(list.lastFrame()).toContain('❯ fixture.txt')

    const patch = renderNormal(
      <DiffDashboard
        model={projectTuiDiffSurface({
          sources: [{ label: 'Current', snapshot }],
          sourceIndex: 0,
          selectedIndex: 0,
          viewingFile: true,
          scrollOffset: 0,
        })}
        width={100}
        screenReader={false}
      />,
    )
    expect(patch.lastFrame()).toContain('-before')
    expect(patch.lastFrame()).toContain('+second line')
    expect(patch.lastFrame()).toContain('Esc to back')
  })

  it('announces diff source and file focus textually for screen readers', () => {
    const snapshot = {
      files: [
        {
          path: 'first.ts',
          additions: 2,
          deletions: 0,
          patch: '@@ -1 +1 @@\n-before\n+after\n',
        },
        { path: 'second.ts', additions: 0, deletions: 1, patch: '' },
      ],
      additions: 2,
      deletions: 1,
    }
    const first = render(
      <DiffDashboard
        model={projectTuiDiffSurface({
          sources: [
            { label: 'Current', snapshot },
            { label: 'T1', snapshot },
          ],
          sourceIndex: 0,
          selectedIndex: 0,
          viewingFile: false,
          scrollOffset: 0,
        })}
        width={100}
        screenReader
      />,
    ).lastFrame()
    const moved = render(
      <DiffDashboard
        model={projectTuiDiffSurface({
          sources: [
            { label: 'Current', snapshot },
            { label: 'T1', snapshot },
          ],
          sourceIndex: 1,
          selectedIndex: 1,
          viewingFile: false,
          scrollOffset: 0,
        })}
        width={100}
        screenReader
      />,
    ).lastFrame()

    const firstSemantic = (first ?? '').replace(/\s+/gu, ' ')
    const movedSemantic = (moved ?? '').replace(/\s+/gu, ' ')
    expect(firstSemantic).toContain('Current source: Current')
    expect(firstSemantic).toContain(
      'Selected: first.ts; 2 additions; 0 deletions',
    )
    expect(firstSemantic).toContain(
      'Use left and right arrows to switch source',
    )
    expect(firstSemantic).toContain(
      'Use up and down arrows to select a file, then Enter to view',
    )
    expect(firstSemantic).toContain('Escape to close')
    expect(movedSemantic).toContain('Current source: T1')
    expect(movedSemantic).toContain(
      'Selected: second.ts; 0 additions; 1 deletion',
    )
    expect(`${first}${moved}`).not.toContain('❯')
    expect(`${first}${moved}`).not.toContain('─')

    const detail = render(
      <DiffDashboard
        model={projectTuiDiffSurface({
          sources: [{ label: 'Current', snapshot }],
          sourceIndex: 0,
          selectedIndex: 0,
          viewingFile: true,
          scrollOffset: 0,
        })}
        width={100}
        screenReader
      />,
    ).lastFrame()
    const detailSemantic = (detail ?? '').replace(/\s+/gu, ' ')
    expect(detailSemantic).toContain('Current source: Current')
    expect(detailSemantic).toContain(
      'Selected file: first.ts; 2 additions; 0 deletions',
    )
    expect(detailSemantic).toContain('Removed: before')
    expect(detailSemantic).toContain('Added: after')
    expect(detailSemantic).toContain('Patch lines 1-2 of 2')
    expect(detailSemantic).toContain('Escape to go back')
    expect(detail).not.toContain('─')
    expect(detail).not.toContain('❯')
    expect(detail).not.toContain('\u001B[7m')
  })

  it('collapses diff decoration below 32 columns and remains semantic without color', () => {
    const snapshot = {
      files: [
        {
          path: 'narrow.ts',
          additions: 1,
          deletions: 0,
          patch: '+const narrow = true',
        },
      ],
      additions: 1,
      deletions: 0,
    }
    const model = projectTuiDiffSurface({
      sources: [{ label: 'Current', snapshot }],
      sourceIndex: 0,
      selectedIndex: 0,
      viewingFile: false,
      scrollOffset: 0,
    })
    const narrow = render(
      <DiffDashboard model={model} width={20} screenReader={false} />,
    ).lastFrame()

    const narrowSemantic = (narrow ?? '').replace(/\s+/gu, ' ')
    expect(narrowSemantic).toContain('narrow.ts')
    expect(narrowSemantic).toContain('Enter to view')
    expect(narrowSemantic).toContain('Esc to close')
    expect(narrow).not.toContain('─'.repeat(21))
    for (const invalidWidth of [
      -4,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ]) {
      expect(() =>
        render(
          <DiffDashboard
            model={model}
            width={invalidWidth}
            screenReader={false}
          />,
        ),
      ).not.toThrow()
    }

    const previousNoColor = process.env.NO_COLOR
    process.env.NO_COLOR = '1'
    try {
      const noColor = render(
        <TuiThemeProvider
          settings={{ theme: 'dark', syntaxHighlightingDisabled: false }}
        >
          <DiffDashboard model={model} width={20} screenReader={false} />
        </TuiThemeProvider>,
      ).lastFrame()
      const noColorSemantic = (noColor ?? '').replace(/\s+/gu, ' ')
      expect(noColorSemantic).toContain('Current source: Current')
      expect(noColorSemantic).toContain('Selected: narrow.ts +1 -0')
      expect(noColorSemantic).toContain('Enter to view')
      expect(noColor).not.toContain('❯')
      expectNoColorSgr(noColor ?? '')
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previousNoColor
    }
  })

  it('renders the observed built-in theme choices and active profile', () => {
    const app = render(
      <ThemePicker
        model={projectTuiThemeSurface({
          kind: 'theme',
          currentTheme: 'dark',
          customThemes: [],
          selectedIndex: 1,
          syntaxHighlightingDisabled: false,
        })}
        width={100}
        screenReader={false}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Theme')
    expect(frame).toContain(
      'Choose the text style that looks best with your terminal',
    )
    expect(frame).toContain('2. Dark mode ✔')
    expect(frame).toContain('4. Dark mode (colorblind-friendly)')
    expect(frame).toContain('6. Dark mode (ANSI colors only)')
    expect(frame).toContain('1 function greet()')
    expect(frame).toContain('2 -  console.log("Hello, World!");')
    expect(frame).toContain('2 +  console.log("Hello, Claude!");')
    expect(frame).toContain(
      'Syntax theme: Monokai Extended (ctrl+t to disable)',
    )
    expect(frame).toContain('Enter to select · Esc to cancel')
  })

  it('renders a semantic, decoration-free theme picker for screen readers', () => {
    const app = render(
      <ThemePicker
        model={projectTuiThemeSurface({
          kind: 'theme',
          currentTheme: 'light-ansi',
          customThemes: [],
          selectedIndex: 6,
          syntaxHighlightingDisabled: true,
        })}
        width={100}
        screenReader
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain(
      '7. Light mode (ANSI colors only) (current) (focused)',
    )
    expect(frame).toContain('Selected: Light mode (ANSI colors only)')
    expect(frame).toContain('Syntax highlighting disabled (ctrl+t to enable)')
    expect(frame).not.toContain('function greet')
    expect(frame).not.toContain('╌')
    expect(frame).not.toContain('❯')
    expect(frame).not.toContain('✔')
  })

  it('shows active thinking in full and expands retained thinking on demand', () => {
    const reasoning = `Start ${'detail '.repeat(40)}reasoning tail stays visible`
    const collapsed = render(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries(
          [{ kind: 'thinking', text: reasoning }],
          'normal',
        )}
      />,
    )
    expect(collapsed.lastFrame()).toContain('Thought for a moment')
    expect(collapsed.lastFrame()).not.toContain('reasoning tail stays visible')

    const expanded = render(
      <Transcript
        screenReader={false}
        activeText=""
        thinkingExpanded
        entries={transcriptEntries(
          [{ kind: 'thinking', text: reasoning }],
          'audit',
        )}
      />,
    )
    expect(expanded.lastFrame()).toContain('reasoning tail stays visible')

    const active = render(
      <Transcript
        screenReader={false}
        activeText=""
        activeThinking={reasoning}
        entries={[]}
      />,
    )
    expect(active.lastFrame()).toContain('Thinking…')
    expect(active.lastFrame()).toContain('reasoning tail stays visible')
  })

  it('renders context usage and local status dashboards', () => {
    const context = render(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries(
          [
            {
              kind: 'context',
              usedTokens: 1_500,
              contextWindowTokens: 200_000,
              skills: [{ name: 'review', tokens: 290 }],
              memoryFiles: [],
            },
          ],
          'normal',
        )}
      />,
    )
    expect(context.lastFrame()).toContain('Free space: 165.5k (82.8%)')
    expect(context.lastFrame()).toContain(
      'Autocompact buffer: 33k tokens (16.5%)',
    )
    expect(context.lastFrame()).toContain('Estimated usage by category')
    expect(context.lastFrame()).toContain('Memory files · /memory')
    expect(context.lastFrame()).toContain('Loaded')
    expect(context.lastFrame()).toContain('review: ~290 tokens')

    const accessibleContext = render(
      <Transcript
        screenReader
        activeText=""
        entries={transcriptEntries(
          [
            {
              kind: 'context',
              usedTokens: 1_500,
              contextWindowTokens: 200_000,
              skills: [{ name: 'review', tokens: 290 }],
              memoryFiles: [],
            },
          ],
          'screen-reader',
        )}
      />,
    )
    expect(accessibleContext.lastFrame()).toContain(
      'provider default · 1,500/200,000 tokens',
    )
    expect(accessibleContext.lastFrame()).not.toContain('⛶')
  })

  it('renders empty and populated local list dashboards', () => {
    const empty = render(
      <ListDashboard
        surface={projectTuiListSurface({
          kind: 'list',
          title: 'Skills',
          rows: [],
          emptyText:
            'No skills found\nCreate skills in .claude/skills/ or ~/.claude/skills/',
          selectedIndex: 0,
        })}
        width={80}
        screenReader={false}
      />,
    )
    expect(empty.lastFrame()).toContain('No skills found')
    expect(empty.lastFrame()).toContain('.claude/skills/')

    const populated = renderNormal(
      <ListDashboard
        surface={projectTuiListSurface({
          kind: 'list',
          title: 'Background',
          rows: [{ label: 'w1 [running] Review repository' }],
          emptyText: 'No tasks currently running',
          selectedIndex: 0,
        })}
        width={80}
        screenReader={false}
      />,
    )
    expect(populated.lastFrame()).toContain('❯ w1 [running] Review repository')
  })

  it('announces selected rows across legacy screen-reader dashboards', () => {
    const customTheme = render(
      <CustomThemeEditor
        model={projectTuiThemeSurface({
          kind: 'custom-theme-editor',
          theme: {
            name: 'Review theme',
            slug: 'review-theme',
            base: 'dark',
            overrides: {},
          },
          selectedIndex: 1,
          query: 'text',
        })}
        width={80}
        screenReader
      />,
    ).lastFrame()
    const list = render(
      <ListDashboard
        surface={projectTuiListSurface({
          kind: 'list',
          title: 'Background',
          rows: [{ label: 'w1 [running] Review repository' }, { label: 'w2' }],
          emptyText: 'No tasks currently running',
          selectedIndex: 0,
        })}
        width={80}
        screenReader
      />,
    ).lastFrame()
    const memory = render(
      <MemoryDashboard
        surface={projectTuiMemorySurface({
          autoMemoryEnabled: true,
          entries: [
            {
              kind: 'file',
              label: 'User memory',
              path: '/memory/CLAUDE.md',
              displayPath: '/memory/CLAUDE.md',
              scope: 'user',
            },
          ],
          selectedIndex: 0,
          openedIndex: null,
          dataPlane: 'native',
        })}
        width={80}
        screenReader
      />,
    ).lastFrame()
    const sessions = render(
      <SessionPicker
        model={projectTuiSessionPicker({
          choices: [{ sessionId: 'abc', name: 'Review', status: 'ready' }],
          query: '',
          selectedIndex: 0,
        })}
        screenReader
      />,
    ).lastFrame()

    expect(customTheme).toContain('Selected: ██ text')
    expect(list).toContain('Selected: w1 [running] Review repository')
    expect(memory).toContain('Selected: 1. User memory')
    expect(sessions).toContain('Selected: Review')
    expect(`${customTheme}${list}${memory}${sessions}`).not.toContain('❯')
  })

  it('announces selected rows without color even outside screen-reader mode', () => {
    const previousNoColor = process.env.NO_COLOR
    process.env.NO_COLOR = '1'
    try {
      const app = render(
        <TuiThemeProvider
          settings={{ theme: 'dark', syntaxHighlightingDisabled: false }}
        >
          <>
            <CustomThemeEditor
              model={projectTuiThemeSurface({
                kind: 'custom-theme-editor',
                theme: {
                  name: 'Review theme',
                  slug: 'review-theme',
                  base: 'dark',
                  overrides: {},
                },
                selectedIndex: 1,
                query: 'text',
              })}
              width={80}
              screenReader={false}
            />
            <ListDashboard
              surface={projectTuiListSurface({
                kind: 'list',
                title: 'Background',
                rows: [{ label: 'w1 [running] Review repository' }],
                emptyText: 'No tasks currently running',
                selectedIndex: 0,
              })}
              width={80}
              screenReader={false}
            />
            <MemoryDashboard
              surface={projectTuiMemorySurface({
                autoMemoryEnabled: true,
                entries: [
                  {
                    kind: 'file',
                    label: 'User memory',
                    path: '/memory/CLAUDE.md',
                    displayPath: '/memory/CLAUDE.md',
                    scope: 'user',
                  },
                ],
                selectedIndex: 0,
                openedIndex: null,
                dataPlane: 'native',
              })}
              width={80}
              screenReader={false}
            />
            <SessionPicker
              model={projectTuiSessionPicker({
                choices: [
                  { sessionId: 'abc', name: 'Review', status: 'ready' },
                ],
                query: '',
                selectedIndex: 0,
              })}
              screenReader={false}
            />
          </>
        </TuiThemeProvider>,
      )
      const frame = app.lastFrame() ?? ''
      expect(frame).toContain('Selected: ██ text')
      expect(frame).toContain('Selected: w1 [running] Review repository')
      expect(frame).toContain('Selected: 1. User memory')
      expect(frame).toContain('Selected: Review')
      expect(frame).not.toContain('❯')
      expectNoColorSgr(frame)
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previousNoColor
    }
  })

  it('renders hook events, matchers, details, and screen-reader selection', () => {
    const configuration = projectTuiHooks([
      {
        path: '/shared/settings.json',
        scope: 'user',
        value: {
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo inspect' }],
              },
            ],
          },
        },
      },
    ])
    const events = render(
      <HookDashboard
        surface={projectTuiHooksSurface({
          configuration,
          depth: 'events',
          eventIndex: 0,
          matcherIndex: 0,
          hookIndex: 0,
        })}
        width={100}
        screenReader={false}
      />,
    )
    expect(events.lastFrame()).toContain('1 hooks configured')
    expect(events.lastFrame()).toContain('❯ 1. PreToolUse (1)')
    expect(events.lastFrame()).toContain('↓ 5 more below')

    const hooks = render(
      <HookDashboard
        surface={projectTuiHooksSurface({
          configuration,
          depth: 'hooks',
          eventIndex: 0,
          matcherIndex: 0,
          hookIndex: 0,
        })}
        width={80}
        screenReader
      />,
    )
    expect(hooks.lastFrame()).toContain('PreToolUse - Matcher: Bash')
    expect(hooks.lastFrame()).toContain('Selected: 1. [command] echo inspect')
    expect(hooks.lastFrame()).not.toContain('────')

    const detail = render(
      <HookDashboard
        surface={projectTuiHooksSurface({
          configuration,
          depth: 'detail',
          eventIndex: 0,
          matcherIndex: 0,
          hookIndex: 0,
        })}
        width={80}
        screenReader={false}
      />,
    )
    expect(detail.lastFrame()).toContain('Hook details')
    expect(detail.lastFrame()).toContain('Event: PreToolUse')
    expect(detail.lastFrame()).toContain('Type: command')
    expect(detail.lastFrame()).toContain('echo inspect')
  })

  it('renders a bounded slash command palette with descriptions', () => {
    const model = projectTuiCommandPalette({
      commands: [
        {
          name: 'review',
          description: 'Review the current change.',
          source: 'command',
        },
        {
          name: 'check',
          description: 'Check the workspace.',
          source: 'skill',
        },
      ],
      query: '',
      selectedIndex: 1,
    })
    const app = render(
      <CommandPalette model={model} width={70} screenReader={false} />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('/review')
    expect(frame).toContain('Review the current change.')
    expect(frame).toContain('/check')
    expect(frame).not.toContain('╭')
  })

  it('keeps the bounded slash command palette on one row per command with long descriptions', () => {
    const model = projectTuiCommandPalette({
      commands: [
        {
          name: 'caveman-compress',
          description:
            'Compress the conversation with heavy-handed simplification, dropping nuance and detail aggressively to fit the context window',
          source: 'builtin',
        },
        {
          name: 'review',
          description: 'Review the current change.',
          source: 'command',
        },
      ],
      query: '',
      selectedIndex: 0,
    })
    const app = render(
      <CommandPalette model={model} width={80} screenReader={false} />,
    )
    const frame = app.lastFrame() ?? ''
    const lines = frame.split('\n')
    const firstCommandRow = lines.findIndex((line) =>
      line.includes('/caveman-compress'),
    )
    expect(firstCommandRow).toBeGreaterThanOrEqual(0)
    // The palette stays a one-row-per-command surface: no line escapes the
    // supplied width, and the second command label starts on the line directly
    // below the first command row instead of after a wrapped description.
    expect(lines.every((line) => line.length <= 80)).toBe(true)
    expect(lines[firstCommandRow + 1]).toContain('/review')
  })

  it('exposes selected command and actions to screen readers', () => {
    const model = projectTuiCommandPalette({
      commands: [
        { name: 'review', description: 'Review changes.', source: 'command' },
      ],
      query: '',
      selectedIndex: 0,
    })
    const app = render(<CommandPalette model={model} width={70} screenReader />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Selected: /review: Review changes.')
    expect(frame).toContain('Tab to complete')
    expect(frame).toContain('Enter to run')
    expect(frame).toContain('Esc to cancel')
  })

  it('renders a Claude-shaped file picker with an accessible selection', () => {
    const visual = render(
      <FilePicker
        entries={[
          { path: 'alpha.ts', directory: false },
          { path: 'src/', directory: true },
        ]}
        selectedIndex={1}
        width={80}
        screenReader={false}
      />,
    )
    expect(visual.lastFrame()).toContain('+ alpha.ts')
    expect(visual.lastFrame()).toContain('+ src/')

    const accessible = render(
      <FilePicker
        entries={[{ path: 'src/agent.ts', directory: false }]}
        selectedIndex={0}
        width={80}
        screenReader
      />,
    )
    expect(accessible.lastFrame()).toContain('Selected: src/agent.ts')
  })

  it('renders Claude-shaped agent entries in the mention picker', () => {
    const visual = render(
      <MentionPicker
        model={projectTuiMentionPicker({
          files: [],
          agents: [
            {
              name: 'reviewer',
              description: 'Reviews code for subtle regressions.',
            },
          ],
          query: '',
          selectedIndex: 0,
        })}
        width={80}
        screenReader={false}
      />,
    )
    expect(visual.lastFrame()).toContain(
      '* reviewer (agent) – Reviews code for subtle regressions.',
    )

    const narrow = render(
      <MentionPicker
        model={projectTuiMentionPicker({
          files: [],
          agents: [
            {
              name: 'reviewer',
              description:
                'Reviews code for subtle regressions across the repository.',
            },
          ],
          query: '',
          selectedIndex: 0,
        })}
        width={32}
        screenReader={false}
      />,
    )
    expect(narrow.lastFrame()?.split('\n').filter(Boolean)).toHaveLength(1)
    expect(narrow.lastFrame()).toContain('…')

    const accessible = render(
      <MentionPicker
        model={projectTuiMentionPicker({
          files: [],
          agents: [
            {
              name: 'reviewer',
              description: 'Reviews code for subtle regressions.',
            },
          ],
          query: '',
          selectedIndex: 0,
        })}
        width={80}
        screenReader
      />,
    )
    expect(accessible.lastFrame()).toContain('Selected agent: reviewer')
    expect(accessible.lastFrame()).toContain('Actions:')
    expect(accessible.lastFrame()).toContain(
      'Enter to select · Tab to complete',
    )
  })

  it('renders the shortcut grid and tabbed help surface', () => {
    const model = projectTuiHelpSurface({
      invocation: '?',
      tabIndex: 0,
      selectedIndex: 0,
      builtinCommands: [],
      customCommands: [],
    })
    const shortcuts = render(
      <ShortcutHelp
        shortcutGroups={
          model.activeContent.kind === 'general'
            ? model.activeContent.shortcutGroups
            : []
        }
        width={100}
      />,
    )
    expect(shortcuts.lastFrame()).toContain('! for bash mode')
    expect(shortcuts.lastFrame()).toContain('& for background')
    expect(shortcuts.lastFrame()).toContain('shift + tab to auto-accept edits')
    expect(shortcuts.lastFrame()).toContain('ctrl + o for verbose output')
    expect(shortcuts.lastFrame()).toContain('/keybindings to customize')
    const visualRows = (shortcuts.lastFrame() ?? '').split('\n')
    const backgroundRow = visualRows.find((row) =>
      row.includes('& for background'),
    )
    const sideQuestionRow = visualRows.find((row) =>
      row.includes('/btw for side question'),
    )
    expect(backgroundRow).toContain('& for background')
    expect(backgroundRow).not.toContain('ctrl + t')
    expect(backgroundRow).not.toContain('opt + p')
    expect(sideQuestionRow).toContain('ctrl + t to toggle tasks')
    expect(sideQuestionRow).toContain('opt + p to switch model')

    const help = render(
      <HelpMenu
        model={projectTuiHelpSurface({
          invocation: '?',
          tabIndex: 1,
          selectedIndex: 0,
          builtinCommands: [
            {
              name: 'resume',
              description: 'Resume a previous conversation',
            },
          ],
          customCommands: [],
        })}
        width={100}
        screenReader={false}
      />,
    )
    expect(help.lastFrame()).toContain(
      'Help  General  Commands  Custom commands',
    )
    expect(help.lastFrame()).toContain('Browse default commands')
    expect(help.lastFrame()).toContain('/resume')

    const windowed = render(
      <HelpMenu
        model={projectTuiHelpSurface({
          invocation: '/help',
          tabIndex: 1,
          selectedIndex: 11,
          builtinCommands: Array.from({ length: 12 }, (_, index) => ({
            name: `command-${index}`,
            description: `Description ${index}`,
          })),
          customCommands: [],
        })}
        width={100}
        screenReader={false}
      />,
    )
    expect(windowed.lastFrame()).toContain('/command-7')
    expect(windowed.lastFrame()).toContain('/command-11')
    expect(windowed.lastFrame()).not.toContain('/command-0')

    const screenReaderHelp = render(
      <HelpMenu model={model} width={30} screenReader />,
    )
    const screenReaderFrame = screenReaderHelp.lastFrame() ?? ''
    for (const shortcut of [
      '! for bash mode',
      '/ for commands',
      '@ for file paths',
      '& for background',
      '/btw for side question',
      'double tap esc to clear input',
      'shift + tab to auto-accept edits',
      'ctrl + o for verbose output',
      'ctrl + t to toggle tasks',
      'backslash (\\) + return (⏎) for newline',
      'ctrl + shift + _ to undo',
      'ctrl + z to suspend',
      'ctrl + v to paste images',
      'opt + p to switch model',
      'ctrl + s to stash prompt',
      'ctrl + g to edit in $EDITOR',
      '/keybindings to customize',
    ]) {
      expect(screenReaderFrame).toContain(shortcut)
    }
  })

  it('renders complete linear screen-reader help without visual decoration', () => {
    const general = projectTuiHelpSurface({
      invocation: '?',
      tabIndex: 0,
      selectedIndex: 0,
      builtinCommands: [],
      customCommands: [],
    })
    const generalHelp = render(
      <HelpMenu model={general} width={30} screenReader />,
    )
    const generalFrame = generalHelp.lastFrame() ?? ''
    expect(generalFrame).toContain('You: ?')
    expect(generalFrame).toContain('Current tab: General')
    expect(generalFrame).toContain('! for bash mode')
    expect(generalFrame).toContain(
      'Praxis documentation: https://github.com/Forest-Isle/Praxis',
    )
    expect(generalFrame).toContain('Left/Right to switch tabs')
    expect(generalFrame).toContain('Esc to close')
    expect(generalFrame).toContain(
      '(current) General · Commands · Custom commands',
    )
    expect(generalFrame).not.toContain('─')
    expect(generalFrame).not.toContain('❯')
    expect(generalFrame).not.toContain('←')
    expect(generalFrame).not.toContain('→')
    expect(generalFrame).not.toContain('↑')
    expect(generalFrame).not.toContain('↓')

    const commands = projectTuiHelpSurface({
      invocation: '/help',
      tabIndex: 1,
      selectedIndex: 11,
      builtinCommands: Array.from({ length: 12 }, (_, index) => ({
        name: `command-${index}`,
        description: `Description ${index}`,
      })),
      customCommands: [],
    })
    const commandHelp = render(
      <HelpMenu model={commands} width={30} screenReader />,
    )
    const commandFrame = commandHelp.lastFrame() ?? ''
    expect(commandFrame).toContain('You: /help')
    expect(commandFrame).toContain('Current tab: Commands')
    expect(commandFrame).toContain('1. /command-0 — Description 0')
    expect(commandFrame).toContain('6. /command-5 — Description 5')
    expect(commandFrame).toContain('12. /command-11 — Description 11')
    expect(commandFrame).toContain('Focused: 12. /command-11')
    expect(commandFrame).toContain('Up/Down to browse commands')
    expect(commandFrame).not.toContain('←')
    expect(commandFrame).not.toContain('→')
    expect(commandFrame).not.toContain('↑')
    expect(commandFrame).not.toContain('↓')
    expect(commandFrame).not.toContain('\n↓ ')
  })

  it('renders an accessible selected runtime menu', () => {
    const app = render(
      <SelectionMenu
        title="Select effort"
        description="Choose reasoning effort."
        options={[
          { label: 'low', description: 'Fast', selected: false },
          { label: 'high', description: 'Thorough', selected: true },
        ]}
        selectedIndex={1}
        footer="Enter applies · Esc cancels"
        width={70}
        screenReader={false}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Select effort')
    expect(frame).toContain('❯ 2. high ✔')
    expect(frame).toContain('Enter applies · Esc cancels')
  })

  it('renders semantic model and effort surfaces', () => {
    const model = render(
      <ModelMenu
        surface={projectTuiModelSurface({
          options: [
            {
              label: 'Default (recommended)',
              description: 'Use default',
              selected: true,
            },
            {
              label: 'custom',
              description: 'Current provider model',
              model: 'custom',
            },
          ],
          effort: 'high',
          selectedIndex: 1,
        })}
        width={70}
        screenReader
      />,
    )
    const effort = render(
      <EffortMenu
        surface={projectTuiEffortSurface({ effort: 'high', selectedIndex: 2 })}
        width={70}
        screenReader
      />,
    )
    expect(model.lastFrame()).toContain('Select model')
    expect(model.lastFrame()).toContain('Current: Default (recommended)')
    expect(model.lastFrame()).toContain('High effort (default)')
    expect(effort.lastFrame()).toContain('Select effort')
    expect(effort.lastFrame()).toContain('Current: high')
  })

  it('renders semantic leaf surfaces for visual and screen-reader paths', () => {
    const exportPanel = render(
      <LeafSurface
        surface={projectTuiLeafSurface({ kind: 'export', selectedIndex: 1 })}
        width={70}
        screenReader={false}
      />,
    )
    expect(exportPanel.lastFrame()).toContain('Export conversation')
    expect(exportPanel.lastFrame()).toContain('❯ 2. Save to file')

    const modelInput = render(
      <LeafSurface
        surface={projectTuiLeafSurface({ kind: 'model-input', value: '' })}
        width={70}
        screenReader
      />,
    )
    expect(modelInput.lastFrame()).toContain('Enter model ID')
    expect(modelInput.lastFrame()).toContain('›')
    expect(modelInput.lastFrame()).not.toContain('undefined')
  })

  it('announces generic menu focus and current value for screen readers', () => {
    const options = [
      { label: 'low', description: 'Fast', selected: false },
      { label: 'high', description: 'Thorough', selected: true },
    ]
    const low = render(
      <SelectionMenu
        title="Select effort"
        options={options}
        selectedIndex={0}
        footer="Enter applies · Esc cancels"
        width={70}
        screenReader
      />,
    ).lastFrame()
    const high = render(
      <SelectionMenu
        title="Select effort"
        options={options}
        selectedIndex={1}
        footer="Enter applies · Esc cancels"
        width={70}
        screenReader
      />,
    ).lastFrame()

    expect(low).toContain('Current: high')
    expect(low).toContain('Selected: 1. low')
    expect(high).toContain('Selected: 2. high')
    expect(`${low}${high}`).not.toContain('❯')
    expect(`${low}${high}`).not.toContain('✔')
  })

  it('renders composer effort, prompt, mode, and busy states', () => {
    const idle = render(
      <Composer
        input=""
        busy={false}
        status="ready"
        display={{ ...display, contextWindowTokens: 200 }}
        usage={{ inputTokens: 2, outputTokens: 1 }}
        costUsd={0.001}
        width={100}
        screenReader={false}
      />,
    )
    expect(idle.lastFrame()).toContain('● high · /effort')
    expect(idle.lastFrame()).toContain('❯ Try "review this project"')
    expect(idle.lastFrame()).toContain('permissions default')
    expect(idle.lastFrame()).toContain(
      'Context · 3 tokens / 200 (2%) · $0.001000',
    )

    const busy = render(
      <Composer
        input="ignored"
        busy
        status="streaming"
        display={display}
        width={60}
        screenReader={false}
      />,
    )
    expect(busy.lastFrame()).toContain('✳ streaming…')
    expect(busy.lastFrame()).toContain('esc to interrupt')

    const cursor = renderNormal(
      <Composer
        input="abXcd"
        cursor={2}
        busy={false}
        status="ready"
        display={display}
        width={60}
        screenReader={false}
      />,
    )
    expect(cursor.lastFrame()).toContain('❯ abXcd')

    const shell = render(
      <Composer
        input="pwd"
        cursor={3}
        shellMode
        busy={false}
        status="ready"
        display={display}
        width={60}
        screenReader={false}
      />,
    )
    expect(shell.lastFrame()).toContain('! pwd')
    expect(shell.lastFrame()).toContain('! for bash mode')
    expect(shell.lastFrame()).not.toContain('❯ pwd')

    const shellTranscript = render(
      <Transcript
        screenReader={false}
        activeText=""
        entries={transcriptEntries(
          [
            { kind: 'shell', callId: 'shell-1', command: 'pwd' },
            {
              kind: 'shell-result',
              callId: 'shell-1',
              stdout: '/tmp/project\n',
              stderr: '',
              isError: false,
            },
          ],
          'normal',
        )}
      />,
    )
    expect(shellTranscript.lastFrame()).toContain('! pwd')
    expect(shellTranscript.lastFrame()).toContain('⎿ /tmp/project')
  })

  it('colors the composer separators around the prompt when a session color is set', () => {
    const line = '─'.repeat(60)
    const base = render(
      <Composer
        input=""
        busy={false}
        status="ready"
        display={display}
        width={60}
        screenReader={false}
      />,
    )
    const colored = render(
      <Composer
        input=""
        busy={false}
        status="ready"
        display={display}
        width={60}
        screenReader={false}
        sessionColor="purple"
      />,
    )
    const baseFrame = base.lastFrame() ?? ''
    const coloredFrame = colored.lastFrame() ?? ''
    const baseLines = baseFrame.split('\n')
    const coloredLines = coloredFrame.split('\n')
    expect(baseLines[1]).toBe(line)
    expect(baseLines[3]).toBe(line)
    expect(coloredLines[1]).toBe(line)
    expect(coloredLines[3]).toBe(line)
    expect(coloredLines[2]).toContain('❯ ')
    expect(coloredFrame).toBe(baseFrame)
    expect(coloredFrame).not.toContain('Session color')
    expect(coloredFrame).not.toContain('purple')
  })

  it('renders the slash command argument hint dimmed beside the input', () => {
    const hint = '[red|blue|green|yellow|purple|orange|pink|cyan|default]'
    const trailing = renderNormal(
      <Composer
        input="/color "
        cursor={7}
        busy={false}
        status="ready"
        display={display}
        width={100}
        screenReader={false}
        commandArgumentHint={hint}
      />,
    )
    const trailingPlain = renderNormal(
      <Composer
        input="/color "
        cursor={7}
        busy={false}
        status="ready"
        display={display}
        width={100}
        screenReader={false}
      />,
    )
    expect(trailing.lastFrame()?.split('\n')[2]).toBe(`❯ /color  ${hint}`)
    expect(trailingPlain.lastFrame()).not.toContain(hint)

    const bare = renderNormal(
      <Composer
        input="/color"
        cursor={6}
        busy={false}
        status="ready"
        display={display}
        width={100}
        screenReader={false}
        commandArgumentHint={hint}
      />,
    )
    expect(bare.lastFrame()?.split('\n')[2]).toContain(`❯ /color  ${hint}`)
    expect(trailing.lastFrame()?.split('\n')[2]).toContain(hint)
  })

  it('renders the external editor wait state and footer outcomes', () => {
    const wait = render(<ExternalEditorWait screenReader={false} />)
    expect(wait.lastFrame()).toBe(
      '────────────────────────\nSave and close editor to continue...\n────────────────────────',
    )
    const accessibleWait = render(<ExternalEditorWait screenReader />)
    expect(accessibleWait.lastFrame()).toBe(
      'External editor open. Save and close it to continue.',
    )

    const success = render(
      <Composer
        input="edited"
        busy={false}
        status="ready"
        display={display}
        width={100}
        screenReader={false}
        footerMessage={{
          text: 'ctrl+g to edit in Editor-wrapper',
          isError: false,
        }}
      />,
    )
    expect(success.lastFrame()).toContain('ctrl+g to edit in Editor-wrapper')
    expect(success.lastFrame()).not.toContain('● high · /effort')

    const failure = render(
      <Composer
        input="original"
        busy={false}
        status="ready"
        display={display}
        width={100}
        screenReader={false}
        footerMessage={{
          text: 'Editor-fail quit unexpectedly (exit code 7)',
          isError: true,
        }}
      />,
    )
    expect(failure.lastFrame()).toContain(
      'Editor-fail quit unexpectedly (exit code 7)',
    )
    expect(failure.lastFrame()).not.toContain('● high · /effort')
  })

  it('keeps the composer footer on one bounded line at common widths', () => {
    const renderFooter = (
      width: number,
      overrides: Partial<ComponentProps<typeof Composer>> = {},
    ) => {
      const frame = render(
        <Composer
          input=""
          busy={false}
          status="ready"
          display={display}
          width={width}
          screenReader={false}
          {...overrides}
        />,
      ).lastFrame()
      return frame ?? ''
    }
    // A Composer without usage renders exactly five rows (blank top margin,
    // separator, prompt, separator, footer); a wrapped footer would add a sixth.
    const singleFooterRow = (frame: string) => {
      expect(frame.split('\n')).toHaveLength(5)
      return frame.split('\n')[4] ?? ''
    }

    const idle = (width: number) => singleFooterRow(renderFooter(width))

    // 100 columns keeps the full idle discoverability content including /effort.
    const at100 = idle(100)
    expect(at100).toContain('permissions default')
    expect(at100).toContain('? for shortcuts')
    expect(at100).toContain('← for agents')
    expect(at100).toContain('● high')
    expect(at100).toContain('/effort')

    // 80 columns keeps shortcuts/agents and effort without relying on a
    // wrapped thinking hint or the /effort suffix.
    const at80 = idle(80)
    expect(at80).toContain('permissions default')
    expect(at80).toContain('? for shortcuts')
    expect(at80).toContain('← for agents')
    expect(at80).toContain('● high')
    expect(at80).not.toContain('/effort')

    // 60 columns keeps a compact shortcuts hint and effort, dropping agents.
    const at60 = idle(60)
    expect(at60).toContain('permissions default')
    expect(at60).toContain('? for shortcuts')
    expect(at60).not.toContain('← for agents')
    expect(at60).toContain('● high')
    expect(at60).not.toContain('/effort')

    // 40 columns keeps permission state and effort, omitting optional hints.
    const at40 = idle(40)
    expect(at40).toContain('permissions default')
    expect(at40).toContain('● high')
    expect(at40).not.toContain('/effort')
    expect(at40).not.toContain('? for shortcuts')
    expect(at40).not.toContain('← for agents')

    // 32 columns keeps a compact mode indicator and effort.
    const at32 = idle(32)
    expect(at32).toContain('default')
    expect(at32).not.toContain('permissions default')
    expect(at32).toContain('● high')

    // A busy 40-column footer keeps an explicit cancel state without wrapping.
    const busyFrame = renderFooter(40, { busy: true, status: 'streaming' })
    const busyFooter = singleFooterRow(busyFrame)
    expect(busyFooter).toContain('esc to interrupt')
    expect(busyFooter).toContain('● high')
    expect(busyFooter).not.toContain('? for shortcuts')

    // An overlong error footer message renders on one clipped line. The test
    // harness strips color escapes, so layout (single row, clipped tail) is
    // the assertable part of the error-color contract.
    const longMessage = `Editor-fail quit unexpectedly: ${'detail '.repeat(30)}`
    const errorFrame = renderFooter(40, {
      footerMessage: { text: longMessage, isError: true },
    })
    const errorFooter = singleFooterRow(errorFrame)
    expect(errorFooter).toContain('Editor-fail quit')
    expect(errorFooter).not.toContain('detail detail')
  })

  it('keeps dialogs and session selection visually bounded', () => {
    const picker = renderNormal(
      <SessionPicker
        model={projectTuiSessionPicker({
          choices: [
            null,
            { sessionId: 'abc-123', name: 'Review', status: 'ready' },
          ],
          query: '',
          selectedIndex: 1,
        })}
        screenReader={false}
      />,
    )
    expect(picker.lastFrame()).toContain('❯ Review · abc-123 · ready')

    const dialog = render(
      <DialogFrame title="Allow Bash?" screenReader={false}>
        <Text>permission details</Text>
      </DialogFrame>,
    )
    expect(dialog.lastFrame()).toContain('╭')
    expect(dialog.lastFrame()).toContain('Allow Bash?')
  })

  it('keeps a long session picker focused around the selection', () => {
    const sessions = Array.from({ length: 14 }, (_, index) => ({
      sessionId: `session-${index}`,
      name: `Session ${index}`,
      status: 'ready',
    }))
    const app = renderNormal(
      <SessionPicker
        model={projectTuiSessionPicker({
          choices: sessions,
          query: '',
          selectedIndex: 11,
        })}
        screenReader={false}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('↑ 6 earlier')
    expect(frame).toContain('❯ Session 11')
    expect(frame).not.toContain('Session 0 ·')
  })

  it('removes decorative controls in screen-reader mode', () => {
    const composer = render(
      <Composer
        input="hello"
        busy={false}
        status="ready"
        display={display}
        width={80}
        screenReader
      />,
    )
    expect(composer.lastFrame()).toBe('Prompt: hello')

    const shellComposer = render(
      <Composer
        input="pwd"
        shellMode
        busy={false}
        status="ready"
        display={display}
        width={80}
        screenReader
      />,
    )
    expect(shellComposer.lastFrame()).toBe('Shell command: pwd')

    const transcript = render(
      <Transcript
        screenReader
        activeText=""
        entries={transcriptEntries(
          [{ kind: 'assistant', text: 'answer' }],
          'screen-reader',
        )}
      />,
    )
    expect(transcript.lastFrame()).toContain('Praxis:')
    expect(transcript.lastFrame()).not.toContain('✳')
  })

  it('keeps the semantic composer cursor visible without NO_COLOR decoration', () => {
    const previousNoColor = process.env.NO_COLOR
    const previousForceColor = process.env.FORCE_COLOR
    process.env.NO_COLOR = '1'
    try {
      const composer = render(
        <TuiThemeProvider
          settings={{ theme: 'dark', syntaxHighlightingDisabled: false }}
        >
          <Composer
            input="abc"
            cursor={1}
            busy={false}
            status="ready"
            display={display}
            width={60}
            screenReader={false}
          />
        </TuiThemeProvider>,
      )
      expect(composer.lastFrame()).toContain('❯ ab\u0332c')
      expectNoColorSgr(composer.lastFrame() ?? '')
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previousNoColor
      if (previousForceColor === undefined) delete process.env.FORCE_COLOR
      else process.env.FORCE_COLOR = previousForceColor
    }
  })
})
