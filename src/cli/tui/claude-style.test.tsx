import { cleanup, render } from 'ink-testing-library'
import { Text } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import { TuiThemeProvider } from './theme.js'
import {
  CommandPalette,
  Composer,
  DiffDashboard,
  DialogFrame,
  ExternalEditorWait,
  FilePicker,
  HelpMenu,
  HookDashboard,
  ListDashboard,
  MemoryDashboard,
  MarkdownText,
  MentionPicker,
  PermissionDashboard,
  SelectionMenu,
  SessionPicker,
  ShortcutHelp,
  ThemePicker,
  Transcript,
  WelcomePanel,
} from './claude-style.js'
import { projectTuiHooks } from './hook-settings.js'

afterEach(() => cleanup())

const display = {
  version: '0.1.2',
  cwd: '/Users/test/dev/Praxis',
  model: 'test-model',
  effort: 'high',
  permissionMode: 'default',
}

describe('Claude-style TUI components', () => {
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
        autoMemoryEnabled
        entries={entries}
        selectedIndex={1}
        openedIndex={1}
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
    expect(frame).toContain('https://code.claude.com/docs/en/memory')
    expect(frame.split('\n')[0]).toBe('─'.repeat(100))

    const accessible = render(
      <MemoryDashboard
        autoMemoryEnabled={false}
        entries={entries.slice(0, 1)}
        selectedIndex={0}
        openedIndex={null}
        width={40}
        screenReader
      />,
    )
    expect(accessible.lastFrame()).toContain('Auto-memory: off')
    expect(accessible.lastFrame()).not.toContain('────')
  })

  it('renders the wide welcome hierarchy and local identity', () => {
    const app = render(<WelcomePanel display={display} width={100} />)
    const frame = app.lastFrame() ?? ''
    expect(frame).toContain('Praxis Code v0.1.2')
    expect(frame).toContain('Welcome back!')
    expect(frame).toContain('Tips for getting started')
    expect(frame).toContain('test-model · high effort')
    // Claude 2.1.208 launch parity: title lives in the top border row,
    // not in a separate title line inside the card.
    expect(frame.split('\n')[0]).toContain('╭───Praxis Code v0.1.2')
    // No status line between card and composer; card is 19 rows tall with
    // the Claude 2.1.208 "What's new" right column.
    expect(frame.split('\n').length).toBe(19)
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

  it('renders transcript code and diff surfaces under persisted syntax settings', () => {
    const runtimeSurfaces = (
      <>
        <Transcript
          screenReader={false}
          activeText=""
          items={[
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
          ]}
        />
        <DiffDashboard
          snapshots={[
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
          ]}
          sourceIndex={0}
          selectedIndex={0}
          viewingFile
          scrollOffset={0}
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
      <Transcript screenReader={false} activeText="" items={items} />,
    )
    expect(collapsed.lastFrame()).toContain('Read 2 files (ctrl+o to expand)')
    expect(collapsed.lastFrame()).toContain('Read 1 file (ctrl+o to expand)')
    expect(collapsed.lastFrame()).not.toContain('/tmp/one.ts')

    const expanded = render(
      <Transcript
        screenReader={false}
        activeText=""
        detailedTranscript
        items={items}
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
        snapshots={[
          { label: 'Current', snapshot },
          { label: 'T1', snapshot },
        ]}
        sourceIndex={0}
        selectedIndex={0}
        viewingFile={false}
        scrollOffset={0}
        width={100}
        screenReader
      />,
    ).lastFrame()
    const moved = render(
      <DiffDashboard
        snapshots={[
          { label: 'Current', snapshot },
          { label: 'T1', snapshot },
        ]}
        sourceIndex={1}
        selectedIndex={1}
        viewingFile={false}
        scrollOffset={0}
        width={100}
        screenReader
      />,
    ).lastFrame()

    expect(first).toContain('Current source: Current')
    expect(first).toContain('Selected: first.ts +2 -0')
    expect(moved).toContain('Current source: T1')
    expect(moved).toContain('Selected: second.ts +0 -1')
    expect(`${first}${moved}`).not.toContain('❯')

    const detail = render(
      <DiffDashboard
        snapshots={[{ label: 'Current', snapshot }]}
        sourceIndex={0}
        selectedIndex={0}
        viewingFile
        scrollOffset={0}
        width={100}
        screenReader
      />,
    ).lastFrame()
    expect(detail).toContain('Current source: Current')
    expect(detail).toContain('first.ts')
    expect(detail).toContain('-before')
    expect(detail).toContain('+after')
    expect(detail).not.toContain('─')
    expect(detail).not.toContain('❯')
    expect(detail).not.toContain('\u001B[7m')
  })

  it('renders permission tabs, scoped rules, search, and workspace modes', () => {
    const rules = [
      {
        behavior: 'allow' as const,
        rule: 'Bash(npm test:*)',
        scope: 'project' as const,
        path: '/project/.claude/settings.json',
      },
    ]
    const allow = render(
      <PermissionDashboard
        tabIndex={1}
        selectedIndex={0}
        query="npm"
        rules={rules}
        recentDenied={[]}
        workspaceDirectories={[
          { path: '/project', original: true },
          { path: '/shared', original: false },
        ]}
        width={100}
        screenReader={false}
      />,
    )
    expect(allow.lastFrame()).toContain('Recently denied')
    expect(allow.lastFrame()).toContain('⌕ npm')
    expect(allow.lastFrame()).toContain(
      "Praxis Code won't ask before using allowed tools.",
    )
    expect(allow.lastFrame()).toContain('1. Add a new rule…')
    expect(allow.lastFrame()).toContain('2. Bash(npm test:*)')

    const workspace = render(
      <PermissionDashboard
        tabIndex={4}
        selectedIndex={0}
        query=""
        rules={rules}
        recentDenied={[]}
        workspaceDirectories={[
          { path: '/project', original: true },
          { path: '/shared', original: false },
        ]}
        width={100}
        screenReader={false}
      />,
    )
    expect(workspace.lastFrame()).toContain(
      '/project (Original working directory)',
    )
    expect(workspace.lastFrame()).toContain('/shared')
    expect(workspace.lastFrame()).toContain('1. /shared')
    expect(workspace.lastFrame()).toContain('2. Add directory…')
  })

  it('announces permission tab and row focus textually for screen readers', () => {
    const props = {
      query: 'npm',
      rules: [
        {
          behavior: 'allow' as const,
          rule: 'Bash(npm test:*)',
          scope: 'project' as const,
          path: '/project/.claude/settings.json',
        },
      ],
      recentDenied: [],
      workspaceDirectories: [
        { path: '/project', original: true },
        { path: '/shared', original: false },
      ],
      width: 100,
      screenReader: true,
    }
    const addRule = render(
      <PermissionDashboard {...props} tabIndex={1} selectedIndex={0} />,
    ).lastFrame()
    const existingRule = render(
      <PermissionDashboard {...props} tabIndex={1} selectedIndex={1} />,
    ).lastFrame()

    expect(addRule).toContain('Current tab: Allow')
    expect(addRule).toContain('Search: npm')
    expect(addRule).toContain('Selected: 1. Add a new rule…')
    expect(existingRule).toContain('Selected: 2. Bash(npm test:*)')
    expect(`${addRule}${existingRule}`).not.toContain('❯')
    expect(`${addRule}${existingRule}`).not.toContain('⌕')
  })

  it('renders the native Recently denied action and controls', () => {
    const frame = render(
      <PermissionDashboard
        tabIndex={0}
        selectedIndex={0}
        query=""
        rules={[]}
        recentDenied={[
          {
            id: 'denied-1',
            call: {
              id: 'call-1',
              name: 'Bash',
              input: { command: 'rm /tmp/target' },
            },
            display: 'Delete target',
            reason: 'Classifier policy',
            sessionId: 'session-1',
          },
        ]}
        workspaceDirectories={[]}
        width={100}
        screenReader={false}
      />,
    ).lastFrame()

    expect(frame).toContain(
      'Commands recently denied by the auto mode classifier.',
    )
    expect(frame).toContain('1. ✘ Delete target  Classifier policy')
    expect(frame).toContain(
      'Enter to approve · r to retry · ↑/↓ to navigate · Esc to cancel',
    )
    expect(frame).not.toContain('Clear recently denied')
  })

  it('renders the observed built-in theme choices and active profile', () => {
    const app = render(
      <ThemePicker
        currentTheme="dark"
        selectedIndex={1}
        syntaxHighlightingDisabled={false}
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
        currentTheme="light-ansi"
        selectedIndex={6}
        syntaxHighlightingDisabled
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

  it('renders context usage and local status dashboards', () => {
    const context = render(
      <Transcript
        screenReader={false}
        activeText=""
        items={[
          {
            kind: 'context',
            usedTokens: 1_500,
            contextWindowTokens: 200_000,
            skills: [{ name: 'review', tokens: 290 }],
            memoryFiles: [],
          },
        ]}
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
        items={[
          {
            kind: 'context',
            usedTokens: 1_500,
            contextWindowTokens: 200_000,
            skills: [{ name: 'review', tokens: 290 }],
            memoryFiles: [],
          },
        ]}
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
        title="Skills"
        rows={[]}
        emptyText={
          'No skills found\nCreate skills in .claude/skills/ or ~/.claude/skills/'
        }
        selectedIndex={0}
        width={80}
        screenReader={false}
      />,
    )
    expect(empty.lastFrame()).toContain('No skills found')
    expect(empty.lastFrame()).toContain('.claude/skills/')

    const populated = render(
      <ListDashboard
        title="Background"
        rows={[{ label: 'w1 [running] Review repository' }]}
        emptyText="No tasks currently running"
        selectedIndex={0}
        width={80}
        screenReader={false}
      />,
    )
    expect(populated.lastFrame()).toContain('❯ w1 [running] Review repository')
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
        configuration={configuration}
        depth="events"
        eventIndex={0}
        matcherIndex={0}
        hookIndex={0}
        width={100}
        screenReader={false}
      />,
    )
    expect(events.lastFrame()).toContain('1 hooks configured')
    expect(events.lastFrame()).toContain('❯ 1. PreToolUse (1)')
    expect(events.lastFrame()).toContain('↓ 5 more below')

    const hooks = render(
      <HookDashboard
        configuration={configuration}
        depth="hooks"
        eventIndex={0}
        matcherIndex={0}
        hookIndex={0}
        width={80}
        screenReader
      />,
    )
    expect(hooks.lastFrame()).toContain('PreToolUse - Matcher: Bash')
    expect(hooks.lastFrame()).toContain('Selected: 1. [command] echo inspect')
    expect(hooks.lastFrame()).not.toContain('────')

    const detail = render(
      <HookDashboard
        configuration={configuration}
        depth="detail"
        eventIndex={0}
        matcherIndex={0}
        hookIndex={0}
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
        entries={[
          {
            kind: 'agent',
            name: 'reviewer',
            description: 'Reviews code for subtle regressions.',
          },
        ]}
        selectedIndex={0}
        width={80}
        screenReader={false}
      />,
    )
    expect(visual.lastFrame()).toContain(
      '* reviewer (agent) – Reviews code for subtle regressions.',
    )

    const narrow = render(
      <MentionPicker
        entries={[
          {
            kind: 'agent',
            name: 'reviewer',
            description:
              'Reviews code for subtle regressions across the repository.',
          },
        ]}
        selectedIndex={0}
        width={32}
        screenReader={false}
      />,
    )
    expect(narrow.lastFrame()?.split('\n').filter(Boolean)).toHaveLength(1)
    expect(narrow.lastFrame()).toContain('…')

    const accessible = render(
      <MentionPicker
        entries={[
          {
            kind: 'agent',
            name: 'reviewer',
            description: 'Reviews code for subtle regressions.',
          },
        ]}
        selectedIndex={0}
        width={80}
        screenReader
      />,
    )
    expect(accessible.lastFrame()).toContain('Selected agent: reviewer')
  })

  it('renders the shortcut grid and tabbed help surface', () => {
    const shortcuts = render(<ShortcutHelp width={100} />)
    expect(shortcuts.lastFrame()).toContain('! for bash mode')
    expect(shortcuts.lastFrame()).toContain('& for background')
    expect(shortcuts.lastFrame()).toContain('shift + tab to auto-accept edits')
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
        items={[
          { kind: 'shell', callId: 'shell-1', command: 'pwd' },
          {
            kind: 'shell-result',
            callId: 'shell-1',
            stdout: '/tmp/project\n',
            stderr: '',
            isError: false,
          },
        ]}
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
    const trailing = render(
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
    const trailingPlain = render(
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

    const bare = render(
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
    expect(bare.lastFrame()?.split('\n')[2]).toBe(`❯ /color  ${hint}`)
    expect(trailing.lastFrame()?.split('\n')[2]).toBe(
      bare.lastFrame()?.split('\n')[2],
    )
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
        items={[{ kind: 'assistant', text: 'answer' }]}
      />,
    )
    expect(transcript.lastFrame()).toContain('Praxis:')
    expect(transcript.lastFrame()).not.toContain('✳')
  })
})
