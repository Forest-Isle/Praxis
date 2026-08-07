import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

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
  await execFileAsync('git', ['init', root])
  await writeFile(join(root, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['-C', root, 'add', 'tracked.txt'])
  await execFileAsync('git', [
    '-C',
    root,
    '-c',
    'user.name=Praxis Test',
    '-c',
    'user.email=praxis@example.invalid',
    'commit',
    '-m',
    'fixture',
  ])
  return root
}

describe('createWorkflowWorktree', () => {
  it('creates an isolated checkout and removes it when clean', async () => {
    const root = await repository()
    const worktree = await createWorkflowWorktree({
      cwd: root,
      praxisRoot: join(root, '.praxis-data'),
      runId: 'wf_12345678-abc',
      agentId: 'a000000000000001',
    })
    expect(await readFile(join(worktree.cwd, 'tracked.txt'), 'utf8')).toBe(
      'base\n',
    )
    expect(await worktree.cleanup()).toEqual({ retained: false })
    await expect(
      readFile(join(worktree.cwd, 'tracked.txt'), 'utf8'),
    ).rejects.toThrow()
  })

  it('retains a dirty checkout and reports its path', async () => {
    const root = await repository()
    const worktree = await createWorkflowWorktree({
      cwd: root,
      praxisRoot: join(root, '.praxis-data'),
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
    const root = await repository()
    const worktree = await createWorkflowWorktree({
      cwd: root,
      praxisRoot: join(root, '.praxis-data'),
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
