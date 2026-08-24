import { describe, expect, it } from 'vitest'

import type { ModelToolCall } from '../../core/runtime.js'
import { projectTuiToolPermission } from './tool-permission.js'
import {
  projectTuiPermissionSurface,
  type TuiPermissionDashboardModel,
  type TuiPermissionSurfaceInput,
} from './permission-surface-model.js'

const rule = {
  behavior: 'allow' as const,
  rule: 'Bash(npm test:*)',
  scope: 'project' as const,
  path: '/workspace/.claude/settings.json',
}

const call: ModelToolCall = {
  id: 'call-1',
  name: 'Bash',
  input: { command: 'npm test' },
}

const dashboard = (
  input: Parameters<typeof projectTuiPermissionSurface>[0],
): TuiPermissionDashboardModel => {
  const model = projectTuiPermissionSurface(input)
  if (model.kind !== 'permission-dashboard')
    throw new Error('expected dashboard')
  return model
}

describe('permission surface projection', () => {
  it('projects each permission discriminant with semantic headings and actions', () => {
    const tool = projectTuiToolPermission(call, '/workspace', [])
    const inputs: TuiPermissionSurfaceInput[] = [
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
        selection: 1,
        feedbackMode: false,
        feedback: '',
      },
      {
        kind: 'permission-dashboard',
        tabIndex: 1,
        selectedIndex: 0,
        query: '',
        rules: [rule],
        recentDenied: [],
        workspaceDirectories: [{ path: '/workspace', original: true }],
      },
      { kind: 'permission-rule-input', behavior: 'allow', value: '' },
      {
        kind: 'permission-scope',
        behavior: 'allow',
        rule: 'Bash(npm test:*)',
        selectedIndex: 0,
        settingsDirectory: '.claude',
      },
      { kind: 'permission-delete', rule, selectedIndex: 0 },
      { kind: 'workspace-directory-input', value: '' },
      { kind: 'workspace-directory-delete', path: '/shared', selectedIndex: 0 },
    ]
    const models = inputs.map(projectTuiPermissionSurface)
    expect(models.map((model) => model.kind)).toEqual([
      'tool-request',
      'recovery-request',
      'permission-dashboard',
      'permission-rule-input',
      'permission-scope',
      'permission-delete',
      'workspace-directory-input',
      'workspace-directory-delete',
    ])
    expect(models[0]).toMatchObject({
      heading: 'Bash command',
      range: { min: 1, max: 3 },
      actions: [{ label: 'Enter to select' }, { label: 'Tab to amend' }],
    })
    expect(models[1]).toMatchObject({
      heading: 'Retry interrupted Bash?',
      question: 'Do you want to proceed?',
      range: { min: 1, max: 2 },
      actions: [
        { label: 'Enter to confirm' },
        { label: 'Tab to add feedback' },
      ],
    })
    expect(models[2]).toMatchObject({
      rows: [
        { label: 'Add a new rule…', selected: true },
        { label: 'Bash(npm test:*)', selected: false },
      ],
    })
    if (models[2]?.kind !== 'permission-dashboard')
      throw new Error('expected dashboard')
    expect(models[2].tabs.find((tab) => tab.current)).toMatchObject({
      label: 'Allow',
    })
    expect(models[2].actions[1]).toMatchObject({ label: 'Enter to select' })
    expect(models[3]).toMatchObject({
      heading: 'Add allow permission rule',
      actions: [{ label: 'Enter to submit' }],
    })
    expect(models[4]).toMatchObject({
      heading: 'Where should this rule be saved?',
      range: { min: 1, max: 3 },
    })
    if (models[4]?.kind !== 'permission-scope')
      throw new Error('expected scope')
    expect(models[4].options[0]).toMatchObject({
      label: 'Project settings (local)',
    })
    expect(models[5]).toMatchObject({
      heading: 'Delete allowed tool?',
      question: 'Are you sure you want to delete this permission rule?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    })
    expect(models[6]).toMatchObject({
      heading: 'Add directory to workspace',
      actions: [{ label: 'Tab to complete' }, { label: 'Enter to add' }],
    })
    expect(models[7]).toMatchObject({
      heading: 'Remove directory from workspace?',
      options: [{ label: 'Yes' }, { label: 'No' }],
    })
  })

  it('normalizes non-finite, fractional, negative, and oversized selections', () => {
    const base = {
      kind: 'permission-dashboard' as const,
      tabIndex: Number.NaN,
      selectedIndex: Number.POSITIVE_INFINITY,
      query: '',
      rules: [rule],
      recentDenied: [],
      workspaceDirectories: [],
    }
    expect(dashboard(base).tabIndex).toBe(0)
    expect(dashboard({ ...base, tabIndex: 2.9 }).tabIndex).toBe(2)
    expect(dashboard({ ...base, tabIndex: -2 }).tabIndex).toBe(0)
    expect(dashboard({ ...base, tabIndex: 99 }).tabIndex).toBe(4)
    const selectionBase = { ...base, tabIndex: 1 as number }
    expect(
      dashboard({ ...selectionBase, selectedIndex: -5 }).rows.findIndex(
        (row) => row.selected,
      ),
    ).toBe(-1)
    expect(
      dashboard({ ...selectionBase, selectedIndex: 1.9 }).rows.findIndex(
        (row) => row.selected,
      ),
    ).toBe(1)
    const numericModels = [
      projectTuiPermissionSurface({
        kind: 'tool-request',
        model: projectTuiToolPermission(call, '/workspace', []),
        selection: Number.NaN,
        feedbackMode: false,
        feedback: '',
      }),
      projectTuiPermissionSurface({
        kind: 'recovery-request',
        display: 'Bash npm test',
        selection: Number.POSITIVE_INFINITY,
        feedbackMode: false,
        feedback: '',
      }),
      projectTuiPermissionSurface({
        kind: 'permission-scope',
        behavior: 'allow',
        rule: 'Bash(npm test:*)',
        selectedIndex: -10,
        settingsDirectory: '.claude',
      }),
      projectTuiPermissionSurface({
        kind: 'permission-delete',
        rule,
        selectedIndex: 99.8,
      }),
      projectTuiPermissionSurface({
        kind: 'workspace-directory-delete',
        path: '/shared',
        selectedIndex: 99.8,
      }),
    ]
    expect(
      numericModels.map((model) =>
        'selectedIndex' in model ? model.selectedIndex : -99,
      ),
    ).toEqual([0, 0, 0, 1, 1])
  })

  it('uses an empty range and no selected row for empty tabs', () => {
    const model = dashboard({
      kind: 'permission-dashboard',
      tabIndex: 1,
      selectedIndex: 999,
      query: 'not-found',
      rules: [rule],
      recentDenied: [],
      workspaceDirectories: [],
    })
    expect(model.rows).toHaveLength(1)
    expect(model.rows[0]?.label).toBe('Add a new rule…')
    expect(model.rows[0]?.selected).toBe(true)
    expect(model.range).toEqual({ min: 1, max: 1 })

    const recent = dashboard({
      kind: 'permission-dashboard',
      tabIndex: 0,
      selectedIndex: 9,
      query: '',
      rules: [],
      recentDenied: [],
      workspaceDirectories: [],
    })
    expect(recent).toMatchObject({
      rows: [],
      range: { min: 0, max: 0 },
      emptyState: 'No recent denials.',
      actions: [{ label: '←/→ to switch' }],
    })

    const workspace = dashboard({
      kind: 'permission-dashboard',
      tabIndex: 4,
      selectedIndex: 2,
      query: '',
      rules: [],
      recentDenied: [],
      workspaceDirectories: [
        { path: '/workspace', original: true },
        { path: '/shared', original: false },
      ],
    })
    expect(workspace).toMatchObject({
      originalWorkspace: { label: '/workspace' },
      rows: [{ label: '/shared' }, { label: 'Add directory…', selected: true }],
      range: { min: 1, max: 2 },
    })

    const filtered = dashboard({
      kind: 'permission-dashboard',
      tabIndex: 1,
      selectedIndex: 0,
      query: 'missing',
      rules: [rule],
      recentDenied: [],
      workspaceDirectories: [],
    })
    expect(filtered.emptyState).toBe('No matching permission rules.')
  })

  it('does not mutate source collections or tool models', () => {
    const rules = [rule]
    const workspaces = [{ path: '/workspace', original: true }]
    const model = projectTuiToolPermission(call, '/workspace', [])
    const before = JSON.stringify({ rules, workspaces, model })
    projectTuiPermissionSurface({
      kind: 'permission-dashboard',
      tabIndex: 4,
      selectedIndex: 0,
      query: '',
      rules,
      recentDenied: [],
      workspaceDirectories: workspaces,
    })
    projectTuiPermissionSurface({
      kind: 'tool-request',
      model,
      selection: 0,
      feedbackMode: false,
      feedback: '',
    })
    expect(JSON.stringify({ rules, workspaces, model })).toBe(before)
  })

  it('preserves exact rule descriptions, paths, and status semantics', () => {
    const scope = projectTuiPermissionSurface({
      kind: 'permission-scope',
      behavior: 'allow',
      rule: 'Bash(npm test:*)',
      selectedIndex: 0,
      settingsDirectory: '.claude',
    })
    if (scope.kind !== 'permission-scope') throw new Error('expected scope')
    expect(scope.options[2]).toMatchObject({
      description: 'Saved in ~/.claude/settings.json',
    })
    const deletion = projectTuiPermissionSurface({
      kind: 'permission-delete',
      rule,
      selectedIndex: 0,
    })
    if (deletion.kind !== 'permission-delete')
      throw new Error('expected deletion')
    expect(deletion.description).toBe('Any Bash command starting with npm test')
    const retrying = dashboard({
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
    expect(retrying.rows[0]).toMatchObject({
      status: 'retrying',
      label: 'Delete target',
    })
  })
})
