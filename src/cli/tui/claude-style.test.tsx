import { cleanup, render } from 'ink-testing-library'
import { Text } from 'ink'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Composer,
  DialogFrame,
  MarkdownText,
  SessionPicker,
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
    expect(frame.split('\n')[0]?.length).toBeLessThanOrEqual(80)
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
    expect(frame).toContain('● Bash')
    expect(frame).toContain('└ Result')
    expect(frame).toContain('@@ file')
    expect(frame).toContain('-old')
    expect(frame).toContain('+new')
    expect(frame).toContain('⚠ careful')
    expect(frame).toContain('✳ streaming')
  })

  it('renders composer effort, prompt, mode, and busy states', () => {
    const idle = render(
      <Composer
        input=""
        busy={false}
        status="ready"
        display={display}
        usage={{ inputTokens: 2, outputTokens: 1 }}
        width={60}
        screenReader={false}
      />,
    )
    expect(idle.lastFrame()).toContain('◉ high · /effort')
    expect(idle.lastFrame()).toContain('❯ Try "review this project"')
    expect(idle.lastFrame()).toContain('permissions default')
    expect(idle.lastFrame()).toContain('Context · 3 tokens')

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
