import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import {
  initialTuiTaskPanelState,
  projectBackgroundAgentTask,
  projectBackgroundBashTask,
  projectTuiTasks,
  projectWorkflowTask,
  TaskPanel,
  type TuiTaskEntry,
} from './task-panel.js'

interface TaskFixture {
  version: string
  captureFile: string
  captureSha256: string
  terminal: { columns: number; lines: number; screenReader: boolean }
  empty: { title: string; message: string; footer: string }
  multipleRunningShells: {
    title: string
    summary: string
    order: string
    rows: string[]
    footer: string
  }
  runningShellDetail: {
    title: string
    fields: string[]
    emptyOutput: string
    footer: string
  }
}

const fixtureUrl = new URL(
  '../../../test/fixtures/claude-code/2.1.208/tasks-tui.json',
  import.meta.url,
)
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as TaskFixture
const capture = await readFile(new URL(fixture.captureFile, fixtureUrl), 'utf8')

const runningShells = projectTuiTasks({
  shells: [
    {
      taskId: 'b27kmnapy',
      status: 'running',
      command: 'sleep 90',
      description: 'Sleep for 90 seconds',
      outputFile: '/tmp/sleep-90.output',
      output: '',
      exitCode: null,
      startedAt: 500,
      durationMs: null,
    },
    {
      taskId: 'bf4ubz69n',
      status: 'running',
      command: 'sleep 100',
      description: 'Sleep for 100 seconds',
      outputFile: '/tmp/sleep-100.output',
      output: '',
      exitCode: null,
      startedAt: 1_000,
      durationMs: null,
    },
  ],
})
const newestShell = runningShells[0]
const olderShell = runningShells[1]
if (!newestShell || !olderShell) throw new Error('Shell fixture is incomplete')

