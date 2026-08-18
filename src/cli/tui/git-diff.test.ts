import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { loadGitDiff, visiblePatchLines } from './git-diff.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('TUI git diff snapshot', () => {
  it('loads changed files with safe path arguments and line totals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-diff-'))
    roots.push(root)
    const path = join(root, 'file with spaces.txt')
    await execFileAsync('git', ['init', '-q'], { cwd: root })
    await writeFile(path, 'before\n')
    await execFileAsync('git', ['add', '.'], { cwd: root })
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=Praxis Fixture',
        '-c',
        'user.email=fixture@example.com',
        'commit',
        '-qm',
        'fixture',
      ],
      { cwd: root },
    )
    await writeFile(path, 'after\nsecond line\n')

    const snapshot = await loadGitDiff(root)
    expect(snapshot).toMatchObject({ additions: 2, deletions: 1 })
    expect(snapshot.files[0]).toMatchObject({
      path: 'file with spaces.txt',
      additions: 2,
      deletions: 1,
    })
    expect(visiblePatchLines(snapshot.files[0]?.patch ?? '')).toEqual([
      '-before',
      '+after',
      '+second line',
    ])
  })

  it('keeps changed content that resembles a diff header', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '--- content',
      '+++ content',
    ].join('\n')
    expect(visiblePatchLines(patch)).toEqual(['--- content', '+++ content'])
  })

  it('returns an empty snapshot for an unborn repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-diff-unborn-'))
    roots.push(root)
    await execFileAsync('git', ['init', '-q'], { cwd: root })

    const snapshot = await loadGitDiff(root)
    expect(snapshot).toEqual({ files: [], additions: 0, deletions: 0 })
  })

  it('reports staged and untracked files in an unborn repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-diff-unborn-'))
    roots.push(root)
    await execFileAsync('git', ['init', '-q'], { cwd: root })

    await writeFile(join(root, 'staged.txt'), 'staged line\n')
    await execFileAsync('git', ['add', '.'], { cwd: root })
    await writeFile(join(root, 'untracked.txt'), 'untracked line\n')

    const snapshot = await loadGitDiff(root)

    expect(snapshot).toMatchObject({ additions: 2, deletions: 0 })
    const staged = snapshot.files.find((file) => file.path === 'staged.txt')
    const untracked = snapshot.files.find(
      (file) => file.path === 'untracked.txt',
    )
    expect(staged).toMatchObject({ additions: 1, deletions: 0 })
    expect(untracked).toMatchObject({ additions: 1, deletions: 0 })
    expect(visiblePatchLines(staged?.patch ?? '')).toContain('+staged line')
    expect(visiblePatchLines(untracked?.patch ?? '')).toContain(
      '+untracked line',
    )
  })
})
