import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeEvent } from '../core/runtime.js'

import {
  BackgroundBashManager,
  claudeBackgroundTaskParent,
} from './background-bash-manager.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function createManager(options: { maxOutputBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'praxis-background-bash-'))
  roots.push(root)
  const cwd = join(root, 'work')
  await mkdir(cwd)
  roots.push(claudeBackgroundTaskParent(cwd))
  const stateRoot = join(root, 'config', 'praxis', 'background-tasks')
  const sessionId = '20202020-2020-4020-8020-202020202020'
  const events: RuntimeEvent[] = []
  const manager = new BackgroundBashManager({
    cwd,
    sessionId,
    stateRoot,
    eventSink: (event) => events.push(event),
    ...options,
  })
  return { root, cwd, events, manager, sessionId, stateRoot }
}

describe('BackgroundBashManager', () => {
  it('returns live output, completes with native metadata, and notifies once', async () => {
    const { events, manager } = await createManager()
    const launch = await manager.launch({
      command: "printf 'BG_START\\n'; sleep 0.05; printf 'BG_END\\n'",
      description: 'Emit markers',
      toolUseId: 'call_bash',
      timeout: 30_000,
    })
    expect(launch.taskId).toMatch(/^b[a-z0-9]{8}$/u)
    expect(launch.content).toContain(`ID: ${launch.taskId}`)
    await expect(readFile(launch.outputFile, 'utf8')).resolves.toBeDefined()

    const completed = await manager.output(launch.taskId, {
      block: true,
      timeout: 30_000,
    })
    expect(completed.content).toContain('<status>completed</status>')
    expect(completed.content).toContain('<exit_code>0</exit_code>')
    expect(completed.nativeToolUseResult).toMatchObject({
      retrieval_status: 'success',
      task: {
        task_id: launch.taskId,
        task_type: 'local_bash',
        status: 'completed',
        output: 'BG_START\nBG_END\n',
        exitCode: 0,
      },
    })
    await expect(manager.notifications(true)).resolves.toEqual([])
    await expect(manager.notifications(false)).resolves.toEqual([])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task-started',
        taskId: launch.taskId,
        taskType: 'local_bash',
        toolUseId: 'call_bash',
      }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'task-notification',
        taskId: launch.taskId,
        status: 'completed',
        outputFile: launch.outputFile,
      }),
    )
  })

  it('uses active cwd when worktree changes before launch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-background-bash-cwd-'))
    roots.push(root)
    const original = join(root, 'original')
    const worktree = join(root, 'worktree')
    await mkdir(original)
    await mkdir(worktree)
    const stateRoot = join(root, 'state')
    let active = original
    const manager = new BackgroundBashManager({
      cwd: original,
      cwdProvider: () => active,
      sessionId: '21212121-2121-4121-8121-212121212121',
      stateRoot,
    })
    active = worktree
    const launch = await manager.launch({
      command: 'pwd',
      description: 'Print active cwd',
      toolUseId: 'call_cwd',
      timeout: 30_000,
    })
    const output = await manager.output(launch.taskId, {
      block: true,
      timeout: 30_000,
    })
    expect(output.nativeToolUseResult.task).toMatchObject({
      output: `${await realpath(worktree)}\n`,
    })
  })

  it('returns timeout without consuming a still-running completion', async () => {
    const { manager } = await createManager()
    const launch = await manager.launch({
      command: 'sleep 30',
      description: 'Wait command',
      toolUseId: 'call_wait',
      timeout: 60_000,
    })

    const timedOut = await manager.output(launch.taskId, {
      block: true,
      timeout: 1,
    })
    expect(timedOut.content).toContain(
      '<retrieval_status>timeout</retrieval_status>',
    )
    expect(timedOut.content).toContain('<status>running</status>')
    await manager.stop(launch.taskId)
  })

  it('reports non-zero exits as failed retrievals', async () => {
    const { manager } = await createManager()
    const launch = await manager.launch({
      command: "printf 'FAILED_OUTPUT\\n'; exit 7",
      description: 'Fail command',
      toolUseId: 'call_failed',
      timeout: 30_000,
    })
    const output = await manager.output(launch.taskId, {
      block: true,
      timeout: 30_000,
    })

    expect(output.content).toContain('<status>failed</status>')
    expect(output.content).toContain('<exit_code>7</exit_code>')
    expect(output.nativeToolUseResult.task).toMatchObject({
      status: 'failed',
      exitCode: 7,
    })
  })

  it('kills a timed-out process group and emits its failure notification once', async () => {
    const { manager } = await createManager()
    const launch = await manager.launch({
      command: "printf 'TIMEOUT_START\\n'; sleep 30",
      description: 'Timeout command',
      toolUseId: 'call_timeout',
      timeout: 500,
    })

    await expect(manager.notifications(true)).resolves.toEqual([
      expect.stringContaining(`<task-id>${launch.taskId}</task-id>`),
    ])
    const output = await manager.output(launch.taskId, {
      block: false,
      timeout: 0,
    })
    expect(output.content).toContain('<status>failed</status>')
    expect(output.content).toContain('TIMEOUT_START')
    await expect(manager.notifications(false)).resolves.toEqual([])
  })

  it('contains detached output failures and reports them as managed failures', async () => {
    const { manager } = await createManager()
    const launch = await manager.launch({
      command: "sleep 0.05; printf 'UNWRITABLE_OUTPUT\\n'",
      description: 'Lose output directory',
      toolUseId: 'call_output_failure',
      timeout: 30_000,
    })
    const outputRoot = dirname(launch.outputFile)
    await rm(outputRoot, { recursive: true, force: true })
    await writeFile(outputRoot, 'not a directory')

    await expect(manager.notifications(true)).resolves.toHaveLength(1)
    const output = await manager.output(launch.taskId, {
      block: false,
      timeout: 0,
    })
    expect(output.content).toContain('<status>failed</status>')
    expect(output.content).toContain('Background task failed:')
  })

  it('stops a running process group and returns Claude stop metadata', async () => {
    const { manager } = await createManager()
    const launch = await manager.launch({
      command: "printf 'START\\n'; sleep 30; printf 'END\\n'",
      description: 'Stop command',
      toolUseId: 'call_stop',
      timeout: 60_000,
    })

    const stopped = await manager.stop(launch.taskId)
    expect(stopped.content).toContain('Successfully stopped task')
    expect(stopped.nativeToolUseResult).toMatchObject({
      task_id: launch.taskId,
      task_type: 'local_bash',
    })
    const output = await manager.output(launch.taskId, {
      block: true,
      timeout: 30_000,
    })
    expect(output.content).toContain('<status>stopped</status>')
  })

  it('cancels a running process group with its parent tool signal', async () => {
    const { manager } = await createManager()
    const controller = new AbortController()
    const launch = await manager.launch({
      command: 'sleep 30',
      description: 'Cancel command',
      toolUseId: 'call_cancel',
      timeout: 60_000,
      signal: controller.signal,
    })
    controller.abort()

    const output = await manager.output(launch.taskId, {
      block: true,
      timeout: 30_000,
    })
    expect(output.content).toContain('<status>stopped</status>')
  })

  it('does not start a command when its parent tool is already aborted', async () => {
    const { manager } = await createManager()
    const controller = new AbortController()
    controller.abort()

    const launch = await manager.launch({
      command: 'sleep 30',
      description: 'Cancelled before launch',
      toolUseId: 'call_pre_cancelled',
      timeout: 60_000,
      signal: controller.signal,
    })
    const output = await manager.output(launch.taskId, {
      block: true,
      timeout: 30_000,
    })

    expect(output.content).toContain('<status>stopped</status>')
  })

  it('hydrates an unconsumed completion notification in a later manager', async () => {
    const { cwd, manager, root } = await createManager()
    const sessionId = '20202020-2020-4020-8020-202020202020'
    const stateRoot = join(root, 'config', 'praxis', 'background-tasks')
    const launch = await manager.launch({
      command: 'printf persisted',
      description: 'Persist notification',
      toolUseId: 'call_persisted',
      timeout: 30_000,
    })
    const stateFile = join(stateRoot, sessionId, `${launch.taskId}.json`)
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(stateFile, 'utf8')
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      }
    }
    await expect(readFile(stateFile, 'utf8')).resolves.toBeDefined()

    const reopened = new BackgroundBashManager({ cwd, sessionId, stateRoot })
    await expect(reopened.notifications(false)).resolves.toEqual([
      expect.stringContaining(`<task-id>${launch.taskId}</task-id>`),
    ])
    await expect(reopened.notifications(false)).resolves.toEqual([])
  })

  it('ignores malformed persisted task state while hydrating notifications', async () => {
    const { manager, sessionId, stateRoot } = await createManager()
    const sessionStateRoot = join(stateRoot, sessionId)
    await mkdir(sessionStateRoot, { recursive: true })
    await writeFile(join(sessionStateRoot, 'b12345678.json'), '{broken')
    await writeFile(
      join(sessionStateRoot, 'b87654321.json'),
      JSON.stringify({ version: 1, taskId: 'b87654321' }),
    )

    await expect(manager.notifications(false)).resolves.toEqual([])
  })

  it('escapes dynamic values in completion notifications', async () => {
    const { manager } = await createManager()
    const launch = await manager.launch({
      command: 'printf done',
      description: 'Build <prod> & "ship"',
      toolUseId: 'call<&"\'>',
      timeout: 30_000,
    })

    const notifications = await manager.notifications(true)

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toContain(
      'Build &lt;prod&gt; &amp; &quot;ship&quot;',
    )
    expect(notifications[0]).toContain(
      '<tool-use-id>call&lt;&amp;&quot;&apos;&gt;</tool-use-id>',
    )
    expect(notifications[0]).not.toContain('<prod>')
    expect(notifications[0]).toContain(`<task-id>${launch.taskId}</task-id>`)
  })

  it('bounds and redacts persisted output', async () => {
    const secret = 'stage20-secret-value'
    process.env.PRAXIS_STAGE20_SECRET = secret
    try {
      const { manager } = await createManager({ maxOutputBytes: 32 })
      const launch = await manager.launch({
        command: `printf '${secret}--abcdefghijklmnopqrstuvwxyz'`,
        description: 'Bound output',
        toolUseId: 'call_bound',
        timeout: 30_000,
      })
      const output = await manager.output(launch.taskId, {
        block: true,
        timeout: 30_000,
      })
      expect(output.content).not.toContain(secret)
      expect(output.content).toContain('[REDACTED]')
      expect(output.content).toContain('[output truncated]')
      await expect(readFile(launch.outputFile, 'utf8')).resolves.not.toContain(
        secret,
      )
    } finally {
      delete process.env.PRAXIS_STAGE20_SECRET
    }
  })
})