describe('TaskPanel', () => {
  it('binds every observed fixture section to an immutable 2.1.208 capture', () => {
    expect(createHash('sha256').update(capture).digest('hex')).toBe(
      fixture.captureSha256,
    )
    expect(fixture.terminal).toEqual({
      columns: 100,
      lines: 32,
      screenReader: true,
    })
    expect(capture).toContain(`Claude Code v${fixture.version}`)
    for (const value of [
      fixture.empty.title,
      fixture.empty.message,
      fixture.empty.footer,
      fixture.multipleRunningShells.summary,
      ...fixture.multipleRunningShells.rows,
      fixture.multipleRunningShells.footer,
      fixture.runningShellDetail.title,
      ...fixture.runningShellDetail.fields,
      fixture.runningShellDetail.emptyOutput,
      fixture.runningShellDetail.footer,
    ]) {
      expect(capture).toContain(value)
    }
  })

  it('matches the observed empty task surface', () => {
    const app = render(
      <TaskPanel
        tasks={[]}
        state={initialTuiTaskPanelState([])}
        screenReader={fixture.terminal.screenReader}
        width={fixture.terminal.columns}
        height={fixture.terminal.lines}
      />,
    )

    expect(app.lastFrame()).toContain(fixture.empty.title)
    expect(app.lastFrame()).toContain(fixture.empty.message)
    expect(app.lastFrame()).toContain(fixture.empty.footer)
  })

  it('sorts multiple running shells newest-first and semantically selects', () => {
    expect(fixture.multipleRunningShells.order).toBe('most-recent-first')
    const app = render(
      <TaskPanel
        tasks={runningShells}
        state={{ depth: 'list', selectedIndex: 0, scrollOffset: 0 }}
        screenReader={fixture.terminal.screenReader}
        width={fixture.terminal.columns}
        height={fixture.terminal.lines}
      />,
    )
    const frame = app.lastFrame() ?? ''

    expect(frame).toContain(fixture.multipleRunningShells.summary)
    expect(frame).toContain(fixture.multipleRunningShells.title)
    expect(frame).toContain(
      `Selected: ${fixture.multipleRunningShells.rows[0]}`,
    )
    expect(frame.indexOf('sleep 100')).toBeLessThan(frame.indexOf('sleep 90'))
    expect(frame).toContain(fixture.multipleRunningShells.footer)
    expect(frame).not.toContain('❯')
  })

  it('opens one running shell directly with the captured detail contract', () => {
    const tasks = runningShells.slice(0, 1)
    const app = render(
      <TaskPanel
        tasks={tasks}
        state={initialTuiTaskPanelState(tasks)}
        nowMs={4_500}
        screenReader={fixture.terminal.screenReader}
        width={fixture.terminal.columns}
        height={fixture.terminal.lines}
      />,
    )
    const frame = app.lastFrame() ?? ''

    expect(frame).toContain(fixture.runningShellDetail.title)
    for (const field of fixture.runningShellDetail.fields) {
      expect(frame).toContain(`${field}:`)
    }
    expect(frame).toContain('Status: running')
    expect(frame).toContain('Runtime: 3s')
    expect(frame).toContain('Command: sleep 100')
    expect(frame).toContain(fixture.runningShellDetail.emptyOutput)
    expect(frame).toContain(fixture.runningShellDetail.footer)
  })

  it('projects real Agent and Workflow result, error, duration, and status shapes', () => {
    expect(
      projectBackgroundAgentTask({
        agentId: 'a0123456789abcdef',
        status: 'completed',
        outputFile: '/tmp/agent.output',
        name: null,
        description: 'Review repository',
        startedAt: 1_000,
        error: null,
        durationMs: 2_000,
        result: {
          text: 'Agent result',
          usage: { inputTokens: 1, outputTokens: 2 },
          toolUseCount: 1,
          durationMs: 2_000,
        },
      }),
    ).toMatchObject({
      label: 'Review repository',
      output: 'Agent result',
      durationMs: 2_000,
    })
    expect(
      projectWorkflowTask({
        task_id: 'wf123',
        status: 'error',
        summary: 'Review repository',
        startTime: 500,
        durationMs: 1_500,
        result: { files: 3 },
        error: 'Workflow failed',
      }),
    ).toMatchObject({
      status: 'failed',
      output: 'Workflow failed',
      durationMs: 1_500,
      createdAtMs: 500,
    })
    expect(() => projectWorkflowTask({ status: 'running' })).toThrow(
      'Task record is missing',
    )
  })

  it('renders a finished shell with its fixed terminal duration', () => {
    const task = projectBackgroundBashTask({
      taskId: 'bfinished1',
      status: 'completed',
      command: 'printf done',
      description: 'Print done',
      outputFile: '/tmp/done.output',
      output: 'done',
      exitCode: 0,
      startedAt: 1_000,
      durationMs: 5_000,
    })
    const app = render(
      <TaskPanel
        tasks={[task]}
        state={initialTuiTaskPanelState([task])}
        nowMs={500_000}
      />,
    )

    expect(app.lastFrame()).toContain('Runtime: 5s')
  })

  it('bounds long detail output and scrolls within a narrow terminal', () => {
    const task: TuiTaskEntry = {
      ...newestShell,
      output: Array.from({ length: 20 }, (_, index) => `line-${index}`).join(
        '\n',
      ),
    }
    const app = render(
      <TaskPanel
        tasks={[task]}
        state={{ depth: 'detail', selectedIndex: 0, scrollOffset: 10 }}
        width={30}
        height={12}
      />,
    )
    const frame = app.lastFrame() ?? ''
    const lines = frame.split('\n')

    expect(frame).toContain('line-10')
    expect(frame).toContain('line-13')
    expect(frame).not.toContain('line-9')
    expect(frame).not.toContain('line-14')
    expect(frame).toContain('↑/↓ scroll')
    expect(lines.length).toBeLessThanOrEqual(12)
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      30,
    )
  })

  it('offers stop only for the selected running row', () => {
    const completed: TuiTaskEntry = {
      ...newestShell,
      id: 'completed',
      status: 'completed',
    }
    const app = render(
      <TaskPanel
        tasks={[completed, olderShell]}
        state={{ depth: 'list', selectedIndex: 0, scrollOffset: 0 }}
      />,
    )

    expect(app.lastFrame()).not.toContain('x to stop')
  })

  it('keeps a selected task visible inside a bounded narrow list viewport', () => {
    const tasks = Array.from({ length: 20 }, (_, index): TuiTaskEntry => ({
      ...newestShell,
      id: `task-${index}`,
      label: `task-${index}-${'long'.repeat(10)}`,
      createdAtMs: 20 - index,
    }))
    const app = render(
      <TaskPanel
        tasks={tasks}
        state={{ depth: 'list', selectedIndex: 15, scrollOffset: 0 }}
        width={25}
        height={6}
        screenReader
      />,
    )
    const frame = app.lastFrame() ?? ''
    const lines = frame.split('\n')

    expect(frame).toContain('Selected: task-15')
    expect(frame).not.toContain('task-0-')
    expect(lines.length).toBeLessThanOrEqual(6)
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      25,
    )
  })
})
