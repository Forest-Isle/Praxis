import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import type { ClaudeHookCommandExecutor } from '../hooks/claude-hooks.js'
import { ClaudeHookRunner } from '../hooks/claude-hooks.js'
import { createWorkflowWorktree } from './workflow-worktree.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  )
})

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-workflow-git-'))
  roots.push(root)
  const repositoryRoot = join(root, 'repo')
  await execFileAsync('git', ['init', repositoryRoot])
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['-C', repositoryRoot, 'add', 'tracked.txt'])
  await execFileAsync('git', [
    '-C',
    repositoryRoot,
    '-c',
    'user.name=Praxis Test',
    '-c',
    'user.email=praxis@example.invalid',
    'commit',
    '-m',
    'fixture',
  ])
  return { repositoryRoot, stateRoot: join(root, 'state') }
}

describe('createWorkflowWorktree', () => {
  it('runs matched lifecycle hooks with exact checkout identity and signal', async () => {
    const fixture = await repository()
    const controller = new AbortController()
    const calls: {
      command: string
      input: Record<string, unknown>
      signal: AbortSignal | undefined
    }[] = []
    const executeCommand: ClaudeHookCommandExecutor = async (
      command,
      input,
      _timeoutMs,
      signal,
    ) => {
      calls.push({ command, input, signal })
      return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 }
    }
    const runner = new ClaudeHookRunner({
      settings: [
        {
          path: '/project.json',
          scope: 'project',
          value: {
            hooks: {
              WorktreeCreate: [
                {
                  matcher: 'workflow',
                  hooks: [{ type: 'command', command: 'create-hook' }],
                },
                {
                  matcher: 'agent',
                  hooks: [{ type: 'command', command: 'wrong-create-hook' }],
                },
              ],
              WorktreeRemove: [
                {
                  matcher: 'workflow',
                  hooks: [{ type: 'command', command: 'remove-hook' }],
                },
                {
                  matcher: 'agent',
                  hooks: [{ type: 'command', command: 'wrong-remove-hook' }],
                },
              ],
            },
          },
        },
      ],
      cwd: fixture.repositoryRoot,
      executeCommand,
    })
    const worktree = await createWorkflowWorktree({
      cwd: fixture.repositoryRoot,
      praxisRoot: fixture.stateRoot,
      runId: 'wf_exact-fields',
      agentId: 'a000000000000001',
      hookContext: {
        runner,
        sessionId: 'session-123',
        transcriptPath: '/tmp/session-agent.jsonl',
        permissionMode: 'default',
        signal: controller.signal,
      },
    })

    expect(calls).toHaveLength(1)
    const createCall = calls[0]
    expect(createCall).toBeDefined()
    expect(createCall?.command).toBe('create-hook')
    expect(createCall?.signal).toBe(controller.signal)
    expect(createCall?.input).toEqual({
      session_id: 'session-123',
      transcript_path: '/tmp/session-agent.jsonl',
      cwd: worktree.cwd,
      permission_mode: 'default',
      hook_event_name: 'WorktreeCreate',
      worktree_path: worktree.cwd,
      worktree_kind: 'workflow',
      worktree_id: expect.any(String),
      owner_id: 'workflow:wf_exact-fields:a000000000000001',
      base_commit: expect.any(String),
    })
    expect(createCall?.input.cwd).toBe(createCall?.input.worktree_path)

    await expect(worktree.cleanup()).resolves.toEqual({ retained: false })
    expect(calls).toHaveLength(2)
    const removeCall = calls[1]
    expect(removeCall).toBeDefined()
    expect(removeCall?.command).toBe('remove-hook')
    expect(removeCall?.signal).toBe(controller.signal)
    expect(removeCall?.input).toEqual({
      ...createCall?.input,
      hook_event_name: 'WorktreeRemove',
      reason: 'normal',
    })
  })

  it('creates an isolated checkout and removes it when clean', async () => {
    const fixture = await repository()
    const worktree = await createWorkflowWorktree({
      cwd: fixture.repositoryRoot,
      praxisRoot: fixture.stateRoot,
      runId: 'wf_12345678-abc',
      agentId: 'a000000000000001',
    })
    expect(worktree.cwd).toBe(
      join(
        await realpath(fixture.repositoryRoot),
        '.praxis',
        'worktrees',
        'workflow',
        'wf_12345678-abc-a000000000000001',
      ),
    )
    expect(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8')).toBe(
      'base\n',
    )
    expect(await worktree.cleanup()).toEqual({ retained: false })
    await expect(
      readFile(join(worktree.cwd, 'tracked.txt'), 'utf8'),
    ).rejects.toThrow()
    expect(await worktree.cleanup()).toEqual({ retained: false })
  })

  it('retains a dirty checkout and reports its path', async () => {
    const fixture = await repository()
    const worktree = await createWorkflowWorktree({
      cwd: fixture.repositoryRoot,
      praxisRoot: fixture.stateRoot,
      runId: 'wf_12345678-def',
      agentId: 'a000000000000002',
    })
    await writeFile(join(worktree.cwd, 'tracked.txt'), 'changed\n')
    const cleanup = await worktree.cleanup()
    expect(cleanup).toMatchObject({ retained: true })
    expect(cleanup.reason).toContain(worktree.cwd)
    expect(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8')).toBe(
      'changed\n',
    )
    await writeFile(join(worktree.cwd, 'tracked.txt'), 'base\n')
    expect(await worktree.cleanup()).toEqual({ retained: false })
    await expect(
      readFile(join(worktree.cwd, 'tracked.txt'), 'utf8'),
    ).rejects.toThrow()
  })

  it('retains a clean checkout whose detached HEAD contains commits', async () => {
    const fixture = await repository()
    const worktree = await createWorkflowWorktree({
      cwd: fixture.repositoryRoot,
      praxisRoot: fixture.stateRoot,
      runId: 'wf_12345678-commit',
      agentId: 'a000000000000003',
    })
    await writeFile(join(worktree.cwd, 'tracked.txt'), 'committed\n')
    await execFileAsync('git', ['-C', worktree.cwd, 'add', 'tracked.txt'])
    await execFileAsync('git', [
      '-C',
      worktree.cwd,
      '-c',
      'user.name=Praxis Test',
      '-c',
      'user.email=praxis@example.invalid',
      'commit',
      '-m',
      'agent change',
    ])

    const cleanup = await worktree.cleanup()

    expect(cleanup).toMatchObject({ retained: true })
    expect(cleanup.reason).toContain('has commits')
    expect(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8')).toBe(
      'committed\n',
    )
  })
})
