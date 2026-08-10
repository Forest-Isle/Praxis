import { cleanup, render } from 'ink-testing-library'
import { Text } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CommandPalette,
  Composer,
  DiffDashboard,
  DialogFrame,
  HelpMenu,
  MarkdownText,
  SelectionMenu,
  SessionPicker,
  ShortcutHelp,
  Transcript,
  WelcomePanel,
} from './claude-style.js'

afterEach(() => cleanup())

const display = {
  version: '0.1.2',
  cwd: '/Users/test/dev/Praxis',
  model: 'test-model',
  effort: 'high',
  permissionMode: 'default',
}

describe('Claude-style TUI components', () => {
  it('renders the wide welcome hierarchy and local identity', () => {
    const app = render(<WelcomePanel display={display} width={100} />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Praxis Code v0.1.2')
    expect(frame).toContain('Welcome back!')
    expect(frame).toContain('Tips for getting started')
    expect(frame).toContain('test-model · high effort')
    expect(frame).toContain('/Users/test/dev/Praxis')
    expect(frame.split('\n')[0]?.length).toBeLessThanOrEqual(100)
  })

  it('collapses welcome columns on a narrow terminal', () => {
    const app = render(<WelcomePanel display={display} width={40} />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Welcome back!')
    expect(frame).toContain('Tips for getting started')
    expect(frame.split('\n').every((line) => line.length <= 40)).toBe(true)
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

  it('gives user, assistant, tool, result, and warning distinct shapes', () => {
    const app = render(
      <Transcript
        screenReader={false}
        activeText="streaming"
        items={[
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
        ]}
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
      <Transcript screenReader={false} activeText="" items={items} />,
    )
    expect(collapsed.lastFrame()).toContain('… +2 lines (ctrl+o to expand)')
    expect(collapsed.lastFrame()).not.toContain('five')
    expect(collapsed.lastFrame()).toContain('Update(/tmp/fixture.txt)')
    expect(collapsed.lastFrame()).toContain('Added 2 lines, removed 1 line')
    expect(collapsed.lastFrame()).toContain('1 -before')
    expect(collapsed.lastFrame()).toContain('2 +second line')

    const detailed = render(
      <Transcript
        screenReader={false}
        activeText=""
        detailedTranscript
        items={items}
      />,
    )
    expect(detailed.lastFrame()).toContain('five')
    expect(detailed.lastFrame()).not.toContain('… +2 lines')
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
    const list = render(
      <DiffDashboard
        snapshots={[
          { label: 'Current', snapshot },
          { label: 'T1', snapshot },
        ]}
        sourceIndex={0}
        selectedIndex={0}
        viewingFile={false}
        scrollOffset={0}
        width={100}
        screenReader={false}
      />,
    )
    expect(list.lastFrame()).toContain('Uncommitted changes (git diff HEAD)')
    expect(list.lastFrame()).toContain('Current')
    expect(list.lastFrame()).toContain('T1')
    expect(list.lastFrame()).toContain('❯ fixture.txt')

    const patch = render(
      <DiffDashboard
        snapshots={[{ label: 'Current', snapshot }]}
        sourceIndex={0}
        selectedIndex={0}
        viewingFile
        scrollOffset={0}
        width={100}
        screenReader={false}
      />,
    )
    expect(patch.lastFrame()).toContain('-before')
    expect(patch.lastFrame()).toContain('+second line')
    expect(patch.lastFrame()).toContain('Esc to back')
  })

  it('shows active thinking in full and expands retained thinking on demand', () => {
    const reasoning = `Start ${'detail '.repeat(40)}reasoning tail stays visible`
    const collapsed = render(
      <Transcript
        screenReader={false}
        activeText=""
        items={[{ kind: 'thinking', text: reasoning }]}
      />,
    )
    expect(collapsed.lastFrame()).toContain('Thought for a moment')
    expect(collapsed.lastFrame()).not.toContain('reasoning tail stays visible')

    const expanded = render(
      <Transcript
        screenReader={false}
        activeText=""
        thinkingExpanded
        items={[{ kind: 'thinking', text: reasoning }]}
      />,
    )
    expect(expanded.lastFrame()).toContain('reasoning tail stays visible')

    const active = render(
      <Transcript
        screenReader={false}
        activeText=""
        activeThinking={reasoning}
        items={[]}
      />,
    )
    expect(active.lastFrame()).toContain('Thinking…')
    expect(active.lastFrame()).toContain('reasoning tail stays visible')
  })

  it('renders a bounded slash command palette with descriptions', () => {
    const app = render(
      <CommandPalette
        commands={[
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
        ]}
        selectedIndex={1}
        width={70}
        screenReader={false}
      />,
    )
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('/review')
    expect(frame).toContain('Review the current change.')
    expect(frame).toContain('/check')
    expect(frame).not.toContain('╭')
  })

  it('renders the shortcut grid and tabbed help surface', () => {
    const shortcuts = render(<ShortcutHelp width={100} />)
    expect(shortcuts.lastFrame()).toContain('! for shell mode')
    expect(shortcuts.lastFrame()).toContain('ctrl + o for verbose output')
    expect(shortcuts.lastFrame()).toContain('/keybindings to customize')

    const help = render(
      <HelpMenu
        tabIndex={1}
        selectedIndex={0}
        builtinCommands={[
          {
            name: 'resume',
            description: 'Resume a previous conversation',
            source: 'builtin',
          },
        ]}
        customCommands={[]}
        width={100}
        screenReader={false}
      />,
    )
    expect(help.lastFrame()).toContain(
      'Help  General  Commands  Custom commands',
    )
    expect(help.lastFrame()).toContain('Browse default commands')
    expect(help.lastFrame()).toContain('/resume')
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

    const cursor = render(
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
  })

  it('keeps dialogs and session selection visually bounded', () => {
    const picker = render(
      <SessionPicker
        sessions={[
          null,
          { sessionId: 'abc-123', name: 'Review', status: 'ready' },
        ]}
        selectedIndex={1}
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
    const app = render(
      <SessionPicker
        sessions={sessions}
        selectedIndex={11}
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

    const transcript = render(
      <Transcript
        screenReader
        activeText=""
        items={[{ kind: 'assistant', text: 'answer' }]}
      />,
    )
    expect(transcript.lastFrame()).toContain('Praxis:')
    expect(transcript.lastFrame()).not.toContain('✳')
  })
})
