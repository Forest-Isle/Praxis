import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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

function changedLines(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !isNewFileHeader(line)) additions += 1
    if (line.startsWith('-') && !isOldFileHeader(line)) deletions += 1
  }
  return { additions, deletions }
}

function isOldFileHeader(line: string): boolean {
  return /^--- (?:a\/|"a\/|\/dev\/null$)/u.test(line)
}

function isNewFileHeader(line: string): boolean {
  return /^\+\+\+ (?:b\/|"b\/|\/dev\/null$)/u.test(line)
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

export async function loadGitDiff(cwd: string): Promise<TuiDiffSnapshot> {
  const names = await execFileAsync(
    'git',
    ['-C', cwd, 'diff', '--name-only', '-z', 'HEAD', '--'],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
  const paths = names.stdout.split('\0').filter(Boolean)
  const files: TuiDiffFile[] = []
  for (const path of paths) {
    const result = await execFileAsync(
      'git',
      [
        '-C',
        cwd,
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--unified=3',
        'HEAD',
        '--',
        path,
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    )
    files.push({ path, patch: result.stdout, ...changedLines(result.stdout) })
  }
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  }
}
