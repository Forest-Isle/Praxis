import { describe, expect, it } from 'vitest'

import { projectTuiCommandPalette } from './command-palette-model.js'
import { projectTuiDecisionSurface } from './decision-surface-model.js'
import type { TuiElicitationSurfaceModel } from './mcp-elicitation-surface-model.js'
import { projectQuietChoiceRows } from './quiet-choice-rows.js'
import {
  projectTuiPermissionSurface,
  type TuiPermissionSurfaceInput,
} from './permission-surface-model.js'
import { projectTuiToolPermission } from './tool-permission.js'

const text = (rows: ReturnType<typeof projectQuietChoiceRows>) =>
  rows
    .flatMap((row) => [
      ...row.segments.map((segment) => segment.text),
      row.accessibleText ?? '',
    ])
    .join('\n')

const occurrences = (value: string, expected: string) =>
  value.split(expected).length - 1

const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error(`Missing ${label}`)
  return value
}

const rule = {
  behavior: 'allow' as const,
  rule: 'Bash(npm test:*)',
  scope: 'project' as const,
  path: '/workspace/.praxis/settings.json',
}

const tool = projectTuiToolPermission(
  {
    id: 'call-1',
    name: 'Bash',
    input: { command: 'npm test' },
  },
  '/workspace',
  [],
)

const permissionInputs: readonly TuiPermissionSurfaceInput[] = [
  {
    kind: 'tool-request',
    model: tool,
    selection: 0,
    feedbackMode: false,
    feedback: '',
  },
  {
    kind: 'recovery-request',
    display: 'Bash npm test',
    selection: 1,
    feedbackMode: false,
    feedback: '',
  },
  {
    kind: 'permission-dashboard',
    tabIndex: 1,
    selectedIndex: 0,
    query: 'npm',
    rules: [rule],
    recentDenied: [],
    workspaceDirectories: [{ path: '/workspace', original: true }],
  },
  { kind: 'permission-rule-input', behavior: 'allow', value: 'Bash(npm)' },
  {
    kind: 'permission-scope',
    behavior: 'allow',
    rule: 'Bash(npm test:*)',
    selectedIndex: 0,
    settingsDirectory: '.praxis',
  },
  { kind: 'permission-delete', rule, selectedIndex: 0 },
  { kind: 'workspace-directory-input', value: '/shared' },
  { kind: 'workspace-directory-delete', path: '/shared', selectedIndex: 0 },
]

