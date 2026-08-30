import { describe, expect, it } from 'vitest'

import { projectTuiCommandPalette } from './command-palette-model.js'
import { projectTuiHelpSurface } from './help-surface-model.js'
import { projectTuiLeafSurface } from './leaf-surface-model.js'
import { projectTuiMentionPicker } from './mention-picker-model.js'
import { projectTuiPermissionSurface } from './permission-surface-model.js'
import type { TuiPresentationEnvironment } from './presentation-environment.js'
import {
  projectQuietScreenFrame,
  type QuietScreenProjectionInput,
  type QuietScreenSurfaces,
} from './quiet-screen-projector.js'
import { projectTuiSessionPicker } from './session-picker-model.js'
import { projectTuiToolPermission } from './tool-permission.js'
import type { TuiScreenForeground, TuiScreenModel } from './tui-screen-model.js'

const presentation = (
  columns = 80,
  rows: number | undefined = 24,
  screenReader = false,
): TuiPresentationEnvironment => ({
  kind: screenReader ? 'screen-reader' : 'fullscreen',
  viewport: { columns, rows, revision: 0, source: 'override' },
  fixedViewport: !screenReader,
  screenReader,
})

function conversationScreen(
  foreground: TuiScreenForeground<QuietScreenSurfaces> = {
    kind: 'compose',
    overlays: [],
  },
  environment: TuiPresentationEnvironment = presentation(),
): TuiScreenModel<QuietScreenSurfaces> {
  return {
    presentation: environment,
    body: {
      kind: 'conversation',
      intro: 'none',
      resumed: false,
      freshSession: false,
      hasConversationHistory: false,
      transcript: {
        entries: [],
        rows: [],
        pageRows: 12,
        maxScrollOffset: 0,
        scrollOffset: 0,
        readingMode: environment.screenReader ? 'screen-reader' : 'normal',
        active: { text: '', thinking: '', visible: true },
      },
      foreground,
    },
  }
}

function project(
  screen: TuiScreenModel<QuietScreenSurfaces>,
  overrides: Partial<Omit<QuietScreenProjectionInput, 'screen'>> = {},
) {
  return projectQuietScreenFrame({
    screen,
    composerText: 'hello',
    composerCursor: 2,
    shellMode: false,
    busy: false,
    status: 'Ready',
    ...overrides,
  })
}

const frameText = (frame: ReturnType<typeof projectQuietScreenFrame>) =>
  frame.lines
    .map((row) => row.segments.map((segment) => segment.text).join(''))
    .join('\n')

