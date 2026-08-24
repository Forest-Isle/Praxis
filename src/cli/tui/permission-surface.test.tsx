import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import { projectTuiPermissionSurface } from './permission-surface-model.js'
import { PermissionSurface } from './permission-surface.js'
import { TuiThemeProvider } from './theme.js'
import { projectTuiToolPermission } from './tool-permission.js'
import type { ModelToolCall } from '../../core/runtime.js'

afterEach(cleanup)

const call: ModelToolCall = {
  id: 'call-1',
  name: 'Bash',
  input: { command: 'npm test' },
}

function renderSurface(
  input: Parameters<typeof projectTuiPermissionSurface>[0],
  screenReader = true,
) {
  const model = projectTuiPermissionSurface(input)
  return render(
    <TuiThemeProvider
      settings={{ theme: 'auto', syntaxHighlightingDisabled: false }}
    >
      <PermissionSurface
        model={model}
        width={100}
        screenReader={screenReader}
      />
    </TuiThemeProvider>,
  ).lastFrame()
}

describe('PermissionSurface', () => {
  it('renders a dashboard with linear screen-reader semantics', () => {
    const model = projectTuiPermissionSurface({
      kind: 'permission-dashboard',
      tabIndex: 1,
      selectedIndex: 0,
      query: '',
      rules: [],
      recentDenied: [],
      workspaceDirectories: [{ path: '/workspace', original: true }],
    })
    const frame = render(
      <TuiThemeProvider
        settings={{ theme: 'auto', syntaxHighlightingDisabled: false }}
      >
        <PermissionSurface model={model} width={100} screenReader />
      </TuiThemeProvider>,
    ).lastFrame()
    expect(frame).toContain('Permissions')
    expect(frame).toContain('Current tab: Allow')
    expect(frame).toContain('Selected: 1. Add a new rule…')
    expect(frame).toContain('Enter selection [1-1]')
    expect(frame).toContain('Escape to cancel')
    expect(frame).not.toContain('❯')
    expect(frame).not.toContain('⌕')
  })

  it('renders management dialogs from models only', () => {
    const model = projectTuiPermissionSurface({
      kind: 'workspace-directory-delete',
      path: '/shared',
      selectedIndex: 1,
    })
    const frame = render(
      <TuiThemeProvider
        settings={{ theme: 'auto', syntaxHighlightingDisabled: false }}
      >
        <PermissionSurface model={model} width={100} screenReader />
      </TuiThemeProvider>,
    ).lastFrame()
    expect(frame).toContain('Remove directory from workspace?')
    expect(frame).toContain('2. No')
    expect(frame).toContain('Selected: 2. No')
    expect(frame).toContain('Enter selection [1-2]')
    expect(frame).toContain('Escape to cancel')
  })

  it('renders every permission discriminant with complete screen-reader actions', () => {
    const tool = projectTuiToolPermission(call, '/workspace', [])
    const cases: Array<Parameters<typeof projectTuiPermissionSurface>[0]> = [
      {
        kind: 'tool-request',
        model: tool,
        selection: 0,
        feedbackMode: false,
        feedback: '',
      },
      {
        kind: 'recovery-request',
        heading: 'Retry interrupted Bash?',
        display: 'Bash npm test',
        selection: 0,
        feedbackMode: false,
        feedback: '',
      },
      {
        kind: 'permission-dashboard',
        tabIndex: 1,
        selectedIndex: 0,
        query: '',
        rules: [],
        recentDenied: [],
        workspaceDirectories: [],
      },
      { kind: 'permission-rule-input', behavior: 'allow', value: '' },
      {
        kind: 'permission-scope',
        behavior: 'allow',
        rule: 'Bash(npm test:*)',
        selectedIndex: 0,
        settingsDirectory: '.claude',
      },
      {
        kind: 'permission-delete',
        rule: {
          behavior: 'allow',
          rule: 'Bash(npm test:*)',
          scope: 'project',
          path: '/workspace/.claude/settings.json',
        },
        selectedIndex: 0,
      },
      { kind: 'workspace-directory-input', value: '' },
      { kind: 'workspace-directory-delete', path: '/shared', selectedIndex: 0 },
    ]
    const frames = cases.map((input) => renderSurface(input))
    expect(frames[0]).toContain('Enter selection [1-3]')
    expect(frames[0]).toContain('Tab to amend')
    expect(frames[1]).toContain('Do you want to proceed?')
    expect(frames[1]).toContain('Enter selection [1-2]')
    expect(frames[1]).toContain('Tab to add feedback')
    expect(frames[2]).toContain('Current tab: Allow')
    expect(frames[2]).toContain('Enter selection [1-1]')
    expect(frames[3]).toContain('Add allow permission rule')
    expect(frames[3]).toContain('Enter to submit')
    expect(frames[4]).toContain('Where should this rule be saved?')
    expect(frames[4]).toContain('Enter selection [1-3]')
    expect(frames[5]).toContain('Delete allowed tool?')
    expect(frames[5]).toContain('Enter selection [1-2]')
    expect(frames[6]).toContain('Tab to complete')
    expect(frames[6]).toContain('Enter to add')
    expect(frames[7]).toContain('Remove directory from workspace?')
    for (const frame of frames) {
      expect(frame).toContain('Escape to cancel')
      expect(frame).not.toContain('❯')
    }
  })

  it('preserves visual tool and recovery footers without duplication', () => {
    const tool = renderSurface(
      {
        kind: 'tool-request',
        model: projectTuiToolPermission(call, '/workspace', []),
        selection: 0,
        feedbackMode: false,
        feedback: '',
      },
      false,
    )
    expect((tool ?? '').match(/Esc to cancel/g)).toHaveLength(1)
    expect(tool ?? '').not.toContain('Enter selection')

    const recovery = renderSurface(
      {
        kind: 'recovery-request',
        heading: 'Retry interrupted Bash?',
        display: 'Bash npm test',
        selection: 1,
        feedbackMode: true,
        feedback: '',
      },
      false,
    )
    expect(recovery).toContain('Do you want to proceed?')
    expect(recovery).toContain(
      'Enter to submit · Tab to collapse · Esc to cancel',
    )
    expect(recovery).toContain('› tell Praxis what to do differently')
  })

  it('announces feedback submission instead of a numeric selection', () => {
    const tool = renderSurface({
      kind: 'tool-request',
      model: projectTuiToolPermission(call, '/workspace', []),
      selection: 0,
      feedbackMode: true,
      feedback: 'Use the safer command',
    })
    expect(tool).toContain(
      'Enter to submit · Tab to collapse · Escape to cancel',
    )
    expect(tool).not.toContain('Enter selection')

    const recovery = renderSurface({
      kind: 'recovery-request',
      heading: 'Retry interrupted Bash?',
      display: 'Bash npm test',
      selection: 1,
      feedbackMode: true,
      feedback: '',
    })
    expect(recovery).toContain('Feedback: tell Praxis what to do differently')
    expect(recovery).toContain(
      'Enter to submit · Tab to collapse · Escape to cancel',
    )
    expect(recovery).not.toContain('Enter selection')
  })

  it('uses semantic dashboard statuses and valid empty actions', () => {
    const populated = renderSurface(
      {
        kind: 'permission-dashboard',
        tabIndex: 1,
        selectedIndex: 0,
        query: 'npm',
        rules: [
          {
            behavior: 'allow',
            rule: 'Bash(npm test:*)',
            scope: 'project',
            path: '/workspace/.claude/settings.json',
          },
        ],
        recentDenied: [],
        workspaceDirectories: [
          { path: '/workspace', original: true },
          { path: '/shared', original: false },
        ],
      },
      false,
    )
    expect(populated).toContain('⌕ npm')
    expect(populated).toContain('1. Add a new rule…')
    expect(populated).toContain('2. Bash(npm test:*)')
    expect(populated).toContain(
      '↑/↓ navigate · Enter to select · ←/→ to switch · Esc to cancel',
    )

    const empty = renderSurface({
      kind: 'permission-dashboard',
      tabIndex: 0,
      selectedIndex: 99,
      query: '',
      rules: [],
      recentDenied: [],
      workspaceDirectories: [],
    })
    expect(empty).toContain('No recent denials.')
    expect(empty?.match(/No recent denials\./g)).toHaveLength(1)
    expect(empty).toContain('Use left/right arrows to switch tabs')
    expect(empty).not.toContain('Enter selection')
    expect(empty).not.toContain('r to retry')

    const filtered = renderSurface({
      kind: 'permission-dashboard',
      tabIndex: 1,
      selectedIndex: 0,
      query: 'missing',
      rules: [
        {
          behavior: 'allow',
          rule: 'Bash(npm test:*)',
          scope: 'project',
          path: '/workspace/.claude/settings.json',
        },
      ],
      recentDenied: [],
      workspaceDirectories: [],
    })
    expect(filtered).toContain('No matching permission rules.')

    const retrying = renderSurface(
      {
        kind: 'permission-dashboard',
        tabIndex: 0,
        selectedIndex: 0,
        query: '',
        rules: [],
        retryingDeniedId: 'denied-1',
        recentDenied: [
          {
            id: 'denied-1',
            call,
            display: 'Delete target',
            reason: 'Classifier policy',
            sessionId: 'session-1',
          },
        ],
        workspaceDirectories: [],
      },
      false,
    )
    expect(retrying).toContain('1. ✔ Delete target (retry)')
    expect(retrying).not.toContain('✘ ✔')
    const retryingReader = renderSurface({
      kind: 'permission-dashboard',
      tabIndex: 0,
      selectedIndex: 0,
      query: '',
      rules: [],
      retryingDeniedId: 'denied-1',
      recentDenied: [
        {
          id: 'denied-1',
          call,
          display: 'Delete target',
          reason: 'Classifier policy',
          sessionId: 'session-1',
        },
      ],
      workspaceDirectories: [],
    })
    expect(retryingReader).toContain('Retrying: Delete target')
    expect(retryingReader).not.toContain('✔')
    expect(retryingReader).not.toContain('✘')
  })

  it('preserves the dashboard no-selection sentinel until navigation', () => {
    const frame = renderSurface({
      kind: 'permission-dashboard',
      tabIndex: 4,
      selectedIndex: -1,
      query: '',
      rules: [],
      recentDenied: [],
      workspaceDirectories: [
        { path: '/workspace', original: true },
        { path: '/shared', original: false },
      ],
    })
    expect(frame).not.toContain('Selected:')
    expect(frame).toContain('Use down arrow to select')
    expect(frame).not.toContain('Enter selection')
  })

  it('keeps the original-workspace label intact at 100 columns', () => {
    const frame = renderSurface(
      {
        kind: 'permission-dashboard',
        tabIndex: 4,
        selectedIndex: -1,
        query: '',
        rules: [],
        recentDenied: [],
        workspaceDirectories: [
          {
            path: '/private/var/folders/hb/wf7dvbf939q4s9jgsdwszrc40000gn/T/praxis-tui-compat-Mcw8Tw/work',
            original: true,
          },
          { path: '/shared', original: false },
        ],
      },
      false,
    )
    expect(frame).toContain('Original working directory')
  })
})