describe('quiet choice rows', () => {
  it('serializes every permission discriminant as English control-safe focus rows without mutation', () => {
    expect(permissionInputs).toHaveLength(8)
    for (const input of permissionInputs) {
      const model = projectTuiPermissionSurface(input)
      const before = structuredClone(model)
      const rows = projectQuietChoiceRows(model, { density: 'standard' })
      const output = text(rows)
      expect(rows.length, model.kind).toBeGreaterThan(1)
      expect(
        rows.every((row) => row.region === 'focus'),
        model.kind,
      ).toBe(true)
      expect(output, model.kind).not.toMatch(/\p{Script=Han}/u)
      expect(output, model.kind).not.toContain('\u001b')
      expect(output, model.kind).not.toContain('\u0007')
      expect(model, model.kind).toEqual(before)
    }
  })

  it('uses stable permission selection keys and one simple decision footer', () => {
    const makeRecovery = (selection: number, screenReader = false) =>
      projectQuietChoiceRows(
        projectTuiPermissionSurface({
          kind: 'recovery-request',
          display: 'Bash\u001b[31m npm test\u001b[0m',
          selection,
          feedbackMode: false,
          feedback: '',
        }),
        { density: 'standard', screenReader },
      )
    const first = makeRecovery(0)
    const second = makeRecovery(1)
    expect(first.map((row) => row.key)).toEqual(second.map((row) => row.key))
    expect(text(first)).toContain('❯ Yes')
    expect(text(second)).toContain('❯ No')
    expect(
      occurrences(text(first), '↑/↓ select  Enter confirm  Esc cancel'),
    ).toBe(1)
    expect(text(first)).not.toContain('\u001b')
    expect(text(makeRecovery(0, true))).toContain('Selected: Yes')
    expect(makeRecovery(0, true).at(-1)?.accessibleText).toBe(
      'Use up and down arrows to select. Press Enter to confirm. Press Escape to cancel.',
    )
  })

  it('uses concise imperative labels for tool permission actions', () => {
    const rows = projectQuietChoiceRows(
      projectTuiPermissionSurface(
        required(permissionInputs[0], 'permission input'),
      ),
      { density: 'standard' },
    )
    const output = text(rows)
    expect(output).toContain('Allow once')
    expect(output).toContain('Deny')
    expect(output).not.toMatch(/❯?\s*Yes(?:,|$)/mu)
  })

  it('uses populated and empty permission-dashboard controls honestly', () => {
    const populatedModel = projectTuiPermissionSurface(
      required(permissionInputs[2], 'permission dashboard input'),
    )
    if (populatedModel.kind !== 'permission-dashboard')
      throw new Error('expected dashboard')
    const populated = projectQuietChoiceRows(populatedModel, {
      density: 'standard',
    })
    expect(populated.at(-1)?.segments[0]?.text).toBe(
      '↑/↓ select  Enter open  Esc close',
    )
    expect(populated.at(-1)?.segments[0]?.text).not.toContain('←/→')
    expect(populated.at(-1)?.accessibleText).toContain('left and right arrows')

    const emptyModel = projectTuiPermissionSurface({
      kind: 'permission-dashboard',
      tabIndex: 0,
      selectedIndex: 99,
      query: '',
      rules: [],
      recentDenied: [],
      workspaceDirectories: [],
    })
    if (emptyModel.kind !== 'permission-dashboard')
      throw new Error('expected empty dashboard')
    const empty = projectQuietChoiceRows(emptyModel, { density: 'compact' })
    expect(text(empty)).toContain('No recent denials.')
    expect(empty.at(-1)?.segments[0]?.text).toBe('Esc close')
    expect(empty.at(-1)?.accessibleText).not.toContain('Press Enter')
    expect(text(empty)).not.toContain(emptyModel.description)
  })

  it('uses warning semantics for retrying dashboard rows while preserving selection focus', () => {
    const input: TuiPermissionSurfaceInput = {
      kind: 'permission-dashboard',
      tabIndex: 0,
      selectedIndex: 0,
      query: '',
      rules: [],
      recentDenied: [
        {
          id: 'denied',
          call: {
            id: 'call-denied',
            name: 'Bash',
            input: { command: 'rm -rf /tmp/target' },
          },
          display: 'Delete target',
          reason: 'Classifier policy',
          sessionId: '11111111-1111-4111-8111-111111111111',
        },
        {
          id: 'retrying',
          call: {
            id: 'call-retrying',
            name: 'Bash',
            input: { command: 'rm -rf /tmp/other-target' },
          },
          display: 'Delete other target',
          reason: 'Classifier policy',
          sessionId: '22222222-2222-4222-8222-222222222222',
        },
      ],
      retryingDeniedId: 'retrying',
      workspaceDirectories: [],
    }
    const unselectedRetry = projectQuietChoiceRows(
      projectTuiPermissionSurface(input),
      { density: 'standard' },
    )
    const retryingRow = unselectedRetry.find(
      (row) => row.key === 'quiet:dashboard:retrying',
    )
    expect(retryingRow?.segments[0]?.text).toContain(
      'Delete other target (retrying)',
    )
    expect(retryingRow?.segments[0]?.role).toBe('warning')

    const selectedRetryModel = projectTuiPermissionSurface({
      ...input,
      selectedIndex: 1,
    })
    const selectedRetry = projectQuietChoiceRows(selectedRetryModel, {
      density: 'standard',
      screenReader: true,
    }).find((row) => row.key === 'quiet:dashboard:retrying')
    expect(selectedRetry?.segments[0]?.text).toContain(
      'Selected: Delete other target (retrying)',
    )
    expect(selectedRetry?.segments[0]?.role).toBe('selection')
  })

  it('hides picker descriptions at compact density and keeps stable row identity', () => {
    const make = (selectedIndex: number) =>
      projectTuiCommandPalette({
        commands: [
          { name: 'review', description: 'Review changes', source: 'builtin' },
          { name: 'rename', description: 'Rename session', source: 'builtin' },
        ],
        query: '',
        selectedIndex,
      })
    const full = projectQuietChoiceRows(make(0), { density: 'full' })
    const compact = projectQuietChoiceRows(make(1), { density: 'compact' })
    expect(text(full)).toContain('/review — Review changes')
    expect(text(compact)).toContain('/review')
    expect(text(compact)).not.toContain('Review changes')
    expect(full.map((row) => row.key)).toEqual(compact.map((row) => row.key))
  })

  it('projects plan and question decisions with density-aware detail and explicit accessibility', () => {
    const plan = projectTuiDecisionSurface({
      kind: 'plan-approval',
      request: {
        action: 'exit',
        planPath: '/tmp/plan.md',
        previousMode: 'plan',
        plan: 'Do the work',
      },
      selectedIndex: 1,
      feedbackMode: false,
      feedback: '',
      elevatedMode: 'auto',
    })
    const full = projectQuietChoiceRows(plan, {
      density: 'full',
      screenReader: true,
    })
    const compact = projectQuietChoiceRows(plan, { density: 'compact' })
    expect(text(full)).toContain('Do the work')
    expect(text(full)).toContain('Selected: Yes, manually approve edits')
    expect(text(compact)).not.toContain('Do the work')
    expect(text(compact)).not.toContain('/tmp/plan.md')
    expect(full.at(-1)?.key).toBe('quiet:plan:footer')

    const question = projectTuiDecisionSurface({
      kind: 'question',
      questions: [
        {
          header: 'Runtime',
          question: 'Which?',
          multiSelect: false,
          options: [{ label: 'Node', description: 'Node.js' }],
        },
      ],
      questionIndex: 0,
      answer: 'Node',
    })
    const questionRows = projectQuietChoiceRows(question, {
      density: 'standard',
      screenReader: true,
    })
    expect(text(questionRows)).toContain('Current answer: Node')
    expect(questionRows.at(-1)?.segments[0]?.text).toBe(
      'Enter answer  Esc cancel',
    )
    expect(questionRows.at(-1)?.accessibleText).toBe(
      'Press Enter to submit the answer. Press Escape to cancel.',
    )
  })

  it('projects MCP form input, errors, density, and expanded option focus separately from stored selection', () => {
    const textForm: TuiElicitationSurfaceModel = {
      kind: 'elicitation-form',
      serverName: 'local',
      message: 'Configure',
      input: 'Alice',
      maxVisibleFields: 3,
      state: {
        fields: [
          {
            name: 'name',
            title: 'Name',
            description: 'Shown in reports',
            required: true,
            schema: { type: 'string' },
            kind: 'text',
            options: [],
          },
        ],
        values: {},
        errors: { name: 'Must be at least 3 characters' },
        focusIndex: 0,
        expandedField: undefined,
        optionIndex: 0,
        typeahead: '',
        typeaheadAt: 0,
      },
    }
    const before = structuredClone(textForm)
    expect(
      text(
        projectQuietChoiceRows(
          { kind: 'elicitation', surface: textForm },
          { density: 'full' },
        ),
      ),
    ).toContain(
      'Name (required): Alice — Shown in reports — Must be at least 3 characters',
    )
    expect(
      text(
        projectQuietChoiceRows(
          { kind: 'elicitation', surface: textForm },
          { density: 'compact' },
        ),
      ),
    ).not.toContain('Shown in reports')
    expect(textForm).toEqual(before)

    const expanded: TuiElicitationSurfaceModel = {
      ...textForm,
      input: '',
      state: {
        ...textForm.state,
        fields: [
          {
            name: 'tags',
            title: 'Tags',
            description: undefined,
            required: false,
            schema: { type: 'array' },
            kind: 'multi-enum',
            options: [
              { value: 'fast', label: 'Fast' },
              { value: 'safe', label: 'Safe' },
            ],
          },
        ],
        values: { tags: ['safe'] },
        errors: {},
        expandedField: 'tags',
        optionIndex: 0,
      },
    }
    const expandedRows = projectQuietChoiceRows(
      { kind: 'elicitation', surface: expanded },
      { density: 'standard' },
    )
    expect(text(expandedRows)).toContain('❯ [ ] Fast')
    expect(text(expandedRows)).toContain('  [x] Safe')
    expect(expandedRows.at(-1)?.accessibleText).toContain(
      'Press Enter to edit or select.',
    )
  })

  it('projects URL elicitation, editor wait, and exit confirmation with explicit controls', () => {
    const url: TuiElicitationSurfaceModel = {
      kind: 'elicitation-url',
      serverName: 'oauth',
      message: 'Authorize',
      url: 'https://example.test',
      waiting: false,
      actionLabel: 'Continue without waiting',
      selection: 0,
    }
    const urlRows = projectQuietChoiceRows(
      { kind: 'elicitation', surface: url },
      { density: 'standard', screenReader: true },
    )
    expect(text(urlRows)).toContain('Selected: Continue without waiting')
    expect(urlRows.at(-1)?.accessibleText).toContain('Press Escape to cancel.')

    const editor = projectQuietChoiceRows(
      { kind: 'editor-wait' },
      { density: 'minimal', screenReader: true },
    )
    const exit = projectQuietChoiceRows(
      { kind: 'exit-confirmation' },
      { density: 'minimal', screenReader: true },
    )
    expect(editor.at(-1)?.accessibleText).toBe('Press Escape to cancel.')
    expect(exit.at(-1)?.accessibleText).toBe(
      'Press Enter to confirm. Press Escape to cancel.',
    )
  })
})
