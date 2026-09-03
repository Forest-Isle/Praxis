import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { BoundedProcessRunner } from '../../platform/bounded-process-runner.js'

export interface TuiDiffFile {
  path: string
  additions: number
  deletions: number
  patch: string
}

export interface TuiDiffSnapshot {
  files: readonly TuiDiffFile[]
  additions: number
  deletions: number
}

export interface TuiGitDiffSession {
  prepare(cwd: string, signal?: AbortSignal): Promise<void>
  load(cwd: string, signal?: AbortSignal): Promise<TuiDiffSnapshot>
}

function isOldFileHeader(line: string): boolean {
  return /^--- (?:a\/|"a\/|\/dev\/null$)/u.test(line)
}

function isNewFileHeader(line: string): boolean {
  return /^\+\+\+ (?:b\/|"b\/|\/dev\/null$)/u.test(line)
}

function changedLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !isNewFileHeader(line)) additions += 1
    if (line.startsWith('-') && !isOldFileHeader(line)) deletions += 1
  }
  return { additions, deletions }
}

export function visiblePatchLines(patch: string): readonly string[] {
  return patch
    .split('\n')
    .filter(
      (line) =>
        line &&
        !line.startsWith('diff --git ') &&
        !line.startsWith('index ') &&
        !isOldFileHeader(line) &&
        !isNewFileHeader(line) &&
        !line.startsWith('@@ '),
    )
}

const CONTROL_LIMIT = 8 * 1024 * 1024
const PATCH_LIMIT = 256 * 1024
type Baseline = { root: string; oid: string | null } | { error: Error }

function makeRunner(root: string, limit = PATCH_LIMIT): BoundedProcessRunner {
  return new BoundedProcessRunner({ cwd: root, maxOutputBytes: limit })
}

function note(path: string, text: string): TuiDiffFile {
  return { path, additions: 0, deletions: 0, patch: text }
}

