import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanup, render } from 'ink-testing-library'
import { afterEach, describe, expect, it } from 'vitest'

import type { ModelToolCall } from '../../core/runtime.js'
import {
  projectTuiToolPermission,
  ToolPermissionDialog,
} from './tool-permission.js'
import { TuiThemeProvider } from './theme.js'

const call = (name: string, input: Record<string, unknown>): ModelToolCall => ({
  id: `${name}-fixture`,
  name,
  input,
})

afterEach(cleanup)

function renderWithColor(element: Parameters<typeof render>[0]) {
  const previousNoColor = process.env.NO_COLOR
  delete process.env.NO_COLOR
  try {
    return render(element)
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = previousNoColor
  }
}

describe('tool permission projection', () => {
  it('projects Bash commands and reusable prefix rules', () => {
    const model = projectTuiToolPermission(
      call('Bash', { command: 'npm test', description: 'Run tests' }),
      '/workspace',
      [],
    )

    expect(model).toMatchObject({
      kind: 'bash',
      title: 'Bash command',
      description: 'Run tests',
      detail: [{ text: 'npm test' }],
    })
    expect(model.options[1]).toMatchObject({
      action: 'persist-rule',
      rule: 'Bash(npm test:*)',
    })

    expect(
      projectTuiToolPermission(
        call('Bash', { command: 'NODE_ENV=test npm run build' }),
        '/workspace',
        [],
      ).options[1],
    ).toMatchObject({ rule: 'Bash(npm run:*)' })
    expect(
      projectTuiToolPermission(
        call('Bash', { command: 'CUSTOM_TARGET=test npm run build' }),
        '/workspace',
        [],
      ).options[1],
    ).toMatchObject({ rule: 'Bash(CUSTOM_TARGET=test npm run build)' })
  })

  it('does not persist one-off multiline PowerShell literals', () => {
    const model = projectTuiToolPermission(
      call('PowerShell', { command: "Get-ChildItem\nWrite-Output 'done'" }),
      '/workspace',
      [],
    )
    expect(model.options.map(({ action }) => action)).toEqual([
      'allow-once',
      'deny',
    ])
  })

  it('applies compound shell suggestions atomically without a false editable prefix', () => {
    const suggestions = [
      {
        type: 'addRules' as const,
        rules: [
          { toolName: 'Bash', ruleContent: 'npm test:*' },
          { toolName: 'Bash', ruleContent: 'git push:*' },
        ],
        behavior: 'allow' as const,
        destination: 'localSettings' as const,
      },
    ]
    const model = projectTuiToolPermission(
      call('Bash', { command: 'cd src && npm test && git push' }),
      '/workspace',
      [],
      { behavior: 'ask', suggestions },
    )
    expect(model.options[1]).toMatchObject({
      action: 'persist-rule',
      updates: suggestions,
    })
    expect(model.options[1]?.editableRule).toBeUndefined()
    expect(model.options[1]?.label).toContain('Bash(npm test:*)')
    expect(model.options[1]?.label).toContain('Bash(git push:*)')
  })

  it('projects Edit and Write diffs with source-relative paths', () => {
    const directory = mkdtempSync(join(tmpdir(), 'praxis-permission-'))
    const existing = join(directory, 'existing.txt')
    writeFileSync(existing, 'before\n')
    try {
      const edit = projectTuiToolPermission(
        call('Edit', {
          file_path: existing,
          old_string: 'before',
          new_string: 'after',
        }),
        directory,
        [],
      )
      expect(edit).toMatchObject({
        kind: 'file',
        title: 'Edit file',
        subtitle: 'existing.txt',
        question: 'Do you want to make this edit to existing.txt?',
        detail: [
          { prefix: '-', text: 'before' },
          { prefix: '+', text: 'after' },
        ],
      })
      expect(edit.options[1]).toMatchObject({
        action: 'allow-session-edits',
      })

      const overwrite = projectTuiToolPermission(
        call('Write', { file_path: existing, content: 'after\n' }),
        directory,
        [],
      )
      expect(overwrite.title).toBe('Overwrite file')
      expect(overwrite.detail).toEqual([
        { prefix: '-', text: 'before' },
        { prefix: '-', text: '' },
        { prefix: '+', text: 'after' },
        { prefix: '+', text: '' },
      ])

      const created = projectTuiToolPermission(
        call('Write', {
          file_path: join(directory, 'new.txt'),
          content: 'new',
        }),
        directory,
        [],
      )
      expect(created).toMatchObject({
        title: 'Create file',
        subtitle: 'new.txt',
        detail: [{ prefix: '+', text: 'new' }],
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['insert', 'insert this cell into', '+'],
    ['delete', 'delete this cell from', '-'],
    ['replace', 'make this edit to', '+'],
  ])('projects NotebookEdit %s mode', (mode, wording, prefix) => {
    const model = projectTuiToolPermission(
      call('NotebookEdit', {
        notebook_path: '/workspace/notebook.ipynb',
        edit_mode: mode,
        new_source: 'value = 1',
      }),
      '/workspace',
      [],
    )
    expect(model.question).toContain(wording)
    expect(model.detail).toEqual([{ prefix, text: 'value = 1' }])
  })

  it('projects WebFetch domains and filesystem session rules', () => {
    const web = projectTuiToolPermission(
      call('WebFetch', {
        url: 'https://docs.example.com/guide',
        prompt: 'Summarize it',
      }),
      '/workspace',
      [],
    )
    expect(web).toMatchObject({ kind: 'web-fetch', title: 'Fetch' })
    expect(web.options[1]).toMatchObject({
      rule: 'WebFetch(domain:docs.example.com)',
    })

    const read = projectTuiToolPermission(
      call('Read', { file_path: '/shared/config.json' }),
      '/workspace',
      [],
    )
    expect(read.options[1]).toEqual({
      action: 'allow-session-action',
      label: 'Yes, allow reading from shared/ during this session',
      rule: 'Read(//shared/**)',
    })

    const approvedRead = projectTuiToolPermission(
      call('Read', { file_path: '/shared/config.json' }),
      '/workspace',
      [],
      {
        behavior: 'ask',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Read', ruleContent: '//shared/**' }],
            behavior: 'allow',
            destination: 'session',
          },
        ],
      },
    )
    expect(approvedRead.options[1]?.updates).toEqual([
      {
        type: 'addRules',
        rules: [{ toolName: 'Read', ruleContent: '//shared/**' }],
        behavior: 'allow',
        destination: 'session',
      },
    ])
  })

  it('projects Skill and fallback tools without leaking sensitive values', () => {
    const skill = projectTuiToolPermission(
      call('Skill', { skill: 'reviewer' }),
      '/workspace',
      [],
    )
    expect(skill).toMatchObject({
      kind: 'skill',
      title: 'Use skill "reviewer"?',
    })
    expect(skill.options[1]).toMatchObject({ rule: 'Skill(reviewer)' })

    const skillCommand = projectTuiToolPermission(
      call('Skill', { skill: 'reviewer strict' }),
      '/workspace',
      [],
    )
    expect(skillCommand.options[2]).toMatchObject({
      rule: 'Skill(reviewer:*)',
    })

    const generic = projectTuiToolPermission(
      call('CustomTool', { token: 'secret-value' }),
      '/workspace',
      ['secret-value'],
    )
    expect(generic.kind).toBe('generic')
    expect(generic.detail[0]?.text).not.toContain('secret-value')
  })

  it('offers a session-scoped rule for project .claude edits', () => {
    const model = projectTuiToolPermission(
      call('Write', {
        file_path: '/workspace/.claude/settings.local.json',
        content: '{}',
      }),
      '/workspace',
      [],
    )
    expect(model.options[1]).toEqual({
      action: 'allow-session-action',
      label: 'Yes, and allow Claude to edit its own settings for this session',
      rule: 'Edit(/.claude/**)',
      updates: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Edit', ruleContent: '/.claude/**' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    })
  })

  it('renders the source-shaped selected option and diff', () => {
    const model = projectTuiToolPermission(
      call('Edit', {
        file_path: '/workspace/index.ts',
        old_string: 'const oldValue = 1',
        new_string: 'const newValue = 2',
      }),
      '/workspace',
      [],
    )
    const app = render(
      <ToolPermissionDialog
        model={model}
        selection={1}
        feedbackMode={false}
        feedback=""
        screenReader
      />,
    )
    expect(app.lastFrame()).toContain('Edit file')
    expect(app.lastFrame()).toContain('- const oldValue = 1')
    expect(app.lastFrame()).toContain('+ const newValue = 2')
    expect(app.lastFrame()).toContain(
      'Selected: 2. Yes, allow all edits during this session',
    )
  })

  it('renders the permission decision explanation', () => {
    const model = projectTuiToolPermission(
      call('Bash', { command: 'npm test' }),
      '/workspace',
      [],
      {
        behavior: 'ask',
        reason: 'A project rule requires confirmation.',
      },
    )
    const app = render(
      <ToolPermissionDialog
        model={model}
        selection={0}
        feedbackMode={false}
        feedback=""
        screenReader
      />,
    )
    expect(app.lastFrame()).toContain('A project rule requires confirmation.')
  })

  it('renders the normal dialog with its title and selected option', () => {
    const model = projectTuiToolPermission(
      call('Bash', { command: 'npm test' }),
      '/workspace',
      [],
    )
    const app = render(
      <ToolPermissionDialog
        model={model}
        selection={0}
        feedbackMode={false}
        feedback=""
        screenReader={false}
      />,
    )
    expect(app.lastFrame()).toContain('Bash command')
    expect(app.lastFrame()).toContain('❯ 1. Yes')
    expect(app.lastFrame()).toContain('Esc to cancel · Tab to amend')
  })

  it('applies semantic decision, permission, diff, and selection styles', () => {
    const model = projectTuiToolPermission(
      call('Edit', {
        file_path: '/workspace/index.ts',
        old_string: 'const oldValue = 1',
        new_string: 'const newValue = 2',
      }),
      '/workspace',
      [],
    )
    const app = renderWithColor(
      <TuiThemeProvider
        settings={{ theme: 'dark', syntaxHighlightingDisabled: false }}
      >
        <ToolPermissionDialog
          model={model}
          selection={1}
          feedbackMode={false}
          feedback=""
          screenReader={false}
        />
      </TuiThemeProvider>,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Edit file')
    expect(frame).toContain('- const oldValue = 1')
    expect(frame).toContain('+ const newValue = 2')
    expect(frame).toContain('❯ 2. Yes, allow all edits')
  })
})
