import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { SessionWorktreeManager, WorkspaceContext } from './session-worktree.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'praxis-session-worktree-'))
  roots.push(root)
  await writeFile(join(root, 'tracked.txt'), 'base\n')
  await execFileAsync('git', ['init', root])
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

describe('SessionWorktreeManager', () => {
  it('creates a native worktree, tracks state, and removes cleanly', async () => {
    const root = await repository()
    const workspace = new WorkspaceContext(root)
    const manager = new SessionWorktreeManager({
      workspace,
      sessionId: '11111111-1111-4111-8111-111111111111',
    })
    const result = await manager.enter({ name: 'feature/probe' }, 'enter')
    expect(workspace.cwd()).toContain('/.claude/worktrees/feature/probe')
    expect(result.nativeToolUseResult).toMatchObject({
      worktreeBranch: 'worktree-feature-probe',
    })
    const state = manager.consumeTransition('enter')
    expect(state?.state?.worktreeName).toBe('feature/probe')
    const gitDir = await execFileAsync('git', [
      '-C',
      workspace.cwd(),
      'rev-parse',
      '--git-dir',
    ]).then(({ stdout }) => stdout.trim())
    expect(await readFile(join(gitDir, 'CLAUDE_BASE'), 'utf8')).toMatch(
      /^[0-9a-f]{40}\n$/u,
    )

    const exit = await manager.exit({ action: 'remove' }, 'exit')
    expect(exit.nativeToolUseResult).toMatchObject({ action: 'remove' })
    expect(workspace.cwd()).toBe(root)
    expect(manager.current()).toBeNull()
    await expect(
      execFileAsync('git', [
        '-C',
        root,
        'show-ref',
        '--verify',
        'refs/heads/worktree-feature-probe',
      ]),
    ).rejects.toThrow()
  })

  it('guards dirty removal and allows explicit discard', async () => {
    const root = await repository()
    const workspace = new WorkspaceContext(root)
    const manager = new SessionWorktreeManager({
      workspace,
      sessionId: '22222222-2222-4222-8222-222222222222',
    })
    await manager.enter({ name: 'dirty' }, 'enter')
    await writeFile(join(workspace.cwd(), 'tracked.txt'), 'changed\n')
    await expect(manager.exit({ action: 'remove' }, 'exit')).rejects.toThrow(
      'discard_changes',
    )
    expect(manager.current()).not.toBeNull()
    const result = await manager.exit(
      { action: 'remove', discard_changes: true },
      'exit-forced',
    )
    expect(result.nativeToolUseResult).toMatchObject({ discardedFiles: 1 })
    expect(workspace.cwd()).toBe(root)
  })

  it('counts worktree commits from the entry commit even if main advances', async () => {
    const root = await repository()
    const workspace = new WorkspaceContext(root)
    const manager = new SessionWorktreeManager({
      workspace,
      sessionId: '77777777-7777-4777-8777-777777777777',
    })
    await manager.enter({ name: 'commit-boundary' }, 'enter')
    await writeFile(join(workspace.cwd(), 'worktree.txt'), 'worktree\n')
    await execFileAsync('git', ['-C', workspace.cwd(), 'add', 'worktree.txt'])
    await execFileAsync('git', [
      '-C',
      workspace.cwd(),
      '-c',
      'user.name=Praxis Test',
      '-c',
      'user.email=praxis@example.invalid',
      'commit',
      '-m',
      'worktree commit',
    ])
    await writeFile(join(root, 'main.txt'), 'main\n')
    await execFileAsync('git', ['-C', root, 'add', 'main.txt'])
    await execFileAsync('git', [
      '-C',
      root,
      '-c',
      'user.name=Praxis Test',
      '-c',
      'user.email=praxis@example.invalid',
      'commit',
      '-m',
      'main advance',
    ])
    await expect(manager.exit({ action: 'remove' }, 'remove')).rejects.toThrow(
      'unmerged commit(s)',
    )
    await manager.exit(
      { action: 'remove', discard_changes: true },
      'remove-forced',
    )
  })

  it('does not remove manually entered worktrees', async () => {
    const root = await repository()
    const path = join(root, '.claude', 'worktrees', 'manual')
    await execFileAsync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-b',
      'manual-branch',
      path,
      'HEAD',
    ])
    const workspace = new WorkspaceContext(root)
    const manager = new SessionWorktreeManager({
      workspace,
      sessionId: '33333333-3333-4333-8333-333333333333',
    })
    await manager.enter({ path }, 'enter')
    await expect(manager.exit({ action: 'remove' }, 'exit')).rejects.toThrow(
      'cannot be removed',
    )
    await manager.exit({ action: 'keep' }, 'keep')
    await execFileAsync('git', [
      '-C',
      root,
      'worktree',
      'remove',
      '--force',
      path,
    ])
    await execFileAsync('git', ['-C', root, 'branch', '-D', 'manual-branch'])
  })

  it('ignores stale transcript state without a Git worktree marker', async () => {
    const root = await repository()
    const stalePath = join(root, '.claude', 'worktrees', 'stale')
    await mkdir(stalePath, { recursive: true })
    const workspace = new WorkspaceContext(root)
    const manager = new SessionWorktreeManager({
      workspace,
      sessionId: '44444444-4444-4444-8444-444444444444',
    })
    manager.restore({
      originalCwd: root,
      preEnterOriginalCwd: root,
      worktreePath: stalePath,
      worktreeName: 'stale',
      worktreeBranch: 'worktree-stale',
      originalBranch: 'main',
      originalHeadCommit: '0'.repeat(40),
      sessionId: '44444444-4444-4444-8444-444444444444',
    })
    expect(manager.current()).toBeNull()
    expect(workspace.cwd()).toBe(root)
  })

  it('does not leak an active worktree across session IDs', async () => {
    const root = await repository()
    const workspace = new WorkspaceContext(root)
    const manager = new SessionWorktreeManager({
      workspace,
      sessionId: '55555555-5555-4555-8555-555555555555',
    })
    await manager.enter({ name: 'session-boundary' }, 'enter')
    expect(() =>
      manager.bindSession('66666666-6666-4666-8666-666666666666'),
    ).toThrow('while worktree session')
    await manager.exit({ action: 'remove', discard_changes: true }, 'exit')
    expect(() =>
      manager.bindSession('66666666-6666-4666-8666-666666666666'),
    ).not.toThrow()
  })
})