describe('projectQuietScreenFrame', () => {
  it('projects plain and shell composers with semantic cursors', () => {
    const normal = project(conversationScreen())
    expect(normal.lines.map((row) => row.key)).toEqual([
      'quiet:composer',
      'quiet:status',
    ])
    expect(frameText(normal)).toContain('❯ hello')
    expect(normal.cursor).toEqual({ rowKey: 'quiet:composer', column: 4 })

    const shell = project(conversationScreen(), {
      composerText: 'echo',
      composerCursor: 1,
      shellMode: true,
    })
    expect(frameText(shell)).toContain('! echo')
    expect(shell.cursor).toEqual({ rowKey: 'quiet:composer', column: 3 })
  })

  it('routes session selection through choice rows and suppresses composer', () => {
    const surface = projectTuiSessionPicker({
      choices: [
        null,
        { sessionId: 'session-1', name: 'Alpha', status: 'idle' },
      ],
      query: '',
      selectedIndex: 1,
    })
    const screen: TuiScreenModel<QuietScreenSurfaces> = {
      presentation: presentation(),
      body: { kind: 'session-picker', surface },
    }
    const frame = project(screen)
    expect(frame.lines.map((row) => row.key)).toContain(
      'quiet:session-picker:heading',
    )
    expect(frameText(frame)).toContain('❯ Alpha')
    expect(frame.lines.some((row) => row.key === 'quiet:composer')).toBe(false)
    expect(frame.cursor).toBeUndefined()
  })

  it('renders priority permission decisions as minimal English choices', () => {
    const tool = projectTuiToolPermission(
      { id: 'call-1', name: 'Bash', input: { command: 'npm test' } },
      '/workspace',
      [],
    )
    const surface = projectTuiPermissionSurface({
      kind: 'tool-request',
      model: tool,
      selection: 0,
      feedbackMode: false,
      feedback: '',
    })
    const frame = project(
      conversationScreen({
        kind: 'priority',
        surface: { kind: 'permission', surface },
      }),
    )
    const output = frameText(frame)
    expect(frame.lines[0]?.key).toBe('quiet:permission:heading')
    expect(output).toContain('Allow once')
    expect(output).toContain('Deny')
    expect(output.split('❯').length - 1).toBe(1)
    expect(output).toContain('↑/↓ select  Enter confirm  Esc cancel')
    expect(output).not.toMatch(/\p{Script=Han}/u)
    expect(frame.cursor).toBeUndefined()
  })

  it('keeps pending rows visible while priority focus replaces the composer', () => {
    const tool = projectTuiToolPermission(
      { id: 'call-1', name: 'Bash', input: { command: 'npm test' } },
      '/workspace',
      [],
    )
    const frame = project(
      conversationScreen({
        kind: 'priority',
        surface: {
          kind: 'permission',
          surface: projectTuiPermissionSurface({
            kind: 'tool-request',
            model: tool,
            selection: 0,
            feedbackMode: false,
            feedback: '',
          }),
        },
      }),
      { pendingItems: [{ id: 'pending-1', kind: 'steering', text: 'wait' }] },
    )
    expect(frame.lines.map((row) => row.key)).toContain(
      'quiet:pending:pending-1',
    )
    expect(frame.lines.some((row) => row.key === 'quiet:composer')).toBe(false)
  })

  it('dispatches permission, operational, and settings secondary surfaces', () => {
    const permission = projectTuiPermissionSurface({
      kind: 'permission-dashboard',
      tabIndex: 0,
      selectedIndex: 0,
      query: '',
      rules: [],
      recentDenied: [],
      workspaceDirectories: [],
    })
    const permissionFrame = project(
      conversationScreen({ kind: 'secondary', surface: permission }),
    )
    expect(permissionFrame.lines.map((row) => row.key)).toContain(
      'quiet:dashboard:heading',
    )

    const help = projectTuiHelpSurface({
      invocation: '?',
      tabIndex: 0,
      selectedIndex: 0,
      builtinCommands: [],
      customCommands: [],
    })
    const helpFrame = project(
      conversationScreen({ kind: 'secondary', surface: help }),
    )
    expect(helpFrame.lines.map((row) => row.key)).toContain(
      'quiet:help:heading',
    )

    const leaf = projectTuiLeafSurface({ kind: 'export', selectedIndex: 1 })
    const leafFrame = project(
      conversationScreen({ kind: 'secondary', surface: leaf }),
    )
    expect(leafFrame.lines.map((row) => row.key)).toContain(
      'quiet:export:heading',
    )
  })

  it('projects an English bounded error row for an unsupported focus surface', () => {
    const valid = projectTuiLeafSurface({ kind: 'export', selectedIndex: 0 })
    const screen = conversationScreen({ kind: 'secondary', surface: valid })
    ;(
      screen.body as unknown as { foreground: { surface: unknown } }
    ).foreground.surface = {
      kind: 'future-surface',
    }
    const before = structuredClone(screen)
    const frame = project(screen)
    expect(frame.lines.map((row) => row.key)).toContain(
      'quiet:projection-error',
    )
    const error = frame.lines.find(
      (row) => row.key === 'quiet:projection-error',
    )
    expect(error?.segments[0]).toEqual({
      text: 'Unable to render this view. Press Esc to return.',
      role: 'error',
    })
    expect(error?.accessibleText).toBe(
      'Unable to render this view. Press Esc to return.',
    )
    expect(frame.lines.length).toBeLessThanOrEqual(24)
    expect(screen).toEqual(before)
  })

  it('uses fixed overlay precedence independent of array order', () => {
    const command = projectTuiCommandPalette({
      commands: [{ name: 'review', description: 'Review', source: 'builtin' }],
      query: '',
      selectedIndex: 0,
    })
    const mention = projectTuiMentionPicker({
      files: [{ path: 'src/a.ts', directory: false }],
      agents: [],
      query: '',
      selectedIndex: 0,
    })
    const exit = { kind: 'exit-confirmation' as const }
    const exitFrame = project(
      conversationScreen({
        kind: 'compose',
        overlays: [command, exit, mention],
      }),
    )
    expect(exitFrame.lines.map((row) => row.key)).toContain(
      'quiet:exit:heading',
    )
    expect(frameText(exitFrame)).not.toContain('Commands')
    expect(frameText(exitFrame)).not.toContain('Mentions')

    const mentionFrame = project(
      conversationScreen({
        kind: 'compose',
        overlays: [command, mention],
      }),
    )
    expect(mentionFrame.lines.map((row) => row.key)).toContain(
      'quiet:mention-picker:heading',
    )
    expect(frameText(mentionFrame)).not.toContain('Commands')
  })

  it('keeps screen-reader choices accessible and removes visual cursor state', () => {
    const surface = projectTuiSessionPicker({
      choices: [null],
      query: '',
      selectedIndex: 0,
    })
    const screen: TuiScreenModel<QuietScreenSurfaces> = {
      presentation: presentation(80, undefined, true),
      body: { kind: 'session-picker', surface },
    }
    const frame = project(screen)
    expect(frameText(frame)).toContain('Selected: Start a new session')
    expect(frame.lines.at(-2)?.accessibleText).toContain('up and down arrows')
    expect(frame.cursor).toBeUndefined()
  })

  it('resolves density and bounds finite viewports while normalizing invalid rows', () => {
    const tiny = project(conversationScreen(undefined, presentation(39, 2)))
    expect(tiny.density).toBe('minimal')
    expect(tiny.rows).toBe(2)
    expect(tiny.lines).toHaveLength(2)

    const help = projectTuiHelpSurface({
      invocation: '?',
      tabIndex: 0,
      selectedIndex: 0,
      builtinCommands: [],
      customCommands: [],
    })
    const invalidRows = project(
      conversationScreen(
        { kind: 'secondary', surface: help },
        presentation(100, Number.NaN),
      ),
    )
    expect(invalidRows.density).toBe('full')
    expect(invalidRows.rows).toBe(invalidRows.lines.length)
    expect(invalidRows.lines.length).toBeGreaterThan(10)
  })

  it('does not mutate screen or surface inputs', () => {
    const surface = projectTuiLeafSurface({ kind: 'export', selectedIndex: 0 })
    const screen = conversationScreen({ kind: 'secondary', surface })
    const before = structuredClone(screen)
    project(screen, { status: 'Changed', busy: true })
    expect(screen).toEqual(before)
  })
})
