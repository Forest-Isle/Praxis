import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BoundedProcessRunner,
  type ProcessResult,
  type RunProcessOptions,
} from '../../platform/bounded-process-runner.js'
import {
  createTuiGitDiffSession,
  loadGitDiff,
  visiblePatchLines,
} from './git-diff.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function repository(
  files: Readonly<Record<string, string | Uint8Array>> = {
    'tracked.txt': 'base\n',
  },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'praxis-tui-diff-session-'))
  roots.push(root)
  await execFileAsync('git', ['init', '-q'], { cwd: root })
  await Promise.all(
    Object.entries(files).map(([path, content]) =>
      writeFile(join(root, path), content),
    ),
  )
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await commit(root, 'fixture')
  return root
}

async function commit(root: string, message: string): Promise<void> {
  await execFileAsync(
    'git',
    [
      '-c',
      'user.name=Praxis Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-qm',
      message,
    ],
    { cwd: root },
  )
}

function processFailure(stderr: string): ProcessResult {
  return {
    stdout: '',
    stderr,
    output: stderr,
    code: 128,
    timedOut: false,
    truncated: false,
  }
}

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

  it('keeps the initial HEAD baseline after a later commit', async () => {
    const root = await repository({ 'tracked.txt': 'initial\n' })
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)

    await writeFile(join(root, 'tracked.txt'), 'committed later\n')
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: root })
    await commit(root, 'later commit')
    await writeFile(
      join(root, 'tracked.txt'),
      'committed later\nworking tree edit\n',
    )

    const snapshot = await session.load(root)
    const patch = snapshot.files.find(
      (file) => file.path === 'tracked.txt',
    )?.patch
    expect(visiblePatchLines(patch ?? '')).toEqual([
      '-initial',
      '+committed later',
      '+working tree edit',
    ])
  })

  it('includes headed untracked files and keeps lexical path order', async () => {
    const root = await repository({ 'deleted.txt': 'remove me\n' })
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)

    await rm(join(root, 'deleted.txt'))
    await writeFile(join(root, 'é.txt'), 'unicode\n')
    await writeFile(join(root, 'a space.txt'), 'space\n')

    const snapshot = await session.load(root)
    expect(snapshot.files.map((file) => file.path)).toEqual([
      'a space.txt',
      'deleted.txt',
      'é.txt',
    ])
    expect(
      visiblePatchLines(
        snapshot.files.find((file) => file.path === 'a space.txt')?.patch ?? '',
      ),
    ).toContain('+space')
    expect(
      visiblePatchLines(
        snapshot.files.find((file) => file.path === 'deleted.txt')?.patch ?? '',
      ),
    ).toContain('-remove me')
  })

  it('omits binary patch bodies with a readable note', async () => {
    const root = await repository({
      'binary.dat': Uint8Array.from([0, 1, 2, 3]),
    })
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)
    await writeFile(join(root, 'binary.dat'), Uint8Array.from([0, 4, 5, 6]))

    const snapshot = await session.load(root)
    expect(snapshot.files).toContainEqual({
      path: 'binary.dat',
      additions: 0,
      deletions: 0,
      patch: 'Binary file; patch omitted.',
    })
  })

  it('omits unmerged patch bodies with a readable note', async () => {
    const root = await repository({ 'conflict.txt': 'base\n' })
    const initialBranch = (
      await execFileAsync('git', ['branch', '--show-current'], {
        cwd: root,
        encoding: 'utf8',
      })
    ).stdout.trim()
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)

    await execFileAsync('git', ['checkout', '-qb', 'other'], { cwd: root })
    await writeFile(join(root, 'conflict.txt'), 'other\n')
    await execFileAsync('git', ['add', 'conflict.txt'], { cwd: root })
    await commit(root, 'other change')
    await execFileAsync('git', ['checkout', '-q', initialBranch], { cwd: root })
    await writeFile(join(root, 'conflict.txt'), 'current\n')
    await execFileAsync('git', ['add', 'conflict.txt'], { cwd: root })
    await commit(root, 'current change')
    await expect(
      execFileAsync(
        'git',
        [
          '-c',
          'user.name=Praxis Fixture',
          '-c',
          'user.email=fixture@example.com',
          'merge',
          '--no-edit',
          'other',
        ],
        { cwd: root },
      ),
    ).rejects.toBeDefined()
    const unmerged = await execFileAsync(
      'git',
      ['ls-files', '-u', '--', 'conflict.txt'],
      { cwd: root },
    )
    expect(unmerged.stdout.trim()).not.toBe('')

    const snapshot = await session.load(root)
    expect(snapshot.files).toContainEqual({
      path: 'conflict.txt',
      additions: 0,
      deletions: 0,
      patch: 'Merge conflict; patch omitted.',
    })
  })

  it('bounds multibyte patches and retains the truncation marker', async () => {
    const root = await repository({ 'large.txt': 'before\n' })
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)
    await writeFile(join(root, 'large.txt'), `${'界'.repeat(120_000)}\n`)

    const snapshot = await session.load(root)
    const patch = snapshot.files.find(
      (file) => file.path === 'large.txt',
    )?.patch
    expect(patch).toBeDefined()
    expect(patch).toMatch(/\n\[output truncated\]$/u)
    expect(Buffer.byteLength(patch ?? '')).toBeLessThanOrEqual(
      256 * 1024 + Buffer.byteLength('\n[output truncated]'),
    )
    expect(Buffer.from(patch ?? '', 'utf8').toString('utf8')).toBe(patch)
  })

  it('keeps an unborn baseline after the first commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'praxis-tui-diff-unborn-'))
    roots.push(root)
    await execFileAsync('git', ['init', '-q'], { cwd: root })
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)

    await writeFile(join(root, 'created.txt'), 'created after start\n')
    await execFileAsync('git', ['add', 'created.txt'], { cwd: root })
    await commit(root, 'first commit')

    const snapshot = await session.load(root)
    expect(visiblePatchLines(snapshot.files[0]?.patch ?? '')).toContain(
      '+created after start',
    )
  })

  it('localizes a path that disappears after enumeration', async () => {
    const root = await repository()
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)
    await writeFile(join(root, 'gone.txt'), 'temporary\n')
    const originalRun = BoundedProcessRunner.prototype.run
    vi.spyOn(BoundedProcessRunner.prototype, 'run').mockImplementation(
      function (this: BoundedProcessRunner, options: RunProcessOptions) {
        if (
          options.args.includes('--unified=3') &&
          options.args.at(-1) === 'gone.txt'
        ) {
          return Promise.resolve(
            processFailure('fatal: gone.txt: no such file or directory'),
          )
        }
        return originalRun.call(this, options)
      },
    )

    const snapshot = await session.load(root)
    expect(snapshot.files).toContainEqual({
      path: 'gone.txt',
      additions: 0,
      deletions: 0,
      patch: 'Diff unavailable; path changed during inspection.',
    })
  })

  it('fails closed when a control path list is truncated', async () => {
    const root = await repository()
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)
    const originalRun = BoundedProcessRunner.prototype.run
    vi.spyOn(BoundedProcessRunner.prototype, 'run').mockImplementation(
      function (this: BoundedProcessRunner, options: RunProcessOptions) {
        if (
          options.args.includes('ls-files') &&
          options.args.includes('--others')
        ) {
          return Promise.resolve({
            stdout: 'partial-path',
            stderr: '',
            output: 'partial-path\n[output truncated]',
            code: 0,
            timedOut: false,
            truncated: true,
          })
        }
        return originalRun.call(this, options)
      },
    )

    await expect(session.load(root)).rejects.toThrow(
      'Git diff enumeration failed.',
    )
  })

  it('does not classify a failed HEAD probe as unborn', async () => {
    const root = await repository()
    const originalRun = BoundedProcessRunner.prototype.run
    vi.spyOn(BoundedProcessRunner.prototype, 'run').mockImplementation(
      function (this: BoundedProcessRunner, options: RunProcessOptions) {
        if (options.args.includes('--verify')) {
          return Promise.resolve({
            ...processFailure(''),
            code: 1,
            timedOut: true,
          })
        }
        return originalRun.call(this, options)
      },
    )

    const session = createTuiGitDiffSession(root)
    await expect(session.load(root)).rejects.toThrow(
      'Git HEAD inspection failed.',
    )
  })

  it('rejects cancellation without returning a partial snapshot', async () => {
    const root = await repository({ 'tracked.txt': 'before\n' })
    const session = createTuiGitDiffSession(root)
    await session.prepare(root)
    await writeFile(join(root, 'tracked.txt'), 'after\n')
    const controller = new AbortController()
    controller.abort()

    await expect(session.load(root, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('passes the session cancellation signal to eager baseline probes', async () => {
    const root = await repository()
    const controller = new AbortController()
    const observedSignals: Array<AbortSignal | undefined> = []
    const originalRun = BoundedProcessRunner.prototype.run
    vi.spyOn(BoundedProcessRunner.prototype, 'run').mockImplementation(
      function (this: BoundedProcessRunner, options: RunProcessOptions) {
        if (
          options.args.includes('--show-toplevel') ||
          options.args.includes('--verify')
        ) {
          observedSignals.push(options.signal)
        }
        return originalRun.call(this, options)
      },
    )

    const session = createTuiGitDiffSession(root, controller.signal)
    await session.prepare(root)

    expect(observedSignals).toEqual([controller.signal, controller.signal])
  })
})