async function discover(cwd: string, signal?: AbortSignal): Promise<Baseline> {
  try {
    const process = makeRunner(cwd, CONTROL_LIMIT)
    const rootPromise = process.run({
      command: 'git',
      args: ['-C', cwd, 'rev-parse', '--show-toplevel'],
      timeoutMs: 5_000,
      ...(signal ? { signal } : {}),
    })
    const headPromise = process.run({
      command: 'git',
      args: ['-C', cwd, 'rev-parse', '--verify', '--quiet', 'HEAD'],
      timeoutMs: 5_000,
      ...(signal ? { signal } : {}),
    })
    const [probe, head] = await Promise.all([rootPromise, headPromise])
    if (
      probe.code !== 0 ||
      probe.timedOut ||
      probe.truncated ||
      !probe.stdout.trim()
    )
      throw new Error('Not a Git repository.')
    const root = await realpath(resolve(probe.stdout.trim()))
    if (head.timedOut || head.truncated)
      throw new Error('Git HEAD inspection failed.')
    if (head.code === 0 && head.stdout.trim())
      return { root, oid: head.stdout.trim() }
    if (head.code === 1 && !head.stdout.trim() && !head.stderr.trim())
      return { root, oid: null }
    throw new Error('Git HEAD inspection failed.')
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}

export function createTuiGitDiffSession(
  initialCwd: string,
  sessionSignal?: AbortSignal,
): TuiGitDiffSession {
  const baselines = new Map<string, Promise<Baseline>>()
  const discoveries = new Map<string, Promise<Baseline>>()
  const initialKey = resolve(initialCwd)

  const beginDiscovery = (
    key: string,
    signal?: AbortSignal,
  ): Promise<Baseline> => {
    let pending = discoveries.get(key)
    if (!pending) {
      pending = discover(key, signal).then((result) => {
        if (!('error' in result) && !baselines.has(result.root)) {
          baselines.set(result.root, Promise.resolve(result))
        }
        return result
      })
      discoveries.set(key, pending)
    }
    return pending
  }

  // Start both repository and HEAD probes before returning the session so a
  // later commit cannot move the initial baseline while the TUI is mounting.
  const initialReady = beginDiscovery(initialKey, sessionSignal).then(
    () => undefined,
  )

  const prepare = async (
    cwd: string,
    signal: AbortSignal | undefined = sessionSignal,
  ): Promise<void> => {
    const key = resolve(cwd)
    if (key !== initialKey) await initialReady
    await beginDiscovery(key, signal)
  }

  const load = async (
    cwd: string,
    signal?: AbortSignal,
  ): Promise<TuiDiffSnapshot> => {
    await prepare(cwd, signal)
    if (signal?.aborted)
      throw new DOMException('Tool execution aborted', 'AbortError')
    const discovery = await discoveries.get(resolve(cwd))
    const captured =
      discovery && !('error' in discovery)
        ? await baselines.get(discovery.root)
        : discovery
    if (!captured) throw new Error('Git baseline unavailable.')
    if ('error' in captured) throw captured.error
    const { root, oid } = captured
    const git = makeRunner(root)
    const control = makeRunner(root, CONTROL_LIMIT)
    const runGit = (args: string[]) =>
      git.run({
        command: 'git',
        args,
        timeoutMs: 5_000,
        ...(signal ? { signal } : {}),
      })
    const list = async (args: string[]) => {
      const result = await control.run({
        command: 'git',
        args,
        timeoutMs: 5_000,
        ...(signal ? { signal } : {}),
      })
      if (result.code !== 0 || result.timedOut || result.truncated)
        throw new Error('Git diff enumeration failed.')
      return result.stdout.split('\0').filter(Boolean)
    }
    const untracked = await list([
      '-C',
      root,
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ])
    const untrackedSet = new Set(untracked)
    let paths: string[]
    if (oid === null) {
      const cached = await list(['-C', root, 'ls-files', '--cached', '-z'])
      const deleted = new Set(
        await list(['-C', root, 'ls-files', '--deleted', '-z']),
      )
      paths = [...new Set([...cached, ...untracked])]
        .filter((path) => !deleted.has(path))
        .sort()
    } else {
      paths = [
        ...new Set([
          ...(await list([
            '-C',
            root,
            'diff',
            '--no-ext-diff',
            '--no-renames',
            '--name-only',
            '-z',
            oid,
            '--',
          ])),
          ...(await list([
            '-C',
            root,
            'diff',
            '--cached',
            '--no-ext-diff',
            '--no-renames',
            '--name-only',
            '-z',
            oid,
            '--',
          ])),
          ...untracked,
        ]),
      ].sort()
    }
    const baselineOid = oid ?? ''
    const files: TuiDiffFile[] = []
    for (const path of paths) {
      if (signal?.aborted)
        throw new DOMException('Tool execution aborted', 'AbortError')
      try {
        const conflict = await runGit([
          '-C',
          root,
          'ls-files',
          '-u',
          '--',
          path,
        ])
        if (conflict.code !== 0 || conflict.timedOut || conflict.truncated) {
          files.push(note(path, 'Diff unavailable; Git inspection failed.'))
          continue
        }
        if (conflict.stdout.trim()) {
          files.push(note(path, 'Merge conflict; patch omitted.'))
          continue
        }
        const numstatArgs =
          oid === null || untrackedSet.has(path)
            ? [
                '-C',
                root,
                'diff',
                '--no-index',
                '--no-ext-diff',
                '--numstat',
                '--',
                '/dev/null',
                path,
              ]
            : [
                '-C',
                root,
                'diff',
                '--no-ext-diff',
                '--no-renames',
                '--numstat',
                baselineOid,
                '--',
                path,
              ]
        const numstat = await (untrackedSet.has(path) ? control : git).run({
          command: 'git',
          args: numstatArgs,
          timeoutMs: 5_000,
          ...(signal ? { signal } : {}),
        })
        const validNumstatDifference =
          (oid === null || untrackedSet.has(path)) &&
          numstat.code === 1 &&
          !/error|fatal|permission|cannot|no such/iu.test(numstat.stderr)
        if (
          (numstat.code !== 0 && !validNumstatDifference) ||
          numstat.timedOut ||
          numstat.truncated
        ) {
          files.push(note(path, 'Diff unavailable; Git inspection failed.'))
          continue
        }
        if (/^-\s+-\s+/u.test(numstat.stdout)) {
          files.push(note(path, 'Binary file; patch omitted.'))
          continue
        }
        const args =
          oid === null || untrackedSet.has(path)
            ? [
                '-C',
                root,
                'diff',
                '--no-index',
                '--no-ext-diff',
                '--no-color',
                '--unified=3',
                '--',
                '/dev/null',
                path,
              ]
            : [
                '-C',
                root,
                'diff',
                '--no-ext-diff',
                '--no-color',
                '--unified=3',
                baselineOid,
                '--',
                path,
              ]
        const result = await runGit(args)
        if (result.timedOut) {
          files.push(note(path, 'Diff unavailable; Git inspection timed out.'))
          continue
        }
        const noIndexDifference =
          (oid === null || untrackedSet.has(path)) &&
          result.code === 1 &&
          !/error|fatal|permission|cannot|no such/iu.test(result.stderr)
        if (result.code !== 0 && !noIndexDifference) {
          const disappeared =
            /no such|cannot stat|does not exist|not found/iu.test(result.stderr)
          files.push(
            note(
              path,
              disappeared
                ? 'Diff unavailable; path changed during inspection.'
                : 'Diff unavailable; Git inspection failed.',
            ),
          )
        } else
          files.push({
            path,
            patch: result.stdout,
            ...changedLines(result.stdout),
          })
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError')
          throw error
        const message = error instanceof Error ? error.message : String(error)
        files.push(
          note(
            path,
            /no such|cannot stat|does not exist|not found/iu.test(message)
              ? 'Diff unavailable; path changed during inspection.'
              : 'Diff unavailable; Git inspection failed.',
          ),
        )
      }
    }
    return {
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    }
  }
  return { prepare, load }
}
export async function loadGitDiff(cwd: string): Promise<TuiDiffSnapshot> {
  const session = createTuiGitDiffSession(cwd)
  await session.prepare(cwd)
  return session.load(cwd)
}
